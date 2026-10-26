"""跨模块回归测试：运行真实图，只替换外部模型和搜索调用。"""

import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.messages import convert_to_messages

import evaluate
from mini_deep_research import config, graph, log_utils
from mini_deep_research.models import (
    BriefPoint,
    CompressedResearch,
    DelegationPlan,
    Finding,
    FindingSet,
    ResearchDecision,
    ResearchPlan,
    SearchResult,
    SupervisorDecision,
)


@pytest.mark.parametrize(
    "mode,with_judge",
    [
        ("ok", False),
        ("ok", True),
        ("budget", False),
        ("search_error", False),
        ("research_timeout", False),
        ("judge_error", True),
        ("judge_timeout", True),
    ],
)
@pytest.mark.parametrize("compression_enabled", [False, True])
def test_evaluation_across_modules(
    monkeypatch, caplog, mode, with_judge, compression_enabled
):
    case = evaluate.EvalCase(
        id="q1",
        question="StateGraph 的作用？",
        reference="说明共享状态、节点与边。",
        keyword_groups=[["StateGraph"], ["状态"], ["节点"], ["边"]],
    )
    source = SearchResult(
        title="资料",
        url="https://example.com/a",
        content="StateGraph 通过状态、节点和边组织工作流。",
        fetched_at=datetime.now(timezone.utc),
    )
    finding = Finding(
        claim=source.content, evidence=source.content, source_urls=[source.url]
    )
    settings = SimpleNamespace(
        model_name="test",
        max_search_rounds=1,
        max_results_per_query=5,
        max_concurrent_researchers=2,
        enable_research_compression=compression_enabled,
    )
    responses = {
        DelegationPlan: DelegationPlan(topics=["状态管理", "节点和边"]),
        ResearchPlan: ResearchPlan(research_goal="当前子任务", queries=["查询"]),
        FindingSet: FindingSet(findings=[finding], gaps=[]),
        ResearchDecision: ResearchDecision(done=True, reason="充分"),
        CompressedResearch: CompressedResearch(
            key_findings=[
                BriefPoint(text="整理后的简报：工作流共享状态。", finding_ids=[1])
            ],
            limitations=[],
            conflicts=[],
        ),
        SupervisorDecision: SupervisorDecision(
            done=mode != "budget",
            reason="评审理由",
            gaps=["必要缺口"] if mode == "budget" else [],
        ),
        evaluate.JudgeResult: evaluate.JudgeResult(
            relevance=4, completeness=4, grounding=4, reasoning="材料支持"
        ),
    }
    judge_calls = []
    brief_calls = []
    model = Mock()

    def structured(schema, **kwargs):
        async def invoke(messages):
            convert_to_messages(messages)
            if schema is evaluate.JudgeResult:
                judge_calls.append(True)
                assert source.content in messages[-1][1]
                if mode == "judge_error":
                    raise ValueError("模拟裁判失败")
                if mode == "judge_timeout":
                    await asyncio.Event().wait()
            else:
                assert case.reference not in "\n".join(m[1] for m in messages)
            if schema is CompressedResearch:
                assert compression_enabled
                brief_calls.append(True)
                assert source.content in messages[-1][1]
            if schema is SupervisorDecision:
                assert ("整理后的简报" in messages[-1][1]) is compression_enabled
                assert (source.content in messages[-1][1]) is not compression_enabled
            return responses[schema]

        return SimpleNamespace(ainvoke=invoke)

    async def writer(messages):
        # 普通 Mock 不会发现三元素消息元组，调用真实解析器校验格式。
        convert_to_messages(messages)
        assert "研究停止原因" in messages[-1][1]
        assert source.content in messages[-1][1]
        assert "整理后的简报" not in messages[-1][1]
        return SimpleNamespace(
            content=(
                f"{source.content}[资料]({source.url})\n\n"
                f"## Sources\n- [资料]({source.url})"
            )
        )

    async def search(*args, **kwargs):
        if mode == "search_error":
            try:
                raise ConnectionError("模拟连接失败")
            except ConnectionError as cause:
                raise RuntimeError("搜索失败") from cause
        if mode == "research_timeout":
            await asyncio.Event().wait()
        return [source]

    model.with_structured_output.side_effect = structured
    model.ainvoke = AsyncMock(side_effect=writer)
    monkeypatch.setattr(graph, "create_model", lambda: model)
    monkeypatch.setattr(evaluate, "create_model", lambda: model)
    monkeypatch.setattr(graph, "load_settings", lambda: settings)
    monkeypatch.setattr(evaluate, "load_settings", lambda: settings)
    monkeypatch.setattr(graph, "search_web", search)
    monkeypatch.setattr(evaluate, "JUDGE_TIMEOUT", 0.05)
    if mode == "research_timeout":
        monkeypatch.setattr(evaluate, "RESEARCH_TIMEOUT", 0.1)

    caplog.set_level(logging.INFO, logger="mini_deep_research")
    row = asyncio.run(evaluate.evaluate_one(case, with_judge=with_judge))
    run_id = row["config"]["run_id"]
    assert row["config"]["enable_research_compression"] is compression_enabled
    assert f"run={run_id} node=search" in caplog.text
    assert "topic='状态管理'" in caplog.text
    assert f"run={run_id} stage=research status=" in caplog.text
    json.dumps(row)  # 结果不应包含无法写入 JSONL 的模型对象或异常对象。

    if mode == "search_error":
        assert row["status"] == "error"
        assert [item["type"] for item in row["error"]["chain"]] == [
            "RuntimeError",
            "ConnectionError",
        ]
        model.ainvoke.assert_not_awaited()
    elif mode == "research_timeout":
        assert row["status"] == "timeout"
        assert "event=cancelled" in caplog.text
        assert row["error"]["type"] == "TimeoutError"
        model.ainvoke.assert_not_awaited()
    else:
        assert row["status"] == "ok"
        assert row["basic_pass"] is True
        assert row["research_done"] is (mode != "budget")
        assert row["researcher_count"] == 2
        assert len(row["findings"]) == len(row["sources"]) == 1
        assert brief_calls == ([True, True] if compression_enabled else [])
        assert row["compression_metrics"][0]["used"] is compression_enabled
        assert len(row["research_results"]) == 2
        for result in row["research_results"]:
            assert result["compression_used"] is compression_enabled
            assert result["findings"][0] == finding.model_dump()
            assert result["sources"][0] == source.model_dump(mode="json")
            if compression_enabled:
                assert result["summary_finding_ids"] == [1]
                assert "整理后的简报" in result["compressed_research"]
        # 新增的获取时间必须可直接写入 JSONL，不能残留 datetime 对象。
        json.dumps(row, ensure_ascii=False)
        assert "topic='节点和边'" in caplog.text
        assert "node=validate_citations event=end" in caplog.text
        model.ainvoke.assert_awaited_once()
        if with_judge:
            assert judge_calls == [True]
            assert row["judge_seconds"] >= 0
            if mode == "judge_error":
                assert row["judge_error"]["type"] == "ValueError"
            elif mode == "judge_timeout":
                assert row["judge_error"]["type"] == "TimeoutError"
            else:
                assert row["judge"]["relevance"] == 4

    if not with_judge:
        assert judge_calls == []
        assert row["judge"] is None
        assert "judge_seconds" not in row


