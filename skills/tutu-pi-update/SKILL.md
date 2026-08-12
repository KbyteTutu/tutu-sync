---
name: tutu-pi-update
description: "Sync pi agent tutu provider models in ~/.pi/agent/models.json strictly from the tutu /v1/models endpoint. Model params are looked up online per real model name (user prefix stripped, name normalized); fallback template applies when lookup fails; user-tuned models are preserved. Uses built-in intranet key 'tutu'. Trigger: 'tutu-pi-update', 'update pi models', 'sync pi tutu models'."
---

# Tutu Pi Update

从 tutu 内网 OpenAI-compatible 模型端点同步 `~/.pi/agent/models.json` 中 `providers.tu.models`。

**核心原则: 模型列表完全按照端点更新; 模型参数必须联网查询真实模型（剥离前缀、归一化模型名），查不到的用安全回退; 用户精调永远保留。**

- 模型 ID 集合只来自 `GET http://192.168.125.11:8317/v1/models`
- 认证 key 内置为 `tutu`
- **必须联网查询**（web_search）每个模型的 thinking 映射与上下文长度——端点只返回 id，不返回能力参数，参数必须以真实模型为准
- **模型前缀是用户自定义的**（`bytecat/` `go/` `ds/` `sf/` 等）：id 中第一个 `/` 之前为前缀，剥离后才是真实模型名
- **模型名基本没动但存在大小写/空格差异**：查询前必须归一化（小写、空格/下划线转连字符），否则查不到或查错
- pi 的 models.json 为标准 JSON（无注释）
- 依据 pi 官方文档 (`docs/models.md`): `name`=id、`input`=["text"]、`cost` 全零有内置默认——`name`/`input`/`cost` 一律不写
- **删除模型**: 端点已不存在的从数组中移除

## 固定参数 (勿改)

- 端点: `http://192.168.125.11:8317/v1/models`
- provider `tu`: `baseUrl: http://192.168.125.11:8317/v1`、`api: openai-completions`、`apiKey: tutu`
- provider `compat`: `supportsDeveloperRole: false`、`supportsReasoningEffort: true`（必须为 true，否则 pi 不发送 `reasoning_effort`，thinking 级别无法生效；端点不支持时请求会报错，届时改为 false 并保留用户精调）

## Phase 0: Preconditions

检查必要条件:

- `~/.pi/agent/models.json` 存在
- `providers.tu` 已配置，baseUrl、api、apiKey 正确
- WireGuard / 内网环境可访问 `http://192.168.125.11:8317/v1/models`
- 临时 API key 固定使用 `tutu`

## Phase 1: Fetch Endpoint Models

必须使用内置 API key 调用模型端点:

```bash
curl -sS \
  -H 'Authorization: Bearer tutu' \
  -H 'Content-Type: application/json' \
  'http://192.168.125.11:8317/v1/models' \
  -o /tmp/tutu-pi-models.json

jq -r '.data[].id' /tmp/tutu-pi-models.json | sort > /tmp/tutu-pi-ids.txt
```

验收:

- HTTP status 必须是 `200`
- 响应必须包含 `.data[].id`
- 如端点不可访问或返回非 200，立即停止，不修改任何配置

## Phase 2: List All Available Models

从 endpoint 展示全部可用模型，按 `owned_by` 分组:

```bash
jq -r '[.data[] | {id, owned_by}] | group_by(.owned_by) | .[] | "\n## " + .[0].owned_by + " (" + (length|tostring) + ")\n" + (map("  - " + .id) | join("\n"))' /tmp/tutu-pi-models.json
```

输出总模型数和分组数。

## Phase 3: 联网查询模型参数 (必须)

对端点返回的**每一个模型**执行联网查询。禁止凭训练记忆填写参数，禁止跳过查询直接写默认值。

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

为每个模型记录一份参数表（写进报告），例如:

```text
bytecat/claude-opus-4-6  → claude-opus-4-6: ctx=200000 max_out=64000 thinking=yes levels=未知
gpt-5.5                 → gpt-5.5: ctx=272000 max_out=128000 thinking=yes levels=[low,medium,high]
ds/deepseek-v4-pro      → deepseek-v4-pro: ctx=1000000 max_out=384000 thinking=yes levels=[none,low,medium,high]
```

查询不到任何参数（无来源支撑）→ 标记 `fallback`，写入时使用回退模板。

## Phase 4: Sync models.json

目标文件:

```text
~/.pi/agent/models.json
```

必须先备份:

```bash
cp ~/.pi/agent/models.json \
  ~/.pi/agent/models.json.bak-$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)
```

### 4.1 读取现有配置

解析 `models.json`，取出 `providers.tu.models` 数组。

### 4.2 计算变更

