"use client";

import { useEffect, useState } from "react";
import type { EvidencePage, EvidenceSource } from "@/lib/contracts";
import { displayTime } from "./task-status";

export function EvidencePanel({
  taskId,
  reportId,
  sourceUrl,
  onClose,
}: {
  taskId: string;
  reportId: string;
  sourceUrl: string | null;
  onClose: () => void;
}) {
  const [page, setPage] = useState<EvidencePage | null>(null);
  const [errorState, setErrorState] = useState<{
    sourceUrl: string;
    message: string;
  } | null>(null);
  const selectedPage =
    sourceUrl && page?.selected_source?.url === sourceUrl ? page : null;
  const error =
    sourceUrl && errorState?.sourceUrl === sourceUrl ? errorState.message : "";
  const loading = Boolean(sourceUrl && !selectedPage && !error);

  useEffect(() => {
    if (!sourceUrl) return;
    const controller = new AbortController();
    void fetch(
      `/api/v1/research/tasks/${taskId}/evidence?report_id=${encodeURIComponent(reportId)}&source_url=${encodeURIComponent(sourceUrl)}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const result = (await response.json()) as
          EvidencePage | { error?: { message?: string } };
        if (!response.ok)
          throw new Error(
            "error" in result
              ? (result.error?.message ?? "证据读取失败")
              : "证据读取失败",
          );
        setPage(result as EvidencePage);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError")
          return;
        setErrorState({
          sourceUrl,
          message:
            reason instanceof Error
              ? reason.message
              : "证据读取失败，请稍后重试。",
        });
      });
    return () => controller.abort();
  }, [reportId, sourceUrl, taskId]);

  return (
    <aside className="evidence-panel" aria-label="来源证据">
      <div className="evidence-panel-heading">
        <div>
          <span className="section-index">SOURCE TRACE</span>
          <h2>来源与证据</h2>
        </div>
        <button
          type="button"
          className="evidence-close"
          onClick={onClose}
          aria-label="关闭来源面板"
        >
          ×
        </button>
      </div>
      {!sourceUrl ? (
        <div className="evidence-empty">
          <p>点击报告中的引用，查看它支持的发现与归档内容。</p>
        </div>
      ) : loading ? (
        <div className="evidence-empty" role="status">
          <p>正在读取归档证据…</p>
        </div>
      ) : error ? (
        <div className="evidence-empty" role="alert">
          <p>{error}</p>
          <button type="button" className="text-link" onClick={onClose}>
            关闭并重新选择
          </button>
        </div>
      ) : selectedPage?.selected_source ? (
        <EvidenceSourceDetail
          source={selectedPage.selected_source}
          findings={selectedPage.selected_findings}
        />
      ) : null}
    </aside>
  );
}

function EvidenceSourceDetail({
  source,
  findings,
}: {
  source: EvidenceSource;
  findings: EvidencePage["selected_findings"];
}) {
  return (
    <div className="evidence-panel-body">
      <p className="evidence-source-title">{source.title}</p>
      {isSafeHttpUrl(source.url) ? (
        <a
          className="evidence-external-link"
          href={source.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          打开原网页 ↗
        </a>
      ) : (
        <span className="evidence-unavailable-link">
          原网页链接不可安全打开
        </span>
      )}
      <dl className="evidence-facts">
        <div>
          <dt>获取时间</dt>
          <dd>{source.fetched_at ? displayTime(source.fetched_at) : "未知"}</dd>
        </div>
        <div>
          <dt>内容来源</dt>
          <dd>{source.content_source ?? "未知"}</dd>
        </div>
      </dl>
      <section className="evidence-quote">
        <span className="section-index">归档正文</span>
        <p>{source.content || source.snippet || "这条来源没有保存正文。"}</p>
        {source.content_truncated && (
          <small>正文超过展示上限，仅显示归档开头。</small>
        )}
      </section>
      <section className="related-findings">
        <span className="section-index">相关发现 · {findings.length}</span>
        {findings.length > 0 ? (
          <ul>
            {findings.map((finding) => (
              <li key={finding.finding_id}>
                <strong>{finding.claim}</strong>
                <p>{finding.evidence}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p>报告正文没有把这条来源关联到结构化发现。</p>
        )}
      </section>
    </div>
  );
}

function isSafeHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