def test_configuration_finds_env_outside_working_directory(monkeypatch, tmp_path):
    (tmp_path / ".env").write_text("MODEL_NAME=path-test\n", encoding="utf-8")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.setattr(config, "PROJECT_DIR", tmp_path)
    monkeypatch.delenv("MODEL_NAME", raising=False)
    monkeypatch.chdir(elsewhere)

    assert config.load_settings().model_name == "path-test"


def test_logging_writes_to_output_directory_once(monkeypatch, tmp_path):
    output = tmp_path / "outputs"
    test_logger = logging.Logger("isolated-test")
    monkeypatch.setattr(log_utils, "logger", test_logger)
    monkeypatch.setattr(log_utils, "OUTPUT_DIR", output)

    try:
        log_utils.setup_logging()
        log_utils.setup_logging()
        test_logger.info("中文日志")
        assert len(test_logger.handlers) == 2
        assert "中文日志" in (output / "research.log").read_text(encoding="utf-8")
    finally:
        for handler in test_logger.handlers:
            handler.close()


def test_evaluation_saves_results_to_outputs(monkeypatch, tmp_path):
    output = tmp_path / "outputs"
    row = {
        "status": "error",
        "basic_pass": None,
        "judge": None,
        "error": {"type": "TestError"},
        "judge_error": None,
    }
    monkeypatch.setattr(evaluate, "OUTPUT_DIR", output)
    monkeypatch.setattr(evaluate, "setup_logging", Mock())
    monkeypatch.setattr(evaluate, "evaluate_one", AsyncMock(return_value=row))
    monkeypatch.setattr(sys, "argv", ["evaluate.py", "--limit", "1"])
    monkeypatch.chdir(tmp_path)

    asyncio.run(evaluate.main())

    files = list(output.glob("eval_results_*.jsonl"))
    assert len(files) == 1
    assert json.loads(files[0].read_text(encoding="utf-8")) == row
    evaluate.setup_logging.assert_called_once()


def test_archived_report_evaluation_does_not_start_research():
    case = evaluate.EvalCase(
        id="archived-1",
        question="StateGraph 的作用？",
        reference="共享状态、节点与边。",
        keyword_groups=[["StateGraph"], ["状态"], ["节点"], ["边"]],
    )
    url = "https://example.com/source"
    result = evaluate.evaluate_archived_report(
        case,
        {
            "markdown": (
                "StateGraph 通过状态、节点和边组织工作流，见[资料](https://example.com/source)。\n\n"
                "## Sources\n- [资料](https://example.com/source)"
            ),
            "findings": [
                {
                    "claim": "StateGraph 通过状态、节点和边组织工作流。",
                    "evidence": "资料原文",
                    "source_urls": [url],
                }
            ],
            "sources": [{"title": "资料", "url": url, "content": "资料原文"}],
        },
        report_id="report-1",
        evaluation_version="questions-v1",
        code_version="code-1",
        prompt_version="prompt-1",
        model_version="model-1",
        budget={"total_timeout_seconds": 600},
    )
    assert result["report_id"] == "report-1"
    assert result["evaluation_version"] == "questions-v1"
    assert result["usage"] == {"status": "unavailable"}
    assert result["cost"] == {"status": "unavailable"}
    assert result["basic_pass"] is True
