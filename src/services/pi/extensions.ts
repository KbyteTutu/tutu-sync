import type { PiConfig } from './config.js';

export interface ExtensionEntry {
  source: string;
  install: string;
}

/** 扩展源只允许普通包/仓库标识：拒绝空白与 shell 元字符，避免被当成命令片段 */
const SOURCE_RE = /^[A-Za-z0-9@:._~+/-]{1,200}$/;

export function extensionPlan(cfg: PiConfig): ExtensionEntry[] {
  return cfg.extensions.map((source) => {
    if (!SOURCE_RE.test(source)) {
      throw new Error(`pi.extensions 中的源不合法（禁止空白与 shell 元字符）: "${source}"`);
    }
    return { source, install: `pi install ${source}` };
  });
}
