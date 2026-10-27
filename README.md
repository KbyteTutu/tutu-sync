# tutu-sync 2.0 — tutu 内网 MCP 中台

一台中心服务器（Docker，跑在 wg 内的 `192.168.125.11`）提供 `tutu-mcp`，把原先散落的几个 skill
收成**一组 MCP 工具**：主机接入、WireGuard 内网、pi 模型与扩展、文件分享、邮件。
所有机器只连一个入口 `http://192.168.125.11/mcp`，不经过公网。

```text
tutu 内网 192.168.125.0/24 (wg)
   pi 主机 / 手机
      │  http://192.168.125.11/mcp        MCP Streamable HTTP（Bearer 令牌）
      │  http://192.168.125.11/init.sh     引导脚本（自带中心地址）
      │  http://192.168.125.11/api/enroll  一次性注册码兑换（单次、15 分钟 TTL）
      ▼
   192.168.125.11  宿主 nginx :80  ──(反代 /mcp /api/enroll /init.sh /assets)──▶  127.0.0.1:60380
                                                                                  docker: tutu-mcp
                                                                                  ├─ /data  SQLite + 规范 models.json
                                                                                  └─ wg 域: 调 WGDashboard API（192.168.125.1:10086）
```

## 快速开始（内网部署，192.168.125.11）

### 1. 部署中心服务

```bash
cp config.example.yaml config.yaml    # 默认已是内网形态，按需改 share / 扩展清单
chmod 600 config.yaml
cp .env.example .env && chmod 600 .env
openssl rand -base64 48               # 写入 TUTU_MASTER_TOKEN
# 再填入 WGDASHBOARD_API_KEY（面板 Settings 最下方生成）

docker compose up -d --build          # 只监听 127.0.0.1:60380
sudo cp deploy/nginx-tutu-mcp.conf /etc/nginx/conf.d/tutu-mcp.conf
sudo nginx -t && sudo systemctl reload nginx

curl -s http://192.168.125.11/healthz
```

唯一入口 `http://192.168.125.11/mcp`，nginx 只放行 `192.168.125.0/24` 与 `192.168.50.0/24`。
wg 节点的新增/删除/轮换全部调 WGDashboard REST API（无需 host 网络 / NET_ADMIN）；
部署形态与安全边界见 [docs/deploy.md](docs/deploy.md)。

### 2. 接入一台新主机

> 内网形态下 `/init.sh` 只能从内网访问，所以新主机**先要有 wg 连通性**。
> 全新机器的顺序是：先在任一已入网设备上调 `tutu_wg_issue`（走 WGDashboard）拿到 wg 配置
> 并拉起 wg0 → 再跑 init.sh 走注册；若中心已启用 wg 域，`tutu_host_enroll` 也可以直接带回 wg 配置。

在**持有 master 令牌**的会话里让 agent 调：

```text
tutu_host_enroll(name="工作笔记本")
```

把返回的两段内容带到新主机：引导命令 + 一次性注册码。

```bash
bash -c "$(curl -fsSL http://192.168.125.11/init.sh)"
# 提示时粘贴注册码；脚本会装工具、装 pi、兑换凭据、落盘配置
```

完成后新主机自带：

| 落盘内容 | 来源 |
| --- | --- |
| `~/.pi/agent/mcp.json` (600) | 中心签发的 host 令牌 + MCP 地址 |
| `~/.pi/agent/models.json` | 中心规范版（仅在本机缺失时写入） |
| `~/.pi/agent/AGENTS.md` | 中心全局约束（仅在本机缺失时写入） |
| `~/.tmux.conf` | 中心维护的配置 |
| `~/.pi/agent/extensions/tutu-share/` | 本机文件上传/下载扩展 |
| `/etc/wireguard/wg0.conf` (600) | 仅当中心启用 wg 域时下发（含 `.tu` 域名解析） |

注册码 15 分钟内有效、只能兑换一次；同名主机重注册会轮换令牌（旧令牌立即失效）。

## 工具

所有工具形如 `tutu_<域>_<动作>`。`master` = 需要管理令牌的写操作；`host` = 任意已注册主机可用。

