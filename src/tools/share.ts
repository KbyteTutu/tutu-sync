import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Caller } from '../lib/auth.js';
import { masterOnly, text, unexpected } from './helpers.js';

/** 本地文件的上传/下载仍由 pi 扩展 tutu-share 负责；本服务只代理中心侧管理操作 */
export function registerShareTools(server: McpServer, ctx: AppContext, caller: Caller): void {
  const share = ctx.share;
  if (!share) return;

  server.registerTool(
    'tutu_share_list',
    {
      description: '列出 share 服务上已分享的文件：远程路径、大小、公网下载链接、缺失标记。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const files = await share.list();
        if (files.length === 0) return text('暂无已分享文件。');
        const lines = [`共 ${files.length} 个文件：`, ''];
        for (const file of files) {
          const size = file.size === null ? '?' : humanSize(file.size);
          lines.push(`${file.missing ? '[缺失] ' : ''}${file.path}  ${size}  ${file.url}`);
        }
        return text(lines.join('\n'));
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_share_delete',
    {
      description: '删除 share 服务上的文件并撤销其下载链接（仅文件，不能删目录）。需要 master 令牌。',
      inputSchema: { remote_path: z.string().min(1).describe('远程相对路径') },
      annotations: { destructiveHint: true },
    },
    async ({ remote_path }) => {
      const denied = masterOnly(caller, '删除分享文件');
      if (denied) return denied;
      try {
        return text(`✓ 已删除并撤销链接: ${await share.remove(remote_path)}`);
      } catch (e) {
        return unexpected(e);
      }
    },
  );

  server.registerTool(
    'tutu_share_mkdir',
    {
      description: '在 share 存储根目录下创建子目录。需要 master 令牌。',
      inputSchema: { dir: z.string().min(1).describe('远程相对目录路径') },
      annotations: { destructiveHint: true },
    },
    async ({ dir }) => {
      const denied = masterOnly(caller, '创建分享目录');
      if (denied) return denied;
      try {
        return text(`✓ 已创建目录: ${await share.mkdir(dir)}`);
      } catch (e) {
        return unexpected(e);
      }
    },
  );
}

function humanSize(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let index = -1;
  do {
    value /= 1024;
    index++;
  } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(1)}${units[index]}`;
}
