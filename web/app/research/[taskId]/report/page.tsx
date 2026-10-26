import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/icon";
import { ReportViewer } from "@/components/ReportViewer";
import { ReviewRequestForm } from "@/components/review-request-form";
import { ReportFeedbackForm } from "@/components/report-feedback-form";
import { displayTime } from "@/components/task-status";
import { ApiError } from "@/lib/server/http";
import { requirePageUser } from "@/lib/server/auth";
import { getReport } from "@/lib/server/tasks";

export const metadata: Metadata = { title: "研究报告" };

export default async function ResearchReportPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  const user = await requirePageUser();
  let report;
  try {
    report = await getReport(user.id, taskId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    if (error instanceof ApiError && error.status === 409) {
      return (
        <section className="library-card empty-state" role="status">
          <h1>报告还在路上</h1>
          <p>
            研究任务已经保存，但报告尚未归档。回到任务详情可以查看最新状态。
          </p>
          <Link href={`/research/${taskId}`} className="button button-primary">
            返回任务详情
            <Icon name="arrow" size={16} />
          </Link>
        </section>
      );
    }
    throw error;
  }

  return (
    <div className="page-enter report-page">
      <Link href={`/research/${taskId}`} className="text-link back-link">
        ← 返回任务详情
      </Link>
      <section className="page-heading heading-with-action">
        <div>
          <p className="eyebrow">RESEARCH REPORT · VERSION {report.version}</p>
          <h1>把发现，读成自己的理解。</h1>
          <p className="page-description">
            报告来自已归档的研究结果。点击正文引用，可以回看支持它的来源与证据。
          </p>
        </div>
        <a
          href={`/api/v1/research/tasks/${taskId}/report/download?format=markdown`}
          className="button button-primary"
        >
          <Icon name="download" size={16} />
          下载 Markdown
        </a>
      </section>

      <section className="report-overview" aria-label="报告状态">
        <div>
          <span className="section-index">REPORT STATUS</span>
          <strong>报告已生成</strong>
          <p>
            {report.research_done
              ? "研究评审认为现有证据足以回答当前问题。"
              : "报告已生成，但研究仍保留必要的信息缺口。"}
          </p>
        </div>
        <dl>
          <div>
            <dt>归档时间</dt>
            <dd>{displayTime(report.created_at)}</dd>
          </div>
          <div>
            <dt>研究判断</dt>
            <dd>{report.research_done ? "证据充分" : "仍有缺口"}</dd>
          </div>
        </dl>
      </section>

      {(report.gaps.length > 0 || report.citation_warnings.length > 0) && (
        <section className="report-notes" aria-label="报告提示">
          {report.gaps.length > 0 && (
            <div className="report-note report-note-gap">
              <span className="section-index">必要缺口</span>
              <ul>
                {report.gaps.map((gap, index) => (
                  <li key={index}>{gap}</li>
                ))}
              </ul>
            </div>
          )}
          {report.citation_warnings.length > 0 && (
            <div className="report-note report-note-warning">
              <span className="section-index">引用检查</span>
              <ul>
                {report.citation_warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <ReportViewer taskId={taskId} report={report} />

      <section className="library-card review-request-card">
        <div className="card-toolbar">
          <h2>
            <span className="section-index">P8</span>需要另一双眼睛？
          </h2>
          <span className="muted-label">人工复核不会自动消耗研究额度</span>
        </div>
        <ReviewRequestForm taskId={taskId} reportId={report.report_id} />
        <ReportFeedbackForm taskId={taskId} reportId={report.report_id} />
      </section>

      <section className="report-stop-reason">
        <span className="section-index">研究停止原因</span>
        <p>{report.stop_reason}</p>
      </section>
    </div>
  );
}
