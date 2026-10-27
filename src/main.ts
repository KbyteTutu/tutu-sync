import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { stderr } from 'node:process';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ConfigSchema } from './config.js';
import { createContext, SERVICE_NAME, SERVICE_VERSION, type AppContext } from './context.js';
import { APP_ROOT, loadConfig, resolveFromConfig } from './lib/config.js';
import { migrate, openDb } from './lib/db.js';
import { parseDuration } from './lib/duration.js';
import { createLogger, errMsg, setLogLevel } from './lib/log.js';
import { createMcpServer } from './server.js';

const ENROLL_BODY_LIMIT = 4096;
/** 全局失败尝试窗口：一次性注册码是 256 位随机值，限流只做卫生 */
const ENROLL_FAIL_WINDOW_MS = 10 * 60_000;
const ENROLL_FAIL_MAX = 20;
const enrollLimiter = { count: 0, resetAt: Date.now() + ENROLL_FAIL_WINDOW_MS };

/** 可对外分发的非敏感资源（新主机引导用），白名单，不接受用户拼路径 */
const ASSETS: Record<string, { file: string; type: string }> = {
  'tmux.conf': { file: 'assets/tmux.conf', type: 'text/plain; charset=utf-8' },
  'AGENTS.md': { file: 'AGENTS.md', type: 'text/markdown; charset=utf-8' },
  'tutu-share.ts': { file: 'extensions/tutu-share/index.ts', type: 'text/plain; charset=utf-8' },
};

/** init.sh 内的占位符，按当前对外地址替换，下载即自带正确的中心地址 */
const BASE_URL_PLACEHOLDER = '__TUTU_BASE_URL__';

function parseArgs(argv: string[]): { config: string } {
  let config = 'config.yaml';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') config = argv[++i] ?? config;
  }
  return { config };
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

