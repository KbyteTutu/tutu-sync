import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SERVICE_NAME, SERVICE_VERSION, type AppContext } from '../context.js';
import type { Caller } from '../lib/auth.js';
import { errMsg } from '../lib/log.js';
import { modelsSyncedAt, readProvider } from '../services/pi/models.js';
import { validatePeerName } from '../services/wg/client-config.js';
import {
  code,
  failure,
  formatTime,
  formatUptime,
  masterOnly,
  text,
  unexpected,
} from './helpers.js';

export function registerHostTools(server: McpServer, ctx: AppContext, caller: Caller): void {
  server.registerTool(
    'tutu_host_status',
    {
      description:
        '中心服务总览：版本与调用身份、WireGuard 可用性与节点数、share 可用性、模型规范版新鲜度、邮件同步配置、已注册主机数。排查“为什么某个工具不可用”时先调这个。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const lines: string[] = [];
      lines.push(`# ${SERVICE_NAME} v${SERVICE_VERSION}`);
      lines.push(
        `身份: ${caller.role === 'master' ? 'master（管理令牌）' : `host:${caller.host ?? '?'}`}` +
          ` · 运行: ${formatUptime(Date.now() - ctx.startedAt)}`,
      );

      const wg = await ctx.wg.status();
      if (wg.available && ctx.cfg.wg) {
        try {
          const snapshot = await ctx.wg.snapshot();
          const online = snapshot.peers.filter((peer) => peer.status === 'running').length;
          lines.push(
            `- WireGuard: 可用（${snapshot.configuration.name} · ${snapshot.peers.length} 个节点 · ${online} 个运行中，WGDashboard ${ctx.cfg.wg.dashboard.url}）`,
          );
        } catch (e) {
          lines.push(`- WireGuard: 可用但读取节点失败 — ${errMsg(e)}`);
        }
      } else {
        lines.push(`- WireGuard: 不可用 — ${wg.reason}`);
      }

      if (ctx.share) {
        try {
          const entries = await ctx.share.list();
          lines.push(`- share: 可用（${entries.length} 个已分享文件）`);
        } catch (e) {
          lines.push(`- share: 不可用 — ${(e as Error).message}`);
        }
      } else {
        lines.push('- share: 未配置');
      }

      const provider = readProvider(ctx.cfg.pi);
      const models = Array.isArray(provider?.models) ? provider.models.length : 0;
      const syncedAt = modelsSyncedAt(ctx.cfg.pi);
      lines.push(
        provider
          ? `- 模型规范版: ${models} 个模型${syncedAt ? ` · 最近同步 ${formatTime(syncedAt)} UTC` : ''}`
          : '- 模型规范版: 尚未生成（先调 tutu_pi_models）',
      );

      lines.push(
        ctx.gmail
          ? `- 邮件: 已配置（每 ${ctx.gmail.cfg.fetch.interval} 同步${ctx.gmail.busy ? ' · 正在同步' : ''}）`
          : '- 邮件: 未配置',
      );
      lines.push(`- 已注册主机: ${ctx.auth.listHosts().length}`);

      return text(lines.join('\n'));
    },
  );

  registerEnrollTool(server, ctx, caller);
  registerTokensTool(server, ctx, caller);
  registerRevokeTool(server, ctx, caller);
}

