"""真实 PostgreSQL/Redis + Web 业务层 + 研究图。只替换外部模型和搜索。

必须显式设置 TEST_DATABASE_URL / TEST_REDIS_URL；每题使用随机 schema 和 stream。
"""

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote, parse_qsl, urlsplit, urlunsplit
from uuid import uuid4

import psycopg
from psycopg import sql
import pytest

from mini_deep_research import worker as worker_module
from mini_deep_research import graph
from mini_deep_research.config import WorkerSettings
from mini_deep_research.contracts import ResearchJob
from mini_deep_research.worker import Worker
from mini_deep_research.search import SearchError
from mini_deep_research.checkpointing import setup_postgres_checkpoints
from mini_deep_research.storage import LeaseLost
from test_service import install_external_stubs

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_DATABASE_URL") or not os.getenv("TEST_REDIS_URL"),
    reason="需显式设置测试 PostgreSQL 和 Redis 地址",
)
ROOT = Path(__file__).resolve().parents[1]


async def web_call(url, *args, compression=False):
    process = await asyncio.create_subprocess_exec(
        "node",
        "--import",
        "tsx",
        "--import",
        "./tests/setup.ts",
        "tests/create-worker-task.ts",
        *args,
        cwd=ROOT / "web",
        env={
            **os.environ,
            "TEST_DATABASE_URL": url,
            "RESEARCH_COMPRESSION_ENABLED": str(compression).lower(),
        },
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    assert process.returncode == 0, stderr.decode()
    return json.loads(stdout) if stdout.strip() else None


@asynccontextmanager
async def backend():
    schema = f"p3_test_{uuid4().hex}"
    base = os.environ["TEST_DATABASE_URL"]
    admin = await psycopg.AsyncConnection.connect(base, autocommit=True)
    await admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    parts = urlsplit(base)
    params = dict(parse_qsl(parts.query))
    params["options"] = f"-c search_path={schema}"
    query = "&".join(f"{quote(k)}={quote(v, safe='')}" for k, v in params.items())
    url = urlunsplit(parts._replace(query=query))
    w = Worker(
        WorkerSettings(
            url,
            os.environ["TEST_REDIS_URL"],
            heartbeat_seconds=0.1,
            lease_seconds=2,
            poll_seconds=0.05,
            maintenance_seconds=0.1,
        ),
        stream=f"test:{schema}:jobs",
        group=f"test:{schema}:workers",
    )
    try:
        await web_call(url, "migrate")
        await setup_postgres_checkpoints(url)
        await w.start()
        yield SimpleNamespace(w=w, url=url)
    finally:
        await w.redis.delete(w.stream, w.invalid_stream)
        await w.close()
        await admin.execute(
            sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema))
        )
        await admin.close()


async def enqueue(b, *, depth="quick", compression=False):
    created = await web_call(
        b.url,
        json.dumps(
            {
                "question": "What does StateGraph do?",
                "requirements": "Prefer official sources",
                "language": "en",
                "depth": depth,
            }
        ),
        compression=compression,
    )
    async with b.w.storage.pool.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT payload_json FROM task_outbox WHERE task_id=%s",
                (created["task_id"],),
            )
        ).fetchone()
    return created, ResearchJob.model_validate(row["payload_json"])


async def query(b, text, args=()):
    async with b.w.storage.pool.connection() as conn:
        cursor = await conn.execute(text, args)
        return await cursor.fetchall() if cursor.description else []


