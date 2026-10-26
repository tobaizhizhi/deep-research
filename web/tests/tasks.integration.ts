import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { migrate } from "../scripts/migrations";
import {
  createTask,
  getEvidence,
  getReport,
  getTask,
  getTaskEventBounds,
  getTaskEvents,
  listTasks,
  requestCancel,
  resumeTask,
  retryTask,
} from "../lib/server/tasks";
import { ApiError } from "../lib/server/http";
import { researchJobSchema } from "../lib/contracts";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("请设置 TEST_DATABASE_URL；测试仅操作随机隔离 schema。");
const schema = `p2_tasks_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = new Pool({ connectionString: url.href, max: 8 });
const input = { question: "LangGraph 是什么？" };
process.env.MAX_ACTIVE_TASKS_PER_USER = "3";
before(async () => {
  assert.match(schema, /^p2_tasks_[a-f0-9]{32}$/);
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
const code = (expected: string) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;
async function counts() {
  const result = await pool.query(`SELECT
    (SELECT count(*) FROM research_tasks) AS tasks,
    (SELECT count(*) FROM research_attempts) AS attempts,
    (SELECT count(*) FROM task_outbox) AS outbox,
    (SELECT count(*) FROM task_events) AS events,
    (SELECT count(*) FROM api_idempotency) AS idempotency`);
  return result.rows[0];
}

test("create atomically freezes input/config, links attempt, outbox, event and idempotency", async () => {
  const owner = await user();
  const key = randomUUID();
  const result = await createTask(owner, input, key, pool);
  const task = await getTask(owner, result.task_id, pool);
  assert.equal(task.status, "queued");
  assert.equal(task.current_attempt_id, result.attempt_id);
  assert.equal(task.research_done, null);
  assert.equal(task.last_event_seq, "1");
  assert.equal(task.min_event_seq, "1");
  assert.equal(task.latest_event_type, "task.queued");
  assert.equal(task.has_report, false);
  const raw = (
    await pool.query("SELECT * FROM research_tasks WHERE id = $1", [
      result.task_id,
    ])
  ).rows[0];
  assert.equal(raw.config_json.max_search_rounds, 2);
  assert.equal(raw.config_json.total_timeout_seconds, 600);
  const outbox = (
    await pool.query("SELECT * FROM task_outbox WHERE task_id = $1", [
      result.task_id,
    ])
  ).rows[0];
  const job = researchJobSchema.parse(outbox.payload_json);
  assert.equal(job.message_id, outbox.id);
  assert.equal(job.attempt_id, result.attempt_id);
  assert.equal(outbox.state, "pending");
  const retained = (
    await pool.query(
      "SELECT expires_at - created_at >= interval '24 hours' AS enough FROM api_idempotency WHERE user_id = $1 AND key = $2",
      [owner, key],
    )
  ).rows[0];
  assert.equal(retained.enough, true);
});

test("event bounds and cursor reads preserve order and task ownership", async () => {
  const owner = await user();
  const stranger = await user();
  const task = await createTask(owner, input, randomUUID(), pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE research_tasks SET next_event_seq = next_event_seq + 1 WHERE id = $1",
      [task.task_id],
    );
    await client.query(
      `INSERT INTO task_events(task_id, seq, attempt_id, type, payload_json)
       VALUES ($1, 2, $2, 'researcher.started', $3)`,
      [
        task.task_id,
        task.attempt_id,
        {
          schema_version: 1,
          task_id: task.task_id,
          attempt_id: task.attempt_id,
          researcher_id: `${task.attempt_id}:b1:r1`,
          topic: "StateGraph",
        },
      ],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  assert.deepEqual(await getTaskEventBounds(owner, task.task_id, pool), {
    last_event_seq: "2",
    min_event_seq: "1",
  });
  const all = await getTaskEvents(owner, task.task_id, "0", 10, pool);
  assert.deepEqual(
    all.map((event) => [event.id, event.event]),
    [
      ["1", "task.queued"],
      ["2", "researcher.started"],
    ],
  );
  const resumed = await getTaskEvents(owner, task.task_id, "1", 10, pool);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].id, "2");
  assert.equal(resumed[0].data.researcher_id, `${task.attempt_id}:b1:r1`);
  await assert.rejects(
    getTaskEvents(stranger, task.task_id, "0", 10, pool),
    code("TASK_NOT_FOUND"),
  );
});

test("failed tasks retry from the frozen snapshot and retry is idempotent", async () => {
  const owner = await user();
  const original = await createTask(owner, input, randomUUID(), pool);
  await pool.query(
    `UPDATE research_tasks
        SET status='failed', stop_reason='模拟失败', research_done=NULL
      WHERE id=$1`,
    [original.task_id],
  );
  await pool.query(
    `UPDATE research_attempts
        SET status='failed', finished_at=now(), error_code='MODEL_ERROR'
      WHERE id=$1`,
    [original.attempt_id],
  );

  const key = randomUUID();
  const retried = await retryTask(owner, original.task_id, key, pool);
  assert.equal(retried.status, "queued");
  assert.notEqual(retried.attempt_id, original.attempt_id);

  const rows = (
    await pool.query(
      `SELECT a.number, a.status, t.current_attempt_id, t.config_json,
              o.state, e.type
         FROM research_attempts a
         JOIN research_tasks t ON t.id=a.task_id
         JOIN task_outbox o ON o.attempt_id=a.id
         JOIN task_events e ON e.task_id=t.id AND e.attempt_id=a.id
        WHERE a.id=$1
        ORDER BY e.seq DESC LIMIT 1`,
      [retried.attempt_id],
    )
  ).rows[0];
  assert.equal(rows.number, 2);
  assert.equal(rows.status, "queued");
  assert.equal(rows.current_attempt_id, retried.attempt_id);
  assert.equal(rows.state, "pending");
  assert.equal(rows.type, "task.retry_queued");
  assert.equal(rows.config_json.max_search_rounds, 2);
  assert.equal(
    (
      await pool.query("SELECT status FROM research_attempts WHERE id=$1", [
        original.attempt_id,
      ])
    ).rows[0].status,
    "failed",
  );

  const replay = await retryTask(owner, original.task_id, key, pool);
  assert.equal(replay.attempt_id, retried.attempt_id);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM research_attempts WHERE task_id=$1",
        [original.task_id],
      )
    ).rows[0].count,
    "2",
  );
});

test("many simultaneous requests with the same key create exactly one resource", async () => {
  const owner = await user();
  const key = randomUUID();
  const before = await counts();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => createTask(owner, input, key, pool)),
  );
  assert.equal(new Set(results.map((result) => result.task_id)).size, 1);
  assert.equal(new Set(results.map((result) => result.attempt_id)).size, 1);
  const after = await counts();
  for (const field of Object.keys(before))
    assert.equal(Number(after[field]) - Number(before[field]), 1, field);
  const normalized = await createTask(
    owner,
    {
      depth: "standard",
      language: "auto",
      requirements: "  ",
      question: ` \n${input.question}\t`,
    },
    key.toUpperCase(),
    pool,
  );
  assert.equal(normalized.task_id, results[0].task_id);
  await assert.rejects(
    createTask(owner, { question: "另一个问题" }, key, pool),
    code("IDEMPOTENCY_CONFLICT"),
  );
  const other = await createTask(await user(), input, key, pool);
  assert.notEqual(other.task_id, results[0].task_id);
});

test("different keys cannot race past the active quota; replay consumes no quota", async () => {
  const owner = await user();
  const keys = Array.from({ length: 10 }, () => randomUUID());
  const outcomes = await Promise.allSettled(
    keys.map((key) => createTask(owner, input, key, pool)),
  );
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    3,
  );
  for (const result of outcomes)
    if (result.status === "rejected")
      assert.equal(result.reason.code, "ACTIVE_TASK_LIMIT");
  const index = outcomes.findIndex((result) => result.status === "fulfilled");
  const original = (
    outcomes[index] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof createTask>>
    >
  ).value;
  const replay = await createTask(owner, input, keys[index], pool);
  assert.equal(replay.task_id, original.task_id);
  await requestCancel(owner, original.task_id, pool);
  await createTask(owner, input, randomUUID(), pool);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM research_tasks WHERE user_id=$1 AND status='queued'",
        [owner],
      )
    ).rows[0].count,
    "3",
  );
});

test("replay returns original attempt and never rebuilds a changed model configuration", async () => {
  const owner = await user();
  const key = randomUUID();
  const original = await createTask(owner, input, key, pool);
  await requestCancel(owner, original.task_id, pool);
  const newAttempt = randomUUID();
  await pool.query(
    "INSERT INTO research_attempts(id,task_id,number,graph_run_id) VALUES($1,$2,2,(SELECT graph_run_id FROM research_attempts WHERE id=$3))",
    [newAttempt, original.task_id, original.attempt_id],
  );
  await pool.query(
    "UPDATE research_tasks SET current_attempt_id=$1 WHERE id=$2",
    [newAttempt, original.task_id],
  );
  const prior = process.env.RESEARCH_MODEL_NAME;
  process.env.RESEARCH_MODEL_NAME = "intentionally invalid profile";
  try {
    const replay = await createTask(owner, input, key, pool);
    assert.equal(replay.attempt_id, original.attempt_id);
    assert.equal(replay.status, "cancelled");
  } finally {
    if (prior === undefined) delete process.env.RESEARCH_MODEL_NAME;
    else process.env.RESEARCH_MODEL_NAME = prior;
  }
});

test("resume requires a checkpoint and exclusive graph, keeps the run, and is idempotent", async () => {
  const owner = await user();
  const stranger = await user();
  const created = await createTask(owner, input, randomUUID(), pool);
  const graph = (
    await pool.query<{ id: string; thread_id: string }>(
      `SELECT g.id,g.thread_id FROM research_graph_runs g
       JOIN research_attempts a ON a.graph_run_id=g.id WHERE a.id=$1`,
      [created.attempt_id],
    )
  ).rows[0];
  await pool.query(
    `UPDATE research_attempts SET status='failed',started_at=now()-interval '10 seconds',
     finished_at=now(),error_code='WORKER_LOST' WHERE id=$1`,
    [created.attempt_id],
  );
  await pool.query("UPDATE research_tasks SET status='failed' WHERE id=$1", [
    created.task_id,
  ]);
  const key = randomUUID();
  await assert.rejects(
    resumeTask(owner, created.task_id, key, pool),
    code("CHECKPOINT_NOT_FOUND"),
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS checkpoints (thread_id text NOT NULL, checkpoint_ns text NOT NULL)",
  );
  await pool.query(
    "INSERT INTO checkpoints(thread_id,checkpoint_ns) VALUES($1,'')",
    [graph.thread_id],
  );
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      graph.thread_id,
    ]);
    await assert.rejects(
      resumeTask(owner, created.task_id, key, pool),
      code("GRAPH_RUN_IN_USE"),
    );
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
      graph.thread_id,
    ]);
    lock.release();
  }
  await assert.rejects(
    resumeTask(stranger, created.task_id, randomUUID(), pool),
    code("TASK_NOT_FOUND"),
  );
  const resumed = await resumeTask(owner, created.task_id, key, pool);
  assert.notEqual(resumed.attempt_id, created.attempt_id);
  assert.equal(
    (await resumeTask(owner, created.task_id, key, pool)).attempt_id,
    resumed.attempt_id,
  );
  const attempt = (
    await pool.query<{
      graph_run_id: string;
      resume_from_checkpoint: boolean;
      status: string;
    }>(
      "SELECT graph_run_id,resume_from_checkpoint,status FROM research_attempts WHERE id=$1",
      [resumed.attempt_id],
    )
  ).rows[0];
  assert.equal(attempt.graph_run_id, graph.id);
  assert.equal(attempt.resume_from_checkpoint, true);
  assert.equal(attempt.status, "queued");
  assert.equal(
    (
      await pool.query(
        "SELECT resume_count FROM research_graph_runs WHERE id=$1",
        [graph.id],
      )
    ).rows[0].resume_count,
    1,
  );
});

test("failure in the last insert rolls back task, attempt, event, and outbox; retry then succeeds", async () => {
  const owner = await user();
  const key = randomUUID();
  await pool.query(`CREATE FUNCTION fail_creation_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.key = '${key}' THEN RAISE EXCEPTION 'injected transaction failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER fail_creation_probe BEFORE INSERT ON api_idempotency FOR EACH ROW EXECUTE FUNCTION fail_creation_probe();`);
  const before = await counts();
  try {
    await assert.rejects(
      createTask(owner, input, key, pool),
      /injected transaction failure/,
    );
    assert.deepEqual(await counts(), before);
  } finally {
    await pool.query(
      "DROP TRIGGER fail_creation_probe ON api_idempotency; DROP FUNCTION fail_creation_probe();",
    );
  }
  assert.equal((await createTask(owner, input, key, pool)).status, "queued");
});

