#!/usr/bin/env bash
#
# init.sh — 个人主机基础环境初始化
#
# 适配系统:
#   - Ubuntu / Debian 系 (apt)
#   - RHEL 系 (dnf/yum): RHEL, CentOS, Rocky, AlmaLinux, Fedora, Oracle Linux
#
# 流程:
#   1. 安装系统工具: curl, vim, tmux, wireguard
#   2. 部署 config/ 下的个人配置 (tmux.conf -> ~/.tmux.conf)
#   3. 安装 pi-agent: curl -fsSL https://pi.dev/install.sh | sh
#   4. 将本项目 skills/ 下的 skill 以原名安装到 ~/.pi/agent/skills/
#
# 用法:
#   bash init.sh            # 普通用户执行, 系统包安装自动走 sudo
#
# 幂等: 可重复执行。
#
# 注意:
#   - RHEL 8 的 wireguard-tools 需要先启用 EPEL
#   - 请以普通用户执行 (pi-agent 与 skills 安装在当前用户的 ~/.pi 下)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf '\033[1;34m[init]\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m[init]\033[0m %s\n' "$*"; }
die() {
	printf '\033[1;31m[init]\033[0m %s\n' "$*" >&2
	exit 1
}

# root 时直接执行, 否则 sudo
as_root() {
	if [[ $EUID -eq 0 ]]; then
		"$@"
	else
		sudo "$@"
	fi
}

# 通过 /etc/os-release 的 ID / ID_LIKE 判断包管理家族
detect_family() {
	[[ -f /etc/os-release ]] || die "无法检测系统: /etc/os-release 不存在"
	# shellcheck disable=SC1091
	. /etc/os-release
	case " $ID $ID_LIKE " in
	*" ubuntu "* | *" debian "*) echo "debian" ;;
	*" rhel "* | *" centos "* | *" fedora "* | *" rocky "* | *" almalinux "* | *" ol "*)
		echo "rhel"
		;;
	*) die "不支持的发行版 (ID=$ID, ID_LIKE=$ID_LIKE): 仅支持 Ubuntu/Debian 与 RHEL 系" ;;
	esac
}

install_packages() {
	local family="$1"
	local pkgs
	info "安装系统工具 (curl, vim, tmux, wireguard)..."
	case "$family" in
	debian)
		pkgs="vim tmux wireguard-tools"
		# 容器/精简系统可能缺 curl, 缺了才装 (RHEL 9 预装 curl-minimal, 显式装 curl 会冲突)
		command -v curl >/dev/null 2>&1 || pkgs="$pkgs curl"
		as_root apt-get update
		as_root apt-get install -y $pkgs
		;;
	rhel)
		pkgs="vim-enhanced tmux wireguard-tools"
		command -v curl >/dev/null 2>&1 || pkgs="$pkgs curl"
		if command -v dnf >/dev/null 2>&1; then
			as_root dnf install -y $pkgs
		else
			as_root yum install -y $pkgs
		fi
		;;
	esac
	ok "系统工具安装完成"
}

install_user_configs() {
	local src="$REPO_DIR/config"
	[[ -d "$src" ]] || die "项目 config 目录不存在: $src"

	if [[ -f "$src/tmux.conf" ]]; then
		info "部署 tmux 配置 -> ~/.tmux.conf"
		cp "$src/tmux.conf" "$HOME/.tmux.conf"
		ok "tmux 配置已部署"
	fi
}

install_pi_agent() {
	info "安装 pi-agent..."
	command -v curl >/dev/null 2>&1 || die "缺少 curl, 请先执行系统工具安装"
	curl -fsSL https://pi.dev/install.sh | sh
	if command -v pi >/dev/null 2>&1; then
		ok "pi-agent 已就绪: $(command -v pi)"
	else
		ok "pi-agent 安装脚本执行完成 (请确认 PATH 中包含 ~/.local/bin 等安装位置)"
	fi
}

install_skills() {
	local src="$REPO_DIR/skills"
	local dst="$HOME/.pi/agent/skills"
	[[ -d "$src" ]] || die "项目 skills 目录不存在: $src"
	mkdir -p "$dst"
	local n=0
	for skill_dir in "$src"/*/; do
		[[ -d "$skill_dir" ]] || continue
		local name
		name="$(basename "$skill_dir")"
		if [[ ! -f "$skill_dir/SKILL.md" ]]; then
			info "跳过 $name (缺少 SKILL.md)"
			continue
		fi
		rm -rf "${dst:?}/$name" # 覆盖旧版本, 避免残留过期文件
		cp -R "$skill_dir" "${dst:?}/$name"
		info "已安装 skill: $name"
		n=$((n + 1))
	done
	[[ $n -gt 0 ]] || die "skills/ 下没有可安装的 skill"
	ok "已安装 $n 个 skill 到 $dst"
}

main() {
	local family
	family="$(detect_family)"
	info "检测到系统: $family 系"

	if [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
		die "安装系统包需要 root 或 sudo, 请以 root 执行或以有 sudo 权限的用户执行"
	fi

	install_packages "$family"
	install_user_configs
	install_pi_agent
	install_skills

	ok "初始化完成"
	echo
	echo "  下一步:"
	echo "    1. 重新打开终端, 运行 pi 开始使用"
	echo "    2. 已安装的 skill 可直接触发: tutu-ai-update, tutu-pi-update"
}

main "$@"
