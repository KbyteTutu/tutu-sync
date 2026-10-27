import type { ShareConfig } from './config.js';

export interface ShareEntry {
  path: string;
  token: string;
  size: number | null;
  mtime?: string;
  missing?: boolean;
  url: string;
}

interface ShareListResponse {
  files?: Omit<ShareEntry, 'url'>[];
}

function encodeRemote(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

/**
 * share 服务代理。只做参数封装与结果整形，鉴权/存储/令牌都在服务端。
 * 无鉴权端点，因此只在内网（wg / 家内 LAN）暴露。
 */
export class ShareClient {
  constructor(private readonly cfg: ShareConfig) {}

  private async api(method: string, path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.cfg.upload}${path}`, {
      method,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    if (!res.ok) {
      throw new Error(`share 服务 HTTP ${res.status}: ${String(json.error ?? text.slice(0, 300))}`);
    }
    return json;
  }

  async list(): Promise<ShareEntry[]> {
    const data = (await this.api('GET', '/api/list')) as ShareListResponse;
    return (data.files ?? []).map((file) => ({
      ...file,
      url: `${this.cfg.public_base.replace(/\/+$/, '')}/${file.token}`,
    }));
  }

  async remove(remotePath: string): Promise<string> {
    const data = await this.api('DELETE', `/${encodeRemote(remotePath)}`);
    return String(data.deleted ?? remotePath);
  }

  async mkdir(dir: string): Promise<string> {
    const data = await this.api('MKCOL', `/${encodeRemote(dir)}`);
    return String(data.path ?? dir);
  }
}