@pytest.mark.parametrize("compression", [False, True])
def test_web_creation_to_graph_archive_and_duplicate(monkeypatch, compression):
    _, calls, _, _ = install_external_stubs(monkeypatch)

    async def scenario():
        async with backend() as b:
            created, job = await enqueue(b, compression=compression)
            assert await b.w.relay_once()
            await b.w.consume_once()
            detail = await web_call(b.url, "detail", created["user_id"], job.task_id)
            assert detail["status"] == "succeeded" and detail["has_report"] is True
            assert detail["research_done"] is True
            assert int(detail["last_event_seq"]) > 3
            event_types = {
                row["type"]
                for row in await query(
                    b,
                    "SELECT type FROM task_events WHERE task_id=%s",
                    (job.task_id,),
                )
            }
            assert {
                "task.started",
                "supervisor.planned",
                "researcher.started",
                "search.completed",
                "task.succeeded",
            }.issubset(event_types)
            rows = await query(b, "SELECT * FROM researcher_results ORDER BY ordinal")
            assert len(rows) == 2 and all(
                r["compression_used"] == compression for r in rows
            )
            assert len({row["researcher_id"] for row in rows}) == 2
            assert rows[0]["sources_json"][0]["content"]
            assert rows[0]["findings_json"][0]["evidence"]
            assert set(calls) == {3}
            count = len(calls)
            await b.w.redis.xadd(b.w.stream, {"payload": job.model_dump_json()})
            await b.w.consume_once()
            assert len(calls) == count
            assert (await query(b, "SELECT count(*) AS n FROM research_reports"))[0][
                "n"
            ] == 1
            assert (await b.w.redis.xpending(b.w.stream, b.w.group))["pending"] == 0

    asyncio.run(scenario())


def test_postgres_checkpoints_resume_partial_batch_without_repeating_search(monkeypatch):
    _, search_calls, _, _ = install_external_stubs(monkeypatch)
    original_extract = graph.extract_findings
    failed = False

    async def interrupt_after_search(state):
        nonlocal failed
        if state["topic"] == "applications" and not failed:
            await asyncio.sleep(0.1)
            failed = True
            raise RuntimeError("injected interruption")
        return await original_extract(state)

    monkeypatch.setattr(graph, "extract_findings", interrupt_after_search)

    async def scenario():
        async with backend() as b:
            created, job = await enqueue(b)
            await b.w.relay_once()
            await b.w.consume_once()
            assert (
                await query(b, "SELECT status FROM research_tasks WHERE id=%s", (job.task_id,))
            )[0]["status"] == "failed"
            completed = await query(
                b,
                "SELECT status FROM research_subtasks WHERE graph_run_id=(SELECT graph_run_id FROM research_attempts WHERE id=%s) ORDER BY ordinal",
                (job.attempt_id,),
            )
            assert [row["status"] for row in completed] == ["succeeded", "running"]
            assert len(search_calls) == 2
            resumed = await web_call(
                b.url, "resume", created["user_id"], job.task_id, str(uuid4())
            )
            assert resumed["attempt_id"] != job.attempt_id
            new_job = ResearchJob.model_validate(
                (
                    await query(
                        b,
                        "SELECT payload_json FROM task_outbox WHERE attempt_id=%s",
                        (resumed["attempt_id"],),
                    )
                )[0]["payload_json"]
            )
            await b.w.relay_once()
            await b.w.consume_once()
            assert (
                await query(b, "SELECT status FROM research_tasks WHERE id=%s", (job.task_id,))
            )[0]["status"] == "succeeded"
            assert len(search_calls) == 2
            assert await b.w.storage.is_terminal(new_job)
            assert (
                await query(b, "SELECT count(*) AS n FROM research_reports WHERE task_id=%s", (job.task_id,))
            )[0]["n"] == 1
            assert (
                await query(b, "SELECT count(*) AS n FROM researcher_results WHERE attempt_id=%s", (resumed["attempt_id"],))
            )[0]["n"] == 2

    asyncio.run(scenario())


def test_expired_attempt_cannot_write_checkpoint_transaction():
    async def scenario():
        async with backend() as b:
            _, job = await enqueue(b)
            lease = await b.w.storage.claim_attempt(
                job.task_id, job.attempt_id, b.w.worker_id, 2
            )
            assert lease
            await query(
                b,
                "UPDATE research_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=%s",
                (job.attempt_id,),
            )
            with pytest.raises(LeaseLost):
                async with b.w.storage.checkpoint_connection(
                    job.task_id, job.attempt_id, lease, complete_checkpoint=True
                ) as conn:
                    await conn.execute(
                        "INSERT INTO checkpoints(thread_id,checkpoint_ns,checkpoint_id,checkpoint,metadata) VALUES('stale','','stale','{}','{}')"
                    )
            assert (
                await query(b, "SELECT count(*) AS n FROM checkpoints WHERE thread_id='stale'")
            )[0]["n"] == 0

    asyncio.run(scenario())


