import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';

export type Role = 'master' | 'host';

export interface Caller {
  role: Role;
  /** host 角色对应的主机名；master 为 null */
  host: string | null;
}

export interface HostRow {
  name: string;
  wg_ip: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface HostDbRow {
  name: string;
  wg_ip: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** 令牌形如 tutu_<43 位 base64url>，与一次性注册码同构 */
const TOKEN_PREFIX = 'tutu_';

export function mintToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** 令牌只以 sha256 摘要落库，数据库泄露不直接暴露可用凭据 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * 访问控制。两条信任路径：
 *  - master token（环境变量 TUTU_MASTER_TOKEN）：管理密钥，可签发/吊销主机
 *  - host token（数据库，sha256）：由主令牌注册的主机，只能读写与自身职责相关的工具
 */
export class AuthStore {
  private readonly masterHash: string;

  constructor(
    private readonly db: Database.Database,
    masterToken: string,
  ) {
    if (masterToken.length < 32) {
      throw new Error('TUTU_MASTER_TOKEN 至少 32 字符（用 openssl rand -base64 48 生成）');
    }
    this.masterHash = hashToken(masterToken);
  }

  /** 解析请求令牌；host 令牌会刷新 last_used_at */
  resolve(token: string): Caller | null {
    const hash = hashToken(token);
    if (safeEqualHex(hash, this.masterHash)) return { role: 'master', host: null };
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const row = this.db
      .prepare('SELECT name FROM hosts WHERE token_hash = ?')
      .get(hash) as { name: string } | undefined;
    if (!row) return null;
    this.db
      .prepare('UPDATE hosts SET last_used_at = ? WHERE name = ?')
      .run(new Date().toISOString(), row.name);
    return { role: 'host', host: row.name };
  }

  listHosts(): HostRow[] {
    return this.db
      .prepare('SELECT name, wg_ip, created_at, last_used_at FROM hosts ORDER BY created_at')
      .all() as HostDbRow[];
  }

  getHost(name: string): HostRow | null {
    const row = this.db
      .prepare('SELECT name, wg_ip, created_at, last_used_at FROM hosts WHERE name = ?')
      .get(name) as HostDbRow | undefined;
    return row ?? null;
  }

  /** 注册或轮换主机令牌（同名主机重注册即吊销旧令牌），返回明文令牌（仅此一次） */
  issueHost(name: string, wgIp: string | null): string {
    const token = mintToken();
    this.db
      .prepare(
        `INSERT INTO hosts (name, token_hash, wg_ip, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET token_hash = excluded.token_hash, wg_ip = excluded.wg_ip`,
      )
      .run(name, hashToken(token), wgIp, new Date().toISOString());
    return token;
  }

  revokeHost(name: string): HostRow | null {
    const host = this.getHost(name);
    if (!host) return null;
    this.db.prepare('DELETE FROM hosts WHERE name = ?').run(name);
    return host;
  }

  /**
   * 签发一次性注册码。只落摘要，TTL 到期或首次兑换后失效。
   * wgIp 是预分配的内网 IP（可选），兑换时才真正生成密钥并写入 peer。
   */
  createEnrollment(hostName: string, wgIp: string | null, ttlMs: number): string {
    const token = mintToken();
    const now = Date.now();
    this.db.prepare('DELETE FROM enrollments WHERE expires_at < ?').run(now);
    this.db
      .prepare(
        `INSERT INTO enrollments (token_hash, host_name, wg_ip, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), hostName, wgIp, now + ttlMs, new Date().toISOString());
    return token;
  }

  /** 兑换注册码：原子删除（单次使用），返回绑定的主机名与预分配 IP */
  consumeEnrollment(token: string): { hostName: string; wgIp: string | null } | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const hash = hashToken(token);
    const row = this.db
      .prepare('SELECT host_name, wg_ip, expires_at FROM enrollments WHERE token_hash = ?')
      .get(hash) as { host_name: string; wg_ip: string | null; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    const deleted = this.db.prepare('DELETE FROM enrollments WHERE token_hash = ?').run(hash);
    if (deleted.changes !== 1) return null;
    return { hostName: row.host_name, wgIp: row.wg_ip };
  }
}
