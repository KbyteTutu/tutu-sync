import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDb(file: string): Database.Database {
  const dir = path.dirname(file);
  // 库里有邮件正文与令牌摘要：目录与库文件一律 0700/0600（WAL/SHM 由 SQLite 继承库文件权限）
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const db = new Database(file);
  fs.chmodSync(file, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * 全库表结构。hosts/enrollments 是中台状态（各 pi 主机的访问令牌与一次性注册码），
 * gmail_* 是邮件服务的本地缓存。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS hosts (
  name TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  wg_ip TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS enrollments (
  token_hash TEXT PRIMARY KEY,
  host_name TEXT NOT NULL,
  wg_ip TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function migrate(db: Database.Database): void {
  db.exec(SCHEMA);
}
