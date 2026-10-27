import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Caller } from '../lib/auth.js';
import type { DigestSummary } from '../services/gmail/service.js';
import {
  getEmail,
  listEmails,
  searchEmails,
  stats,
  type EmailRow,
  type EmailState,
} from '../services/gmail/store.js';
import { failure, masterOnly, text, unexpected } from './helpers.js';

/** 邮件正文属于最敏感数据：全部工具一律要求 master 令牌 */
export function registerGmailTools(server: McpServer, ctx: AppContext, caller: Caller): void {
  const gmail = ctx.gmail;
  if (!gmail) return;

  server.registerTool(
    'tutu_gmail_sync',
    {
      description:
        `立即从 Gmail 增量拉取新邮件并写入本地清单（只落库，不做 LLM 分析，不重复下载已有邮件）。`
        + `服务本身每 ${gmail.cfg.fetch.interval} 自动拉取。需要 master 令牌。`,
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async () => {
      const denied = masterOnly(caller, '同步邮件');
      if (denied) return denied;
      try {
        const summary = await gmail.sync('手动');
        return text(
          `拉取完成: 新邮件 ${summary.fetched}，水位 uid=${summary.lastUid}（已落库，未分析）`,
        );
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_gmail_digest',
    {
      description:
        '按需处理增量未处理邮件，供 agent/claw 直接使用：先用本地规则（发件人/主题/完整正文/批量发件头）'
        + '按置信度初筛，>=80% 确认是垃圾或自动通知的直接过滤、不花 token；其余（含普通邮件与拿不准的）'
        + '才交给 LLM 生成摘要。返回有价值摘要；若全部被过滤，明确返回"无有价值信息"。'
        + '单次约 45 秒预算，返回剩余待处理数，重复调用即可清空。需要 master 令牌。',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe('本次最多处理封数（本地初筛很快，LLM 部分受时间预算约束）'),
        instruction: z
          .string()
          .max(500)
          .optional()
          .describe('本次分析要求，追加到 LLM 系统提示词（例如"只关注需要我回复或付款的邮件"）'),
        retry_failed: z.boolean().default(false).describe('是否重试此前 LLM 分析失败的邮件'),
      },
      annotations: { openWorldHint: false },
    },
    async ({ limit, instruction, retry_failed }) => {
      const denied = masterOnly(caller, '分析邮件');
      if (denied) return denied;
      try {
        const summary = await gmail.digest({ limit, instruction, retryFailed: retry_failed });
        return text(fmtDigest(summary));
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_gmail_stats',
    {
      description:
        '邮件域统计：清单总数、已处理/待处理、LLM 分析封数与本地过滤封数、垃圾邮件数（本地/LLM 分解）、'
        + '未读数、LLM 调用次数与 token、使用的模型、分类分布、最近拉取/分析时间与同步水位。需要 master 令牌。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => {
      const denied = masterOnly(caller, '查看邮件统计');
      if (denied) return denied;
      const data = stats(ctx.db);
      const state = gmail.syncState();
      return text(fmtStats(data, state, gmail.cfg.llm.model));
    },
  );

  server.registerTool(
    'tutu_gmail_list',
    {
      description: '列出本地清单中的邮件（按时间倒序），支持分类/优先级/未读/处理状态过滤。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe('返回条数'),
        category: z
          .string()
          .optional()
          .describe('按分类过滤（如 通知/营销/安全/账务/工作/个人/垃圾/其他）'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('按优先级过滤'),
        unread_only: z.boolean().default(false).describe('仅未读'),
        state: z
          .enum(['all', 'processed', 'pending', 'failed'])
          .default('all')
          .describe('处理状态：all 全部 / analyzed 已处理 / pending 待处理 / failed 分析失败'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ limit, category, priority, unread_only, state }) => {
      const denied = masterOnly(caller, '查看邮件');
      if (denied) return denied;
      const rows = listEmails(ctx.db, {
        limit,
        category,
        priority,
        unreadOnly: unread_only,
        state: state as EmailState,
      });
      return text(fmtList(rows));
    },
  );

  server.registerTool(
    'tutu_gmail_get',
    {
      description: '查看单封邮件详情（处理结果 + 正文）。未处理的邮件会提示先调用 tutu_gmail_digest。',
      inputSchema: {
        uid: z.number().int().positive().describe('邮件 uid（来自 tutu_gmail_list / tutu_gmail_search）'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ uid }) => {
      const denied = masterOnly(caller, '查看邮件详情');
      if (denied) return denied;
      const row = getEmail(ctx.db, uid);
      if (!row) return failure(`未找到 uid=${uid} 的邮件`);
      return text(fmtDetail(row));
    },
  );

  server.registerTool(
    'tutu_gmail_search',
    {
      description:
        '按关键词检索本地清单（匹配主题/发件人/正文/分析结果），不访问 Gmail 服务器；'
        + '只覆盖已同步过的邮件。',
      inputSchema: {
        query: z.string().min(1).describe('搜索关键词'),
        limit: z.number().int().min(1).max(100).default(20).describe('返回条数'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) => {
      const denied = masterOnly(caller, '搜索邮件');
      if (denied) return denied;
      return text(fmtList(searchEmails(ctx.db, query, limit)));
    },
  );
}

function fmtNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function analysisFields(row: EmailRow): Record<string, unknown> {
  if (!row.analysis) return {};
  try {
    return JSON.parse(row.analysis) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stateLabel(row: EmailRow, analysis: Record<string, unknown>): string | null {
  if (row.analyzed === 0) return '待处理';
  if (row.prefilter_kind === 'spam' || row.prefilter_kind === 'noise') {
    return `本地过滤:${row.prefilter_kind === 'spam' ? '垃圾' : '通知'}(${row.prefilter_score}%)`;
  }
  if (analysis.category) return String(analysis.category);
  return null;
}

function fmtList(rows: EmailRow[]): string {
  if (rows.length === 0) return '没有符合条件的邮件。';
  const lines: string[] = [`共 ${rows.length} 封：`, ''];
  for (const row of rows) {
    const analysis = analysisFields(row);
    const meta = [
      `uid=${row.uid}`,
      row.date ? row.date.slice(0, 16).replace('T', ' ') : '时间未知',
      row.seen ? '已读' : '未读',
      stateLabel(row, analysis),
      analysis.priority ? `优先级:${String(analysis.priority)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`## ${meta}`);
    lines.push(`发件人: ${row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr}`);
    lines.push(`主题: ${row.subject ?? '(无主题)'}`);
    if (analysis.summary) lines.push(`摘要: ${String(analysis.summary)}`);
    if (row.analysis_error) lines.push(`(分析失败: ${row.analysis_error})`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function fmtDetail(row: EmailRow): string {
  const lines: string[] = [
    `uid: ${row.uid}`,
    `发件人: ${row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr}`,
    `收件人: ${row.to_addr ?? '未知'}`,
    `主题: ${row.subject ?? '(无主题)'}`,
    `时间: ${row.date ?? '未知'}`,
    `状态: ${row.seen ? '已读' : '未读'}${row.analyzed === 0 ? ' · 待处理' : ''}`,
    '',
  ];
  if (row.analysis) {
    const source =
      row.prefilter_kind === 'spam' || row.prefilter_kind === 'noise'
        ? `本地初筛（置信度 ${row.prefilter_score}%，未调用 LLM）`
        : `LLM: ${row.llm_model ?? '?'} · 调用 ${row.llm_calls} 次 · total ${fmtNumber(row.llm_total_tokens)} tokens`;
    lines.push(`## 处理结果（${source}）`);
    try {
      lines.push(JSON.stringify(JSON.parse(row.analysis), null, 2));
    } catch {
      lines.push(row.analysis);
    }
    lines.push('');
  } else if (row.analysis_error) {
    lines.push(`## 分析失败\n${row.analysis_error}\n`);
  } else {
    lines.push('## 处理结果\n尚未处理（可用 tutu_gmail_digest 按需处理）\n');
  }
  if (row.body_text) {
    const body = row.body_text.length > 4000 ? `${row.body_text.slice(0, 4000)}…[已截断]` : row.body_text;
    lines.push('## 正文', body);
  }
  return lines.join('\n');
}

function fmtDigest(summary: DigestSummary): string {
  if (summary.processed === 0) {
    return `没有待处理的邮件（剩余 ${summary.remaining}）。`;
  }
  const filtered = summary.skippedSpam + summary.skippedNoise;
  const lines: string[] = [
    `本次处理 ${summary.processed} 封：LLM 分析 ${summary.analyzed} · 本地过滤 ${filtered}`
      + `（垃圾 ${summary.skippedSpam} / 通知 ${summary.skippedNoise}）· 失败 ${summary.failed}`,
  ];
  if (summary.usage.calls > 0) {
    lines.push(
      `LLM: ${summary.usage.model} · 调用 ${summary.usage.calls} 次 · total ${fmtNumber(summary.usage.totalTokens)} tokens`,
    );
  }
  lines.push(`剩余待处理: ${summary.remaining}${summary.remaining > 0 ? '（继续调用即可）' : ''}`);
  lines.push('');

  if (summary.items.length === 0) {
    lines.push(
      `无有价值信息：本次 ${filtered} 封均为垃圾/自动通知`
        + `${summary.failed > 0 ? `，另有 ${summary.failed} 封分析失败` : ''}。`,
    );
    return lines.join('\n');
  }

  lines.push(`## 有价值邮件（${summary.items.length}）`);
  for (const item of summary.items) {
    lines.push(
      '',
      `### uid=${item.uid} · ${item.priority ?? 'medium'} · ${item.category ?? '其他'}`
        + (item.date ? ` · ${item.date.slice(0, 16).replace('T', ' ')}` : ''),
      `发件人: ${item.from ?? '未知'}`,
      `主题: ${item.subject ?? '(无主题)'}`,
      `摘要: ${item.summary ?? '(无摘要)'}`,
    );
    if (item.actionRequired || item.action) {
      lines.push(`需要行动: ${item.actionRequired ? '是' : '否'}${item.action ? ` — ${item.action}` : ''}`);
    }
  }
  return lines.join('\n');
}

function fmtStats(
  data: ReturnType<typeof stats>,
  state: { mailbox: string; uidvalidity: number; last_uid: number } | null,
  configuredModel: string,
): string {
  const lines: string[] = ['## 邮件清单', ''];
  lines.push(
    `总数 ${fmtNumber(data.total)} · 已处理 ${fmtNumber(data.analyzed)} · 待处理 ${fmtNumber(data.pending)}`
      + ` · 失败 ${fmtNumber(data.failed)} · 未读 ${fmtNumber(data.unread)}`,
  );
  lines.push(
    `LLM 分析 ${fmtNumber(data.llmAnalyzed)} 封 · 本地初筛过滤 ${fmtNumber(data.prefiltered)} 封`,
  );
  const spamRate = data.analyzed > 0 ? ((data.spam / data.analyzed) * 100).toFixed(1) : '0.0';
  lines.push(
    `垃圾邮件: ${fmtNumber(data.spam)}（本地 ${fmtNumber(data.spamByPrefilter)} / LLM ${fmtNumber(data.spamByLlm)}，占已处理 ${spamRate}%）`,
  );

  lines.push('', '## LLM 用量', '');
  lines.push(`调用: ${fmtNumber(data.usage.calls)} 次`);
  lines.push(
    `tokens: prompt ${fmtNumber(data.usage.promptTokens)} · completion ${fmtNumber(data.usage.completionTokens)} · total ${fmtNumber(data.usage.totalTokens)}`,
  );
  const models = data.models.length > 0 ? data.models.join(', ') : configuredModel;
  lines.push(`模型: ${models}（当前配置 ${configuredModel}）`);

  if (data.categories.length > 0) {
    lines.push('', '## 分类分布', '');
    lines.push(
      data.categories
        .map((item) => `${item.category ?? '(未分类)'} ${fmtNumber(item.count)}`)
        .join(' · '),
    );
  }

  lines.push('', '## 时间与水位', '');
  lines.push(`最近拉取: ${formatTime(data.latestFetchedAt)} · 最近处理: ${formatTime(data.latestAnalyzedAt)}`);
  lines.push(`最新邮件: ${formatTime(data.latestMailDate)}`);
  if (state) {
    lines.push(`水位: ${state.mailbox} · uidvalidity ${state.uidvalidity} · last_uid ${state.last_uid}`);
  }
  return lines.join('\n');
}

function formatTime(iso: string | null): string {
  if (!iso) return '从未';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
