import {
  createResearchSchema,
  listTasksQuerySchema,
  uuidSchema,
} from "@/lib/contracts";
import { requireUser } from "@/lib/server/auth";
import { createTask, listTasks } from "@/lib/server/tasks";
import {
  ApiError,
  apiErrorResponse,
  privateJson,
  readJsonBody,
  readQuery,
  requireSameOriginWrite,
  validateInput,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOriginWrite(request);
    const key = request.headers.get("Idempotency-Key");
    if (!key || !uuidSchema.safeParse(key).success)
      throw new ApiError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "请提供 UUID 格式的 Idempotency-Key。",
      );
    const input = validateInput(
      createResearchSchema,
      await readJsonBody(request),
    );
    const task = await createTask(user.id, input, key);
    const response = privateJson(task, 202);
    response.headers.set("Location", task.status_url);
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const query = validateInput(listTasksQuerySchema, readQuery(request.url));
    return privateJson(await listTasks(user.id, query));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
