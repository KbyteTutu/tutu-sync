import { z } from 'zod';

/** tutu-share 基础服务端点（中心服务只做代理，不管理其存储） */
export const ShareSchema = z.object({
  /** 上传/管理端点（PUT/MKCOL/DELETE/GET /api/list） */
  upload: z.string().url(),
  /** 对外下载链接前缀 */
  public_base: z.string().url(),
});

export type ShareConfig = z.infer<typeof ShareSchema>;
