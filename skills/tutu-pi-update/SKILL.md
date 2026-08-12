---
name: tutu-pi-update
description: "Sync pi agent tutu provider models in ~/.pi/agent/models.json strictly from the tutu /v1/models endpoint. All models default to reasoning on with a full thinkingLevelMap; legacy family-default params and bare id entries are upgraded automatically. Uses built-in intranet key 'tutu'. Trigger: 'tutu-pi-update', 'update pi models', 'sync pi tutu models'."
---

# Tutu Pi Update

从 tutu 内网 OpenAI-compatible 模型端点同步 `~/.pi/agent/models.json` 中 `providers.tu.models`。

**核心原则: 模型列表完全按照端点更新; 标准形态 = 默认模板 (thinking 全开 + 完整级别映射); 用户精调永远保留。**

- 模型 ID 集合只来自 `GET http://192.168.125.11:8317/v1/models`
- 认证 key 内置为 `tutu`
- 不使用 web search
- pi 的 models.json 为标准 JSON（无注释）
- 依据 pi 官方文档 (`docs/models.md`): 模型对象**只有 `id` 是必须的**，其余字段均有内置默认值（`name`=id、`input`=["text"]、`contextWindow`=128000、`maxTokens`=16384、`cost` 全零）——`name`/`input`/`contextWindow`/`maxTokens`/`cost` **不写**，信任 pi 默认
- **标准形态（新模型与未精调模型统一）**: `reasoning: true` + 完整 `thinkingLevelMap`（minimal~max 全部直通，pi 默认省略时 `xhigh`/`max` 不展示，因此显式提供）
- **收敛逻辑**: 旧家族遗留参数、裸 `{"id": id}` 形态 → 一律升级为默认模板；用户精调（`reasoning: false`、自定义 `thinkingLevelMap`、额外参数等）→ 完整保留
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

## Phase 3: Sync models.json

目标文件:

```text
~/.pi/agent/models.json
```

必须先备份:

```bash
cp ~/.pi/agent/models.json \
  ~/.pi/agent/models.json.bak-$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)
```

### 3.1 读取现有配置

解析 `models.json`，取出 `providers.tu.models` 数组。

### 3.2 计算变更

```javascript
// 伪代码
const endpointIds = [...readLines('/tmp/tutu-pi-ids.txt')];
const oldModels = json.providers.tu.models || [];
const oldMap = Object.fromEntries(oldModels.map(m => [m.id, m]));

const added = endpointIds.filter(id => !oldMap[id]);
const deleted = oldModels.filter(m => !endpointIds.includes(m.id)).map(m => m.id);
const kept = endpointIds.filter(id => oldMap[id]);
```

### 3.3 默认模板

所有模型（新增 + 未精调）统一使用:

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
  }
}
```

- `reasoning: true`: 默认开启思考
- `thinkingLevelMap`: pi 思考级别直通 provider 值，`minimal`~`max` 全部可用
- 其余字段一律不写（`name`=id、`input`=["text"]、`contextWindow`=128000、`maxTokens`=16384、`cost` 全零）
- 若端点对某级别不支持（请求报错）→ 在该模型上手动精调 `thinkingLevelMap`（精调模型不会被覆盖）

### 3.4 已有模型: 收敛到默认模板

对每个已有模型判定形态:

**形态 A — 旧家族遗留**（旧版本 skill 生成的家族默认值，指纹表匹配）→ 升级为默认模板

指纹表（旧版本 skill 的家族默认值，仅用于识别）:

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

**形态 B — 裸 id 形态**（`{"id": id}`，无任何参数）→ 升级为默认模板

**形态 C — 默认模板** → 保持不变

**保留（用户精调）** — 出现以下任一特征即视为用户手动精调，**原样保留**:

- `reasoning` 显式为 `false`（用户明确关闭思考）
- `thinkingLevelMap` 与默认映射不同（用户自定义级别）
- 含 `input` / `contextWindow` / `maxTokens` / `compat` / `samplingParams` 等额外字段
- `name` ≠ `id`，或 `cost` 非全零

```javascript
// 伪代码
const DEFAULT_TEMPLATE = {
  reasoning: true,
  thinkingLevelMap: { minimal:"minimal", low:"low", medium:"medium",
                      high:"high", xhigh:"xhigh", max:"max" },
};
// cost 缺省（无字段）视为全零
const allZero = (c) => !c || (c.input===0 && c.output===0 && c.cacheRead===0 && c.cacheWrite===0);
const isUserTuned = (m) =>
  m.reasoning === false ||
  JSON.stringify(m.thinkingLevelMap || DEFAULT_TEMPLATE.thinkingLevelMap) !==
    JSON.stringify(DEFAULT_TEMPLATE.thinkingLevelMap) ||
  ['input','contextWindow','maxTokens','compat','samplingParams'].some(k => k in m) ||
  (m.name !== undefined && m.name !== m.id) ||
  !allZero(m.cost);

