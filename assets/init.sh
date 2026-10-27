#!/usr/bin/env bash
#
# init.sh — 新主机接入 tutu-mcp 中心服务
#
# 由中心服务下发（https://<mcp>/init.sh），执行流程:
#   1. 装系统工具: curl / vim / tmux / wireguard-tools（Ubuntu+Debian / RHEL 系）
#   2. 装或更新 pi-agent
#   3. 用一次性注册码向中心兑换: host 令牌、wg 客户端配置、模型配置、扩展清单
#   4. 落盘: ~/.pi/agent/mcp.json、models.json（仅缺失时）、AGENTS.md（仅缺失时）、
#            ~/.tmux.conf、~/.pi/agent/extensions/tutu-share/
#   5. 按清单安装 pi 扩展（已安装的跳过），拉起 wg0 并做连通性自检
#
# 用法（由中心签发的一次性注册码，15 分钟内有效）:
#   bash -c "$(curl -fsSL https://<mcp>/init.sh)"
#
# 非交互环境可用环境变量带入:
#   TUTU_MCP_URL=https://<mcp> TUTU_ENROLL_TOKEN=tutu_xxx bash init.sh
#
# 幂等: 可重复执行；重复注册会轮换本机 host 令牌（旧令牌立即失效）。
#
set -euo pipefail
umask 077

BASE_URL="${TUTU_MCP_URL:-__TUTU_BASE_URL__}"
if [[ "$BASE_URL" == "__TUTU"* ]]; then
	printf '\033[1;31m[init]\033[0m 缺少中心地址: 用 TUTU_MCP_URL=https://<mcp> 指定（本脚本应从中心下载）\n' >&2
	exit 1
fi
BASE_URL="${BASE_URL%/}"

info() { printf '\033[1;34m[init]\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m[init]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[init]\033[0m %s\n' "$*"; }
die() {
	printf '\033[1;31m[init]\033[0m %s\n' "$*" >&2
	exit 1
}

as_root() {
	if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

# ---- 1. 系统工具 ----

detect_family() {
	[[ -f /etc/os-release ]] || die "无法检测系统: /etc/os-release 不存在"
	# shellcheck disable=SC1091
	. /etc/os-release
	case " $ID $ID_LIKE " in
	*" ubuntu "* | *" debian "*) echo "debian" ;;
	*" rhel "* | *" centos "* | *" fedora "* | *" rocky "* | *" almalinux "* | *" ol "*) echo "rhel" ;;
	*) die "不支持的发行版 (ID=$ID, ID_LIKE=$ID_LIKE): 仅支持 Ubuntu/Debian 与 RHEL 系" ;;
	esac
}

install_packages() {
	local family="$1" pkgs
	info "安装系统工具 (curl, vim, tmux, wireguard-tools)..."
	case "$family" in
	debian)
		pkgs="vim tmux wireguard-tools iputils-ping"
		command -v curl >/dev/null 2>&1 || pkgs="$pkgs curl"
		as_root apt-get update -qq
		as_root apt-get install -y -qq $pkgs
		;;
	rhel)
		pkgs="vim-enhanced tmux wireguard-tools iputils"
		command -v curl >/dev/null 2>&1 || pkgs="$pkgs curl"
		if command -v dnf >/dev/null 2>&1; then
			as_root dnf install -y $pkgs || {
				warn "直接安装失败，尝试启用 EPEL 后重试（RHEL 8 的 wireguard-tools 在 EPEL）"
				as_root dnf install -y epel-release
				as_root dnf install -y $pkgs
			}
		else
			as_root yum install -y $pkgs
		fi
		;;
	esac
	command -v wg >/dev/null 2>&1 || warn "未检测到 wg（wg 客户端配置将无法立即生效）"
	ok "系统工具就绪"
}

# ---- 2. pi-agent ----

install_pi() {
	export PATH="$HOME/.local/bin:$PATH"
	if command -v pi >/dev/null 2>&1; then
		info "已检测到 pi ($(command -v pi))，执行更新..."
		pi update || warn "pi update 失败，继续使用现有版本"
		pi update --extensions || true
		ok "pi-agent: $(command -v pi)"
		return
	fi
	info "安装 pi-agent..."
	curl -fsSL https://pi.dev/install.sh | sh
	export PATH="$HOME/.local/bin:$PATH"
	command -v pi >/dev/null 2>&1 || die "pi 安装后仍不在 PATH（请确认 ~/.local/bin 已加入 PATH 后重跑）"
	ok "pi-agent: $(command -v pi)"
}

