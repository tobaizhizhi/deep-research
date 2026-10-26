"use client";

import { useRef, useState } from "react";

export function ReportFeedbackForm({
  taskId,
  reportId,
}: {
  taskId: string;
  reportId: string;
}) {
  const [feedback, setFeedback] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const key = useRef<string | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !feedback.trim()) return;
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/v1/research/tasks/${taskId}/feedback`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Research-CSRF": "1",
            "Idempotency-Key": (key.current ??= crypto.randomUUID()),
          },
          body: JSON.stringify({ report_id: reportId, feedback }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "反馈未提交。");
      key.current = null;
      setFeedback("");
      setMessage("反馈已记录，后续会由人工判断是否纳入回归题集。");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "反馈未提交，请稍后再试。",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="report-feedback-form" onSubmit={submit}>
      <label htmlFor="report-feedback">报告反馈</label>
      <textarea
        id="report-feedback"
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        maxLength={4000}
        rows={3}
        placeholder="指出错误、缺口或值得保留的地方。反馈会绑定到这个报告版本。"
      />
      <div className="review-form-footer">
        <button
          className="button button-outline"
          disabled={pending || !feedback.trim()}
        >
          {pending ? "正在提交…" : "提交反馈"}
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
