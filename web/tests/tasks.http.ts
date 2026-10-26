import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { migrate } from "../scripts/migrations";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("请设置 TEST_DATABASE_URL；测试只操作随机 schema。");
const schema = `p2_http_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = new Pool({ connectionString: url.href });
const webDirectory = fileURLToPath(new URL("../", import.meta.url));
let server: ChildProcess | undefined;
let createdSchema = false;
let base: string;
let token: string;
let otherToken: string;
let userId: string;
let taskId: string;
const key = randomUUID();
const input = {
  question: "LangGraph 是什么？",
  requirements: "优先官方来源",
  depth: "quick",
  language: "zh",
};

async function launch(port: number) {
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: webDirectory,
      stdio: "ignore",
      env: {
        ...process.env,
        DATABASE_URL: url.href,
        REDIS_URL: "redis://127.0.0.1:1/0",
        APP_ORIGIN: base,
        AUTH_URL: base,
        NEXTAUTH_URL: base,
        AUTH_SECRET: randomUUID() + randomUUID(),
        AUTH_GITHUB_ID: "local-protocol-test",
        AUTH_GITHUB_SECRET: "local-protocol-test",
        MAX_ACTIVE_TASKS_PER_USER: "3",
      },
    },
  );
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null)
      throw new Error("Next.js 测试进程启动失败，请先 pnpm build。");
    try {
      if ((await fetch(`${base}/api/health/ready`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("测试服务未就绪。");
}
async function stop() {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
}
before(async () => {
  await access(new URL("../.next/BUILD_ID", import.meta.url));
  assert.match(schema, /^p2_http_[a-f0-9]{32}$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await migrate(pool);
  const sessions = [];
  for (let i = 0; i < 2; i++) {
    const id = (
      await pool.query("INSERT INTO users DEFAULT VALUES RETURNING id")
    ).rows[0].id;
    const sessionToken = randomUUID();
    await pool.query(
      'INSERT INTO sessions("userId","sessionToken",expires) VALUES($1,$2,now()+interval \'1 hour\')',
      [id, sessionToken],
    );
    sessions.push({ id, sessionToken });
  }
  userId = sessions[0].id;
  token = sessions[0].sessionToken;
  otherToken = sessions[1].sessionToken;
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  base = `http://127.0.0.1:${port}`;
  await launch(port);
});
after(async () => {
  await stop();
  await pool.end();
  if (createdSchema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

function auth(session = token) {
  return { cookie: `authjs.session-token=${session}` };
}
function write(
  body: unknown,
  overrides: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      ...auth(),
      origin: base,
      "Content-Type": "application/json",
      "X-Research-CSRF": "1",
      "Idempotency-Key": key,
      ...overrides,
    },
    body: JSON.stringify(body),
  };
}
async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.request_id, "string");
  assert.ok(!JSON.stringify(body).includes("postgresql://"));
}

test("unauthenticated reads/writes are JSON 401; CSRF, key and body validation happen before storage", async () => {
  await expectError(
    await fetch(`${base}/api/v1/research/tasks`),
    401,
    "UNAUTHENTICATED",
  );
  await expectError(
    await fetch(`${base}/api/v1/research/tasks`, { method: "POST" }),
    401,
    "UNAUTHENTICATED",
  );
  await expectError(
    await fetch(
      `${base}/api/v1/research/tasks`,
      write(input, { origin: "https://evil.example" }),
    ),
    403,
    "CSRF_REJECTED",
  );
  await expectError(
    await fetch(
      `${base}/api/v1/research/tasks`,
      write(input, { "Idempotency-Key": "" }),
    ),
    400,
    "INVALID_IDEMPOTENCY_KEY",
  );
  await expectError(
    await fetch(
      `${base}/api/v1/research/tasks`,
      write(input, { "Content-Type": "text/plain" }),
    ),
    415,
    "UNSUPPORTED_MEDIA_TYPE",
  );
  for (const invalid of [
    {},
    { question: " " },
    { question: "a", depth: "unlimited" },
    { ...input, user_id: userId },
  ]) {
    await expectError(
      await fetch(`${base}/api/v1/research/tasks`, write(invalid)),
      400,
      "INVALID_INPUT",
    );
  }
  await expectError(
    await fetch(`${base}/api/v1/research/tasks`, {
      ...write(input),
      body: "{",
    }),
    400,
    "INVALID_JSON",
  );
  await expectError(
    await fetch(
      `${base}/api/v1/research/tasks`,
      write({ question: "a".repeat(70_000) }),
    ),
    413,
    "BODY_TOO_LARGE",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM research_tasks")).rows[0].count,
    "0",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM api_idempotency")).rows[0].count,
    "0",
  );
});

