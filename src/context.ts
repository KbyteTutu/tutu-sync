import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import { AuthStore } from './lib/auth.js';
import type { Logger } from './lib/log.js';
import { Mutex } from './lib/mutex.js';
import { GmailService } from './services/gmail/service.js';
import { ShareClient } from './services/share/client.js';
import { WgManager } from './services/wg/manager.js';

export const SERVICE_NAME = 'tutu-mcp';
export const SERVICE_VERSION = '2.0.0';

export interface AppContext {
  cfg: Config;
  db: Database.Database;
  log: Logger;
  auth: AuthStore;
  wg: WgManager;
  share: ShareClient | null;
  gmail: GmailService | null;
  /** 生成引导命令用的对外地址，无尾斜杠 */
  publicUrl: string;
  startedAt: number;
}

export function createContext(
  cfg: Config,
  db: Database.Database,
  log: Logger,
  masterToken: string,
): AppContext {
  const bindHost = cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host;
  return {
    cfg,
    db,
    log,
    auth: new AuthStore(db, masterToken),
    wg: new WgManager(cfg.wg ?? null, log, new Mutex()),
    share: cfg.share ? new ShareClient(cfg.share) : null,
    gmail: cfg.gmail ? new GmailService(cfg.gmail, db, log) : null,
    publicUrl: (cfg.server.public_url ?? `http://${bindHost}:${cfg.server.port}`).replace(/\/+$/, ''),
    startedAt: Date.now(),
  };
}
