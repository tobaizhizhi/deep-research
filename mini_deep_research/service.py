"""数据库任务与现有研究图之间的适配层；不读取队列、不持有数据库事务。"""

from pydantic import BaseModel, ConfigDict, Field

from .config import resolve_model_settings
from .contracts import CreateResearchInput, ResearchConfig, UUIDText
from .graph import build_research_graph
from collections.abc import Awaitable, Callable

from .log_utils import (
    service_checkpoint,
    service_checkpointer,
    service_event_sink,
    service_execution,
    service_identity,
    service_subtask_registry,
    service_subtask_result_sink,
)
from .models import Finding, SearchResult, SupervisorState


class ResearchTask(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    task_id: UUIDText
    attempt_id: UUIDText
    input: CreateResearchInput
    config: ResearchConfig
    graph_run_id: UUIDText | None = None
    graph_thread_id: str | None = None
    checkpoint_ns: str = ""
    resume: bool = False
    budget_remaining_seconds: float | None = None
    state_schema_version: int = 1
    graph_code_version: str | None = None
    graph_prompt_version: str | None = None


class ResearcherArchive(BaseModel):
    model_config = ConfigDict(extra="forbid")
    researcher_id: str = "legacy"
    topic: str
    findings: list[Finding]
    sources: list[SearchResult]
    gaps: list[str]
    search_round: int = Field(ge=1)
    searched_queries: list[str]
    done: bool = Field(strict=True)
    stop_reason: str = Field(min_length=1)
    compressed_research: str = ""
    summary_finding_ids: list[int] = Field(default_factory=list)
    compression_used: bool = False
    compression_warning: str = ""


class ResearchArchive(BaseModel):
    """显式白名单序列化，不把完整 state、运行时依赖或凭证写入数据库。"""

    model_config = ConfigDict(extra="forbid")
    final_report: str = Field(min_length=1)
    research_done: bool = Field(strict=True)
    stop_reason: str = Field(min_length=1)
    findings: list[Finding]
    sources: list[SearchResult]
    gaps: list[str]
    citation_warnings: list[str]
    compression_metrics: list[dict]
    research_results: list[ResearcherArchive]


def build_graph_input(task: ResearchTask) -> SupervisorState:
    language = {
        "auto": "跟随原始问题的语言。",
        "zh": "最终报告使用中文；搜索可以使用其他语言。",
        "en": "Write the final report in English; searches may use other languages.",
    }[task.input.language]
    return {
        # run_id 是逻辑图运行身份；attempt_id 只表示本次服务执行权。
        "run_id": task.graph_run_id or task.attempt_id,
        "graph_run_id": task.graph_run_id or task.attempt_id,
        "graph_thread_id": task.graph_thread_id or f"research:{task.task_id}",
        "resume": task.resume,
        "task_id": task.task_id,
        "attempt_id": task.attempt_id,
        "question": (
            f"原始问题：\n{task.input.question}\n\n"
            f"补充要求：\n{task.input.requirements or '无'}\n\n"
            f"输出语言要求：\n{language}"
        ),
        **{
            key: getattr(task.config, key)
            for key in (
                "model_name",
                "model_profile",
                "max_search_rounds",
                "max_supervisor_rounds",
                "max_concurrent_researchers",
                "max_results_per_query",
                "enable_research_compression",
            )
        },
    }


def serialize_result(state: SupervisorState) -> ResearchArchive:
    if not state.get("should_stop") or not state.get("final_report", "").strip():
        raise ValueError("研究图未返回完整终态报告")
    if not state.get("stop_reason", "").strip():
        raise ValueError("研究图缺少停止原因")
    return ResearchArchive(
        final_report=state["final_report"],
        research_done=state["done"],
        stop_reason=state["stop_reason"],
        findings=state["findings"],
        sources=state["sources"],
        gaps=state["gaps"],
        citation_warnings=state["citation_warnings"],
        compression_metrics=state.get("compression_metrics", []),
        research_results=state["research_results"],
    )


async def run_research_task(
    task: ResearchTask,
    *,
    event_sink: Callable[[str, dict], Awaitable[None]] | None = None,
    checkpoint: Callable[[], Awaitable[None]] | None = None,
    checkpointer=None,
    subtask_registry=None,
    subtask_result_sink=None,
) -> ResearchArchive:
    # 提前校验配置档，所有节点仍显式使用同一份非敏感模型配置。
    resolve_model_settings(task.config.model_name, task.config.model_profile)
    identity = service_identity.set((task.task_id, task.attempt_id))
    event_token = service_event_sink.set(event_sink)
    checkpoint_token = service_checkpoint.set(checkpoint)
    checkpointer_token = service_checkpointer.set(checkpointer)
    registry_token = service_subtask_registry.set(subtask_registry)
    result_sink_token = service_subtask_result_sink.set(subtask_result_sink)
    execution_token = service_execution.set(
        (task.graph_run_id or task.attempt_id, task.attempt_id, task.resume)
    )
    try:
        graph = build_research_graph(checkpointer) if checkpointer is not None else build_research_graph()
        input_state = build_graph_input(task)
        config = {
            "recursion_limit": 2 * task.config.max_supervisor_rounds + 10,
            "configurable": {
                "thread_id": task.graph_thread_id or f"research:{task.task_id}",
                "checkpoint_ns": task.checkpoint_ns,
            },
        }
        state = await graph.ainvoke(
            None if task.resume else input_state,
            config=config,
        )
        return serialize_result(state)
    finally:
        service_execution.reset(execution_token)
        service_subtask_result_sink.reset(result_sink_token)
        service_subtask_registry.reset(registry_token)
        service_checkpointer.reset(checkpointer_token)
        service_checkpoint.reset(checkpoint_token)
        service_event_sink.reset(event_token)
        service_identity.reset(identity)
