import { z } from "zod";
import { uuidSchema } from "@/lib/contracts";
import { requireUser } from "@/lib/server/auth";
import { assignReview } from "@/lib/server/review-service";
import {
  apiErrorResponse,
  privateJson,
  readJsonBody,
  requireSameOriginWrite,
  validateInput,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assignSchema = z.strictObject({
  assigned_to: uuidSchema,
  expected_version: z.number().int().positive(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ reviewId: string }> },
) {
  try {
    const user = await requireUser();
    requireSameOriginWrite(request);
    const reviewId = validateInput(uuidSchema, (await context.params).reviewId);
    const key = request.headers.get("Idempotency-Key");
    const body = validateInput(assignSchema, await readJsonBody(request));
    return privateJson(
      await assignReview(
        user.id,
        reviewId,
        body.assigned_to,
        body.expected_version,
        key ?? "",
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
