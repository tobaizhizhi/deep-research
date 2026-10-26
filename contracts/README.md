# Web / Worker v1 数据契约

JSON Schema 是公开传输规范。`web/lib/contracts.ts` 用 Zod 校验，`mini_deep_research/contracts.py` 用 Pydantic 校验。两端测试读取同一份 `fixtures.json`；Web 测试还用 Ajv 验证公开 schema，避免只验证两个实现恰好写得相同。

| Schema | 用途 | 当前接入位置 |
| --- | --- | --- |
| create-research.v1.schema.json | 规范化后的研究输入 | 浏览器需求预览与服务端创建接口 |
| research-config.v1.schema.json | 服务端生成的预算/模型配置快照 | `buildResearchConfig()` 构建并入库，P3 消费 |
| research-job.v1.schema.json | 队列里的任务执行指令 | 已写入 PostgreSQL outbox，P3 再发布和消费 |

创建输入先做规范化，再用公开 schema 验证：question 必填，requirements 省略时为空字符串，language 默认为 auto，depth 默认为 standard。补查任务可以额外绑定 `parent_report_id` 和 `review_id`，两者必须同时提供并由服务端验证。只去除首尾 ASCII 空白（空格、tab、换行、回车、form feed、vertical tab）；不改动其他 Unicode 字符。JSON Schema 不执行 trim 或填默认值，因此原始 `{ "question": " 问题 " }` 先经过 TS/Python 变成完整对象，才能直接按公开 schema 验证。所有层均拒绝额外字段。

长度按 Unicode 码点计算；question 1–4000，requirements 0–2000。配置只接受有限范围的整数值，不强制必须来自 JSON 的整数字面量：`2.0` 与 `2` 同义，`"2"`、`true`、`2.5` 不可用作整数。快照没有默认补值，所有字段必填；只支持 schema_version=1、graph_mode=fixed。不存 API key、任意 base_url 或 OAuth token。

创建文本不接受 PostgreSQL text 无法保存的 NUL（U+0000）字符；TS、Python 和公开 schema 均验证这个规则。HTTP 创建入口额外限制原始 JSON 请求体为 64 KiB，这是传输上限，与规范化后的字符数限制分别生效。

标识使用带连字符的 UUID（版本 1–8，标准 variant）。消息时间使用有效 UTC 日期，格式为 `YYYY-MM-DDTHH:mm:ssZ` 或最多 6 位小数秒，年份 0001–9999；不接受本地时间、偏移写法或闰秒。字段字符串不隐式转换为数字、日期对象或 UUID 对象，序列化形状保持稳定。

后续 Redis Streams 约定：stream 为 `research:jobs:v1`，consumer group 为 `research-workers-v1`，每条记录只有一个名为 `payload` 的 UTF-8 JSON 字符串字段，其内容符合 research-job schema。`message_id` 对应 outbox ID；`task_id` 和 `attempt_id` 用于到 PostgreSQL 读取快照，不把全部网页材料塞进队列。

事件序号在 PostgreSQL 用 bigint，任务详情的 last_event_seq / min_event_seq 已使用十进制字符串；不要使用 `Number(seq)`。队列消息 v1 目前没有事件序号字段，SSE 接口将在 P5 接入。

修改协议时同时更新公开 schema、两种语言实现、共享样例及测试。破坏兼容性的变更提升 schema_version，并在接收端明确拒绝不支持的版本。
