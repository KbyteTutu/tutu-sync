---
name: tutu-wg-init
description: "Set up or verify WireGuard wg0 for the tutu intranet (192.168.125.0/24): status check, keypair generation, wg0.conf creation, server-side public key registration, connectivity test, autostart. Trigger: 'tutu-wg-init', 'init wireguard', 'wg 配置', 'wireguard 初始化'."
---

# Tutu WG Init

检查并初始化 WireGuard (`wg0`)，接入 tutu 内网 `192.168.125.0/24`。

**核心原则: 已正常则零改动。**

- 一切正常 (配置存在 + 接口运行 + 内网可达) → 直接报告正常，不做任何修改
- 已有配置 → 复用，**绝不重新生成密钥**（否则服务器端注册的公钥立即失效）
- 全新配置 → 生成密钥对 → 询问固定 IP → 写 `/etc/wireguard/wg0.conf` → 展示公钥并等待服务器端注册 → 测试连通性 → 设置开机自启

## 固定参数 (来自需求，勿改)

| 参数 | 值 |
| ------ | ----- |
| 内网网段 | `192.168.125.0/24` |
| 内网服务器 / DNS | `192.168.125.1` |
| tutu 模型端点 (连通性探测) | `http://192.168.125.1:8317/v1/models` |
| 服务器公钥 | `Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=` |
| 服务器端点 | `tutu.gold:60399` |
| AllowedIPs | `192.168.125.0/24` |
| PersistentKeepalive | `25` |
| 接口名 | `wg0` |

## Phase 0: Preconditions

检查必要条件，任一不满足即停止并提示:

- **权限**: 需要 root 或 sudo（写 `/etc/wireguard/`、`systemctl`、`wg show` 都需要）
- **wireguard-tools**: `command -v wg` 存在；缺失则安装
  - Debian 系: `sudo apt-get install -y wireguard-tools`
  - RHEL 系: `sudo dnf install -y wireguard-tools`
  - 安装失败 → 停止
- **resolvectl**: `command -v resolvectl`（决定是否写入 DNS 相关 PostUp/PreDown 行）

## Phase 1: 检查当前状态

```bash
# 1. 配置存在?
sudo test -f /etc/wireguard/wg0.conf && echo CONFIG_OK || echo NO_CONFIG

# 2. 接口运行? (无接口则输出 WG_DOWN)
sudo wg show wg0 >/dev/null 2>&1 && echo WG_UP || echo WG_DOWN

# 3. 握手时间 (unix 秒, 0 表示从未握手)
sudo wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2}'

# 4. 内网可达性 (期待 200)
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer tutu' \
  http://192.168.125.1:8317/v1/models

# 5. 配置指向正确的服务器?
sudo grep -q 'Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=' /etc/wireguard/wg0.conf \
  && echo PEER_OK || echo PEER_MISMATCH
```

判定分支:

| 状态 | 结论 | 动作 |
| ------ | ------ | ------ |
| CONFIG_OK + WG_UP + 握手在最近 3 分钟内 + curl 200 + PEER_OK | 一切正常 | **不做任何改动**，输出报告，结束 |
| CONFIG_OK + WG_UP + 握手过期或 curl 非 200 | 隧道异常 | `sudo systemctl restart wg-quick@wg0`（或 `sudo wg-quick down wg0 && sudo wg-quick up wg0`）后重测；仍失败 → 报告错误停止，不重建配置 |
| CONFIG_OK + WG_DOWN | 已配置未运行 | 复用配置，从 **Phase 4** 继续（跳过 Phase 2/3） |
| NO_CONFIG | 未配置 | 从 **Phase 2** 全新配置 |

## Phase 2: 生成密钥对

**私钥只在首次生成**，持久化保存以便重跑复用:

```bash
# 已有私钥则复用 (绝不重新生成!)
if [[ ! -s /etc/wireguard/privatekey ]]; then
  sudo sh -c 'umask 077; wg genkey > /etc/wireguard/privatekey'
fi
sudo chmod 600 /etc/wireguard/privatekey

# 计算公钥 (私钥本身不得显示/输出)
PUBLIC_KEY="$(sudo sh -c 'wg pubkey < /etc/wireguard/privatekey')"
```

验收:

- `/etc/wireguard/privatekey` 存在，权限 600
- `PUBLIC_KEY` 是合法的 WireGuard 公钥（44 字符 base64）
- 全程不得回显私钥内容

## Phase 3: 询问 IP 并写入 wg0.conf

### 3.1 向用户索要固定 IP

- 要求用户在 `192.168.125.0/24` 网段内指定一个**固定 IP**（例如 `192.168.125.9`）
- 校验格式:

```bash
[[ "$IP" =~ ^192\.168\.125\.(25[0-4]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]?)$ ]] \
  && echo VALID || echo INVALID
```

- 非法（不在网段、`.0`、`.255`、格式错误）→ 重新询问，不写配置

### 3.2 写入 /etc/wireguard/wg0.conf

权限 600，内容严格按参考配置（私钥取 Phase 2 生成的值）:

