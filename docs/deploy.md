# 部署与安全边界

## 1. 拓扑与前提

```text
公网 ──HTTPS──▶ 反代 (Tengine/nginx, 443) ──▶ 127.0.0.1:60380 ──▶ tutu-mcp 容器
                                                                  ├── host 网络（看到 / 管理 wg0）
                                                                  ├── /etc/wireguard（读写挂载）
                                                                  └── /data（SQLite + 规范 models.json）
```

- 中心服务就是 WireGuard 服务器（`192.168.125.1`），否则 `wg` 域不可用（其余域正常）。
- 新主机在建立 wg 隧道**之前**就要访问 `/init.sh` 与 `/api/enroll`，因此入口必须是公网可达的 HTTPS。
- 不想暴露公网时：`server.host` 改成 `192.168.125.1`，只在 wg 内网使用；新主机改为手工粘贴
  `tutu_host_enroll` 返回的注册码与 wg 配置。两种模式功能一致。

## 2. 反向代理

以 nginx 为例（Tengine 同理）：

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.tutu.gold;

    client_max_body_size 4m;

    # MCP：SSE 流式响应，必须关闭缓冲并放大超时
    location = /mcp {
        proxy_pass http://127.0.0.1:60380;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 一次性注册码兑换：只允许 POST，别透传其他方法
    location = /api/enroll {
        limit_except POST { deny all; }
        proxy_pass http://127.0.0.1:60380;
    }

    # 引导资源（非敏感：脚本 / tmux 配置 / 全局约束 / 分享扩展）
    location = /init.sh {
        proxy_pass http://127.0.0.1:60380;
    }
    location /assets/ {
        proxy_pass http://127.0.0.1:60380;
    }

    # 健康检查只给本机
    location = /healthz {
        allow 127.0.0.1;
        deny all;
        proxy_pass http://127.0.0.1:60380;
    }

    location / { return 404; }
}
```

WAF（雷池）注意：`/mcp` 的请求体是 JSON-RPC，响应可能是 `text/event-stream`。
如果开了「响应缓冲 / 大包拦截 / 非 HTML 拒绝」，需要给该站点放行；否则表现为工具调用超时。

## 3. 容器权限（为什么需要这些）

| 配置 | 原因 | 去掉的后果 |
| --- | --- | --- |
| `network_mode: host` | 容器必须看到宿主上的 `wg0` 才能 `wg show` / `wg syncconf` | wg 域报告 `wg show 失败` |
| `cap_add: NET_ADMIN` | `wg syncconf` 需要 netlink 权限 | 同上 |
| `/etc/wireguard` 读写挂载 | 改 `wg0.conf`（改前自动 `.bak-时间戳`） | wg 域报告「不可读写」 |
| `/data` | SQLite（主机令牌摘要 / 注册码 / 邮件缓存）+ 规范 models.json | 重启丢状态 |

`wg` 写入采用「备份 → 同目录临时文件 → fsync → rename → 目录 fsync」，
运行态用 `wg syncconf` 热应用（不重启接口、不断既有 peer），写后回读 `wg show` 校验。
镜像内以 root 运行：这是操作 netlink 的直接结果，容器内无其他业务，风险面由上面四项收敛。

## 4. 令牌生命周期

| 凭据 | 存放 | 轮换 |
| --- | --- | --- |
| master | `.env` 的 `TUTU_MASTER_TOKEN` | 改 `.env` → `docker compose up -d` → 各管理机 `~/.pi/agent/mcp.json` 换 token |
| host | 各主机 `~/.pi/agent/mcp.json`（600） | 中心调 `tutu_host_revoke(name)`；或重新 `tutu_host_enroll(name)`（同名轮换） |
| 一次性注册码 | 不落盘，仅中心数据库存 sha256 | 15 分钟 TTL、单次使用；过期重新签发 |

- 令牌形如 `tutu_<43 位 base64url>`，服务端只存 sha256，比较走摘要查表。
- `master` 能力：签发/吊销主机、签发/删除/轮换 wg 节点、同步模型规范版、删分享/建目录。
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
# wg 配置（中心端）
sudo cp /etc/wireguard/wg0.conf /path/to/backup/
```

丢失 `/data` 的后果：所有 host 令牌与注册码失效（各主机需重新 `tutu_host_enroll`），
邮件缓存丢失（可重新拉取），模型规范版可重新 `tutu_pi_models` 生成。
wg 配置独立于容器，不受影响。

## 7. 故障排查

| 现象 | 先看 |
| --- | --- |
| 新主机 `init.sh` 兑换 401 | 注册码是否已用过/超时（15 分钟）；`tutu_host_enroll` 重新签发 |
| `tutu_wg_*` 报不可用 | `tutu_host_status`：未配置 wg 段 / 配置文件不可读写 / Address 不是服务器地址 / wg show 失败 |
| `tutu_pi_models` 报 error | CPA 端点（`192.168.125.11:8317`）是否可达；报告里的 `message` 与 `warnings` |
| 模型列表能加载但请求失败 | 模型参数与上游能力不符；用 `full=true` 重跑并核对 CPA 目录 |
| 工具调用超时 | 反代 `proxy_buffering off`、超时 ≥ 300s；WAF 是否拦截 SSE |
| 容器起不来 | `docker compose logs tutu-mcp`；缺 `TUTU_MASTER_TOKEN` 会直接报错退出 |
