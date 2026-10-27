import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Caller } from '../lib/auth.js';
import type { IssuedPeer, WgPeer } from '../services/wg/dashboard.js';
import { code, failure, masterOnly, text, unexpected } from './helpers.js';

export function registerWgTools(server: McpServer, ctx: AppContext, caller: Caller): void {
  server.registerTool(
    'tutu_wg_peers',
    {
      description:
        '列出 tutu 内网 WireGuard 节点（数据来自 WGDashboard）：IP、用途名、实时 endpoint、最近握手、运行状态、是否被限制。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const status = await ctx.wg.status();
      if (!status.available) return failure(`WireGuard 不可用: ${status.reason}`);
      try {
        const snapshot = await ctx.wg.snapshot();
        return text(formatPeers(ctx, snapshot.peers, snapshot.configuration.listenPort));
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_wg_issue',
    {
      description:
        '签发一个新节点（不涉及 pi 主机令牌，适用于手机/路由等设备）：由 WGDashboard 分配内网 IP、生成密钥并热应用，' +
        '返回可直接落盘的客户端配置。私钥只在本次结果中出现，务必当场保存。需要 master 令牌。',
      inputSchema: {
        name: z.string().min(1).max(64).describe('用途名（WGDashboard 节点名，如 手机/工作笔记本）'),
        ip: z.string().optional().describe('指定内网 IP；省略则由 WGDashboard 自动分配最小可用 IP'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ name, ip }) => {
      const denied = masterOnly(caller, '签发 wg 节点');
      if (denied) return denied;
      try {
        const issued = await ctx.wg.issue(name, ip);
        return text(formatIssued(ctx, issued, false));
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_wg_remove',
    {
      description:
        '删除 wg 节点（按 IP 或用途名定位），WGDashboard 会同时从配置与运行态移除。需要 master 令牌。',
      inputSchema: {
        target: z.string().min(1).describe('节点 IP（如 192.168.125.20）或用途名'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ target }) => {
      const denied = masterOnly(caller, '删除 wg 节点');
      if (denied) return denied;
      try {
        const peer = await ctx.wg.remove(target);
        return text(`✓ 已删除节点: ${peer.name} (${peer.ip})\nWGDashboard 已更新配置并生效。`);
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_wg_rotate',
    {
      description:
        '轮换 wg 节点密钥（设备私钥丢失时用）：保留用途名与 IP，删除后用新密钥重建，返回新的客户端配置。旧私钥立即失效。需要 master 令牌。',
      inputSchema: {
        target: z.string().min(1).describe('节点 IP（如 192.168.125.20）或用途名'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ target }) => {
      const denied = masterOnly(caller, '轮换 wg 密钥');
      if (denied) return denied;
      try {
        const issued = await ctx.wg.rotate(target);
        return text(formatIssued(ctx, issued, true));
      } catch (e) {
        return unexpected(e);
      }
    },
  );
}

function formatPeers(ctx: AppContext, peers: WgPeer[], listenPort: number): string {
  if (peers.length === 0) return '当前没有任何节点。用 tutu_wg_issue 或 tutu_host_enroll 签发。';
  const online = peers.filter((peer) => peer.status === 'running').length;
  const lines = [
    `共 ${peers.length} 个节点（运行中 ${online}）· ${ctx.cfg.wg?.configuration ?? 'wg0'} · :${listenPort || '?'}`,
    '',
  ];
  for (const peer of peers) {
    const handshake = peer.latestHandshake ?? '从未握手';
    const flags = [peer.restricted ? '已限制' : '', peer.status === 'running' ? '运行中' : '未连接']
      .filter(Boolean)
      .join(' · ');
    lines.push(`- ${peer.ip}  ${peer.name}  · ${handshake}  · ${flags}`);
    lines.push(`  公钥 ${peer.id}${peer.endpoint ? ` · endpoint ${peer.endpoint}` : ''}`);
  }
  return lines.join('\n');
}

function formatIssued(ctx: AppContext, issued: IssuedPeer, rotated: boolean): string {
  const lines = [
    `✓ ${rotated ? '已轮换密钥' : '已签发节点'}: ${issued.ip} (${issued.nickname})`,
    `公钥: ${issued.publicKey}`,
    rotated
      ? '⚠ 旧私钥已作废，目标机器必须按下面的配置整体重写。'
      : '⚠ 私钥仅此一次展示，请当场保存（WGDashboard 面板也能导出）。',
    '',
    '## 客户端配置（目标机器 /etc/wireguard/wg0.conf）',
    '',
    code(issued.clientConfig, 'ini'),
    '',
    '## 目标机器执行',
    '',
    code(
      [
        "sudo mkdir -p /etc/wireguard && sudo tee /etc/wireguard/wg0.conf >/dev/null <<'EOF'",
        issued.clientConfig.trimEnd(),
        'EOF',
        'sudo chmod 600 /etc/wireguard/wg0.conf',
        'sudo systemctl enable --now wg-quick@wg0',
        'sudo wg show wg0',
      ].join('\n'),
      'bash',
    ),
    '',
    `节点已由 WGDashboard（${ctx.cfg.wg?.dashboard.url ?? '?'}）落盘并热应用，无需再改服务器。`,
  ];
  return lines.join('\n');
}
