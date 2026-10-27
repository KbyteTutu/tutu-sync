import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Caller } from '../lib/auth.js';
import { getEmail, listEmails, searchEmails, type EmailRow } from '../services/gmail/store.js';
import { failure, masterOnly, text, unexpected } from './helpers.js';

/** 邮件正文属于最敏感数据：四个工具一律要求 master 令牌 */
export function registerGmailTools(server: McpServer, ctx: AppContext, caller: Caller): void {
  const gmail = ctx.gmail;
  if (!gmail) return;

  server.registerTool(
    'tutu_gmail_sync',
    {
      description: '立即拉取 Gmail 新邮件并调用 LLM 分析（服务本身会定时自动拉取，通常无需手动调用）。',
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async () => {
      const denied = masterOnly(caller, '同步邮件');
      if (denied) return denied;
      try {
        const summary = await gmail.sync('手动');
        return text(
          `同步完成: 新邮件 ${summary.fetched}，分析成功 ${summary.analyzed}，失败 ${summary.failed}，水位 uid=${summary.lastUid}`,
        );
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_gmail_list',
    {
      description: '列出已分析的邮件（按时间倒序），支持按分类/优先级/未读过滤。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe('返回条数'),
        category: z.string().optional().describe('按分类过滤（如 通知/营销/安全/账务/工作/个人/其他）'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('按优先级过滤'),
        unread_only: z.boolean().default(false).describe('仅未读'),
        include_failed: z.boolean().default(false).describe('包含分析失败的邮件'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ limit, category, priority, unread_only, include_failed }) => {
      const denied = masterOnly(caller, '查看邮件');
      if (denied) return denied;
      const rows = listEmails(ctx.db, {
        limit,
        category,
        priority,
        unreadOnly: unread_only,
        includeFailed: include_failed,
      });
      return text(fmtList(rows));
    },
  );

  server.registerTool(
    'tutu_gmail_get',
    {
      description: '查看单封邮件详情（LLM 分析结果 + 正文）。',
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
      description: '按关键词搜索邮件（匹配主题/发件人/正文/分析结果）。',
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

function analysisFields(row: EmailRow): Record<string, unknown> {
  if (!row.analysis) return {};
  try {
    return JSON.parse(row.analysis) as Record<string, unknown>;
  } catch {
    return {};
  }
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
      analysis.category ? String(analysis.category) : null,
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
    `状态: ${row.seen ? '已读' : '未读'}`,
    '',
  ];
  if (row.analysis) {
    lines.push('## 分析结果');
    try {
      lines.push(JSON.stringify(JSON.parse(row.analysis), null, 2));
    } catch {
      lines.push(row.analysis);
    }
    lines.push('');
  }
  if (row.analysis_error) lines.push(`## 分析失败\n${row.analysis_error}\n`);
  if (row.body_text) {
    const body = row.body_text.length > 4000 ? `${row.body_text.slice(0, 4000)}…[已截断]` : row.body_text;
    lines.push('## 正文', body);
  }
  return lines.join('\n');
}
