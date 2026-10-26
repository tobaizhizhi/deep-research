import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  createResearchSchema,
  researchJobSchema,
  researchConfigSchema,
  uuidSchema,
  type CreateResearchInput,
  type CreateTaskResult,
  type EvidenceFinding,
  type EvidencePage,
  type EvidenceSource,
  type ResearchReport,
  type TaskDetail,
  type TaskEvent,
  type ListTasksQuery,
  type TaskSummary,
  type TaskStatus,
} from "../contracts";
import { getPool, transaction } from "./db";
import { ApiError } from "./http";
import { buildResearchConfig } from "./research-config";

type TaskRow = {
  id: string;
  question: string;
  requirements: string;
  language: CreateResearchInput["language"];
  depth: CreateResearchInput["depth"];
  status: TaskStatus;
  current_attempt_id: string | null;
  attempt_number: number | null;
  created_at: string;
  updated_at: string;
  cancel_requested_at: string | null;
  research_done: boolean | null;
  stop_reason: string;
  last_event_seq: string;
  min_event_seq: string | null;
  latest_event_type: string | null;
  error_code: string | null;
  has_report: boolean;
  resume_available: boolean;
  parent_report_id: string | null;
  review_id: string | null;
};

type ReportRow = {
  report_id: string;
  task_id: string;
  version: number;
  markdown: string;
  findings_json: unknown;
  sources_json: unknown;
  gaps_json: unknown;
  citation_warnings_json: unknown;
  research_done: boolean;
  stop_reason: string;
  created_at: string;
};

type ArchivedFinding = {
  claim: string;
  evidence: string;
  source_urls: string[];
};

type ArchivedSource = {
  title: string;
  url: string;
  snippet: string;
  content: string;
  fetched_at: string | null;
  content_hash: string | null;
  content_source: string | null;
  content_truncated: boolean | null;
};

export type EvidenceQuery = {
  report_id: string;
  cursor?: string;
  limit: number;
  source_url?: string;
};

const MAX_SOURCE_CONTENT_CHARS = 20_000;
const MAX_EVIDENCE_LIMIT = 20;

// 用数据库的微秒时间生成游标，避免 JS Date 截到毫秒导致分页遗漏。
const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// userId 必须由 requireUser / requirePageUser 获得，不能来自请求 JSON。
export async function requireOwnedTask(
  userId: string,
  taskId: string,
  client?: Pool | PoolClient,
  lock = false,
) {
  if (
    !uuidSchema.safeParse(taskId).success ||
    !uuidSchema.safeParse(userId).success
  )
    throw new ApiError(404, "TASK_NOT_FOUND");
  const result = await (client ?? getPool()).query<TaskRow>(
    `SELECT t.id, t.question, t.requirements, t.language, t.depth, t.status,
       t.parent_report_id, t.review_id,
       t.current_attempt_id, a.number AS attempt_number, a.error_code,
       ${timestamp("t.created_at")} AS created_at, ${timestamp("t.updated_at")} AS updated_at,
       ${timestamp("t.cancel_requested_at")} AS cancel_requested_at,
       t.research_done, t.stop_reason, (t.next_event_seq - 1)::text AS last_event_seq,
       (SELECT min(seq)::text FROM task_events WHERE task_id = t.id) AS min_event_seq,
       (SELECT type FROM task_events WHERE task_id = t.id ORDER BY seq DESC LIMIT 1) AS latest_event_type,
       EXISTS (SELECT 1 FROM research_reports r WHERE r.task_id = t.id AND r.attempt_id = t.current_attempt_id) AS has_report,
       EXISTS (SELECT 1 FROM research_graph_runs g WHERE g.id=a.graph_run_id
               AND g.checkpoint_count>0 AND g.status='active'
               AND g.state_schema_version=1 AND g.resume_count<g.max_resume_count
               AND g.code_version=$3 AND g.prompt_version=$4
               AND g.code_version=t.config_json->>'code_version'
               AND g.prompt_version=t.config_json->>'prompt_version'
               AND COALESCE((SELECT SUM(EXTRACT(EPOCH FROM x.finished_at-x.started_at))
                             FROM research_attempts x WHERE x.graph_run_id=g.id
                               AND x.started_at IS NOT NULL AND x.finished_at IS NOT NULL),0)
                   < (t.config_json->>'total_timeout_seconds')::numeric) AS resume_available
     FROM research_tasks t LEFT JOIN research_attempts a ON a.id = t.current_attempt_id
     WHERE t.id = $1 AND t.user_id = $2 ${lock ? "FOR UPDATE OF t" : ""}`,
    [
      taskId,
      userId,
      process.env.RESEARCH_CODE_VERSION ?? "local-p2",
      process.env.RESEARCH_PROMPT_VERSION ?? "v1",
    ],
  );
  if (!result.rows[0]) throw new ApiError(404, "TASK_NOT_FOUND");
  return result.rows[0];
}

