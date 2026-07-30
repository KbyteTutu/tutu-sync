---
name: tutu-pi-update
description: "Sync pi agent tutu provider models in ~/.pi/agent/models.json from the tutu /v1/models endpoint. Uses built-in intranet key 'tutu'. Trigger: 'tutu-pi-update', 'update pi models', 'sync pi tutu models'."
---

# Tutu Pi Update

从 tutu 内网 OpenAI-compatible 模型端点同步 `~/.pi/agent/models.json` 中 `providers.tu.models`。

**原则: 模型列表完全按照端点更新。**

- 模型 ID 集合只来自 `GET http://192.168.125.11:8317/v1/models`
- 认证 key 内置为 `tutu`
- 不使用 web search
- pi 的 models.json 为标准 JSON（无注释）
- pi 模型配置需要 `contextWindow`、`maxTokens` 等字段，端点当前不提供这些，因此：
  - **保留已有模型**: 保留其现有参数不变
  - **新增模型**: 使用安全默认值
  - **删除模型**: 从数组中移除

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

解析 `models.json`，取出 `providers.tu.models` 数组。记录现有模型 ID → 参数映射。

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

### 3.3 为新模型生成默认配置

对于 endpoint 新增但配置中不存在的模型，使用以下默认值:

```json
{
  "id": "<endpoint-id>",
  "name": "<endpoint-id>",
  "reasoning": true,
  "input": ["text"],
  "contextWindow": 200000,
  "maxTokens": 32000,
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
}
```

特殊模型族的增强默认值 — 按 ID 前缀/关键字匹配:

| 模型族 | 特征 | input | contextWindow | maxTokens | reasoning | thinkingLevelMap |
|--------|------|-------|---------------|-----------|-----------|-----------------|
| Claude 系列 | id 含 `claude` | `["text","image"]` | 200000 | 64000 | true | `{"xhigh":"max"}` |
| Gemini 系列 | id 含 `gemini` | `["text","image"]` | 1048576 | 65536 | true | `{"off":null}` |
| GPT 系列 | id 含 `gpt` | `["text","image"]` | 272000 | 128000 | true | `{"xhigh":"xhigh","minimal":"low"}` |
| DeepSeek 系列 | id 含 `deepseek` | `["text"]` | 1000000 | 384000 | true | `{"minimal":null,"low":null,"medium":null,"high":"high","xhigh":"max"}` |
| GLM 系列 | id 含 `glm` | `["text"]` | 131072 | 16384 | true | - |
| Kimi 系列 | id 含 `kimi` | `["text"]` | 131072 | 16384 | true | - |
| Qwen 系列 | id 含 `qwen` | `["text"]` | 131072 | 16384 | true | - |
| MiniMax 系列 | id 含 `minimax` | `["text"]` | 131072 | 16384 | true | - |
| 图片模型 | id 含 `image` | `["text","image"]` | 32768 | 8192 | false | - |
| 其他 (default) | - | `["text"]` | 200000 | 32000 | true | - |

添加 `compat.supportsReasoningEffort` 给 GPT 系列模型:

```json
"compat": { "supportsReasoningEffort": true }
```

添加 `compat.thinkingFormat` 和 `compat.requiresReasoningContentOnAssistantMessages` 给 DeepSeek 系列:

```json
"compat": {
  "thinkingFormat": "deepseek",
  "requiresReasoningContentOnAssistantMessages": true
}
```

### 3.4 构建新模型数组

```javascript
const newModels = endpointIds.map(id => {
  if (oldMap[id]) return oldMap[id];           // 保留已有模型参数不变
  return buildDefaultModel(id);                // 新模型使用默认值
});
json.providers.tu.models = newModels;
```

### 3.5 确保 provider 基础配置正确

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

### 3.6 写回文件

用 `JSON.stringify(json, null, 2)` 写回，保持标准 JSON 格式。

## Phase 4: Verify

```bash
# 校验 JSON 语法
jq empty ~/.pi/agent/models.json
```

验证一致性:

- endpoint model ID 集合 == `providers.tu.models[].id` 集合
- 所有模型都有 `id`、`name`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`cost`
- `providers.tu.baseUrl` == `http://192.168.125.11:8317/v1`
- `providers.tu.apiKey` == `tutu`
- `providers.tu.api` == `openai-completions`

pi 的 models.json 是热加载的 — 编辑后不用重启，下次打开 `/model` 即生效。

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
Endpoint 模型数: 48

新增模型 (N):
  - model-a (使用 defaults/gpt/claude/...)
  - model-b (使用 defaults)

删除模型 (N):
  - old-model-x

保留模型 (N):
  - 参数未变，沿用现有配置

备份:
  ~/.pi/agent/models.json.bak-...
```

对每个新增模型标注使用了哪个默认值模板。

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

禁止:

- ❌ 使用 web search 查询模型参数
- ❌ 手动删除用户精心配置的模型参数（保留已有模型配置）
- ❌ endpoint 失败时修改配置
- ❌ 用 opencode 的模型对象格式（pi 格式不同）

推荐:

- ✅ endpoint 模型 ID 集合是唯一事实来源
- ✅ 新增模型使用保守默认值，安全第一
- ✅ 保留已有模型的所有参数
- ✅ 先备份，再修改
- ✅ 报告新增、删除和保留的模型
