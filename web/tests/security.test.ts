import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiError,
  assertTrustedHost,
  requireSameOriginWrite,
  safeRedirect,
  readJsonBody,
  readQuery,
  validateInput,
} from "../lib/server/http";
import { createResearchSchema, listTasksQuerySchema } from "../lib/contracts";

process.env.APP_ORIGIN = "http://localhost:3000";

test("redirects cannot escape the configured site", () => {
  assert.equal(safeRedirect("/research"), "http://localhost:3000/research");
  for (const value of [
    "https://evil.example",
    "//evil.example",
    "javascript:alert(1)",
    "/\\evil.example",
  ]) {
    assert.equal(safeRedirect(value), "http://localhost:3000");
  }
});

test("reject spoofed forwarded host and protocol", () => {
  assert.doesNotThrow(() =>
    assertTrustedHost(new Headers({ host: "localhost:3000" })),
  );
  const cases: Record<string, string>[] = [
    { host: "evil.example" },
    { host: "localhost:3000", "x-forwarded-host": "evil.example" },
    { host: "localhost:3000", "x-forwarded-proto": "https" },
  ];
  for (const headers of cases) {
    assert.throws(
      () => assertTrustedHost(new Headers(headers)),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  }
});

test("business writes require same origin, JSON and explicit request header", () => {
  const headers = {
    host: "localhost:3000",
    origin: "http://localhost:3000",
    "content-type": "application/json",
    "x-research-csrf": "1",
  };
  const request = (overrides: Record<string, string>) =>
    new Request("http://localhost:3000/api/v1/research/tasks", {
      method: "POST",
      headers: { ...headers, ...overrides },
    });
  assert.doesNotThrow(() => requireSameOriginWrite(request({})));
  const cases: Record<string, string>[] = [
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: "" },
    { "x-research-csrf": "" },
  ];
  for (const overrides of cases) {
    assert.throws(
      () => requireSameOriginWrite(request(overrides)),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
  }
  assert.throws(
    () => requireSameOriginWrite(request({ "content-type": "text/plain" })),
    (error: unknown) => error instanceof ApiError && error.status === 415,
  );
});

test("body reader bounds actual streamed bytes, validates JSON/encoding, and ignores false short length", async () => {
  const request = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost:3000", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });
  assert.deepEqual(await readJsonBody(request('{"question":"问题"}')), {
    question: "问题",
  });
  for (const body of ["", "{", "null trailing"])
    await assert.rejects(
      readJsonBody(request(body)),
      (error: unknown) =>
        error instanceof ApiError && error.code === "INVALID_JSON",
    );
  await assert.rejects(
    readJsonBody(
      request('"' + "a".repeat(100) + '"', { "content-length": "1" }),
      20,
    ),
    (error: unknown) => error instanceof ApiError && error.status === 413,
  );
  await assert.rejects(
    readJsonBody(request("{}", { "content-length": "9999999" })),
    (error: unknown) => error instanceof ApiError && error.status === 413,
  );
  await assert.rejects(
    readJsonBody(request("{}", { "content-encoding": "gzip" })),
    (error: unknown) => error instanceof ApiError && error.status === 415,
  );
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(30));
    },
    cancel() {
      cancelled = true;
    },
  });
  const streamed = new Request("http://localhost:3000", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    readJsonBody(streamed, 20),
    (error: unknown) => error instanceof ApiError && error.status === 413,
  );
  assert.equal(cancelled, true);
});

test("input errors are 400 with field paths and list parameters reject duplicates and unbounded limits", () => {
  for (const input of [
    {},
    { question: " " },
    { question: "a", depth: "unlimited" },
    { question: "a", user_id: "fake" },
    null,
  ]) {
    assert.throws(
      () => validateInput(createResearchSchema, input),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  }
  assert.deepEqual(
    validateInput(createResearchSchema, { question: " LangGraph 是什么 " }),
    {
      question: "LangGraph 是什么",
      requirements: "",
      language: "auto",
      depth: "standard",
    },
  );
  assert.equal(validateInput(listTasksQuerySchema, {}).limit, 20);
  for (const limit of ["0", "-1", "101", "1.5", "1e2", "", "01"])
    assert.equal(listTasksQuerySchema.safeParse({ limit }).success, false);
  assert.throws(
    () => readQuery("http://localhost:3000?limit=1&limit=2"),
    ApiError,
  );
  assert.equal(
    listTasksQuerySchema.safeParse({ other: "unknown" }).success,
    false,
  );
});
