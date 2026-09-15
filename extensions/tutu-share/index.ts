/**
 * tutu-share — 文件分享服务的工具扩展（pi 原生等价于 MCP）。
 *
 * 后端是固定独立运行的基础服务，不在本项目管理、不做部署，只使用:
 *   share-upload   http://192.168.50.31:60306   (家内 LAN 直连，服务已绑 0.0.0.0)
 *                   http://192.168.125.11:60306 (wg0 兑底，家外走隧道)
 *   share-download http://192.168.50.31:60307   (家内 LAN 直连)
 *                   http://192.168.125.11:60307 (wg0 兑底)
 * 本扩展是薄客户端: 所有状态与安全校验都在服务端，工具只做参数封装与流式传输。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// 基础服务端点：家内（本机有 192.168.50.x 网卡）走 LAN 直连，否则走 wg 隧道兑底。
// 服务绑定 0.0.0.0（见 README）；LAN 端点 192.168.50.31 依赖路由器 DHCP 保留固定。
const LAN = Object.values(networkInterfaces()).some((addrs) =>
  (addrs ?? []).some(
    (a) => a.family === "IPv4" && a.address.startsWith("192.168.50."),
  ),
);
const UP = LAN ? "http://192.168.50.31:60306" : "http://192.168.125.11:60306";
const DL = LAN ? "http://192.168.50.31:60307" : "http://192.168.125.11:60307";
// 公网域名，直接指向下载服务
const PUBLIC_BASE = "https://nas.tutu.gold";

/** 下载链接: 统一返回公网域名链接（不随本机所处网络变化，任何环境可达） */
function downloadUrl(token: string): string {
  return `${PUBLIC_BASE}/${token}`;
}