function publicTask(row: TaskRow): TaskDetail {
  const messages: Record<string, string> = {
    RESEARCH_TIMEOUT: "研究执行超时。",
    WORKER_LOST: "研究执行进程已断开。",
    MODEL_ERROR: "模型调用失败。",
    SEARCH_ERROR: "搜索服务调用失败。",
    CONFIG_UNAVAILABLE: "本次任务的研究配置不可用，请联系维护者。",
    WORKER_SHUTDOWN: "研究执行服务已停止，本次任务未完成。",
  };
  const error =
    row.status === "failed"
      ? {
          code:
            row.error_code && Object.hasOwn(messages, row.error_code)
              ? row.error_code
              : "RESEARCH_FAILED",
          message:
            row.error_code && Object.hasOwn(messages, row.error_code)
              ? messages[row.error_code]
              : "研究未能完成，请稍后重试。",
        }
      : null;
  return {
    task_id: row.id,
    question: row.question,
    requirements: row.requirements,
    language: row.language,
    depth: row.depth,
    status: row.status,
    current_attempt_id: row.current_attempt_id,
    attempt_number: row.attempt_number,
    created_at: row.created_at,
    updated_at: row.updated_at,
    cancel_requested_at: row.cancel_requested_at,
    research_done: row.research_done,
    stop_reason: row.stop_reason,
    last_event_seq: row.last_event_seq,
    min_event_seq: row.min_event_seq,
    latest_event_type: row.latest_event_type,
    has_report: row.has_report,
    resume_available: row.status === "failed" && row.resume_available,
    error,
    parent_report_id: row.parent_report_id,
    review_id: row.review_id,
  };
}

export async function getTask(
  userId: string,
  taskId: string,
  client?: Pool | PoolClient,
) {
  return publicTask(await requireOwnedTask(userId, taskId, client));
}

function activeTaskLimit() {
  const value = process.env.MAX_ACTIVE_TASKS_PER_USER ?? "3";
  if (!/^[1-9][0-9]?$/.test(value) || Number(value) > 20)
    throw new Error("INVALID_ACTIVE_TASK_LIMIT");
  return Number(value);
}

function requestHash(input: CreateResearchInput) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        question: input.question,
        requirements: input.requirements,
        language: input.language,
        depth: input.depth,
        parent_report_id: input.parent_report_id ?? null,
        review_id: input.review_id ?? null,
      }),
    )
    .digest("hex");
}

async function appendEvent(
  client: PoolClient,
  taskId: string,
  attemptId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  // 调用方已经锁定 task（新建任务则持有插入行）；锁顺序始终 task → attempt → event。
  const result = await client.query<{ seq: string }>(
    "UPDATE research_tasks SET next_event_seq = next_event_seq + 1 WHERE id = $1 RETURNING (next_event_seq - 1)::text AS seq",
    [taskId],
  );
  await client.query(
    `INSERT INTO task_events(task_id, seq, attempt_id, type, payload_json)
    VALUES ($1, $2, $3, $4, $5)`,
    [
      taskId,
      result.rows[0].seq,
      attemptId,
      type,
      {
        schema_version: 1,
        task_id: taskId,
        attempt_id: attemptId,
        ...payload,
      },
    ],
  );
}