# ---- 3. 兑换注册码 ----

read_enroll_token() {
	if [[ -n "${TUTU_ENROLL_TOKEN:-}" ]]; then return; fi
	printf '\033[1;34m[init]\033[0m 一次性注册码（中心会话里 tutu_host_enroll 返回）: ' >/dev/tty 2>/dev/null || printf '一次性注册码: '
	if [[ -r /dev/tty ]]; then
		IFS= read -rs TUTU_ENROLL_TOKEN </dev/tty
	else
		IFS= read -rs TUTU_ENROLL_TOKEN
	fi
	printf '\n' >/dev/tty 2>/dev/null || printf '\n'
	[[ -n "${TUTU_ENROLL_TOKEN:-}" ]] || die "未输入注册码"
}

enroll() {
	read_enroll_token
	info "向中心兑换注册码..."
	command -v curl >/dev/null 2>&1 || die "缺少 curl"
	local response
	response="$(curl -fsS --max-time 20 -X POST "$BASE_URL/api/enroll" \
		-H 'content-type: application/json' \
		--data "{\"token\":\"${TUTU_ENROLL_TOKEN}\"}")" || die "兑换失败: 注册码无效/已过期，或中心服务不可达"

	# 响应为 KEY_B64=<base64> 行；用参数展开按第一个 '=' 切分，值里的 '=' 原样保留
	local line key value
	while IFS= read -r line; do
		[[ -z "$line" ]] && continue
		key="${line%%=*}"
		value="${line#*=}"
		[[ "$key" =~ ^TUTU_[A-Z_]+_B64$ ]] || die "响应格式异常: $key"
		[[ -z "$value" ]] && {
			printf -v "$key" '%s' ''
			continue
		}
		[[ "$value" =~ ^[A-Za-z0-9+/=]+$ ]] || die "响应格式异常: $key 非 base64"
		# 存原始 base64，下面统一 decode 一次
		printf -v "$key" '%s' "$value"
	done <<<"$response"

	[[ -n "${TUTU_HOST_NAME_B64:-}" ]] || die "响应缺少主机名"
	HOST_NAME="$(printf '%s' "${TUTU_HOST_NAME_B64}" | base64 -d)"
	MCP_TOKEN="$(printf '%s' "${TUTU_MCP_TOKEN_B64:-}" | base64 -d)"
	MCP_URL="$(printf '%s' "${TUTU_MCP_URL_B64:-}" | base64 -d)"
	WG_CONF="$(printf '%s' "${TUTU_WG_CONF_B64:-}" | base64 -d)"
	MODELS_JSON="$(printf '%s' "${TUTU_MODELS_B64:-}" | base64 -d)"
	EXTENSIONS="$(printf '%s' "${TUTU_EXTENSIONS_B64:-}" | base64 -d)"
	ok "已兑换: 主机 $HOST_NAME"
}

# ---- 4. 落盘 ----

asset() {
	# asset <name> <dest>：先下载到临时文件再覆盖，避免半截文件
	local tmp
	tmp="$(mktemp)"
	if curl -fsS --max-time 20 "$BASE_URL/assets/$1" -o "$tmp"; then
		mv "$tmp" "$2"
	else
		rm -f "$tmp"
		return 1
	fi
}

write_pi_config() {
	local dir="$HOME/.pi/agent" mcp="$HOME/.pi/agent/mcp.json"
	mkdir -p "$dir" "$dir/extensions"
	if [[ -f "$mcp" ]]; then
		cp "$mcp" "$mcp.bak-$(date +%Y%m%d-%H%M%S)"
	fi
	cat >"$mcp" <<EOF
{
  "mcpServers": {
    "tutu-mcp": {
      "url": "${MCP_URL}/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
      "description": "tutu 中心控制面: 主机/内网/模型/分享/邮件"
    }
  }
}
EOF
	chmod 600 "$mcp"
	ok "pi MCP 配置: $mcp (600)"

	if [[ ! -f "$dir/AGENTS.md" ]]; then
		if asset AGENTS.md "$dir/AGENTS.md"; then
			ok "pi 全局约束: $dir/AGENTS.md"
		else
			warn "AGENTS.md 下载失败，跳过"
		fi
	else
		info "已存在 AGENTS.md，保留不覆盖"
	fi

	if [[ -n "$MODELS_JSON" ]]; then
		if [[ ! -f "$dir/models.json" ]]; then
			printf '%s' "$MODELS_JSON" >"$dir/models.json"
			chmod 600 "$dir/models.json"
			ok "模型配置: $dir/models.json（规范版）"
		else
			info "已存在 models.json，保留不覆盖（host 用 tutu_pi_models_get 取规范版，master 用 tutu_pi_models 刷新）"
		fi
	fi

	if asset tmux.conf "$HOME/.tmux.conf"; then
		ok "tmux 配置: ~/.tmux.conf"
	else
		warn "tmux.conf 下载失败，跳过"
	fi

	mkdir -p "$dir/extensions/tutu-share"
	if asset tutu-share.ts "$dir/extensions/tutu-share/index.ts"; then
		ok "share 扩展: $dir/extensions/tutu-share/（新会话生效）"
	else
		warn "tutu-share 扩展下载失败，跳过"
	fi
}

