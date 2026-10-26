import { z } from "zod";
import { uuidSchema } from "@/lib/contracts";
import { requireUser } from "@/lib/server/auth";
import { getEvidence } from "@/lib/server/tasks";
import {
  apiErrorResponse,
  privateJson,
  readQuery,
  validateInput,
} from "@/lib/server/http";

const evidenceQuerySchema = z.strictObject({
  report_id: uuidSchema,
  cursor: z.string().min(1).max(1024).optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]?$/)
    .transform(Number)
    .default(8),
  source_url: z.string().min(1).max(2048).optional(),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const user = await requireUser();
    const taskId = validateInput(uuidSchema, (await context.params).taskId);
    const query = validateInput(evidenceQuerySchema, readQuery(request.url));
    return privateJson(await getEvidence(user.id, taskId, query));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