function registerEnrollTool(server: McpServer, ctx: AppContext, caller: Caller): void {
  server.registerTool(
    'tutu_host_enroll',
    {
      description:
        '签发新主机的接入凭据：生成一次性注册码（同名主机重注册会轮换其令牌），可选同时预分配 WireGuard 内网 IP。' +
        '把返回的命令与新主机上执行，会提示粘贴注册码；完成后该主机获得自己的 host 令牌、wg 配置、模型配置与扩展清单。' +
        '需要 master 令牌。',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(40)
          .describe('主机名 / 用途标识（1-40 字符，禁止空白与 #），用作令牌标签与 wg peer nickname'),
        wg: z
          .boolean()
          .optional()
          .describe('是否同时签发 WireGuard 客户端配置；省略则按中心是否启用 wg 域自动决定'),
        ip: z.string().optional().describe('指定 wg 内网 IP；省略则兑换注册码时自动分配最小空闲 IP'),
        ttl_minutes: z
          .number()
          .int()
          .min(1)
          .max(120)
          .default(15)
          .describe('一次性注册码有效期（分钟）'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ name, wg, ip, ttl_minutes }) => {
      const denied = masterOnly(caller, '签发主机凭据');
      if (denied) return denied;
      try {
        const hostName = validatePeerName(name);
        const withWg = wg ?? (await ctx.wg.status()).available;
        if (!withWg && ip !== undefined) return failure('未开启 wg 时不能指定 IP');
        if (withWg) {
          const status = await ctx.wg.status();
          if (!status.available) return failure(`无法签发 wg 配置: ${status.reason}`);
          if (ip !== undefined) {
            try {
              await ctx.wg.assertIpAvailable(ip);
            } catch (e) {
              return failure((e as Error).message);
            }
          }
        }
        const existing = ctx.auth.getHost(hostName);
        const token = ctx.auth.createEnrollment(hostName, ip ?? null, ttl_minutes * 60_000);

        const lines = [
          `已签发一次性注册码（${ttl_minutes} 分钟内有效，仅可使用一次）`,
          '',
          `主机名: ${hostName}`,
          withWg
            ? `wg 内网 IP: ${ip ?? '兑换时自动分配最小空闲 IP'}（兑换注册码时才生成密钥并写入 peer）`
            : 'wg: 不签发（仅注册 pi 主机令牌；内网部署下新主机需先已有 wg 连通性）',
        ];
        if (existing) {
          lines.push(
            '',
            `⚠ 已存在同名主机（创建于 ${formatTime(existing.created_at)}）: 兑换成功后其旧令牌立即失效。`,
          );
        }
        lines.push(
          '',
          '## 在新主机执行',
          '',
          code(`bash -c "$(curl -fsSL ${ctx.publicUrl}/init.sh)"`),
          '',
          '提示 `一次性注册码` 时粘贴下面这一行：',
          '',
          code(token),
          '',
          '完成后在新主机启动 `pi`，即可通过 tutu-mcp 继续配置（wg 状态、模型同步、扩展安装等）。',
        );
        return text(lines.join('\n'));
      } catch (e) {
        return unexpected(e);
      }
    },
  );
}

function registerTokensTool(server: McpServer, ctx: AppContext, caller: Caller): void {
  server.registerTool(
    'tutu_host_tokens',
    {
      description: '列出已注册主机（令牌标签、wg IP、注册时间、最近使用时间）。只显示元数据，不返回任何令牌。需要 master 令牌。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const denied = masterOnly(caller, '查看主机清单');
      if (denied) return denied;
      const hosts = ctx.auth.listHosts();
      if (hosts.length === 0) return text('还没有注册任何主机。用 tutu_host_enroll 签发第一台。');
      const lines = [`共 ${hosts.length} 台主机：`, ''];
      for (const host of hosts) {
        lines.push(
          `- ${host.name}${host.wg_ip ? ` (${host.wg_ip})` : ''} · 注册 ${formatTime(host.created_at)}` +
            ` · 最近使用 ${formatTime(host.last_used_at)}`,
        );
      }
      return text(lines.join('\n'));
    },
  );
}

function registerRevokeTool(server: McpServer, ctx: AppContext, caller: Caller): void {
  server.registerTool(
    'tutu_host_revoke',
    {
      description:
        '吊销主机令牌（该主机立即无法再调用本服务）。remove_wg=true 时同时删除其 wg peer。需要 master 令牌。',
      inputSchema: {
        name: z.string().min(1).describe('主机名（见 tutu_host_tokens）'),
        remove_wg: z.boolean().default(true).describe('是否同时删除该主机的 wg peer'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ name, remove_wg }) => {
      const denied = masterOnly(caller, '吊销主机凭据');
      if (denied) return denied;
      try {
        const host = ctx.auth.revokeHost(name);
        if (!host) return failure(`未找到主机: ${name}`);
        const lines = [`✓ 已吊销主机令牌: ${host.name}`];
        if (!remove_wg) {
          if (host.wg_ip) lines.push(`wg peer 保留: ${host.wg_ip}`);
        } else if (host.wg_ip) {
          try {
            await ctx.wg.remove(host.wg_ip);
            lines.push(`✓ 已删除 wg peer: ${host.wg_ip}`);
          } catch (e) {
            lines.push(`⚠ wg peer 删除失败（${host.wg_ip}）: ${(e as Error).message}`);
          }
        } else {
          lines.push('该主机没有关联 wg IP');
        }
        return text(lines.join('\n'));
      } catch (e) {
        return unexpected(e);
      }
    },
  );
}
