"""阶段 B：只替换外部模型，验证材料选择、回退和证据保留。"""

import asyncio
import copy
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from langchain_core.exceptions import OutputParserException
from openai import APIConnectionError

import deep_research
from mini_deep_research import config, graph
from mini_deep_research.models import Finding, SearchResult, SupervisorDecision


@pytest.fixture
def research_state():
    return {
        "topic": "可靠性",
        "research_goal": "调查服务的运行条件和限制",
        "enable_research_compression": True,
        "findings": [
            Finding(
                claim="A 支持恢复",
                evidence="A：需要存储",
                source_urls=["https://example.com/a"],
            ),
            Finding(
                claim="B 不支持恢复",
                evidence="B：此版本不支持",
                source_urls=["https://example.com/b"],
            ),
        ],
        "sources": [
            SearchResult(title="A", url="https://example.com/a", content="网页原文")
        ],
        "done": False,
        "gaps": ["尚未核实版本差异"],
        "stop_reason": "搜索轮数已达上限。",
    }


@pytest.fixture
def brief():
    return {
        "key_findings": [{"text": "A 支持恢复，B 的说法不同。", "finding_ids": [1, 2]}],
        "limitations": [{"text": "A 要求配置存储。", "finding_ids": [1]}],
        "conflicts": [
            {
                "text": "两份资料对恢复能力的描述不同，版本差异待核实。",
                "finding_ids": [1, 2],
            }
        ],
    }


def mock_compressor(monkeypatch, result=None, error=None):
    invoke = AsyncMock(return_value=result, side_effect=error)
    model = Mock()
    model.with_structured_output.return_value = SimpleNamespace(ainvoke=invoke)
    create = Mock(return_value=model)
    monkeypatch.setattr(graph, "create_model", create)
    return invoke, create


@pytest.mark.parametrize("enabled,empty", [(False, False), (True, True)])
def test_skips_without_calling_model(monkeypatch, research_state, enabled, empty):
    research_state["enable_research_compression"] = enabled
    if empty:
        research_state["findings"] = []
    invoke, create = mock_compressor(monkeypatch)
    result = asyncio.run(graph.compress_research(research_state))
    assert result["compression_used"] is False
    assert result["compression_warning"] == ""
    create.assert_not_called()
    invoke.assert_not_awaited()


def test_brief_preserves_raw_evidence_and_can_be_longer(
    monkeypatch, research_state, brief
):
    before = copy.deepcopy(research_state)
    invoke, _ = mock_compressor(monkeypatch, brief)
    result = asyncio.run(graph.compress_research(research_state))
    assert result["compression_used"] is True
    assert result["summary_finding_ids"] == [1, 2]
    assert research_state == before
    assert not {"findings", "sources", "gaps", "done", "stop_reason"} & result.keys()
    material = result["compressed_research"]
    assert len(material) > len(graph.format_findings(research_state["findings"]))
    for expected in (
        "条件与限制",
        "来源冲突",
        "版本差异待核实",
        "https://example.com/b",
    ):
        assert expected in material
    prompt = invoke.await_args.args[0][-1][1]
    assert "资料是否被判断充分：False" in prompt
    assert research_state["stop_reason"] in prompt


@pytest.mark.parametrize(
    "bad",
    ["blank", "string_id", "bool_id", "out_of_range", "missing", "missing_section"],
)
def test_invalid_brief_falls_back_with_visible_reason(
    monkeypatch, caplog, research_state, brief, bad
):
    if bad == "blank":
        brief["key_findings"][0]["text"] = " \n "
    elif bad == "missing_section":
        del brief["conflicts"]
    else:
        ids = {
            "string_id": ["1", 2],
            "bool_id": [True, 2],
            "out_of_range": [1, 9],
            "missing": [1],
        }[bad]
        brief["key_findings"][0]["finding_ids"] = ids
        brief["limitations"] = []
        brief["conflicts"] = []
    mock_compressor(monkeypatch, brief)
    caplog.set_level(logging.WARNING, logger="mini_deep_research")
    result = asyncio.run(graph.compress_research(research_state))
    assert result["compression_used"] is False
    assert result["compressed_research"] == ""
    assert result["summary_finding_ids"] == []
    assert result["compression_warning"]
    assert "event=fallback" in caplog.text


