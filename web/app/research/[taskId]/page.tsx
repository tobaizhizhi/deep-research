import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/server/auth";
import { getTask } from "@/lib/server/tasks";
import { ApiError } from "@/lib/server/http";
import { displayTime } from "@/components/task-status";
import { TaskActions } from "@/components/task-actions";
import { TaskLiveStatus } from "@/components/task-live-status";

export const metadata: Metadata = { title: "研究详情" };

// App Router 的动态路由参数是 Promise，需要先 await 才能读取。
export default async function ResearchDetailPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  const user = await requirePageUser();
  let task;
  try {
    task = await getTask(user.id, taskId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="page-enter">
      <Link href="/research" className="text-link back-link">
        ← 返回研究记录
      </Link>
      <section className="page-heading">
        <p className="eyebrow">RESEARCH OVERVIEW</p>
        <h1>看见研究的每一步。</h1>
        <p className="page-description">
          已确认的研究范围与任务状态，都保存在这里。
        </p>
      </section>
      <section className="library-card">
        <div className="card-toolbar">
          <h2>
            <Icon name="compass" size={19} />
            研究详情
          </h2>
          <TaskLiveStatus taskId={taskId} initialTask={task} />
        </div>
        <div className="detail-body">
          <dl className="task-identifier">
            <dt>任务编号</dt>
            <dd>{taskId}</dd>
          </dl>
          <h2 className="task-question">{task.question}</h2>
          {task.requirements && (
            <p className="task-requirements">补充要求：{task.requirements}</p>
          )}
          <dl className="task-facts">
            <div>
              <dt>研究深度</dt>
              <dd>{task.depth === "quick" ? "快速探索" : "标准研究"}</dd>
            </div>
            <div>
              <dt>报告语言</dt>
              <dd>
                {
                  { auto: "跟随问题语言", zh: "简体中文", en: "English" }[
                    task.language
                  ]
                }
              </dd>
            </div>
            <div>
              <dt>创建时间 · 北京时间</dt>
              <dd>
                <time dateTime={task.created_at}>
                  {displayTime(task.created_at)}
                </time>
              </dd>
            </div>
          </dl>
          {task.status === "queued" && (
            <div className="notice">
              任务已保存，等待研究服务领取。页面会自动检查最新状态，也可以取消排队。
            </div>
          )}
          {task.status === "running" && (
            <div className="notice">
              {task.cancel_requested_at
                ? "已收到停止请求，研究服务正在清理当前步骤。"
                : "研究服务正在整理资料、证据和报告，页面会实时接收进度。"}
            </div>
          )}
          {task.status === "cancelled" && (
            <div className="notice">
              排队已取消，研究尚未执行。需求与取消记录仍然保留。
            </div>
          )}
          {task.error && (
            <div className="notice" role="alert">
              {task.error.message}
            </div>
          )}
          <div className="detail-grid">
            <section>
              <span className="section-index">01 / 研究过程</span>
              <h3>
                {task.status === "cancelled"
                  ? "排队已结束"
                  : task.status === "queued"
                    ? "等待开始"
                    : "任务状态已更新"}
              </h3>
              <p>{task.stop_reason || "提交已记录，可以刷新查看最新状态。"}</p>
            </section>
            <section>
              <span className="section-index">02 / 报告与证据</span>
              <h3>{task.has_report ? "报告与证据已保存" : "尚未生成报告"}</h3>
              <p>
                {task.has_report
                  ? "研究结果已归档，可以阅读报告、展开来源证据或下载 Markdown。"
                  : "研究结束后将在这里显示报告的保存状态。"}
              </p>
              {task.has_report && (
                <Link
                  href={`/research/${taskId}/report`}
                  className="text-link detail-report-link"
                >
                  阅读研究报告
                  <Icon name="arrow" size={14} />
                </Link>
              )}
            </section>
          </div>
          <TaskActions
            taskId={task.task_id}
            status={task.status}
            cancelRequested={Boolean(task.cancel_requested_at)}
            resumeAvailable={task.resume_available}
          />
          <Link href="/" className="button button-outline">
            整理一个新问题
            <Icon name="arrow" size={16} />
          </Link>
        </div>
      </section>
    </div>
  );
}
