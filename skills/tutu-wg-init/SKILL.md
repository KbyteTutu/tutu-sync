---
name: tutu-wg-init
description: "Unified WireGuard management for the tutu intranet (192.168.125.0/24). Detects the local wg0 state to pick the mode: on the main server (192.168.125.1) manage peers (list, add with copy-paste client config, edit, delete); on any other machine initialize or verify the wg0 client tunnel — fresh setup is issued top-down on the main server via a copy-paste prompt, then validated and applied locally (idempotent, zero change when healthy). Trigger: 'tutu-wg-init', 'init wireguard', 'wg 配置', 'wireguard 初始化', 'wg edit peer', '编辑节点', '修改节点', '添加节点', '新增节点', '删除节点', 'wg 加节点'."
---

# Tutu WG Init

统一管理 tutu 内网 (`192.168.125.0/24`) 的 WireGuard：**Phase 1 检测本机 wg0 状态决定功能目标**，一个 skill 覆盖两端:

- 本机是**主服务器** (`192.168.125.1`) → 服务器模式：罗列/新增/修改/删除 peer 节点
- 其他任何机器 → 客户端模式：验证或接入本机 wg0 隧道（全新接入由主服务器签发）

**核心原则:**

- 客户端一切正常 (配置存在 + 接口运行 + 内网可达) → **零改动**，直接报告
- 客户端已有配置 → 复用，**绝不重新生成密钥**（否则服务器端注册的公钥立即失效）
- 客户端全新接入**不在本机生成密钥**: 一律到主服务器运行本 skill 签发（新增节点），客户端校验后落盘
- 服务器端默认只新增；只有用户明确要求才动旧配置
- 服务器生成的客户端私钥只输出一次，不落盘
- 服务器端任何写入前先备份 `wg0.conf`（沿用服务器既有 `.bak` 习惯）

## 固定参数 (来自需求，勿改)

| 参数 | 值 |
| ------ | ----- |
| 内网网段 | `192.168.125.0/24` |
| 内网服务器 / DNS | `192.168.125.1` |
| tutu 模型端点 (连通性探测) | `http://192.168.125.1:8317/v1/models` |
| 服务器公钥 | `Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=` |
| 服务器 ListenPort | `60399` |
| 服务器端点 (客户端 Endpoint) | `tutu.gold:60399` |
| AllowedIPs (客户端) | `192.168.125.0/24` |
| PersistentKeepalive | `25` |
| 接口名 / 服务 | `wg0` / `wg-quick@wg0` |
| 配置文件 | `/etc/wireguard/wg0.conf` |
| 服务器既有 peer 注释习惯 | `# nickname: <用途>`（所有变更必须沿用） |

## Phase 0: Preconditions

任一不满足即停止并提示:

- **权限**: 需要 root 或 sudo（读写 `/etc/wireguard/`、`systemctl`、`wg`）
- **wireguard-tools**: `command -v wg` 存在；缺失则安装（Debian 系 `sudo apt-get install -y wireguard-tools` / RHEL 系 `sudo dnf install -y wireguard-tools`），失败 → 停止
- **resolvectl**: `command -v resolvectl`（仅客户端模式决定是否写入 DNS 相关 PostUp/PreDown 行）

## Phase 1: 角色判定

```bash
# A. 本机是主服务器? (从配置文件推导公钥, 不依赖接口运行:
#    服务器 wg0 意外 down 时 wg show 读不到公钥, 会误判成客户端)
SERVER_PK='Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM='
LOCAL_PK="$(sudo awk -F' = ' '/^PrivateKey/{print $2}' /etc/wireguard/wg0.conf 2>/dev/null | wg pubkey 2>/dev/null)"
[ "$LOCAL_PK" = "$SERVER_PK" ] \
  && sudo grep -q '^Address = 192\.168\.125\.1/24' /etc/wireguard/wg0.conf \
  && echo ROLE_SERVER || echo ROLE_CLIENT

# B. 客户端模式下本机配置状态
sudo test -f /etc/wireguard/wg0.conf && echo CONFIG_OK || echo NO_CONFIG
```

| 结果 | 进入 |
| ------ | ------ |
| ROLE_SERVER（两条都匹配） | **服务器模式** (Phase S1) |
| ROLE_CLIENT + CONFIG_OK | **客户端模式**（复用已有配置，从 Phase C1 继续） |
| ROLE_CLIENT + NO_CONFIG | **客户端模式**（全新接入：主服务器签发，从 Phase C2 继续） |