```javascript
// 伪代码
const endpointIds = [...readLines('/tmp/tutu-pi-ids.txt')];
const oldModels = json.providers.tu.models || [];
const oldMap = Object.fromEntries(oldModels.map(m => [m.id, m]));

const added = endpointIds.filter(id => !oldMap[id]);
const deleted = oldModels.filter(m => !endpointIds.includes(m.id)).map(m => m.id);
const kept = endpointIds.filter(id => oldMap[id]);
```

### 4.3 生成模型参数（查询结果优先）

对每个模型（新增 + 未精调），按 Phase 3 查询结果生成:

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
| `thinkingLevelMap` | 查到级别集合 → 只映射集合内的级别（如 `{"low":"low","medium":"medium","high":"high"}`）；支持 thinking 但级别未知 → 完整 6 级直通（minimal~max）；不支持 thinking → 不写 | 完整 6 级直通（回退） |
| `contextWindow` | 查询值 | 不写（pi 默认 128000） |
| `maxTokens` | 查询值 | 不写（pi 默认 16384） |

- `name` / `input` / `cost` 一律不写（pi 默认: name=id、input=["text"]、cost 全零）
- 回退模板 = `reasoning: true` + 完整 6 级 `thinkingLevelMap`（thinking 全开，安全保守）

### 4.4 已有模型: 自动形态收敛

对每个已有模型判定:

**自动生成形态**（以下任一 → 重新生成为本次标准形态）:

- **形态 A — 旧家族遗留**: 参数与旧版本 skill 家族指纹表完全一致（表见下）
- **形态 B — 裸 id**: `{"id": id}`，无任何参数
- **形态 C — 上次默认模板**: `reasoning: true` + 完整 6 级 `thinkingLevelMap`，无其他字段
- **形态 D — 本次标准形态**: 参数与本次查询生成的完全一致 → 无需改动（保持）

**保留（用户精调）** — 不属于以上任一形态 → **原样保留**:

- 显式 `reasoning: false`（且查询结果显示支持 thinking）
- `thinkingLevelMap` 既不是完整 6 级也不是本次查询级别集合
- 含 `input` / `compat` / `samplingParams` 等额外字段
- `name` ≠ `id`，或 `cost` 非全零
- `contextWindow` / `maxTokens` 与查询结果不一致（用户手动改过窗口）

旧家族指纹表（仅用于识别形态 A）:

| 家族 | reasoning | input | contextWindow | maxTokens | thinkingLevelMap | compat |
| ------ | ----------- | ------- | --------------- | ----------- | ------------------ | -------- |
| claude | true | ["text","image"] | 200000 | 64000 | {"xhigh":"max"} | - |
| gemini | true | ["text","image"] | 1048576 | 65536 | {"off":null} | - |
| gpt | true | ["text","image"] | 272000 | 128000 | {"xhigh":"xhigh","minimal":"low"} | {"supportsReasoningEffort":true} |
| deepseek | true | ["text"] | 1000000 | 384000 | {"minimal":null,"low":null,"medium":null,"high":"high","xhigh":"max"} | {"thinkingFormat":"deepseek","requiresReasoningContentOnAssistantMessages":true} |
| glm | true | ["text"] | 131072 | 16384 | - | - |
| kimi | true | ["text"] | 131072 | 16384 | - | - |
| qwen | true | ["text"] | 131072 | 16384 | - | - |
| minimax | true | ["text"] | 131072 | 16384 | - | - |
| image | false | ["text","image"] | 32768 | 8192 | - | - |
| default | true | ["text"] | 200000 | 32000 | - | - |

```javascript
// 伪代码
const standard = (id) => buildFromLookup(id);   // Phase 3 结果; 查不到 = 回退模板
const isAutoForm = (m, id) =>
  JSON.stringify(m) === JSON.stringify(standard(id)) ||  // 形态 D: 已是标准
  legacyFingerprintMatch(m) ||                           // 形态 A
  isBareId(m) ||                                         // 形态 B
  isOldDefaultTemplate(m);                               // 形态 C

const upgraded  = kept.filter(id => isAutoForm(oldMap[id], id))
                      .map(id => standard(id));
const preserved = kept.filter(id => !isAutoForm(oldMap[id], id)).map(id => oldMap[id]);
```

### 4.5 构建新模型数组

```javascript
const newModels = [
  ...upgraded,                              // A/B/C/D 形态 → 本次标准形态（查询结果）
  ...preserved,                             // 用户精调 → 原样保留
  ...added.map(id => standard(id)),         // 新增 → 本次标准形态
];
json.providers.tu.models = newModels;
```

### 4.6 确保 provider 基础配置正确

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

### 4.7 写回文件

