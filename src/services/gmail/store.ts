import type Database from 'better-sqlite3';
import type { LlmUsage } from './analyze.js';

export interface EmailRow {
  uidvalidity: number;
  uid: number;
  message_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addr: string | null;
  subject: string | null;
  date: string | null;
  seen: number;
  snippet: string | null;
  body_text: string | null;
  /** 批量投递/自动通知相关邮件头（JSON） */
  headers: string | null;
  analyzed: number;
  analysis: string | null;
  analysis_error: string | null;
  llm_model: string | null;
  llm_calls: number;
  llm_prompt_tokens: number;
  llm_completion_tokens: number;
  llm_total_tokens: number;
  spam: number;
  /** 'valuable' | 'spam' | 'noise'；NULL 表示还没处理 */
  prefilter_kind: string | null;
  prefilter_score: number;
  prefilter_reason: string | null;
  fetched_at: string;
  analyzed_at: string | null;
}

export interface EmailInsert {
  uidvalidity: number;
  uid: number;
  message_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addr: string | null;
  subject: string | null;
  date: string | null;
  seen: boolean;
  snippet: string;
  body_text: string;
  headers: string;
}

export interface SyncState {
  mailbox: string;
  uidvalidity: number;
  last_uid: number;
}

export interface AnalysisResult {
  analysis: string | null;
  error: string | null;
  usage: LlmUsage;
  spam: boolean;
}

export function getSyncState(db: Database.Database, mailbox: string): SyncState | null {
  const row = db
    .prepare('SELECT mailbox, uidvalidity, last_uid FROM gmail_sync_state WHERE mailbox = ?')
    .get(mailbox) as SyncState | undefined;
  return row ?? null;
}

export function setSyncState(
  db: Database.Database,
  mailbox: string,
  uidvalidity: number,
  lastUid: number,
): void {
  db.prepare(
    `INSERT INTO gmail_sync_state (mailbox, uidvalidity, last_uid) VALUES (?, ?, ?)
     ON CONFLICT(mailbox) DO UPDATE SET uidvalidity = excluded.uidvalidity, last_uid = excluded.last_uid`,
  ).run(mailbox, uidvalidity, lastUid);
}

