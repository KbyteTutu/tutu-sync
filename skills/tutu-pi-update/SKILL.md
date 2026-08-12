---
name: tutu-pi-update
description: "Sync pi agent tutu provider models in ~/.pi/agent/models.json strictly from the tutu /v1/models endpoint. New models get id-only entries (pi defaults); legacy family-default parameters are auto-repaired. Uses built-in intranet key 'tutu'. Trigger: 'tutu-pi-update', 'update pi models', 'sync pi tutu models'."
---

# Tutu Pi Update

从 tutu 内网 OpenAI-compatible 模型端点同步 `~/.pi/agent/models.json` 中 `providers.tu.models`。

**核心原则: 模型列表完全按照端点更新; 模型参数完全信任 pi 内置默认值。**

- 模型 ID 集合只来自 `GET http://192.168.125.11:8317/v1/models`
- 认证 key 内置为 `tutu`
- 不使用 web search
- pi 的 models.json 为标准 JSON（无注释）
- 依据 pi 官方文档 (`docs/models.md`): 模型对象**只有 `id` 是必须的**，其余字段均有内置默认值（`name`=id、`reasoning`=false、`input`=["text"]、`contextWindow`=128000、`maxTokens`=16384、`cost` 全零）——**不猜测、不推断任何参数**
- **新模型**: 只写 `{"id": id}`，其余参数全部交给 pi 默认值
- **旧模式遗留修复**: 检测已有模型参数是否等于旧版本 skill 的家族默认值指纹，完全匹配 → 清理为 `{"id": id}`；参数被用户手动改过 → 完整保留
- **删除模型**: 端点已不存在的从数组中移除

## 固定参数 (勿改)

- 端点: `http://192.168.125.11:8317/v1/models`
- provider `tu`: `baseUrl: http://192.168.125.11:8317/v1`、`api: openai-completions`、`apiKey: tutu`、`compat.supportsDeveloperRole: false`、`compat.supportsReasoningEffort: false`

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

### 3.3 新模型: 只写 id

对于 endpoint 新增但配置中不存在的模型，**只写最小结构，不生成任何参数**:

```json
{ "id": "<endpoint-id>" }
```

禁止添加 `name`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`cost`、`thinkingLevelMap`、`compat` 等任何字段——pi 对缺省字段使用官方内置默认值（见上），猜测的数值比官方默认更危险（例如 `reasoning: true` 会给不支持 thinking 的模型发无效参数）。

### 3.4 旧模式遗留检测与修复

旧版本 skill 会给新模型生成"家族默认值"参数。对**已有模型**逐一做指纹比对，识别并清理旧模式遗留:

指纹表（旧版本 skill 的家族默认值，仅用于识别，不再用于生成）:

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

判定规则（对每个已有模型）:

- 满足 **全部** 条件 → 旧模式遗留，清理为 `{"id": id}`:
  - `name` 等于 `id`（旧模式恒为 id）
  - `cost` 为全零（旧模式恒为全零）
  - `reasoning`、`input`、`contextWindow`、`maxTokens`、`thinkingLevelMap`（缺省视为 {}）、`compat`（缺省视为 {}）与指纹表中某一行的值**完全一致**
- 任一条件不满足 → 用户手动精调过，**完整保留原对象**

```javascript
// 伪代码
const legacyFingerprints = [...table above];
const isLegacy = (m) =>
  m.name === m.id &&
  allZero(m.cost) &&
  legacyFingerprints.some(f => {
    const a = {reasoning:m.reasoning, input:m.input, contextWindow:m.contextWindow,
               maxTokens:m.maxTokens, thinkingLevelMap:m.thinkingLevelMap||{},
               compat:m.compat||{}};
    const b = {reasoning:f.reasoning, input:f.input, contextWindow:f.contextWindow,
               maxTokens:f.maxTokens, thinkingLevelMap:f.thinkingLevelMap||{},
               compat:f.compat||{}};
    return JSON.stringify(a) === JSON.stringify(b);
  });

const repaired = kept.filter(id => isLegacy(oldMap[id])).map(id => ({ id }));
const preserved = kept.filter(id => !isLegacy(oldMap[id])).map(id => oldMap[id]);
```

### 3.5 构建新模型数组

```javascript
const newModels = [
  ...repaired,                              // 旧模式遗留 → {"id": id}
  ...preserved,                             // 用户精调 → 原样保留
  ...added.map(id => ({ id })),             // 新增 → {"id": id}
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
    "supportsReasoningEffort": false
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
- 新模型与已修复模型只含 `id` 字段（或含用户精调的额外字段）
- `providers.tu.baseUrl` == `http://192.168.125.11:8317/v1`
- `providers.tu.apiKey` == `tutu`
- `providers.tu.api` == `openai-completions`

验证模型实际可用（pi 官方 CLI）:

```bash
pi --list-models tu
```

- 应列出全部 29+ 个 `tu/...` 模型
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

新增模型 (N):
  - model-a ({"id": ...}, 参数用 pi 默认)
  - model-b

旧模式遗留修复 (N):
  - model-x (原为 claude 家族默认值 → {"id": ...})
  - model-y (原为 default 默认值)

删除模型 (N):
  - old-model-z

保留用户精调 (N):
  - model-w (参数非旧模式默认, 原样保留)

备份:
  ~/.pi/agent/models.json.bak-...
```

## Error Handling

- endpoint 401/403 → 确认使用了 `Authorization: Bearer tutu`，仍失败则停止
- endpoint 超时/不可达 → 提示检查 WireGuard，不修改配置
- endpoint JSON 格式不对 → 停止并显示响应摘要
- 没有模型 ID → 停止，不写空 models
- 配置写入后 `jq empty` 失败 → 从备份恢复并报告错误
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
- ❌ 给新模型生成 `name`/`reasoning`/`input`/`contextWindow`/`maxTokens`/`cost`/`thinkingLevelMap`/`compat` 等任何参数（只写 id，信任 pi 默认值）
- ❌ 保留旧模式家族默认值参数（必须指纹检测并清理）
- ❌ 误删用户手动精调过的模型参数（指纹不匹配 → 完整保留）
- ❌ endpoint 失败时修改配置
- ❌ 用 opencode 的模型对象格式（pi 格式不同）

推荐:

- ✅ endpoint 模型 ID 集合是唯一事实来源
- ✅ 新模型最小结构 `{"id": id}`，安全第一
- ✅ 指纹检测区分"旧模式遗留"与"用户精调"，只清理前者
- ✅ 先备份，再修改
- ✅ 报告新增、修复、删除和保留的模型
