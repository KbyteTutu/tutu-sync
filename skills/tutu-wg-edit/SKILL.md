---
name: tutu-wg-edit
description: "Manage WireGuard peers on the tutu main server (192.168.125.1): verify this host is the server, list current peers, then add a new node (IP + purpose, following '# nickname:' comment convention, return copy-paste client config), or edit/remove an existing node when the user asks (change nickname/IP, replace lost private key, delete). Restart wg after changes. Trigger: 'tutu-wg-edit', 'wg edit peer', '编辑节点', '修改节点', '添加节点', '新增节点', '删除节点', 'wg 加节点'."
---

# Tutu WG Edit

在 **tutu 主服务器**（`192.168.125.1`）上管理 WireGuard 对等节点：确认本机是服务器 → 罗列现有 peer 清单 → 按用户要求 **新增** 或 **修改/删除** 节点 → 备份后写入 → 重启 wg 服务 → 输出结果（新增时返回可直接复制的客户端配置片段）。

**核心原则: 默认只新增；只有用户明确要求才动旧配置。**

- 本机不是主服务器 → 立即停止，不做任何修改
- 未获用户要求 → 绝不修改/删除已有 peer
- 客户端私钥由服务器本次生成，**只输出一次**，不落盘
- 任何写入前先备份 `wg0.conf`（沿用服务器既有 `.bak` 习惯）

## 固定参数 (来自需求，勿改)

| 参数 | 值 |
| ------ | ----- |
| 内网网段 | `192.168.125.0/24` |
| 服务器 VPN IP | `192.168.125.1` |
| 服务器公钥 | `Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=` |
| 服务器 ListenPort | `60399` |
| 接口名 / 服务 | `wg0` / `wg-quick@wg0` |
| 配置文件 | `/etc/wireguard/wg0.conf` |
| 既有 peer 注释习惯 | `# nickname: <用途>`（所有变更必须沿用） |
| 客户端 AllowedIPs | `192.168.125.0/24` |
| PersistentKeepalive | `25` |

## Phase 0: Preconditions

任一不满足即停止并提示:

- **权限**: 需要 root 或 sudo（读写 `/etc/wireguard/`、`systemctl`、`wg`）
- **wireguard-tools**: `command -v wg`
- **配置文件**: `sudo test -f /etc/wireguard/wg0.conf`

## Phase 1: 确认本机是主服务器

```bash
# 本机 wg0 公钥必须等于服务器公钥
[ "$(sudo wg show wg0 public-key 2>/dev/null)" = "Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=" ] && echo SERVER_OK || echo NOT_SERVER

# 配置中 Address 必须是服务器 IP
sudo grep -q '^Address = 192\.168\.125\.1/24' /etc/wireguard/wg0.conf && echo ADDR_OK || echo ADDR_MISMATCH
```

两条都通过才继续。任何一条不满足 → **停止**，提示: 本机不是 tutu 主服务器，节点管理必须在 192.168.125.1 上执行（子节点接入请用 `tutu-wg-init`）。

## Phase 2: 罗列当前对等节点清单

从配置解析昵称/公钥/IP，叠加 `wg show` 的实时状态，展示给用户:

```bash
# 配置中的 peer 清单 (昵称 + IP + 公钥)
sudo awk '
  /^# nickname:/ { nick=substr($0, index($0,":")+2) }
  /^\[Peer\]/ { ispeer=1 }
  /^PublicKey/ && ispeer { pk=$3 }
  /^AllowedIPs/ && ispeer { print "  " $3 "\t" nick "\t" pk; nick=""; pk=""; ispeer=0 }
' /etc/wireguard/wg0.conf

# 实时握手状态 (IP -> 最近握手)
sudo wg show wg0 | grep -E 'peer:|allowed ips:|latest handshake:'
```

输出格式（给用户看）:

```text
当前节点 (共 N 个):
  IP              用途         最近握手
  192.168.125.2   家里125      28 秒前
  192.168.125.3   财贸         1 分钟前
  ...
  (无握手时间 = 该节点未上线)

可用 IP 建议: 192.168.125.X   (网段内最小空闲 IP)
```

## Phase 3: 询问操作类型

向用户确认要做什么，**明确等待用户回复**:

1. **新增节点** → 询问 IP 与用途（见 3.1）
2. **修改现有节点** → 列出节点编号让用户指定，并询问改什么（见 3.2）
3. **删除现有节点** → 列出节点编号让用户指定，并要求输入节点 IP 二次确认（见 3.3）