def test_killed_worker_releases_graph_lock_and_resumes_partial_batch(monkeypatch):
    _, resumed_search_calls, _, _ = install_external_stubs(monkeypatch)
    child_script = """
import asyncio, os, sys
from pathlib import Path
from pytest import MonkeyPatch
from mini_deep_research import graph, worker
from mini_deep_research.config import WorkerSettings
sys.path.insert(0, str(Path.cwd() / 'tests'))
from test_service import install_external_stubs
install_external_stubs(MonkeyPatch())
original = graph.extract_findings
async def block_second(state):
    if state['topic'] == 'applications':
        await asyncio.Event().wait()
    return await original(state)
graph.extract_findings = block_second
async def main():
    w = worker.Worker(
        WorkerSettings(os.environ['TEST_DATABASE_URL'], os.environ['TEST_REDIS_URL'],
                       heartbeat_seconds=.1, lease_seconds=2),
        stream=os.environ['TEST_STREAM'], group=os.environ['TEST_GROUP'])
    await w.start()
    await w.consume_once()
asyncio.run(main())
"""

    async def scenario():
        async with backend() as b:
            created, job = await enqueue(b)
            await b.w.relay_once()
            child = await asyncio.create_subprocess_exec(
                str(ROOT / ".venv/bin/python"),
                "-c",
                child_script,
                cwd=ROOT,
                env={
                    **os.environ,
                    "TEST_DATABASE_URL": b.url,
                    "TEST_STREAM": b.w.stream,
                    "TEST_GROUP": b.w.group,
                },
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                for _ in range(100):
                    rows = await query(
                        b,
                        "SELECT status FROM research_subtasks WHERE graph_run_id=(SELECT graph_run_id FROM research_attempts WHERE id=%s) ORDER BY ordinal",
                        (job.attempt_id,),
                    )
                    parent_status = (
                        await query(b, "SELECT status FROM research_tasks WHERE id=%s", (job.task_id,))
                    )[0]["status"]
                    if [row["status"] for row in rows] == ["succeeded", "running"] and parent_status == "running":
                        break
                    if child.returncode is not None:
                        raise AssertionError("child exited before partial checkpoint")
                    await asyncio.sleep(0.05)
                else:
                    raise AssertionError("partial batch was not checkpointed")
                child.kill()
                await child.wait()
                for _ in range(60):
                    if await b.w.storage.expire_leases() == 1:
                        break
                    await asyncio.sleep(0.1)
                else:
                    raise AssertionError("killed worker lease did not expire")
                resumed = await web_call(
                    b.url, "resume", created["user_id"], job.task_id, str(uuid4())
                )
                await b.w.relay_once()
                await b.w.consume_once()
                assert (
                    await query(b, "SELECT status FROM research_tasks WHERE id=%s", (job.task_id,))
                )[0]["status"] == "succeeded"
                assert resumed_search_calls == []
            finally:
                if child.returncode is None:
                    child.kill()
                    await child.wait()

    asyncio.run(scenario())


def test_concurrent_claims_and_expired_token_cannot_commit(monkeypatch):
    install_external_stubs(monkeypatch)

    async def scenario():
        async with backend() as b:
            _, job = await enqueue(b)
            tokens = await asyncio.gather(
                *[
                    b.w.storage.claim_attempt(
                        job.task_id, job.attempt_id, f"worker-{i}", 2
                    )
                    for i in range(4)
                ]
            )
            assert len([t for t in tokens if t]) == 1
            token = next(t for t in tokens if t)
            assert await b.w.storage.renew_lease(job.task_id, job.attempt_id, token, 2)
            await query(
                b,
                "UPDATE research_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=%s",
                (job.attempt_id,),
            )
            assert not await b.w.storage.renew_lease(
                job.task_id, job.attempt_id, token, 2
            )
            assert not await b.w.storage.finish_failure(
                job.task_id, job.attempt_id, token, "MODEL_ERROR", "old writer"
            )
            assert await b.w.storage.expire_leases() == 1
            assert await b.w.storage.expire_leases() == 0
            row = (await query(b, "SELECT status,error_code FROM research_attempts"))[0]
            assert row == {"status": "failed", "error_code": "WORKER_LOST"}
            assert await b.w.storage.is_terminal(job)

    asyncio.run(scenario())


def test_outbox_retry_stale_claim_and_queued_cancel(monkeypatch):
    async def scenario():
        async with backend() as b:
            _, job = await enqueue(b)
            original = b.w.redis.xadd

            async def unavailable(*args, **kwargs):
                raise ConnectionError("test offline")

            monkeypatch.setattr(b.w.redis, "xadd", unavailable)
            with pytest.raises(ConnectionError):
                await b.w.relay_once()
            row = (await query(b, "SELECT state,publish_attempts FROM task_outbox"))[0]
            assert row == {"state": "pending", "publish_attempts": 1}
            await query(b, "UPDATE task_outbox SET next_publish_at=now()")
            claim = await b.w.storage.claim_outbox(1)
            await query(
                b, "UPDATE task_outbox SET claim_until=now()-interval '1 second'"
            )
            newer = await b.w.storage.claim_outbox(30)
            assert not await b.w.storage.mark_published(
                job.message_id, claim["claim_token"]
            )
            assert claim["claim_token"] != newer["claim_token"]
            # 还原成可投递，模拟取消先提交；relay 不会把它假标为 published。
            await query(b, "UPDATE research_tasks SET status='cancelled'")
            await query(b, "UPDATE research_attempts SET status='cancelled'")
            await query(b, "UPDATE task_outbox SET state='pending'")
            monkeypatch.setattr(b.w.redis, "xadd", original)
            assert await b.w.storage.claim_outbox() is None
            await b.w.redis.xadd(b.w.stream, {"payload": job.model_dump_json()})
            await b.w.consume_once()
            assert (await query(b, "SELECT state FROM task_outbox"))[0][
                "state"
            ] == "pending"
            assert (await b.w.redis.xpending(b.w.stream, b.w.group))["pending"] == 0

    asyncio.run(scenario())


def test_final_event_failure_rolls_back_and_does_not_ack(monkeypatch):
    install_external_stubs(monkeypatch)

    async def scenario():
        async with backend() as b:
            _, job = await enqueue(b)
            await query(
                b,
                """CREATE FUNCTION fail_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF NEW.type='task.succeeded' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$""",
            )
            await query(
                b,
                "CREATE TRIGGER fail_terminal BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION fail_terminal()",
            )
            await b.w.relay_once()
            await b.w.consume_once()
            assert (await query(b, "SELECT status FROM research_tasks"))[0][
                "status"
            ] == "running"
            assert (await query(b, "SELECT count(*) AS n FROM research_reports"))[0][
                "n"
            ] == 0
            assert (await query(b, "SELECT count(*) AS n FROM researcher_results"))[0][
                "n"
            ] == 0
            assert (await b.w.redis.xpending(b.w.stream, b.w.group))["pending"] == 1
            await query(
                b,
                "UPDATE research_attempts SET lease_expires_at=now()-interval '1 second'",
            )
            await b.w.storage.expire_leases()
            assert await b.w.storage.is_terminal(job)

    asyncio.run(scenario())


def test_commit_response_lost_is_reconciled_without_rerun(monkeypatch):
    _, calls, _, _ = install_external_stubs(monkeypatch)

    async def scenario():
        async with backend() as b:
            _, job = await enqueue(b)
            original = b.w.storage.finish_success

            async def commit_then_disconnect(*args):
                await original(*args)
                raise ConnectionError("commit response lost")

            monkeypatch.setattr(b.w.storage, "finish_success", commit_then_disconnect)
            await b.w.relay_once()
            await b.w.consume_once()
            assert await b.w.storage.is_terminal(job)
            assert (await b.w.redis.xpending(b.w.stream, b.w.group))["pending"] == 0
            assert len(calls) == 2

    asyncio.run(scenario())


def test_heartbeat_failure_cancels_graph_and_awaits_cleanup(monkeypatch):
    async def scenario():
        async with backend() as b:
            _, job = await enqueue(b)
            stopped = asyncio.Event()

            async def endless(task, **kwargs):
                try:
                    await asyncio.Event().wait()
                finally:
                    stopped.set()

            async def lose(*args):
                return False

            monkeypatch.setattr(worker_module, "run_research_task", endless)
            monkeypatch.setattr(b.w.storage, "renew_lease", lose)
            assert await b.w.run_attempt(job) is False
            assert stopped.is_set()
            assert not await b.w.storage.is_terminal(job)

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "mode,code", [("search", "SEARCH_ERROR"), ("timeout", "RESEARCH_TIMEOUT")]
)
def test_failure_or_timeout_persists_safe_error_and_next_task_runs(
    monkeypatch, mode, code
):
    install_external_stubs(monkeypatch)

    async def scenario():
        async with backend() as b:
            _, job = await enqueue(b)
            original = worker_module.run_research_task
            cleanup = asyncio.Event()

            async def fail(task, **kwargs):
                if mode == "search":
                    raise SearchError("secret provider request must not be public")
                try:
                    await asyncio.Event().wait()
                finally:
                    cleanup.set()

            actual_timeout = asyncio.timeout

            def shorter_timeout(delay):
                # 保留真实 timeout 机制，确认读取的是 quick 的 300 秒快照。
                return actual_timeout(0.05 if delay == 300 else delay)

            monkeypatch.setattr(worker_module, "run_research_task", fail)
            monkeypatch.setattr(asyncio, "timeout", shorter_timeout)
            await b.w.relay_once()
            await b.w.consume_once()
            row = (
                await query(
                    b,
                    "SELECT status,error_code,error_detail FROM research_attempts WHERE id=%s",
                    (job.attempt_id,),
                )
            )[0]
            assert row["status"] == "failed" and row["error_code"] == code
            assert "secret" not in row["error_detail"]
            if mode == "timeout":
                assert cleanup.is_set()
            monkeypatch.setattr(worker_module, "run_research_task", original)
            monkeypatch.setattr(asyncio, "timeout", actual_timeout)
            await enqueue(b)
            await b.w.relay_once()
            await b.w.consume_once()
            assert (await query(b, "SELECT count(*) AS n FROM research_reports"))[0][
                "n"
            ] == 1

    asyncio.run(scenario())


