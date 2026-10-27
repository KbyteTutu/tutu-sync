import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Caller } from '../lib/auth.js';
import { extensionPlan } from '../services/pi/extensions.js';
import { modelsSyncedAt, readProvider, syncModels } from '../services/pi/models.js';
import { code, failure, formatTime, masterOnly, text, unexpected } from './helpers.js';

export function registerPiTools(server: McpServer, ctx: AppContext, caller: Caller): void {
  server.registerTool(
    'tutu_pi_models',
    {
      description:
        '同步 tutu 模型规范版（唯一事实来源，供所有主机共用）：调用确定性执行器拉取 CPA 参数目录与 /v1/models，' +
        '更新中心规范 models.json，并把 providers.tu 返回给调用方写入本机 ~/.pi/agent/models.json。' +
        'dry_run 预览、full 全量重查。返回 needs_research 时，按 research[].query 检索后把结果以 research 参数再次调用。' +
        '需要 master 令牌。',
      inputSchema: {
        full: z.boolean().default(false).describe('全量刷新（忽略缓存基线，重新检索未覆盖模型）'),
        dry_run: z.boolean().default(false).describe('只预览变化，不写规范版'),
        research: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('未覆盖模型的检索结果: { "<model id>": { contextWindow?, maxTokens?, reasoning?, levels?, sources: [...] } | null }'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ full, dry_run, research }) => {
      const denied = masterOnly(caller, '同步模型规范版');
      if (denied) return denied;
      try {
        if (research !== undefined) {
          for (const [id, value] of Object.entries(research)) {
            if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
              return failure(`research["${id}"] 必须是对象或 null`);
            }
          }
        }
        const { report, provider } = await syncModels(ctx.cfg.pi, { full, dryRun: dry_run, research });
        return text(formatReport(report, provider));
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_pi_models_get',
    {
      description:
        '读取中心规范版 providers.tu（只读）：把返回对象写入本机 ~/.pi/agent/models.json 的 providers.tu，' +
        '保留本机其他 provider。任何已注册主机都可用；规范版由 master 的 tutu_pi_models 维护。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => {
      const provider = readProvider(ctx.cfg.pi);      if (!provider) return failure('规范版尚未生成：先在有 master 令牌的会话执行 tutu_pi_models');
      const models = Array.isArray(provider.models) ? provider.models.length : 0;
      const syncedAt = modelsSyncedAt(ctx.cfg.pi);
      return text(
        [
          `规范版: ${models} 个模型${syncedAt ? ` · 最近同步 ${formatTime(syncedAt)} UTC` : ''}`,
          '',
          code(JSON.stringify(provider, null, 2), 'json'),
        ].join('\n'),
      );
    },
  );
  server.registerTool(
    'tutu_pi_extensions',
    {
      description:
        '返回新主机应安装的 pi 扩展清单与安装命令（中心维护的唯一清单）。已安装的用 `pi list` 比对后跳过，' +
        '单个失败不中断整体。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => {
      try {
        const plan = extensionPlan(ctx.cfg.pi);
        if (plan.length === 0) return text('中心未配置任何扩展（config.yaml 的 pi.extensions 为空）。');
        const lines = [`共 ${plan.length} 个扩展：`, ''];
        for (const entry of plan) lines.push(`- ${entry.source}`);
        lines.push('', '## 安装命令（缺失的逐个执行）', '', code(plan.map((e) => e.install).join('\n'), 'bash'));
        lines.push('安装后运行 `pi list` 校验，新扩展在下一个 pi 会话生效。');
        return text(lines.join('\n'));
      } catch (e) {
        return unexpected(e);
      }
    },
  );
}

/** 报告 + 规范版 providers.tu；needs_research 时给出续跑指引 */
function formatReport(
  report: Record<string, unknown>,
  provider: Record<string, unknown> | null,
): string {
  const status = String(report.status ?? 'unknown');
  const lines = [`status: ${status}`, ''];

  const summary = [
    `models: ${report.models ?? '?'}`,
    `added: ${Array.isArray(report.added) ? report.added.length : 0}`,
    `deleted: ${Array.isArray(report.deleted) ? report.deleted.length : 0}`,
    `updated: ${Array.isArray(report.updated) ? report.updated.length : 0}`,
  ];
  lines.push(summary.join(' · '));

  const catalog = report.catalog as Record<string, unknown> | undefined;
  if (catalog) {
    lines.push(
      `catalog: ${catalog.state ?? '?'} · ${catalog.models ?? 0} 条${catalog.generated_at ? ` · ${catalog.generated_at}` : ''}`,
    );
  }
  if (report.degraded === true) {
    lines.push('⚠ degraded: 结论基于缓存基线，未核对 CPA 目录，建议稍后重跑。');
  }
  const warnings = report.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const warning of warnings) lines.push(`- ${String(warning)}`);
  }
  if (report.message) lines.push('', `error: ${String(report.message)}`);

  if (status === 'needs_research') {
    const research = Array.isArray(report.research) ? report.research : [];
    lines.push('', '## 待检索模型（本轮未写入）', '');
    for (const item of research) {
      const row = item as { id?: string; query?: string };
      lines.push(`- ${row.id ?? '?'}  → 检索词: ${row.query ?? '?'}`);
    }
    lines.push(
      '',
      '检索官方文档确认参数后，把结果作为 research 参数再次调用本工具（查不到的填 null），脚本会重新取事实再判定。',
    );
    return lines.join('\n');
  }

  if (provider === null) {
    lines.push('', '（本次未产出规范版：dry_run 或同步未完成）');
    return lines.join('\n');
  }

  lines.push(
    '',
    '## 规范版 providers.tu',
    '',
    '把下面的对象写入本机 `~/.pi/agent/models.json` 的 `providers.tu`（保留其他 provider 与手改字段）：',
    '',
    code(JSON.stringify(provider, null, 2), 'json'),
  );
  lines.push(
    '',
    '其他主机不必重跑同步，直接调 `tutu_pi_models_get` 取同一份规范版。',
  );
  return lines.join('\n');
}