install_extensions() {
	[[ -n "$EXTENSIONS" ]] || return 0
	local installed
	installed="$(pi list 2>/dev/null || true)"
	local source added=0 skipped=0 failed=0
	while IFS= read -r source; do
		[[ -z "$source" ]] && continue
		if grep -qF -- "$source" <<<"$installed"; then
			skipped=$((skipped + 1))
			continue
		fi
		info "安装 pi 扩展: $source"
		if pi install "$source" >/dev/null 2>&1; then
			added=$((added + 1))
		else
			failed=$((failed + 1))
			warn "安装失败: $source"
		fi
	done <<<"$EXTENSIONS"
	ok "pi 扩展: 新装 $added，已存在 $skipped，失败 $failed"
}

apply_wg() {
	[[ -n "$WG_CONF" ]] || {
		info "中心未下发 wg 配置，跳过"
		return 0
	}
	if [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
		die "写入 /etc/wireguard 需要 root 或 sudo"
	fi
	local conf="/etc/wireguard/wg0.conf" tmp
	tmp="$(mktemp)"
	printf '%s' "$WG_CONF" >"$tmp"
	grep -q '^\[Interface\]' "$tmp" || die "下发的 wg 配置非法（缺少 [Interface]）"
	if ! command -v resolvectl >/dev/null 2>&1; then
		warn "无 systemd-resolved（resolvectl 缺失）: 去掉 DNS hook，*.tu 域名不可解析（IP 直连不受影响）"
		grep -vE '^(PostUp|PreDown) = ' "$tmp" >"$tmp.filtered" || true
		mv "$tmp.filtered" "$tmp"
	fi
	as_root mkdir -p /etc/wireguard
	if as_root test -f "$conf"; then
		as_root cp "$conf" "$conf.bak-$(date +%Y%m%d-%H%M%S)"
	fi
	as_root install -m 600 "$tmp" "$conf"
	rm -f "$tmp"
	ok "wg 配置: $conf (600)"

	if command -v systemctl >/dev/null 2>&1; then
		as_root systemctl enable wg-quick@wg0
		# 重新接入时配置已换密钥：必须 restart 才能把新配置应用到内核
		if as_root systemctl is-active --quiet wg-quick@wg0; then
			as_root systemctl restart wg-quick@wg0
		else
			as_root systemctl start wg-quick@wg0
		fi
	else
		as_root wg-quick down wg0 >/dev/null 2>&1 || true
		as_root wg-quick up wg0 || warn "wg-quick up 失败，请手动拉起"
	fi

	sleep 3
	as_root wg show wg0 >/dev/null 2>&1 || die "wg0 未启动，检查 /etc/wireguard/wg0.conf 与 wireguard-tools"
	if ping -c 3 -W 2 192.168.125.1 >/dev/null 2>&1; then
		ok "内网连通: ping 192.168.125.1 正常"
	else
		warn "内网探测失败: 检查服务器端是否已注册本机公钥、UDP 60399 是否可达"
	fi
}

# ---- 5. 收尾 ----

main() {
	info "接入 tutu-mcp 中心服务: $BASE_URL"
	local family
	family="$(detect_family)"
	install_packages "$family"
	install_pi
	enroll
	write_pi_config
	install_extensions
	apply_wg

	ok "初始化完成: $HOST_NAME"
	echo
	echo "  下一步:"
	echo "    1. 重新登录终端（或 export PATH=\"\$HOME/.local/bin:\$PATH\"）"
	echo "    2. 运行 pi，验证工具: 让它调用 tutu_host_status"
	echo "    3. 模型更新: tutu_pi_models；节点管理: tutu_wg_peers / tutu_wg_issue"
	echo "    4. 本机 host 令牌存于 ~/.pi/agent/mcp.json (600)，吊销用中心会话的 tutu_host_revoke"
}

main "$@"