没有收到明确指令 → 默认停在新增流程，不碰旧配置。

### 3.1 新增: 询问 IP 与用途

- **IP**：要求给出 `192.168.125.0/24` 内未占用的固定 IP；用户说"自动"/"随便" → 取网段内最小空闲 IP（跳过 `.1` 服务器自身）
- **用途（nickname）**：一句话描述，将写入 `# nickname: <用途>` 注释，沿用既有习惯

校验:

```bash
# IP 合法且未被占用
[[ "$IP" =~ ^192\.168\.125\.(25[0-4]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]?)$ ]] || echo IP_INVALID
[ "$IP" = "192.168.125.1" ] && echo IP_IS_SERVER
sudo grep -q "AllowedIPs = $IP/32" /etc/wireguard/wg0.conf && echo IP_IN_USE

# nickname 只能出现在注释里: 不允许空白、#、换行, 长度 ≤ 40
[[ "$NICK" =~ ^[^#[:space:]]{1,40}$ ]] || echo NICK_INVALID
```

任一不合法 → 重新询问，不写配置。

### 3.2 修改现有节点

用户指定节点后，确认要改的项（可多项）:

- **改用途** → 新的 nickname，校验同 3.1
- **改 IP** → 新的 IP，校验同 3.1（含未被占用）
- **换公钥**（客户端私钥丢失，重建）→ 不需要旧公钥；生成新密钥对，替换该 peer 的 PublicKey，其余不动；向用户返回新的客户端私钥片段
- **改端点/其他** → 服务器端配置不涉及端点（客户端主动连服务器），仅上述三项可改

修改方式: 备份后用 `awk`/`sed` 精准替换该 peer 块内的行，或整块重写该 peer 块（保留 `# nickname:` 注释与块顺序），**不动其他任何内容**。

### 3.3 删除现有节点

- 列出节点编号，用户指定
- 要求用户**输入该节点的 IP 二次确认**（防误删），确认后才删除
- 删除该 `# nickname:` 注释 + 紧随的 `[Peer]` 块（含空行处理，保持文件整洁）

## Phase 4: 备份与写入

```bash
# 1. 备份现有配置 (沿用服务器 .bak 习惯; 所有变更类型都先备份)
sudo cp /etc/wireguard/wg0.conf "/etc/wireguard/wg0.conf.bak-wgedit-$(date +%Y%m%d-%H%M%S)"

# 2a. 新增: 生成密钥对并按既有注释习惯追加 (只追加, 不动已有内容)
CLIENT_PRIV="$(wg genkey)"
CLIENT_PUB="$(printf '%s' "$CLIENT_PRIV" | wg pubkey)"
sudo tee -a /etc/wireguard/wg0.conf >/dev/null <<EOF

# nickname: $NICK
[Peer]
PublicKey = $CLIENT_PUB
AllowedIPs = $IP/32
EOF

# 2b. 修改/删除: 按 3.2 / 3.3 的方式精准改写对应 peer 块
```

验收:

- 新增: 追加内容与既有 peer 块格式完全一致（`# nickname: xxx` → `[Peer]` → `PublicKey` → `AllowedIPs = <IP>/32`），原有内容零改动
- 修改: 只有目标 peer 块变化，其他块逐字节一致
- 删除: 目标节点完全移除，其余块与顺序不变
- 全程不得回显、记录服务器私钥；不得改动服务器密钥文件
- 所有变更先经用户最终确认（回显变更摘要: 操作类型 + 目标节点 + 新值），确认后才写入

## Phase 5: 重启服务并验证

```bash
sudo systemctl restart wg-quick@wg0
sleep 2
sudo wg show wg0   # 必须看到预期结果 (新增的 peer / 修改后的值 / 删除后消失)
sudo systemctl is-active wg-quick@wg0   # active
```

验收:

- 新增: 新 peer 出现在 `wg show wg0` 中，allowed ips 为 `192.168.125.X/32`
- 修改: `wg show wg0` 中该 peer 的 allowed ips 为新值（或公钥已更新）
- 删除: 该 peer 不再出现
- 接口地址仍为 `192.168.125.1/24`，监听端口仍为 `60399`
- 既有 peer 不受影响（重启瞬间客户端自动重连，属正常）

任一失败 → 停止并报告（配置语法问题用 `sudo wg-quick strip wg0` 检查），并提示可用备份恢复: `sudo cp /etc/wireguard/wg0.conf.bak-wgedit-<时间戳> /etc/wireguard/wg0.conf && sudo systemctl restart wg-quick@wg0`。

