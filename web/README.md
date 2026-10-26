# 寻据 · Deep Research Web

React 编写页面，Next.js App Router 提供页面路由和 API。当前完成 P1–P7：登录、任务、后台执行、报告、实时进度、失败重跑，以及父子图检查点与可控接续。

GitHub 真实授权需要站点自己的 OAuth 配置。首页预览后可以确认提交，任务会保存为 queued，并写入 PostgreSQL outbox；启动 Python Worker 后会投递并执行研究图。

## 1. 本机启动

需要 Docker 已运行，并在 WSL 中可执行 `docker version`。项目使用自己的两个容器，不需要另外启动宿主机上的 PostgreSQL / Redis。

```bash
cd /home/lenovo/ai/study_deep_research/Simplified_version
docker compose up -d --wait
docker compose ps
cd web
pnpm install --frozen-lockfile
```

首次在另一台机器安装时，将 [.env.example](.env.example) 复制为 `.env.local`。本次工作目录已经生成这个文件及随机 `AUTH_SECRET`，不必覆盖。Web 不读取 Python 根目录的 `.env`，也不需要模型或 Tavily 密钥。

```bash
pnpm db:migrate
cd ..
uv run python -m mini_deep_research.checkpointing
cd web
pnpm dev
```

打开 <http://localhost:3000>。请使用与 `APP_ORIGIN` 完全一致的地址；`127.0.0.1` 与 `localhost` 在浏览器中是不同站点。终端按 Ctrl+C 停止 Web。

| 服务       | 本机地址              | 数据保存位置                                      |
| ---------- | --------------------- | ------------------------------------------------- |
| PostgreSQL | 127.0.0.1:55433       | Docker 卷 mini-deep-research_postgres_data        |
| Redis      | 127.0.0.1:56379       | Docker 卷 mini-deep-research_redis_data，开启 AOF |
| Next.js    | http://localhost:3000 | 读取 web/.env.local                               |

选择这两个数据库端口是为了避开其他项目。镜像固定到摘要，端口只绑定本机；Compose 中的数据库账号是本机开发配置。生产环境的账号、HTTPS、备份和网络配置另行部署。Redis Streams 由 Python Worker 使用。

`docker compose stop` 停止本项目依赖，数据保留；`docker compose up -d --wait` 再次启动。不要为普通重启删除数据卷。

## 2. 启用 GitHub 登录

在 GitHub 的 **Settings → Developer settings → OAuth Apps → New OAuth App** 创建一个 OAuth App：

| 配置项                     | 本机填写值                                     |
| -------------------------- | ---------------------------------------------- |
| Application name           | 例如 Mini Deep Research                        |
| Homepage URL               | http://localhost:3000                          |
| Authorization callback URL | http://localhost:3000/api/auth/callback/github |

把得到的 Client ID 和 Client Secret 填入本机 `web/.env.local`：

```dotenv
AUTH_GITHUB_ID=你的ClientID
AUTH_GITHUB_SECRET=你的ClientSecret
```

`AUTH_SECRET` 是网站自己的会话安全密钥，和 GitHub Client Secret 不同。另一台机器首次配置时可以用 `openssl rand -base64 32` 生成。不要将这些值放到 `NEXT_PUBLIC_*` 变量、Git 或聊天中。

重启 `pnpm dev`，访问 `/login`，点击“使用 GitHub 登录”。同意授权后进入研究记录页，可以创建、查看和取消自己的排队任务。网站只接收 GitHub 的授权结果，不接收 GitHub 密码。退出登录会删除数据库会话。

本项目锁定 Auth.js `5.0.0-beta.32`，其依赖范围支持当前 Next.js 16；它仍是 beta 版本，后续升级需要重跑认证测试。会话由官方 PostgreSQL adapter `1.11.3` 保存。此版本 adapter 的 `updateSession` 未返回更新行，因此 [auth-adapter.ts](lib/server/auth-adapter.ts) 做了一个带测试的补充。

