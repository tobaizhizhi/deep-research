import { z } from "zod";

// 与 Python / JSON Schema 统一：按 Unicode 码点计数，只去除首尾 ASCII 空白。
export const trimInput = (value: string) =>
  value.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
const textInput = (min: number, max: number) =>
  z
    .string()
    .transform(trimInput)
    .refine(
      (value) =>
        Array.from(value).length >= min && Array.from(value).length <= max,
      `长度应为 ${min}–${max} 个字符`,
    )
    .refine(
      (value) => !value.includes(String.fromCharCode(0)),
      "文本不能包含 NUL 字符",
    );
export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$(?![\s\S])/,
  );
export const createResearchSchema = z.strictObject({
  question: textInput(1, 4000),
  requirements: textInput(0, 2000).default(""),
  language: z.enum(["auto", "zh", "en"]).default("auto"),
  depth: z.enum(["quick", "standard"]).default("standard"),
  parent_report_id: uuidSchema.optional(),
  review_id: uuidSchema.optional(),
});
export type CreateResearchInput = z.infer<typeof createResearchSchema>;

const label = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$(?![\s\S])/);
export const researchConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  graph_mode: z.literal("fixed"),
  model_name: label,
  model_profile: label,
  code_version: label,
  prompt_version: label,
  max_search_rounds: z.int().min(1).max(5),
  max_supervisor_rounds: z.int().min(1).max(5),
  max_concurrent_researchers: z.int().min(1).max(4),
  max_results_per_query: z.int().min(1).max(10),
  total_timeout_seconds: z.int().min(30).max(1800),
  enable_research_compression: z.boolean(),
});
export type ResearchConfig = z.infer<typeof researchConfigSchema>;

export const researchJobSchema = z.strictObject({
  schema_version: z.literal(1),
  message_id: uuidSchema,
  type: z.literal("research.run"),
  task_id: uuidSchema,
  attempt_id: uuidSchema,
  created_at: z.iso
    .datetime({ offset: false })
    .regex(
      /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$(?![\s\S])/,
    ),
});
export const RESEARCH_STREAM = "research:jobs:v1";
export const RESEARCH_CONSUMER_GROUP = "research-workers-v1";

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const listTasksQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .refine((value) => value <= 100)
    .default(20),
  cursor: z.string().min(1).max(1024).optional(),
  status: taskStatusSchema.optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export type TaskSummary = {
  task_id: string;
  question: string;
  status: TaskStatus;
  created_at: string;
};
export type TaskDetail = TaskSummary & {
  requirements: string;
  language: CreateResearchInput["language"];
  depth: CreateResearchInput["depth"];
  current_attempt_id: string | null;
  attempt_number: number | null;
  last_event_seq: string;
  min_event_seq: string | null;
  latest_event_type: string | null;
  research_done: boolean | null;
  stop_reason: string;
  cancel_requested_at: string | null;
  updated_at: string;
  has_report: boolean;
  resume_available: boolean;
  error: { code: string; message: string } | null;
  parent_report_id: string | null;
  review_id: string | null;
};
export type CreateTaskResult = {
  task_id: string;
  attempt_id: string;
  status: TaskStatus;
  status_url: string;
};

export type ResearchReport = {
  report_id: string;
  task_id: string;
  version: number;
  markdown: string;
  gaps: string[];
  citation_warnings: string[];
  research_done: boolean;
  stop_reason: string;
  created_at: string;
};

export type EvidenceSource = {
  title: string;
  url: string;
  snippet: string;
  fetched_at: string | null;
  content_hash: string | null;
  content_source: string | null;
  content_truncated: boolean | null;
  content?: string;
};

export type EvidenceFinding = {
  finding_id: number;
  claim: string;
  evidence: string;
  source_urls: string[];
  sources: EvidenceSource[];
};

export type EvidencePage = {
  report_id: string;
  items: EvidenceFinding[];
  next_cursor: string | null;
  selected_source: EvidenceSource | null;
  selected_findings: EvidenceFinding[];
};

export type TaskEvent = {
  id: string;
  event: string;
  data: Record<string, unknown>;
};
