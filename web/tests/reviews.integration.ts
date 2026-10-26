import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";
import { migrate } from "../scripts/migrations";
import { createTask } from "../lib/server/tasks";
import {
  addFeedback,
  assignReview,
  decideReview,
  getReview,
  listReviews,
  requestReview,
} from "../lib/server/review-service";
import { ApiError } from "../lib/server/http";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("请设置 TEST_DATABASE_URL；测试仅操作随机隔离 schema。");
const schema = `p8_reviews_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = new Pool({ connectionString: url.href, max: 8 });

before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

async function user() {
  return (
    await pool.query<{ id: string }>(
      "INSERT INTO users DEFAULT VALUES RETURNING id",
    )
  ).rows[0].id;
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof ApiError && error.code === expected;
}

test("P8 review request, role-gated assignment, versioned decision and feedback", async () => {
  const owner = await user();
  const reviewer = await user();
  const dispatcher = await user();
  const stranger = await user();
  await pool.query(
    "INSERT INTO user_roles(user_id,role) VALUES($1,'reviewer'),($2,'dispatcher')",
    [reviewer, dispatcher],
  );
  const task = await createTask(
    owner,
    { question: "P8 review fixture" },
    randomUUID(),
    pool,
  );
  const reportId = randomUUID();
  await pool.query(
    `INSERT INTO research_reports
      (id,task_id,attempt_id,version,markdown,findings_json,sources_json,gaps_json,citation_warnings_json,compression_metrics_json,research_done,stop_reason)
     VALUES($1,$2,$3,1,'A report',$4,$5,$6,$7,$8,true,'done')`,
    [
      reportId,
      task.task_id,
      task.attempt_id,
      JSON.stringify([
        { claim: "claim", evidence: "evidence", source_urls: [] },
      ]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
    ],
  );

  const requested = await requestReview(
    owner,
    task.task_id,
    reportId,
    "核对关键结论的支持证据",
    randomUUID(),
    pool,
  );
  assert.equal(requested.status, "pending");
  assert.equal((await listReviews(owner, undefined, pool)).length, 1);
  assert.equal((await listReviews(stranger, undefined, pool)).length, 0);
  assert.equal((await listReviews(dispatcher, "pending", pool)).length, 1);
  assert.equal((await listReviews(dispatcher, undefined, pool)).length, 1);
  await assert.rejects(
    getReview(stranger, requested.review_id, pool),
    code("REVIEW_NOT_FOUND"),
  );
  assert.equal(
    (await getReview(dispatcher, requested.review_id, pool)).report,
    null,
  );

  const assigned = await assignReview(
    dispatcher,
    requested.review_id,
    reviewer,
    1,
    randomUUID(),
    pool,
  );
  assert.equal(assigned.status, "in_review");
  assert.equal(assigned.assigned_to, reviewer);
  const reviewerView = await getReview(reviewer, requested.review_id, pool);
  assert.equal(reviewerView.permissions.reviewer, true);
  assert.equal(reviewerView.report?.markdown, "A report");

  const decisionKey = randomUUID();
  await assert.rejects(
    decideReview(
      reviewer,
      requested.review_id,
      "confirmed",
      {},
      1,
      randomUUID(),
      pool,
    ),
    code("REVIEW_VERSION_CONFLICT"),
  );
  const decided = await decideReview(
    reviewer,
    requested.review_id,
    "needs_more_evidence",
    { text: "请补充一条独立来源" },
    2,
    decisionKey,
    pool,
  );
  assert.equal(decided.status, "completed");
  assert.equal(decided.verdict, "needs_more_evidence");
  assert.equal(
    (
      await decideReview(
        reviewer,
        requested.review_id,
        "needs_more_evidence",
        { text: "请补充一条独立来源" },
        2,
        decisionKey,
        pool,
      )
    ).version,
    3,
  );
  await assert.rejects(
    decideReview(
      reviewer,
      requested.review_id,
      "confirmed",
      {},
      3,
      randomUUID(),
      pool,
    ),
    code("REVIEW_NOT_DECIDABLE"),
  );

  const feedbackKey = randomUUID();
  const feedback = await addFeedback(
    owner,
    task.task_id,
    reportId,
    "希望后续比较更多来源",
    feedbackKey,
    pool,
  );
  assert.equal(
    (
      await addFeedback(
        owner,
        task.task_id,
        reportId,
        "希望后续比较更多来源",
        feedbackKey,
        pool,
      )
    ).feedback_id,
    feedback.feedback_id,
  );

  const followup = await createTask(
    owner,
    {
      question: "请补查独立来源",
      parent_report_id: reportId,
      review_id: requested.review_id,
    },
    randomUUID(),
    pool,
  );
  const relation = (
    await pool.query(
      "SELECT parent_report_id,review_id FROM research_tasks WHERE id=$1",
      [followup.task_id],
    )
  ).rows[0];
  assert.equal(relation.parent_report_id, reportId);
  assert.equal(relation.review_id, requested.review_id);
});
