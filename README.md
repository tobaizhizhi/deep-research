# Mini Deep Research

参考 Open Deep Research 逐步实现的学习项目。使用 DeepSeek、Tavily 和 LangGraph，完成拆题、研究、证据汇总、总体评审、报告生成、引用检查和本地评测，并通过 Next.js、PostgreSQL 和 Redis Streams 提供长任务服务。

**本目录是实际项目根目录。** Python 研究引擎与 React / Next.js Web 工程统一放在这里；上一级 `study_deep_research/` 用于学习指南和原版参考，不放本项目的应用代码。

## 当前目录

```text
Simplified_version/
├── README.md                 # 项目总入口与运行说明
├── deep_research.py          # 演示入口，保留之前的运行方式
├── evaluate.py               # 评测题读取、基础检查、裁判和批量入口
├── questions.jsonl           # 固定评测题与人工参考要点
├── mini_deep_research/
│   ├── __init__.py
│   ├── config.py             # Settings、环境变量、模型客户端、项目路径
│   ├── models.py             # Pydantic 数据结构和 TypedDict 状态
│   ├── contracts.py          # Web / Worker 传输协议，与图状态分开
│   ├── search.py             # Tavily 搜索、查询清理和去重
│   ├── graph.py              # 节点、证据处理、条件路由和两层图
│   ├── service.py            # 冻结任务配置 ↔ 图输入 / 结果序列化
│   ├── storage.py            # 领取、租约、报告归档和终态事务
│   ├── checkpointing.py      # P7 PostgreSQL 图检查点与租约保护
│   ├── worker.py             # Outbox、Redis 消费、心跳和退出
│   └── log_utils.py          # 日志初始化、节点计时、异常链
├── compose.yaml             # 本机 PostgreSQL / Redis，独立端口和持久卷
├── Dockerfile               # P6 Python Worker 生产镜像
├── deploy/                  # P6 生产 Compose、Caddy、备份/恢复脚本
├── db/migrations/           # 唯一的 SQL 迁移来源
├── contracts/               # JSON Schema 与跨语言样例
├── web/                     # React + Next.js（P1、P2 已实现）
│   ├── app/                 # 页面、公共布局、健康接口
│   ├── components/          # 表单、导航、图标
│   ├── lib/                 # 共享输入契约与 server-only 数据/认证逻辑
│   ├── scripts/             # 迁移入口和执行器
│   ├── tests/               # 契约、安全与真实数据库测试
│   ├── README.md            # Web 启动方式与逐文件讲解
│   ├── package.json         # Node 依赖与命令
│   └── pnpm-lock.yaml       # Web 依赖锁文件
├── tests/
│   ├── test_deep_research.py # 原有配置、子图和引用测试
│   ├── test_compression.py  # 研究简报、回退、预算与配置测试
│   ├── test_evaluate.py      # 跨模块流程、异常和输出路径测试
│   └── test_contracts.py     # 与 Web 共用的传输样例
├── outputs/                 # 历史与新生成的评测 JSONL、research.log
├── .env                     # 本机配置
├── .env.example
├── .gitignore
├── pyproject.toml
└── uv.lock
```

`graph.py` 中把紧密相关的节点和图组装保留在一起，便于顺着流程学习；不按每个节点再拆一份文件。`evaluate.py` 也暂时保留为一个完整的评测入口。

Python 在项目根目录使用 uv，Web 在 `web/` 内使用 pnpm，两者分别维护依赖。数据库迁移、协议和 Compose 放在本项目根目录，两端共同使用。

## 如何运行

### Web 页面

```bash
cd /home/lenovo/ai/study_deep_research/Simplified_version
docker compose up -d --wait
cd web
pnpm install --frozen-lockfile
pnpm db:migrate
cd ..
uv run python -m mini_deep_research.checkpointing
cd web
pnpm dev
```

首次安装先按 [web/README.md](web/README.md) 配置 `web/.env.local`；本工作目录已有本机配置。打开 <http://localhost:3000>，GitHub 登录后可以预览确认需求、提交任务、查看记录、筛选翻页、取消排队、阅读报告、展开证据和下载 Markdown。启动下述 Worker 后会执行研究并在 PostgreSQL 归档报告和证据。

### P3 后台研究服务

在另一个终端运行：

```bash
cd /home/lenovo/ai/study_deep_research/Simplified_version
uv sync --locked
uv run python -m mini_deep_research.worker
```

