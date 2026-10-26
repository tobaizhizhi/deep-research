import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import { createAuthAdapter } from "../lib/server/auth-adapter";
import { getPool, transaction, checkDatabaseReady } from "../lib/server/db";
import { migrate, migrationsDirectory } from "../scripts/migrations";
import { requireOwnedTask } from "../lib/server/tasks";
import { ApiError } from "../lib/server/http";
import { buildResearchConfig } from "../lib/server/research-config";
import {
  GET as authGET,
  POST as authPOST,
} from "../app/api/auth/[...nextauth]/route";

// 显式指定测试目标，绝不默默连接开发 DATABASE_URL。
if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "请设置 TEST_DATABASE_URL；测试只创建并清理自己的随机 schema。",
  );
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const schema = `p2_test_${randomUUID().replaceAll("-", "")}`;
const testURL = new URL(process.env.TEST_DATABASE_URL);
testURL.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = testURL.href;
process.env.APP_ORIGIN = "http://localhost:3000";
// 只测试本地会话协议；不会访问 GitHub，也不提供任何测试登录接口。
process.env.AUTH_SECRET = randomUUID() + randomUUID();
process.env.AUTH_GITHUB_ID = "local-protocol-test";
process.env.AUTH_GITHUB_SECRET = "local-protocol-test";
const pool = getPool();
const adapter = createAuthAdapter(pool);
let createdSchema = false;
let firstUser: string;
let secondUser: string;
let firstTask: string;
let secondTask: string;
let firstAttempt: string;

