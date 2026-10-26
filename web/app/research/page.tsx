import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { requirePageUser } from "@/lib/server/auth";
import { listTasks } from "@/lib/server/tasks";
import { ApiError, validateInput } from "@/lib/server/http";
import { listTasksQuerySchema } from "@/lib/contracts";
import {
  TaskStatusBadge,
  taskStatusLabels,
  displayTime,
} from "@/components/task-status";

export const metadata: Metadata = { title: "研究记录" };

export default async function ResearchHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  let query;
  let page;
  try {
    query = validateInput(listTasksQuerySchema, await searchParams);
    page = await listTasks(user.id, query);
  } catch (error) {
    if (error instanceof ApiError && error.status === 400)
      return (
        <section className="empty-state">
          <h1>无法读取这个分页位置</h1>
          <p>{error.message}</p>
          <Link href="/research" className="button button-primary">
            回到研究记录首页
          </Link>
        </section>
      );
    throw error;
  }
  const nextParams = new URLSearchParams({ limit: String(query.limit) });
  if (query.status) nextParams.set("status", query.status);
  if (page.next_cursor) nextParams.set("cursor", page.next_cursor);
  return (
    <div className="page-enter">
      <section className="page-heading heading-with-action">
        <div>
          <p className="eyebrow">YOUR RESEARCH LIBRARY</p>
          <h1>每一次探索，都有迹可循。</h1>
          <p className="page-description">
            在这里回到问题本身，重新阅读发现与依据。
          </p>
        </div>
        <Link href="/" className="button button-primary">
          <Icon name="plus" size={17} />
          新建研究
        </Link>
      </section>
      <section className="library-card" aria-labelledby="library-title">
        <div className="card-toolbar">
          <h2 id="library-title">
            <Icon name="history" size={18} />
            研究记录
          </h2>
          <span className="muted-label">仅你可见 · 北京时间</span>
        </div>
        <nav className="task-filters" aria-label="按任务状态筛选">
          <Link
            href="/research"
            aria-current={!query.status ? "page" : undefined}
          >
            全部
          </Link>
          {Object.entries(taskStatusLabels).map(([value, label]) => (
            <Link
              key={value}
              href={`/research?status=${value}`}
              aria-current={query.status === value ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        {page.items.length > 0 ? (
          <>
            <ul className="task-list">
              {page.items.map((task) => (
                <li key={task.task_id}>
                  <Link
                    href={`/research/${task.task_id}`}
                    className="task-row"
                    prefetch={false}
                  >
                    <span className="task-row-icon" aria-hidden="true">
                      <Icon name="document" size={22} />
                    </span>
                    <div className="task-row-main">
                      <h3>{task.question}</h3>
                      <time dateTime={task.created_at}>
                        {displayTime(task.created_at)}
                      </time>
                    </div>
                    <TaskStatusBadge status={task.status} />
                    <Icon name="arrow" size={16} />
                  </Link>
                </li>
              ))}
            </ul>
            <div className="task-pagination">
              <span>本页 {page.items.length} 条</span>
              {query.cursor && (
                <Link
                  href={
                    query.status
                      ? `/research?status=${query.status}`
                      : "/research"
                  }
                  className="text-link"
                >
                  回到第一页
                </Link>
              )}
              {page.next_cursor && (
                <Link
                  className="button button-outline"
                  href={`/research?${nextParams}`}
                >
                  下一页 <Icon name="arrow" size={14} />
                </Link>
              )}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <span className="empty-illustration">
              <Icon name="document" size={38} />
              <span className="empty-illustration-dot" />
            </span>
            <h3>
              {query.status || query.cursor
                ? "这里暂时没有任务"
                : "你的研究空间，正待开启"}
            </h3>
            <p>
              {query.status || query.cursor
                ? "可以回到全部记录，或确认一个新的研究问题。"
                : "确认第一个研究问题后，就能在这里查看和管理任务。"}
              <br />
              研究完成后，报告和证据会保存在对应任务中。
            </p>
            <Link href="/" className="button button-primary">
              从一个问题开始
              <Icon name="arrow" size={16} />
            </Link>
            <Link className="text-link muted-link" href="/research">
              查看全部研究记录
              <Icon name="arrow" size={14} />
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