未配置时，登录页明确显示不可用，认证接口返回 503；不会创建假身份。实际 GitHub 授权需要你完成上述配置才能人工验收。自动化测试覆盖本地会话协议，不代表已经连通 GitHub。

## 3. 路由和权限

| 地址                        | 当前行为                                                          |
| --------------------------- | ----------------------------------------------------------------- |
| `/`                         | 公开的需求预览；确认提交需要登录                                  |
| `/login`                    | GitHub 登录、当前账户、退出登录                                   |
| `/research`                 | 当前用户的真实记录，支持状态筛选和游标分页                        |
| `/research/[taskId]`        | 查看需求与实时状态，刷新或取消排队/运行中的任务；他人的任务不显示 |
| `/research/[taskId]/report` | 阅读归档报告、证据，申请人工复核并提交反馈                        |
| `/reviews`                  | 查看本人申请、受分派或可分派的复核收件箱                          |
| `/reviews/[reviewId]`       | 查看授权报告、操作记录，分派或提交版本化结论                      |
| `/api/v1/me`                | 会话有效时返回最小用户信息，未登录返回 JSON 401                   |
| `/api/auth/[...nextauth]`   | Auth.js 的登录、回调、会话、退出和 CSRF 接口                      |
| `/api/health/live`          | Web 进程存活：200，`{"status":"ok"}`                              |
| `/api/health/ready`         | 数据库可连接且必要迁移已完成：200；否则 503                       |

就绪检查只判断数据库和八份必要业务迁移，不调用 GitHub、模型、搜索，也不要求 Redis 在线。OAuth 是否配置在登录入口单独检查。Worker 启动另行检查 PostgreSQL、Redis、业务迁移和 LangGraph checkpoint 表。旧的 `/research/preview` 已由真实任务详情替代，访问这个旧标识会显示未找到页面。

页面权限由 `requirePageUser()` 处理，API 使用 `requireUser()` 返回 401。数据访问使用 `requireOwnedTask(user.id, taskId)`，将经过会话验证的用户 ID 放进参数化 SQL；不属于当前用户时抛出统一的 404 错误，业务 API 通过 `apiErrorResponse()` 转为 JSON 404。页面捕获后调用 Next.js `notFound()`：流式页面的 HTTP 状态可能已经是 200，但最终显示未找到页面，不会返回任务内容。页面测试应同时检查最终渲染结果，不能只看状态码。不能只在导航里隐藏链接，也不能信任浏览器提交的 `user_id`。

创建和取消接口均复用 `requireSameOriginWrite()`：校验配置的 Host / Origin、JSON Content-Type 和 `X-Research-CSRF: 1`。这个固定头是触发浏览器同源限制的标记，不是秘密令牌；不要为这些接口开放跨站 CORS。Auth.js 的登录接口使用库自己的 CSRF token，不套用业务 JSON 校验。

Cookie 使用 HttpOnly、SameSite=Lax，HTTPS 下增加 Secure。身份和授权数据按请求读取，私有 API 显式 no-store。生产反向代理必须提供与 `APP_ORIGIN` 一致的 Host / forwarded-host / forwarded-proto；不接受任意转发主机名。登录完成后的跳转只能留在配置的站点内。

## 4. 核心文件怎样分工

