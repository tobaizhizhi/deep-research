import { NextRequest } from "next/server";
import { handlers, isAuthConfigured } from "@/lib/server/auth";
import {
  apiErrorResponse,
  appOrigin,
  assertTrustedHost,
  privateJson,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  if (!isAuthConfigured())
    return privateJson({ error: { code: "AUTH_NOT_CONFIGURED" } }, 503);
  try {
    assertTrustedHost(request.headers);
    // 内部监听地址可以与对外站点不同，OAuth 回调始终使用明确配置的公开 origin。
    const url = new URL(request.url);
    const canonical = new NextRequest(
      `${appOrigin()}${url.pathname}${url.search}`,
      request,
    );
    const response =
      await handlers[request.method === "POST" ? "POST" : "GET"](canonical);
    // 库可能返回 headers 不可修改的重定向 Response，复制后再补缓存头。
    const outgoing = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    outgoing.headers.set("Cache-Control", "private, no-store");
    return outgoing;
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export { handle as GET, handle as POST };
