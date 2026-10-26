import { uuidSchema } from "@/lib/contracts";
import { requireUser } from "@/lib/server/auth";
import { getReport } from "@/lib/server/tasks";
import { z } from "zod";
import { apiErrorResponse, readQuery, validateInput } from "@/lib/server/http";

const downloadQuerySchema = z.strictObject({
  format: z.literal("markdown").default("markdown"),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const user = await requireUser();
    const taskId = validateInput(uuidSchema, (await context.params).taskId);
    validateInput(downloadQuerySchema, readQuery(_request.url));
    const report = await getReport(user.id, taskId);
    const filename = `research-${taskId}.md`;
    return new Response(report.markdown, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
