---
name: tutu-pi-update
description: "Incrementally sync pi agent tutu provider models in ~/.pi/agent/models.json from the tutu /v1/models endpoint. A cache file (~/.pi/agent/tutu-pi-update.cache.json) records what this skill last wrote, so only changed models (added / removed / legacy form / failed lookup retry) get online parameter lookup; unchanged cache-hit models cost zero queries and zero writes. Model params are looked up online per real model name (prefix stripped, name normalized); fallback template applies when lookup fails; user-tuned models are preserved. Uses built-in intranet key 'tutu'. Full resync mode available. Trigger: 'tutu-pi-update', 'update pi models', 'sync pi tutu models'; full mode: 'tutu-pi-update full', '全量同步 tutu models'."
---

# Tutu Pi Update

从 tutu 内网 OpenAI-compatible 模型端点**增量**同步 `~/.pi/agent/models.json` 中 `providers.tu.models`。

**核心原则: 端点 ID 集合每次都拉取（唯一事实来源，1 次 curl）；参数查询只对变更集执行（web_search 是最贵步骤）；缓存命中且未变更的模型零查询、零写入；用户精调永远保留。**

- 端点只返回 id，不返回能力参数 → 需要参数的模型**必须联网查询**（web_search），禁止凭训练记忆填写
- 缓存文件记录 skill 上次写入的每个条目（深度相等比较）→ 变更检测基线
- **模型前缀是用户自定义的**（`bytecat/` `go/` `ds/` `sf/` 等）：id 中第一个 `/` 之前为前缀，剥离后才是真实模型名
- 查询前必须归一化模型名（小写、空格/下划线转连字符），否则查不到或查错
- pi 的 models.json 为标准 JSON（无注释）
- 依据 pi 官方文档 (`docs/models.md`): `name`=id、`input`=["text"]、`cost` 全零有内置默认——`name`/`input`/`cost` 一律不写
- **删除模型**: 端点已不存在的从数组中移除，并从缓存移除

## 固定参数 (勿改)

- 端点: `http://192.168.125.11:8317/v1/models`
- provider `tu`: `baseUrl: http://192.168.125.11:8317/v1`、`api: openai-completions`、`apiKey: tutu`
- provider `compat`: `supportsDeveloperRole: false`、`supportsReasoningEffort: true`（必须为 true，否则 pi 不发送 `reasoning_effort`；端点不支持时请求会报错，届时改为 false 并保留用户精调）
- 缓存: `~/.pi/agent/tutu-pi-update.cache.json`，结构:

```json
{
  "syncedAt": "<UTC ISO>",
  "models": {
    "<endpoint-id>": { "model": { "…条目原文…": "" }, "fallback": false }
  }
}
```

- `model` = 上次写入 models.json 的**精确条目**（深度相等比较用）
- `fallback: true` = 该条目参数来自回退模板（查询失败），下次运行需重试查询
- 模式: 默认增量；触发词含 `full` / `全量` 时走全量模式（见文末）

## Phase 0: Preconditions

- `~/.pi/agent/models.json` 存在（不存在则先创建最小结构: `{"providers":{"tu":{"baseUrl":"http://192.168.125.11:8317/v1","api":"openai-completions","apiKey":"tutu","models":[]}}}`）
- `providers.tu` 的 baseUrl、api、apiKey 正确
- WireGuard / 内网环境可访问端点
- 临时 API key 固定使用 `tutu`

## Phase 1: Fetch Endpoint Models

```bash
export LC_ALL=C                       # sort/comm 必须字节序，否则 diff 报 "not in sorted order"
T=/tmp/tutu-pi-update.$(id -u)        # 按用户隔离临时目录（/tmp 固定文件名会被其他用户的残留文件堵死）
mkdir -p "$T" && cd "$T"

curl -sS \
  -H 'Authorization: Bearer tutu' \
  -H 'Content-Type: application/json' \
  'http://192.168.125.11:8317/v1/models' \
  -o "$T/models.json"

jq -r '.data[].id' "$T/models.json" | sort > "$T/ids.txt"
```

> 下文所有 /tmp/tutu-pi-* 路径均指 "$T/" 下同名文件。

展示端点全貌（按 `owned_by` 分组，供报告参考）:

```bash
jq -r '[.data[] | {id, owned_by}] | group_by(.owned_by) | .[] | "\n## " + .[0].owned_by + " (" + (length|tostring) + ")\n" + (map("  - " + .id) | join("\n"))' "$T/models.json"
```

验收:

- HTTP status 必须是 `200`，响应包含 `.data[].id`
- 端点不可访问或非 200 → 立即停止，不修改任何配置
- curl 报写入错误（exit 23）→ 检查临时目录权限/残留文件，换新目录重试

