---
name: tutu-ai-update
description: "Update tutu provider models in opencode.jsonc strictly from the tutu /v1/models endpoint. Uses built-in temporary intranet API key 'tutu'. Trigger: 'tutu-ai-update', 'update tutu models', 'refresh tutu provider', 'sync tutu models'."
---

# Tutu AI Update

从 tutu 内网 OpenAI-compatible 模型端点同步 `~/.config/opencode/opencode.jsonc` 中 `provider.tutu.models`。

**核心原则: 完全按照端点更新。**

- 模型全集只来自 `GET http://192.168.125.1:8317/v1/models`
- 认证 key 内置为 `tutu`
- 不使用 web search
- 不猜测、不推断、不补全端点没有返回的能力参数
- 端点当前返回字段为 OpenAI-compatible model object: `id`, `object`, `created`, `owned_by`

## Phase 0: Preconditions

检查必要条件:

- `~/.config/opencode/opencode.jsonc` 存在
- `provider.tutu` 已配置，或需要创建/修正
- WireGuard / 内网环境可访问 `http://192.168.125.1:8317/v1/models`
- 临时 API key 固定使用 `tutu`

## Phase 1: Fetch Endpoint Models

必须使用内置 API key 调用模型端点:

```bash
curl -sS \
  -H 'Authorization: Bearer tutu' \
  -H 'Content-Type: application/json' \
  'http://192.168.125.1:8317/v1/models'
```

验收要求:

- HTTP status 必须是 `200`
- 响应必须是 JSON
- 响应必须包含数组字段 `.data`
- `.data[]` 中必须有非空字符串 `id`

推荐保存响应方便审计:

```bash
curl -sS \
  -H 'Authorization: Bearer tutu' \
  -H 'Content-Type: application/json' \
  'http://192.168.125.1:8317/v1/models' \
  -o /tmp/tutu-models-endpoint.json

jq -r '.data[].id' /tmp/tutu-models-endpoint.json
```

如端点不可访问或返回非 200，立即停止，不修改任何配置。

## Phase 2: List All Available Models

从 endpoint 响应中提取并展示全部可用模型，方便用户查看:

```bash
jq -r '.data[].id' /tmp/tutu-models-endpoint.json | sort
```

分 provider 统计:

```bash
jq -r '.data[].id' /tmp/tutu-models-endpoint.json | sort | while read id; do
  prefix="$(echo "$id" | cut -d/ -f1)"
  echo "$prefix"
done | sort | uniq -c | sort -rn
```

以分组格式列出所有模型:

```bash
jq -r '[.data[] | {id, owned_by}] | group_by(.owned_by) | .[] | "\n## " + .[0].owned_by + " (" + (length|tostring) + ")\n" + (map("  - " + .id) | join("\n"))' /tmp/tutu-models-endpoint.json
```

输出示例:

```text
## 小方codex (12)
  - bytecat/claude-opus-4-6
  - bytecat/claude-opus-4-7
  - bytecat/gpt-5.5
  ...

## opencode-go (8)
  - go/glm-5
  - go/glm-latest
  ...
```

此步骤为纯展示，不影响后续同步逻辑。总模型数、分组数和每个分组的模型列表都应清晰输出。

## Phase 3: Endpoint-to-opencode Mapping

严格将端点返回的每个模型对象映射为 opencode model 配置。

当前端点返回示例:

```json
{
  "created": 1782571440,
  "id": "bytecat/gpt-5.5",
  "object": "model",
  "owned_by": "小方codex"
}
```

映射规则:

```json
{
  "id": "<endpoint.data[].id>",
  "name": "<endpoint.data[].id>"
}
```

只写入端点明确提供、且 opencode model 配置支持的字段:

- `id`: 来自 `endpoint.data[].id`
- `name`: 来自 `endpoint.data[].id`

不要写入以下字段，除非端点未来明确返回等价字段:

- `reasoning`
- `attachment`
- `tool_call`
- `limit.context`
- `limit.output`
- `modalities`

原因: 这些参数当前 `/v1/models` 没有返回。为了“完全按照端点更新”，不得使用旧配置、默认值、模型名推断或外部搜索结果填充。

如果端点未来新增字段，可按以下原则扩展:

- 只使用端点响应中真实存在的字段
- 字段语义必须明确
- 不确定时不要写入
- 报告中说明新增采用了哪些 endpoint fields