const upgraded  = kept.filter(id => !isUserTuned(oldMap[id]))
                      .map(id => ({ id, ...DEFAULT_TEMPLATE }));
const preserved = kept.filter(id =>  isUserTuned(oldMap[id])).map(id => oldMap[id]);
```

### 3.5 构建新模型数组

```javascript
const newModels = [
  ...upgraded,                              // A/B/C 形态 → 默认模板 (thinking true)
  ...preserved,                             // 用户精调 → 原样保留
  ...added.map(id => ({ id, ...DEFAULT_TEMPLATE })),  // 新增 → 默认模板
];
json.providers.tu.models = newModels;
```

### 3.6 确保 provider 基础配置正确

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

### 3.7 写回文件

用 `JSON.stringify(json, null, 2)` 写回，保持标准 JSON 格式。

## Phase 4: Verify

```bash
# 校验 JSON 语法
jq empty ~/.pi/agent/models.json
```

验证一致性:

- endpoint model ID 集合 == `providers.tu.models[].id` 集合
- 未精调模型 == 默认模板（含 `reasoning: true` 与完整 `thinkingLevelMap`）
- `providers.tu.baseUrl` == `http://192.168.125.11:8317/v1`
- `providers.tu.apiKey` == `tutu`
- `providers.tu.api` == `openai-completions`

验证模型实际可用（pi 官方 CLI）:

```bash
pi --list-models tu
```

- 应列出全部 N 个 `tu/...` 模型，thinking 列应显示 `yes`
- pi 的 models.json 是热加载的 — 编辑后不用重启，下次打开 `/model` 即生效

## Phase 5: Report

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

新增模型 (N) — 默认模板 (thinking true + 完整 thinkingLevelMap):
  - model-a
  - model-b

升级为默认模板 (N) — 其中旧家族遗留 X, 裸 id 形态 Y:
  - model-x (原为 claude 家族默认值)
  - model-y (原为 {"id": ...})

删除模型 (N):
  - old-model-z

保留用户精调 (N):
  - model-w (reasoning false / 自定义 thinkingLevelMap / 额外参数)

备份:
  ~/.pi/agent/models.json.bak-...
```

## Error Handling

- endpoint 401/403 → 确认使用了 `Authorization: Bearer tutu`，仍失败则停止
- endpoint 超时/不可达 → 提示检查 WireGuard，不修改配置
- endpoint JSON 格式不对 → 停止并显示响应摘要
- 没有模型 ID → 停止，不写空 models
- 配置写入后 `jq empty` 失败 → 从备份恢复并报告错误
- 模型请求报 thinking 相关错误 → 端点可能不支持某级别或 `reasoning_effort`，对该模型精调 `thinkingLevelMap`（或把 provider `supportsReasoningEffort` 改回 false），保留逻辑不会覆盖
- 如果 `models.json` 不存在 → 先创建最小结构: `{"providers":{"tu":{"baseUrl":"...","api":"openai-completions","apiKey":"tutu","models":[]}}}`

## Implementation Notes

核心工具:

- `bash` + `curl`: 使用内置 key `tutu` 获取 endpoint 模型列表
- `read`: 读取 `models.json`
- `edit` 或 `write`: 更新 models.json
- `bash` + `jq`: 验证 JSON 语法
- `pi --list-models tu`: 验证模型实际可用

禁止:

- ❌ 使用 web search 查询模型参数
- ❌ 给模型写 `name`/`input`/`contextWindow`/`maxTokens`/`cost`（默认模板不含这些字段，信任 pi 默认值）
- ❌ 保留旧家族遗留参数或裸 `{"id": id}` 形态（必须升级为默认模板，thinking 全开）
- ❌ 覆盖用户精调（`reasoning: false` / 自定义 `thinkingLevelMap` / 额外字段 → 原样保留）
- ❌ endpoint 失败时修改配置
- ❌ 用 opencode 的模型对象格式（pi 格式不同）

推荐:

- ✅ endpoint 模型 ID 集合是唯一事实来源
- ✅ 默认模板统一: `reasoning: true` + 完整 `thinkingLevelMap`
- ✅ 精调检测区分"默认形态"与"用户精调"，只升级前者
- ✅ 先备份，再修改
- ✅ 报告新增、升级、删除和保留的模型
