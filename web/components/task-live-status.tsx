"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TaskDetail, TaskEvent } from "@/lib/contracts";
import { TaskStatusBadge } from "./task-status";

const terminalStatuses = new Set<TaskDetail["status"]>([
  "succeeded",
  "failed",
  "cancelled",
]);

const eventTypes = [
  "task.queued",
  "task.retry_queued",
  "task.started",
  "task.cancel_requested",
  "task.cancelled",
  "task.succeeded",
  "task.failed",
  "supervisor.planned",
  "supervisor.reviewed",
  "researcher.started",
  "researcher.reviewed",
  "search.completed",
  "findings.extracted",
  "brief.completed",
  "brief.fallback",
  "report.started",
  "citation.checked",
];

const eventLabels: Record<string, string> = {
  "task.queued": "任务已加入队列",
  "task.retry_queued": "重试已加入队列",
  "task.started": "研究服务开始执行",
  "task.cancel_requested": "已收到停止请求",
  "task.cancelled": "研究已停止",
  "task.succeeded": "报告和证据已归档",
  "task.failed": "研究未能完成",
  "supervisor.planned": "主控拆分研究任务",
  "supervisor.reviewed": "主控完成资料评估",
  "researcher.started": "研究员开始工作",
  "researcher.reviewed": "研究员完成本轮评估",
  "search.completed": "网页搜索完成",
  "findings.extracted": "本轮证据已整理",
  "brief.completed": "研究资料已压缩整理",
  "brief.fallback": "改用完整研究资料继续",
  "report.started": "开始撰写最终报告",
  "citation.checked": "引用检查完成",
};

const snapshotEvents = new Set([
  "task.started",
  "task.retry_queued",
  "task.cancel_requested",
  "task.cancelled",
  "task.succeeded",
  "task.failed",
]);

function researcherLabel(value: unknown) {
  if (typeof value !== "string") return "研究流程";
  const match = value.match(/:b(\d+):r(\d+)$/);
  return match ? `研究员 ${match[1]}.${match[2]}` : "研究员";
}

function eventDetails(event: TaskEvent) {
  const data = event.data;
  const details: string[] = [];
  if (typeof data.researcher_id === "string")
    details.push(researcherLabel(data.researcher_id));
  if (typeof data.search_round === "number")
    details.push(`第 ${data.search_round} 轮`);
  if (typeof data.new_sources === "number")
    details.push(`${data.new_sources} 条新来源`);
  if (typeof data.finding_count === "number")
    details.push(`${data.finding_count} 条发现`);
  if (typeof data.gap_count === "number")
    details.push(`${data.gap_count} 项缺口`);
  if (typeof data.warning_count === "number")
    details.push(`${data.warning_count} 条警告`);
  if (typeof data.batch === "number" && event.event === "supervisor.planned")
    details.push(`第 ${data.batch} 批`);
  return details.join(" · ");
}

function newerCursor(current: string, next: string) {
  try {
    return BigInt(next) > BigInt(current) ? next : current;
  } catch {
    return current;
  }
}

function cursorIsExpired(cursor: string, minimum: string | null) {
  if (minimum === null) return false;
  try {
    return BigInt(cursor) < BigInt(minimum) - BigInt(1);
  } catch {
    return false;
  }
}