| 工具 | 权限 | 作用 |
| --- | --- | --- |
| `tutu_host_status` | 全部 | 版本/身份、wg、share、模型规范版、邮件、主机数（排查入口） |
| `tutu_host_enroll` | master | 签发一次性注册码（可预分配 wg IP），返回接入命令 |
| `tutu_host_tokens` | master | 已注册主机清单（只有元数据，无令牌） |
| `tutu_host_revoke` | master | 吊销主机令牌，可选同时删除其 wg peer |
| `tutu_wg_peers` | 全部 | 节点清单 + 实时握手 |
| `tutu_wg_issue` | master | 签发设备（手机/路由）：分配 IP、生成密钥、热应用、返回客户端配置 |
| `tutu_wg_remove` | master | 删除节点（按 IP 或用途名） |
| `tutu_wg_rotate` | master | 换密钥（私钥丢失重建），保留 IP/用途名 |
| `tutu_pi_models` | master | 同步模型规范版（CPA 目录 + 端点），返回 `providers.tu` |
| `tutu_pi_models_get` | 全部 | 读取规范版 `providers.tu`（其他主机用它取同一份配置） |
| `tutu_pi_extensions` | 全部 | 中心扩展清单 + 安装命令 |
| `tutu_share_list` | 全部 | 已分享文件与公网链接 |
| `tutu_share_delete` | master | 删除文件并撤链 |
| `tutu_share_mkdir` | master | 建目录 |
| `tutu_gmail_sync` | master | 立即增量拉取并落库（不分析；定时任务每 30m 自动执行） |
| `tutu_gmail_digest` | master | 按需处理增量未处理邮件：本地规则初筛（≥80% 置信度）→ 只把拿不准的交给 LLM，返回有价值摘要；全为垃圾时明确“无有价值信息” |
| `tutu_gmail_stats` | master | 清单/待处理/垃圾数（本地 vs LLM）/LLM 调用与 token/模型/分类/水位 |
| `tutu_gmail_list` / `get` / `search` | master | 查询本地清单（含未处理、本地过滤来源） |

### 为什么有些动作只返回“产物”由本机执行

中心服务无法写其他主机的磁盘。因此模型配置、wg 客户端配置、扩展安装都是**中心产出 → 本机应用**：
生成与校验（IP 分配、密钥、配置语法、家族版本裁剪）全部在中心用确定性代码完成，
本机只做落盘，不靠模型自由发挥。`init.sh` 是这个流程的自动化版本。

## 权限模型

| 令牌 | 来源 | 能力 |
| --- | --- | --- |
| master | 环境变量 `TUTU_MASTER_TOKEN` | 全部；签发/吊销主机与 wg 节点、同步模型规范版、删分享 |
| host | `tutu_host_enroll` 兑换时签发，只存 sha256 | 只读查询 + 邮件同步 |

- 令牌形如 `tutu_<43 位 base64url>`，比较用摘要查表，不存明文。
- 注册码单次使用、默认 15 分钟 TTL；兑换失败率全局限流。
- 中心默认只监听 `127.0.0.1`，对外只能经 TLS 反代；内网部署可改成 wg 地址。
- 需要哪台机器执行特权操作，就把它的 `~/.pi/agent/mcp.json` 里的 `Authorization` 换成
  `Bearer $TUTU_MASTER_TOKEN`（默认注册下发的是 host 令牌）。master 令牌建议只放在你自己常用/可信的机器上。

## 从 1.0 迁移

1.0 的三个 skill 与独立 gmail 服务已删除，对应关系：

| 1.0 | 2.0 |
| --- | --- |
| `skills/tutu-wg-init`（服务器/客户端） | `tutu_wg_*` + `init.sh` 的 wg 段 |
| `skills/tutu-pi-update` | `tutu_pi_models`（同一份 `sync.py` 执行器，改由中心运行） |
| `skills/tutu-pi-ext` | `tutu_pi_extensions` + `init.sh` 的扩展段 |
| `tutu-mcp` gmail 服务（stdio） | 同一进程内的 `tutu_gmail_*` 工具（HTTP） |
| `extensions/tutu-share` | 保留：本机文件读写必须在本机执行 |

旧机器上的 `~/.pi/agent/mcp.json` 需要重新接入一次（host 令牌是新机制）。

## 仓库结构

```text
src/
  main.ts              HTTP 入口：/mcp、/api/enroll、/init.sh、/assets、/healthz
  server.ts            McpServer 组装与工具注册
  config.ts            全量配置 schema
  context.ts           运行期上下文（db/auth/wg/share/gmail）
  lib/                 配置加载($ENV 插值)/日志/时长/SQLite/令牌/互斥锁
  services/
    wg/                peers.ts 纯文本与 IP 分配 + manager.ts 文件/命令
    pi/                models.ts（调用 sync.py）+ sync.py 确定性执行器 + extensions.ts
    share/             share 服务代理
    gmail/             IMAP + LLM 分析 + 增量同步 + SQLite
  tests/               node:test（wg 文本操作、令牌与注册码）
assets/
  init.sh              新主机引导脚本（由中心按 public_url 下发）
  tmux.conf
extensions/tutu-share/ 本机文件上传/下载（pi 扩展，由 init.sh 安装）
docker-compose.yml / Dockerfile
```

## 开发

```bash
npm install
npm run build          # tsc + 复制 sync.py
npm test               # node:test（dist/tests）
npm run test:py        # sync.py 的 unittest
TUTU_MASTER_TOKEN=$(openssl rand -base64 48) node dist/main.js --config ./config.yaml
```

新增域：在 `src/services/<域>/` 放实现与 schema，`src/tools/<域>.ts` 注册工具，
`src/config.ts` 挂配置段，`src/server.ts` 注册。写操作记得 `masterOnly(caller, ...)`。
