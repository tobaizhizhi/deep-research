import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { uuidSchema } from "../contracts";
import { getPool, transaction } from "./db";
import { ApiError } from "./http";

const reviewStatus = z.enum(["pending", "in_review", "completed", "cancelled"]);
const verdictSchema = z.enum([
  "confirmed",
  "needs_more_evidence",
  "not_accepted",
]);
const notesSchema = z.record(z.string(), z.unknown()).default({});

export type ReviewSummary = {
  review_id: string;
  report_id: string;
  task_id: string;
  requested_by: string;
  assigned_to: string | null;
  status: z.infer<typeof reviewStatus>;
  reason: string;
  verdict: z.infer<typeof verdictSchema> | null;
  notes: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  report_version: number;
  question: string;
};

export type ReviewDetail = ReviewSummary & {
  permissions: {
    owner: boolean;
    reviewer: boolean;
    dispatcher: boolean;
  };
  report: {
    markdown: string;
    gaps: string[];
    citation_warnings: string[];
    findings: unknown[];
    sources: unknown[];
  } | null;
  actions: Array<{
    action_id: string;
    actor_id: string;
    action: string;
    from_status: string | null;
    to_status: string | null;
    from_version: number;
    to_version: number;
    details: Record<string, unknown>;
    created_at: string;
  }>;
};

type ReviewRow = ReviewSummary & {
  markdown: string;
  gaps_json: unknown;
  citation_warnings_json: unknown;
  findings_json: unknown;
  sources_json: unknown;
};

function assertUuid(value: string, code = "INVALID_INPUT") {
  if (!uuidSchema.safeParse(value).success)
    throw new ApiError(400, code, "字段必须是 UUID。");
}

function assertKey(key: string) {
  assertUuid(key, "INVALID_IDEMPOTENCY_KEY");
}

function hashRequest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function hasRole(
  client: PoolClient,
  userId: string,
  role: "reviewer" | "dispatcher",
) {
  const result = await client.query(
    "SELECT 1 FROM user_roles WHERE user_id=$1 AND role=$2",
    [userId, role],
  );
  return Boolean(result.rowCount);
}

async function ensureUser(client: PoolClient, userId: string) {
  assertUuid(userId);
  const result = await client.query(
    "SELECT 1 FROM users WHERE id=$1 FOR UPDATE",
    [userId],
  );
  if (!result.rowCount)
    throw new ApiError(401, "UNAUTHENTICATED", "请先登录。");
}

function parseReviewRow(row: ReviewRow): ReviewSummary {
  return {
    review_id: row.review_id,
    report_id: row.report_id,
    task_id: row.task_id,
    requested_by: row.requested_by,
    assigned_to: row.assigned_to,
    status: reviewStatus.parse(row.status),
    reason: row.reason,
    verdict: row.verdict ? verdictSchema.parse(row.verdict) : null,
    notes: (row.notes as Record<string, unknown>) ?? {},
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    report_version: row.report_version,
    question: row.question,
  };
}

const reviewSelect = `
  SELECT v.id AS review_id, v.report_id, v.task_id, v.requested_by, v.assigned_to,
         v.status, v.reason, v.verdict, v.notes_json AS notes, v.version,
         to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
         to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
         to_char(v.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at,
         r.version AS report_version, t.question,
         r.markdown, r.gaps_json, r.citation_warnings_json,
         r.findings_json, r.sources_json
    FROM report_reviews v
    JOIN research_reports r ON r.id=v.report_id
    JOIN research_tasks t ON t.id=v.task_id`;

async function readReview(
  client: PoolClient,
  userId: string,
  reviewId: string,
  includeReport = true,
): Promise<ReviewDetail> {
  assertUuid(reviewId);
  const row = (
    await client.query<ReviewRow>(`${reviewSelect} WHERE v.id=$1`, [reviewId])
  ).rows[0];
  if (!row) throw new ApiError(404, "REVIEW_NOT_FOUND", "复核单不存在。");
  const dispatcher = await hasRole(client, userId, "dispatcher");
  const reviewer =
    row.assigned_to === userId && (await hasRole(client, userId, "reviewer"));
  if (row.requested_by !== userId && !dispatcher && !reviewer)
    throw new ApiError(404, "REVIEW_NOT_FOUND", "复核单不存在。");
  const actions = await client.query<ReviewDetail["actions"][number]>(
    `SELECT id AS action_id, actor_id, action, from_status, to_status,
            from_version, to_version, details_json AS details,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM review_actions WHERE review_id=$1 ORDER BY created_at ASC, id ASC`,
    [reviewId],
  );
  const summary = parseReviewRow(row);
  return {
    ...summary,
    permissions: {
      owner: row.requested_by === userId,
      reviewer,
      dispatcher,
    },
    report:
      includeReport && (row.requested_by === userId || reviewer)
        ? {
            markdown: row.markdown,
            gaps: Array.isArray(row.gaps_json)
              ? (row.gaps_json as string[])
              : [],
            citation_warnings: Array.isArray(row.citation_warnings_json)
              ? (row.citation_warnings_json as string[])
              : [],
            findings: Array.isArray(row.findings_json) ? row.findings_json : [],
            sources: Array.isArray(row.sources_json) ? row.sources_json : [],
          }
        : null,
    actions: actions.rows,
  };
}

