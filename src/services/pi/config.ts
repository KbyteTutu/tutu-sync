import { z } from 'zod';

/** pi 相关能力：模型目录（CPA）同步 + 扩展清单 */
export const PiSchema = z.object({
  /**
   * 容器内作为 HOME 的目录。sync.py 在该目录下维护 .pi/agent/models.json
   * 作为全内网唯一的「规范版本」；各主机取走后写入自己的 ~/.pi/agent/。
   */
  home: z.string().min(1).default('/data/pi-home'),
  /** 新主机应安装的 pi 扩展（packages 源，如 npm:pi-lens） */
  extensions: z.array(z.string().min(1)).default([]),
});

export type PiConfig = z.infer<typeof PiSchema>;
