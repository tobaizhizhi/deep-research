"""运行真实父子图，仅替换外部模型与搜索，验证服务参数和原始证据。"""

import asyncio
from datetime import datetime, timezone
from hashlib import sha256
from types import SimpleNamespace
from uuid import uuid4

import pytest

from mini_deep_research import config, graph, search, service
from mini_deep_research.log_utils import service_identity
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


def task_input(**overrides):
    return {
        "schema_version": 1,
        "graph_mode": "fixed",
        "model_name": "deepseek-chat",
        "model_profile": "deepseek-default-v1",
        "code_version": "test",
        "prompt_version": "v1",
        "max_search_rounds": 1,
        "max_supervisor_rounds": 1,
        "max_concurrent_researchers": 2,
        "max_results_per_query": 3,
        "total_timeout_seconds": 30,
        "enable_research_compression": False,
        **overrides,
    }


def install_external_stubs(monkeypatch, *, insufficient=False):
    """测试专用，正常任务流程没有 fake 开关。"""
    source = SearchResult(
        title="Official",
        url="https://example.test/source",
        content="StateGraph keeps shared state.",
        fetched_at=datetime.now(timezone.utc),
        content_source="raw_content",
    )
    finding = Finding(
        claim=source.content, evidence=source.content, source_urls=[source.url]
    )
    calls = []
    model_calls = []
    messages_seen = []
    counts = {"queries": 0, "topics": 0}

    def model_factory(**kwargs):
        model_calls.append(kwargs)

        class Model:
            def with_structured_output(self, schema, **_):
                async def invoke(messages):
                    messages_seen.append((schema.__name__, messages))
                    if schema is DelegationPlan:
                        return DelegationPlan(topics=["definition", "applications"])
                    if schema is ResearchPlan:
                        return ResearchPlan(
                            research_goal="task scope", queries=["official docs"]
                        )
                    if schema is FindingSet:
                        return FindingSet(findings=[finding], gaps=[])
                    if schema is ResearchDecision:
                        counts["queries"] += 1
                        return ResearchDecision(
                            done=not insufficient,
                            reason="reviewed",
                            follow_up_queries=[f"extra {counts['queries']}"]
                            if insufficient
                            else [],
                        )
                    if schema is CompressedResearch:
                        # 可能有多轮发现；编号必须覆盖所有发现。
                        prompt = messages[-1][1]
                        ids = list(range(1, prompt.count("声明：") + 1))
                        return CompressedResearch(
                            key_findings=[BriefPoint(text="brief", finding_ids=ids)],
                            limitations=[],
                            conflicts=[],
                        )
                    if schema is SupervisorDecision:
                        counts["topics"] += 1
                        return SupervisorDecision(
                            done=not insufficient,
                            reason="overall reviewed",
                            gaps=["necessary gap"] if insufficient else [],
                            follow_up_topics=[f"follow-up {counts['topics']}"]
                            if insufficient
                            else [],
                        )
                    raise AssertionError(schema)

                return SimpleNamespace(ainvoke=invoke)

            async def ainvoke(self, messages):
                messages_seen.append(("writer", messages))
                return SimpleNamespace(
                    content=f"{source.content} [Official]({source.url})\n\n## Sources\n- [Official]({source.url})"
                )

        return Model()

    async def search_stub(queries, *, max_results):
        calls.append(max_results)
        await asyncio.sleep(0)
        # 每轮新 URL，允许真正走补查循环。
        return [source.model_copy(update={"url": source.url})]

    monkeypatch.setattr(graph, "create_model", model_factory)
    monkeypatch.setattr(graph, "search_web", search_stub)
    monkeypatch.setattr(
        service, "resolve_model_settings", lambda *_: ("test", "https://example.test")
    )
    return source, calls, model_calls, messages_seen


@pytest.mark.parametrize("compression", [False, True])
@pytest.mark.parametrize("depth,rounds,results", [("quick", 1, 3), ("standard", 2, 5)])
def test_task_snapshot_reaches_parent_child_and_writer(
    monkeypatch, compression, depth, rounds, results
):
    source, calls, model_calls, messages = install_external_stubs(
        monkeypatch, insufficient=True
    )
    task = service.ResearchTask(
        task_id=str(uuid4()),
        attempt_id=str(uuid4()),
        input={
            "question": "What is StateGraph?",
            "requirements": "Prefer official sources",
            "language": "en",
            "depth": depth,
        },
        config=task_input(
            max_search_rounds=rounds,
            max_supervisor_rounds=rounds,
            max_results_per_query=results,
            enable_research_compression=compression,
        ),
    )
    archive = asyncio.run(service.run_research_task(task))
    assert service_identity.get() is None
    assert calls and set(calls) == {results}
    assert all(
        call == {"model_name": "deepseek-chat", "model_profile": "deepseek-default-v1"}
        for call in model_calls
    )
    assert len(archive.research_results) == (2 if rounds == 1 else 3)
    assert len({r.researcher_id for r in archive.research_results}) == len(
        archive.research_results
    )
    assert all(r.researcher_id.startswith(f"{task.attempt_id}:b") for r in archive.research_results)
    assert all(r.search_round == rounds for r in archive.research_results)
    assert all(r.compression_used == compression for r in archive.research_results)
    assert archive.research_done is False
    assert archive.sources[0].content == source.content
    assert archive.citation_warnings == []
    writer = next(msg for schema, msg in messages if schema == "writer")[-1][1]
    assert "What is StateGraph?" in writer and "Prefer official sources" in writer
    assert "Write the final report in English" in writer
    assert source.content in writer
    assert "brief" not in writer
    assert "api_key" not in archive.model_dump_json()


def test_unknown_profile_is_not_silently_replaced(monkeypatch):
    monkeypatch.setattr(
        config,
        "load_settings",
        lambda: SimpleNamespace(openai_api_key="secret", base_url=None),
    )
    with pytest.raises(config.ConfigUnavailable):
        config.resolve_model_settings("deepseek-chat", "retired-profile")
    assert config.resolve_model_settings("deepseek-chat", "deepseek-default-v1") == (
        "secret",
        "https://api.deepseek.com",
    )


def test_source_metadata_matches_saved_content(monkeypatch):
    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def search(self, **kwargs):
            return {
                "results": [
                    {
                        "url": "https://example.test",
                        "content": "摘要",
                        "raw_content": None,
                    }
                ]
            }

    monkeypatch.setattr(search, "AsyncTavilyClient", Client)
    monkeypatch.setattr(
        search, "load_settings", lambda: SimpleNamespace(tavily_api_key="test")
    )
    result = asyncio.run(search.search_web(["test"]))[0]
    assert result.content_hash == sha256("摘要".encode("utf-8")).hexdigest()
    assert result.fetched_at.tzinfo is not None
    assert result.content_source == "snippet"
    assert result.content_truncated is None
    assert SearchResult(title="legacy", url="https://example.test").fetched_at is None
