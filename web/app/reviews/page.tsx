import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { requirePageUser } from "@/lib/server/auth";
import { listReviews } from "@/lib/server/review-service";

export const metadata: Metadata = { title: "人工复核" };

const labels: Record<string, string> = {
  pending: "待分派",
  in_review: "复核中",
  completed: "已完成",
  cancelled: "已取消",
};

export default async function ReviewsPage() {
  const user = await requirePageUser();
  const reviews = await listReviews(user.id);
  return (
    <div className="page-enter">
      <section className="page-heading heading-with-action">
        <div>
          <p className="eyebrow">REVIEW DESK</p>
          <h1>把疑问交给另一双眼睛。</h1>
          <p className="page-description">
            查看你申请、受分派或负责分派的人工复核，所有决定都保留版本和操作记录。
          </p>
        </div>
        <Link href="/research" className="button button-outline">
          <Icon name="history" size={16} />
          研究记录
        </Link>
      </section>
      <section
        className="library-card review-inbox"
        aria-labelledby="review-inbox-title"
      >
        <div className="card-toolbar">
          <h2 id="review-inbox-title">
            <Icon name="compass" size={18} />
            复核收件箱
          </h2>
          <span className="muted-label">共 {reviews.length} 条</span>
        </div>
        {reviews.length ? (
          <ul className="review-list">
            {reviews.map((review) => (
              <li key={review.review_id}>
                <Link
                  href={`/reviews/${review.review_id}`}
                  className="review-row"
                >
                  <span className="review-row-mark" aria-hidden="true">
                    {review.status === "completed" ? "✓" : "·"}
                  </span>
                  <span className="review-row-main">
                    <strong>{review.reason}</strong>
                    <span>{review.question}</span>
                    <small>
                      报告 v{review.report_version} ·{" "}
                      {review.assigned_to ? "已有负责人" : "待分派"}
                    </small>
                  </span>
                  <span
                    className={`review-status review-status-${review.status}`}
                  >
                    {labels[review.status]}
                  </span>
                  <Icon name="arrow" size={16} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-state">
            <span className="empty-illustration">
              <Icon name="compass" size={38} />
            </span>
            <h3>还没有人工复核</h3>
            <p>在已生成的报告页提出具体疑问，复核单会出现在这里。</p>
            <Link href="/research" className="button button-primary">
              查看研究记录
              <Icon name="arrow" size={16} />
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