function encodeRemote(p: string): string {
  return p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function humanSize(n: number | null): string {
  if (n === null) return "?";
  if (n < 1024) return `${n}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)}${units[i]}`;
}

async function api(
  method: string,
  path: string,
  signal?: AbortSignal,
  body?: unknown,
) {
  const res = await fetch(`${UP}${path}`, {
    method,
    signal,
    ...(body === undefined ? {} : { body: body as any }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok)
    throw new Error(
      json?.error || `share service HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  return json;
}

async function listEntries(signal?: AbortSignal): Promise<any[]> {
  const data = await api("GET", "/api/list", signal);
  return data.files ?? [];
}

/** token_or_path → token（token 精确匹配，否则按远程路径匹配） */
async function resolveToken(
  input: string,
  signal?: AbortSignal,
): Promise<string> {
  const files = await listEntries(signal);
  const byToken = files.find((f: any) => f.token === input);
  if (byToken) return byToken.token;
  const byPath = files.find((f: any) => f.path === input);
  if (byPath) return byPath.token;
  throw new Error(`未找到对应分享：${input}（可用 share_list 查询）`);
}

function stripAt(p: string): string {
  return p.startsWith("@") ? p.slice(1) : p;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "share_upload",
    label: "Share: 上传文件",
    description:
      "把本机文件上传到 share 服务并返回下载链接 https://nas.tutu.gold/<token>（统一公网链接）。" +
      "上传通道自动择优: 本机在家内 LAN（有 192.168.50.x 网卡）时直连 192.168.50.31:60306，否则走 wg 隧道。" +
      "凡是用户想在手机/电脑上查看、下载、分享 pi 上产生的任何文件，一律用此工具，上传后把返回的 url 原样发给用户。" +
      "重复上传同一路径会更新内容且链接不变。支持中文与子目录。",
    promptSnippet:
      "Upload a local file and get a public download link (tutu-share)",
    promptGuidelines: [
      "Use share_upload whenever the user wants to obtain, view, or share a file from this machine — upload it and hand the returned url to the user.",
    ],
    parameters: Type.Object({
      local_path: Type.String({ description: "本机文件绝对或相对路径" }),
      remote_path: Type.Optional(
        Type.String({
          description:
            "服务端相对路径（默认取文件名；可含子目录如 docs/report.md）",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, _ctx) {
      const abs = resolve(stripAt(params.local_path));
      const st = await stat(abs).catch(() => null);
      if (!st || !st.isFile()) throw new Error(`文件不存在: ${abs}`);
      const remote =
        params.remote_path?.replace(/^\/+|\/+$/g, "") || basename(abs);
      onUpdate?.({
        content: [{ type: "text", text: `上传中 ${humanSize(st.size)}…` }],
        details: {},
      });
      const res = await fetch(`${UP}/${encodeRemote(remote)}`, {
        method: "PUT",
        body: Readable.toWeb(createReadStream(abs)) as any,
        duplex: "half",
        signal,
      } as RequestInit);
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(json?.error || `上传失败 HTTP ${res.status}`);
      const url = downloadUrl(json.token);
      return {
        content: [
          {
            type: "text",
            text: `已上传 ${remote} (${humanSize(json.size)})\n下载链接: ${url}`,
          },
        ],
        details: { url, token: json.token, path: remote },
      };
    },
  });

  pi.registerTool({
    name: "share_list",
    label: "Share: 列表",
    description:
      "列出 share 服务上所有已分享文件：远程路径、token、下载链接（本机在 wg 内网时为内网直链）、大小、缺失标记。",
    promptSnippet: "List shared files and their download links (tutu-share)",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const files = (await listEntries(signal)).map((f: any) => ({
        ...f,
        url: downloadUrl(f.token),
      }));
      if (!files.length)
        return {
          content: [{ type: "text", text: "暂无已分享文件" }],
          details: { files: [] },
        };
      const lines = files.map(
        (f: any) =>
          `${f.missing ? "[缺失] " : ""}${f.path}  ${humanSize(f.size)}  ${f.url}` +
          (f.mtime ? `  (${f.mtime})` : ""),
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { files },
      };
    },
  });

  pi.registerTool({
    name: "share_download",
    label: "Share: 下载到本机",
    description:
      "从 share 服务下载文件到本机。source 可为 token 或远程路径（会自动解析）。支持断点需手动重试。",
    promptSnippet:
      "Download a shared file to this machine by token or path (tutu-share)",
    parameters: Type.Object({
      source: Type.String({ description: "token 或远程路径" }),
      local_path: Type.String({ description: "本机保存路径" }),
    }),
    async execute(_id, params, signal, onUpdate, _ctx) {
      const token = await resolveToken(params.source, signal);
      const abs = resolve(stripAt(params.local_path));
      const res = await fetch(`${DL}/${token}`, { signal });
      if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
      onUpdate?.({ content: [{ type: "text", text: "下载中…" }], details: {} });
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(abs));
      const st = await stat(abs);
      return {
        content: [
          { type: "text", text: `已下载到 ${abs} (${humanSize(st.size)})` },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "share_delete",
    label: "Share: 删除并撤链",
    description:
      "删除 share 服务上的文件并撤销其下载链接（仅文件，不能删目录）。",
    promptSnippet: "Delete a shared file and revoke its link (tutu-share)",
    parameters: Type.Object({
      remote_path: Type.String({ description: "远程相对路径" }),
    }),
    async execute(_id, params, signal) {
      const json = await api(
        "DELETE",
        `/${encodeRemote(params.remote_path)}`,
        signal,
      );
      return {
        content: [{ type: "text", text: `已删除并撤销链接: ${json.deleted}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "share_mkdir",
    label: "Share: 建目录",
    description: "在 share 服务存储根目录下创建子目录。",
    promptSnippet: "Create a directory in share storage (tutu-share)",
    parameters: Type.Object({
      dir: Type.String({ description: "远程相对目录路径" }),
    }),
    async execute(_id, params, signal) {
      const json = await api("MKCOL", `/${encodeRemote(params.dir)}`, signal);
      return {
        content: [{ type: "text", text: `已创建目录: ${json.path}` }],
        details: {},
      };
    },
  });
}