test("malformed and missing input create nothing; open questions do not need fake clarification", async () => {
  const owner = await user();
  const before = await counts();
  for (const invalid of [
    {},
    { question: " " },
    { question: "a", depth: "unlimited" },
    { question: "a", user_id: owner },
  ])
    await assert.rejects(
      createTask(owner, invalid, randomUUID(), pool),
      code("INVALID_INPUT"),
    );
  await assert.rejects(
    createTask(owner, input, "missing-uuid", pool),
    code("INVALID_IDEMPOTENCY_KEY"),
  );
  assert.deepEqual(await counts(), before);
  await createTask(owner, { question: "LangGraph 是什么" }, randomUUID(), pool);
});

test("pagination is stable at equal timestamps and microseconds, scoped to user and status", async () => {
  const owner = await user();
  const other = await user();
  const created = [];
  for (let i = 0; i < 6; i++) {
    const task = await createTask(
      owner,
      { question: `问题${i}` },
      randomUUID(),
      pool,
    );
    await requestCancel(owner, task.task_id, pool);
    created.push(task.task_id);
    await pool.query("UPDATE research_tasks SET created_at=$1 WHERE id=$2", [
      `2026-09-26T08:00:00.${i < 3 ? "000001" : "000002"}Z`,
      task.task_id,
    ]);
  }
  await createTask(other, input, randomUUID(), pool);
  let cursor: string | undefined;
  const seen: string[] = [];
  do {
    const page = await listTasks(
      owner,
      { limit: 2, status: "cancelled", cursor },
      pool,
    );
    seen.push(...page.items.map((item) => item.task_id));
    assert.ok(
      page.items.every(
        (item) =>
          item.status === "cancelled" && !Object.hasOwn(item, "config_json"),
      ),
    );
    if (page.next_cursor) {
      await assert.rejects(
        listTasks(
          other,
          { limit: 2, status: "cancelled", cursor: page.next_cursor },
          pool,
        ),
        code("INVALID_CURSOR"),
      );
      await assert.rejects(
        listTasks(owner, { limit: 2, cursor: page.next_cursor }, pool),
        code("INVALID_CURSOR"),
      );
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  assert.equal(seen.length, 6);
  assert.deepEqual([...seen].sort(), created.sort());
  const ordered = (
    await pool.query(
      "SELECT id FROM research_tasks WHERE user_id=$1 ORDER BY created_at DESC,id DESC",
      [owner],
    )
  ).rows.map((row) => row.id);
  assert.deepEqual(seen, ordered);
  await assert.rejects(
    listTasks(owner, { limit: 20, cursor: "not-json" }, pool),
    code("INVALID_CURSOR"),
  );
});

test("concurrent queued cancellations make one terminal event, both states match, outbox is preserved", async () => {
  const owner = await user();
  const task = await createTask(owner, input, randomUUID(), pool);
  const cancelled = await Promise.all(
    Array.from({ length: 8 }, () => requestCancel(owner, task.task_id, pool)),
  );
  for (const result of cancelled) {
    assert.equal(result.status, "cancelled");
    assert.equal(result.research_done, null);
    assert.equal(result.last_event_seq, "2");
    assert.equal(result.latest_event_type, "task.cancelled");
  }
  const attempt = (
    await pool.query(
      "SELECT status,finished_at FROM research_attempts WHERE id=$1",
      [task.attempt_id],
    )
  ).rows[0];
  assert.equal(attempt.status, "cancelled");
  assert.ok(attempt.finished_at);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM task_events WHERE task_id=$1 AND type='task.cancelled'",
        [task.task_id],
      )
    ).rows[0].count,
    "1",
  );
  assert.equal(
    (
      await pool.query("SELECT state FROM task_outbox WHERE task_id=$1", [
        task.task_id,
      ])
    ).rows[0].state,
    "pending",
  );
});