test("HTTP creates 202 with Redis unreachable, replays original identity, and rejects a conflicting body", async () => {
  const responses = await Promise.all(
    Array.from({ length: 6 }, () =>
      fetch(`${base}/api/v1/research/tasks`, write(input)),
    ),
  );
  const bodies = [];
  for (const response of responses) {
    assert.equal(response.status, 202);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    const body = await response.json();
    assert.equal(response.headers.get("location"), body.status_url);
    bodies.push(body);
  }
  taskId = bodies[0].task_id;
  assert.equal(new Set(bodies.map((body) => body.task_id)).size, 1);
  assert.equal(new Set(bodies.map((body) => body.attempt_id)).size, 1);
  assert.equal(bodies[0].status, "queued");
  const detail = await (
    await fetch(`${base}/api/v1/research/tasks/${taskId}`, { headers: auth() })
  ).json();
  assert.equal(detail.research_done, null);
  assert.equal(detail.last_event_seq, "1");
  assert.equal(detail.current_attempt_id, bodies[0].attempt_id);
  assert.equal(detail.has_report, false);
  await expectError(
    await fetch(
      `${base}/api/v1/research/tasks`,
      write({ ...input, question: "different" }),
    ),
    409,
    "IDEMPOTENCY_CONFLICT",
  );
});

test("SSE returns ordered event frames and validates cursor/ownership", async () => {
  const response = await fetch(
    `${base}/api/v1/research/tasks/${taskId}/events?after=0`,
    { headers: auth() },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const reader = response.body!.getReader();
  const first = await reader.read();
  await reader.cancel();
  const frame = new TextDecoder().decode(first.value);
  assert.match(frame, /id: 1\n/);
  assert.match(frame, /event: task\.queued\n/);
  assert.match(frame, /"task_id"/);

  await expectError(
    await fetch(`${base}/api/v1/research/tasks/${taskId}/events?after=999`, {
      headers: auth(),
    }),
    400,
    "INVALID_EVENT_CURSOR",
  );
  await expectError(
    await fetch(`${base}/api/v1/research/tasks/${taskId}/events?after=0`, {
      headers: auth(otherToken),
    }),
    404,
    "TASK_NOT_FOUND",
  );
});

test("task and list ownership, bad paths/queries, quota and private responses are enforced by actual handlers", async () => {
  await expectError(
    await fetch(`${base}/api/v1/research/tasks/${taskId}`, {
      headers: auth(otherToken),
    }),
    404,
    "TASK_NOT_FOUND",
  );
  await expectError(
    await fetch(`${base}/api/v1/research/tasks/${randomUUID()}`, {
      headers: auth(),
    }),
    404,
    "TASK_NOT_FOUND",
  );
  await expectError(
    await fetch(`${base}/api/v1/research/tasks/not-uuid`, { headers: auth() }),
    400,
    "INVALID_INPUT",
  );
  const strangers = await (
    await fetch(`${base}/api/v1/research/tasks`, { headers: auth(otherToken) })
  ).json();
  assert.deepEqual(strangers, { items: [], next_cursor: null });
  for (const query of [
    "limit=101",
    "limit=1&limit=2",
    "status=invalid",
    "user_id=someone",
  ]) {
    await expectError(
      await fetch(`${base}/api/v1/research/tasks?${query}`, {
        headers: auth(),
      }),
      400,
      "INVALID_INPUT",
    );
  }
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await fetch(
          `${base}/api/v1/research/tasks`,
          write(input, { "Idempotency-Key": randomUUID() }),
        )
      ).status,
      202,
    );
  await expectError(
    await fetch(
      `${base}/api/v1/research/tasks`,
      write(input, { "Idempotency-Key": randomUUID() }),
    ),
    429,
    "ACTIVE_TASK_LIMIT",
  );
  const page = await (
    await fetch(`${base}/api/v1/research/tasks?limit=2`, { headers: auth() })
  ).json();
  assert.equal(page.items.length, 2);
  assert.ok(page.next_cursor);
  const second = await (
    await fetch(
      `${base}/api/v1/research/tasks?limit=2&cursor=${page.next_cursor}`,
      { headers: auth() },
    )
  ).json();
  assert.equal(second.items.length, 1);
  assert.equal(second.next_cursor, null);
});