function send(res: ServerResponse, status: number, body: string, type: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8', headers);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function mcpMethodNotAllowed(res: ServerResponse): void {
  sendJson(
    res,
    405,
    { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
    { allow: 'POST' },
  );
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function enrollmentResponse(ctx: AppContext, hostName: string, token: string, wgConfig: string): string {
  const modelsPath = path.join(ctx.cfg.pi.home, '.pi', 'agent', 'models.json');
  let models = '';
  try {
    models = fs.readFileSync(modelsPath, 'utf8');
  } catch {
    models = '';
  }
  return [
    `TUTU_HOST_NAME_B64=${base64(hostName)}`,
    `TUTU_MCP_TOKEN_B64=${base64(token)}`,
    `TUTU_MCP_URL_B64=${base64(ctx.publicUrl)}`,
    `TUTU_WG_CONF_B64=${base64(wgConfig)}`,
    `TUTU_MODELS_B64=${base64(models)}`,
    `TUTU_EXTENSIONS_B64=${base64(ctx.cfg.pi.extensions.join('\n'))}`,
    '',
  ].join('\n');
}

async function handleEnroll(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  if (Date.now() > enrollLimiter.resetAt) {
    enrollLimiter.count = 0;
    enrollLimiter.resetAt = Date.now() + ENROLL_FAIL_WINDOW_MS;
  }
  if (enrollLimiter.count >= ENROLL_FAIL_MAX) {
    sendJson(res, 429, { error: '尝试过于频繁，稍后再试' });
    return;
  }

  let enrollToken: string;
  try {
    const body = JSON.parse(await readBody(req, ENROLL_BODY_LIMIT)) as { token?: unknown };
    if (typeof body.token !== 'string') throw new Error('缺少 token');
    enrollToken = body.token;
  } catch (e) {
    enrollLimiter.count++;
    sendJson(res, 400, { error: errMsg(e) });
    return;
  }

  const pending = ctx.auth.consumeEnrollment(enrollToken);
  if (!pending) {
    enrollLimiter.count++;
    sendJson(res, 401, { error: '注册码无效、已使用或已过期' });
    return;
  }

  let wgConfig = '';
  let wgIp = pending.wgIp;
  if (ctx.cfg.wg) {
    try {
      const issued = await ctx.wg.issue(pending.hostName, pending.wgIp ?? undefined);
      wgConfig = issued.clientConfig;
      wgIp = issued.ip;
      ctx.log.info(`注册 ${pending.hostName}: 签发 wg peer ${issued.ip}`);
    } catch (e) {
      sendJson(res, 500, { error: `wg 签发失败: ${errMsg(e)}（请重新签发注册码）` });
      return;
    }
  }

  const hostToken = ctx.auth.issueHost(pending.hostName, wgIp);
  ctx.log.info(`注册 ${pending.hostName}: 颁发 host 令牌`);
  send(res, 200, enrollmentResponse(ctx, pending.hostName, hostToken, wgConfig), 'text/plain; charset=utf-8');
}

function serveInitScript(res: ServerResponse, ctx: AppContext): void {
  const file = path.join(APP_ROOT, 'assets', 'init.sh');
  let script: string;
  try {
    script = fs.readFileSync(file, 'utf8');
  } catch {
    sendJson(res, 500, { error: 'init.sh 缺失（镜像未包含 assets）' });
    return;
  }
  send(res, 200, script.replaceAll(BASE_URL_PLACEHOLDER, ctx.publicUrl), 'text/x-shellscript; charset=utf-8');
}

function serveAsset(name: string, res: ServerResponse): void {
  const asset = ASSETS[name];
  if (!asset) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  try {
    send(res, 200, fs.readFileSync(path.join(APP_ROOT, asset.file), 'utf8'), asset.type);
  } catch {
    sendJson(res, 500, { error: '资源缺失（镜像未包含 assets）' });
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const token = bearerToken(req);
  const caller = token ? ctx.auth.resolve(token) : null;
  if (!caller) {
    sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="tutu-mcp"' });
    return;
  }

  const server = createMcpServer(ctx, caller);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    ctx.log.error(`MCP 请求失败: ${errMsg(e)}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
}

function route(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> | void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  if (url.pathname === '/healthz' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptime_s: Math.floor((Date.now() - ctx.startedAt) / 1000),
    });
  }
  if (url.pathname === '/init.sh' && method === 'GET') return serveInitScript(res, ctx);
  if (url.pathname.startsWith('/assets/') && method === 'GET') {
    return serveAsset(url.pathname.slice('/assets/'.length), res);
  }
  if (url.pathname === '/api/enroll' && method === 'POST') return handleEnroll(req, res, ctx);
  if (url.pathname === '/mcp') {
    if (method !== 'POST') return mcpMethodNotAllowed(res);
    return handleMcp(req, res, ctx);
  }
  return sendJson(res, 404, { error: 'not found' });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { config, dir } = loadConfig(args.config, ConfigSchema);
  setLogLevel(config.log_level);
  const log = createLogger('main');

  const masterToken = process.env.TUTU_MASTER_TOKEN;
  if (!masterToken) {
    throw new Error('缺少 TUTU_MASTER_TOKEN 环境变量（用 openssl rand -base64 48 生成）');
  }

  const db = openDb(resolveFromConfig(dir, config.storage.path));
  migrate(db);
  const ctx = createContext(config, db, log, masterToken);

  const wgStatus = ctx.wg.status();
  log.info(
    `启动 ${SERVICE_NAME} v${SERVICE_VERSION} · 监听 ${config.server.host}:${config.server.port} · 对外 ${ctx.publicUrl}`,
  );
  log.info(
    `域: wg=${wgStatus.available ? 'on' : `off(${wgStatus.reason})`} ` +
      `share=${ctx.share ? 'on' : 'off'} pi=on gmail=${ctx.gmail ? 'on' : 'off'}`,
  );

  const httpServer = createServer((req, res) => {
    void Promise.resolve(route(req, res, ctx)).catch((e: unknown) => {
      ctx.log.error(`请求处理失败 ${req.method} ${req.url}: ${errMsg(e)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });

  let gmailTimer: NodeJS.Timeout | null = null;
  if (ctx.gmail) {
    const gmail = ctx.gmail;
    const intervalMs = parseDuration(gmail.cfg.fetch.interval) * 1000;
    setTimeout(() => void gmail.sync('启动').catch(() => undefined), 1000);
    gmailTimer = setInterval(() => void gmail.sync('定时').catch(() => undefined), intervalMs);
  }

  const shutdown = (signal: string): void => {
    log.info(`收到 ${signal}，正在退出`);
    if (gmailTimer) clearInterval(gmailTimer);
    httpServer.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.server.port, config.server.host, resolve);
  });
  log.info('就绪');
}

main().catch((e: unknown) => {
  stderr.write(`${SERVICE_NAME} 启动失败: ${errMsg(e)}\n`);
  process.exit(1);
});