before(async () => {
  assert.match(schema, /^p2_test_[0-9a-f]{32}$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
});

after(async () => {
  await pool.end();
  if (createdSchema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

test("concurrent migrations apply once and readiness requires migrations", async () => {
  await assert.rejects(checkDatabaseReady(pool));
  const results = await Promise.all([migrate(pool), migrate(pool)]);
  assert.equal(results.flat().length, 8);
  assert.equal(await checkDatabaseReady(pool), true);
  assert.deepEqual(await migrate(pool), []);
});

test("P7 migration backfills existing P6 tasks and attempts", async () => {
  const upgradeSchema = `p7_upgrade_${randomUUID().replaceAll("-", "")}`;
  const legacyFiles = await mkdtemp(join(tmpdir(), "research-p6-migrations-"));
  const upgradeURL = new URL(process.env.TEST_DATABASE_URL!);
  upgradeURL.searchParams.set("options", `-c search_path=${upgradeSchema}`);
  const upgradePool = new Pool({ connectionString: upgradeURL.href });
  try {
    await admin.query(`CREATE SCHEMA "${upgradeSchema}"`);
    await cp(migrationsDirectory, legacyFiles, { recursive: true });
    await rm(join(legacyFiles, "007_p7_checkpoints.sql"));
    await rm(join(legacyFiles, "008_reviews.sql"));
    assert.equal((await migrate(upgradePool, legacyFiles)).length, 6);
    const user = (
      await upgradePool.query<{ id: string }>(
        "INSERT INTO users DEFAULT VALUES RETURNING id",
      )
    ).rows[0].id;
    const old = (
      await upgradePool.query<{ id: string }>(
        `INSERT INTO research_tasks
         (user_id,question,language,depth,config_json,status)
         VALUES($1,'legacy','zh','quick',$2,'failed') RETURNING id`,
        [user, buildResearchConfig("quick")],
      )
    ).rows[0].id;
    const attempt = (
      await upgradePool.query<{ id: string }>(
        "INSERT INTO research_attempts(task_id,number,status) VALUES($1,1,'failed') RETURNING id",
        [old],
      )
    ).rows[0].id;
    await upgradePool.query(
      "UPDATE research_tasks SET current_attempt_id=$1 WHERE id=$2",
      [attempt, old],
    );
    assert.deepEqual(await migrate(upgradePool), [
      "007_p7_checkpoints.sql",
      "008_reviews.sql",
    ]);
    const upgraded = (
      await upgradePool.query<{
        graph_run_id: string;
        task_id: string;
        thread_id: string;
      }>(
        `SELECT a.graph_run_id,g.task_id,g.thread_id
         FROM research_attempts a JOIN research_graph_runs g ON g.id=a.graph_run_id
         WHERE a.id=$1`,
        [attempt],
      )
    ).rows[0];
    assert.equal(upgraded.task_id, old);
    assert.equal(upgraded.thread_id, `research:${old}`);
  } finally {
    await upgradePool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
    await rm(legacyFiles, { recursive: true, force: true });
  }
});

test("failed migration rolls back DDL and version; modified history is refused", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "research-migrations-test-"));
  try {
    await cp(migrationsDirectory, temporary, { recursive: true });
    await writeFile(
      join(temporary, "004_broken.sql"),
      "CREATE TABLE rollback_probe (id integer); SELECT * FROM missing_table;",
    );
    await assert.rejects(migrate(pool, temporary));
    assert.equal(
      (await pool.query("SELECT to_regclass('rollback_probe') AS name")).rows[0]
        .name,
      null,
    );
    assert.equal(
      (await pool.query("SELECT count(*) FROM schema_migrations")).rows[0]
        .count,
      "8",
    );
    await writeFile(join(temporary, "001_auth.sql"), "SELECT 1;");
    await assert.rejects(migrate(pool, temporary), /MIGRATION_CHANGED/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("official adapter creates UUID identities and distinct provider accounts", async () => {
  const first = await adapter.createUser!({
    id: randomUUID(),
    name: "First",
    email: "first@example.test",
    emailVerified: null,
    image: null,
  });
  const second = await adapter.createUser!({
    id: randomUUID(),
    name: "Second",
    email: "second@example.test",
    emailVerified: null,
    image: null,
  });
  firstUser = first.id;
  secondUser = second.id;
  await adapter.linkAccount!({
    userId: firstUser,
    provider: "github",
    type: "oauth",
    providerAccountId: "test-first",
  });
  const account = await adapter.getUserByAccount!({
    provider: "github",
    providerAccountId: "test-first",
  });
  assert.equal(account?.id, firstUser);
  await assert.rejects(async () =>
    adapter.linkAccount!({
      userId: secondUser,
      provider: "github",
      type: "oauth",
      providerAccountId: "test-first",
    }),
  );
});

test("database Auth.js session: identity, cookie policy, renewal, expiry, deletion", async () => {
  const token = randomUUID();
  await adapter.createSession!({
    userId: firstUser,
    sessionToken: token,
    expires: new Date(Date.now() + 3600_000),
  });
  const request = () =>
    new NextRequest("http://localhost:3000/api/auth/session", {
      headers: {
        host: "localhost:3000",
        cookie: `authjs.session-token=${token}`,
      },
    });
  const response = await authGET(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.id, firstUser);
  assert.deepEqual(Object.keys(body.user).sort(), ["email", "id", "name"]);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(response.headers.get("set-cookie")!, /SameSite=Lax/i);
  const expires = new Date(Date.now() + 7200_000);
  const updated = await adapter.updateSession!({
    sessionToken: token,
    expires,
  });
  assert.equal(updated?.expires.getTime(), expires.getTime());
  await adapter.updateSession!({
    sessionToken: token,
    expires: new Date(Date.now() - 1000),
  });
  assert.equal(await (await authGET(request())).json(), null);
  assert.equal(await adapter.getSessionAndUser!(token), null);
  await adapter.createSession!({
    userId: secondUser,
    sessionToken: token,
    expires,
  });
  assert.equal((await (await authGET(request())).json()).user.id, secondUser);
  await adapter.deleteSession!(token);
  assert.equal(await (await authGET(request())).json(), null);
});

test("HTTPS sessions use Secure cookies and authentication rejects missing CSRF", async () => {
  const token = randomUUID();
  await adapter.createSession!({
    userId: firstUser,
    sessionToken: token,
    expires: new Date(Date.now() + 3600_000),
  });
  process.env.APP_ORIGIN = "https://research.example.test";
  try {
    const response = await authGET(
      new NextRequest("https://research.example.test/api/auth/session", {
        headers: {
          host: "research.example.test",
          cookie: `__Secure-authjs.session-token=${token}`,
        },
      }),
    );
    assert.equal((await response.json()).user.id, firstUser);
    assert.match(response.headers.get("set-cookie")!, /; Secure/i);
    const rejected = await authPOST(
      new NextRequest("https://research.example.test/api/auth/signout", {
        method: "POST",
        headers: {
          host: "research.example.test",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `__Secure-authjs.session-token=${token}`,
        },
        body: "csrfToken=invalid",
      }),
    );
    assert.equal(rejected.status, 302);
    assert.match(rejected.headers.get("location")!, /error=/);
    assert.equal((await adapter.getSessionAndUser!(token))?.user.id, firstUser);
    const csrfResponse = await authGET(
      new NextRequest("https://research.example.test/api/auth/csrf", {
        headers: { host: "research.example.test" },
      }),
    );
    const { csrfToken } = await csrfResponse.json();
    const csrfCookies = csrfResponse.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const signedOut = await authPOST(
      new NextRequest("https://research.example.test/api/auth/signout", {
        method: "POST",
        headers: {
          host: "research.example.test",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${csrfCookies}; __Secure-authjs.session-token=${token}`,
        },
        body: new URLSearchParams({
          csrfToken,
          callbackUrl: "https://evil.example",
        }),
      }),
    );
    assert.equal(signedOut.status, 302);
    assert.equal(
      signedOut.headers.get("location"),
      "https://research.example.test",
    );
    assert.equal(await adapter.getSessionAndUser!(token), null);
  } finally {
    process.env.APP_ORIGIN = "http://localhost:3000";
    await adapter.deleteSession!(token);
  }
});

test("auth handler rejects untrusted host and reports absent configuration", async () => {
  const bad = await authGET(
    new NextRequest("http://localhost:3000/api/auth/session", {
      headers: { host: "evil.example" },
    }),
  );
  assert.equal(bad.status, 400);
  const clientId = process.env.AUTH_GITHUB_ID;
  try {
    delete process.env.AUTH_GITHUB_ID;
    const response = await authGET(
      new NextRequest("http://localhost:3000/api/auth/session"),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: "AUTH_NOT_CONFIGURED" },
    });
  } finally {
    process.env.AUTH_GITHUB_ID = clientId;
  }
});

test("task ownership is checked with a parameterized query and returns indistinguishable 404", async () => {
  firstTask = (
    await pool.query(
      "INSERT INTO research_tasks(user_id, question, language, depth, config_json) VALUES ($1, 'first', 'zh', 'standard', $2) RETURNING id",
      [firstUser, buildResearchConfig("standard")],
    )
  ).rows[0].id;
  secondTask = (
    await pool.query(
      "INSERT INTO research_tasks(user_id, question, language, depth, config_json) VALUES ($1, 'second', 'en', 'quick', $2) RETURNING id",
      [secondUser, buildResearchConfig("quick")],
    )
  ).rows[0].id;
  assert.equal(
    (await requireOwnedTask(firstUser, firstTask, pool)).id,
    firstTask,
  );
  for (const id of [secondTask, randomUUID(), "' OR 1=1 --"]) {
    await assert.rejects(
      requireOwnedTask(firstUser, id, pool),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 404 &&
        error.code === "TASK_NOT_FOUND",
    );
  }
});

test("attempts, outbox and events cannot reference another task's attempt", async () => {
  const graphRun = (
    await pool.query<{ id: string }>(
      `INSERT INTO research_graph_runs
       (task_id,run_number,thread_id,code_version,prompt_version)
       VALUES($1,1,$2,'test','v1') RETURNING id`,
      [firstTask, `research:${firstTask}`],
    )
  ).rows[0].id;
  firstAttempt = (
    await pool.query(
      "INSERT INTO research_attempts(task_id, number, graph_run_id) VALUES ($1, 1, $2) RETURNING id",
      [firstTask, graphRun],
    )
  ).rows[0].id;
  await pool.query(
    "UPDATE research_tasks SET current_attempt_id = $1 WHERE id = $2",
    [firstAttempt, firstTask],
  );
  const foreignKeyError = (error: unknown) =>
    (error as { code: string }).code === "23503";
  await assert.rejects(
    pool.query(
      "UPDATE research_tasks SET current_attempt_id = $1 WHERE id = $2",
      [firstAttempt, secondTask],
    ),
    foreignKeyError,
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO task_outbox(task_id, attempt_id, schema_version, payload_json) VALUES ($1, $2, 1, '{}')",
      [secondTask, firstAttempt],
    ),
    foreignKeyError,
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO task_events(task_id, attempt_id, seq, type, payload_json) VALUES ($1, $2, 1, 'task.queued', '{}')",
      [secondTask, firstAttempt],
    ),
    foreignKeyError,
  );
});

test("uniqueness constraints and bigint transport are enforced", async () => {
  const uniqueError = (error: unknown) =>
    (error as { code: string }).code === "23505";
  await assert.rejects(
    pool.query(
      "INSERT INTO research_attempts(task_id, number, graph_run_id) VALUES ($1, 1, (SELECT graph_run_id FROM research_attempts WHERE id=$2))",
      [firstTask, firstAttempt],
    ),
    uniqueError,
  );
  const outboxSQL =
    "INSERT INTO task_outbox(task_id, attempt_id, schema_version, payload_json) VALUES ($1, $2, 1, '{}')";
  await pool.query(outboxSQL, [firstTask, firstAttempt]);
  await assert.rejects(
    pool.query(outboxSQL, [firstTask, firstAttempt]),
    uniqueError,
  );
  const eventSQL =
    "INSERT INTO task_events(task_id, seq, type, payload_json) VALUES ($1, 9007199254740993, 'test', '{}')";
  await pool.query(eventSQL, [firstTask]);
  await assert.rejects(pool.query(eventSQL, [firstTask]), uniqueError);
  assert.equal(
    (
      await pool.query("SELECT seq FROM task_events WHERE task_id = $1", [
        firstTask,
      ])
    ).rows[0].seq,
    "9007199254740993",
  );
  const idempotencySQL =
    "INSERT INTO api_idempotency(user_id, operation, key, request_hash, resource_id, expires_at) VALUES ($1, 'create', 'key', 'hash', $2, now() + interval '1 day')";
  await pool.query(idempotencySQL, [firstUser, firstTask]);
  await assert.rejects(
    pool.query(idempotencySQL, [firstUser, firstTask]),
    uniqueError,
  );
  await pool.query(idempotencySQL, [secondUser, secondTask]);
});

test("task snapshot is immutable and transaction errors roll back changes", async () => {
  await assert.rejects(
    pool.query("UPDATE research_tasks SET config_json = '{}' WHERE id = $1", [
      firstTask,
    ]),
    (error: unknown) => (error as { code: string }).code === "23514",
  );
  const marker = randomUUID();
  await assert.rejects(
    transaction(async (client) => {
      await client.query(
        "INSERT INTO research_tasks(id, user_id, question, language, depth, config_json) VALUES ($1, $2, 'rollback', 'zh', 'quick', '{}')",
        [marker, firstUser],
      );
      throw new Error("rollback requested");
    }, pool),
  );
  assert.equal(
    (await pool.query("SELECT id FROM research_tasks WHERE id = $1", [marker]))
      .rowCount,
    0,
  );
});