test("foreign task reads/cancels are 404; running cancel requests stop; failed detail hides raw errors", async () => {
  const owner = await user();
  const stranger = await user();
  const task = await createTask(owner, input, randomUUID(), pool);
  await assert.rejects(
    getTask(stranger, task.task_id, pool),
    code("TASK_NOT_FOUND"),
  );
  await assert.rejects(
    requestCancel(stranger, task.task_id, pool),
    code("TASK_NOT_FOUND"),
  );
  await pool.query("UPDATE research_tasks SET status='running' WHERE id=$1", [
    task.task_id,
  ]);
  await pool.query(
    "UPDATE research_attempts SET status='running' WHERE id=$1",
    [task.attempt_id],
  );
  const stopping = await requestCancel(owner, task.task_id, pool);
  assert.equal(stopping.status, "running");
  assert.ok(stopping.cancel_requested_at);
  assert.equal(stopping.latest_event_type, "task.cancel_requested");
  await pool.query("UPDATE research_tasks SET status='failed' WHERE id=$1", [
    task.task_id,
  ]);
  await pool.query(
    "UPDATE research_attempts SET status='failed',error_code='secret provider details',error_detail='fake-private-token' WHERE id=$1",
    [task.attempt_id],
  );
  const detail = await requestCancel(owner, task.task_id, pool);
  assert.equal(detail.error?.code, "RESEARCH_FAILED");
  assert.ok(!JSON.stringify(detail).includes("secret provider"));
  assert.ok(!JSON.stringify(detail).includes("fake-private-token"));
  assert.equal(detail.last_event_seq, "2");
});