export function insertEmail(db: Database.Database, email: EmailInsert): void {
  db.prepare(
    `INSERT OR IGNORE INTO gmail_emails
       (uidvalidity, uid, message_id, from_addr, from_name, to_addr, subject,
        date, seen, snippet, body_text, headers, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    email.uidvalidity,
    email.uid,
    email.message_id,
    email.from_addr,
    email.from_name,
    email.to_addr,
    email.subject,
    email.date,
    email.seen ? 1 : 0,
    email.snippet,
    email.body_text,
    email.headers,
    new Date().toISOString(),
  );
}

export interface PrefilterMeta {
  kind: string;
  confidence: number;
  reason: string;
}

export function setAnalysis(
  db: Database.Database,
  uidvalidity: number,
  uid: number,
  result: AnalysisResult,
  prefilter?: PrefilterMeta,
): void {
  db.prepare(
    `UPDATE gmail_emails
     SET analyzed = 1, analysis = ?, analysis_error = ?, analyzed_at = ?,
         llm_model = ?, llm_calls = ?, llm_prompt_tokens = ?, llm_completion_tokens = ?,
         llm_total_tokens = ?, spam = ?,
         prefilter_kind = ?, prefilter_score = ?, prefilter_reason = ?
     WHERE uidvalidity = ? AND uid = ?`,
  ).run(
    result.analysis,
    result.error,
    new Date().toISOString(),
    result.usage.model,
    result.usage.calls,
    result.usage.promptTokens,
    result.usage.completionTokens,
    result.usage.totalTokens,
    result.spam ? 1 : 0,
    prefilter?.kind ?? null,
    prefilter?.confidence ?? 0,
    prefilter?.reason ?? null,
    uidvalidity,
    uid,
  );
}

export interface PrefilterSave {
  analysis: string;
  kind: string;
  confidence: number;
  reason: string;
  spam: boolean;
}

/** 本地初筛直接过滤：不产生 LLM 用量 */
export function setPrefilter(
  db: Database.Database,
  uidvalidity: number,
  uid: number,
  save: PrefilterSave,
): void {
  db.prepare(
    `UPDATE gmail_emails
     SET analyzed = 1, analysis = ?, analysis_error = NULL, analyzed_at = ?,
         llm_model = NULL, llm_calls = 0, llm_prompt_tokens = 0,
         llm_completion_tokens = 0, llm_total_tokens = 0, spam = ?,
         prefilter_kind = ?, prefilter_score = ?, prefilter_reason = ?
     WHERE uidvalidity = ? AND uid = ?`,
  ).run(
    save.analysis,
    new Date().toISOString(),
    save.spam ? 1 : 0,
    save.kind,
    save.confidence,
    save.reason,
    uidvalidity,
    uid,
  );
}

/** 待分析（tut=0）或分析失败（retryFailed）的邮件，按 UID 从旧到新 */
export function listPending(
  db: Database.Database,
  limit: number,
  retryFailed: boolean,
): EmailRow[] {
  return db
    .prepare(
      `SELECT * FROM gmail_emails
       WHERE analyzed = 0 OR (analysis_error IS NOT NULL AND @retryFailed = 1)
       ORDER BY uidvalidity ASC, uid ASC
       LIMIT @limit`,
    )
    .all({ retryFailed: retryFailed ? 1 : 0, limit }) as EmailRow[];
}

export function countPending(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) c FROM gmail_emails WHERE analyzed = 0').get() as {
    c: number;
  };
  return row.c;
}

export type EmailState = 'all' | 'processed' | 'pending' | 'failed';

export interface ListFilter {
  limit: number;
  category?: string;
  priority?: 'high' | 'medium' | 'low';
  unreadOnly?: boolean;
  state?: EmailState;
}

/** 全静态 SQL + 命名参数，无任何字符串拼接 */
const LIST_SQL = `
  SELECT * FROM gmail_emails
  WHERE (@state = 'all'
      OR (@state = 'processed' AND analyzed = 1 AND analysis_error IS NULL)
      OR (@state = 'pending' AND analyzed = 0)
      OR (@state = 'failed' AND analysis_error IS NOT NULL))
    AND (@category IS NULL OR json_extract(analysis, '$.category') = @category COLLATE NOCASE)
    AND (@priority IS NULL OR json_extract(analysis, '$.priority') = @priority COLLATE NOCASE)
    AND (@unreadOnly = 0 OR seen = 0)
  ORDER BY uidvalidity DESC, uid DESC
  LIMIT @limit
`;

export function listEmails(db: Database.Database, filter: ListFilter): EmailRow[] {
  return db
    .prepare(LIST_SQL)
    .all({
      state: filter.state ?? 'all',
      category: filter.category ?? null,
      priority: filter.priority ?? null,
      unreadOnly: filter.unreadOnly ? 1 : 0,
      limit: filter.limit,
    }) as EmailRow[];
}

/** 取最新 uidvalidity 下指定 uid 的邮件 */
export function getEmail(db: Database.Database, uid: number): EmailRow | null {
  const row = db
    .prepare('SELECT * FROM gmail_emails WHERE uid = ? ORDER BY uidvalidity DESC LIMIT 1')
    .get(uid) as EmailRow | undefined;
  return row ?? null;
}

export function searchEmails(db: Database.Database, query: string, limit: number): EmailRow[] {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;
  return db
    .prepare(
      `SELECT * FROM gmail_emails
       WHERE subject LIKE ? ESCAPE '\\'
          OR from_addr LIKE ? ESCAPE '\\'
          OR from_name LIKE ? ESCAPE '\\'
          OR body_text LIKE ? ESCAPE '\\'
          OR analysis LIKE ? ESCAPE '\\'
       ORDER BY uidvalidity DESC, uid DESC LIMIT ?`,
    )
    .all(pattern, pattern, pattern, pattern, pattern, limit) as EmailRow[];
}

export interface GmailStats {
  total: number;
  analyzed: number;
  pending: number;
  failed: number;
  /** 真正调用过 LLM 的封数 */
  llmAnalyzed: number;
  /** 被本地初筛直接过滤（垃圾/通知）的封数 */
  prefiltered: number;
  spam: number;
  spamByPrefilter: number;
  spamByLlm: number;
  unread: number;
  usage: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  models: string[];
  categories: { category: string | null; count: number }[];
  latestFetchedAt: string | null;
  latestAnalyzedAt: string | null;
  latestMailDate: string | null;
}

/** 清单/分析/垃圾邮件/LLM 用量汇总，全部来自本地 SQLite */
export function stats(db: Database.Database): GmailStats {
  const row = db
    .prepare(
      `SELECT COUNT(*) total,
              COALESCE(SUM(CASE WHEN analyzed = 1 AND analysis_error IS NULL THEN 1 ELSE 0 END), 0) analyzed,
              COALESCE(SUM(CASE WHEN analyzed = 0 THEN 1 ELSE 0 END), 0) pending,
              COALESCE(SUM(CASE WHEN analysis_error IS NOT NULL THEN 1 ELSE 0 END), 0) failed,
              COALESCE(SUM(CASE WHEN llm_calls > 0 THEN 1 ELSE 0 END), 0) llmAnalyzed,
              COALESCE(SUM(CASE WHEN prefilter_kind IN ('spam','noise') THEN 1 ELSE 0 END), 0) prefiltered,
              COALESCE(SUM(spam), 0) spam,
              COALESCE(SUM(CASE WHEN spam = 1 AND prefilter_kind = 'spam' THEN 1 ELSE 0 END), 0) spamByPrefilter,
              COALESCE(SUM(CASE WHEN spam = 1 AND llm_calls > 0 THEN 1 ELSE 0 END), 0) spamByLlm,
              COALESCE(SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END), 0) unread,
              COALESCE(SUM(llm_calls), 0) calls,
              COALESCE(SUM(llm_prompt_tokens), 0) promptTokens,
              COALESCE(SUM(llm_completion_tokens), 0) completionTokens,
              COALESCE(SUM(llm_total_tokens), 0) totalTokens,
              MAX(fetched_at) latestFetchedAt,
              MAX(analyzed_at) latestAnalyzedAt,
              MAX(date) latestMailDate
       FROM gmail_emails`,
    )
    .get() as Omit<GmailStats, 'models' | 'categories' | 'usage'> & {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  const models = (
    db
      .prepare(
        `SELECT DISTINCT llm_model FROM gmail_emails
         WHERE llm_model IS NOT NULL ORDER BY llm_model`,
      )
      .all() as { llm_model: string }[]
  ).map((item) => item.llm_model);

  const categories = db
    .prepare(
      `SELECT json_extract(analysis, '$.category') AS category, COUNT(*) AS count
       FROM gmail_emails WHERE analysis IS NOT NULL
       GROUP BY 1 ORDER BY count DESC`,
    )
    .all() as { category: string | null; count: number }[];

  return {
    total: row.total,
    analyzed: row.analyzed,
    pending: row.pending,
    failed: row.failed,
    llmAnalyzed: row.llmAnalyzed,
    prefiltered: row.prefiltered,
    spam: row.spam,
    spamByPrefilter: row.spamByPrefilter,
    spamByLlm: row.spamByLlm,
    unread: row.unread,
    usage: {
      calls: row.calls,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
    },
    models,
    categories,
    latestFetchedAt: row.latestFetchedAt,
    latestAnalyzedAt: row.latestAnalyzedAt,
    latestMailDate: row.latestMailDate,
  };
}
