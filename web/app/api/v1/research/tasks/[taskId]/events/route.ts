import { uuidSchema } from "@/lib/contracts";
import { requireUser } from "@/lib/server/auth";
import {
  apiErrorResponse,
  ApiError,
  readQuery,
  validateInput,
} from "@/lib/server/http";
import {
  getTaskEventBounds,
  getTaskEvents,
  type TaskEventBounds,
} from "@/lib/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONNECTION_MS = 60_000;
const POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;

function readAfter(request: Request): string {
  const query = readQuery(request.url);
  const header = request.headers.get("last-event-id");
  const value = header ?? query.after ?? "0";
  if (!/^\d+$/.test(value) || BigInt(value) < BigInt(0))
    throw new ApiError(400, "INVALID_EVENT_CURSOR", "事件游标无效。");
  return value;
}

function cursorTooOld(after: string, bounds: TaskEventBounds) {
  return (
    bounds.min_event_seq !== null &&
    BigInt(after) < BigInt(bounds.min_event_seq) - BigInt(1)
  );
}

function sseFrame(id: string, event: string, data: Record<string, unknown>) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const user = await requireUser();
    const taskId = validateInput(uuidSchema, (await context.params).taskId);
    const after = readAfter(request);
    const bounds = await getTaskEventBounds(user.id, taskId);
    if (BigInt(after) > BigInt(bounds.last_event_seq))
      throw new ApiError(
        400,
        "INVALID_EVENT_CURSOR",
        "事件游标超过当前任务进度。",
      );
    if (cursorTooOld(after, bounds))
      throw new ApiError(
        410,
        "EVENT_CURSOR_EXPIRED",
        "事件游标已过期，请重新读取任务概要。",
      );

    const encoder = new TextEncoder();
    let closed = false;
    let cursor = after;
    let lastHeartbeat = Date.now();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

    const close = () => {
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        controllerRef?.close();
      } catch {
        // 客户端断开时控制器可能已经关闭。
      }
    };

    request.signal.addEventListener("abort", close, { once: true });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        const loop = async () => {
          if (closed) return;
          try {
            if (Date.now() - started >= MAX_CONNECTION_MS) {
              controller.enqueue(encoder.encode(": reconnect\n\n"));
              close();
              return;
            }
            const events = await getTaskEvents(user.id, taskId, cursor, 100);
            for (const item of events) {
              if (closed) return;
              controller.enqueue(
                encoder.encode(sseFrame(item.id, item.event, item.data)),
              );
              cursor = item.id;
            }
            if (!events.length && Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
              lastHeartbeat = Date.now();
            }
            if (!closed) timer = setTimeout(loop, POLL_MS);
          } catch {
            close();
          }
        };
        void loop();
      },
      cancel() {
        close();
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
