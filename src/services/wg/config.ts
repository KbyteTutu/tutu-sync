import { z } from 'zod';

/** WireGuard 中心端（wg 服务器本机）配置 */
export const WgSchema = z.object({
  /** wg0.conf 绝对路径（compose 挂载 /etc/wireguard） */
  config: z.string().min(1).default('/etc/wireguard/wg0.conf'),
  /** 接口名 */
  interface: z
    .string()
    .regex(/^[a-z0-9_]{1,15}$/, '接口名只能是小写字母/数字/下划线')
    .default('wg0'),
  /** 内网网段 */
  subnet: z.string().min(1).default('192.168.125.0/24'),
  /** wg 服务器自身的内网 IP */
  server_ip: z.string().min(1).default('192.168.125.1'),
  /** 服务器公钥（客户端配置里的 Peer.PublicKey） */
  server_public_key: z.string().min(1),
  /** 客户端 Endpoint，如 tutu.gold:60399 */
  endpoint: z.string().min(1),
  /** 客户端 DNS；null 表示不写 resolvectl hook（目标无 systemd-resolved 时） */
  dns: z.string().nullable().default('192.168.125.1'),
  /** 客户端 DNS 搜索域（resolvectl domain，配合 *.tu 域名） */
  dns_domain: z.string().default('~tu'),
});

export type WgConfig = z.infer<typeof WgSchema>;
