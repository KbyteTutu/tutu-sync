# 部署与安全边界

## 1. 拓扑（内网形态，默认）

```text
wg 内网 192.168.125.0/24
  pi 主机 / 手机 ──http://192.168.125.11/{mcp,init.sh,api/enroll}──▶ 宿主 nginx :80
                                                                     │（只放行 125.0/24 + 50.0/24）
                                                                     ▼
                                                            127.0.0.1:60380
                                                                     │
                                                          docker: tutu-mcp（bridge）
                                                            ├─ /data  SQLite + 规范 models.json
                                                            └─ wg 域 ──HTTP──▶ WGDashboard 192.168.125.1:10086
```

- **入口**：`http://192.168.125.11/mcp`。容器只绑宿主回环，nginx 做路径反代，
  端口不暴露到 LAN/公网；nginx 层用 `allow 192.168.125.0/24; allow 192.168.50.0/24; deny all;` 兜底。
  配置在 [deploy/nginx-tutu-mcp.conf](../deploy/nginx-tutu-mcp.conf)。
- **wg 域走 WGDashboard REST API**：节点的新增/删除/密钥生成/IP 分配/配置落盘/热应用
  全部由面板完成，本服务只发 HTTP 请求（请求头 `wg-dashboard-apikey`）。
  因此中心不需要 host 网络、NET_ADMIN、也不挂载 `/etc/wireguard`。
- **新主机的顺序**：内网入口只能在 wg 建立后访问，所以全新机器先在任一已入网设备上
  `tutu_wg_issue` 拿到 wg 配置并拉起 `wg0`，再跑 `init.sh` 走注册；
  若 wg 域可用，`tutu_host_enroll` 也会在兑换时带回 wg 配置。

### WGDashboard 接入要点

```yaml
wg:
  dashboard:
    url: http://192.168.125.1:10086
    api_key: ${WGDASHBOARD_API_KEY}
  configuration: wg0
  endpoint: tutu.gold:60399
  dns_domain: "~tu"
```

- API Key 在面板 **Settings 最下方**启用并创建；只放在 `.env`（600）。
- 面板 API 会返回节点私钥（用于导出客户端配置），本服务只在 `tutu_wg_issue` /
  `tutu_wg_rotate` 的返回中展示目标节点的私钥，列表工具不返回私钥。
- 请求走 wg 隧道（`192.168.125.1`），不经过公网；若面板本身对公网明文暴露，
  那是面板侧的风险，建议只监听 wg 地址或加 TLS 反代。
- 面板不可达时 `wg_*` 工具报 `WireGuard 不可用: …`，其余域不受影响。

## 2. 容器权限

| 配置 | 需要 | 原因 |
| --- | --- | --- |
| `ports: 127.0.0.1:60380:60380` | 是 | 只给宿主 nginx 用 |
| `network_mode: host` | 否 | wg 由面板管理，容器不需要看宿主接口 |
| `cap_add: NET_ADMIN` | 否 | 同上；故意不给，降低被攻破后的影响面 |
| `/etc/wireguard` 挂载 | 否 | 同上 |
| `/data` | 是 | SQLite（令牌摘要/注册码/邮件缓存）+ 规范 models.json |

镜像内以 root 运行仅因为 `/data` 需要 0700 归属；网络侧没有任何特权。

## 3. nginx 关键点

- `/mcp` 是 SSE 流式响应：必须 `proxy_buffering off`、超时 ≥ 300s（模板用 3600s）。
- `/api/enroll` 只允许 POST；响应含一次性令牌，`cache-control: no-store` 由服务端发送。
- `/healthz` 不鉴权但只返回版本与 uptime；对外暴露也无敏感信息。
- 本机 `sites-enabled/default` 已有 `listen 80 default_server`，新 vhost 用
  `server_name 192.168.125.11` 精确匹配，不修改现有站点。
- 如果走公网 TLS 反代，另加 WAF 放行规则：`text/event-stream` 不能被缓冲/拦截，
  否则表现为工具调用超时。

## 4. 令牌生命周期

| 凭据 | 存放 | 轮换 |
| --- | --- | --- |
| master | `.env` 的 `TUTU_MASTER_TOKEN` | 改 `.env` → `docker compose up -d` → 各管理机 `~/.pi/agent/mcp.json` 换 token |
| host | 各主机 `~/.pi/agent/mcp.json`（600） | 中心调 `tutu_host_revoke(name)`；或重新 `tutu_host_enroll(name)`（同名轮换） |
| 一次性注册码 | 不落盘，仅中心数据库存 sha256 | 15 分钟 TTL、单次使用；过期重新签发 |

- 令牌形如 `tutu_<43 位 base64url>`，服务端只存 sha256，比较走摘要查表。
- `master` 能力：签发/吊销主机、签发/删除/轮换 wg 节点、同步模型规范版、删分享/建目录、邮件域。
- `host` 能力：状态、节点清单、模型规范版内容、扩展清单。
- 被吊销的 host 在下一次请求即被拒绝（无会话缓存）。
- 需要哪台机器执行 master 操作，就把它的 `mcp.json` 里 `Authorization` 换成 master 令牌；
  默认注册下发的是 host 令牌（最小权限）。

## 5. 升级

```bash
git pull
docker compose up -d --build
docker compose logs -f --tail=50
```

数据库表结构在启动时 `CREATE TABLE IF NOT EXISTS`，无迁移脚本（2.0 起不再保留旧格式）。

## 6. 备份

```bash
# 状态（令牌摘要 + 注册码 + 邮件缓存 + 规范模型）
docker compose exec tutu-mcp tar czf - /data > tutu-mcp-data.tgz
```

丢失 `/data` 的后果：所有 host 令牌与注册码失效（各主机需重新 `tutu_host_enroll`），
邮件缓存丢失（可重新拉取），模型规范版可重新 `tutu_pi_models` 生成。
wg 节点由 WGDashboard 持有，不在 `/data` 里，不受影响。

## 7. 故障排查

| 现象 | 先看 |
| --- | --- |
| `http://192.168.125.11/mcp` 404 | nginx vhost 未装/未 reload；或 Host 不是 `192.168.125.11`（`curl -v` 看 Host 头） |
| 403 | 来源 IP 不在 `192.168.125.0/24` / `192.168.50.0/24` 白名单 |
| 新主机 `init.sh` 兑换 401 | 注册码是否已用过/超时（15 分钟）；`tutu_host_enroll` 重新签发 |
| 新主机连不上 `/init.sh` | 内网形态要求先有 wg 连通性；先签发 wg 配置并拉起 `wg0` |
| `tutu_wg_*` 报不可用 | `tutu_host_status` 的原因：`WGDASHBOARD_API_KEY` 未设 / 面板不可达 / 配置名不对 / API Key 失效 |
| `tutu_wg_issue` 报 IP 已被占用 | 面板里已有同 IP 节点；换 IP 或先删除旧节点 |
| `tutu_wg_rotate` 失败后节点消失 | 面板不支持改私钥，轮换是删除+重建；重建失败时用 `tutu_wg_issue` 重新签发 |
| `tutu_pi_models` 报 error | CPA 端点（`192.168.125.11:8317`）是否可达；报告里的 `message` 与 `warnings` |
| 工具调用超时 | 反代 `proxy_buffering off`、超时 ≥ 300s；WAF 是否拦截 SSE |
| 容器起不来 | `docker compose logs tutu-mcp`；缺 `TUTU_MASTER_TOKEN` 会直接报错退出 |
| 端口被占用 | 本机 80 已由 nginx 占用，tutu-mcp 只监听 127.0.0.1:60380 |