## Phase 6: 输出结果

### 新增: 返回客户端配置片段

端点公网地址尝试自动探测一次，失败则留占位符让用户手工填:

```bash
SERVER_EP="$(curl -sS --max-time 3 https://api.ipify.org 2>/dev/null)"
SERVER_EP="${SERVER_EP:-<服务器公网IP>}:60399"
```

输出格式（markdown 代码块，供直接复制）:

````text
=== 新节点配置 ===
用途: $NICK
IP: $IP

在目标机器执行:
  sudo mkdir -p /etc/wireguard && sudo tee /etc/wireguard/wg0.conf <<'EOF'
[Interface]
# 子节点私钥 (仅此一次, 请妥善保存)
PrivateKey = $CLIENT_PRIV
# 子节点在 VPN 中的地址 (192.168.125.0/24 网段)
Address = $IP/24
PostUp = resolvectl dns wg0 192.168.125.1; resolvectl domain wg0 '~tu'
PreDown = resolvectl domain wg0 ''; resolvectl dns wg0 ''

[Peer]
# 服务器端公钥
PublicKey = Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=
# 接受整个 tutu 内网网段流量
AllowedIPs = 192.168.125.0/24
# 服务器端点 (公网IP 需确认)
Endpoint = $SERVER_EP
PersistentKeepalive = 25
EOF
  sudo chmod 600 /etc/wireguard/wg0.conf
  sudo systemctl enable --now wg-quick@wg0

验证: sudo wg show   (看到 handshake 即连通)
````

### 修改: 输出变更摘要

```text
✓ 已更新节点: 192.168.125.X ($NICK)
  变更内容: <改了什么, 旧值 -> 新值>
  服务器配置已生效 (wg-quick@wg0 已重启)
```

换公钥（私钥丢失重建）时，额外输出新的客户端配置片段（同新增格式，仅 PrivateKey/Address 按新值），并提示旧私钥已作废、目标机器需更新配置并重启 wg。

### 删除: 输出删除摘要

```text
✓ 已删除节点: 192.168.125.X ($NICK)
  服务器配置已生效 (wg-quick@wg0 已重启)
```

## Error Handling

- 无 root/sudo → 停止，提示以 root 执行或使用 sudo
- 本机不是主服务器（公钥或 Address 不匹配）→ 停止，指向 `tutu-wg-init`
- IP 非法 / 是 `.1` / 已被占用 / nickname 含非法字符 → 重新询问，不写配置
- 用户未确认变更摘要 / 删除时未二次确认 IP → 不执行写入
- 未获用户明确修改/删除要求 → 绝不改动旧配置
- 重启后结果不符合预期 → 停止，检查语法（`sudo wg-quick strip wg0`）或用备份恢复
- 修改时用户指定的节点不存在 → 重新列出清单让用户重选
- 私钥丢失 → 走修改流程"换公钥"重建节点（旧公钥被替换即作废，无需额外清理）

## Implementation Notes

核心工具:

- `bash` + `wg` / `wg-quick`: 密钥生成、peer 状态
- `sudo tee -a`: 新增时只追加，不重写配置
- `awk`/`sed`: 修改/删除时精准定位目标 peer 块
- `sudo cp`: 沿用服务器 `.bak` 备份习惯
- `systemctl`: 重启与状态检查
- `awk`: 解析配置中的 nickname/IP 清单

禁止:

- ❌ 未经用户明确要求修改/删除旧配置
- ❌ 修改/重写/重新排序已有配置内容（新增只允许 `tee -a` 追加；修改/删除仅限目标块）
- ❌ 动服务器私钥、公钥、Address、ListenPort
- ❌ 把客户端私钥落盘到服务器任何文件（只输出一次）
- ❌ 回显服务器私钥
- ❌ 跳过用户确认直接写入（含删除二次确认）
- ❌ 修改固定参数（服务器公钥 / 网段 / Keepalive / 注释格式）

推荐:

- ✅ 新 peer 严格沿用 `# nickname: <用途>` 注释习惯；修改时同样保留该格式
- ✅ 任何写入前备份 `wg0.conf.bak-wgedit-<时间戳>`
- ✅ 私钥丢失时走"换公钥"重建，不保留旧私钥副本
- ✅ 返回的客户端片段尽量简短、可整体复制
- ✅ 交互节点（操作类型、IP、用途、确认、删除二次确认）必须显式等待用户回复
