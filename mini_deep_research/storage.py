"""Worker 的 PostgreSQL 存储边界。

所有执行权、租约和终态更新都在短事务中完成；研究图本身不直接写数据库。
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

from psycopg.rows import dict_row
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from .service import ResearchArchive, ResearchTask
from .contracts import CreateResearchInput, ResearchConfig, ResearchJob
from .log_utils import researcher_identity


def _json(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return value


class LeaseLost(RuntimeError):
    """旧执行者不再有权提交结果。"""


async def _configure(conn):
    await conn.execute("SET statement_timeout = '10s'")
    await conn.execute("SET lock_timeout = '5s'")


class Storage:
    def __init__(self, database_url: str, *, min_size: int = 1, max_size: int = 4):
        self.pool = AsyncConnectionPool(
            database_url,
            min_size=min_size,
            max_size=max_size,
            kwargs={"row_factory": dict_row, "autocommit": True, "connect_timeout": 3},
            configure=_configure,
            timeout=5,
            open=False,
        )

    async def open(self) -> None:
        await self.pool.open()
        await self.pool.wait(timeout=10)

    async def check_ready(self) -> None:
        async with self.pool.connection() as conn:
            rows = await (
                await conn.execute("SELECT name FROM schema_migrations")
            ).fetchall()
        required = {
            "001_auth.sql",
            "002_tasks.sql",
            "003_task_api.sql",
            "004_results.sql",
            "005_p5_events.sql",
            "006_p6_reliability.sql",
            "007_p7_checkpoints.sql",
            "008_reviews.sql",
        }
        if not required.issubset({row["name"] for row in rows}):
            raise RuntimeError("DATABASE_MIGRATIONS_REQUIRED")

    async def close(self) -> None:
        await self.pool.close()

    async def claim_outbox(self, claim_seconds: int = 30) -> dict | None:
        token = str(uuid4())
        async with self.pool.connection() as conn:
            async with conn.transaction():
                row = await conn.execute(
                    """SELECT o.id, o.task_id, o.attempt_id, o.payload_json
                       FROM task_outbox o JOIN research_tasks t ON t.id=o.task_id
                       WHERE o.state <> 'published' AND t.status='queued'
                         AND t.current_attempt_id=o.attempt_id
                         AND o.next_publish_at <= clock_timestamp()
                         AND (o.state = 'pending' OR o.claim_until < clock_timestamp())
                       ORDER BY o.next_publish_at, o.id
                       LIMIT 1 FOR UPDATE OF o SKIP LOCKED"""
                )
                item = await row.fetchone()
                if not item:
                    return None
                await conn.execute(
                    """UPDATE task_outbox
                       SET state='publishing', claim_token=%s,
                           claim_until=clock_timestamp() + (%s * interval '1 second'),
                           publish_attempts=publish_attempts + 1
                       WHERE id=%s""",
                    (token, claim_seconds, item["id"]),
                )
                return {**item, "claim_token": token}

    async def mark_published(self, outbox_id: str, claim_token: str) -> bool:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                result = await conn.execute(
                    """UPDATE task_outbox SET state='published', published_at=COALESCE(published_at, now()),
                           last_reconciled_at=now(), claim_until=NULL WHERE id=%s AND claim_token=%s
                           AND state='publishing' AND claim_until > clock_timestamp()""",
                    (outbox_id, claim_token),
                )
                return result.rowcount == 1

    async def claim_published_reconciliation(
        self, claim_seconds: int = 30, after_seconds: int = 60
    ) -> dict | None:
        """领取一个可能丢失 Redis 通知的 queued outbox。

        outbox 已经标记 published 也不代表 Redis 永远保留了消息。定期重新 XADD
        同一个 payload 可以恢复被清理或丢失的通知；消费端用数据库状态去重。
        """
        token = str(uuid4())
        async with self.pool.connection() as conn:
            async with conn.transaction():
                row = await conn.execute(
                    """SELECT o.id, o.task_id, o.attempt_id, o.payload_json
                       FROM task_outbox o JOIN research_tasks t ON t.id=o.task_id
                       WHERE o.state='published' AND t.status='queued'
                         AND t.current_attempt_id=o.attempt_id
                         AND o.published_at <= clock_timestamp() - (%s * interval '1 second')
                         AND (o.last_reconciled_at IS NULL OR
                              o.last_reconciled_at <= clock_timestamp() - (%s * interval '1 second'))
                         AND (o.claim_until IS NULL OR o.claim_until < clock_timestamp())
                       ORDER BY o.last_reconciled_at NULLS FIRST, o.published_at, o.id
                       LIMIT 1 FOR UPDATE OF o SKIP LOCKED""",
                    (after_seconds, after_seconds),
                )
                item = await row.fetchone()
                if not item:
                    return None
                await conn.execute(
                    """UPDATE task_outbox
                       SET state='publishing', claim_token=%s,
                           claim_until=clock_timestamp() + (%s * interval '1 second'),
                           publish_attempts=publish_attempts + 1
                       WHERE id=%s""",
                    (token, claim_seconds, item["id"]),
                )
                return {**item, "claim_token": token}

    async def count_stale_queued(self, after_seconds: int = 300) -> int:
        async with self.pool.connection() as conn:
            row = await (
                await conn.execute(
                    """SELECT count(*)::int AS count
                       FROM research_tasks
                       WHERE status='queued'
                         AND created_at <= clock_timestamp() - (%s * interval '1 second')""",
                    (after_seconds,),
                )
            ).fetchone()
        return int(row["count"])

    async def mark_publish_failure(self, outbox_id: str, claim_token: str) -> None:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(
                    """UPDATE task_outbox
                       SET state='pending', claim_until=NULL,
                           last_reconciled_at=now(),
                           next_publish_at=now() + LEAST(publish_attempts * interval '2 seconds', interval '5 minutes')
                       WHERE id=%s AND claim_token=%s AND state='publishing'
                         AND claim_until > clock_timestamp()""",
                    (outbox_id, claim_token),
                )

    async def load_task(self, task_id: str, attempt_id: str) -> ResearchTask | None:
        async with self.pool.connection() as conn:
            row = await conn.execute(
                """SELECT t.id AS task_id, a.id AS attempt_id,
                          t.question, t.requirements, t.language, t.depth,
                          t.config_json, a.graph_run_id, a.resume_from_checkpoint,
                          g.thread_id AS graph_thread_id, g.checkpoint_ns,
                          g.state_schema_version, g.code_version AS graph_code_version,
                          g.prompt_version AS graph_prompt_version,
                          GREATEST(0, (t.config_json->>'total_timeout_seconds')::numeric -
                            COALESCE((SELECT SUM(EXTRACT(EPOCH FROM x.finished_at-x.started_at))
                                      FROM research_attempts x
                                      WHERE x.graph_run_id=g.id AND x.id<>a.id
                                        AND x.started_at IS NOT NULL AND x.finished_at IS NOT NULL), 0))
                            AS budget_remaining_seconds
                   FROM research_tasks t JOIN research_attempts a
                     ON a.task_id=t.id AND a.id=%s
                   JOIN research_graph_runs g ON g.id=a.graph_run_id
                   WHERE t.id=%s AND t.current_attempt_id=a.id""",
                (attempt_id, task_id),
            )
            item = await row.fetchone()
            if not item:
                return None
            return ResearchTask(
                task_id=str(item["task_id"]),
                attempt_id=str(item["attempt_id"]),
                input=CreateResearchInput(
                    question=item["question"],
                    requirements=item["requirements"],
                    language=item["language"],
                    depth=item["depth"],
                ),
                config=ResearchConfig.model_validate(item["config_json"]),
                graph_run_id=str(item["graph_run_id"]),
                graph_thread_id=item["graph_thread_id"],
                checkpoint_ns=item["checkpoint_ns"],
                resume=item["resume_from_checkpoint"],
                budget_remaining_seconds=float(item["budget_remaining_seconds"]),
                state_schema_version=item["state_schema_version"],
                graph_code_version=item["graph_code_version"],
                graph_prompt_version=item["graph_prompt_version"],
            )

    @asynccontextmanager
    async def checkpoint_connection(
        self,
        task_id: str,
        attempt_id: str,
        lease_token: str,
        *,
        complete_checkpoint: bool,
    ):
        """同一事务校验租约并写 LangGraph checkpoint，旧执行者不能写入。"""
        async with self.pool.connection() as conn:
            async with conn.transaction():
                if not await self._owns_lease(conn, task_id, attempt_id, lease_token):
                    raise LeaseLost("LEASE_LOST_CHECKPOINT_WRITE")
                yield conn
                if complete_checkpoint:
                    await conn.execute(
                        """UPDATE research_graph_runs g
                           SET last_checkpoint_at=clock_timestamp(),
                               checkpoint_count=checkpoint_count+1
                           FROM research_attempts a
                           WHERE a.id=%s AND a.task_id=%s AND a.graph_run_id=g.id""",
                        (attempt_id, task_id),
                    )
                    researcher_id = researcher_identity.get()
                    if researcher_id:
                        await conn.execute(
                            """UPDATE research_subtasks s
                               SET status=CASE WHEN s.status='pending' THEN 'running' ELSE s.status END,
                                   started_at=COALESCE(s.started_at, clock_timestamp()),
                                   last_checkpoint_at=clock_timestamp()
                               FROM research_attempts a
                               WHERE a.id=%s AND a.task_id=%s
                                 AND s.graph_run_id=a.graph_run_id AND s.researcher_id=%s""",
                            (attempt_id, task_id, researcher_id),
                        )

    async def register_subtasks(
        self,
        graph_run_id: str,
        task_id: str,
        attempt_id: str,
        lease_token: str,
        batch: int,
        topics: list[str],
    ) -> list[dict]:
        """登记本批稳定子任务，并返回已完成结果供父节点重放复用。"""
        async with self.pool.connection() as conn:
            async with conn.transaction():
                if not await self._owns_lease(conn, task_id, attempt_id, lease_token):
                    raise LeaseLost("LEASE_LOST")
                rows: list[dict] = []
                for index, topic in enumerate(topics, 1):
                    ordinal = (batch - 1) * 3 + index
                    researcher_id = f"{graph_run_id}:r{ordinal}"
                    thread_id = f"research:{graph_run_id}:subtask:{ordinal}"
                    await conn.execute(
                        """INSERT INTO research_subtasks
                           (graph_run_id,ordinal,batch,researcher_id,topic,thread_id,attempt_id)
                           VALUES (%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (graph_run_id, ordinal) DO UPDATE
                           SET attempt_id=EXCLUDED.attempt_id
                           WHERE research_subtasks.topic=EXCLUDED.topic""",
                        (graph_run_id, ordinal, batch, researcher_id, topic, thread_id, attempt_id),
                    )
                    row = await (
                        await conn.execute(
                            """SELECT researcher_id,topic,thread_id,checkpoint_ns,status,
                                      result_json, last_checkpoint_at IS NOT NULL AS has_checkpoint
                               FROM research_subtasks
                               WHERE graph_run_id=%s AND ordinal=%s""",
                            (graph_run_id, ordinal),
                        )
                    ).fetchone()
                    if row is None:
                        raise RuntimeError("SUBTASK_REGISTRATION_FAILED")
                    item = dict(row)
                    if item["result_json"] is not None:
                        item["result"] = item.pop("result_json")
                    else:
                        item.pop("result_json", None)
                    rows.append(item)
                return rows

    @asynccontextmanager
    async def exclusive_graph_run(self, thread_id: str):
        """持有 PostgreSQL 会话锁直到图完全退出；进程死亡会自动释放。"""
        async with await AsyncConnection.connect(
            self.pool.conninfo, autocommit=True, connect_timeout=3
        ) as conn:
            row = await (
                await conn.execute(
                    "SELECT pg_try_advisory_lock(hashtextextended(%s, 0)) AS locked",
                    (thread_id,),
                )
            ).fetchone()
            if not row[0]:
                raise LeaseLost("GRAPH_RUN_IN_USE")
            try:
                yield
            finally:
                await conn.execute(
                    "SELECT pg_advisory_unlock(hashtextextended(%s, 0))",
                    (thread_id,),
                )

    async def complete_subtask_owned(
        self,
        graph_run_id: str,
        researcher_id: str,
        task_id: str,
        attempt_id: str,
        lease_token: str,
        result: dict,
    ) -> bool:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                if not await self._owns_lease(conn, task_id, attempt_id, lease_token):
                    return False
                row = await (
                    await conn.execute(
                        """SELECT status,result_json FROM research_subtasks
                           WHERE graph_run_id=%s AND researcher_id=%s FOR UPDATE""",
                        (graph_run_id, researcher_id),
                    )
                ).fetchone()
                if row is None:
                    return False
                if row["status"] == "succeeded":
                    return row["result_json"] == result
                await conn.execute(
                    """UPDATE research_subtasks
                       SET status='succeeded', result_json=%s, attempt_id=%s,
                           completed_at=clock_timestamp(), error_detail=NULL
                       WHERE graph_run_id=%s AND researcher_id=%s""",
                    (json.dumps(result), attempt_id, graph_run_id, researcher_id),
                )
                return True

    async def claim_attempt(
        self, task_id: str, attempt_id: str, worker_id: str, lease_seconds: int
    ) -> str | None:
        lease_token = str(uuid4())
        async with self.pool.connection() as conn:
            async with conn.transaction():
                locked = await self._lock_current(conn, task_id, attempt_id)
                if not locked:
                    return None
                task, attempt = locked
                if (
                    task["status"] != "queued"
                    or attempt["status"] != "queued"
                    or task["cancel_requested_at"]
                ):
                    return None
                await conn.execute(
                    """UPDATE research_tasks SET status='running' WHERE id=%s""",
                    (task_id,),
                )
                await conn.execute(
                    """UPDATE research_attempts SET status='running', worker_id=%s,
                           lease_token=%s, lease_expires_at=clock_timestamp() + (%s * interval '1 second'),
                           heartbeat_at=clock_timestamp(), started_at=clock_timestamp()
                       WHERE id=%s""",
                    (worker_id, lease_token, lease_seconds, attempt_id),
                )
                await self._append_event(
                    conn, task_id, attempt_id, "task.started", {"status": "running"}
                )
                return lease_token

    async def renew_lease(
        self, task_id: str, attempt_id: str, lease_token: str, lease_seconds: int
    ) -> bool:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                if not await self._owns_lease(conn, task_id, attempt_id, lease_token):
                    return False
                result = await conn.execute(
                    """UPDATE research_attempts SET heartbeat_at=clock_timestamp(),
                           lease_expires_at=clock_timestamp() + (%s * interval '1 second')
                       WHERE id=%s AND lease_expires_at > clock_timestamp()""",
                    (lease_seconds, attempt_id),
                )
                return result.rowcount == 1

    async def append_runtime_event(
        self,
        task_id: str,
        attempt_id: str,
        lease_token: str,
        event_type: str,
        payload: dict,
    ) -> str:
        """在当前租约仍有效时追加一个业务事件。

        事件和任务序号在同一短事务中提交；如果取消或租约失效，调用方会收到
        LeaseLost，研究图不能继续把过期执行者的进度写入当前任务。
        """
        async with self.pool.connection() as conn:
            async with conn.transaction():
                if not await self._owns_lease(conn, task_id, attempt_id, lease_token):
                    raise LeaseLost("LEASE_LOST")
                return await self._append_event(
                    conn, task_id, attempt_id, event_type, payload
                )

    async def _append_event(
        self, conn, task_id: str, attempt_id: str, event_type: str, payload: dict
    ) -> str:
        row = await conn.execute(
            """UPDATE research_tasks SET next_event_seq=next_event_seq+1
               WHERE id=%s RETURNING (next_event_seq-1)::text AS seq""",
            (task_id,),
        )
        seq = (await row.fetchone())["seq"]
        await conn.execute(
            """INSERT INTO task_events(task_id, seq, attempt_id, type, payload_json)
               VALUES (%s,%s,%s,%s,%s)""",
            (
                task_id,
                seq,
                attempt_id,
                event_type,
                json.dumps(
                    {
                        "schema_version": 1,
                        "task_id": str(task_id),
                        "attempt_id": str(attempt_id),
                        **payload,
                    }
                ),
            ),
        )
        return str(seq)

    async def finish_success(
        self, task_id: str, attempt_id: str, lease_token: str, archive: ResearchArchive
    ) -> bool:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                if not await self._owns_lease(conn, task_id, attempt_id, lease_token):
                    return False
                for ordinal, result in enumerate(archive.research_results, 1):
                    await conn.execute(
                        """INSERT INTO researcher_results
                           (task_id,attempt_id,ordinal,researcher_id,topic,findings_json,sources_json,brief_text,
                            brief_finding_ids,done,gaps_json,stop_reason,search_round,
                            searched_queries_json,compression_used,compression_warning)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (
                            task_id,
                            attempt_id,
                            ordinal,
                            result.researcher_id,
                            result.topic,
                            json.dumps([_json(x) for x in result.findings]),
                            json.dumps([_json(x) for x in result.sources]),
                            result.compressed_research,
                            json.dumps(result.summary_finding_ids),
                            result.done,
                            json.dumps(result.gaps),
                            result.stop_reason,
                            result.search_round,
                            json.dumps(result.searched_queries),
                            result.compression_used,
                            result.compression_warning,
                        ),
                    )
                await conn.execute(
                    """INSERT INTO research_reports
                       (task_id,attempt_id,version,markdown,findings_json,sources_json,gaps_json,
                        citation_warnings_json,compression_metrics_json,research_done,stop_reason)
                       VALUES (%s,%s,(SELECT COALESCE(max(version),0)+1 FROM research_reports WHERE task_id=%s),%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        task_id,
                        attempt_id,
                        task_id,
                        archive.final_report,
                        json.dumps([_json(x) for x in archive.findings]),
                        json.dumps([_json(x) for x in archive.sources]),
                        json.dumps(archive.gaps),
                        json.dumps(archive.citation_warnings),
                        json.dumps(archive.compression_metrics),
                        archive.research_done,
                        archive.stop_reason,
                    ),
                )
                updated = await conn.execute(
                    """UPDATE research_attempts SET status='succeeded', finished_at=now(),
                           lease_expires_at=NULL WHERE id=%s AND lease_expires_at > clock_timestamp()""",
                    (attempt_id,),
                )
                if updated.rowcount != 1:
                    raise LeaseLost("LEASE_LOST")
                await conn.execute(
                    """UPDATE research_tasks SET status='succeeded', research_done=%s,
                           stop_reason=%s WHERE id=%s""",
                    (archive.research_done, archive.stop_reason, task_id),
                )
                await conn.execute(
                    """UPDATE research_graph_runs g SET status='completed'
                       FROM research_attempts a
                       WHERE a.id=%s AND a.task_id=%s AND a.graph_run_id=g.id""",
                    (attempt_id, task_id),
                )
                await self._append_event(
                    conn,
                    task_id,
                    attempt_id,
                    "task.succeeded",
                    {"status": "succeeded", "research_done": archive.research_done},
                )
                return True

    async def finish_cancelled(
        self, task_id: str, attempt_id: str, lease_token: str
    ) -> bool:
        """把已收到取消请求的运行中 attempt 收敛为 cancelled。"""
        async with self.pool.connection() as conn:
            async with conn.transaction():
                if not await self._owns_lease(
                    conn, task_id, attempt_id, lease_token, allow_cancel=True
                ):
                    return False
                updated = await conn.execute(
                    """UPDATE research_attempts
                       SET status='cancelled', finished_at=clock_timestamp(),
                           lease_expires_at=NULL
                       WHERE id=%s AND status='running'""",
                    (attempt_id,),
                )
                if updated.rowcount != 1:
                    return False
                await conn.execute(
                    """UPDATE research_tasks
                       SET status='cancelled', research_done=NULL,
                           stop_reason='用户请求已停止研究。'
                       WHERE id=%s AND status='running'""",
                    (task_id,),
                )
                await self._append_event(
                    conn,
                    task_id,
                    attempt_id,
                    "task.cancelled",
                    {"status": "cancelled", "reason": "user_requested"},
                )
                return True

    async def finish_failure(
        self, task_id: str, attempt_id: str, lease_token: str, code: str, detail: str
    ) -> bool:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                if not await self._owns_lease(conn, task_id, attempt_id, lease_token):
                    return False
                updated = await conn.execute(
                    """UPDATE research_attempts SET status='failed', finished_at=now(),
                           lease_expires_at=NULL, error_code=%s, error_detail=%s
                       WHERE id=%s AND lease_expires_at > clock_timestamp()""",
                    (code, detail[:2000], attempt_id),
                )
                if updated.rowcount != 1:
                    raise LeaseLost("LEASE_LOST")
                await conn.execute(
                    """UPDATE research_tasks SET status='failed', research_done=NULL,
                           stop_reason=%s WHERE id=%s""",
                    (detail[:2000], task_id),
                )
                await self._append_event(
                    conn,
                    task_id,
                    attempt_id,
                    "task.failed",
                    {"status": "failed", "error_code": code},
                )
                return True

    async def _owns_lease(
        self,
        conn,
        task_id: str,
        attempt_id: str,
        lease_token: str,
        *,
        allow_cancel: bool = False,
    ) -> bool:
        locked = await self._lock_current(conn, task_id, attempt_id)
        if not locked:
            return False
        task, attempt = locked
        if (
            task["status"] != "running"
            or (task["cancel_requested_at"] and not allow_cancel)
            or attempt["status"] != "running"
            or str(attempt["lease_token"]) != lease_token
        ):
            return False
        # 必须在等待行锁之后重新读数据库时钟，不能用事务开始时的 now()。
        row = await conn.execute(
            "SELECT 1 FROM research_attempts WHERE id=%s AND lease_expires_at > clock_timestamp()",
            (attempt_id,),
        )
        return await row.fetchone() is not None

    async def cancellation_requested(self, task_id: str, attempt_id: str) -> bool:
        async with self.pool.connection() as conn:
            row = await (
                await conn.execute(
                    """SELECT t.cancel_requested_at IS NOT NULL AS requested
                       FROM research_tasks t
                       WHERE t.id=%s AND t.current_attempt_id=%s AND t.status='running'""",
                    (task_id, attempt_id),
                )
            ).fetchone()
        return bool(row and row["requested"])

    async def owns_lease(self, task_id: str, attempt_id: str, lease_token: str) -> bool:
        """供 checkpoint 写入适配器使用的短事务执行权检查。"""
        async with self.pool.connection() as conn:
            async with conn.transaction():
                return await self._owns_lease(conn, task_id, attempt_id, lease_token)

    async def _lock_current(self, conn, task_id: str, attempt_id: str):
        # 所有写路径严格先锁 task，再锁 attempt，与 Web 取消保持一致。
        task = await (
            await conn.execute(
                "SELECT * FROM research_tasks WHERE id=%s FOR UPDATE",
                (task_id,),
            )
        ).fetchone()
        if not task or str(task["current_attempt_id"]) != str(attempt_id):
            return None
        attempt = await (
            await conn.execute(
                "SELECT * FROM research_attempts WHERE task_id=%s AND id=%s FOR UPDATE",
                (task_id, attempt_id),
            )
        ).fetchone()
        return (task, attempt) if attempt else None

    async def message_state(self, job: ResearchJob) -> str:
        """数据库为消息的身份、终态和执行权来源；wait 表示暂时不能 ACK。"""
        async with self.pool.connection() as conn:
            row = await (
                await conn.execute(
                    """SELECT o.payload_json, t.status AS task_status, t.current_attempt_id,
                          a.status, a.lease_expires_at > clock_timestamp() AS healthy,
                          EXISTS(SELECT 1 FROM research_reports r WHERE r.attempt_id=a.id) AS has_report
                   FROM task_outbox o JOIN research_tasks t ON t.id=o.task_id
                   JOIN research_attempts a ON a.id=o.attempt_id AND a.task_id=t.id
                   WHERE o.id=%s AND o.task_id=%s AND o.attempt_id=%s""",
                    (job.message_id, job.task_id, job.attempt_id),
                )
            ).fetchone()
        if not row or row["payload_json"] != job.model_dump(mode="json"):
            return "invalid"
        if str(row["current_attempt_id"]) != job.attempt_id:
            return "skip"
        if row["status"] in ("failed", "cancelled", "abandoned"):
            return "skip"
        if row["status"] == "succeeded":
            return "skip" if row["has_report"] else "wait"
        if row["status"] == "running":
            return "skip" if row["healthy"] else "wait"
        return "ready" if row["task_status"] == "queued" else "wait"

    async def expire_leases(self, limit: int = 20) -> int:
        async with self.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    """SELECT task_id,id FROM research_attempts WHERE status='running'
                   AND lease_expires_at <= clock_timestamp() ORDER BY lease_expires_at LIMIT %s""",
                    (limit,),
                )
            ).fetchall()
        expired = 0
        for row in rows:
            async with self.pool.connection() as conn:
                async with conn.transaction():
                    locked = await self._lock_current(conn, row["task_id"], row["id"])
                    if (
                        not locked
                        or locked[0]["status"] != "running"
                        or locked[1]["status"] != "running"
                    ):
                        continue
                    cancelled = bool(locked[0]["cancel_requested_at"])
                    terminal_status = "cancelled" if cancelled else "failed"
                    error_code = "" if cancelled else "WORKER_LOST"
                    error_detail = "用户请求已停止研究。" if cancelled else "研究执行进程失联。"
                    updated = await conn.execute(
                        """UPDATE research_attempts SET status=%s, finished_at=now(),
                               error_code=NULLIF(%s, ''), error_detail=NULLIF(%s, ''), lease_expires_at=NULL
                           WHERE id=%s AND lease_expires_at <= clock_timestamp()""",
                        (terminal_status, error_code, error_detail, row["id"]),
                    )
                    if updated.rowcount != 1:
                        continue
                    await conn.execute(
                        "UPDATE research_tasks SET status=%s, research_done=NULL, stop_reason=%s WHERE id=%s",
                        (terminal_status, error_detail, row["task_id"]),
                    )
                    await self._append_event(
                        conn,
                        row["task_id"],
                        row["id"],
                        "task.cancelled" if cancelled else "task.failed",
                        {
                            "status": terminal_status,
                            **({"reason": "user_requested"} if cancelled else {"error_code": "WORKER_LOST"}),
                        },
                    )
                    expired += 1
        return expired

    async def is_terminal(self, job: ResearchJob) -> bool:
        """提交响应不确定时回查，只有结果已经落库才能 ACK。"""
        async with self.pool.connection() as conn:
            row = await (
                await conn.execute(
                    """SELECT a.status,
                              EXISTS(SELECT 1 FROM research_reports r WHERE r.attempt_id=a.id) AS has_report
                       FROM research_attempts a
                       WHERE a.task_id=%s AND a.id=%s""",
                    (job.task_id, job.attempt_id),
                )
            ).fetchone()
        return bool(
            row
            and (
                row["status"] in ("failed", "cancelled", "abandoned")
                or (row["status"] == "succeeded" and row["has_report"])
            )
        )