test("cancellation is owner-only, idempotent and writes one terminal event", async () => {
  const path = `${base}/api/v1/research/tasks/${taskId}/cancel`;
  await expectError(
    await fetch(
      path,
      write({}, { cookie: `authjs.session-token=${otherToken}` }),
    ),
    404,
    "TASK_NOT_FOUND",
  );
  await expectError(
    await fetch(path, write({ force: true })),
    400,
    "INVALID_INPUT",
  );
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => fetch(path, write({}))),
  );
  for (const response of responses) {
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.status, "cancelled");
    assert.equal(detail.last_event_seq, "2");
  }
  const replay = await (
    await fetch(`${base}/api/v1/research/tasks`, write(input))
  ).json();
  assert.equal(replay.task_id, taskId);
  assert.equal(replay.status, "cancelled");
});

test("resume HTTP route checks owner, CSRF, checkpoint and idempotency", async () => {
  const created = await (
    await fetch(
      `${base}/api/v1/research/tasks`,
      write(input, { "Idempotency-Key": randomUUID() }),
    )
  ).json();
  const path = `${base}/api/v1/research/tasks/${created.task_id}/resume`;
  await pool.query(
    "UPDATE research_attempts SET status='failed',started_at=now()-interval '5 seconds',finished_at=now() WHERE id=$1",
    [created.attempt_id],
  );
  await pool.query("UPDATE research_tasks SET status='failed' WHERE id=$1", [
    created.task_id,
  ]);
  await expectError(
    await fetch(path, { method: "POST" }),
    401,
    "UNAUTHENTICATED",
  );
  await expectError(
    await fetch(
      path,
      write({}, { cookie: `authjs.session-token=${otherToken}` }),
    ),
    404,
    "TASK_NOT_FOUND",
  );
  await expectError(
    await fetch(path, write({}, { origin: "https://evil.example" })),
    403,
    "CSRF_REJECTED",
  );
  await expectError(await fetch(path, write({})), 409, "CHECKPOINT_NOT_FOUND");
  await pool.query(
    "CREATE TABLE checkpoints (thread_id text NOT NULL, checkpoint_ns text NOT NULL)",
  );
  const graph = (
    await pool.query<{ thread_id: string }>(
      "SELECT g.thread_id FROM research_graph_runs g JOIN research_attempts a ON a.graph_run_id=g.id WHERE a.id=$1",
      [created.attempt_id],
    )
  ).rows[0];
  await pool.query(
    "INSERT INTO checkpoints(thread_id,checkpoint_ns) VALUES($1,'')",
    [graph.thread_id],
  );
  const resumeKey = randomUUID();
  const first = await fetch(path, write({}, { "Idempotency-Key": resumeKey }));
  assert.equal(first.status, 202);
  const resumed = await first.json();
  assert.notEqual(resumed.attempt_id, created.attempt_id);
  const replay = await fetch(path, write({}, { "Idempotency-Key": resumeKey }));
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).attempt_id, resumed.attempt_id);
});

