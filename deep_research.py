"""演示入口。核心实现位于 mini_deep_research/，原来的导入方式仍可用。"""

from uuid import uuid4

# 保留学习阶段使用过的导入方式；新代码优先从对应模块导入。
from mini_deep_research.config import Settings, create_model, load_settings
from mini_deep_research.graph import (
    create_plan,
    extract_findings,
    filter_findings,
    format_findings,
    research_graph,
    researcher_graph,
    review_research,
    route_after_review,
    route_after_supervisor_review,
    run_researchers,
    search,
    select_new_topics,
    supervisor_plan,
    supervisor_review,
    validate_citations,
    write_report,
)
from mini_deep_research.log_utils import (
    error_info,
    log_node,
    logger,
    observed_node,
    setup_logging,
)
from mini_deep_research.models import (
    DelegationPlan,
    Finding,
    FindingSet,
    ResearchDecision,
    ResearcherOutput,
    ResearchPlan,
    ResearchState,
    SearchResult,
    SupervisorDecision,
    SupervisorState,
)
from mini_deep_research.search import search_web, select_new_queries


def demo_state() -> None:
    settings = load_settings()

    plan = ResearchPlan(
        research_goal = "了解 LangGraph",
        queries = [
            "LangGraph 是什么？",
            "LangGraph 的主要功能有哪些？",
            "LangGraph 的应用场景有哪些？",
        ]
    )

    source = SearchResult(
        title = "LangGraph 官方文档",
        url = "https://www.langgraph.com/docs",
        snippet = "LangGraph 是一个用于构建语言模型图的工具。",
        content = "LangGraph 是一个用于构建语言模型图的工具。它可以帮助开发者将语言模型的各个组件以图的形式组织起来，从而更好的实现ai功能",
    )

    # 把数据放进这次研究的共享状态。
    state:ResearchState = {
        "question" : "LangGraph 是什么？",
        "research_goal" : plan.research_goal,
        "queries" : plan.queries,
        "sources" : [source],
        "findings" : [],
        "search_round" : 1,
        "max_search_rounds" : settings.max_search_rounds,
        "final_report" : "",
        "error" : "",
    }

    print("研究目标：", state["research_goal"])
    print("第一条来源：", state["sources"][0].title)
    print("计划的 JSON：")
    print(plan.model_dump_json(indent=2))

async def demo_search() -> None:
    
    settings = load_settings()

    sources = await search_web(
        queries=[
            "LangGraph 是什么",
            "LangGraph 使用案例",
        ],
        max_results=settings.max_results_per_query,
    )

    print(f"去重后共获得 {len(sources)} 条来源")

    for index, source in enumerate(sources, start=1):
        print(f"\n第 {index} 条")
        print("标题：", source.title)
        print("链接：", source.url)
        print("内容：", source.content[:200])




async def demo_research() -> None:
    setup_logging()
    run_id = uuid4().hex[:12]
    settings = load_settings()

    max_search_rounds = settings.max_search_rounds
    max_supervisor_rounds = 2

    result = await research_graph.ainvoke(
        {
            "run_id": run_id,
            "question": "LangGraph 是什么，适合哪些应用场景？",
            "max_search_rounds": max_search_rounds,
            "max_supervisor_rounds": max_supervisor_rounds,
        },
        config={
            "recursion_limit": 2 * max_supervisor_rounds + 10,
        },
    )

    assert result["should_stop"] is True
    assert result["topics"] == []
    assert result["stop_reason"].strip()
    assert result["final_report"].strip()

    assert (
        1
        <= result["supervisor_round"]
        <= max_supervisor_rounds
    )

    assert (
        len(result["research_results"])
        == len(result["completed_topics"])
    )

    print("\n实际委派批次数：", result["supervisor_round"])

    for index, item in enumerate(
        result["research_results"],
        start=1,
    ):
        assert 1 <= item["search_round"] <= max_search_rounds
        assert item["stop_reason"].strip()

        print(f"\n子任务 {index}：{item['topic']}")
        print("搜索轮数：", item["search_round"])
        print("执行查询：", item["searched_queries"])
        print("发现数量：", len(item["findings"]))
        print("子任务证据被判断为足够：", item["done"])
        print("停止原因：", item["stop_reason"])

    print("\n总体证据被判断为足够：", result["done"])
    print("总体停止原因：", result["stop_reason"])
    print("剩余必要缺口：", result["gaps"])
    print("去重后来源数量：", len(result["sources"]))
    print("引用检查结果：", result["citation_warnings"])

    print("\n" + result["final_report"])

def main() -> None:
    settings=load_settings()

    print("Mini Deep Research is ready.")
    print(f"Model: {settings.model_name}")
    print(f"Max search rounds: {settings.max_search_rounds}")
    print(
        "Max results per query: "
        f"{settings.max_results_per_query}"
    )

if __name__ == "__main__":
    main()
