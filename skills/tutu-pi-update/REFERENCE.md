# 执行器约定

## 文件与依赖

- 正式源码：本项目 `skills/tutu-pi-update/`。
- 安装目录：`~/.pi/agent/skills/tutu-pi-update/`。`init.sh` 已递归复制脚本与测试，不需要修改。
- 运行依赖：Linux、Python 3.9+ 标准库、curl；不引入 pip/npm 依赖。
- 模型文件：`~/.pi/agent/models.json`。
- 缓存文件：`~/.pi/agent/tutu-pi-update.cache.json`。
- 锁文件：`~/.pi/agent/tutu-pi-update.lock`。使用 flock，退出时释放锁，不删除锁 inode。
- dry-run 不写模型、缓存或备份，但创建/打开锁文件。

## 请求与数据来源

每次运行先请求 CPA，再请求模型列表。每个地址最多请求一次，不自动重试：

- `http://192.168.125.11:8317/v0/resource/plugins/tutu-cpa-plugin/models.json`，无需鉴权。
- `http://192.168.125.11:8317/v1/models`，使用固定内网 key `tutu`。

curl 禁用代理与跳转，仅允许 HTTP，连接超时 3 秒，总超时 8 秒；父进程再设 10 秒上限。响应上限 8 MiB。临时响应保存在随机的 0700 目录中，自动清理。失败时不输出响应正文或凭据。

端点必须是 HTTP 200，包含非空 `data` 数组和唯一字符串 id。ID 区分大小写，原样用于同步。查询归一化只影响搜索词。

CPA 不可达、非 JSON、顶层结构不符或 `models` 为空时，视为目录不可用：记录 `catalog_unavailable` 告警（`degraded: true`），全部模型走缓存基线路径，报告不得宣称目录已核对。目录重复 ID 不猜测先后，同样视为不可用。

CPA 已匹配条目中若参数类型错误，停止，不拿网络搜索或旧模板替代。这只是接口形状约束，不质疑 CPA 参数事实。不使用 `match.confidence`、年份或其他来源否定有效参数。

## 参数映射

| CPA | pi | 行为 |
| --- | --- | --- |
| `context_window` | `contextWindow` | 正整数原值，不自行设上限 |
| `max_output_tokens` | `maxTokens` | 正整数原值，不与 context 再作经验校正 |
| `thinking.supported` | `reasoning` | 布尔值原样采用；缺失不假设 false |
| `thinking.levels` | `thinkingLevelMap` | 非空时列出全部 pi 键，未支持键置 null |
| `extra-low` 级别 | `minimal: extra-low` | 当目录没有 minimal 时映射；发送的值仍是目录原值 |
| 空/缺失 levels，supported=true | 删除旧 `thinkingLevelMap` | 交给 pi 默认行为，不宣称支持全部等级 |
| supported=false | 删除旧 `thinkingLevelMap` | 不残留已失效映射 |
| `modalities` | `input` | 含 `image` → `["text","image"]`；否则 `["text"]`；缺失或空数组保留现值 |
| `display_name` | `name` | 非空字符串原值；缺失保留现值 |
| `pricing.*_per_mtok`（USD） | `cost` | 四个子字段按存在合并（input/output/cacheRead/cacheWrite），保留 `tiers` 等未知键；非 USD 跳过并告警；浮点尾数按 10 位小数归一（0.1999999999999998 → 0.2） |

整个 thinking 或 token 参数缺失/null，不抹掉已有参数。显式空 levels 会清除旧 map。不可映射级别报告 warning。pi 的省略映射仍有默认行为；“没有 map”不代表已验证所有能力。

CPA 只管理上述七个模型字段；`samplingParams`、`headers` 等原值保留，不从目录新增其他字段。pi 的 `input` 只接受 `["text"]` 或 `["text","image"]`；`file`、`audio` 等模态由 agent 自行处理，不写入 pi 配置，也不告警。上游撤回 image 支持（modalities 仍返回但不含 image）会写回 `["text"]`；字段整体缺失属无信息，保留现值。provider 固定 baseUrl/api/apiKey 与两个 compat 开关；其他 provider 配置不动。

## 未覆盖模型

- 缓存 model 与现条目相同且无需重试：跳过；full 会重新查询。
- 条目与缓存不同，或含额外字段：保留用户修改，即使 full 也不覆盖。
- 无缓存但已有标准参数：采用为基线，不误判为需要覆盖的旧格式。
- 裸 id、新模型、失败重试：产生检索任务。
- 每家族只检索端点中最新两个不同版本，包括变体；不确定版本则不裁剪。
- 更老版本保留现值，新条目仅写 id；缓存记录无需重试。
- 检索成功只应用有来源的字段。失败结果 null 保留现值并标记下次重试。

`needs_research` 不做部分发布。agent 提交按 id 索引的结果文件后重跑；脚本重新获取事实，不持久化可能含凭据的执行计划。

## 发布与恢复

采用成熟的“同目录临时文件 → flush/fsync → rename/replace → 目录 fsync”模式，而不是 shell 重定向截断目标文件。

1. 全部输入只解析一次，派生一次，两个输出先在内存序列化。
2. 无变化直接返回；不会只为了 `syncedAt` 改写缓存。
3. 发布前重新读取两份文件，只用于检测外部编辑，不是重新做业务验证。
4. 只有模型内容变更才保存原始字节备份；备份和新文件权限为 0600。
5. 先发布 models.json，再发布缓存；缓存失败返回 partial，明确 models 是否已发布。

两个文件各自原子发布，**不是跨文件事务**。进程锁只约束本执行器；未遵守锁的外部程序仍有最后一次检查后的竞争窗口。不要宣称已完全消除并发写入风险。

目标文件禁止符号链接、硬链接、非当前用户文件。损坏的模型配置停止；损坏的缓存可重建。缓存不是模型权威，CPA 正常时可从现值和 CPA 修复。

## 报告字段（证据化）

- `catalog`: `{state: ok|unavailable, models, generated_at}`——本轮目录核对状态与新鲜度。
- `digest`: `{endpoint, current, derived}`——canonical JSON（sort_keys）的 sha256 前 16 位。`current` 为磁盘原始条目，`derived` 为本轮派生条目；二者相等即内容一致。`unchanged` 断言必须由 digest 相等支撑，数量相同不构成一致证据。
- `degraded`: 任一 `catalog_*` 告警时为 true——结论基于缓存基线，未经目录核对，报告必须明示并建议重跑。

## 验证放在哪里

日常运行保留：HTTP/JSON 边界、唯一 ID、目标字段类型、进程锁、写前外部编辑检测、文件系统错误处理。

开发时测试：幂等、参数映射、增删、字段保留、检索续跑、并发锁、失败注入、真实端点 dry-run。

删除：运行后再跑派生算法证明自身、反复 `jq empty`、重复拉端点、靠 pi 表格模糊匹配计数、把列表加载当成模型请求成功。
