export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 存活检查只说明 Web 进程能响应，不调用模型、数据库或搜索服务。
export async function GET() {
  return Response.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
