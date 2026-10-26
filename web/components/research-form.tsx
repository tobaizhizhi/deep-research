"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "./icon";
import {
  createResearchSchema,
  type CreateResearchInput,
  uuidSchema,
} from "@/lib/contracts";

const depths = {
  quick: {
    title: "快速探索",
    detail: "适合初步了解一个问题",
    budget: "每个研究员最多搜索 1 轮 · 最多 1 批任务 · 执行时限 5 分钟",
  },
  standard: {
    title: "标准研究",
    detail: "适合多角度梳理与对照",
    budget: "每个研究员最多搜索 2 轮 · 最多 2 批任务 · 执行时限 10 分钟",
  },
} as const;

const languages = {
  auto: "跟随问题语言",
  zh: "简体中文",
  en: "English",
} as const;

type ResearchDraft = CreateResearchInput;

const suggestions = [
  { label: "了解一项技术", question: "LangGraph 是什么，适合哪些应用场景？" },
  {
    label: "比较不同方案",
    question: "小型团队搭建知识库问答系统，如何选择 RAG 方案？",
  },
  {
    label: "探索行业趋势",
    question: "2025 年以来，AI 智能体在软件开发中的应用有哪些变化？",
  },
];

export function ResearchForm() {
  const router = useRouter();
  const submissionKey = useRef<string | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [clarifications, setClarifications] = useState<string[]>([]);
  const [draft, setDraft] = useState<ResearchDraft>({
    question: "",
    requirements: "",
    language: "auto",
    depth: "standard",
  });
  const [error, setError] = useState("");
  // 预览保存的是用户本次确认的输入；一旦编辑就清除，避免显示旧范围。
  const [preview, setPreview] = useState<ResearchDraft | null>(null);

  function update<K extends keyof ResearchDraft>(
    key: K,
    value: ResearchDraft[K],
  ) {
    if (inFlight.current) return;
    setDraft((current) => ({ ...current, [key]: value }));
    submissionKey.current = null;
    setPreview(null);
    setError("");
    setSubmitError("");
    setClarifications([]);
  }

  function handlePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const parsed = createResearchSchema.safeParse(draft);
    if (!parsed.success) {
      setError("请填写 1–4000 字的研究问题，补充要求不超过 2000 字。");
      setPreview(null);
      document.getElementById("research-question")?.focus();
      return;
    }

    setError("");
    setPreview(parsed.data);
    // 预览不发请求；只有下面的“确认并提交”才创建任务。
  }

  async function submitResearch() {
    if (!preview || inFlight.current) return;
    submissionKey.current ??= crypto.randomUUID();
    inFlight.current = true;
    setPending(true);
    setSubmitError("");
    setNeedsLogin(false);
    setClarifications([]);
    try {
      const response = await fetch("/api/v1/research/tasks", {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
          "X-Research-CSRF": "1",
          "Idempotency-Key": submissionKey.current,
        },
        body: JSON.stringify(preview),
      });
      const result = await response.json();
      if (!response.ok) {
        setNeedsLogin(response.status === 401);
        setSubmitError(
          response.status === 401
            ? "请先登录，再回来提交。当前输入会保留在这个页面。"
            : (result.error?.message ?? "提交未完成，请稍后重试。"),
        );
        if (
          response.status === 422 &&
          result.error?.code === "NEEDS_CLARIFICATION"
        ) {
          setClarifications(
            Array.isArray(result.error.questions)
              ? result.error.questions.filter(
                  (item: unknown) => typeof item === "string",
                )
              : [],
          );
        }
        return;
      }
      const taskId = uuidSchema.parse(result.task_id);
      router.push(`/research/${taskId}`);
      // 成功后清除旧确认，返回首页不会误重用成功任务的输入状态。
      submissionKey.current = null;
      setPreview(null);
      setDraft({
        question: "",
        requirements: "",
        language: "auto",
        depth: "standard",
      });
    } catch {
      // 响应丢失不代表服务器没有提交；保留同一个 key，让用户安全重试。
      setSubmitError(
        "暂时无法确认提交结果。请留在此页重试，系统会核对是否已经创建任务。",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section className="form-card" aria-labelledby="form-title">
      <div className="form-card-heading">
        <div>
          <span className="section-index">01 / 新的探索</span>
          <h2 id="form-title">你想研究什么？</h2>
        </div>
        <span className="form-heading-icon">
          <Icon name="plus" size={22} />
        </span>
      </div>
      <form onSubmit={handlePreview} noValidate>
        <fieldset className="draft-fields" disabled={pending}>
          <legend className="sr-only">研究需求</legend>
          <div className="field">
            <label htmlFor="research-question">
              研究问题{" "}
              <span className="required-mark" aria-label="必填">
                *
              </span>
            </label>
            <div className={`textarea-wrap${error ? " has-error" : ""}`}>
              <textarea
                id="research-question"
                name="question"
                required
                value={draft.question}
                onChange={(event) => update("question", event.target.value)}
                placeholder="例如：LangGraph 是什么，适合哪些应用场景？"
                rows={4}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "question-error" : "question-hint"}
              />
              <span className="character-count">
                {Array.from(draft.question).length} / 4000
              </span>
            </div>
            {error ? (
              <p className="field-error" id="question-error" role="alert">
                {error}
              </p>
            ) : (
              <p className="field-hint" id="question-hint">
                一个清晰的问题，是深入研究的第一步。
              </p>
            )}
            <div className="suggestions" aria-label="问题示例">
              {suggestions.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion.label}
                  onClick={() => update("question", suggestion.question)}
                >
                  <Icon name="plus" size={12} />
                  {suggestion.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field requirements-field">
            <label htmlFor="requirements">
              补充要求 <span className="optional">选填</span>
            </label>
            <textarea
              id="requirements"
              name="requirements"
              value={draft.requirements}
              onChange={(event) => update("requirements", event.target.value)}
              placeholder="你关心的角度、时间范围、偏好的来源……"
              rows={2}
              aria-describedby="requirements-hint"
            />
            <p className="field-hint" id="requirements-hint">
              最多 2000 字，无须为开放问题额外设置限制。
            </p>
          </div>
          <fieldset className="depth-field">
            <legend>研究深度</legend>
            <div className="depth-options">
              {Object.entries(depths).map(([value, option]) => (
                <label
                  key={value}
                  className={`depth-option${draft.depth === value ? " is-selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="depth"
                    value={value}
                    checked={draft.depth === value}
                    onChange={() =>
                      update("depth", value as ResearchDraft["depth"])
                    }
                  />
                  <span className="radio-indicator" aria-hidden="true" />
                  <span>
                    <strong>{option.title}</strong>
                    <small>{option.detail}</small>
                  </span>
                  {value === "standard" && (
                    <span className="recommended">推荐</span>
                  )}
                </label>
              ))}
            </div>
            <p className="field-hint budget-hint">
              {depths[draft.depth].budget}
            </p>
          </fieldset>
          <div className="language-field">
            <label htmlFor="language">报告语言</label>
            <select
              id="language"
              name="language"
              value={draft.language}
              onChange={(event) =>
                update(
                  "language",
                  event.target.value as ResearchDraft["language"],
                )
              }
            >
              {Object.entries(languages).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-bottom">
            <p>
              <span className="status-dot" />
              先确认范围，再提交任务
              <br />
              <small>提交后由后台研究服务执行</small>
            </p>
            <button type="submit" className="button button-primary">
              预览研究需求
              <Icon name="arrow" size={17} />
            </button>
          </div>
        </fieldset>
      </form>
      {preview && (
        <section
          className="draft-preview"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <h3>
            <Icon name="check" size={18} />
            研究需求预览
          </h3>
          <p className="preview-question">{preview.question}</p>
          {preview.requirements && (
            <p className="preview-requirements">
              补充要求：{preview.requirements}
            </p>
          )}
          <dl>
            <div>
              <dt>研究深度</dt>
              <dd>{depths[preview.depth].title}</dd>
            </div>
            <div>
              <dt>报告语言</dt>
              <dd>{languages[preview.language]}</dd>
            </div>
          </dl>
          <p className="field-hint">
            {depths[preview.depth].budget}。时限是执行上限，不是完成时间保证。
          </p>
          <div className="preview-footer">
            <span>提交后保存为排队任务，后台服务会继续生成报告。</span>
            <button
              type="button"
              className="button button-primary"
              onClick={submitResearch}
              disabled={pending}
            >
              {pending ? "正在提交…" : "确认并提交"}
            </button>
          </div>
          {submitError && (
            <p className="field-error" role="alert">
              {submitError}
            </p>
          )}
          {clarifications.length > 0 && (
            <ul>
              {clarifications.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ul>
          )}
          {needsLogin && (
            <Link
              href="/login"
              target="_blank"
              rel="noopener noreferrer"
              className="text-link"
            >
              在新标签页登录，完成后回来提交
            </Link>
          )}
        </section>
      )}
    </section>
  );
}