## Phase 2: Diff & Classify（本地比较，零联网）

### 2.1 三集合

```bash
jq -r '.providers.tu.models[].id' ~/.pi/agent/models.json | sort > "$T/old-ids.txt"
comm -13 "$T/old-ids.txt" "$T/ids.txt"    > "$T/added.txt"    # 新增: 端点有、本地无
comm -23 "$T/old-ids.txt" "$T/ids.txt"    > "$T/deleted.txt"  # 删除: 本地有、端点无
comm -12 "$T/old-ids.txt" "$T/ids.txt"    > "$T/kept.txt"     # 保留: 两边都有
```

### 2.2 缓存命中判定（深度相等）

```bash
: > "$T/unchanged.txt"; : > "$T/fallback-retry.txt"
CACHE=~/.pi/agent/tutu-pi-update.cache.json
while read -r id; do
  cur=$(jq -Sc --arg id "$id" '.providers.tu.models[] | select(.id == $id)' ~/.pi/agent/models.json)
  ent=$(jq -Sc --arg id "$id" '.models[$id].model // empty' "$CACHE" 2>/dev/null)
  if [ -n "$ent" ] && [ "$cur" = "$ent" ]; then
    if [ "$(jq -r --arg id "$id" '.models[$id].fallback // false' "$CACHE" 2>/dev/null)" = "true" ]; then
      echo "$id" >> "$T/fallback-retry.txt"   # 上次回退 → 本次重试查询
    else
      echo "$id" >> "$T/unchanged.txt"        # 未变更 → 跳过
    fi
  fi
done < "$T/kept.txt"
```

### 2.3 kept 中缓存未命中的条目分类（逐个本地判定）

| 判定 | 条件（本地检查，不查询） | 处置 |
| ---- | ---- | ---- |
| 缓存命中 | 条目与缓存 `model` 深度相等 | unchanged（fallback=true 则进重试集） |
| 裸 id | keys == `["id"]` | 升级 → 进查询集 |
| 旧默认模板 | keys == `["id","reasoning","thinkingLevelMap"]` 且 reasoning=true 且 thinkingLevelMap 为完整 6 级直通 | 升级 → 进查询集 |
| 含额外字段 | 任一字段 ∉ {id, reasoning, thinkingLevelMap, contextWindow, maxTokens} | **用户精调 → 原样保留，不缓存** |
| 其余（标准形态但无缓存条目） | — | **用户精调 → 原样保留**（缓存存在后出现的标准形态条目只能是手动添加的） |

注: 缓存条目存在但条目 ≠ 缓存 → 用户在上次同步后手动改过 → 精调保留；缓存条目**不动**（用户改回缓存形态后自动恢复 skill 管理）。

### 2.4 Bootstrap（缓存文件不存在时的首次运行）

一次性建立基线，**零查询**:

- kept 条目 keys ⊆ 5 个已知字段、非裸 id、非旧默认模板 → **原样采纳**写入缓存（`fallback: false`）
- 裸 id / 旧默认模板 → 进查询集升级
- 含额外字段 → 用户精调，保留不缓存
- 报告列出「首次基线采纳 (N)」供用户核对有无误采纳的手动条目

### 2.5 查询集

```text
查询集 = added + 升级集（裸 id / 旧默认模板） + fallback 重试集
```

**查询集可以为空 → Phase 3 整体跳过**（增量模式的核心收益）。

## Phase 3: 联网查询（仅查询集）

对查询集中**每一个模型**执行联网查询。禁止凭训练记忆填写参数，禁止跳过查询直接写默认值。

### 3.1 归一化模型名

```text
1. 剥离用户自定义前缀: id 中第一个 / 前的内容（bytecat/ go/ ds/ sf/ 等）去掉
2. 小写化
3. 空格 / 下划线 → 连字符（"DeepSeek V4 Pro" → deepseek-v4-pro）
4. 网关变体后缀剥离: -thinking / -agent 等剥掉后查基础模型
   （如 claude-opus-4-6-thinking → claude-opus-4-6）
```

示例:

| 端点 id | 归一化真实模型名 |
| ------ | --------------- |
| `bytecat/claude-opus-4-6` | `claude-opus-4-6` |
| `ds/deepseek-v4-pro` | `deepseek-v4-pro` |
| `go/kimi-k3` | `kimi-k3` |
| `gpt-5.5` | `gpt-5.5` |
| `claude-fable-5` | `claude-fable-5` |

### 3.2 查询内容与来源

对每个归一化模型名执行 web_search（同一系列可合并查询，但每个模型必须有来源支撑），查询:

