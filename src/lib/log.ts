import { stderr } from 'node:process';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function emit(level: LogLevel, scope: string, msg: string): void {
  if (LEVELS[level] < threshold) return;
  // MCP stdio 传输用 stdout 走协议，所有日志必须走 stderr
  stderr.write(`${new Date().toISOString()} [${scope}] ${level.toUpperCase()} ${msg}\n`);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg) => emit('debug', scope, msg),
    info: (msg) => emit('info', scope, msg),
    warn: (msg) => emit('warn', scope, msg),
    error: (msg) => emit('error', scope, msg),
  };
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    // imapflow/undici 等库常把真实原因嵌在 cause 链里，逐层解包
    const cause = (e as Error & { cause?: unknown }).cause;
    return cause !== undefined ? `${e.message}: ${errMsg(cause)}` : e.message;
  }
  return String(e);
}