两条服务器判定任一不满足即按客户端处理；未配置的机器（无 wg0.conf 或私钥不可读，推导公钥为空）自然落入 ROLE_CLIENT。

---

## 服务器模式 (本机 = 192.168.125.1)

管理 peer 节点。**默认只新增；只有用户明确要求才修改/删除旧节点。**

### Phase S1: 罗列当前对等节点清单

从配置解析昵称/公钥/IP，叠加 `wg show` 实时状态:

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
  ...
  (无握手时间 = 该节点未上线)

可用 IP 建议: 192.168.125.X   (网段内最小空闲 IP)
```

### Phase S2: 询问操作类型

向用户确认要做什么，**明确等待用户回复**:

1. **新增节点** → 询问 IP、用途（见下）
2. **修改现有节点** → 列出节点让用户指定，并询问改什么（见下）
3. **删除现有节点** → 列出节点让用户指定，并要求输入节点 IP 二次确认

没有收到明确指令 → 默认停在新增流程，不碰旧配置。

#### S2.1 新增: 询问 IP / 用途

- **IP**: `192.168.125.0/24` 内未占用的固定 IP；用户说"自动"/"随便" → 取网段内最小空闲 IP（跳过 `.1` 服务器自身）
- **用途 (nickname)**: 一句话描述，写入 `# nickname: <用途>` 注释
- 密钥一律由服务器生成并当场注册，同时向用户返回完整客户端配置（客户端不自行生成密钥，见客户端模式 C2）

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

#### S2.2 修改现有节点

用户指定节点后，确认要改的项（可多项）:

- **改用途** → 新 nickname，校验同 S2.1
- **改 IP** → 新 IP，校验同 S2.1（含未被占用）
- **换公钥**（客户端私钥丢失重建）→ 不需要旧公钥；服务器生成新密钥对替换该 peer 的 PublicKey，其余不动；返回新的客户端配置片段，目标机器按片段重写本机 wg0.conf 后重启 wg（旧私钥即作废）
- 服务器端配置不涉及客户端端点（客户端主动连服务器），仅上述三项可改

修改方式: 用 `awk`/`sed` 精准替换该 peer 块内的行，或整块重写该 peer 块（保留 `# nickname:` 注释与块顺序），**不动其他任何内容**。

#### S2.3 删除现有节点

- 列出节点，用户指定
- 要求用户**输入该节点的 IP 二次确认**（防误删）
- 删除该 `# nickname:` 注释 + 紧随的 `[Peer]` 块（含空行处理，保持文件整洁）

### Phase S3: 备份与写入

```bash
# 1. 备份 (所有变更类型都先备份)
sudo cp /etc/wireguard/wg0.conf "/etc/wireguard/wg0.conf.bak-$(date +%Y%m%d-%H%M%S)"

# 2a. 新增: 生成密钥对并按既有注释习惯追加 (只追加, 不动已有内容)
CLIENT_PRIV="$(wg genkey)"
CLIENT_PUB="$(printf '%s' "$CLIENT_PRIV" | wg pubkey)"

sudo tee -a /etc/wireguard/wg0.conf >/dev/null <<EOF

# nickname: $NICK
[Peer]
PublicKey = $CLIENT_PUB
AllowedIPs = $IP/32
EOF

# 2b. 修改/删除: 按 S2.2 / S2.3 的方式精准改写对应 peer 块
```

验收:

- 所有变更先经用户最终确认（回显变更摘要: 操作类型 + 目标节点 + 新值），确认后才写入
- 新增: 追加内容与既有 peer 块格式完全一致（`# nickname: xxx` → `[Peer]` → `PublicKey` → `AllowedIPs = <IP>/32`），原有内容零改动
- 修改: 只有目标 peer 块变化，其他块逐字节一致
- 删除: 目标节点完全移除，其余块与顺序不变
- 全程不得回显、记录服务器私钥；不得改动服务器密钥文件
- 客户端私钥不落盘到服务器任何文件（只输出一次）

### Phase S4: 重启服务并验证

```bash
sudo systemctl restart wg-quick@wg0
sleep 2
sudo wg show wg0                 # 必须看到预期结果 (新增的 peer / 修改后的值 / 删除后消失)
sudo wg show wg0 listen-port     # 60399
ip -4 addr show wg0 | grep '192.168.125.1/24'   # 接口地址不变
sudo systemctl is-active wg-quick@wg0   # active
```

