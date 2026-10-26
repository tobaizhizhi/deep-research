import { z } from "zod";
import { uuidSchema } from "@/lib/contracts";
import { requireUser } from "@/lib/server/auth";
import { requestCancel } from "@/lib/server/tasks";
import {
  apiErrorResponse,
  privateJson,
  readJsonBody,
  requireSameOriginWrite,
  validateInput,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const user = await requireUser();
    requireSameOriginWrite(request);
    const taskId = validateInput(uuidSchema, (await context.params).taskId);
    validateInput(z.strictObject({}), await readJsonBody(request, 1024));
    const task = await requestCancel(user.id, taskId);
    return privateJson(
      task,
      task.status === "running" && task.cancel_requested_at ? 202 : 200,
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
