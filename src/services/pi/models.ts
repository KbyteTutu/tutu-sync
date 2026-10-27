import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PiConfig } from './config.js';

const execFileAsync = promisify(execFile);

/** 与 sync.py 同目录（构建时一并复制到 dist/） */
const SYNC_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sync.py');

export interface ModelsSyncOptions {
  full?: boolean;
  dryRun?: boolean;
  /** 未覆盖模型的检索结果，键为 research[].id；null 表示查询失败 */
  research?: Record<string, unknown>;
}

export interface ModelsSyncResult {
  /** sync.py 原样输出的报告 */
  report: Record<string, unknown>;
  /** 规范版 providers.tu（dry-run 或失败时可能为 null） */
  provider: Record<string, unknown> | null;
}

/**
 * 调用确定性执行器 sync.py，以 pi.home 作为 HOME 维护规范 models.json。
 * 退出码 0/2 都算「有报告」，1 需要结合 report.status 判断（error / partial）。
 */
export async function syncModels(cfg: PiConfig, options: ModelsSyncOptions): Promise<ModelsSyncResult> {
  const args = ['-B', SYNC_SCRIPT];
  if (options.full) args.push('--full');
  if (options.dryRun) args.push('--dry-run');

  let researchDir: string | null = null;
  if (options.research) {
    researchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutu-mcp-research-'));
    const file = path.join(researchDir, 'results.json');
    fs.writeFileSync(file, JSON.stringify(options.research), { mode: 0o600 });
    args.push('--results', file);
  }

  try {
    let stdout = '';
    try {
      stdout = (
        await execFileAsync('python3', args, {
          encoding: 'utf8',
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            HOME: cfg.home,
            LANG: process.env.LANG ?? 'C.UTF-8',
          },
        })
      ).stdout;
    } catch (e) {
      const failure = e as { stdout?: string; stderr?: string; message: string };
      stdout = failure.stdout ?? '';
      if (stdout.trim() === '') {
        throw new Error(`模型同步执行失败: ${(failure.stderr ?? failure.message).trim().slice(0, 500)}`);
      }
    }
    const report = parseReport(stdout);
    return { report, provider: options.dryRun ? null : readProvider(cfg) };
  } finally {
    if (researchDir !== null) fs.rmSync(researchDir, { recursive: true, force: true });
  }
}

/** 规范版 models.json 路径（容器内 pi.home 下） */
function canonicalModelsPath(cfg: PiConfig): string {
  return path.join(cfg.home, '.pi', 'agent', 'models.json');
}

/** 规范版最近一次发布（原子替换）的时间，未生成时为 null */
export function modelsSyncedAt(cfg: PiConfig): string | null {
  try {
    return fs.statSync(canonicalModelsPath(cfg)).mtime.toISOString();
  } catch {
    return null;
  }
}

/** 读取规范版 providers.tu */
export function readProvider(cfg: PiConfig): Record<string, unknown> | null {
  const file = canonicalModelsPath(cfg);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      providers?: Record<string, unknown>;
    };
    const provider = data.providers?.tu;
    return provider && typeof provider === 'object' ? (provider as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseReport(stdout: string): Record<string, unknown> {
  const text = stdout.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`模型同步未输出 JSON 报告: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error(`模型同步报告不是合法 JSON: ${text.slice(0, 300)}`);
  }
}