验收:

- 新增: 新 peer 出现在 `wg show wg0` 中，allowed ips 为 `192.168.125.X/32`
- 修改: 该 peer 的 allowed ips 为新值（或公钥已更新）
- 删除: 该 peer 不再出现
- 接口地址仍为 `192.168.125.1/24`，监听端口仍为 `60399`
- 既有 peer 不受影响（重启瞬间客户端自动重连，属正常）

任一失败 → 停止并报告（配置语法问题用 `sudo wg-quick strip wg0` 检查），并提示可用备份恢复: `sudo cp /etc/wireguard/wg0.conf.bak-<时间戳> /etc/wireguard/wg0.conf && sudo systemctl restart wg-quick@wg0`。

### Phase S5: 输出结果

#### 新增: 返回客户端配置片段

客户端配置严格对齐参考子节点的完整 `/etc/wireguard/wg0.conf`：字段顺序一致、无行内注释、端点固定 `tutu.gold:60399`。输出（markdown 代码块，供直接复制）:

````text
=== 新节点配置 ===
用途: $NICK
IP: $IP
⚠ 私钥仅此一次展示, 目标机器落盘后请妥善记录
提示: 目标机器若正跑本 skill 客户端模式, 把本代码块带回其会话交由校验落盘;
     否则按下方命令在目标机器手工执行

在目标机器执行:
  sudo mkdir -p /etc/wireguard && sudo tee /etc/wireguard/wg0.conf <<'EOF'
[Interface]
PrivateKey = $CLIENT_PRIV
Address = $IP/24
PostUp = resolvectl dns wg0 192.168.125.1; resolvectl domain wg0 '~tu'
PreDown = resolvectl domain wg0 ''; resolvectl dns wg0 ''

[Peer]
PublicKey = Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=
Endpoint = tutu.gold:60399
AllowedIPs = 192.168.125.0/24
PersistentKeepalive = 25
EOF
  sudo chmod 600 /etc/wireguard/wg0.conf
  sudo systemctl enable --now wg-quick@wg0

验证: sudo wg show   (看到 handshake 即连通)
  DNS: resolvectl status wg0   (192.168.125.1 + ~tu 即生效)

注: 目标机器无 systemd-resolved (command -v resolvectl 失败) 时, 必须删掉
PostUp/PreDown 两行再拉起, 否则 wg-quick up 直接报错退出 (set -e)。
此时 VPN 本身正常, 但 *.tu 域名解析不可用 (192.168.125.x IP 直连不受影响)。
````

#### 修改: 输出变更摘要

```text
✓ 已更新节点: 192.168.125.X ($NICK)
  变更内容: <改了什么, 旧值 -> 新值>
  服务器配置已生效 (wg-quick@wg0 已重启)
```

换公钥（私钥丢失重建）时，输出新的客户端配置片段（同新增格式，仅 PrivateKey/Address 按新值），并提示旧私钥已作废、目标机器按片段重写 wg0.conf 后重启 wg。

#### 删除: 输出删除摘要

```text
✓ 已删除节点: 192.168.125.X ($NICK)
  服务器配置已生效 (wg-quick@wg0 已重启)
```

---

## 客户端模式 (本机 = 子节点)

初始化或验证本机 wg0 隧道，接入 tutu 内网。全新接入走**自上而下严格流程**: 主服务器签发 → 本机校验落盘 → 验证，本机不生成密钥。

### Phase C1: 检查当前状态 (已有配置时)

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
| CONFIG_OK + WG_UP + 握手在最近 3 分钟内 + curl 200 + PEER_OK | 一切正常 | **不做任何改动**，按 C6 摘要格式输出报告，结束 |
| CONFIG_OK + PEER_MISMATCH | 配置指向其他服务器 | **停止并报告**（重启无济于事），与用户确认后决定是否重写配置（重写需回服务器重新签发） |
| CONFIG_OK + WG_UP + PEER_OK + 握手过期或 curl 非 200 | 隧道异常 | `sudo systemctl restart wg-quick@wg0` 后重测；仍失败 → 报告错误停止，不重建配置 |
| CONFIG_OK + WG_DOWN | 已配置未运行 | 复用配置，从 **Phase C4** 继续（跳过 C2/C3） |
| NO_CONFIG | 未配置 | 从 **Phase C2** 继续（主服务器签发流程） |

