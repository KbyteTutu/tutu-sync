---
name: tutu-pi-ext
description: "Install the pi extensions that ship with this host (reference machine's user packages) onto the current machine's pi. Idempotent: already-installed extensions are skipped. Trigger: 'tutu-pi-ext', 'install pi extensions', 'pi 扩展安装', '装 pi 插件'."
---

# Tutu Pi Ext

把本机（参考主机）pi 所带有的 extensions（user packages）安装到当前机器的 pi。

**核心原则: 清单 = 参考主机 pi 已安装的扩展（`pi list` 事实来源）; 幂等，已安装即跳过; 不卸载、不覆盖任何已存在扩展。**

- 清单来源: 参考主机 `~/.pi/agent/settings.json` 的 `packages` 数组 / `pi list` 输出
- 安装命令: `pi install <source>`（写入当前机器的 user settings `~/.pi/agent/settings.json`）
- 已安装（`pi list` 中已出现）→ 跳过，不重复安装
- 扩展安装后立即生效（新会话加载），无需重启 pi

## 固定清单 (来自参考主机 pi list, 勿改)

```text
npm:@vigolium/piolium
npm:pi-web-access
npm:pi-lens
npm:bigpowers
npm:context-mode
```

若参考主机安装了新扩展，先更新本 skill 的固定清单再执行（清单是本 skill 唯一事实来源）。

## Phase 0: Preconditions

检查必要条件:

- `command -v pi` 存在（pi 未安装时先执行 init.sh 或 tutu-wg-init 之前的安装流程）
- 网络可达 npm registry（`npm config get registry` 或直接安装时验证）
- 如走 git 源（本清单全为 npm 源，无需）则需 git 与 SSH 凭证

## Phase 1: 检查当前已安装

```bash
pi list
```

记录输出中的 User packages 列表。输出示例:

```text
User packages:
  npm:@vigolium/piolium
  npm:pi-web-access
```

## Phase 2: 逐个安装缺失扩展

对固定清单中的每个 source:

```bash
# 已在 pi list 中 → 跳过
# 缺失 → 安装
pi install npm:@vigolium/piolium
```

判定与处理:

- source 已在 `pi list` 输出 → 跳过，记录 "已存在"
- source 缺失 → `pi install <source>`，期待退出码 0
- 安装失败（网络/npm 错误）→ 记录失败原因，**继续安装其余扩展**，不中断

## Phase 3: 验证

```bash
pi list
```

验收:

- 固定清单中每个 source 都出现在 User packages 中
- 已安装的扩展不再重复（`pi list` 无重复项）
- 未动任何用户已有的其他扩展

失败项（Phase 2 失败的）在报告中单独列出并给出排查方向（网络、npm 凭证、包名是否存在）。

## Phase 4: Report

输出摘要:

```text
✓ tutu-pi-ext 完成

清单 (5):
  npm:@vigolium/piolium   → 已存在 / 已安装
  npm:pi-web-access       → 已存在 / 已安装
  npm:pi-lens             → 已存在 / 已安装
  npm:bigpowers           → 已存在 / 已安装
  npm:context-mode        → 已存在 / 已安装

新增安装 (N): ...
跳过已存在 (N): ...
失败 (N): ...
  - <source>: <原因>

提示: 新扩展在下一个 pi 会话生效; 需要联网模型/工具时确认扩展已启用 (pi list / pi config)。
```

## Error Handling

- `pi` 不存在 → 停止，提示先安装 pi-agent（init.sh）
- `pi list` 失败 → 停止，不安装任何扩展
- 单个扩展安装失败 → 记录原因继续，最后汇总报告
- 全部安装失败 → 报告网络/npm 问题，不修改 settings.json 之外的内容
- npm registry 不可达 → 提示检查网络，不重试死循环

## Implementation Notes

核心工具:

- `bash` + `pi list`: 读取当前已安装扩展（事实来源之一）
- `bash` + `pi install`: 安装缺失扩展（写入 user settings）
- `bash` + `pi config`: 按需确认扩展资源启用状态

禁止:

- ❌ 安装清单之外的扩展（用户未要求的不装）
- ❌ 卸载/移除任何已存在的扩展（包括不在清单中的）
- ❌ 用 `-l`（project-local）安装——本 skill 一律写 user settings
- ❌ 修改参考主机的任何配置（本 skill 只作用于当前机器）
- ❌ 跳过验证直接报告成功

推荐:

- ✅ 清单严格等于参考主机 `pi list` 的 User packages
- ✅ 幂等: 已安装跳过，不重复安装
- ✅ 单个失败不中断整体，最后汇总
- ✅ 先备份 `~/.pi/agent/settings.json`（如需）再安装，安装后确认 packages 数组正确
