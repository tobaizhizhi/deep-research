import { z } from "zod";
import { uuidSchema } from "@/lib/contracts";
import { requireUser } from "@/lib/server/auth";
import { decideReview } from "@/lib/server/review-service";
import {
  apiErrorResponse,
  privateJson,
  readJsonBody,
  requireSameOriginWrite,
  validateInput,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionSchema = z.strictObject({
  verdict: z.enum(["confirmed", "needs_more_evidence", "not_accepted"]),
  notes: z.record(z.string(), z.unknown()).default({}),
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
    const body = validateInput(decisionSchema, await readJsonBody(request));
    return privateJson(
      await decideReview(
        user.id,
        reviewId,
        body.verdict,
        body.notes,
        body.expected_version,
        request.headers.get("Idempotency-Key") ?? "",
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
