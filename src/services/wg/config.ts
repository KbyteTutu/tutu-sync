import { z } from 'zod';

/**
 * wg 域走 WGDashboard 的 REST API，而不是本机改 wg0.conf。
 * 因此中心可以跑在任何内网机器（默认 192.168.125.11），不需要 host 网络/NET_ADMIN。
 */
export const WgSchema = z.object({
  dashboard: z.object({
    /** WGDashboard 地址，如 http://192.168.125.1:10086 */
    url: z.string().url(),
    /** WGDashboard 设置页生成的 API Key（请求头 wg-dashboard-apikey） */
    api_key: z.string().min(1),
  }),
  /** WireGuard 配置名（WGDashboard 里的 Name，如 wg0） */
  configuration: z.string().min(1).default('wg0'),
  /** 客户端 Endpoint（客户端配置里的 Endpoint，如 tutu.gold:60399） */
  endpoint: z.string().min(1),
  /** 客户端 resolvectl domain（*.tu 域名解析） */
  dns_domain: z.string().default('~tu'),
});

export type WgConfig = z.infer<typeof WgSchema>;