| 文件                                                                     | 在做什么，为什么放这里                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [../compose.yaml](../compose.yaml)                                       | 启动项目独立 PostgreSQL、Redis 与持久卷                                 |
| [001_auth.sql](../db/migrations/001_auth.sql)                            | 按 adapter 字段建立用户、OAuth 账号、会话和验证 token 表                |
| [002_tasks.sql](../db/migrations/002_tasks.sql)                          | 任务、attempt、outbox、事件和幂等表；约束跨任务关联、重复序号与配置修改 |
| [003_task_api.sql](../db/migrations/003_task_api.sql)                    | 将尚未判断的 research_done 表示为 null，增加活跃任务计数索引            |
| [004_results.sql](../db/migrations/004_results.sql)                      | 研究员完整结果、报告和证据的归档表                                      |
| [005_p5_events.sql](../db/migrations/005_p5_events.sql)                  | 并行 Researcher 稳定标识和 P5 事件索引                                  |
| [006_p6_reliability.sql](../db/migrations/006_p6_reliability.sql)        | retry 幂等 attempt 绑定和 outbox 对账时间                               |
| [007_p7_checkpoints.sql](../db/migrations/007_p7_checkpoints.sql)        | 逻辑图运行、稳定子任务登记、接续计数与版本                              |
| [008_reviews.sql](../db/migrations/008_reviews.sql)                      | 人工复核、角色、反馈、补查关系和追加式操作记录                          |
| [scripts/migrate.ts](scripts/migrate.ts)                                 | 命令行入口，读取 Web 环境并运行迁移                                     |
| [scripts/migrations.ts](scripts/migrations.ts)                           | 排序 SQL、校验 SHA-256、数据库会话锁、逐文件事务和回滚                  |
| [lib/server/db.ts](lib/server/db.ts)                                     | 延迟建立连接池、短事务助手、数据库就绪检查                              |
| [lib/server/auth.ts](lib/server/auth.ts)                                 | Auth.js 配置和统一会话入口，只向页面/API 返回必要用户字段               |
| [lib/server/auth-adapter.ts](lib/server/auth-adapter.ts)                 | 官方 adapter 的小范围兼容修正                                           |
| [lib/server/tasks.ts](lib/server/tasks.ts)                               | 创建/重试事务、幂等、配额、事件、所有权、分页、取消、报告与证据读取     |
| [lib/server/http.ts](lib/server/http.ts)                                 | JSON 错误、no-store、Host、Origin、业务 CSRF 和安全跳转                 |
| [lib/contracts.ts](lib/contracts.ts)                                     | 浏览器和服务端均可使用的 Zod 输入、配置与消息校验                       |
| [lib/server/research-config.ts](lib/server/research-config.ts)           | 将 quick/standard 转成有预算上限的只读配置，不接受浏览器指定密钥或地址  |
| [../mini_deep_research/contracts.py](../mini_deep_research/contracts.py) | Python 对同一传输协议的 Pydantic 校验，与图状态/LLM 输出模型分开        |
| [../contracts/](../contracts/)                                           | 公开 JSON Schema、正常/非法样例和协议说明                               |

读源码建议：`contracts.ts → research-config.ts → db.ts → auth.ts → tasks.ts → route.ts`。页面布局由 `app/layout.tsx` 管理；[research-form.tsx](components/research-form.tsx) 管输入、预览、确认和同键重试，[task-live-status.tsx](components/task-live-status.tsx) 管详情页 SSE、断线重连和终态刷新，[ReportViewer.tsx](components/ReportViewer.tsx) 和 [EvidencePanel.tsx](components/EvidencePanel.tsx) 管安全报告渲染与按需证据，[task-actions.tsx](components/task-actions.tsx) 管刷新、取消和失败重试，[auth-button.tsx](components/auth-button.tsx) 调用认证库的登录/退出动作。原有 CSS、图标和本地字体继续使用。

SQL 只由 `db/migrations/` 管理，Web 与 Worker 不各建一套表。重复运行迁移会跳过已应用文件；历史文件被改动或丢失时拒绝继续。失败的单个文件全部回滚，之前成功的迁移保留。后续修改数据库要新增迁移，并更新 Web / Worker 的必要迁移列表，不要修改已应用 SQL。

## 5. 输入与快照的边界

创建输入只有 question、requirements、language、depth。规范化时去除首尾 ASCII 空白，按 Unicode 码点计数，因此中文和 emoji 的字符计数在 TS / Python 中一致。省略选填字段会补默认值；其他字段直接拒绝。精确规则见 [协议说明](../contracts/README.md)。

`buildResearchConfig()` 只在服务器运行。quick 使用 1 搜索轮、1 批委派、每查询 3 条、300 秒；standard 使用 2 轮、2 批、5 条、600 秒；两者最多 2 个并行研究员。Web 的研究简报默认开启，Python CLI 仍沿用自己的已有默认值。模型名称、profile、代码版本和提示词版本来自服务端配置。

