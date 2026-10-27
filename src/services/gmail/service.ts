import type Database from 'better-sqlite3';
import type { Logger } from '../../lib/log.js';
import { errMsg } from '../../lib/log.js';
import { analyzeEmail, type AnalysisOutcome, type LlmUsage } from './analyze.js';
import { GmailImap } from './imap.js';
import { prefilter, prefilterAnalysis } from './prefilter.js';
import type { GmailConfig } from './schema.js';
import {
  countPending,
  getSyncState,
  listPending,
  setAnalysis,
  setPrefilter,
  type SyncState,
} from './store.js';
import { runSync, type SyncSummary } from './sync.js';

export type AnalyzeFn = typeof analyzeEmail;

export interface DigestOptions {
  /** 单次最多处理封数（默认 10，配合时间预算保持客户端不超时） */
  limit: number;
  /** 本次分析要求，追加到系统提示词（只对交给 LLM 的邮件生效） */
  instruction?: string;
  /** 是否重试此前 LLM 分析失败的邮件 */
  retryFailed?: boolean;
  /** 本次调用的时间预算，默认 45 秒 */
  budgetMs?: number;
}

export interface DigestItem {
  uid: number;
  from: string | null;
  subject: string | null;
  date: string | null;
  summary: string | null;
  category: string | null;
  priority: string | null;
  actionRequired: boolean;
  action: string | null;
  spam: boolean;
}

export interface DigestSummary {
  processed: number;
  /** 本地初筛直接过滤（未调用 LLM） */
  skippedSpam: number;
  skippedNoise: number;
  /** 交给 LLM 并成功的封数 */
  analyzed: number;
  failed: number;
  remaining: number;
  items: DigestItem[];
  usage: LlmUsage;
}

/**
 * 邮件域：定时只拉取（sync）；分析按需触发（digest）。
 * digest 先用本地规则初筛，只有置信度 < 80% 的邮件才交给 LLM。
 */
export class GmailService {
  readonly imap: GmailImap;
  private syncing = false;
  private analyzing = false;

  constructor(
    readonly cfg: GmailConfig,
    private readonly db: Database.Database,
    private readonly log: Logger,
    private readonly analyzeFn: AnalyzeFn = analyzeEmail,
  ) {
    this.imap = new GmailImap(cfg.imap, log);
  }

  get busy(): boolean {
    return this.syncing || this.analyzing;
  }

  pendingCount(): number {
    return countPending(this.db);
  }

  syncState(): SyncState | null {
    return getSyncState(this.db, this.cfg.imap.mailbox);
  }

  async sync(trigger: string): Promise<SyncSummary> {
    if (this.syncing) throw new Error('已有拉取在执行中，请稍后再试');
    this.syncing = true;
    try {
      const summary = await runSync(this.cfg, this.db, this.imap, this.log);
      this.log.info(`拉取完成(${trigger}): 新邮件 ${summary.fetched}，水位 uid=${summary.lastUid}`);
      return summary;
    } catch (e) {
      this.log.error(`拉取失败(${trigger}): ${errMsg(e)}`);
      throw e;
    } finally {
      this.syncing = false;
    }
  }

  async digest(options: DigestOptions): Promise<DigestSummary> {
    if (this.analyzing) throw new Error('已有分析在执行中，请稍后再试');
    this.analyzing = true;
    const startedAt = Date.now();
    const budgetMs = options.budgetMs ?? 45_000;
    const usage: LlmUsage = {
      model: this.cfg.llm.model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let skippedSpam = 0;
    let skippedNoise = 0;
    let analyzed = 0;
    let failed = 0;
    const items: DigestItem[] = [];

    try {
      const rows = listPending(this.db, options.limit, options.retryFailed ?? false);
      for (const row of rows) {
        const processed = analyzed + failed + skippedSpam + skippedNoise;
        if (processed > 0 && Date.now() - startedAt >= budgetMs) break;

        const verdict = prefilter({
          fromAddr: row.from_addr,
          fromName: row.from_name,
          subject: row.subject,
          body: row.body_text,
          headers: row.headers,
        });

        if (verdict.skipLlm) {
          setPrefilter(this.db, row.uidvalidity, row.uid, {
            analysis: prefilterAnalysis(verdict),
            kind: verdict.kind,
            confidence: verdict.confidence,
            reason: verdict.reason,
            spam: verdict.kind === 'spam',
          });
          if (verdict.kind === 'spam') skippedSpam++;
          else skippedNoise++;
          continue;
        }

        const outcome = await this.analyzeFn(this.cfg.llm, {
          fromAddr: row.from_addr,
          fromName: row.from_name,
          subject: row.subject,
          date: row.date,
          text: row.body_text ?? '',
          instruction: options.instruction,
        });
        setAnalysis(this.db, row.uidvalidity, row.uid, outcome, {
          kind: 'valuable',
          confidence: verdict.confidence,
          reason: verdict.reason,
        });
        usage.calls += outcome.usage.calls;
        usage.promptTokens += outcome.usage.promptTokens;
        usage.completionTokens += outcome.usage.completionTokens;
        usage.totalTokens += outcome.usage.totalTokens;

        if (outcome.analysis === null) {
          failed++;
          continue;
        }
        analyzed++;
        items.push(toItem(row.uid, row.from_addr, row.from_name, row.subject, row.date, outcome));
      }

      const remaining = countPending(this.db);
      const summary: DigestSummary = {
        processed: analyzed + failed + skippedSpam + skippedNoise,
        skippedSpam,
        skippedNoise,
        analyzed,
        failed,
        remaining,
        items,
        usage,
      };
      this.log.info(
        `按需分析: 处理 ${summary.processed}，LLM ${analyzed}，过滤 ${skippedSpam + skippedNoise}`
          + `（垃圾 ${skippedSpam}/通知 ${skippedNoise}），失败 ${failed}，剩余 ${remaining}，tokens ${usage.totalTokens}`,
      );
      return summary;
    } finally {
      this.analyzing = false;
    }
  }
}

function toItem(
  uid: number,
  fromAddr: string | null,
  fromName: string | null,
  subject: string | null,
  date: string | null,
  outcome: AnalysisOutcome,
): DigestItem {
  const parsed = parseAnalysis(outcome.analysis);
  return {
    uid,
    from: fromName ? `${fromName} <${fromAddr ?? ''}>` : fromAddr,
    subject,
    date,
    summary: asString(parsed.summary),
    category: asString(parsed.category),
    priority: asString(parsed.priority),
    actionRequired: parsed.action_required === true,
    action: asString(parsed.action),
    spam: outcome.spam,
  };
}

function parseAnalysis(analysis: string | null): Record<string, unknown> {
  if (!analysis) return {};
  try {
    return JSON.parse(analysis) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