export function TaskLiveStatus({
  taskId,
  initialTask,
}: {
  taskId: string;
  initialTask: TaskDetail;
}) {
  const router = useRouter();
  const [task, setTask] = useState(initialTask);
  const [connectionState, setConnectionState] = useState("正在连接实时进度");
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [refreshing, startRefresh] = useTransition();
  const taskRef = useRef(initialTask);
  // 游标只随实际收到的事件前进，不能用任务快照的最新序号跳过断线期间的事件。
  const cursorRef = useRef("0");
  const seenEventIds = useRef(new Set<string>());

  useEffect(() => {
    taskRef.current = initialTask;
  }, [initialTask]);

  useEffect(() => {
    if (terminalStatuses.has(initialTask.status)) return;

    let disposed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let historyExpired = false;

    const applySnapshot = (next: TaskDetail) => {
      if (disposed) return;
      const previous = taskRef.current;
      taskRef.current = next;
      historyExpired = cursorIsExpired(cursorRef.current, next.min_event_seq);
      if (historyExpired) {
        // 旧事件已经被清理，不能伪造中间进度；从当前快照的末尾重新订阅。
        cursorRef.current = next.last_event_seq || cursorRef.current;
        seenEventIds.current.clear();
        setEvents([]);
      }
      setTask(next);
      if (
        next.status !== previous.status ||
        next.has_report !== previous.has_report ||
        next.last_event_seq !== previous.last_event_seq
      ) {
        startRefresh(() => router.refresh());
      }
    };

    const readSnapshot = async () => {
      try {
        const response = await fetch(`/api/v1/research/tasks/${taskId}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("状态读取失败");
        applySnapshot((await response.json()) as TaskDetail);
        setConnectionState(
          historyExpired
            ? "部分历史进度已过期，已跳到最新状态"
            : terminalStatuses.has(taskRef.current.status)
              ? "研究已结束"
              : "等待实时事件",
        );
        return true;
      } catch {
        if (!disposed) setConnectionState("暂时无法连接，正在重试");
        return false;
      }
    };

    const connect = () => {
      if (disposed || terminalStatuses.has(taskRef.current.status)) return;
      if (typeof EventSource === "undefined") {
        setConnectionState("浏览器不支持实时连接，使用自动刷新");
        fallbackTimer = setTimeout(async () => {
          await readSnapshot();
          connect();
        }, 2000);
        return;
      }

      const query = new URLSearchParams({ after: cursorRef.current });
      source = new EventSource(
        `/api/v1/research/tasks/${taskId}/events?${query.toString()}`,
        { withCredentials: true },
      );
      setConnectionState("实时进度已连接");

      const handleEvent = (event: Event) => {
        const message = event as MessageEvent<string>;
        if (message.lastEventId)
          cursorRef.current = newerCursor(
            cursorRef.current,
            message.lastEventId,
          );
        let payload: { attempt_id?: string; status?: TaskDetail["status"] } =
          {};
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(message.data) as Record<string, unknown>;
          payload = data as typeof payload;
        } catch {
          // 无法解析时仍保留游标，避免重复消费；页面刷新会补回状态。
        }
        const currentAttempt = taskRef.current.current_attempt_id;
        if (
          payload.attempt_id &&
          currentAttempt &&
          payload.attempt_id !== currentAttempt
        ) {
          startRefresh(() => router.refresh());
          return;
        }
        if (
          message.lastEventId &&
          !seenEventIds.current.has(message.lastEventId)
        ) {
          seenEventIds.current.add(message.lastEventId);
          setEvents((current) =>
            [
              ...current,
              { id: message.lastEventId, event: message.type, data },
            ].slice(-40),
          );
        }
        setConnectionState("实时进度已连接");
        if (snapshotEvents.has(message.type))
          startRefresh(() => router.refresh());
        if (
          payload.status &&
          terminalStatuses.has(payload.status) &&
          (!payload.attempt_id || payload.attempt_id === currentAttempt)
        ) {
          source?.close();
          setConnectionState("研究已结束");
        }
      };

      for (const type of eventTypes) source.addEventListener(type, handleEvent);
      source.onerror = async () => {
        source?.close();
        source = null;
        if (disposed) return;
        const available = await readSnapshot();
        if (!available || terminalStatuses.has(taskRef.current.status)) return;
        setConnectionState("连接已断开，正在重连");
        reconnectTimer = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [initialTask.status, router, taskId]);

  // SSE 断线恢复得到的本地快照可能比当前 Server Component props 更新。
  // 只有在服务端快照确实更新之后，才用它替换本地状态，避免状态回退。
  const displayedTask =
    task.updated_at >= initialTask.updated_at ? task : initialTask;

  return (
    <div className="task-live-shell">
      <div className="live-status" aria-live="polite" aria-atomic="true">
        <TaskStatusBadge status={displayedTask.status} />
        {!terminalStatuses.has(displayedTask.status) && (
          <span className="live-status-note">
            {refreshing ? "正在同步…" : connectionState}
          </span>
        )}
      </div>
      {events.length > 0 && (
        <section className="task-event-feed" aria-label="研究进度">
          <div className="task-event-heading">
            <h2>研究进度</h2>
            <span>{events.length} 条事件</span>
          </div>
          <ol>
            {events.map((event) => (
              <li key={event.id}>
                <span className="task-event-marker" aria-hidden="true" />
                <div className="task-event-copy">
                  <strong>{eventLabels[event.event] ?? event.event}</strong>
                  {eventDetails(event) && <span>{eventDetails(event)}</span>}
                </div>
                <code>#{event.id}</code>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