`createTask()` 已将输入与配置快照在事务内持久化，后续更新状态不能改写快照。Worker 验证 profile 是否支持，再解析对应连接和密钥，不能默默使用不匹配的默认配置。队列消息由 relay 投递到 Redis Streams，消费端从数据库读取冻结任务配置。

当前自由文本入口的澄清范围是“预览研究需求 → 用户确认”，不猜测语义。空问题、非法类型或选项返回 400；普通开放问题正常接受。因为没有明确要求额外字段的研究模板，目前不触发 422 NEEDS_CLARIFICATION，也不调用模型生成追问。前端支持展示将来的澄清问题，修改输入会清除旧预览和提交编号。

## 6. 任务接口与事务

| 方法和路径                                                        | 返回与边界                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/v1/research/tasks`                                     | 202：task_id、原始 attempt_id、当前 status、status_url；必须有 UUID 格式 Idempotency-Key |
| `GET /api/v1/research/tasks?limit=20&status=queued&cursor=...`    | 当前用户的 items、next_cursor；默认 20，上限 100，status 可省略                          |
| `GET /api/v1/research/tasks/{id}`                                 | 输入、当前尝试、状态、事件边界与公开错误；未登录 401，越权或不存在 404                   |
| `GET /api/v1/research/tasks/{id}/events?after=...`                | SSE 事件流；支持 `Last-Event-ID` 补读、心跳、游标 400/410 和任务所有权校验               |
| `POST /api/v1/research/tasks/{id}/cancel`                         | JSON `{}`；排队/已终态返回 200，运行中写入停止请求并返回 202                             |
| `POST /api/v1/research/tasks/{id}/retry`                          | 仅 failed 任务；必须带 UUID 幂等键，从原冻结配置创建新的 attempt                         |
| `POST /api/v1/research/tasks/{id}/resume`                         | 仅有兼容检查点的 failed 任务；沿用逻辑图运行，新建 attempt 并校验排他执行与预算          |
| `GET /api/v1/research/tasks/{id}/report`                          | 当前 attempt 的归档报告；尚未归档返回 409 REPORT_NOT_READY                               |
| `GET /api/v1/research/tasks/{id}/evidence?...`                    | 绑定 report_id 的发现分页；source_url 可按需读取单条来源正文                             |
| `GET /api/v1/research/tasks/{id}/report/download?format=markdown` | 下载归档 Markdown；不重新运行研究或抓取网页                                              |

创建请求原始体最多 64 KiB，取消体最多 1 KiB；格式错误返回 400，超限 413，非 JSON 类型 415。读取过程检查实际字节数，不依赖客户端声称的 Content-Length。未知字段、重复查询参数、非法分页游标也会拒绝。响应统一 no-store；错误包含稳定 code、公开 message 和 request_id，不带 SQL、凭证或原始异常。

`createTask()` 的顺序是：锁定用户行 → 查询幂等记录 → 检查活跃配额 → 写任务和第一个 attempt → 写 current_attempt_id → 写 outbox → 分配并保存 task.queued 事件 → 保存幂等引用 → 提交。每一步都属于同一事务，不调用 Redis、模型或搜索。任一步失败会整体回滚。

同一用户的创建请求用 users 行锁串行化，数据库主键防止重复幂等记录，因此两次并发 COUNT/INSERT 也不会突破配额。默认最多 3 个 queued/running 任务，可在 `.env.local` 设置 `MAX_ACTIVE_TASKS_PER_USER=3`（1–20）。取消排队后释放额度；命中幂等记录不再计费或占新额度。未来 retry 等增加活跃任务的入口必须遵守同一用户锁规则。

请求哈希使用规范化后的固定字段顺序，不包含当前模型配置。相同 key 和相同内容返回原 task、首次 attempt 和当前状态；不同内容返回 409。即使原任务已取消或以后产生新的 attempt，重放也不另建任务。记录至少保留 24 小时，当前没有清理程序，会继续保留。

浏览器只在“确认并提交”时生成 key，同页网络重试复用它，修改输入后重新预览会生成新的 key。刷新页面会丢失未提交草稿和 key；收到网络错误应留在本页重试，或先查看研究记录，不要刷新后误当同一次提交。已经持久保存的任务不受页面刷新影响。

列表游标按 `(created_at, id)` 倒序排列，保留 PostgreSQL 微秒精度，并验证用户与状态筛选匹配；列表仅返回摘要。详情中的事件序号是字符串，避免 bigint 精度损失。`research_done=null` 表示还没有研究结论；`has_report` 查询当前 attempt 是否有真实归档报告。

排队取消先锁任务，再锁当前 attempt，一次事务更新两者为 cancelled、记录取消时间并追加 task.cancelled。运行中取消先写 cancel_requested_at 和 task.cancel_requested，返回 202；Worker 在取消检查点清理研究图后再追加 task.cancelled。重复取消不重复写事件，已终态返回现状。outbox 保留原投递状态，投递器/消费者要按任务终态跳过，不能把取消假记为已经发布。

登录后可以在浏览器开发者工具 Console 体验创建；保存这个 key，重试时不要重新生成：

```javascript
const key = crypto.randomUUID();
const response = await fetch("/api/v1/research/tasks", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Research-CSRF": "1",
    "Idempotency-Key": key,
  },
  body: JSON.stringify({ question: "LangGraph 是什么？", depth: "quick" }),
});
const task = await response.json();
console.log(task);
```

浏览器自动携带同站 Cookie 和 Origin，不需要手写用户 ID。返回 202 只说明任务已可靠接受；Worker 归档成功后才会变为 succeeded。P5 的详情页通过 SSE 接收节点事件，断线时读取任务快照并从事件序号继续补读；浏览器不支持 SSE 或短时连接失败时使用快照刷新。终态停止订阅。报告、证据和下载全部读取 PostgreSQL 归档快照，越权统一返回 404。

## 7. 验证命令

```bash
pnpm test
TEST_DATABASE_URL=postgresql://deep_research:local_development_only@127.0.0.1:55433/deep_research pnpm test:db
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
TEST_DATABASE_URL=postgresql://deep_research:local_development_only@127.0.0.1:55433/deep_research pnpm test:http
```

`pnpm test` 检查共享样例、JSON Schema、预算与 HTTP 安全规则。`pnpm test:db` 必须显式设置测试地址，只创建自己的随机 schema，结束时清理该 schema，不删除开发库或 Docker 卷。它覆盖真实迁移、回滚、会话、CSRF、Secure Cookie、用户隔离、唯一约束与 bigint 精度，不消耗模型/搜索额度。

新增 [tasks.integration.ts](tests/tasks.integration.ts) 覆盖并发同键提交、冲突、配额、事务失败、分页、重复取消、重试幂等、报告未就绪、归档证据分页和跨用户读取。[tasks.http.ts](tests/tasks.http.ts) 启动独立端口的 Next.js 生产服务，用临时数据库会话验证实际 HTTP 入口、报告读取、来源展开和 Markdown 下载，Redis 故意配置为不可达；也验证 Web 重启后数据保留。先 build 再运行 test:http。测试不访问 GitHub，不创建生产测试登录接口，结束清理临时进程和 schema。

P7/P8 的真实数据库测试会在迁移中包含 `007_p7_checkpoints.sql` 和 `008_reviews.sql`；Worker 测试另外运行 LangGraph 官方 checkpoint 初始化。没有测试 PostgreSQL 时不能声称数据库/HTTP 集成测试通过。

Python 验证从项目根目录执行：

```bash
PYTHONDONTWRITEBYTECODE=1 uv run --locked pytest -q -p no:cacheprovider
```

手工检查：启动 Web 和 Worker 后，登录并填写问题 → 预览 → 确认并提交 → 打开任务详情观察 queued/running/succeeded 自动更新 → 阅读报告 → 点击引用展开证据 → 下载 Markdown。停止 Worker 后可验证 queued 取消。修改需求应清除旧预览；未登录提交保留当前输入。报告页直接读取归档快照，不会重新抓网页。

## 8. P3 Worker

在另一个终端，从项目根目录执行：

```bash
cd /home/lenovo/ai/study_deep_research/Simplified_version
uv sync --locked
uv run python -m mini_deep_research.worker
```

Worker 使用根目录 `.env` 的模型和 Tavily 配置。数据库和 Redis 地址优先读取环境变量/根目录 `.env`，未设置时复用 `web/.env.local`；Auth.js 的 OAuth 密钥不会进入图状态。当前支持 `deepseek-default-v1`，使用 `OPENAI_API_KEY` 和 `OPENAI_API_BASE_URL`，未设置地址时使用 DeepSeek 官方地址。

`service.py` 适配冻结输入和输出，`storage.py` 管理租约、子任务登记、检查点写入事务和归档，`worker.py` 管理队列、心跳、取消与退出；`checkpointing.py` 包装 LangGraph PostgreSQL saver。`007_p7_checkpoints.sql` 保存图身份、版本和子任务结果；LangGraph 的 `checkpoint_*` 表由 `python -m mini_deep_research.checkpointing` 独立初始化。Worker 启动时检查两组迁移，节点边界和约 1 秒取消检查点响应停止请求。P5 的事件写入 `task_events`，Web 通过 SSE 按 `seq` 补读；P6 对账恢复丢失通知；P4 报告页继续读取归档快照。

本机的 55432 已由另一个项目占用，本项目从 P3 改用 55433，原 PostgreSQL 数据卷保留。若有另行导出的 DATABASE_URL，也需要同步修改端口。

项目整体目录见 [项目 README](../README.md)，后续顺序见 [实现方案](../../PROJECT_IMPLEMENTATION_GUIDE.md)。

## 9. P7 检查点与接续

业务迁移后、启动 Worker 前，从项目根目录单独运行 `uv run python -m mini_deep_research.checkpointing`。它调用锁定版本的 LangGraph PostgreSQL saver 初始化 `checkpoint_*` 表；Web 的 SQL 迁移只建立 `research_graph_runs`、`research_subtasks` 和 attempt 关联。生产 Compose 先运行 `migrate`，再运行 `checkpoint_migrate`，最后启动 Worker。新代码会要求两组迁移齐备，旧业务迁移文件不会被改写。

## 10. P8 人工复核

报告页可以申请人工复核或提交绑定到指定报告版本的反馈。复核收件箱位于 `/reviews`；服务端角色通过 `user_roles` 授予 `reviewer` 或 `dispatcher`，页面本身不决定权限。dispatcher 只能分派，reviewer 只能查看已分派报告并提交一次版本化结论，报告所有者可以查看自己的复核和决定是否发起补查。

`needs_more_evidence` 不会自动启动研究。确认补查后，创建接口接受 `parent_report_id` 和 `review_id`，服务端检查报告、复核结论、所有权和普通任务预算，再创建独立任务，原报告不会被覆盖。`tests/reviews.integration.ts` 覆盖越权、幂等、乐观锁、证据授权和补查关系。

失败任务详情页保留两个明确操作：“从中断处接续”沿用同一 `graph_run_id` 和父子图 thread，只在有真实父图 checkpoint、代码/提示词/状态版本兼容、旧图会话锁已释放、累计执行时间仍低于冻结预算且接续次数未达到 3 时创建新 attempt；“重新研究”创建新图运行，从头调用模型和搜索。两者都需要登录、任务所有权、同站写入头和 UUID 幂等键；重复同键返回首次 attempt。P7 前的任务没有图检查点时只提供重跑。

Worker 在图执行期间持有 PostgreSQL 会话 advisory lock；进程退出后数据库自动释放。父子图 checkpoint 写入与当前 attempt 的租约核验共用一个数据库事务。父节点中断后重放会读取稳定子任务登记，复用已提交的不可变结果；未完成子图按 LangGraph 保存的状态继续。若报告已归档但 Redis 尚未 ACK，重复消息只补 ACK。节点内部尚未形成检查点的外部模型或搜索调用可能重放，因此不能把 checkpoint 理解为供应商请求恰好执行一次。
