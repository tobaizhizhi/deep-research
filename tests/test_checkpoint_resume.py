"""P7 父子图恢复：真实 LangGraph 检查点，替换模型/搜索外部调用。"""

import asyncio
from uuid import uuid4

import pytest
from langgraph.checkpoint.memory import MemorySaver

from mini_deep_research import graph, service
from test_service import install_external_stubs, task_input


@pytest.mark.parametrize("interruption", ["extract", "writer"])
def test_resume_reuses_completed_subtasks_and_does_not_repeat_search(
    monkeypatch, interruption
):
    _, search_calls, _, model_messages = install_external_stubs(monkeypatch)
    saver = MemorySaver()
    graph_run_id = str(uuid4())
    task_id = str(uuid4())
    saved: dict[str, dict] = {}
    failed = False
    original_extract = graph.extract_findings
    original_writer = graph.write_report

    async def interrupt_extract(state):
        nonlocal failed
        if interruption == "extract" and state["topic"] == "applications" and not failed:
            # 另一研究员先完成并提交不可变结果；本研究员搜索后的 checkpoint 留存。
            await asyncio.sleep(0.1)
            failed = True
            raise RuntimeError("injected crash after search")
        return await original_extract(state)

    async def interrupt_writer(state):
        nonlocal failed
        result = await original_writer(state)
        if interruption == "writer" and not failed:
            failed = True
            raise RuntimeError("injected crash during writing")
        return result

    monkeypatch.setattr(graph, "extract_findings", interrupt_extract)
    monkeypatch.setattr(graph, "write_report", interrupt_writer)

    async def registry(run_id, attempt_id, batch, topics):
        assert run_id == graph_run_id
        records = []
        for index, topic in enumerate(topics, 1):
            researcher_id = f"{run_id}:r{(batch - 1) * 3 + index}"
            thread_id = f"research:{run_id}:subtask:{(batch - 1) * 3 + index}"
            snapshot = await saver.aget({"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}})
            records.append(
                {
                    "topic": topic,
                    "researcher_id": researcher_id,
                    "thread_id": thread_id,
                    "checkpoint_ns": "",
                    "status": "succeeded" if researcher_id in saved else "pending",
                    "result": saved.get(researcher_id),
                    "has_checkpoint": snapshot is not None,
                }
            )
        return records

    async def save_result(researcher_id, result):
        saved[researcher_id] = service.ResearcherArchive.model_validate(result).model_dump(mode="json")

    def task(attempt_id, *, resume=False):
        return service.ResearchTask(
            task_id=task_id,
            attempt_id=attempt_id,
            graph_run_id=graph_run_id,
            graph_thread_id=f"research:{task_id}",
            resume=resume,
            input={"question": "What does StateGraph do?", "language": "en"},
            config=task_input(),
        )

    async def scenario():
        with pytest.raises(RuntimeError, match="injected crash"):
            await service.run_research_task(
                task(str(uuid4())),
                checkpointer=saver,
                subtask_registry=registry,
                subtask_result_sink=save_result,
            )
        before = len(search_calls)
        assert before == 2
        assert len(saved) == (1 if interruption == "extract" else 2)
        archive = await service.run_research_task(
            task(str(uuid4()), resume=True),
            checkpointer=saver,
            subtask_registry=registry,
            subtask_result_sink=save_result,
        )
        assert archive.final_report
        assert len(archive.research_results) == 2
        assert len(search_calls) == before
        assert len(saved) == 2
        writer_calls = sum(kind == "writer" for kind, _ in model_messages)
        assert writer_calls == (2 if interruption == "writer" else 1)

    asyncio.run(scenario())
