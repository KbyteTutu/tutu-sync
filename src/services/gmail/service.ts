import type Database from 'better-sqlite3';
import type { Logger } from '../../lib/log.js';
import { errMsg } from '../../lib/log.js';
import type { GmailConfig } from './schema.js';
import { GmailImap } from './imap.js';
import { runSync, type SyncSummary } from './sync.js';

/**
 * 邮件服务：进程内定时同步 + 手动触发。同步串行化，失败只记日志不打挂服务。
 */
export class GmailService {
  readonly imap: GmailImap;
  private running = false;

  constructor(
    readonly cfg: GmailConfig,
    private readonly db: Database.Database,
    private readonly log: Logger,
  ) {
    this.imap = new GmailImap(cfg.imap, log);
  }

  get busy(): boolean {
    return this.running;
  }

  async sync(trigger: string): Promise<SyncSummary> {
    if (this.running) throw new Error('已有同步在执行中，请稍后再试');
    this.running = true;
    try {
      const summary = await runSync(this.cfg, this.db, this.imap, this.log);
      this.log.info(
        `同步完成(${trigger}): 新邮件 ${summary.fetched}，成功 ${summary.analyzed}，失败 ${summary.failed}`,
      );
      return summary;
    } catch (e) {
      this.log.error(`同步失败(${trigger}): ${errMsg(e)}`);
      throw e;
    } finally {
      this.running = false;
    }
  }
}
