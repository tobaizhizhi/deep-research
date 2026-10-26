"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TaskStatus } from "@/lib/contracts";

export function TaskActions({
  taskId,
  status,
  cancelRequested = false,
  resumeAvailable = false,
}: {
  taskId: string;
  status: TaskStatus;
  cancelRequested?: boolean;
  resumeAvailable?: boolean;
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const retryKey = useRef<string | null>(null);
  const resumeKey = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState("");
  async function retry() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/research/tasks/${taskId}/retry`, {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
          "X-Research-CSRF": "1",
          "Idempotency-Key": (retryKey.current ??= crypto.randomUUID()),
        },
      });
      const result = await response.json();
      if (!response.ok)
        setError(result.error?.message ?? "重试未创建，请刷新后再试。");
      else retryKey.current = null;
      startRefresh(() => router.refresh());
    } catch {
      setError("暂时无法确认重试结果，请刷新状态后再试。");
    } finally {
      setPending(false);
      inFlight.current = false;
    }
  }
  async function resume() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/research/tasks/${taskId}/resume`, {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
          "X-Research-CSRF": "1",
          "Idempotency-Key": (resumeKey.current ??= crypto.randomUUID()),
        },
      });
      const result = await response.json();
      if (!response.ok)
        setError(result.error?.message ?? "接续未创建，请刷新后再试。");
      else resumeKey.current = null;
      startRefresh(() => router.refresh());
    } catch {
      setError("暂时无法确认接续结果，请刷新状态后再试。");
    } finally {
      setPending(false);
      inFlight.current = false;
    }
  }
  async function cancel() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/research/tasks/${taskId}/cancel`, {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/json", "X-Research-CSRF": "1" },
        body: "{}",
      });
      const result = await response.json();
      if (!response.ok)
        setError(result.error?.message ?? "取消未完成，请刷新后重试。");
      startRefresh(() => router.refresh());
    } catch {
      setError("暂时无法确认取消结果，请刷新状态或再次取消。");
    } finally {
      setPending(false);
      inFlight.current = false;
    }
  }
  return (
    <div className="task-actions">
      <div className="task-action-buttons">
        <button
          className="button button-outline"
          disabled={pending || refreshing}
          onClick={() => startRefresh(() => router.refresh())}
        >
          {refreshing ? "正在刷新…" : "刷新状态"}
        </button>
        {(status === "queued" || status === "running") && (
          <button
            className="button button-outline cancel-button"
            disabled={pending || refreshing || cancelRequested}
            onClick={cancel}
          >
            {pending
              ? "正在提交停止请求…"
              : cancelRequested
                ? "等待研究停止…"
                : status === "running"
                  ? "停止研究"
                  : "取消排队"}
          </button>
        )}
        {status === "failed" && (
          <>
            {resumeAvailable && (
              <button
                className="button button-outline"
                disabled={pending || refreshing}
                onClick={resume}
              >
                {pending ? "正在接续排队…" : "从中断处接续"}
              </button>
            )}
            <button
              className="button button-outline"
              disabled={pending || refreshing}
              onClick={retry}
            >
              {pending ? "正在重新排队…" : "重新研究"}
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