## Phase 4: Update opencode.jsonc

目标文件:

```text
~/.config/opencode/opencode.jsonc
```

必须更新:

```json
provider.tutu.options.baseURL = "http://192.168.125.1:8317/v1"
provider.tutu.options.apiKey = "tutu"
provider.tutu.models = <endpoint mapped models>
```

更新策略:

- **删除**配置中存在但 endpoint 没有返回的模型
- **新增**endpoint 返回但配置中不存在的模型
- **重写**所有保留模型为 endpoint-only 结构 `{ "id": id, "name": id }`
- **不要保留**旧模型上的 guessed/inferred 字段，例如 `limit`, `modalities`, `reasoning`, `attachment`, `tool_call`

必须先备份:

```bash
cp ~/.config/opencode/opencode.jsonc \
  ~/.config/opencode/opencode.jsonc.bak-$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)
```

推荐实现方式:

1. 用 `read` 读取 `opencode.jsonc`
2. 用 `edit` 精确替换 `provider.tutu.models` 对象和必要的 `options.apiKey`
3. 保留文件中其他 provider、agent、格式和注释

如果使用脚本处理 JSONC，必须确保不会丢失无关配置。不要无脑覆盖整个文件。

## Phase 5: oh-my-openagent.json Sync

**MUST DO**: 删除不可用模型后，必须检查 `~/.config/opencode/oh-my-openagent.json` 是否引用了被删除模型。

步骤:

1. 记录 deleted model IDs
2. 搜索 `~/.config/opencode/oh-my-openagent.json` 中这些 ID 的引用
3. 若存在引用，询问用户选择替代模型
4. 只替换被删除模型的引用，不改其他内容

询问格式:

```text
以下 agent/category 引用了 endpoint 已不存在的模型:
  - librarian → ganti/gemini-3-flash-agent
  - visual-engineering → ganti/gemini-pro-agent

请选择替代模型: [列出 endpoint 当前可用模型]
```

## Phase 6: Verify

验证配置语法:

```bash
jq empty ~/.config/opencode/opencode.jsonc
```

如 `jq` 因 JSONC 注释失败，则使用项目中已有 JSONC 校验方式，或用 Node/JSONC parser 校验。

再次检查 endpoint 和配置一致性:

- endpoint model ID 集合 == `provider.tutu.models` key 集合
- 每个模型对象只有 endpoint-only 字段: `id`, `name`
- `provider.tutu.options.apiKey == "tutu"`
- `provider.tutu.options.baseURL == "http://192.168.125.1:8317/v1"`

## Phase 7: Report

输出摘要:

```text
✓ tutu-ai-update 完成

Endpoint:
  http://192.168.125.1:8317/v1/models
API key:
  tutu
Endpoint 模型数: 48

新增模型 (N):
  - ...
删除模型 (N):
  - ...
重写为 endpoint-only 结构 (N):
  - 所有保留模型仅包含 id/name

备份:
  ~/.config/opencode/opencode.jsonc.bak-...

oh-my-openagent.json:
  - 无失效引用 / 已替换 X 处 / 等待用户选择替代模型
```

## Error Handling

- endpoint 401/403 → 确认使用了 `Authorization: Bearer tutu`，仍失败则停止
- endpoint 超时/不可达 → 提示检查 WireGuard，不修改配置
- endpoint JSON 格式不对 → 停止并显示响应摘要
- 没有模型 ID → 停止，不写空 models
- 配置写入后校验失败 → 从备份恢复并报告错误

## Implementation Notes

核心工具:

- `bash` + `curl`: 使用内置 key `tutu` 获取 endpoint 模型列表
- `read`: 读取配置文件
- `edit`: 精确替换 tutu provider 的相关块
- `bash` + `jq` 或 JSONC parser: 验证结果

禁止:

- ❌ 使用 web search 查询模型参数
- ❌ 根据模型名推断 context/output/capabilities/modalities
- ❌ 保留旧模型中的 inferred 字段
- ❌ endpoint 失败时修改配置
- ❌ 直接覆盖整个配置导致其他设置丢失

推荐:

- ✅ endpoint 是唯一事实来源
- ✅ 内置 API key 固定为 `tutu`
- ✅ 先备份，再精确修改
- ✅ 报告新增、删除和被重写的模型