test("report, evidence and Markdown download expose only the archived snapshot", async () => {
  const source = {
    title: "Archived source",
    url: "https://example.com/source",
    snippet: "An archived excerpt.",
    content: "Archived source content.",
    fetched_at: "2026-09-27T10:00:00.000Z",
    content_hash: "hash",
    content_source: "raw_content",
    content_truncated: false,
  };
  const finding = {
    claim: "The archived claim.",
    evidence: "The archived evidence.",
    source_urls: [source.url],
  };
  await pool.query(
    `INSERT INTO research_reports
      (task_id, attempt_id, version, markdown, findings_json, sources_json,
       gaps_json, citation_warnings_json, compression_metrics_json,
       research_done, stop_reason)
     VALUES ($1,$2,1,$3,$4,$5,$6,$7,'[]',true,$8)`,
    [
      taskId,
      (
        await pool.query(
          "SELECT current_attempt_id FROM research_tasks WHERE id=$1",
          [taskId],
        )
      ).rows[0].current_attempt_id,
      `[Source](${source.url})`,
      JSON.stringify([finding]),
      JSON.stringify([source]),
      JSON.stringify([]),
      JSON.stringify([]),
      "归档完成。",
    ],
  );
  const reportResponse = await fetch(
    `${base}/api/v1/research/tasks/${taskId}/report`,
    { headers: auth() },
  );
  assert.equal(reportResponse.status, 200);
  assert.match(reportResponse.headers.get("cache-control")!, /no-store/);
  const report = await reportResponse.json();
  assert.equal(report.markdown, `[Source](${source.url})`);
  assert.equal(typeof report.report_id, "string");

  const evidenceResponse = await fetch(
    `${base}/api/v1/research/tasks/${taskId}/evidence?report_id=${report.report_id}&limit=1`,
    { headers: auth() },
  );
  assert.equal(evidenceResponse.status, 200);
  const evidence = await evidenceResponse.json();
  assert.equal(evidence.items.length, 1);
  assert.equal("content" in evidence.items[0].sources[0], false);

  const selectedResponse = await fetch(
    `${base}/api/v1/research/tasks/${taskId}/evidence?report_id=${report.report_id}&source_url=${encodeURIComponent(source.url)}`,
    { headers: auth() },
  );
  assert.equal(selectedResponse.status, 200);
  const selected = await selectedResponse.json();
  assert.equal(selected.selected_source.content, source.content);
  assert.equal(selected.selected_findings.length, 1);

  const downloadResponse = await fetch(
    `${base}/api/v1/research/tasks/${taskId}/report/download?format=markdown`,
    { headers: auth() },
  );
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get("content-type")!, /text\/markdown/);
  assert.match(
    downloadResponse.headers.get("content-disposition")!,
    /attachment/,
  );
  assert.equal(await downloadResponse.text(), `[Source](${source.url})`);

  await expectError(
    await fetch(`${base}/api/v1/research/tasks/${taskId}/report`, {
      headers: auth(otherToken),
    }),
    404,
    "TASK_NOT_FOUND",
  );
});

test("restarting Web retains task and session; expired sessions cannot read them", async () => {
  await stop();
  await launch(Number(new URL(base).port));
  const retained = await (
    await fetch(`${base}/api/v1/research/tasks/${taskId}`, { headers: auth() })
  ).json();
  assert.equal(retained.status, "cancelled");
  await pool.query(
    "UPDATE sessions SET expires=now()-interval '1 minute' WHERE \"sessionToken\"=$1",
    [token],
  );
  await expectError(
    await fetch(`${base}/api/v1/research/tasks/${taskId}`, { headers: auth() }),
    401,
    "UNAUTHENTICATED",
  );
});
