import type Database from 'better-sqlite3';

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
  analyzed: number;
  analysis: string | null;
  analysis_error: string | null;
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
}

export interface SyncState {
  mailbox: string;
  uidvalidity: number;
  last_uid: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gmail_emails (
  uidvalidity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  from_addr TEXT,
  from_name TEXT,
  to_addr TEXT,
  subject TEXT,
  date TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  snippet TEXT,
  body_text TEXT,
  analyzed INTEGER NOT NULL DEFAULT 0,
  analysis TEXT,
  analysis_error TEXT,
  fetched_at TEXT NOT NULL,
  analyzed_at TEXT,
  PRIMARY KEY (uidvalidity, uid)
);
CREATE INDEX IF NOT EXISTS idx_gmail_emails_date ON gmail_emails(date);
CREATE INDEX IF NOT EXISTS idx_gmail_emails_analyzed ON gmail_emails(analyzed);
CREATE TABLE IF NOT EXISTS gmail_sync_state (
  mailbox TEXT PRIMARY KEY,
  uidvalidity INTEGER NOT NULL,
  last_uid INTEGER NOT NULL DEFAULT 0
);
`;

export function migrateGmail(db: Database.Database): void {
  db.exec(SCHEMA);
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
        date, seen, snippet, body_text, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    new Date().toISOString(),
  );
}

export function setAnalysis(
  db: Database.Database,
  uidvalidity: number,
  uid: number,
  analysis: string | null,
  error: string | null,
): void {
  db.prepare(
    `UPDATE gmail_emails
     SET analyzed = 1, analysis = ?, analysis_error = ?, analyzed_at = ?
     WHERE uidvalidity = ? AND uid = ?`,
  ).run(analysis, error, new Date().toISOString(), uidvalidity, uid);
}

export interface ListFilter {
  limit: number;
  category?: string;
  priority?: 'high' | 'medium' | 'low';
  unreadOnly?: boolean;
  includeFailed?: boolean;
}

/** 全静态 SQL + 命名参数，无任何字符串拼接 */
const LIST_SQL = `
  SELECT * FROM gmail_emails
  WHERE (@includeFailed OR analyzed = 1)
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
      includeFailed: filter.includeFailed ? 1 : 0,
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