@pytest.mark.parametrize(
    "error",
    [
        OutputParserException("bad output"),
        APIConnectionError(request=httpx.Request("POST", "https://example.com")),
        TimeoutError(),
    ],
)
def test_expected_model_errors_allow_fallback(monkeypatch, research_state, error):
    mock_compressor(monkeypatch, error=error)
    result = asyncio.run(graph.compress_research(research_state))
    assert result["compression_used"] is False
    assert type(error).__name__ in result["compression_warning"]


@pytest.mark.parametrize(
    "error", [asyncio.CancelledError(), KeyError("programming error")]
)
def test_cancel_and_programming_errors_propagate(monkeypatch, research_state, error):
    mock_compressor(monkeypatch, error=error)
    with pytest.raises(type(error)):
        asyncio.run(graph.compress_research(research_state))


def test_input_budget_skips_before_model_creation(monkeypatch, research_state):
    monkeypatch.setattr(graph, "MAX_COMPRESSION_INPUT_CHARS", 1)
    _, create = mock_compressor(monkeypatch)
    result = asyncio.run(graph.compress_research(research_state))
    assert "预算" in result["compression_warning"]
    create.assert_not_called()


def test_compression_timeout_cancels_request(monkeypatch, research_state):
    cancelled = []

    async def slow_request(*args):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(True)

    mock_compressor(monkeypatch, error=slow_request)
    monkeypatch.setattr(graph, "COMPRESSION_TIMEOUT", 0.01)
    result = asyncio.run(graph.compress_research(research_state))
    assert "TimeoutError" in result["compression_warning"]
    assert cancelled == [True]


def test_supervisor_uses_mixed_material_and_preserves_history(
    monkeypatch, research_state, brief
):
    mock_compressor(monkeypatch, brief)
    result = asyncio.run(graph.compress_research(research_state))
    first = {**research_state, **result}
    second = {
        **research_state,
        "topic": "失败后回退",
        "compression_used": False,
        "compression_warning": "请求失败",
    }
    state = {
        "question": "服务有何限制？",
        "completed_topics": ["可靠性", "失败后回退"],
        "research_results": [first, second],
        "findings": research_state["findings"],
        "gaps": research_state["gaps"],
        "supervisor_round": 2,
        "max_supervisor_rounds": 2,
        "enable_research_compression": True,
        "compression_metrics": [{"supervisor_round": 1}],
    }
    invoke, _ = mock_compressor(
        monkeypatch,
        SupervisorDecision(
            done=False, reason="缺版本", gaps=["版本"], follow_up_topics=[]
        ),
    )
    update = asyncio.run(graph.supervisor_review(state))
    sent = invoke.await_args.args[0][-1][1]
    assert result["compressed_research"] in sent
    assert "证据：A：需要存储" in sent  # 回退任务的完整发现仍在。
    assert "资料是否被判断充分：False" in sent
    assert "尚未核实版本差异" in sent
    assert update["done"] is False
    assert update["should_stop"] is True
    metrics = update["compression_metrics"]
    assert metrics[-1]["brief_count"] == metrics[-1]["fallback_count"] == 1
    assert metrics[-1]["sent_chars"] > metrics[-1]["full_chars"]
    assert metrics[0] == {"supervisor_round": 1}
    assert len(state["compression_metrics"]) == 1

    # 回退也不能将任意长的材料发给下游模型。
    monkeypatch.setattr(graph, "MAX_SUPERVISOR_INPUT_CHARS", 1)
    _, create = mock_compressor(monkeypatch)
    with pytest.raises(RuntimeError, match="Supervisor 评审输入超过"):
        asyncio.run(graph.supervisor_review(state))
    create.assert_not_called()


