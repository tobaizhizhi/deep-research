import { getPool, checkDatabaseReady } from "@/lib/server/db";
import { privateJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (await checkDatabaseReady(getPool()))
      return privateJson({ status: "ready" });
  } catch {
    /* 外部只暴露就绪状态，不暴露连接信息。 */
  }
  return privateJson({ status: "not_ready" }, 503);
}
