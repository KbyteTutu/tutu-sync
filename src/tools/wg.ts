import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Caller } from '../lib/auth.js';
import type { IssuedPeer, PeerStatus } from '../services/wg/manager.js';
import { code, failure, formatTime, masterOnly, text, unexpected } from './helpers.js';

export function registerWgTools(server: McpServer, ctx: AppContext, caller: Caller): void {
  server.registerTool(
    'tutu_wg_peers',
    {
      description:
        '列出 tutu 内网 WireGuard 节点：IP、用途名、公钥、实时 endpoint 与最近握手时间（无握手=未上线）。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const status = ctx.wg.status();
      if (!status.available) return failure(`WireGuard 不可用: ${status.reason}`);
      try {
        return text(formatPeers(ctx.wg.list()));
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_wg_issue',
    {
      description:
        '在 wg 服务器上签发一个新节点（不涉及 pi 主机令牌，适用于手机/路由等设备）：分配内网 IP、生成密钥对、追加 peer 并热应用到 wg0，' +
        '返回可直接落盘的客户端配置。私钥只在本次结果中出现，务必当场保存。需要 master 令牌。',
      inputSchema: {
        name: z.string().min(1).max(40).describe('用途名（写入 # nickname: 注释，禁止空白与 #）'),
        ip: z.string().optional().describe('指定内网 IP；省略则自动取最小空闲 IP'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
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
      description: '删除 wg 节点（按 IP 或用途名定位），从 wg0.conf 移除 peer 块并热应用。需要 master 令牌。',
      inputSchema: {
        target: z.string().min(1).describe('节点 IP（192.168.125.X）或用途名'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ target }) => {
      const denied = masterOnly(caller, '删除 wg 节点');
      if (denied) return denied;
      try {
        const peer = await ctx.wg.remove(target);
        return text(`✓ 已删除节点: ${peer.nickname || '(无名)'} (${peer.allowedIps.join(', ')})\n配置已热应用，wg-quick@wg0 未重启。`);
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_wg_rotate',
    {
      description:
        '轮换 wg 节点密钥（设备私钥丢失时用）：保留 IP 与用途名，生成新密钥对替换 peer 公钥并热应用，返回新的客户端配置。旧私钥立即失效。需要 master 令牌。',
      inputSchema: {
        target: z.string().min(1).describe('节点 IP（192.168.125.X）或用途名'),
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

function formatPeers(peers: PeerStatus[]): string {
  if (peers.length === 0) return '当前没有任何节点。用 tutu_wg_issue 或 tutu_host_enroll 签发。';
  const lines = [`共 ${peers.length} 个节点：`, ''];
  for (const peer of peers) {
    const handshake = peer.lastHandshake ? `${formatTime(peer.lastHandshake)} UTC` : '从未握手';
    lines.push(`- ${peer.ip}  ${peer.nickname || '(无名)'}  · ${handshake}`);
    lines.push(`  公钥 ${peer.publicKey}${peer.endpoint ? ` · endpoint ${peer.endpoint}` : ''}`);
  }
  return lines.join('\n');
}

function formatIssued(ctx: AppContext, issued: IssuedPeer, rotated: boolean): string {
  const dnsNote = ctx.cfg.wg?.dns
    ? ''
    : '\n注: 配置省略了 resolvectl hook，*.tu 域名不可解析（IP 直连不受影响）。';
  const lines = [
    `✓ ${rotated ? '已轮换密钥' : '已签发节点'}: ${issued.ip} (${issued.nickname})`,
    `公钥: ${issued.publicKey}`,
    rotated ? '⚠ 旧私钥已作废，目标机器必须按下面的配置整体重写。' : '⚠ 私钥仅此一次展示，请当场保存（服务器不落盘私钥）。',
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
    dnsNote,
  ];
  return lines.filter((line) => line !== '').join('\n');
}