- **contextWindow**: 上下文长度（tokens）
- **maxTokens**: 最大输出 tokens
- **thinking 支持**: 是否支持 reasoning/thinking
- **thinking 级别集合**: 支持哪些 effort 级别（如 OpenAI GPT-5 系为 low/medium/high；DeepSeek 为 none/low/medium/high；Claude 无 effort 级别则记录"级别未知"）

来源优先级:

1. 模型官方文档 / 官方定价页（OpenAI、Anthropic、DeepSeek、Google、Zhipu、Moonshot 等）
2. OpenRouter 模型页（聚合 context/max output/thinking 能力）
3. 其他权威聚合来源

### 3.3 记录查询结果

为查询集中每个模型记录参数表（写进报告），例如:

```text
bytecat/claude-opus-4-6  → claude-opus-4-6: ctx=200000 max_out=64000 thinking=yes levels=未知
gpt-5.5                 → gpt-5.5: ctx=272000 max_out=128000 thinking=yes levels=[low,medium,high]
grok-4.5                → grok-4.5: 查无来源 → 回退（或沿用缓存旧值，见 4.3）
```

## Phase 4: Sync

### 4.0 无变更短路

变更集 = added ∪ deleted ∪ 升级集 ∪ fallback 重试成功，且 provider 基础配置正确 → **不备份、不写入 models.json、不动缓存**，直接进 Phase 5（Bootstrap 除外——首次运行必须写缓存基线）。

### 4.1 备份（仅在有写入时）

```bash
cp ~/.pi/agent/models.json \
  ~/.pi/agent/models.json.bak-$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)
```

### 4.2 生成标准形态（查询结果优先）

```json
{
  "id": "<endpoint-id>",
  "reasoning": true,
  "thinkingLevelMap": {
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
    "max": "max"
  },
  "contextWindow": 200000,
  "maxTokens": 64000
}
```

字段规则（严格按查询结果）:

| 字段 | 查询到 | 查询不到 |
| ---- | ------ | -------- |
| `reasoning` | 支持 thinking → `true`；明确不支持 → `false` | `true`（回退） |
| `thinkingLevelMap` | 查到级别集合 → 只映射集合内的级别（如 `{"low":"low","medium":"medium","high":"high"}`）；支持 thinking 但级别未知 → 完整 6 级直通；不支持 thinking → 不写 | 完整 6 级直通（回退） |
| `contextWindow` | 查询值 | 不写（pi 默认 128000） |
| `maxTokens` | 查询值 | 不写（pi 默认 16384） |

- `name` / `input` / `cost` 一律不写（pi 默认: name=id、input=["text"]、cost 全零）
- 回退模板 = `reasoning: true` + 完整 6 级 `thinkingLevelMap`（thinking 全开，安全保守），缓存标记 `fallback: true`

### 4.3 查询失败兜底

优先级: **缓存旧值（last known good）> 回退模板**。

- 全量/重试时查询失败，但缓存中该 id 有 `fallback: false` 的旧条目 → 沿用旧条目，缓存标记改为 `fallback: true` 待下次重试
- 无缓存旧值 → 回退模板 + `fallback: true`

### 4.4 构建新模型数组

```text
newModels = [
  …unchanged 原条目（不重排序）,      // 保持物理顺序 → 人工 diff 只显示真实变更
  …preserved 用户精调原条目,
  …upgraded / 重试成功的新标准条目（就地替换原位置）,
  …added 新条目（追加末尾）,
]
```

- 删除的 id 移除；数组保持原有顺序，新增追加末尾

### 4.5 确保 provider 基础配置正确

```json
"tu": {
  "baseUrl": "http://192.168.125.11:8317/v1",
  "api": "openai-completions",
  "apiKey": "tutu",
  "compat": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": true
  }
}
```

### 4.6 写回

- models.json: `JSON.stringify(json, null, 2)`，标准 JSON
- 缓存: 写入本轮所有 skill 管理条目（unchanged / upgraded / added）+ fallback 标记；移除已删除 id 的缓存；精调条目不动（保留旧缓存条目见 2.3 注）
- 先写 models.json 再写缓存；缓存写失败无害（下次运行按无条目分类，偏保守不会破坏数据）

## Phase 5: Verify

```bash
jq empty ~/.pi/agent/models.json   # JSON 语法
```

- endpoint model ID 集合 == `providers.tu.models[].id` 集合
- **本轮写入的**条目 `contextWindow`/`maxTokens`/`thinkingLevelMap` 与 Phase 3 查询记录一致（unchanged 条目由 2.2 深度相等保证，无需重查）
- 回退条目使用回退模板且缓存 `fallback: true`
- `providers.tu` baseUrl / apiKey / api 正确