async function getIdempotency(
  client: PoolClient,
  userId: string,
  operation: string,
  key: string,
  hash: string,
  taskId: string,
) {
  if (operation.startsWith("review.")) {
    const previous = (
      await client.query<{
        request_hash: string;
        task_id: string;
        review_id: string | null;
      }>(
        `SELECT request_hash,task_id,review_id
           FROM review_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3`,
        [userId, operation, key],
      )
    ).rows[0];
    if (!previous) return null;
    if (previous.request_hash !== hash || previous.task_id !== taskId)
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "这个操作编号已用于其他内容。",
      );
    return {
      request_hash: previous.request_hash,
      resource_id: previous.task_id,
      result_review_id: previous.review_id,
      result_feedback_id: null,
    };
  }
  const previous = (
    await client.query<{
      request_hash: string;
      resource_id: string;
      result_review_id: string | null;
      result_feedback_id: string | null;
    }>(
      `SELECT request_hash,resource_id,result_review_id,result_feedback_id
         FROM api_idempotency WHERE user_id=$1 AND operation=$2 AND key=$3`,
      [userId, operation, key],
    )
  ).rows[0];
  if (!previous) return null;
  if (previous.request_hash !== hash || previous.resource_id !== taskId)
    throw new ApiError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "这个操作编号已用于其他内容。",
    );
  return previous;
}

async function insertIdempotency(
  client: PoolClient,
  userId: string,
  operation: string,
  key: string,
  hash: string,
  taskId: string,
  reviewId: string | null,
  feedbackId: string | null,
) {
  if (operation.startsWith("review.")) {
    await client.query(
      `INSERT INTO review_idempotency
         (actor_id,operation,key,request_hash,task_id,review_id,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours')`,
      [userId, operation, key, hash, taskId, reviewId],
    );
    return;
  }
  await client.query(
    `INSERT INTO api_idempotency
       (user_id,operation,key,request_hash,resource_id,result_review_id,result_feedback_id,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '24 hours')`,
    [userId, operation, key, hash, taskId, reviewId, feedbackId],
  );
}

export async function requestReview(
  userId: string,
  taskId: string,
  reportId: string,
  reason: string,
  key: string,
  pool = getPool(),
) {
  assertUuid(taskId);
  assertUuid(reportId);
  assertKey(key);
  const trimmed = reason.trim();
  if (trimmed.length < 1 || trimmed.length > 2000)
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "复核理由长度应为 1–2000 个字符。",
    );
  const hash = hashRequest({
    task_id: taskId,
    report_id: reportId,
    reason: trimmed,
  });
  return transaction(async (client) => {
    await ensureUser(client, userId);
    const previous = await getIdempotency(
      client,
      userId,
      "research.review.create",
      key.toLowerCase(),
      hash,
      taskId,
    );
    if (previous?.result_review_id)
      return readReview(client, userId, previous.result_review_id, false);
    const report = (
      await client.query<{ report_task_id: string; owner_id: string }>(
        `SELECT r.task_id AS report_task_id,t.user_id AS owner_id
           FROM research_reports r JOIN research_tasks t ON t.id=r.task_id
          WHERE r.id=$1 AND r.task_id=$2`,
        [reportId, taskId],
      )
    ).rows[0];
    if (!report || report.owner_id !== userId)
      throw new ApiError(404, "REPORT_NOT_FOUND", "报告不存在。");
    const open = await client.query(
      "SELECT 1 FROM report_reviews WHERE report_id=$1 AND status IN ('pending','in_review')",
      [reportId],
    );
    if (open.rowCount)
      throw new ApiError(
        409,
        "REVIEW_ALREADY_OPEN",
        "这份报告已经有待处理的复核单。",
      );
    const reviewId = randomUUID();
    await client.query(
      `INSERT INTO report_reviews(id,report_id,task_id,requested_by,reason)
       VALUES($1,$2,$3,$4,$5)`,
      [reviewId, reportId, taskId, userId, trimmed],
    );
    await client.query(
      `INSERT INTO review_actions(review_id,actor_id,action,from_status,to_status,from_version,to_version,details_json)
       VALUES($1,$2,'requested',NULL,'pending',1,1,$3)`,
      [reviewId, userId, { reason: trimmed }],
    );
    await insertIdempotency(
      client,
      userId,
      "research.review.create",
      key.toLowerCase(),
      hash,
      taskId,
      reviewId,
      null,
    );
    return readReview(client, userId, reviewId, false);
  }, pool);
}

