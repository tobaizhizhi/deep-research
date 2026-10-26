"""研究流程使用的 Pydantic 数据模型和 TypedDict 状态。"""

from typing import Annotated, TypedDict
from datetime import datetime

from pydantic import BaseModel, Field, StrictInt, StringConstraints


class SearchResult(BaseModel):
    """一条搜索结果。"""

    title: str
    url: str
    snippet: str = ""
    content: str = ""
    fetched_at: datetime | None = None
    content_hash: str | None = None
    content_source: str | None = None
    # 搜索供应商未说明原文是否完整时保持未知，不声称获取了完整网页。
    content_truncated: bool | None = None


class ResearchPlan(BaseModel):
    """研究目标和准备执行的搜索查询。"""

    research_goal: str
    queries: list[str] = Field(min_length=1, max_length=5)


class ResearchDecision(BaseModel):
    """判断研究是否完成，以及还需要搜索什么。"""

    done: bool
    reason: str
    follow_up_queries: list[str] = Field(
        default_factory=list,
        max_length=3,
    )


class Finding(BaseModel):
    claim: str
    evidence: str
    source_urls: list[str] = Field(min_length=1)


class FindingSet(BaseModel):
    """从搜索资料中提取的研究发现和信息缺口。"""

    findings: list[Finding]
    gaps: list[str]


class BriefPoint(BaseModel):
    """研究简报的一条内容，编号只在当前研究员的 findings 内有效。"""

    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    finding_ids: list[StrictInt] = Field(min_length=1)


class CompressedResearch(BaseModel):
    """整理研究结果，保留事实、条件和分歧，不要求比原文短。"""

    key_findings: list[BriefPoint] = Field(min_length=1)
    limitations: list[BriefPoint]
    conflicts: list[BriefPoint]


class ResearchState(TypedDict, total=False):
    run_id: str
    graph_run_id: str
    graph_thread_id: str
    resume: bool
    task_id: str
    attempt_id: str
    researcher_id: str
    model_name: str
    model_profile: str
    max_results_per_query: int
    topic: str

    question: str
    research_goal: str
    queries: list[str]
    sources: list[SearchResult]
    latest_sources: list[SearchResult]
    searched_queries: list[str]
    findings: list[Finding]
    citation_warnings: list[str]
    gaps: list[str]
    search_round: int
    max_search_rounds: int
    done: bool
    should_stop: bool
    stop_reason: str
    final_report: str
    error: str

    enable_research_compression: bool

    # 已格式化的研究简报；原始发现和网页仍保留在上面的字段中。
    compressed_research: str
    # 沿用旧字段名，表示简报引用的局部发现编号，并非全局编号。
    summary_finding_ids: list[int]
    compression_used: bool
    compression_warning: str


class DelegationPlan(BaseModel):
    """Supervisor 拆分出来的研究主题。"""

    topics: list[str] = Field(
        min_length=1,
        max_length=3,
    )


class SupervisorDecision(BaseModel):
    """针对原始问题的总体评审结果。"""

    done: bool
    reason: str
    gaps: list[str]
    follow_up_topics: list[str] = Field(
        default_factory=list,
        max_length=3,
    )


class ResearcherOutput(TypedDict):
    """一个 Researcher 返回给 Supervisor 的结果。"""

    topic: str
    researcher_id: str
    findings: list[Finding]
    sources: list[SearchResult]
    gaps: list[str]
    search_round: int
    searched_queries: list[str]
    done: bool
    stop_reason: str

    compressed_research: str
    summary_finding_ids: list[int]
    compression_used: bool
    compression_warning: str


class SupervisorState(TypedDict, total=False):
    run_id: str
    graph_run_id: str
    graph_thread_id: str
    resume: bool
    task_id: str
    attempt_id: str
    model_name: str
    model_profile: str
    max_results_per_query: int

    question: str
    research_goal: str

    # 单个 Researcher 的搜索轮数上限。
    max_search_rounds: int

    # Supervisor 最多委派多少批任务。
    max_supervisor_rounds: int
    supervisor_round: int

    # 下一批准备执行的主题。
    topics: list[str]

    # 已执行并返回结果的主题，不代表它们的证据一定充分。
    completed_topics: list[str]

    research_results: list[ResearcherOutput]

    # 所有 Researcher 汇总后的资料。
    findings: list[Finding]
    sources: list[SearchResult]
    gaps: list[str]

    done: bool
    should_stop: bool
    stop_reason: str

    final_report: str
    citation_warnings: list[str]

    max_concurrent_researchers: int

    enable_research_compression: bool

    # 记录每轮总体评审实际使用的材料长度。
    compression_metrics: list[dict]