```bash
pi --list-models tu
```

- 应列出全部 N 个 `tu/...` 模型
- pi 的 models.json 是热加载的 — 编辑后不用重启，下次打开 `/model` 即生效

## Phase 6: Report

```text
✓ tutu-pi-update 完成 (增量)

Endpoint: http://192.168.125.11:8317/v1/models
Endpoint 模型数: N (本地 M)

跳过·未变更缓存命中 (N):
新增模型 (N) — 查询结果/回退:
  - model-a
升级为标准形态 (N) — 裸 id X, 旧默认模板 Y:
  - model-x
回退重试 (N) — 成功 X, 仍失败 Y:
  - model-y (沿用缓存旧值 / 回退模板)
删除模型 (N):
  - old-model-z
保留用户精调 (N):
  - model-w (手动参数)
首次基线采纳 (N)        # 仅 bootstrap 时
联网查询 (M) — 成功 X, 回退 Y   # M = 查询集大小，可远小于 N
备份: ~/.pi/agent/models.json.bak-... (或「无变更，未写入」)
```

## 全量模式（触发词含 full / 全量）

强制刷新全部模型参数（用于怀疑上游参数已变、或增量模式长期未刷新时）:

- **对端点全部模型联网查询**（同 Phase 3 规则）
- 分类沿用 Phase 2 缓存判定: 缓存命中（条目 == 缓存）→ skill 管理 → 用新查询结果重写；不命中或含额外字段 → 用户精调 → 保留
- 裸 id / 旧默认模板 → 升级
- 查询失败 → 沿用缓存旧值（见 4.3），无旧值才回退
- 写入后**重建整个缓存**；报告标注「全量模式」

## Error Handling

- endpoint 401/403 → 确认使用了 `Authorization: Bearer tutu`，仍失败则停止
- endpoint 超时/不可达 → 提示检查 WireGuard，不修改配置
- endpoint JSON 格式不对 → 停止并显示响应摘要
- 没有模型 ID → 停止，不写空 models
- **web_search 失败/无结果** → 缓存旧值优先，否则回退模板；不得凭记忆填写；报告注明
- 配置写入后 `jq empty` 失败 → 从备份恢复并报告错误
- 缓存文件损坏/非法 JSON → 视为不存在，走 Bootstrap 重建
- 模型请求报 thinking 相关错误 → 端点可能不支持某级别或 `reasoning_effort`，对该模型精调 `thinkingLevelMap`（或把 provider `supportsReasoningEffort` 改回 false），保留逻辑不会覆盖

## Implementation Notes

核心工具:

- `bash` + `curl`: 获取 endpoint 模型列表（内置 key `tutu`）；临时目录用 `/tmp/tutu-pi-update.$(id -u)` 按用户隔离
- `bash` + `jq` + `comm`: 三集合 diff、`jq -Sc` 深度相等缓存判定；sort/comm 前必须 `export LC_ALL=C`
- `jq` 多文档输出用 `jq -c`（每文档一行）再按行拆分，禁止对 pretty-print 输出用 head/tail 切分
- **`web_search`**: 仅对查询集查 contextWindow / maxTokens / thinking 级别（增量模式核心：查询集可 为空）
- `read` / `edit` / `write`: 读写 models.json 与缓存
- `pi --list-models tu`: 验证模型实际可用

禁止:

- ❌ 对缓存命中的未变更模型发起联网查询或重写（增量核心，全量模式除外）
- ❌ 凭训练记忆填写模型参数（查询不到 → 缓存旧值 → 回退模板）
- ❌ 用未归一化的模型名查询
- ❌ 给模型写 `name`/`input`/`cost`（信任 pi 默认值）
- ❌ 覆盖用户精调（条目 ≠ 缓存 或 含额外字段 → 原样保留）
- ❌ endpoint 失败时修改配置
- ❌ 用 opencode 的模型对象格式（pi 格式不同）

推荐:

- ✅ 端点 ID 集合每次都拉取，是唯一事实来源；参数查询只对变更集
- ✅ 缓存 = 变更检测基线 + last-known-good 兜底 + fallback 重试标记
- ✅ 无变更 → 不备份不写入；写入时保持条目原有顺序（新增追加末尾），人工 diff 干净
- ✅ 归一化规则: 剥前缀 → 小写 → 空格/下划线转连字符 → 剥 -thinking/-agent 后缀
- ✅ 先备份再修改；先写 models.json 再写缓存
- ✅ 报告各分类计数，联网查询数 M 应远小于总模型数 N