export async function listReviews(
  userId: string,
  status?: string,
  pool = getPool(),
) {
  if (!uuidSchema.safeParse(userId).success)
    throw new ApiError(401, "UNAUTHENTICATED");
  const parsedStatus = status
    ? reviewStatus.safeParse(status)
    : { success: true, data: undefined };
  if (!parsedStatus.success)
    throw new ApiError(400, "INVALID_INPUT", "复核状态不合法。");
  return transaction(async (client) => {
    await ensureUser(client, userId);
    const dispatcher = await hasRole(client, userId, "dispatcher");
    const where = dispatcher
      ? parsedStatus.data
        ? "TRUE AND v.status=$1"
        : "TRUE"
      : parsedStatus.data
        ? "(v.requested_by=$1 OR v.assigned_to=$1) AND v.status=$2"
        : "v.requested_by=$1 OR v.assigned_to=$1";
    const values = dispatcher
      ? parsedStatus.data
        ? [parsedStatus.data]
        : []
      : parsedStatus.data
        ? [userId, parsedStatus.data]
        : [userId];
    const rows = await client.query<ReviewRow>(
      `${reviewSelect}
        WHERE ${where}
        ORDER BY v.created_at DESC, v.id DESC
        LIMIT 100`,
      values,
    );
    return rows.rows.map((row) => parseReviewRow(row));
  }, pool);
}

export async function getReview(
  userId: string,
  reviewId: string,
  pool = getPool(),
) {
  return transaction((client) => readReview(client, userId, reviewId), pool);
}

