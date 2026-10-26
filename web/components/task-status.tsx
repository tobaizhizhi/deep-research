import type { TaskStatus } from "@/lib/contracts";

export const taskStatusLabels: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "研究中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`task-status task-status-${status}`}>
      <span aria-hidden="true" />
      {taskStatusLabels[status]}
    </span>
  );
}

export function displayTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}
