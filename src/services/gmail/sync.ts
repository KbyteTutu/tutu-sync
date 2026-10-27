import type Database from 'better-sqlite3';
import type { Logger } from '../../lib/log.js';
import { GmailImap } from './imap.js';
import type { GmailConfig } from './schema.js';
import { getSyncState, insertEmail, setSyncState } from './store.js';

export interface SyncSummary {
  fetched: number;
  lastUid: number;
}

/** 入库正文上限：本地初筛要用完整正文，LLM 分析时再按 llm.max_body_chars 截断 */
const STORED_BODY_CHARS = 20_000;

/**
 * 只拉取与落库，不做 LLM 分析：分析由 tutu_gmail_analyze 按需触发。
 * 水位逐封推进，进程中途被杀最多重下 1 封（清单主键保证不会重复入库）。
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

  let fetched = 0;
  for (let batch = 0; batch < cfg.fetch.max_batches_per_run; batch++) {
    const emails = await imap.fetchBatch(
      mailbox,
      afterUid,
      cfg.fetch.batch_size,
      STORED_BODY_CHARS,
    );
    if (emails.length === 0) break;

    const markSeenUids: number[] = [];
    for (const email of emails) {
      insertEmail(db, {
        uidvalidity: current.uidValidity,
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
        headers: email.headers,
      });
      if (cfg.fetch.mark_seen && !email.seen) markSeenUids.push(email.uid);
      afterUid = email.uid;
      setSyncState(db, mailbox, current.uidValidity, afterUid);
      fetched++;
    }

    if (cfg.fetch.mark_seen) await imap.markSeen(mailbox, markSeenUids);
    if (emails.length < cfg.fetch.batch_size) break;
  }

  return { fetched, lastUid: afterUid };
}
