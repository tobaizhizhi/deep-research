import { requireUser } from "@/lib/server/auth";
import { retryTask } from "@/lib/server/tasks";
import { uuidSchema } from "@/lib/contracts";
import {
  apiErrorResponse,
  privateJson,
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
    const key = request.headers.get("Idempotency-Key");
    if (!key || !uuidSchema.safeParse(key).success)
      return privateJson(
        {
          error: {
            code: "INVALID_IDEMPOTENCY_KEY",
            message: "请提供 UUID 格式的 Idempotency-Key。",
          },
        },
        400,
      );
    const result = await retryTask(user.id, taskId, key);
    return privateJson(result, 202);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