def test_pending_after_ack_failure_recovers_without_research(monkeypatch):
    _, calls, _, _ = install_external_stubs(monkeypatch)

    async def scenario():
        async with backend() as b:
            await enqueue(b)
            original_ack = b.w.redis.xack

            async def fail_ack(*args):
                raise ConnectionError("lost ACK")

            monkeypatch.setattr(b.w.redis, "xack", fail_ack)
            await b.w.relay_once()
            with pytest.raises(ConnectionError):
                await b.w.consume_once()
            entry = (
                await b.w.redis.xpending_range(b.w.stream, b.w.group, "-", "+", 10)
            )[0]
            await b.w.redis.xclaim(
                b.w.stream,
                b.w.group,
                "dead-worker",
                0,
                [entry["message_id"]],
                idle=3000,
            )
            monkeypatch.setattr(b.w.redis, "xack", original_ack)
            assert await b.w.recover_pending_once()
            assert (await b.w.redis.xpending(b.w.stream, b.w.group))["pending"] == 0
            assert len(calls) == 2

    asyncio.run(scenario())


def test_hard_process_exit_expires_lease_and_recovers_pending():
    async def scenario():
        async with backend() as b:
            _, job = await enqueue(b)
            await b.w.relay_once()
            script = """
import asyncio, os
from mini_deep_research import worker
from mini_deep_research.config import WorkerSettings
async def block(task, **kwargs):
    await asyncio.Event().wait()
worker.run_research_task = block
async def main():
    w=worker.Worker(WorkerSettings(os.environ['TEST_DATABASE_URL'],os.environ['TEST_REDIS_URL'],heartbeat_seconds=.1,lease_seconds=2),stream=os.environ['TEST_STREAM'],group=os.environ['TEST_GROUP'])
    await w.start()
    await w.consume_once()
asyncio.run(main())
"""
            child = await asyncio.create_subprocess_exec(
                str(ROOT / ".venv/bin/python"),
                "-c",
                script,
                cwd=ROOT,
                env={
                    **os.environ,
                    "TEST_DATABASE_URL": b.url,
                    "TEST_STREAM": b.w.stream,
                    "TEST_GROUP": b.w.group,
                },
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                for _ in range(100):
                    if (await query(b, "SELECT status FROM research_tasks"))[0][
                        "status"
                    ] == "running":
                        break
                    await asyncio.sleep(0.05)
                else:
                    raise AssertionError("child did not claim task")
                child.kill()
                await child.wait()
                await asyncio.sleep(2.1)
                assert await b.w.storage.expire_leases() == 1
                assert await b.w.recover_pending_once()
                assert await b.w.storage.is_terminal(job)
                assert (await b.w.redis.xpending(b.w.stream, b.w.group))["pending"] == 0
                assert (await query(b, "SELECT error_code FROM research_attempts"))[0][
                    "error_code"
                ] == "WORKER_LOST"
            finally:
                if child.returncode is None:
                    child.kill()
                    await child.wait()

    asyncio.run(scenario())


def test_graceful_shutdown_is_failure_not_user_cancellation(monkeypatch):
    async def scenario():
        async with backend() as b:
            _, job = await enqueue(b)
            started, cleaned = asyncio.Event(), asyncio.Event()

            async def endless(task, **kwargs):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cleaned.set()

            monkeypatch.setattr(worker_module, "run_research_task", endless)
            running = asyncio.create_task(b.w.run_attempt(job))
            await started.wait()
            running.cancel()
            with pytest.raises(asyncio.CancelledError):
                await running
            assert cleaned.is_set()
            row = (await query(b, "SELECT status,error_code FROM research_attempts"))[0]
            assert row == {"status": "failed", "error_code": "WORKER_SHUTDOWN"}

    asyncio.run(scenario())


def test_unavailable_profile_fails_before_external_call(monkeypatch):
    monkeypatch.setenv("RESEARCH_MODEL_PROFILE", "retired-profile")

    async def scenario():
        async with backend() as b:
            _, job = await enqueue(b)
            await b.w.relay_once()
            await b.w.consume_once()
            row = (await query(b, "SELECT status,error_code FROM research_attempts"))[0]
            assert row == {"status": "failed", "error_code": "CONFIG_UNAVAILABLE"}
            assert (await query(b, "SELECT count(*) AS n FROM research_reports"))[0][
                "n"
            ] == 0
            assert await b.w.storage.is_terminal(job)

    asyncio.run(scenario())


def test_invalid_job_is_quarantined_without_payload():
    async def scenario():
        async with backend() as b:
            await b.w.redis.xadd(b.w.stream, {"payload": "secret malformed message"})
            await b.w.consume_once()
            quarantined = await b.w.redis.xrange(b.w.invalid_stream)
            assert len(quarantined) == 1
            assert quarantined[0][1]["error"] == "INVALID_JOB"
            assert "secret" not in json.dumps(quarantined)
            assert (await b.w.redis.xpending(b.w.stream, b.w.group))["pending"] == 0

    asyncio.run(scenario())
