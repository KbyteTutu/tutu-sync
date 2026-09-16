---
name: tutu-pi-update
description: "Safely synchronizes pi's tutu models using the trusted CPA parameter catalog and incremental research for uncovered models. Use when the user says 'tutu-pi-update', 'update pi models', or 'sync pi tutu models'; supports full refresh and dry-run."
compatibility: "Linux, Python 3.9+, curl; tutu intranet reachable."
---

# Tutu Pi Update

## 执行

以本 SKILL.md 所在目录为技能根目录，解析下列脚本的绝对路径。

```bash
python3 -B <技能根目录>/scripts/sync.py
```

- 用户要求 `full` / `全量`：追加 `--full`。
- 用户仅要求预览：追加 `--dry-run`；不得随后擅自执行写入。
- 直接运行脚本，不提前拉接口、不读完整配置、不临时生成 jq。
- 不运行 init.sh、安装依赖、修改脚本或调用子代理来完成一次同步。

## 处理结果

脚本只输出一份 JSON 摘要：

| status / 退出码 | 动作 |
| --- | --- |
| `updated` / 0 | 报告模型数、增删改数、CPA 覆盖数、耗时与备份路径，然后结束 |
| `unchanged` / 0 | 报告无变化、零配置/缓存写入，然后结束 |
| `dry_run` / 0 | 报告预计变化，不写模型或缓存 |
| `needs_research` / 2 | 仅处理 `research` 数组，按下一节续跑 |
| `partial` / 1 | 配置可能已发布、缓存未完成；报告警告，不宣称全部成功 |
| `error` / 1 | 报告错误并停止；不得凭猜测重写配置 |

有 warnings 必须简要报告。不要复述每个阶段。
不要再次逐条派生、运行 `jq empty` 或重复调用 `pi --list-models`。
`/model` 会重新加载配置；列表可加载不代表模型推理请求一定成功。

## 未覆盖模型的检索续跑

只有 `needs_research` 才联网检索。此时模型和缓存均未写入。

1. 对 `research[].query` 去重检索；优先官方文档，其次 OpenRouter 等来源。
2. 仅记录有证据的字段。不得凭记忆补参数，不查询 CPA 覆盖的模型。
3. 用 `mktemp -d` 创建私有临时目录，将结果写入其中的 `results.json`。
4. 键必须是 `research[].id` 原文，查询无结果则值为 `null`。

```json
{
  "route/example-model": {
    "contextWindow": 200000,
    "maxTokens": 32000,
    "reasoning": true,
    "levels": ["off", "low", "high"],
    "sources": ["https://example.com/model-documentation"]
  },
  "route/unknown-model": null
}
```

上例仅说明文件格式，不是模型参数来源。
字段均可省略；成功结果至少含一个参数和非空 `sources`。

```bash
python3 -B <技能根目录>/scripts/sync.py --results <私有临时目录>/results.json
```

保留原来的 `--full` / `--dry-run` 参数。
脚本会刷新端点和 CPA，重新判定需要使用的结果，不覆盖已出现的 CPA 数据。
若期间出现新的待查模型，继续补齐；同一模型的 `null` 结果本轮不得反复查询。
仅删除本轮创建的临时目录，不清理共享 `/tmp/tutu-pi-update.*`。

## 权威与安全边界

- `/v1/models` 决定模型 ID 集合；空列表、重复 ID、HTTP 失败时停止。
- CPA 目录成功返回的模型参数无条件信任；不校验年份、置信度或参数是否“合理”。
- 只校验 JSON 结构与 pi 所需字段类型，防止坏数据写入配置。
- CPA 缺字段时保留现值；`thinking=false` 或空级别表清除旧 thinking 映射。
- CPA `modalities` 含 `image` 时写 `input: ["text","image"]`，否则 `["text"]`；字段缺失或空数组保留现值。
- CPA `display_name` 写入 `name`；`pricing`（USD）按子字段合并写入 `cost`（保留 tiers 等未知键），非 USD 跳过并告警。
- 不再凭空启用全级别 thinking；`extra-low` 映射为 pi 的 `minimal` 键。
- CPA 不管辖的字段、其他 provider 保留。未覆盖的用户精调模型不覆盖。
- 家族最新两个版本限制只用于未覆盖模型检索；不确定家族时不裁剪。
- 查询失败保留现值；新模型仅写 id，下一次运行重试，不写猜测模板。
- 脚本使用进程锁、0600 备份、原子替换；无变化不备份、不更新时间戳。

详细规则见 [REFERENCE.md](REFERENCE.md)。开发验证：

```bash
python3 -B -m unittest discover -s <技能根目录>/tests -v
```

测试仅在修改脚本时运行，不属于日常同步步骤。
