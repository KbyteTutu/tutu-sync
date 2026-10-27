import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Caller } from '../lib/auth.js';
import { errMsg } from '../lib/log.js';

export function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

export function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `✗ ${message}` }], isError: true };
}

export function unexpected(e: unknown): CallToolResult {
  return failure(errMsg(e));
}

/** 特权工具（签发/删除/改写中心状态）只接受 master 令牌 */
export function masterOnly(caller: Caller, action: string): CallToolResult | null {
  if (caller.role === 'master') return null;
  return failure(
    `${action} 需要 master 令牌（当前身份: host:${caller.host ?? '?'}）。` +
      '请在本机 ~/.pi/agent/mcp.json 中使用 TUTU_MASTER_TOKEN，或到持有 master 令牌的会话执行。',
  );
}

export function code(body: string, lang = 'text'): string {
  return `\`\`\`${lang}\n${body.trimEnd()}\n\`\`\``;
}

export function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes}m`]
    .filter(Boolean)
    .join('');
}

export function formatTime(iso: string | null): string {
  if (!iso) return '从未';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
