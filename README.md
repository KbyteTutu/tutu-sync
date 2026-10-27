# tutu-sync 2.0 — 中心式个人 MCP 服务组

一台中心服务器（Docker）跑 `tutu-mcp`，把原先散落的几个 skill 收成**一组 MCP 工具**：
主机接入、WireGuard 内网、pi 模型与扩展、文件分享、邮件。任何一台新机器只需要装好 pi，
用一次注册码接入，之后所有配置都通过中心服务下发与统一调用。

```text
                         ┌──────────────────────── 中心服务器 (tutu.gold) ───────────────────────┐
                         │  docker: tutu-mcp (network_mode: host + NET_ADMIN)                    │
  新主机 / 手机          │    POST /mcp        MCP Streamable HTTP（Bearer 令牌）                │
      │  init.sh         │    POST /api/enroll 一次性注册码兑换（单次、15 分钟 TTL）              │
      ├─────── HTTPS ───▶│    GET  /init.sh    引导脚本（自带中心地址）                           │
      │  一次注册码       │    GET  /assets/*   tmux.conf / AGENTS.md / tutu-share.ts             │
      │                  │    /etc/wireguard   挂载，wg syncconf 热应用                          │
      │                  │    /data             SQLite（主机令牌摘要、注册码、邮件缓存）          │
      │                  │                     规范 models.json（CPA 同步结果）                  │
      └──── wg0 隧道 ───▶│  WireGuard 192.168.125.0/24（中心 = .1）                              │
                         └───────────────────────────────────────────────────────────────────────┘
```

## 快速开始

### 1. 部署中心服务

```bash
cp config.example.yaml config.yaml    # 改 public_url / wg / share / gmail
cp .env.example .env && chmod 600 .env
openssl rand -base64 48               # 写入 TUTU_MASTER_TOKEN
docker compose up -d --build
curl -s http://127.0.0.1:60380/healthz
```

对外入口由宿主机 TLS 反代提供（如 `https://mcp.tutu.gold` → `127.0.0.1:60380`），
配置与安全边界见 [docs/deploy.md](docs/deploy.md)。

### 2. 接入一台新主机

在**持有 master 令牌**的会话里（中心或任意管理机）让 agent 调：

```text
tutu_host_enroll(name="工作笔记本")
```

把返回的两段内容带到新主机：引导命令 + 一次性注册码。

```bash
bash -c "$(curl -fsSL https://mcp.tutu.gold/init.sh)"
# 提示时粘贴注册码；脚本会装工具、装 pi、兑换凭据、落盘配置、拉起 wg0
```

完成后新主机自带：

| 落盘内容 | 来源 |
| --- | --- |
| `~/.pi/agent/mcp.json` (600) | 中心签发的 host 令牌 + MCP 地址 |
| `~/.pi/agent/models.json` | 中心规范版（仅在本机缺失时写入） |
| `~/.pi/agent/AGENTS.md` | 中心全局约束（仅在本机缺失时写入） |
| `~/.tmux.conf` | 中心维护的配置 |
| `~/.pi/agent/extensions/tutu-share/` | 本机文件上传/下载扩展 |
| `/etc/wireguard/wg0.conf` (600) | 中心签发的客户端配置（含 `.tu` 域名解析） |

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
| `tutu_gmail_sync` | master | 立即拉取并分析新邮件（服务本身定时执行） |
| `tutu_gmail_list` / `get` / `search` | master | 查询已分析邮件（正文属敏感数据） |

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