```bash
PRIVKEY="$(sudo cat /etc/wireguard/privatekey)"
sudo tee /etc/wireguard/wg0.conf >/dev/null <<EOF
[Interface]
# 子节点私钥
PrivateKey = $PRIVKEY
# 子节点在 VPN 中的地址（192.168.125.0/24 网段）
Address = $IP/24
PostUp = resolvectl dns wg0 192.168.125.1; resolvectl domain wg0 '~tu'
PreDown = resolvectl domain wg0 ''; resolvectl dns wg0 ''

[Peer]
# 服务器端公钥
PublicKey = Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=
# 接受 192.168.125.0/24 网段的所有流量
AllowedIPs = 192.168.125.0/24
# 服务器端点
Endpoint = tutu.gold:60399
# 保持连接活跃
PersistentKeepalive = 25
EOF
sudo chmod 600 /etc/wireguard/wg0.conf
```

- `resolvectl` 不存在（或 systemd-resolved 未运行）→ **省略** PostUp/PreDown 两行，并提示用户 DNS 需另行配置（不阻塞 WireGuard 本身）
- 校验: 文件存在、权限 600、含服务器公钥 `Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=`

### 3.3 展示公钥，等待服务器端注册

**必须**将公钥醒目地展示给用户:

```text
请将以下公钥添加到 tutu 主服务器 (192.168.125.1) 上该 IP (192.168.125.x) 对应的 peer 配置:

  <PUBLIC_KEY>
```

然后**停下来等待用户确认**——询问用户是否已在服务器端配置完成。用户明确确认之前，不得继续 Phase 4。

## Phase 4: 启动并测试连通性

```bash
# 启动 (复用已有配置时同样适用)
sudo systemctl start wg-quick@wg0 2>/dev/null || sudo wg-quick up wg0
sleep 3

# 握手检查: 期待 peer 的 latest-handshake 为非 0 且是最近时间
sudo wg show wg0
sudo wg show wg0 latest-handshakes

# 内网可达性: 期待 200
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer tutu' \
  http://192.168.125.1:8317/v1/models
```

验收（全部满足才算通过）:

- 接口 `wg0` 状态 `up`，Address 为配置的 IP
- peer 出现握手，时间在最近 3 分钟内
- curl 返回 `200`

失败 → **停止**，不启用自启，报告以下排查方向:

- 服务器端是否已添加该公钥 + IP（最常见原因）
- 端点可达性: `curl -sS --max-time 5 http://tutu.gold:60399` 或 `getent hosts tutu.gold`
- 服务器防火墙 / UDP 端口 60399

## Phase 5: 设置开机自启

仅在 Phase 4 连通性验证通过后执行:

```bash
sudo systemctl enable wg-quick@wg0
sudo systemctl is-enabled wg-quick@wg0   # 期待 enabled
```

非 systemd 系统 → 提示用户手动加入开机执行 `wg-quick up wg0`，不阻塞收尾。

## Phase 6: Verify + Report

全量复核:

```bash
sudo wg show wg0                # up / Address / peer / 握手
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer tutu' http://192.168.125.1:8317/v1/models   # 200
sudo systemctl is-enabled wg-quick@wg0    # enabled
```

输出摘要:

```text
✓ tutu-wg-init 完成

模式: 全新配置 / 复用配置 / 已正常(零改动)
接口: wg0
本机 VPN IP: 192.168.125.x/24
公钥: <PUBLIC_KEY>   (已注册到主服务器)
服务器端点: tutu.gold:60399
握手: <最新握手时间>
内网探测: 192.168.125.1:8317 → 200
开机自启: enabled
配置: /etc/wireguard/wg0.conf (600)  私钥: /etc/wireguard/privatekey (600)
```

## Error Handling

- 无 root/sudo → 停止，提示以 root 执行或使用 sudo
- `wg` 缺失 → 安装 wireguard-tools（apt/dnf），失败停止
- 用户 IP 非法 → 重新询问，不写配置
- `resolvectl` 缺失/systemd-resolved 未运行 → 省略 DNS 行，提示用户
- `tutu.gold` 无法解析或 UDP 端口不通 → 停止，提示检查 DNS/防火墙
- 用户未确认服务器端注册 → 不得继续测试
- 已正常状态 → 零改动（不重启、不 rewrite 配置、不重新生成密钥）

## Implementation Notes

核心工具:

- `bash` + `wg` / `wg-quick`: 状态检查、密钥生成、接口管理
- `sudo tee`: 写 `/etc/wireguard/wg0.conf` 与 `privatekey`
- `systemctl`: 启动与自启
- `curl`: 内网可达性探测（复用 tutu 模型端点 + 内置 key `tutu`）

禁止:

- ❌ 使用任何示例/外部给定的私钥值（必须用 `wg genkey` 自生成，不得复制粘贴）
- ❌ 重复生成密钥 / 覆盖已有 `privatekey`（服务器端公钥注册会失效）
- ❌ 回显或记录私钥内容
- ❌ 在用户确认服务器端注册前继续
- ❌ 已正常时做任何修改（含重启接口）
- ❌ 修改固定参数（服务器公钥 / Endpoint / AllowedIPs / Keepalive）

推荐:

- ✅ 私钥持久化到 `/etc/wireguard/privatekey`（600），重跑复用
- ✅ 连通性验证通过后才启用自启
- ✅ 交互节点（要 IP、等服务器确认）必须显式等待用户回复
