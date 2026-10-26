"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Review = {
  review_id: string;
  version: number;
  status: string;
  assigned_to: string | null;
  permissions: { owner: boolean; reviewer: boolean; dispatcher: boolean };
};

export function ReviewControls({ review }: { review: Review }) {
  const router = useRouter();
  const [assignedTo, setAssignedTo] = useState(review.assigned_to ?? "");
  const [verdict, setVerdict] = useState("needs_more_evidence");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const key = useRef<string | null>(null);
  async function submit(path: string, body: Record<string, unknown>) {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/v1/reviews/${review.review_id}/${path}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Research-CSRF": "1",
            "Idempotency-Key": (key.current ??= crypto.randomUUID()),
          },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "操作未完成。");
      key.current = null;
      setMessage("已保存。");
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "操作未完成，请刷新后再试。",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="review-controls">
      {review.permissions.dispatcher &&
        review.status !== "completed" &&
        review.status !== "cancelled" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit("assign", {
                assigned_to: assignedTo,
                expected_version: review.version,
              });
            }}
          >
            <label htmlFor="reviewer-id">分派给 reviewer</label>
            <div className="review-inline-form">
              <input
                id="reviewer-id"
                value={assignedTo}
                onChange={(event) => setAssignedTo(event.target.value)}
                placeholder="reviewer 用户 UUID"
              />
              <button
                className="button button-outline"
                disabled={pending || !assignedTo}
              >
                分派
              </button>
            </div>
          </form>
        )}
      {review.permissions.reviewer && review.status === "in_review" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit("decision", {
              verdict,
              notes: notes ? { text: notes } : {},
              expected_version: review.version,
            });
          }}
        >
          <label htmlFor="review-verdict">提交复核结论</label>
          <select
            id="review-verdict"
            value={verdict}
            onChange={(event) => setVerdict(event.target.value)}
          >
            <option value="confirmed">confirmed · 现有证据足够</option>
            <option value="needs_more_evidence">
              needs_more_evidence · 建议补查
            </option>
            <option value="not_accepted">not_accepted · 不采纳</option>
          </select>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="说明核查依据、缺口或不采纳理由。"
            rows={4}
          />
          <button className="button button-primary" disabled={pending}>
            {pending ? "正在保存…" : "提交结论"}
          </button>
        </form>
      )}
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
