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
                                                            └─ wg 域: 默认关闭
```

- **入口**：`http://192.168.125.11/mcp`。容器只绑宿主回环，nginx 做路径反代，
  端口不暴露到 LAN/公网；nginx 层用 `allow 192.168.125.0/24; allow 192.168.50.0/24; deny all;` 兜底。
  配置在 [deploy/nginx-tutu-mcp.conf](../deploy/nginx-tutu-mcp.conf)。
- **默认不启用 wg 域**：`192.168.125.11` 是 wg 客户端，不是服务器。`config.example.yaml`
  里的 `wg:` 整段默认注释；`tutu_host_enroll` 会自动按“wg 域是否可用”决定是否签发 wg 配置。
- **新主机的顺序**：内网入口只能在 wg 建立后访问，所以全新机器要先拿到 wg 配置并拉起
  `wg0`（`tutu_wg_issue` 需在 wg 服务器那台实例上调用，或手工加 peer），再跑 `init.sh` 走注册。

### 变体：中心跑在 wg 服务器（192.168.125.1，需要 wg 域）

在 `config.yaml` 打开 `wg:` 段，并把 compose 改成：

```yaml
    network_mode: host        # 删掉 ports 段（二者互斥）
    cap_add: [NET_ADMIN]
    volumes:
      - /etc/wireguard:/etc/wireguard
      - ./data:/data
      - ./config.yaml:/app/config/config.yaml:ro
```

此时 `server.host` 可改为 `192.168.125.1`（或保留 127.0.0.1 + nginx），
新主机可以直接从 `http://192.168.125.1/...` 引导并在兑换时拿到 wg 配置。
如果还需要公网可达（新机器在无 wg 时也能引导），把 nginx 换成带 TLS 的公网 vhost，
注意 WAF 放行 SSE（见第 3 节）。

## 2. 容器权限

| 配置 | 内网形态（默认） | wg 服务器变体 |
| --- | --- | --- |
| `ports: 127.0.0.1:60380:60380` | 需要（只给 nginx 用） | 删除，改 `network_mode: host` |
| `network_mode: host` | 不需要 | 需要（看到宿主 `wg0`） |
| `cap_add: NET_ADMIN` | 不需要 | 需要（`wg syncconf`） |
| `/etc/wireguard` 挂载 | 不需要 | 需要（读写 `wg0.conf`） |
| `/data` | 需要 | 需要 |

内网形态故意不给 NET_ADMIN：容器被攻破也拿不到宿主网络配置权限。
wg 变体的写入采用「校验 → 备份 → 临时文件 fsync → rename → 目录 fsync」，
运行态用 `wg syncconf` 热应用（不重启接口、不断既有 peer），写后回读 `wg show` 校验。

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
# wg 变体才有：wg 配置
sudo cp /etc/wireguard/wg0.conf /path/to/backup/
```

丢失 `/data` 的后果：所有 host 令牌与注册码失效（各主机需重新 `tutu_host_enroll`），
邮件缓存丢失（可重新拉取），模型规范版可重新 `tutu_pi_models` 生成。
wg 配置独立于容器，不受影响。

## 7. 故障排查

| 现象 | 先看 |
| --- | --- |
| `http://192.168.125.11/mcp` 404 | nginx vhost 未装/未 reload；或 Host 不是 `192.168.125.11`（`curl -v` 看 Host 头） |
| 403 | 来源 IP 不在 `192.168.125.0/24` / `192.168.50.0/24` 白名单 |
| 新主机 `init.sh` 兑换 401 | 注册码是否已用过/超时（15 分钟）；`tutu_host_enroll` 重新签发 |
| 新主机连不上 `/init.sh` | 内网形态要求先有 wg 连通性；先签发 wg 配置并拉起 `wg0` |
| `tutu_wg_*` 报不可用 | 默认内网形态未启用 wg 域（正常）；要管 wg 需部署到 wg 服务器变体 |
| `tutu_pi_models` 报 error | CPA 端点（`192.168.125.11:8317`）是否可达；报告里的 `message` 与 `warnings` |
| 工具调用超时 | 反代 `proxy_buffering off`、超时 ≥ 300s；WAF 是否拦截 SSE |
| 容器起不来 | `docker compose logs tutu-mcp`；缺 `TUTU_MASTER_TOKEN` 会直接报错退出 |
| 端口被占用 | 本机 80 已由 nginx 占用，tutu-mcp 只监听 127.0.0.1:60380 |