Worker 使用根目录 `.env` 中的真实模型和 Tavily 凭证；连接地址可复用 `web/.env.local`，也可通过 `DATABASE_URL`、`REDIS_URL` 显式设置。本机 PostgreSQL 改为 `127.0.0.1:55433`，Redis 为 `127.0.0.1:56379`。Web 和 Worker 要连接同一个数据库。

执行路径：`Web createTask → task_outbox → relay → Redis Streams → claim_attempt → service.run_research_task → research_graph → finish_success → XACK`。

- 任务的模型、语言、补充要求、轮数、并发、结果条数和 B 开关使用冻结快照；不会临时修改环境变量来切换任务配置。
- 报告、各 Researcher 的完整证据、简报、缺口、引用警告和终态事件在同一事务保存。只有成功归档才能是 succeeded；research_done 可以为 false。
- 消费重复通知不重复运行研究。归档提交响应未知时回查终态，数据库不可用时不 ACK。过期租约不能续活，也不能提交旧结果。
- Ctrl+C / SIGTERM 尽力记录 WORKER_SHUTDOWN；强制退出的租约过期后记录 WORKER_LOST。失败任务可以选择“从中断处接续”或“重新研究”：接续沿用兼容的图运行与已有检查点，重跑创建新的图运行并从头执行。两者都创建新 attempt、保留旧记录，并要求幂等键。
- P7 使用 PostgreSQL 保存父子图检查点，并登记稳定子任务；父节点重放时复用已完成的子任务。最多接续 3 次，累计执行时长不能超过冻结任务预算，且代码、提示词和状态版本必须兼容。图运行的 PostgreSQL 会话锁和检查点写入事务共同隔离旧 Worker。中断节点内已经发出的模型或搜索请求仍可能重放。
- P4 已接入报告/证据读取、下载和任务详情自动轮询；P5 已接入节点级实时事件、SSE 断线补读和运行中取消；P6 已接入失败重跑、Redis/数据库对账、Worker 预算参数和生产部署材料。

