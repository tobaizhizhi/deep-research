"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function ReviewFollowupForm({
  reportId,
  reviewId,
}: {
  reportId: string;
  reviewId: string;
}) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const key = useRef<string | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !question.trim()) return;
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/v1/research/tasks", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Research-CSRF": "1",
          "Idempotency-Key": (key.current ??= crypto.randomUUID()),
        },
        body: JSON.stringify({
          question,
          requirements: "基于复核意见补充独立证据，并保留原报告作为历史版本。",
          language: "auto",
          depth: "standard",
          parent_report_id: reportId,
          review_id: reviewId,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? "补查任务未创建。");
      setMessage("补查任务已排队，原报告保持不变。");
      key.current = null;
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "补查任务未创建，请稍后再试。",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="review-followup-form" onSubmit={submit}>
      <label htmlFor="followup-question">确认发起补查</label>
      <textarea
        id="followup-question"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        rows={3}
        maxLength={4000}
        placeholder="把希望补充的证据或待核查问题写成新的研究需求。"
      />
      <div className="review-form-footer">
        <button
          className="button button-primary"
          disabled={pending || !question.trim()}
        >
          {pending ? "正在排队…" : "创建补查任务"}
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
