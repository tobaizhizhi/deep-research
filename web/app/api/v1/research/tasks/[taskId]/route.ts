import { uuidSchema } from "@/lib/contracts";
import { requireUser } from "@/lib/server/auth";
import { getTask } from "@/lib/server/tasks";
import {
  apiErrorResponse,
  privateJson,
  validateInput,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const user = await requireUser();
    const taskId = validateInput(uuidSchema, (await context.params).taskId);
    return privateJson(await getTask(user.id, taskId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
