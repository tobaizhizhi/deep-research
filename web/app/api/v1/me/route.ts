import { requireUser } from "@/lib/server/auth";
import { apiErrorResponse, privateJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return privateJson({ user: await requireUser() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
