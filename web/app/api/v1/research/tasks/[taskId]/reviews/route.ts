import { z } from "zod";
import { uuidSchema } from "@/lib/contracts";
import { requireUser } from "@/lib/server/auth";
import { requestReview } from "@/lib/server/review-service";
import {
  ApiError,
  apiErrorResponse,
  privateJson,
  readJsonBody,
  requireSameOriginWrite,
  validateInput,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.strictObject({
  report_id: uuidSchema,
  reason: z.string(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const user = await requireUser();
    requireSameOriginWrite(request);
    const taskId = validateInput(uuidSchema, (await context.params).taskId);
    const key = request.headers.get("Idempotency-Key");
    if (!key)
      throw new ApiError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "请提供 UUID 格式的 Idempotency-Key。",
      );
    const body = validateInput(requestSchema, await readJsonBody(request));
    return privateJson(
      await requestReview(user.id, taskId, body.report_id, body.reason, key),
      202,
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
