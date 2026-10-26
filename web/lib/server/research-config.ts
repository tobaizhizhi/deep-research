import "server-only";
import { researchConfigSchema, type CreateResearchInput } from "../contracts";

const profiles = {
  quick: {
    max_search_rounds: 1,
    max_supervisor_rounds: 1,
    max_concurrent_researchers: 2,
    max_results_per_query: 3,
    total_timeout_seconds: 300,
  },
  standard: {
    max_search_rounds: 2,
    max_supervisor_rounds: 2,
    max_concurrent_researchers: 2,
    max_results_per_query: 5,
    total_timeout_seconds: 600,
  },
} as const;

// 仅服务器构建；createTask 在同一事务中将此结果写入 config_json。
export function buildResearchConfig(depth: CreateResearchInput["depth"]) {
  const compression = process.env.RESEARCH_COMPRESSION_ENABLED ?? "true";
  if (!["true", "false"].includes(compression))
    throw new Error("INVALID_COMPRESSION_CONFIG");
  return Object.freeze(
    researchConfigSchema.parse({
      schema_version: 1,
      graph_mode: "fixed",
      model_name: process.env.RESEARCH_MODEL_NAME ?? "deepseek-chat",
      model_profile:
        process.env.RESEARCH_MODEL_PROFILE ?? "deepseek-default-v1",
      code_version: process.env.RESEARCH_CODE_VERSION ?? "local-p2",
      prompt_version: process.env.RESEARCH_PROMPT_VERSION ?? "v1",
      ...profiles[depth],
      enable_research_compression: compression === "true",
    }),
  );
}