test("event insertion failure rolls back cancellation as a whole", async () => {
  const owner = await user();
  const task = await createTask(owner, input, randomUUID(), pool);
  await pool.query(`CREATE FUNCTION fail_cancel_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.type = 'task.cancelled' THEN RAISE EXCEPTION 'injected cancellation failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER fail_cancel_probe BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION fail_cancel_probe();`);
  try {
    await assert.rejects(
      requestCancel(owner, task.task_id, pool),
      /injected cancellation failure/,
    );
    const detail = await getTask(owner, task.task_id, pool);
    assert.equal(detail.status, "queued");
    assert.equal(detail.cancel_requested_at, null);
    assert.equal(detail.last_event_seq, "1");
    assert.equal(
      (
        await pool.query("SELECT status FROM research_attempts WHERE id=$1", [
          task.attempt_id,
        ])
      ).rows[0].status,
      "queued",
    );
  } finally {
    await pool.query(
      "DROP TRIGGER fail_cancel_probe ON task_events; DROP FUNCTION fail_cancel_probe();",
    );
  }
});

test("report and evidence reads use the archived snapshot, paginate findings, and enforce ownership", async () => {
  const owner = await user();
  const stranger = await user();
  const task = await createTask(owner, input, randomUUID(), pool);
  await assert.rejects(
    getReport(owner, task.task_id, pool),
    code("REPORT_NOT_READY"),
  );

  const source = {
    title: "Official source",
    url: "https://example.com/langgraph",
    snippet: "A short excerpt.",
    content: "x".repeat(25_000),
    fetched_at: "2026-09-27T10:00:00.000Z",
    content_hash: "hash",
    content_source: "raw_content",
    content_truncated: false,
  };
  const findings = [
    {
      claim: "LangGraph uses a graph structure.",
      evidence: "The source describes a graph structure.",
      source_urls: [source.url],
    },
    {
      claim: "LangGraph supports stateful workflows.",
      evidence: "The source describes stateful workflows.",
      source_urls: [source.url],
    },
  ];
  await pool.query(
    `INSERT INTO research_reports
      (task_id, attempt_id, version, markdown, findings_json, sources_json,
       gaps_json, citation_warnings_json, compression_metrics_json,
       research_done, stop_reason)
     VALUES ($1,$2,1,$3,$4,$5,$6,$7,'[]',true,$8)`,
    [
      task.task_id,
      task.attempt_id,
      "# Report\n\nA report.",
      JSON.stringify(findings),
      JSON.stringify([source]),
      JSON.stringify([]),
      JSON.stringify([]),
      "证据已足够。",
    ],
  );

  const report = await getReport(owner, task.task_id, pool);
  assert.equal(report.task_id, task.task_id);
  assert.equal(report.version, 1);
  assert.equal(report.markdown, "# Report\n\nA report.");

  const first = await getEvidence(
    owner,
    task.task_id,
    { report_id: report.report_id, limit: 1 },
    pool,
  );
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].finding_id, 1);
  assert.equal(first.items[0].sources[0].url, source.url);
  assert.equal("content" in first.items[0].sources[0], false);
  assert.ok(first.next_cursor);

  const second = await getEvidence(
    owner,
    task.task_id,
    { report_id: report.report_id, limit: 1, cursor: first.next_cursor! },
    pool,
  );
  assert.equal(second.items[0].finding_id, 2);
  assert.equal(second.next_cursor, null);

  const selected = await getEvidence(
    owner,
    task.task_id,
    { report_id: report.report_id, limit: 1, source_url: source.url },
    pool,
  );
  assert.equal(selected.selected_source?.content?.length, 20_000);
  assert.equal(selected.selected_findings.length, 2);

  await assert.rejects(
    getReport(stranger, task.task_id, pool),
    code("TASK_NOT_FOUND"),
  );
  await assert.rejects(
    getEvidence(
      stranger,
      task.task_id,
      { report_id: report.report_id, limit: 1 },
      pool,
    ),
    code("TASK_NOT_FOUND"),
  );
});
