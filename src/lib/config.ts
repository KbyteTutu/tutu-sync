import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * 服务根配置段。所有相对路径都以配置文件所在目录为基准。
 */
export const RootBaseSchema = z.object({
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  server: z.object({
    // 默认只听回环: 由宿主机反代（TLS）或 wg 内网地址对外提供，避免直接暴露公网。
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().positive().default(60380),
    // 生成引导命令时使用的对外地址；省略时按 host/port 推导
    public_url: z.string().url().optional(),
  }),
  storage: z.object({
    path: z.string().min(1),
  }),
});

/** 配置文件的值树（YAML 解析结果的领域类型） */
type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue };

/** 递归展开配置中的 ${ENV_VAR} 引用（密钥等敏感信息一律走环境变量） */
function interpolate(node: ConfigValue, file: string): ConfigValue {
  if (typeof node === 'string') {
    const refs = [...node.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)];
    if (refs.length === 0) return node;
    let out = node;
    for (const ref of refs) {
      const name = ref[1];
      const v = process.env[name];
      if (v === undefined || v === '') {
        throw new Error(`配置引用的环境变量 ${name} 未设置（${file} 中的 \${${name}}）`);
      }
      out = out.replaceAll(ref[0], v);
    }
    return out;
  }
  if (Array.isArray(node)) return node.map((n) => interpolate(n, file));
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, interpolate(v, file)]),
    );
  }
  return node;
}

export interface LoadedConfig<T> {
  config: T;
  /** 配置文件所在目录，相对路径以此为基准 */
  dir: string;
}

export function loadConfig<T>(file: string, schema: z.ZodType<T>): LoadedConfig<T> {
  const abs = path.resolve(file);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    const hint =
      (e as NodeJS.ErrnoException).code === 'EISDIR'
        ? '该路径是目录：compose 挂载要求 config.yaml 先存在（cp config.example.yaml config.yaml）'
        : '用 --config 指定路径';
    throw new Error(`无法读取配置文件: ${abs}（${hint}）`);
  }
  const data = schema.parse(interpolate(parseYaml(raw) as ConfigValue, abs));
  return { config: data, dir: path.dirname(abs) };
}

/** 配置中的相对路径一律相对配置文件目录解析 */
export function resolveFromConfig(dir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(dir, p);
}

/** 代码根目录（dist/lib → 项目根），用于定位随仓库发布的 assets/ */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
