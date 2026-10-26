import { requireUser } from "@/lib/server/auth";
import { listReviews } from "@/lib/server/review-service";
import { apiErrorResponse, privateJson, readQuery } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const query = readQuery(request.url);
    return privateJson(await listReviews(user.id, query.status));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