PEER_MISMATCH 优先判定（无论握手/curl 结果如何，公钥不对就不是本内网的隧道）。

### Phase C2: 引导到主服务器签发（不在本机生成密钥）

全新客户端**不在本机生成任何密钥**。密钥与 IP 一律由主服务器签发（服务器模式新增节点时生成并注册），客户端只领取成品配置。输出以下指引并**停下等待**用户带回签发片段:

```text
本机尚无 WireGuard 配置, 密钥需在主服务器上签发。

步骤: 到主服务器 (192.168.125.1) 的 pi 会话中粘贴以下提示词 →

  tutu-wg-init: 新增节点。用途: <本机标识, 如 "工作笔记本">,
  IP 自动取最小空闲, 密钥由服务器生成。

完成后服务器会输出「=== 新节点配置 ===」代码块。
把整个代码块带回本会话继续。
```

用户带回片段前，不做任何写入。

### Phase C3: 校验并落盘签发片段

用户粘贴「=== 新节点配置 ===」片段后，先**严格校验**，全部通过才写盘；落盘内容一律按参考模板重新生成，**不盲写粘贴内容**:

```bash
# 从片段提取 PrivateKey / Address 后逐项校验
# 1. PrivateKey: 44 字符 base64 (43 数据字符 + '=')
[[ "$PRIVKEY" =~ ^[A-Za-z0-9+/]{43}=$ ]] || echo PRIVKEY_INVALID
# 2. Address: 网段内且非服务器自身
[[ "$IP" =~ ^192\.168\.125\.(25[0-4]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]?)$ ]] \
  && [ "$IP" != "192.168.125.1" ] || echo IP_INVALID
# 3. Peer 公钥必须等于固定服务器公钥 (拿错片段 / 其他 VPN 的配置直接拒绝)
grep -Fq 'Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=' <<<"$SNIPPET" || echo PEER_INVALID
# 4. Endpoint / AllowedIPs 必须等于固定参数
grep -q '^Endpoint = tutu\.gold:60399$' <<<"$SNIPPET" || echo ENDPOINT_INVALID
grep -q '^AllowedIPs = 192\.168\.125\.0/24$' <<<"$SNIPPET" || echo ALLOWED_INVALID
```

任一不满足 → 拒绝写盘并指出问题，让用户回服务器重新获取（服务器公钥/端点不符说明片段不是本内网的签发产物）。

通过后写入（`resolvectl` 不存在或 systemd-resolved 未运行时**省略** PostUp/PreDown 两行——`wg-quick` 以 `set -e` 执行 hook，缺命令会直接失败；省略时提示 `*.tu` 域名解析不可用、`192.168.125.x` IP 直连不受影响）:

```bash
sudo tee /etc/wireguard/wg0.conf >/dev/null <<EOF
[Interface]
PrivateKey = $PRIVKEY
Address = $IP/24
PostUp = resolvectl dns wg0 192.168.125.1; resolvectl domain wg0 '~tu'
PreDown = resolvectl domain wg0 ''; resolvectl dns wg0 ''

[Peer]
PublicKey = Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=
Endpoint = tutu.gold:60399
AllowedIPs = 192.168.125.0/24
PersistentKeepalive = 25
EOF
sudo chmod 600 /etc/wireguard/wg0.conf
```

校验: 文件存在、权限 600、含服务器公钥。

签发即注册（服务器新增节点时已写入 peer），**无需再等服务器端确认**，直接进入 C4。

### Phase C4: 启动并测试连通性

```bash
# 启动 (复用已有配置时同样适用)
sudo systemctl start wg-quick@wg0 2>/dev/null || sudo wg-quick up wg0
sleep 3

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

失败 → **停止**，不启用自启，报告排查方向:

- 服务器端是否已注册该公钥 + IP（最常见原因）
- 端点解析: `getent hosts tutu.gold`（UDP 端口无法用 curl/TCP 探测，勿尝试）
- 服务器防火墙 / UDP 端口

### Phase C5: 设置开机自启

仅在 C4 连通性验证通过后执行:

```bash
sudo systemctl enable wg-quick@wg0
sudo systemctl is-enabled wg-quick@wg0   # 期待 enabled
```

非 systemd 系统 → 提示用户手动加入开机执行 `wg-quick up wg0`，不阻塞收尾。

### Phase C6: Verify + Report

```bash
sudo wg show wg0                # up / Address / peer / 握手
sudo awk -F' = ' '/^PrivateKey/{print $2}' /etc/wireguard/wg0.conf | wg pubkey   # 本机公钥(报告用)
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer tutu' http://192.168.125.1:8317/v1/models   # 200
sudo systemctl is-enabled wg-quick@wg0    # enabled
```

输出摘要:

```text
✓ tutu-wg-init 完成 (客户端模式)

