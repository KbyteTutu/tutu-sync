import { z } from 'zod';
import { RootBaseSchema } from './lib/config.js';
import { GmailSchema } from './services/gmail/schema.js';
import { PiSchema } from './services/pi/config.js';
import { ShareSchema } from './services/share/config.js';
import { WgSchema } from './services/wg/config.js';

export const ConfigSchema = RootBaseSchema.extend({
  /** 本机是否作为 wg 服务器管理 peer；缺省则该域工具报告不可用 */
  wg: WgSchema.optional(),
  /** 模型规范版与扩展清单（必填：pi 域工具依赖） */
  pi: PiSchema,
  /** 分享服务代理；缺省则不注册 share 工具 */
  share: ShareSchema.optional(),
  /** 邮件服务；缺省则不注册 gmail 工具 */
  gmail: GmailSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
