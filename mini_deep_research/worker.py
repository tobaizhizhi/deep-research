"""后台 Worker：Outbox relay、Redis Streams 消费和研究图执行。

运行：``uv run python -m mini_deep_research.worker``。
一个进程一次执行一个任务；PostgreSQL 决定执行权、终态和是否可以 ACK。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import socket
from contextlib import AsyncExitStack
from contextlib import suppress
from uuid import uuid4
from dotenv import dotenv_values

from langchain_core.exceptions import OutputParserException
from openai import APIError
from pydantic import ValidationError
from redis.asyncio import Redis
from redis.exceptions import ResponseError

from .config import ConfigUnavailable, PROJECT_DIR, WorkerSettings, load_worker_settings
from .contracts import RESEARCH_CONSUMER_GROUP, RESEARCH_STREAM, ResearchJob
from .log_utils import setup_logging
from .search import SearchError
from .service import run_research_task
from .storage import LeaseLost, Storage
from .checkpointing import LeaseAwareCheckpointer, check_postgres_checkpoints
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

logger = logging.getLogger("mini_deep_research.worker")
FAILURE_MESSAGES = {
    "CONFIG_UNAVAILABLE": "本次任务的研究配置不可用。",
    "RESEARCH_TIMEOUT": "研究执行超时，未归档报告。",
    "SEARCH_ERROR": "搜索服务调用失败。",
    "MODEL_ERROR": "模型调用或结构化输出失败。",
    "RESEARCH_FAILED": "研究未能完成。",
    "WORKER_SHUTDOWN": "研究执行服务已停止，本次任务未完成。",
}


class CancellationRequested(RuntimeError):
    """用户已请求停止当前图执行。"""


async def cancel_and_wait(*tasks: asyncio.Task) -> None:
    for task in tasks:
        if not task.done():
            task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


class Worker:
    def __init__(
        self,
        settings: WorkerSettings | None = None,
        *,
        stream: str = RESEARCH_STREAM,
        group: str = RESEARCH_CONSUMER_GROUP,
    ):
        self.settings = settings or load_worker_settings()
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}:{uuid4().hex[:8]}"
        self.storage = Storage(self.settings.database_url)
        self.redis = Redis.from_url(
            self.settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=5,
        )
        self.stream = stream
        self.group = group
        self.invalid_stream = f"{stream}:invalid"
        self.stop_event = asyncio.Event()
        self.pending_cursor = "0-0"
        self.checkpoint_stack: AsyncExitStack | None = None
        self.checkpointer: AsyncPostgresSaver | None = None

    async def ensure_group(self) -> None:
        try:
            await self.redis.xgroup_create(
                self.stream, self.group, id="0", mkstream=True
            )
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def start(self) -> None:
        await self.storage.open()
        await self.storage.check_ready()
        await check_postgres_checkpoints(self.settings.database_url)
        self.checkpoint_stack = AsyncExitStack()
        self.checkpointer = await self.checkpoint_stack.enter_async_context(
            AsyncPostgresSaver.from_conn_string(self.settings.database_url)
        )
        await self.redis.ping()
        await self.ensure_group()

    async def close(self) -> None:
        self.stop_event.set()
        await self.redis.aclose()
        if self.checkpoint_stack is not None:
            await self.checkpoint_stack.aclose()
            self.checkpoint_stack = None
            self.checkpointer = None
        await self.storage.close()

    @staticmethod
    def log_failure(stage: str, exc: Exception, job: ResearchJob | None = None):
        # 外部异常可能包含请求头或 URL；服务日志只保留类型和任务定位。
        logger.warning(
            "stage=%s task=%s attempt=%s error_type=%s",
            stage,
            job.task_id if job else "-",
            job.attempt_id if job else "-",
            type(exc).__name__,
        )

    async def relay_once(self) -> bool:
        item = await self.storage.claim_outbox(self.settings.outbox_claim_seconds)
        if not item:
            return False
        try:
            await self.redis.xadd(
                self.stream,
                {"payload": json.dumps(item["payload_json"], ensure_ascii=False)},
            )
        except Exception:
            with suppress(Exception):
                await self.storage.mark_publish_failure(item["id"], item["claim_token"])
            raise
        # XADD 成功后崩溃会重投同一个 message_id；消费端按数据库幂等。
        await self.storage.mark_published(item["id"], item["claim_token"])
        return True

    async def reconcile_once(self) -> bool:
        """重新投递数据库认为已发布、但可能已从 Redis 消失的 queued 任务。"""
        item = await self.storage.claim_published_reconciliation(
            self.settings.outbox_claim_seconds,
            self.settings.reconcile_after_seconds,
        )
        if not item:
            return False
        try:
            await self.redis.xadd(
                self.stream,
                {"payload": json.dumps(item["payload_json"], ensure_ascii=False)},
            )
        except Exception:
            with suppress(Exception):
                await self.storage.mark_publish_failure(item["id"], item["claim_token"])
            raise
        await self.storage.mark_published(item["id"], item["claim_token"])
        return True

    async def pause(self, seconds: float) -> None:
        try:
            async with asyncio.timeout(seconds):
                await self.stop_event.wait()
        except TimeoutError:
            pass

    async def relay_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                if await self.relay_once():
                    continue
                if await self.reconcile_once():
                    continue
            except Exception as exc:
                self.log_failure("relay", exc)
            await self.pause(self.settings.poll_seconds)

    async def quarantine(self, stream_id: str, code: str) -> None:
        # 不把不可信的原始消息复制到隔离流。
        await self.redis.xadd(
            self.invalid_stream,
            {"stream_id": stream_id, "error": code},
        )
        await self.redis.xack(self.stream, self.group, stream_id)

    async def handle_message(self, stream_id: str, fields: dict) -> None:
        try:
            payload = fields.get("payload", "")
            if len(payload.encode("utf-8")) > 4096:
                raise ValueError("JOB_TOO_LARGE")
            job = ResearchJob.model_validate_json(payload)
        except (ValidationError, ValueError, TypeError, AttributeError):
            await self.quarantine(stream_id, "INVALID_JOB")
            return

        state = await self.storage.message_state(job)
        if state == "invalid":
            await self.quarantine(stream_id, "MESSAGE_MISMATCH")
        elif state == "skip":
            await self.redis.xack(self.stream, self.group, stream_id)
        elif state == "ready":
            if await self.run_attempt(job):
                await self.redis.xack(self.stream, self.group, stream_id)
        # wait：不 ACK，等租约/数据库状态变化后重新核对。

    async def recover_pending_once(self) -> bool:
        result = await self.redis.xautoclaim(
            self.stream,
            self.group,
            self.worker_id,
            min_idle_time=self.settings.lease_seconds * 1000,
            start_id=self.pending_cursor,
            count=1,
        )
        self.pending_cursor = result[0]
        for stream_id, fields in result[1]:
            await self.handle_message(stream_id, fields)
        return bool(result[1])

    async def consume_once(self) -> bool:
        await self.recover_pending_once()
        rows = await self.redis.xreadgroup(
            groupname=self.group,
            consumername=self.worker_id,
            streams={self.stream: ">"},
            count=1,
            block=1000,
        )
        for _stream, entries in rows:
            for stream_id, fields in entries:
                await self.handle_message(stream_id, fields)
        return bool(rows)

    async def consume_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                await self.consume_once()
            except Exception as exc:
                self.log_failure("consume", exc)
                with suppress(Exception):
                    await self.ensure_group()
                await self.pause(self.settings.poll_seconds)

    async def heartbeat(self, job: ResearchJob, lease: str) -> None:
        while True:
            await asyncio.sleep(self.settings.heartbeat_seconds)
            if not await self.storage.renew_lease(
                job.task_id,
                job.attempt_id,
                lease,
                self.settings.lease_seconds,
            ):
                raise LeaseLost("LEASE_LOST")

    async def execute_graph(self, job: ResearchJob, lease: str):
        try:
            task = await self.storage.load_task(job.task_id, job.attempt_id)
        except ValidationError as exc:
            raise ConfigUnavailable("CONFIG_UNAVAILABLE") from exc
        if task is None:
            raise LeaseLost("CURRENT_ATTEMPT_CHANGED")
        web_config = dotenv_values(PROJECT_DIR / "web" / ".env.local")
        code_version = os.getenv("RESEARCH_CODE_VERSION") or web_config.get("RESEARCH_CODE_VERSION") or "local-p2"
        prompt_version = os.getenv("RESEARCH_PROMPT_VERSION") or web_config.get("RESEARCH_PROMPT_VERSION") or "v1"
        if (
            task.state_schema_version != 1
            or task.graph_code_version != task.config.code_version
            or task.graph_prompt_version != task.config.prompt_version
            or task.graph_code_version != code_version
            or task.graph_prompt_version != prompt_version
        ):
            raise ConfigUnavailable("GRAPH_VERSION_INCOMPATIBLE")
        # 总时限控制实际图调用，recursion_limit 只保护图步数。
        async def event_sink(event_type: str, payload: dict) -> None:
            await self.storage.append_runtime_event(
                job.task_id,
                job.attempt_id,
                lease,
                event_type,
                payload,
            )

        async def checkpoint() -> None:
            if await self.storage.cancellation_requested(job.task_id, job.attempt_id):
                raise CancellationRequested("CANCEL_REQUESTED")
            if not await self.storage.owns_lease(job.task_id, job.attempt_id, lease):
                raise LeaseLost("LEASE_LOST")

        def checkpoint_write_connection(complete_checkpoint: bool):
            return self.storage.checkpoint_connection(
                job.task_id,
                job.attempt_id,
                lease,
                complete_checkpoint=complete_checkpoint,
            )

        async def register_subtasks(run_id: str, _attempt_id: str, batch: int, topics: list[str]):
            return await self.storage.register_subtasks(
                run_id, job.task_id, job.attempt_id, lease, batch, topics
            )

        async def save_subtask(researcher_id: str, result: dict) -> None:
            task = await self.storage.load_task(job.task_id, job.attempt_id)
            if task is None or task.graph_run_id is None:
                raise LeaseLost("CURRENT_ATTEMPT_CHANGED")
            from .service import ResearcherArchive

            serialized = ResearcherArchive.model_validate(result).model_dump(mode="json")
            if not await self.storage.complete_subtask_owned(
                task.graph_run_id,
                researcher_id,
                job.task_id,
                job.attempt_id,
                lease,
                serialized,
            ):
                raise LeaseLost("LEASE_LOST")

        async with self.storage.exclusive_graph_run(task.graph_thread_id or f"research:{task.task_id}"):
            async with asyncio.timeout(
                task.budget_remaining_seconds
                if task.budget_remaining_seconds is not None
                else task.config.total_timeout_seconds
            ):
                checkpointer = (
                    LeaseAwareCheckpointer(self.checkpointer, checkpoint_write_connection)
                    if self.checkpointer is not None
                    else None
                )
                return await run_research_task(
                    task,
                    event_sink=event_sink,
                    checkpoint=checkpoint,
                    checkpointer=checkpointer,
                    subtask_registry=register_subtasks,
                    subtask_result_sink=save_subtask,
                )

    async def wait_for_cancel(self, job: ResearchJob) -> None:
        while True:
            if await self.storage.cancellation_requested(job.task_id, job.attempt_id):
                return
            await asyncio.sleep(1)

    async def run_attempt(self, job: ResearchJob) -> bool:
        lease = await self.storage.claim_attempt(
            job.task_id,
            job.attempt_id,
            self.worker_id,
            self.settings.lease_seconds,
        )
        if not lease:
            return await self.storage.is_terminal(job)

        research = asyncio.create_task(self.execute_graph(job, lease))
        heartbeat = asyncio.create_task(self.heartbeat(job, lease))
        cancel_watch = asyncio.create_task(self.wait_for_cancel(job))
        code: str | None = None
        try:
            finished, _ = await asyncio.wait(
                {research, heartbeat, cancel_watch},
                # 取消监视器只在数据库收到明确请求后完成。
                # 它不直接写终态，终态仍由拥有租约的 Worker 事务提交。
                # 集合在下面补入，保持 heartbeat/research 的竞争语义不变。
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancel_watch.done():
                await cancel_and_wait(research)
                return await self.storage.finish_cancelled(
                    job.task_id, job.attempt_id, lease
                )
            if heartbeat in finished:
                error = heartbeat.exception()
                self.log_failure("heartbeat", error or LeaseLost(), job)
                await cancel_and_wait(research)
                return False

            try:
                archive = research.result()
            except CancellationRequested:
                return await self.storage.finish_cancelled(
                    job.task_id, job.attempt_id, lease
                )
            except ConfigUnavailable:
                code = "CONFIG_UNAVAILABLE"
            except TimeoutError:
                code = "RESEARCH_TIMEOUT"
            except SearchError:
                code = "SEARCH_ERROR"
            except (APIError, OutputParserException, ValidationError):
                code = "MODEL_ERROR"
            except LeaseLost:
                if await self.storage.cancellation_requested(
                    job.task_id, job.attempt_id
                ):
                    return await self.storage.finish_cancelled(
                        job.task_id, job.attempt_id, lease
                    )
                return False
            except Exception as exc:
                self.log_failure("research", exc, job)
                code = "RESEARCH_FAILED"

            try:
                if code:
                    return await self.storage.finish_failure(
                        job.task_id,
                        job.attempt_id,
                        lease,
                        code,
                        FAILURE_MESSAGES[code],
                    )
                return await self.storage.finish_success(
                    job.task_id,
                    job.attempt_id,
                    lease,
                    archive,
                )
            except Exception as exc:
                # 提交结果未知时回查终态；false 会让消息保持 pending。
                self.log_failure("archive", exc, job)
                return await self.storage.is_terminal(job)
        except asyncio.CancelledError:
            await cancel_and_wait(research)
            with suppress(Exception):
                await self.storage.finish_failure(
                    job.task_id,
                    job.attempt_id,
                    lease,
                    "WORKER_SHUTDOWN",
                    FAILURE_MESSAGES["WORKER_SHUTDOWN"],
                )
            raise
        finally:
            await cancel_and_wait(research, heartbeat, cancel_watch)

    async def maintenance_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                expired = await self.storage.expire_leases()
                stale = await self.storage.count_stale_queued(
                    self.settings.stale_queue_seconds
                )
                if expired:
                    logger.warning("event=lease_reconciled count=%s", expired)
                if stale:
                    logger.warning(
                        "event=stale_queued_tasks count=%s threshold_seconds=%s",
                        stale,
                        self.settings.stale_queue_seconds,
                    )
            except Exception as exc:
                self.log_failure("maintenance", exc)
            await self.pause(self.settings.maintenance_seconds)

    async def run(self) -> None:
        loops: list[asyncio.Task] = []
        try:
            await self.start()
            logger.info("worker=%s event=ready", self.worker_id)
            loops = [
                asyncio.create_task(loop())
                for loop in (self.relay_loop, self.consume_loop, self.maintenance_loop)
            ]
            stopping = asyncio.create_task(self.stop_event.wait())
            loops.append(stopping)
            finished, _ = await asyncio.wait(
                loops,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in finished:
                task.result()
        finally:
            await cancel_and_wait(*loops)
            await self.close()


async def main() -> None:
    setup_logging()
    worker = Worker()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, worker.stop_event.set)
    try:
        await worker.run()
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        logger.error(
            "worker_start_failed error_type=%s; 检查连接、迁移和配置。",
            type(exc).__name__,
        )
        raise SystemExit(1)
