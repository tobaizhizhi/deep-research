import { uuidSchema } from "@/lib/contracts";
import { requireUser } from "@/lib/server/auth";
import { getReview } from "@/lib/server/review-service";
import {
  apiErrorResponse,
  privateJson,
  validateInput,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ reviewId: string }> },
) {
  try {
    const user = await requireUser();
    const reviewId = validateInput(uuidSchema, (await context.params).reviewId);
    return privateJson(await getReview(user.id, reviewId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
