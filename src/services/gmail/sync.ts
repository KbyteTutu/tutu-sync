import type Database from 'better-sqlite3';
import type { GmailConfig } from './schema.js';
import { GmailImap, type RawEmail } from './imap.js';
import { analyzeEmail } from './analyze.js';
import { getSyncState, insertEmail, setAnalysis, setSyncState } from './store.js';
import type { Logger } from '../../lib/log.js';

export interface SyncSummary {
  fetched: number;
  analyzed: number;
  failed: number;
  lastUid: number;
}

/**
 * 增量同步：按 UIDVALIDITY + last_uid 水位只拉新邮件，逐封调 LLM 分析后落库。
 * 单封分析失败不影响整体，失败原因写进 analysis_error。
 */
export async function runSync(
  cfg: GmailConfig,
  db: Database.Database,
  imap: GmailImap,
  log: Logger,
): Promise<SyncSummary> {
  const mailbox = cfg.imap.mailbox;
  const current = await imap.mailboxInfo(mailbox);
  const state = getSyncState(db, mailbox);

  let afterUid: number;
  if (state && state.uidvalidity === current.uidValidity) {
    afterUid = state.last_uid;
  } else {
    if (state) {
      log.warn(`UIDVALIDITY 变化 (${state.uidvalidity} -> ${current.uidValidity})，重建水位`);
    }
    afterUid = await imap.resolveStartUid(mailbox, cfg.fetch.initial_days);
    setSyncState(db, mailbox, current.uidValidity, afterUid);
    log.info(`起始水位 uid=${afterUid}`);
  }

  const summary: SyncSummary = { fetched: 0, analyzed: 0, failed: 0, lastUid: afterUid };

  for (let batch = 0; batch < cfg.fetch.max_batches_per_run; batch++) {
    const emails = await imap.fetchBatch(
      mailbox,
      afterUid,
      cfg.fetch.batch_size,
      cfg.llm.max_body_chars,
    );
    if (emails.length === 0) break;

    const markSeenUids: number[] = [];
    for (const email of emails) {
      await processEmail(cfg, db, current.uidValidity, email, markSeenUids);
      const ok = outcomeOf(db, current.uidValidity, email.uid);
      summary.fetched++;
      if (ok) summary.analyzed++;
      else summary.failed++;
      afterUid = email.uid;
    }
    summary.lastUid = afterUid;
    setSyncState(db, mailbox, current.uidValidity, afterUid);

    if (cfg.fetch.mark_seen) await imap.markSeen(mailbox, markSeenUids);
    if (emails.length < cfg.fetch.batch_size) break;
  }

  return summary;
}

async function processEmail(
  cfg: GmailConfig,
  db: Database.Database,
  uidvalidity: number,
  email: RawEmail,
  markSeenUids: number[],
): Promise<void> {
  insertEmail(db, {
    uidvalidity,
    uid: email.uid,
    message_id: email.messageId,
    from_addr: email.fromAddr,
    from_name: email.fromName,
    to_addr: email.toAddr,
    subject: email.subject,
    date: email.date,
    seen: email.seen,
    snippet: email.snippet,
    body_text: email.text,
  });
  if (cfg.fetch.mark_seen && !email.seen) markSeenUids.push(email.uid);

  const outcome = await analyzeEmail(cfg.llm, {
    fromAddr: email.fromAddr,
    fromName: email.fromName,
    subject: email.subject,
    date: email.date,
    text: email.text,
  });
  setAnalysis(db, uidvalidity, email.uid, outcome.analysis, outcome.error);
}

function outcomeOf(db: Database.Database, uidvalidity: number, uid: number): boolean {
  const row = db
    .prepare('SELECT analysis FROM gmail_emails WHERE uidvalidity = ? AND uid = ?')
    .get(uidvalidity, uid) as { analysis: string | null } | undefined;
  return Boolean(row?.analysis);
}