模式: 全新配置 / 复用配置 / 已正常(零改动)
接口: wg0
本机 VPN IP: 192.168.125.x/24
公钥: <PUBLIC_KEY>   (已注册到主服务器)
服务器端点: tutu.gold:60399
握手: <最新握手时间>
内网探测: 192.168.125.1:8317 → 200
开机自启: enabled
配置: /etc/wireguard/wg0.conf (600)
```

## Error Handling

- 无 root/sudo → 停止，提示以 root 执行或使用 sudo
- `wg` 缺失 → 安装 wireguard-tools（apt/dnf），失败停止
- 服务器模式判定不匹配（既非服务器又非有效客户端配置）→ 按客户端模式处理，异常时报错停止
- 签发片段校验失败（私钥/IP 格式非法、服务器公钥/端点/AllowedIPs 与固定参数不符）→ 拒绝写盘并指出问题
- 客户端 PEER_MISMATCH（配置指向其他服务器）→ 停止报告，不自动重写配置
- 服务器模式 IP 非法 / 是 `.1` / 已占用 / nickname 含非法字符 / 公钥格式错误 → 重新询问，不写配置
- `resolvectl` 缺失 → 客户端配置省略 DNS 行并提示；不得保留导致 `wg-quick up` 失败的 hook
- 用户未确认变更摘要 / 删除时未二次确认 IP → 不执行写入
- 服务器模式未获用户明确修改/删除要求 → 绝不改动旧配置
- 重启后结果不符合预期 → 停止，检查语法（`sudo wg-quick strip wg0`）或用备份恢复
- 修改时用户指定的节点不存在 → 重新列出清单让用户重选
- 客户端用户未带回签发片段 → 不得写入任何配置
- 客户端已正常状态 → 零改动（不重启、不 rewrite 配置、不重新生成密钥）

## Implementation Notes

核心工具:

- `bash` + `wg` / `wg-quick`: 状态检查、密钥生成、接口管理
- `sudo tee` / `sudo tee -a`: 写客户端配置；服务器新增只追加，不重写
- `awk`/`sed`: 服务器修改/删除时精准定位目标 peer 块；解析 nickname/IP 清单
- `sudo cp`: 服务器写入前备份 `wg0.conf.bak-<时间戳>`
- `systemctl`: 启动、重启、自启
- `curl`: 内网可达性探测（复用 tutu 模型端点 + 内置 key `tutu`）

禁止:

- ❌ 在客户端本机生成密钥（密钥只能由服务器模式 `wg genkey` 签发；客户端落盘的私钥必须来自签发片段）
- ❌ 覆盖/替换已注册客户端的密钥或配置（重建只能回服务器走「换公钥」重新签发）
- ❌ 回显或额外记录私钥（服务器签发时输出一次属预期；客户端除落盘 wg0.conf 外不得复制到别处）
- ❌ 把服务器代生成的客户端私钥落盘到服务器任何文件（只输出一次）
- ❌ 在用户确认前继续（签发片段带回 / 变更摘要确认 / 删除二次确认）
- ❌ 未经用户明确要求修改/删除服务器旧配置；新增只允许 `tee -a` 追加
- ❌ 动服务器私钥、公钥、Address、ListenPort
- ❌ 修改固定参数（服务器公钥 / 端点 / 网段 / Keepalive / 注释格式）
- ❌ 客户端已正常时做任何修改（含重启接口）

推荐:

- ✅ 客户端密钥唯一载体为 `/etc/wireguard/wg0.conf`（600）；公钥随时可由其 PrivateKey 行推导
- ✅ 新 peer 严格沿用 `# nickname: <用途>` 注释习惯；修改时同样保留该格式
- ✅ 任何服务器写入前备份 `wg0.conf.bak-<时间戳>`
- ✅ 客户端片段严格对齐参考子节点完整配置（字段顺序 / 无注释 / `Endpoint = tutu.gold:60399` 固定），不做公网 IP 探测
- ✅ 交互节点（操作类型、IP、用途、签发片段带回、各项确认）必须显式等待用户回复