export async function assignReview(
  userId: string,
  reviewId: string,
  assignedTo: string,
  expectedVersion: number,
  key: string,
  pool = getPool(),
) {
  assertUuid(reviewId);
  assertUuid(assignedTo);
  assertKey(key);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    throw new ApiError(400, "INVALID_INPUT", "expected_version 不合法。");
  const hash = hashRequest({
    review_id: reviewId,
    assigned_to: assignedTo,
    expected_version: expectedVersion,
  });
  return transaction(async (client) => {
    await ensureUser(client, userId);
    if (!(await hasRole(client, userId, "dispatcher")))
      throw new ApiError(
        403,
        "REVIEW_FORBIDDEN",
        "只有分派人员可以分派复核单。",
      );
    const target = await hasRole(client, assignedTo, "reviewer");
    if (!target)
      throw new ApiError(
        400,
        "INVALID_REVIEWER",
        "指定用户没有 reviewer 权限。",
      );
    const row = (
      await client.query<{
        task_id: string;
        status: string;
        version: number;
        assigned_to: string | null;
      }>(
        "SELECT task_id,status,version,assigned_to FROM report_reviews WHERE id=$1 FOR UPDATE",
        [reviewId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "REVIEW_NOT_FOUND", "复核单不存在。");
    const previous = await getIdempotency(
      client,
      userId,
      "review.assign",
      key.toLowerCase(),
      hash,
      row.task_id,
    );
    if (previous?.result_review_id)
      return readReview(client, userId, previous.result_review_id, false);
    if (row.version !== expectedVersion)
      throw new ApiError(
        409,
        "REVIEW_VERSION_CONFLICT",
        "复核单已更新，请刷新后再操作。",
      );
    if (row.status === "completed" || row.status === "cancelled")
      throw new ApiError(
        409,
        "REVIEW_NOT_ASSIGNABLE",
        "已结案的复核单不能重新分派。",
      );
    const nextVersion = row.version + 1;
    await client.query(
      "UPDATE report_reviews SET assigned_to=$1,status='in_review',version=$2 WHERE id=$3",
      [assignedTo, nextVersion, reviewId],
    );
    await client.query(
      `INSERT INTO review_actions(review_id,actor_id,action,from_status,to_status,from_version,to_version,details_json)
       VALUES($1,$2,'assigned',$3,'in_review',$4,$5,$6)`,
      [
        reviewId,
        userId,
        row.status,
        row.version,
        nextVersion,
        { assigned_to: assignedTo },
      ],
    );
    await insertIdempotency(
      client,
      userId,
      "review.assign",
      key.toLowerCase(),
      hash,
      row.task_id,
      reviewId,
      null,
    );
    return readReview(client, userId, reviewId, false);
  }, pool);
}

export async function decideReview(
  userId: string,
  reviewId: string,
  verdict: string,
  notes: Record<string, unknown>,
  expectedVersion: number,
  key: string,
  pool = getPool(),
) {
  assertUuid(reviewId);
  assertKey(key);
  const parsedVerdict = verdictSchema.safeParse(verdict);
  if (!parsedVerdict.success)
    throw new ApiError(400, "INVALID_INPUT", "复核结论不合法。");
  const parsedNotes = notesSchema.safeParse(notes);
  if (!parsedNotes.success)
    throw new ApiError(400, "INVALID_INPUT", "复核说明必须是对象。");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    throw new ApiError(400, "INVALID_INPUT", "expected_version 不合法。");
  const hash = hashRequest({
    review_id: reviewId,
    verdict: parsedVerdict.data,
    notes: parsedNotes.data,
    expected_version: expectedVersion,
  });
  return transaction(async (client) => {
    await ensureUser(client, userId);
    if (!(await hasRole(client, userId, "reviewer")))
      throw new ApiError(
        403,
        "REVIEW_FORBIDDEN",
        "只有 reviewer 可以提交结论。",
      );
    const row = (
      await client.query<{
        task_id: string;
        status: string;
        version: number;
        assigned_to: string | null;
      }>(
        "SELECT task_id,status,version,assigned_to FROM report_reviews WHERE id=$1 FOR UPDATE",
        [reviewId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "REVIEW_NOT_FOUND", "复核单不存在。");
    const previous = await getIdempotency(
      client,
      userId,
      "review.decision",
      key.toLowerCase(),
      hash,
      row.task_id,
    );
    if (previous?.result_review_id)
      return readReview(client, userId, previous.result_review_id, false);
    if (row.assigned_to !== userId)
      throw new ApiError(403, "REVIEW_FORBIDDEN", "这份复核单尚未分派给你。");
    if (row.version !== expectedVersion)
      throw new ApiError(
        409,
        "REVIEW_VERSION_CONFLICT",
        "复核单已更新，请刷新后再操作。",
      );
    if (row.status !== "in_review")
      throw new ApiError(409, "REVIEW_NOT_DECIDABLE", "当前状态不能提交结论。");
    const nextVersion = row.version + 1;
    await client.query(
      "UPDATE report_reviews SET status='completed',verdict=$1,notes_json=$2,version=$3,completed_at=now() WHERE id=$4",
      [parsedVerdict.data, parsedNotes.data, nextVersion, reviewId],
    );
    await client.query(
      `INSERT INTO review_actions(review_id,actor_id,action,from_status,to_status,from_version,to_version,details_json)
       VALUES($1,$2,'decision','in_review','completed',$3,$4,$5)`,
      [
        reviewId,
        userId,
        row.version,
        nextVersion,
        { verdict: parsedVerdict.data, notes: parsedNotes.data },
      ],
    );
    await insertIdempotency(
      client,
      userId,
      "review.decision",
      key.toLowerCase(),
      hash,
      row.task_id,
      reviewId,
      null,
    );
    return readReview(client, userId, reviewId, false);
  }, pool);
}

export async function addFeedback(
  userId: string,
  taskId: string,
  reportId: string,
  feedbackText: string,
  key: string,
  pool = getPool(),
) {
  assertUuid(taskId);
  assertUuid(reportId);
  assertKey(key);
  const text = feedbackText.trim();
  if (text.length < 1 || text.length > 4000)
    throw new ApiError(400, "INVALID_INPUT", "反馈长度应为 1–4000 个字符。");
  const hash = hashRequest({
    task_id: taskId,
    report_id: reportId,
    feedback: text,
  });
  return transaction(async (client) => {
    await ensureUser(client, userId);
    const previous = await getIdempotency(
      client,
      userId,
      "research.feedback",
      key.toLowerCase(),
      hash,
      taskId,
    );
    if (previous?.result_feedback_id)
      return {
        feedback_id: previous.result_feedback_id,
        task_id: taskId,
        report_id: reportId,
      };
    const report = (
      await client.query<{ owner_id: string }>(
        `SELECT t.user_id AS owner_id FROM research_reports r JOIN research_tasks t ON t.id=r.task_id
        WHERE r.id=$1 AND r.task_id=$2`,
        [reportId, taskId],
      )
    ).rows[0];
    if (!report || report.owner_id !== userId)
      throw new ApiError(404, "REPORT_NOT_FOUND", "报告不存在。");
    const feedbackId = randomUUID();
    await client.query(
      "INSERT INTO report_feedback(id,report_id,task_id,user_id,feedback_text) VALUES($1,$2,$3,$4,$5)",
      [feedbackId, reportId, taskId, userId, text],
    );
    await insertIdempotency(
      client,
      userId,
      "research.feedback",
      key.toLowerCase(),
      hash,
      taskId,
      null,
      feedbackId,
    );
    return { feedback_id: feedbackId, task_id: taskId, report_id: reportId };
  }, pool);
}
