from deep_research import main
from mini_deep_research.config import load_settings
from mini_deep_research import config
import pytest
from pydantic import ValidationError

from mini_deep_research.models import ResearchPlan, SearchResult

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from mini_deep_research import graph as research


def test_load_settings(monkeypatch):
    monkeypatch.setattr(config, "load_dotenv", lambda *args, **kwargs: None)
    monkeypatch.setenv("MODEL_NAME", "test-model")
    monkeypatch.setenv("MAX_SEARCH_ROUNDS", "3")
    monkeypatch.setenv("MAX_RESULTS_PER_QUERY", "4")

    settings = load_settings()

    assert settings.model_name == "test-model"
    assert settings.max_search_rounds == 3
    assert settings.max_results_per_query == 4


def test_program_can_start_without_api_call(
    monkeypatch,
    capsys,
):
    monkeypatch.setattr(config, "load_dotenv", lambda *args, **kwargs: None)
    monkeypatch.setenv("MODEL_NAME", "test-model")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)

    main()

    output = capsys.readouterr().out

    assert "Mini Deep Research is ready." in output
    assert "test-model" in output


def test_search_result_json_round_trip():
    """搜索结果转成 JSON 后，应该能还原回来。"""
    source = SearchResult(
        title="示例资料",
        url="https://example.com",
        content="用于测试的正文",
    )

    json_text = source.model_dump_json()
    restored = SearchResult.model_validate_json(json_text)

    assert restored == source


@pytest.mark.parametrize("query_count", [0, 6])
def test_plan_rejects_invalid_query_count(query_count):
    """没有查询或超过五条查询时，应该拒绝该计划。"""
    with pytest.raises(ValidationError):
        ResearchPlan(
            research_goal="了解 LangGraph",
            queries=["示例查询"] * query_count,
        )


@pytest.mark.parametrize("reason", ["", " \n\t ", " 已覆盖定义和应用场景。 "])
def test_completed_research_always_records_stop_reason(monkeypatch, reason):
    """Researcher 子图记录非空停止原因，并且不调用 Writer。"""
    source = SearchResult(
        title="测试资料",
        url="https://example.com/langgraph",
        content="LangGraph 用于编排有状态的工作流。",
    )
    responses = {
        research.ResearchPlan: research.ResearchPlan(
            research_goal="了解 LangGraph",
            queries=["LangGraph 官方文档"],
        ),
        research.FindingSet: research.FindingSet(
            findings=[research.Finding(
                claim="LangGraph 用于编排有状态的工作流。",
                evidence=source.content,
                source_urls=[source.url],
            )],
            gaps=[],
        ),
        research.ResearchDecision: research.ResearchDecision(
            done=True,
            reason=reason,
            follow_up_queries=[],
        ),
    }
    model = Mock()
    model.with_structured_output.side_effect = lambda schema, **kwargs: SimpleNamespace(
        ainvoke=AsyncMock(return_value=responses[schema]),
    )
    model.ainvoke = AsyncMock(return_value=SimpleNamespace(content="# 测试报告"))
    search = AsyncMock(return_value=[source])
    monkeypatch.setattr(research, "create_model", lambda: model)
    monkeypatch.setattr(research, "search_web", search)
    monkeypatch.setattr(research, "load_settings", lambda: SimpleNamespace(
        max_search_rounds=2,
        max_results_per_query=5,
    ))

    result = asyncio.run(research.researcher_graph.ainvoke({
        "question": "LangGraph 是什么？",
        "max_search_rounds": 2,
    }))
    assert result["stop_reason"].strip()
    # 验证子图返回的停止条件，并拒绝只含空白的停止原因。
    if reason.strip():
        assert result["stop_reason"] == reason.strip()
    else:
        assert "模型未提供具体理由" in result["stop_reason"]
    assert result["done"] is True
    assert result["should_stop"] is True
    assert result["queries"] == []
    assert result["search_round"] == 1
    search.assert_awaited_once()
   # Researcher 子图不调用 Writer。
    model.ainvoke.assert_not_awaited()

def test_filter_findings_removes_invalid_sources():
    url = "https://example.com/a"
    source = research.SearchResult(title="资料 A", url=url)

    findings = [
        research.Finding(
            claim="有效发现",
            evidence="证据摘录",
            source_urls=[url, url, "https://unknown.example"],
        ),
        research.Finding(
            claim="缺少有效来源",
            evidence="证据摘录",
            source_urls=["https://unknown.example"],
        ),
        research.Finding(
            claim="只有空白证据",
            evidence="   ",
            source_urls=[url],
        ),
    ]

    accepted = research.filter_findings(findings, [source])

    assert len(accepted) == 1
    assert isinstance(accepted[0], research.Finding)
    assert accepted[0].claim == "有效发现"
    assert accepted[0].source_urls == [url]

def test_validate_citations_detects_report_problems():
    url = "https://example.com/a"

    state = {
        "sources": [
            research.SearchResult(title="资料 A", url=url),
        ],
        "findings": [
            research.Finding(
                claim="测试发现",
                evidence="测试摘录",
                source_urls=[url],
            ),
        ],
    }

    # 正文和 Sources 使用同一个有效链接，应无警告。
    state["final_report"] = (
        f"测试发现。[资料 A]({url})\n\n"
        f"## Sources\n- [资料 A]({url})"
    )
    assert research.validate_citations(state)["citation_warnings"] == []

    # 正文引用了资料，但 Sources 没有列出来。
    state["final_report"] = (
        f"测试发现。[资料 A]({url})\n\n"
        "## Sources\n"
    )
    warnings = research.validate_citations(state)["citation_warnings"]
    assert any("Sources 遗漏正文引用" in item for item in warnings)

    # 引用了不属于输入资料的链接。
    state["final_report"] = (
        "测试发现。[未知资料](https://unknown.example)\n\n"
        "## Sources\n- [未知资料](https://unknown.example)"
    )
    warnings = research.validate_citations(state)["citation_warnings"]
    assert any("未关联到已收集证据" in item for item in warnings)

    # 报告完全没有引用。
    state["final_report"] = "只有结论，没有引用。"
    warnings = research.validate_citations(state)["citation_warnings"]
    assert "报告正文没有引用链接。" in warnings
    assert "报告缺少 ## Sources 章节。" in warnings