生产部署、迁移、SSE 代理和备份恢复见 [`deploy/`](deploy/) 与父目录 [P6 实施文档](../PROJECT_IMPLEMENTATION_GUIDE.md#9-p6-重跑故障治理与部署)。生产迁移必须单独执行：

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml up -d postgres redis
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml --profile migration run --rm migrate
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml --profile migration run --rm checkpoint_migrate
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml up -d web worker proxy
```

Worker 集成测试必须显式指定依赖地址；仅创建/清理随机测试 schema 和 Redis stream，不调用真实模型和搜索：

```bash
TEST_DATABASE_URL=postgresql://deep_research:local_development_only@127.0.0.1:55433/deep_research \
TEST_REDIS_URL=redis://127.0.0.1:56379/0 \
uv run pytest -q tests/test_worker_integration.py
```

### Python 研究引擎

在 `Simplified_version/` 下执行：

```bash
cd /home/lenovo/ai/study_deep_research/Simplified_version
uv sync
uv run python deep_research.py
uv run pytest -q
```

上面的启动检查和测试不调用真实模型或搜索 API。模型和搜索配置沿用现有 `.env`，当前代码读取 `OPENAI_API_KEY`、`OPENAI_API_BASE_URL`、`MODEL_NAME`、`TAVILY_API_KEY`、`MAX_SEARCH_ROUNDS`、`MAX_RESULTS_PER_QUERY`、`MAX_CONCURRENT_RESEARCHERS` 和 `ENABLE_RESEARCH_COMPRESSION`。

运行真实研究：

```bash
uv run python -c "import asyncio; from deep_research import demo_research; asyncio.run(demo_research())"
```

运行评测：

```bash
uv run python evaluate.py --limit 1
uv run python evaluate.py --judge --limit 1
```

第二条会额外调用裁判模型。研究与评测日志写入 `outputs/research.log`，评测结果写入 `outputs/eval_results_时间戳.jsonl`。目录在首次实际运行时创建；历史结果已原样归档到这里。

`.env` 和输出目录根据项目位置定位，不会因调用者切换工作目录而跑到包目录内。`.gitignore` 忽略环境文件和缓存；它不会自动取消 Git 已经跟踪的文件。

## 阶段 B：可选研究简报

设置 `ENABLE_RESEARCH_COMPRESSION=true` 后，每个有发现的 Researcher 在结束时额外调用一次模型，整理关键发现、条件限制和来源冲突。每条简报内容关联原始发现编号，程序补充来源；原始缺口、停止原因和充分性判断另行附上。

开启后 Supervisor 默认使用通过校验的简报，不按“是否更短”选择。请求或验证失败时记录原因，回退完整发现。整理请求和总体评审有明确的字符预算，不静默截断；总体评审超限会明确报错。默认关闭，单次开启可运行：

```bash
ENABLE_RESEARCH_COMPRESSION=true uv run python evaluate.py --limit 1
```

演示也读取同一开关，会显示简报和材料统计。Writer 继续读完整结构化发现，引用检查与裁判继续使用原始依据。评测成功返回后，JSONL 保存每个任务的发现、搜索返回内容、简报、局部编号、回退原因和每轮 `compression_metrics`。普通演示不自动保存完整证据；研究中途失败也没有自动保存完整中间状态。

简报编号校验不能证明文字完全忠于原文；输入变短也不保证总费用下降，因为增加了整理调用。真实质量和收益需实际评测。具体实现与原版对应位置见父目录 [UPGRADE_IMPLEMENTATION_GUIDE.md](../UPGRADE_IMPLEMENTATION_GUIDE.md) 第 4 节。

## 旧代码现在在哪里

| 原来的类或函数 | 新位置 |
|---|---|
| `Settings`、`load_settings()`、`create_model()` | `mini_deep_research/config.py` |
| `Finding`、`SearchResult`、`ResearchState`、`SupervisorState` 等 | `mini_deep_research/models.py` |
| `search_web()`、`select_new_queries()` | `mini_deep_research/search.py` |
| `setup_logging()`、`observed_node()`、`error_info()` | `mini_deep_research/log_utils.py` |
| `create_plan()`、`search()`、`extract_findings()`、`review_research()` | `mini_deep_research/graph.py` |
| Supervisor 节点、Writer、引用检查、图编译 | `mini_deep_research/graph.py` |
| `demo_state()`、`demo_search()`、`demo_research()`、`main()` | 根目录 `deep_research.py` |
| `evaluate_one()`、`judge_report()` 和评测入口 | 根目录 `evaluate.py` |

根目录的 `deep_research.py` 重新导出了旧的公开类和函数，所以之前的 `from deep_research import demo_research` 等学习命令仍可使用。新增代码建议直接从职责对应的模块导入：

```python
from mini_deep_research.models import Finding, ResearchState
from mini_deep_research.graph import research_graph
from mini_deep_research.search import search_web
```

测试需要在函数实际查找依赖的位置替换模型和搜索调用。例如，图节点位于 `graph.py`，测试应 patch `mini_deep_research.graph.create_model`，而不是根入口重新导出的同名变量。模型和状态只在 `models.py` 定义一次。

## 阅读顺序与验证范围

先读 `models.py`，再读 `search.py`；随后在 `graph.py` 中阅读 Researcher 的计划、搜索、提取、评审和整理节点、Supervisor 的三个节点，最后看文件底部的图组装。配置和日志工具按需要查看。

```text
supervisor_plan → run_researchers → supervisor_review
                         ↑                 │
                         └── 需要补查 ─────┤
                                           └→ write_report → validate_citations

每个 Researcher：create_plan → search → extract_findings → review_research
                                  ↑                              │
                                  └──────── 继续搜索 ─────────────┤
                                                                └→ compress_research → END
```

原有研究流程和轮数语义保持不变：`done` 表示程序接受了证据充分的判断；`should_stop` 表示停止继续研究。链接检查通过不等于事实正确，裁判评分也不等于官方 Deep Research Bench 分数。

测试使用真实研究图并替换外部调用，覆盖成功、关闭/开启裁判、预算停止、搜索异常、研究与裁判超时等路径。它们验证程序行为，真实服务的可用性和报告质量仍需要实际评测。

父目录的 [IMPLEMENTATION_GUIDE.md](../IMPLEMENTATION_GUIDE.md) 保留了逐阶段学习过程；里面的单文件示例可以按上表定位到现在的模块。

完整产品的后续建设方案见 [PROJECT_GUIDE.md](../PROJECT_GUIDE.md)：React 页面与 Next.js API 放在本项目内的 `web/` 工程，Python Worker 复用本目录的研究引擎，通过 PostgreSQL 和 Redis Streams 管理长任务。目前 P1–P7 已实现；下一阶段为 P8 人工复核与质量闭环。

具体开发步骤见 [PROJECT_IMPLEMENTATION_GUIDE.md](../PROJECT_IMPLEMENTATION_GUIDE.md)：从 P0 基线检查到 P8 人工复核，逐步说明文件改动、任务接入、鉴权、验证和交付条件。
