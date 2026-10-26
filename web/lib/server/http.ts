import "server-only";
import { randomUUID } from "node:crypto";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function privateJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export function apiErrorResponse(error: unknown) {
  const request_id = randomUUID();
  if (error instanceof ApiError)
    return privateJson(
      {
        error: {
          code: error.code,
          message: error.message,
          request_id,
          ...error.details,
        },
      },
      error.status,
    );
  console.error("API_UNAVAILABLE", { request_id });
  return privateJson(
    {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "服务暂时不可用，请稍后重试。",
        request_id,
      },
    },
    503,
  );
}

export function validateInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ApiError(400, "INVALID_INPUT", "请检查输入字段。", {
      fields: [
        ...new Set(
          result.error.issues.map((issue) => issue.path.join(".") || "body"),
        ),
      ],
    });
  return result.data;
}

// 边读边限流量，不能仅信任 Content-Length，也不能先 request.json() 再量长度。
export async function readJsonBody(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请使用 application/json。",
    );
  }
  if (
    request.headers.has("content-encoding") &&
    request.headers.get("content-encoding") !== "identity"
  ) {
    throw new ApiError(415, "UNSUPPORTED_ENCODING", "不接受压缩的请求体。");
  }
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^[0-9]+$/.test(length))
      throw new ApiError(400, "INVALID_CONTENT_LENGTH");
    if (BigInt(length) > BigInt(maxBytes))
      throw new ApiError(413, "BODY_TOO_LARGE", "请求内容过长。");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_JSON", "请求体不能为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new ApiError(413, "BODY_TOO_LARGE", "请求内容过长。");
      }
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "请求体必须是有效的 UTF-8 JSON。");
  } finally {
    reader.releaseLock();
  }
}

export function readQuery(url: string) {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(values, key))
      throw new ApiError(400, "INVALID_INPUT", "查询参数不能重复。");
    values[key] = value;
  }
  return values;
}

export function appOrigin(): string {
  const url = new URL(process.env.APP_ORIGIN ?? "http://localhost:3000");
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new Error("INVALID_APP_ORIGIN");
  }
  // Auth.js 的兼容环境变量不能覆盖成另一个站点。
  for (const value of [process.env.AUTH_URL, process.env.NEXTAUTH_URL]) {
    if (value && value !== url.origin) throw new Error("AUTH_ORIGIN_MISMATCH");
  }
  return url.origin;
}

export function assertTrustedHost(headers: Headers) {
  const expected = new URL(appOrigin());
  if (
    headers.get("host") !== expected.host ||
    (headers.has("x-forwarded-host") &&
      headers.get("x-forwarded-host") !== expected.host) ||
    (headers.has("x-forwarded-proto") &&
      headers.get("x-forwarded-proto") !== expected.protocol.slice(0, -1))
  ) {
    throw new ApiError(400, "UNTRUSTED_HOST");
  }
}

// 供后续自定义业务 POST/PATCH/DELETE 复用：浏览器同源、JSON、非简单请求。
// Auth.js 自己的登录接口另有库内置 CSRF token 校验。
export function requireSameOriginWrite(request: Request) {
  assertTrustedHost(request.headers);
  if (
    request.headers.get("origin") !== appOrigin() ||
    request.headers.get("x-research-csrf") !== "1"
  ) {
    throw new ApiError(403, "CSRF_REJECTED");
  }
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请使用 application/json。",
    );
  }
}

export function safeRedirect(target: string) {
  try {
    const url = new URL(target, appOrigin());
    if (url.origin === appOrigin() && !url.username && !url.password)
      return url.href;
  } catch {
    /* 非法 URL 回到首页。 */
  }
  return appOrigin();
}
