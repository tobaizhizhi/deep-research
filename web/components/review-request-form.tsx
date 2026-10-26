"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function ReviewRequestForm({
  taskId,
  reportId,
}: {
  taskId: string;
  reportId: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const key = useRef<string | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !reason.trim()) return;
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(`/api/v1/research/tasks/${taskId}/reviews`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Research-CSRF": "1",
          "Idempotency-Key": (key.current ??= crypto.randomUUID()),
        },
        body: JSON.stringify({ report_id: reportId, reason }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "申请未提交。");
      key.current = null;
      setReason("");
      setMessage("复核申请已提交，等待分派。");
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "申请未提交，请稍后再试。",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="review-request-form" onSubmit={submit}>
      <label htmlFor="review-reason">申请人工复核</label>
      <textarea
        id="review-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="指出希望人工核查的结论、证据或冲突。"
        maxLength={2000}
        rows={3}
      />
      <div className="review-form-footer">
        <button
          className="button button-outline"
          disabled={pending || !reason.trim()}
        >
          {pending ? "正在提交…" : "申请复核"}
        </button>
        {message && (
          <span className="form-message" role="status">
            {message}
          </span>
        )}
      </div>
    </form>
  );
}