用 `JSON.stringify(json, null, 2)` 写回，保持标准 JSON 格式。

## Phase 5: Verify

```bash
# 校验 JSON 语法
jq empty ~/.pi/agent/models.json
```

验证一致性:

- endpoint model ID 集合 == `providers.tu.models[].id` 集合
- 每个未精调模型的 `contextWindow`/`maxTokens`/`thinkingLevelMap` 与 Phase 3 查询记录一致
- 查询失败的模型使用回退模板（`reasoning: true` + 完整 6 级映射）
- `providers.tu.baseUrl` == `http://192.168.125.11:8317/v1`
- `providers.tu.apiKey` == `tutu`
- `providers.tu.api` == `openai-completions`

验证模型实际可用（pi 官方 CLI）:

```bash
pi --list-models tu
```

- 应列出全部 N 个 `tu/...` 模型
- pi 的 models.json 是热加载的 — 编辑后不用重启，下次打开 `/model` 即生效

## Phase 6: Report

输出摘要:

```text
✓ tutu-pi-update 完成

Endpoint:
  http://192.168.125.11:8317/v1/models
Provider:
  tu (pi agent)
API key:
  tutu
Endpoint 模型数: N

联网查询 (N) — 成功 X, 回退 Y:
  - bytecat/claude-opus-4-6 → claude-opus-4-6: ctx=200000 max_out=64000 levels=未知
  - gpt-5.5 → gpt-5.5: ctx=272000 max_out=128000 levels=[low,medium,high]
  - grok-4.5 → grok-4.5: 查无来源, 回退模板

新增模型 (N) — 查询结果/回退模板:
  - model-a

升级为本次标准形态 (N) — 旧家族遗留 X, 裸 id Y, 旧默认模板 Z:
  - model-x (原为 claude 家族默认值)
  - model-y (原为 {"id": ...})

删除模型 (N):
  - old-model-z

保留用户精调 (N):
  - model-w (reasoning false / 自定义 thinkingLevelMap / 手动窗口)

备份:
  ~/.pi/agent/models.json.bak-...
```

## Error Handling

- endpoint 401/403 → 确认使用了 `Authorization: Bearer tutu`，仍失败则停止
- endpoint 超时/不可达 → 提示检查 WireGuard，不修改配置
- endpoint JSON 格式不对 → 停止并显示响应摘要
- 没有模型 ID → 停止，不写空 models
- **web_search 失败/无结果** → 该模型标记回退（回退模板），不得凭记忆填写；报告注明
- 配置写入后 `jq empty` 失败 → 从备份恢复并报告错误
- 模型请求报 thinking 相关错误 → 端点可能不支持某级别或 `reasoning_effort`，对该模型精调 `thinkingLevelMap`（或把 provider `supportsReasoningEffort` 改回 false），保留逻辑不会覆盖
- 如果 `models.json` 不存在 → 先创建最小结构: `{"providers":{"tu":{"baseUrl":"...","api":"openai-completions","apiKey":"tutu","models":[]}}}`

## Implementation Notes

核心工具:

- `bash` + `curl`: 使用内置 key `tutu` 获取 endpoint 模型列表
- **`web_search`**: 查询每个归一化真实模型名的 contextWindow / maxTokens / thinking 级别（必须使用，禁止跳过）
- `read`: 读取 `models.json`
- `edit` 或 `write`: 更新 models.json
- `bash` + `jq`: 验证 JSON 语法
- `pi --list-models tu`: 验证模型实际可用

禁止:

- ❌ 凭训练记忆填写模型参数（必须基于本次联网查询结果，查不到就回退）
- ❌ 用未归一化的模型名查询（带前缀/大小写差异会查错或查不到）
- ❌ 跳过查询直接给所有模型写默认模板（查询是必须步骤）
- ❌ 给模型写 `name`/`input`/`cost`（信任 pi 默认值）
- ❌ 保留旧家族遗留、裸 id、旧默认模板形态（必须升级为本次标准形态）
- ❌ 覆盖用户精调（显式 `reasoning: false`、自定义 `thinkingLevelMap`、手动窗口 → 原样保留）
- ❌ endpoint 失败时修改配置
- ❌ 用 opencode 的模型对象格式（pi 格式不同）

推荐:

- ✅ endpoint 模型 ID 集合是唯一事实来源
- ✅ 每个模型必须联网查询，来源优先官方文档/定价页、OpenRouter
- ✅ 查询不到的模型用回退模板（thinking 全开 + pi 默认窗口），并在报告标注
- ✅ 归一化规则: 剥前缀 → 小写 → 空格/下划线转连字符 → 剥 -thinking/-agent 后缀
- ✅ 先备份，再修改
- ✅ 报告新增、升级、删除和保留的模型
