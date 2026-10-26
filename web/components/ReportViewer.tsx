"use client";

import { useState, type ReactNode } from "react";
import type { ResearchReport } from "@/lib/contracts";
import { EvidencePanel } from "./EvidencePanel";

export function ReportViewer({
  taskId,
  report,
}: {
  taskId: string;
  report: ResearchReport;
}) {
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  return (
    <div className="report-layout">
      <article className="report-article" aria-label="研究报告正文">
        <SafeMarkdown
          markdown={report.markdown}
          onCitationClick={setSourceUrl}
        />
      </article>
      <EvidencePanel
        taskId={taskId}
        reportId={report.report_id}
        sourceUrl={sourceUrl}
        onClose={() => setSourceUrl(null)}
      />
    </div>
  );
}

function SafeMarkdown({
  markdown,
  onCitationClick,
}: {
  markdown: string;
  onCitationClick: (url: string) => void;
}) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    if (text) {
      blocks.push(
        <p key={`paragraph-${index++}`}>
          <InlineMarkdown text={text} onCitationClick={onCitationClick} />
        </p>,
      );
    }
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*```(?:[a-zA-Z0-9_-]+)?\s*$/);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${index}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^\s*(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const content = (
        <InlineMarkdown text={heading[2]} onCitationClick={onCitationClick} />
      );
      if (heading[1].length === 1)
        blocks.push(<h1 key={`heading-${index}`}>{content}</h1>);
      else if (heading[1].length === 2)
        blocks.push(<h2 key={`heading-${index}`}>{content}</h2>);
      else blocks.push(<h3 key={`heading-${index}`}>{content}</h3>);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      blocks.push(<hr key={`rule-${index}`} />);
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ul key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>
              <InlineMarkdown text={item} onCitationClick={onCitationClick} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ol key={`ordered-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>
              <InlineMarkdown text={item} onCitationClick={onCitationClick} />
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*>\s?(.*)$/);
        if (!item) break;
        quoteLines.push(item[1]);
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          <InlineMarkdown
            text={quoteLines.join(" ")}
            onCitationClick={onCitationClick}
          />
        </blockquote>,
      );
      continue;
    }

    if (!line.trim()) flushParagraph();
    else paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();

  return <div className="markdown-body">{blocks}</div>;
}

function InlineMarkdown({
  text,
  onCitationClick,
}: {
  text: string;
  onCitationClick: (url: string) => void;
}) {
  const tokenPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;
  const output: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text)) !== null) {
    const current = match;
    if (current.index > cursor) output.push(text.slice(cursor, current.index));
    if (current[1] && isSafeHttpUrl(current[2])) {
      output.push(
        <button
          type="button"
          className="citation-link"
          key={`citation-${current.index}`}
          onClick={() => onCitationClick(current[2])}
          title={current[2]}
        >
          {current[1]}
        </button>,
      );
    } else if (current[3]) {
      output.push(<strong key={`bold-${current.index}`}>{current[3]}</strong>);
    } else {
      output.push(current[0]);
    }
    cursor = current.index + current[0].length;
  }
  if (cursor < text.length) output.push(text.slice(cursor));
  return <>{output}</>;
}

function isSafeHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