// free text 没有确定的模板必填项：合法开放问题直接接受，不猜测语义来返回 422。
export async function createTask(
  userId: string,
  rawInput: unknown,
  key: string,
  pool = getPool(),
): Promise<CreateTaskResult> {
  const parsed = createResearchSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new ApiError(400, "INVALID_INPUT", "研究问题或选项不合法。");
  if (!uuidSchema.safeParse(key).success)
    throw new ApiError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key 必须是 UUID。",
    );
  const input = parsed.data;
  const hash = requestHash(input);
  const canonicalKey = key.toLowerCase();
  return transaction(async (client) => {
    // 一行锁同时串行化本用户的幂等检查与活跃任务计数；不另建配额/占位表。
    // 每个创建入口都必须先取这把锁，数据库主键再提供最终唯一性约束。
    const owner = await client.query(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    if (!owner.rowCount)
      throw new ApiError(401, "UNAUTHENTICATED", "请先登录。");
    const previous = await client.query<{
      request_hash: string;
      task_id: string;
      attempt_id: string;
      status: TaskStatus;
    }>(
      `SELECT i.request_hash, t.id AS task_id, a.id AS attempt_id, t.status
       FROM api_idempotency i JOIN research_tasks t ON t.id = i.resource_id AND t.user_id = i.user_id
       JOIN research_attempts a ON a.task_id = t.id AND a.number = 1
       WHERE i.user_id = $1 AND i.operation = 'research.create' AND i.key = $2`,
      [userId, canonicalKey],
    );
    if (previous.rows[0]) {
      const original = previous.rows[0];
      if (original.request_hash !== hash)
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "这个提交编号已用于不同的研究需求，请重新确认后提交。",
        );
      return {
        task_id: original.task_id,
        attempt_id: original.attempt_id,
        status: original.status,
        status_url: `/api/v1/research/tasks/${original.task_id}`,
      };
    }
    const limit = activeTaskLimit();
    const active = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM research_tasks WHERE user_id = $1 AND status IN ('queued', 'running')",
      [userId],
    );
    if (active.rows[0].count >= limit)
      throw new ApiError(
        429,
        "ACTIVE_TASK_LIMIT",
        `最多同时保留 ${limit} 个排队或执行中的任务，请先完成或取消已有任务。`,
      );

    if (Boolean(input.parent_report_id) !== Boolean(input.review_id))
      throw new ApiError(
        400,
        "INVALID_FOLLOWUP",
        "补查必须同时绑定报告和已完成的复核单。",
      );
    if (input.parent_report_id && input.review_id) {
      const followup = await client.query<{
        task_id: string;
        requested_by: string;
        status: string;
        verdict: string | null;
      }>(
        `SELECT r.task_id, v.requested_by, v.status, v.verdict
           FROM research_reports r
           JOIN report_reviews v ON v.id=$2 AND v.report_id=r.id
          WHERE r.id=$1`,
        [input.parent_report_id, input.review_id],
      );
      const relation = followup.rows[0];
      if (
        !relation ||
        relation.requested_by !== userId ||
        relation.status !== "completed" ||
        relation.verdict !== "needs_more_evidence"
      )
        throw new ApiError(
          409,
          "FOLLOWUP_NOT_ALLOWED",
          "只有本人报告中已完成且要求补充证据的复核意见可以发起补查。",
        );
    }

    const taskId = randomUUID();
    const attemptId = randomUUID();
    const graphRunId = randomUUID();
    const messageId = randomUUID();
    const config = buildResearchConfig(input.depth);
    const job = researchJobSchema.parse({
      schema_version: 1,
      message_id: messageId,
      type: "research.run",
      task_id: taskId,
      attempt_id: attemptId,
      created_at: new Date().toISOString(),
    });
    await client.query(
      `INSERT INTO research_tasks(id, user_id, question, requirements, language, depth, config_json,
                                  parent_report_id, review_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        taskId,
        userId,
        input.question,
        input.requirements,
        input.language,
        input.depth,
        config,
        input.parent_report_id ?? null,
        input.review_id ?? null,
      ],
    );
    await client.query(
      `INSERT INTO research_graph_runs
       (id, task_id, run_number, thread_id, checkpoint_ns, code_version, prompt_version)
       VALUES ($1, $2, 1, $3, '', $4, $5)`,
      [
        graphRunId,
        taskId,
        `research:${taskId}`,
        config.code_version,
        config.prompt_version,
      ],
    );
    await client.query(
      `INSERT INTO research_attempts(id, task_id, number, graph_run_id, versions_json) VALUES ($1, $2, 1, $3, $4)`,
      [
        attemptId,
        taskId,
        graphRunId,
        {
          schema_version: config.schema_version,
          code_version: config.code_version,
          prompt_version: config.prompt_version,
        },
      ],
    );
    await client.query(
      "UPDATE research_tasks SET current_attempt_id = $1 WHERE id = $2",
      [attemptId, taskId],
    );
    await client.query(
      `INSERT INTO task_outbox(id, task_id, attempt_id, schema_version, payload_json)
      VALUES ($1, $2, $3, 1, $4)`,
      [messageId, taskId, attemptId, job],
    );
    await appendEvent(client, taskId, attemptId, "task.queued", {
      status: "queued",
    });
    await client.query(
      `INSERT INTO api_idempotency(user_id, operation, key, request_hash, resource_id, expires_at)
      VALUES ($1, 'research.create', $2, $3, $4, now() + interval '24 hours')`,
      [userId, canonicalKey, hash, taskId],
    );
    return {
      task_id: taskId,
      attempt_id: attemptId,
      status: "queued",
      status_url: `/api/v1/research/tasks/${taskId}`,
    };
  }, pool);
}

/** 从头重跑 failed task；旧 attempt 和归档记录保持不变。 */
export async function retryTask(
  userId: string,
  taskId: string,
  key: string,
  pool = getPool(),
): Promise<CreateTaskResult> {
  if (
    !uuidSchema.safeParse(userId).success ||
    !uuidSchema.safeParse(taskId).success
  )
    throw new ApiError(404, "TASK_NOT_FOUND");
  if (!uuidSchema.safeParse(key).success)
    throw new ApiError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key 必须是 UUID。",
    );
  const canonicalKey = key.toLowerCase();
  const requestHashValue = createHash("sha256")
    .update(JSON.stringify({ task_id: taskId, operation: "research.retry" }))
    .digest("hex");

  return transaction(async (client) => {
    const owner = await client.query(
      "SELECT id FROM users WHERE id=$1 FOR UPDATE",
      [userId],
    );
    if (!owner.rowCount)
      throw new ApiError(401, "UNAUTHENTICATED", "请先登录。");
    const previous = await client.query<{
      request_hash: string;
      resource_id: string;
      result_attempt_id: string | null;
    }>(
      `SELECT request_hash, resource_id, result_attempt_id
         FROM api_idempotency
        WHERE user_id=$1 AND operation='research.retry' AND key=$2`,
      [userId, canonicalKey],
    );
    if (previous.rows[0]) {
      const original = previous.rows[0];
      if (
        original.request_hash !== requestHashValue ||
        original.resource_id !== taskId
      )
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "这个重试编号已用于其他任务。",
        );
      if (!original.result_attempt_id)
        throw new Error("RETRY_IDEMPOTENCY_MISSING_ATTEMPT");
      const task = await client.query<{ status: TaskStatus }>(
        "SELECT status FROM research_tasks WHERE id=$1 AND user_id=$2",
        [taskId, userId],
      );
      if (!task.rows[0]) throw new ApiError(404, "TASK_NOT_FOUND");
      return {
        task_id: taskId,
        attempt_id: original.result_attempt_id,
        status: task.rows[0].status,
        status_url: `/api/v1/research/tasks/${taskId}`,
      };
    }

    const task = await client.query<{
      id: string;
      status: TaskStatus;
      config_json: unknown;
    }>(
      "SELECT id,status,config_json FROM research_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [taskId, userId],
    );
    if (!task.rows[0]) throw new ApiError(404, "TASK_NOT_FOUND");
    if (task.rows[0].status !== "failed")
      throw new ApiError(409, "TASK_NOT_RETRYABLE", "只有失败的任务可以重试。");
    const limit = activeTaskLimit();
    const active = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM research_tasks WHERE user_id=$1 AND status IN ('queued','running')",
      [userId],
    );
    if (active.rows[0].count >= limit)
      throw new ApiError(
        429,
        "ACTIVE_TASK_LIMIT",
        `最多同时保留 ${limit} 个排队或执行中的任务。`,
      );

    const attemptId = randomUUID();
    const messageId = randomUUID();
    const graphRunId = randomUUID();
    const number = await client.query<{ number: number }>(
      "SELECT COALESCE(max(number),0)+1 AS number FROM research_attempts WHERE task_id=$1",
      [taskId],
    );
    const attemptNumber = number.rows[0].number;
    const parsedConfig = researchConfigSchema.safeParse(
      task.rows[0].config_json,
    );
    if (!parsedConfig.success)
      throw new ApiError(
        409,
        "CONFIG_UNAVAILABLE",
        "本次任务的研究配置已不可用，请重新创建任务。",
      );
    const config = parsedConfig.data;
    const job = researchJobSchema.parse({
      schema_version: 1,
      message_id: messageId,
      type: "research.run",
      task_id: taskId,
      attempt_id: attemptId,
      created_at: new Date().toISOString(),
    });
    await client.query(
      `INSERT INTO research_graph_runs
       (id,task_id,run_number,thread_id,checkpoint_ns,code_version,prompt_version)
       VALUES($1,$2,$3,$4,'',$5,$6)`,
      [
        graphRunId,
        taskId,
        attemptNumber,
        `research:${taskId}:run:${attemptNumber}`,
        config.code_version,
        config.prompt_version,
      ],
    );
    await client.query(
      "INSERT INTO research_attempts(id,task_id,number,graph_run_id,versions_json) VALUES($1,$2,$3,$4,$5)",
      [
        attemptId,
        taskId,
        attemptNumber,
        graphRunId,
        {
          schema_version: config.schema_version,
          code_version: config.code_version,
          prompt_version: config.prompt_version,
        },
      ],
    );
    await client.query(
      `UPDATE research_tasks
          SET current_attempt_id=$1, status='queued', cancel_requested_at=NULL,
              research_done=NULL, stop_reason=''
        WHERE id=$2`,
      [attemptId, taskId],
    );
    await client.query(
      `INSERT INTO task_outbox(id,task_id,attempt_id,schema_version,payload_json)
       VALUES($1,$2,$3,1,$4)`,
      [messageId, taskId, attemptId, job],
    );
    await appendEvent(client, taskId, attemptId, "task.retry_queued", {
      status: "queued",
      attempt_number: attemptNumber,
    });
    await client.query(
      `INSERT INTO api_idempotency(user_id,operation,key,request_hash,resource_id,result_attempt_id,expires_at)
       VALUES($1,'research.retry',$2,$3,$4,$5,now()+interval '24 hours')`,
      [userId, canonicalKey, requestHashValue, taskId, attemptId],
    );
    return {
      task_id: taskId,
      attempt_id: attemptId,
      status: "queued",
      status_url: `/api/v1/research/tasks/${taskId}`,
    };
  }, pool);
}

/** 从失败点接续既有逻辑图；与 retry 创建新图运行的语义分开。 */
export async function resumeTask(
  userId: string,
  taskId: string,
  key: string,
  pool = getPool(),
): Promise<CreateTaskResult> {
  if (
    !uuidSchema.safeParse(userId).success ||
    !uuidSchema.safeParse(taskId).success
  )
    throw new ApiError(404, "TASK_NOT_FOUND");
  if (!uuidSchema.safeParse(key).success)
    throw new ApiError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key 必须是 UUID。",
    );
  const canonicalKey = key.toLowerCase();
  const requestHashValue = createHash("sha256")
    .update(JSON.stringify({ task_id: taskId, operation: "research.resume" }))
    .digest("hex");
  return transaction(async (client) => {
    const owner = await client.query(
      "SELECT id FROM users WHERE id=$1 FOR UPDATE",
      [userId],
    );
    if (!owner.rowCount)
      throw new ApiError(401, "UNAUTHENTICATED", "请先登录。");
    const previous = await client.query<{
      request_hash: string;
      resource_id: string;
      result_attempt_id: string | null;
    }>(
      `SELECT request_hash,resource_id,result_attempt_id FROM api_idempotency
       WHERE user_id=$1 AND operation='research.resume' AND key=$2`,
      [userId, canonicalKey],
    );
    if (previous.rows[0]) {
      const original = previous.rows[0];
      if (
        original.request_hash !== requestHashValue ||
        original.resource_id !== taskId
      )
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "这个接续编号已用于其他任务。",
        );
      if (!original.result_attempt_id)
        throw new Error("RESUME_IDEMPOTENCY_MISSING_ATTEMPT");
      const current = await client.query<{ status: TaskStatus }>(
        "SELECT status FROM research_tasks WHERE id=$1 AND user_id=$2",
        [taskId, userId],
      );
      if (!current.rows[0]) throw new ApiError(404, "TASK_NOT_FOUND");
      return {
        task_id: taskId,
        attempt_id: original.result_attempt_id,
        status: current.rows[0].status,
        status_url: `/api/v1/research/tasks/${taskId}`,
      };
    }
    const task = await client.query<{
      id: string;
      status: TaskStatus;
      current_attempt_id: string;
      config_json: unknown;
    }>(
      "SELECT id,status,current_attempt_id,config_json FROM research_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [taskId, userId],
    );
    if (!task.rows[0]) throw new ApiError(404, "TASK_NOT_FOUND");
    if (task.rows[0].status !== "failed")
      throw new ApiError(409, "TASK_NOT_RESUMABLE", "只有失败的任务可以接续。");
    const oldAttempt = await client.query<{
      graph_run_id: string;
      status: string;
    }>(
      "SELECT graph_run_id,status FROM research_attempts WHERE task_id=$1 AND id=$2 FOR UPDATE",
      [taskId, task.rows[0].current_attempt_id],
    );
    if (!oldAttempt.rows[0] || oldAttempt.rows[0].status !== "failed")
      throw new ApiError(409, "TASK_NOT_RESUMABLE", "当前执行尚未完全结束。");
    const run = await client.query<{
      id: string;
      thread_id: string;
      checkpoint_ns: string;
      state_schema_version: number;
      code_version: string;
      prompt_version: string;
      graph_mode: string;
      status: string;
      resume_count: number;
      max_resume_count: number;
    }>(
      "SELECT * FROM research_graph_runs WHERE id=$1 AND task_id=$2 FOR UPDATE",
      [oldAttempt.rows[0].graph_run_id, taskId],
    );
    const graph = run.rows[0];
    if (!graph || graph.status !== "active")
      throw new ApiError(
        409,
        "GRAPH_RUN_UNAVAILABLE",
        "这次图运行无法接续，请从头重跑。",
      );
    const config = researchConfigSchema.safeParse(task.rows[0].config_json);
    const currentCode = process.env.RESEARCH_CODE_VERSION ?? "local-p2";
    const currentPrompt = process.env.RESEARCH_PROMPT_VERSION ?? "v1";
    if (
      !config.success ||
      graph.state_schema_version !== 1 ||
      graph.graph_mode !== "fixed" ||
      graph.code_version !== config.data.code_version ||
      graph.prompt_version !== config.data.prompt_version ||
      graph.code_version !== currentCode ||
      graph.prompt_version !== currentPrompt
    )
      throw new ApiError(
        409,
        "GRAPH_VERSION_INCOMPATIBLE",
        "图版本已变化，请从头重跑或创建新任务。",
      );
    if (graph.resume_count >= graph.max_resume_count)
      throw new ApiError(
        409,
        "RESUME_LIMIT_REACHED",
        "本次图运行的接续次数已用完。",
      );
    const spent = await client.query<{ seconds: number }>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM finished_at-started_at)),0)::float8 AS seconds
       FROM research_attempts WHERE graph_run_id=$1
         AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
      [graph.id],
    );
    if (spent.rows[0].seconds >= config.data.total_timeout_seconds)
      throw new ApiError(
        409,
        "RESUME_BUDGET_EXHAUSTED",
        "研究时间预算已用完，请从头重跑。",
      );
    const active = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM research_tasks WHERE user_id=$1 AND status IN ('queued','running')",
      [userId],
    );
    const limit = activeTaskLimit();
    if (active.rows[0].count >= limit)
      throw new ApiError(
        429,
        "ACTIVE_TASK_LIMIT",
        `最多同时保留 ${limit} 个排队或执行中的任务。`,
      );
    const checkpointTable = await client.query<{ table_name: string | null }>(
      "SELECT to_regclass('checkpoints')::text AS table_name",
    );
    if (!checkpointTable.rows[0]?.table_name)
      throw new ApiError(
        409,
        "CHECKPOINT_NOT_FOUND",
        "没有可接续的图检查点，请从头重跑。",
      );
    const checkpoint = await client.query(
      "SELECT 1 FROM checkpoints WHERE thread_id=$1 AND checkpoint_ns=$2 LIMIT 1",
      [graph.thread_id, graph.checkpoint_ns],
    );
    if (!checkpoint.rowCount)
      throw new ApiError(
        409,
        "CHECKPOINT_NOT_FOUND",
        "没有可接续的图检查点，请从头重跑。",
      );
    const exclusive = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
      [graph.thread_id],
    );
    if (!exclusive.rows[0].locked)
      throw new ApiError(
        409,
        "GRAPH_RUN_IN_USE",
        "原执行进程仍在退出，请稍后再接续。",
      );
    const next = await client.query<{ number: number }>(
      "SELECT COALESCE(max(number),0)+1 AS number FROM research_attempts WHERE task_id=$1",
      [taskId],
    );
    const attemptId = randomUUID();
    const messageId = randomUUID();
    const job = researchJobSchema.parse({
      schema_version: 1,
      message_id: messageId,
      type: "research.run",
      task_id: taskId,
      attempt_id: attemptId,
      created_at: new Date().toISOString(),
    });
    await client.query(
      `INSERT INTO research_attempts
       (id,task_id,number,graph_run_id,resume_from_checkpoint,versions_json)
       VALUES($1,$2,$3,$4,true,$5)`,
      [
        attemptId,
        taskId,
        next.rows[0].number,
        graph.id,
        {
          schema_version: config.data.schema_version,
          state_schema_version: graph.state_schema_version,
          code_version: graph.code_version,
          prompt_version: graph.prompt_version,
        },
      ],
    );
    await client.query(
      `UPDATE research_tasks SET current_attempt_id=$1,status='queued',
       cancel_requested_at=NULL,research_done=NULL,stop_reason='' WHERE id=$2`,
      [attemptId, taskId],
    );
    await client.query(
      "UPDATE research_graph_runs SET resume_count=resume_count+1 WHERE id=$1",
      [graph.id],
    );
    await client.query(
      `INSERT INTO task_outbox(id,task_id,attempt_id,schema_version,payload_json)
       VALUES($1,$2,$3,1,$4)`,
      [messageId, taskId, attemptId, job],
    );
    await appendEvent(client, taskId, attemptId, "task.resume_queued", {
      status: "queued",
      attempt_number: next.rows[0].number,
      resume_count: graph.resume_count + 1,
    });
    await client.query(
      `INSERT INTO api_idempotency
       (user_id,operation,key,request_hash,resource_id,result_attempt_id,expires_at)
       VALUES($1,'research.resume',$2,$3,$4,$5,now()+interval '24 hours')`,
      [userId, canonicalKey, requestHashValue, taskId, attemptId],
    );
    return {
      task_id: taskId,
      attempt_id: attemptId,
      status: "queued",
      status_url: `/api/v1/research/tasks/${taskId}`,
    };
  }, pool);
}

const cursorSchema = z.strictObject({
  version: z.literal(1),
  user_id: uuidSchema,
  status: z.string().nullable(),
  created_at: z.iso
    .datetime({ precision: 6 })
    .refine((value) => !value.startsWith("0000")),
  id: uuidSchema,
});

export async function listTasks(
  userId: string,
  query: ListTasksQuery,
  client: Pool | PoolClient = getPool(),
): Promise<{ items: TaskSummary[]; next_cursor: string | null }> {
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (query.cursor) {
    try {
      if (!/^[a-zA-Z0-9_-]+$/.test(query.cursor) || query.cursor.length > 1024)
        throw new Error("bad cursor");
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (cursor.user_id !== userId || cursor.status !== (query.status ?? null))
        throw new Error("cursor scope mismatch");
    } catch {
      throw new ApiError(
        400,
        "INVALID_CURSOR",
        "分页位置无效，请从第一页重新查看。",
      );
    }
  }
  const result = await client.query<TaskSummary>(
    `SELECT t.id AS task_id, left(t.question, 180) AS question,
      t.status, ${timestamp("t.created_at")} AS created_at FROM research_tasks t
    WHERE t.user_id = $1 AND ($2::text IS NULL OR t.status = $2)
      AND ($3::timestamptz IS NULL OR (t.created_at, t.id) < ($3::timestamptz, $4::uuid))
    ORDER BY t.created_at DESC, t.id DESC LIMIT $5`,
    [
      userId,
      query.status ?? null,
      cursor?.created_at ?? null,
      cursor?.id ?? null,
      query.limit + 1,
    ],
  );
  const items = result.rows.slice(0, query.limit);
  const last = items.at(-1);
  const next_cursor =
    result.rows.length > query.limit && last
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            user_id: userId,
            status: query.status ?? null,
            created_at: last.created_at,
            id: last.task_id,
          }),
        ).toString("base64url")
      : null;
  return { items, next_cursor };
}

const evidenceCursorSchema = z.strictObject({
  version: z.literal(1),
  report_id: uuidSchema,
  offset: z.int().min(0).max(100_000),
});

function archivedArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`INVALID_ARCHIVED_${field}`);
  return value;
}

function archivedString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`INVALID_ARCHIVED_${field}`);
  return value;
}

function archivedFinding(value: unknown): ArchivedFinding {
  if (!value || typeof value !== "object")
    throw new Error("INVALID_ARCHIVED_FINDING");
  const item = value as Record<string, unknown>;
  const sourceUrls = archivedArray(item.source_urls, "SOURCE_URLS");
  if (!sourceUrls.every((url) => typeof url === "string"))
    throw new Error("INVALID_ARCHIVED_SOURCE_URL");
  return {
    claim: archivedString(item.claim, "CLAIM"),
    evidence: archivedString(item.evidence, "EVIDENCE"),
    source_urls: sourceUrls as string[],
  };
}

function archivedSource(value: unknown): ArchivedSource {
  if (!value || typeof value !== "object")
    throw new Error("INVALID_ARCHIVED_SOURCE");
  const item = value as Record<string, unknown>;
  const optionalString = (key: string) =>
    item[key] === null || item[key] === undefined
      ? null
      : archivedString(item[key], key.toUpperCase());
  const optionalBoolean = (key: string) =>
    item[key] === null || item[key] === undefined
      ? null
      : typeof item[key] === "boolean"
        ? item[key]
        : (() => {
            throw new Error(`INVALID_ARCHIVED_${key.toUpperCase()}`);
          })();
  return {
    title: archivedString(item.title, "TITLE"),
    url: archivedString(item.url, "URL"),
    snippet: archivedString(item.snippet, "SNIPPET"),
    content: archivedString(item.content, "CONTENT"),
    fetched_at: optionalString("fetched_at"),
    content_hash: optionalString("content_hash"),
    content_source: optionalString("content_source"),
    content_truncated: optionalBoolean("content_truncated"),
  };
}

function reportRowFindings(row: ReportRow): ArchivedFinding[] {
  return archivedArray(row.findings_json, "FINDINGS").map(archivedFinding);
}

function reportRowSources(row: ReportRow): ArchivedSource[] {
  return archivedArray(row.sources_json, "SOURCES").map(archivedSource);
}

function reportRowStrings(value: unknown, field: string): string[] {
  const values = archivedArray(value, field);
  if (!values.every((item) => typeof item === "string"))
    throw new Error(`INVALID_ARCHIVED_${field}`);
  return values as string[];
}

function publicReport(row: ReportRow): ResearchReport {
  return {
    report_id: row.report_id,
    task_id: row.task_id,
    version: row.version,
    markdown: row.markdown,
    gaps: reportRowStrings(row.gaps_json, "GAPS"),
    citation_warnings: reportRowStrings(
      row.citation_warnings_json,
      "CITATION_WARNINGS",
    ),
    research_done: row.research_done,
    stop_reason: row.stop_reason,
    created_at: row.created_at,
  };
}

function publicSource(
  source: ArchivedSource,
  includeContent = false,
): EvidenceSource {
  const result: EvidenceSource = {
    title: source.title,
    url: source.url,
    snippet: source.snippet,
    fetched_at: source.fetched_at,
    content_hash: source.content_hash,
    content_source: source.content_source,
    content_truncated: source.content_truncated,
  };
  if (includeContent) {
    result.content = source.content.slice(0, MAX_SOURCE_CONTENT_CHARS);
    result.content_truncated =
      source.content_truncated ||
      source.content.length > MAX_SOURCE_CONTENT_CHARS;
  }
  return result;
}

function publicFinding(
  finding: ArchivedFinding,
  findingId: number,
  sourcesByUrl: Map<string, ArchivedSource>,
): EvidenceFinding {
  return {
    finding_id: findingId,
    claim: finding.claim,
    evidence: finding.evidence,
    source_urls: finding.source_urls,
    sources: finding.source_urls
      .map((url) => sourcesByUrl.get(url))
      .filter((source): source is ArchivedSource => Boolean(source))
      .map((source) => publicSource(source)),
  };
}

async function loadReportRow(
  userId: string,
  taskId: string,
  reportId: string | null,
  client: Pool | PoolClient,
): Promise<ReportRow> {
  const task = await requireOwnedTask(userId, taskId, client);
  const result = await client.query<ReportRow>(
    `SELECT r.id AS report_id, r.task_id, r.version, r.markdown,
       r.findings_json, r.sources_json, r.gaps_json,
       r.citation_warnings_json, r.research_done, r.stop_reason,
       ${timestamp("r.created_at")} AS created_at
     FROM research_reports r
     WHERE r.task_id = $1
       AND ($2::uuid IS NULL OR r.id = $2::uuid)
       AND ($3::uuid IS NULL OR r.attempt_id = $3::uuid)
     ORDER BY r.version DESC
     LIMIT 1`,
    [task.id, reportId, reportId ? null : task.current_attempt_id],
  );
  if (!result.rows[0])
    throw new ApiError(
      reportId ? 404 : 409,
      reportId ? "REPORT_NOT_FOUND" : "REPORT_NOT_READY",
      reportId ? "报告版本不存在。" : "报告尚未生成，请稍后查看任务状态。",
    );
  return result.rows[0];
}

export async function getReport(
  userId: string,
  taskId: string,
  client: Pool | PoolClient = getPool(),
): Promise<ResearchReport> {
  return publicReport(await loadReportRow(userId, taskId, null, client));
}

export async function getEvidence(
  userId: string,
  taskId: string,
  query: EvidenceQuery,
  client: Pool | PoolClient = getPool(),
): Promise<EvidencePage> {
  if (query.limit < 1 || query.limit > MAX_EVIDENCE_LIMIT)
    throw new ApiError(400, "INVALID_INPUT", "证据分页大小无效。");
  if (query.source_url && query.cursor)
    throw new ApiError(400, "INVALID_INPUT", "来源详情不能同时使用分页游标。");

  const row = await loadReportRow(userId, taskId, query.report_id, client);
  const findings = reportRowFindings(row);
  const sourcesByUrl = new Map(
    reportRowSources(row).map((source) => [source.url, source]),
  );

  if (query.source_url) {
    const source = sourcesByUrl.get(query.source_url);
    if (!source)
      throw new ApiError(404, "SOURCE_NOT_FOUND", "这条来源不属于当前报告。");
    const related = findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding }) => finding.source_urls.includes(source.url))
      .map(({ finding, index }) =>
        publicFinding(finding, index + 1, sourcesByUrl),
      );
    return {
      report_id: row.report_id,
      items: [],
      next_cursor: null,
      selected_source: publicSource(source, true),
      selected_findings: related,
    };
  }

  let offset = 0;
  if (query.cursor) {
    try {
      if (!/^[a-zA-Z0-9_-]+$/.test(query.cursor) || query.cursor.length > 1024)
        throw new Error("bad cursor");
      const cursor = evidenceCursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (cursor.report_id !== row.report_id) throw new Error("scope mismatch");
      offset = cursor.offset;
    } catch {
      throw new ApiError(
        400,
        "INVALID_CURSOR",
        "证据分页位置无效，请从第一页重新查看。",
      );
    }
  }

  const page = findings.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  const next_cursor =
    nextOffset < findings.length
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            report_id: row.report_id,
            offset: nextOffset,
          }),
        ).toString("base64url")
      : null;
  return {
    report_id: row.report_id,
    items: page.map((finding, index) =>
      publicFinding(finding, offset + index + 1, sourcesByUrl),
    ),
    next_cursor,
    selected_source: null,
    selected_findings: [],
  };
}

export type TaskEventBounds = {
  last_event_seq: string;
  min_event_seq: string | null;
};

export async function getTaskEventBounds(
  userId: string,
  taskId: string,
  client: Pool | PoolClient = getPool(),
): Promise<TaskEventBounds> {
  const task = await requireOwnedTask(userId, taskId, client);
  const result = await client.query<TaskEventBounds>(
    `SELECT (t.next_event_seq - 1)::text AS last_event_seq,
            (SELECT min(seq)::text FROM task_events WHERE task_id=t.id) AS min_event_seq
       FROM research_tasks t
      WHERE t.id=$1`,
    [task.id],
  );
  return result.rows[0] ?? { last_event_seq: "0", min_event_seq: null };
}

export async function getTaskEvents(
  userId: string,
  taskId: string,
  after: string,
  limit = 100,
  client: Pool | PoolClient = getPool(),
): Promise<TaskEvent[]> {
  if (!/^\d+$/.test(after) || BigInt(after) < BigInt(0))
    throw new ApiError(400, "INVALID_EVENT_CURSOR", "事件游标无效。");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new ApiError(400, "INVALID_INPUT", "事件批大小无效。");
  const task = await requireOwnedTask(userId, taskId, client);
  const result = await client.query<{
    seq: string;
    type: string;
    payload_json: unknown;
  }>(
    `SELECT seq::text, type, payload_json
       FROM task_events
      WHERE task_id=$1 AND seq > $2::bigint
      ORDER BY seq
      LIMIT $3`,
    [task.id, after, limit],
  );
  return result.rows.map((row) => ({
    id: row.seq,
    event: row.type,
    data:
      row.payload_json && typeof row.payload_json === "object"
        ? (row.payload_json as Record<string, unknown>)
        : {},
  }));
}

export async function requestCancel(
  userId: string,
  taskId: string,
  pool = getPool(),
) {
  return transaction(async (client) => {
    const task = await requireOwnedTask(userId, taskId, client, true);
    // 等待行锁后，用新语句读取已提交的事件，避免联表子查询停留在等待前的快照。
    if (["succeeded", "failed", "cancelled"].includes(task.status))
      return getTask(userId, taskId, client);
    if (task.status === "running") {
      if (!task.cancel_requested_at) {
        await client.query(
          `UPDATE research_tasks
              SET cancel_requested_at=now(), stop_reason='正在停止研究。'
            WHERE id=$1`,
          [task.id],
        );
        await appendEvent(
          client,
          task.id,
          task.current_attempt_id!,
          "task.cancel_requested",
          { status: "running", reason: "user_requested" },
        );
      }
      return getTask(userId, taskId, client);
    }
    if (!task.current_attempt_id) throw new Error("TASK_WITHOUT_ATTEMPT");
    const attempt = await client.query<{ status: TaskStatus }>(
      "SELECT status FROM research_attempts WHERE task_id = $1 AND id = $2 FOR UPDATE",
      [task.id, task.current_attempt_id],
    );
    if (attempt.rows[0]?.status !== "queued")
      throw new Error("TASK_ATTEMPT_STATE_MISMATCH");
    await client.query(
      `UPDATE research_tasks SET status = 'cancelled', cancel_requested_at = now(),
      stop_reason = '用户取消了排队任务。', research_done = NULL WHERE id = $1`,
      [task.id],
    );
    await client.query(
      "UPDATE research_attempts SET status = 'cancelled', finished_at = now() WHERE id = $1",
      [task.current_attempt_id],
    );
    await appendEvent(
      client,
      task.id,
      task.current_attempt_id,
      "task.cancelled",
      { status: "cancelled", reason: "user_requested" },
    );
    // 保留 outbox 的真实投递状态；未来投递器/消费者根据 task 终态跳过。
    return getTask(userId, taskId, client);
  }, pool);
}
