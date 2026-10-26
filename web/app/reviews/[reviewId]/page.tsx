import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/icon";
import { ReviewControls } from "@/components/review-controls";
import { ReviewFollowupForm } from "@/components/review-followup-form";
import { requirePageUser } from "@/lib/server/auth";
import { getReview } from "@/lib/server/review-service";
import { ApiError } from "@/lib/server/http";

export const metadata: Metadata = { title: "复核详情" };

const labels: Record<string, string> = {
  pending: "待分派",
  in_review: "复核中",
  completed: "已完成",
  cancelled: "已取消",
};

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const user = await requirePageUser();
  let review;
  try {
    review = await getReview(user.id, (await params).reviewId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  return (
    <div className="page-enter review-detail-page">
      <Link href="/reviews" className="text-link back-link">
        ← 返回复核收件箱
      </Link>
      <section className="page-heading">
        <p className="eyebrow">REVIEW CASE · VERSION {review.version}</p>
        <h1>{review.reason}</h1>
        <p className="page-description">{review.question}</p>
      </section>
      <section className="review-status-card">
        <div>
          <span className="section-index">STATUS</span>
          <strong>{labels[review.status]}</strong>
          <p>
            报告版本 {review.report_version} · 复核单版本 {review.version}
          </p>
        </div>
        <div className="review-meta">
          <span>{review.assigned_to ? "已分派负责人" : "等待分派"}</span>
          <code>{review.assigned_to ?? "—"}</code>
        </div>
      </section>
      <ReviewControls review={review} />
      {review.permissions.owner &&
        review.status === "completed" &&
        review.verdict === "needs_more_evidence" && (
          <section className="library-card review-followup-card">
            <div className="card-toolbar">
              <h2>
                <span className="section-index">FOLLOW UP</span>确认后再补查
              </h2>
              <span className="muted-label">会创建新任务，不覆盖原报告</span>
            </div>
            <ReviewFollowupForm
              reportId={review.report_id}
              reviewId={review.review_id}
            />
          </section>
        )}
      {review.report ? (
        <section className="library-card review-evidence-card">
          <div className="card-toolbar">
            <h2>
              <Icon name="document" size={18} />
              授权报告与证据
            </h2>
            <Link
              className="text-link"
              href={`/research/${review.task_id}/report`}
            >
              打开原报告 <Icon name="arrow" size={14} />
            </Link>
          </div>
          <article className="review-markdown">
            {review.report.markdown}
          </article>
          {(review.report.gaps.length > 0 ||
            review.report.citation_warnings.length > 0) && (
            <div className="review-notes">
              <strong>报告提示</strong>
              <ul>
                {[
                  ...review.report.gaps,
                  ...review.report.citation_warnings,
                ].map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : (
        <div className="notice">
          当前身份只显示分派所需信息，报告正文需要所有者或已分派 reviewer 权限。
        </div>
      )}
      <section className="library-card review-actions-card">
        <div className="card-toolbar">
          <h2>
            <Icon name="history" size={18} />
            操作记录
          </h2>
        </div>
        <ol className="review-action-list">
          {review.actions.map((action) => (
            <li key={action.action_id}>
              <span>{action.action}</span>
              <strong>
                v{action.from_version} → v{action.to_version}
              </strong>
              <small>{action.actor_id}</small>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