@pytest.mark.parametrize(
    "value,expected", [("true", True), (" FALSE ", False), (None, False), ("yes", None)]
)
def test_compression_config_is_explicit(monkeypatch, value, expected):
    monkeypatch.setattr(config, "load_dotenv", Mock())
    if value is None:
        monkeypatch.delenv("ENABLE_RESEARCH_COMPRESSION", raising=False)
    else:
        monkeypatch.setenv("ENABLE_RESEARCH_COMPRESSION", value)
    if value == "yes":
        with pytest.raises(ValueError, match="ENABLE_RESEARCH_COMPRESSION"):
            config.load_settings()
    else:
        assert config.load_settings().enable_research_compression is expected


def test_demo_forwards_compression_setting(monkeypatch, capsys):
    monkeypatch.setattr(deep_research, "setup_logging", Mock())
    monkeypatch.setattr(
        deep_research,
        "load_settings",
        lambda: SimpleNamespace(
            max_search_rounds=1,
            max_concurrent_researchers=2,
            enable_research_compression=True,
        ),
    )
    fake_graph = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value={
                "should_stop": True,
                "topics": [],
                "stop_reason": "无证据",
                "final_report": "无法回答",
                "supervisor_round": 1,
                "research_results": [],
                "completed_topics": [],
                "done": False,
                "gaps": ["无证据"],
                "sources": [],
                "citation_warnings": [],
                "compression_metrics": [],
            }
        )
    )
    monkeypatch.setattr(deep_research, "research_graph", fake_graph)
    asyncio.run(deep_research.demo_research())
    assert fake_graph.ainvoke.await_args.args[0]["enable_research_compression"] is True
    assert "Supervisor 材料统计" in capsys.readouterr().out


@pytest.mark.parametrize("max_rounds", [1, 3])
def test_real_subgraph_only_compresses_after_budget_stop(monkeypatch, max_rounds):
    """每轮都有新网页且仍缺证据，直到业务上限才整理一次累计发现。"""
    searches = []
    compression_calls = []

    async def search(*args, **kwargs):
        index = len(searches) + 1
        source = SearchResult(
            title=f"来源 {index}",
            url=f"https://example.com/{index}",
            content=f"原文 {index}",
        )
        searches.append(source)
        return [source]

    def structured(schema, **kwargs):
        async def invoke(messages):
            if schema is graph.ResearchPlan:
                return graph.ResearchPlan(research_goal="可靠性", queries=["查询 1"])
            if schema is graph.FindingSet:
                source = searches[-1]
                return graph.FindingSet(
                    findings=[
                        Finding(
                            claim=source.title,
                            evidence=source.content,
                            source_urls=[source.url],
                        )
                    ],
                    gaps=["必要版本仍未核实"],
                )
            if schema is graph.ResearchDecision:
                return graph.ResearchDecision(
                    done=False,
                    reason="仍缺版本",
                    follow_up_queries=[f"查询 {len(searches) + 1}"],
                )
            assert schema is graph.CompressedResearch
            compression_calls.append(True)
            assert "资料是否被判断充分：False" in messages[-1][1]
            assert "子任务搜索轮数已达上限" in messages[-1][1]
            return {
                "key_findings": [
                    {"text": source.title, "finding_ids": [index]}
                    for index, source in enumerate(searches, start=1)
                ],
                "limitations": [],
                "conflicts": [],
            }

        return SimpleNamespace(ainvoke=invoke)

    model = Mock()
    model.with_structured_output.side_effect = structured
    monkeypatch.setattr(graph, "create_model", lambda: model)
    monkeypatch.setattr(graph, "search_web", search)
    monkeypatch.setattr(
        graph, "load_settings", lambda: SimpleNamespace(max_results_per_query=5)
    )
    result = asyncio.run(
        graph.researcher_graph.ainvoke(
            {
                "question": "调查可靠性",
                "max_search_rounds": max_rounds,
                "enable_research_compression": True,
            },
            config={"recursion_limit": 3 * max_rounds + 10},
        )
    )
    assert result["search_round"] == max_rounds
    assert len(result["findings"]) == len(result["sources"]) == max_rounds
    assert result["compression_used"] is True
    assert compression_calls == [True]
    assert result["summary_finding_ids"] == list(range(1, max_rounds + 1))
    assert result["done"] is False
    assert result["should_stop"] is True
    assert result["gaps"] == ["必要版本仍未核实"]
    assert "子任务搜索轮数已达上限" in result["stop_reason"]
