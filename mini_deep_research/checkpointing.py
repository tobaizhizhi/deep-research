"""LangGraph PostgreSQL checkpoint 初始化和租约保护适配。"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any

from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langchain_core.runnables import RunnableConfig


async def setup_postgres_checkpoints(database_url: str) -> None:
    """独立于业务 SQL 迁移运行 LangGraph 官方 checkpoint 表初始化。"""
    async with AsyncPostgresSaver.from_conn_string(database_url) as saver:
        await saver.setup()


async def check_postgres_checkpoints(database_url: str) -> None:
    """Worker 启动只检查已初始化的表，不并发执行 checkpoint DDL。"""
    from psycopg import AsyncConnection

    async with await AsyncConnection.connect(database_url, connect_timeout=3) as conn:
        row = await (
            await conn.execute("SELECT to_regclass('checkpoint_migrations')::text")
        ).fetchone()
        if not row or row[0] is None:
            raise RuntimeError("CHECKPOINT_MIGRATIONS_REQUIRED")
        row = await (await conn.execute("SELECT max(v) FROM checkpoint_migrations")).fetchone()
        if row[0] != len(AsyncPostgresSaver.MIGRATIONS) - 1:
            raise RuntimeError("CHECKPOINT_MIGRATIONS_REQUIRED")


class LeaseAwareCheckpointer(BaseCheckpointSaver[Any]):
    """同一数据库事务内校验当前 attempt 租约并写 checkpoint。

    LangGraph 的标准 saver 不理解业务 lease_token。这个小适配层让旧 Worker
    在租约过期后不能把节点状态或 pending writes 写入共享 thread。
    """

    def __init__(
        self,
        inner: AsyncPostgresSaver,
        write_connection: Callable[[bool], AsyncIterator[Any]],
    ) -> None:
        super().__init__(serde=inner.serde)
        self.inner = inner
        self.write_connection = write_connection

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        async with self.write_connection(True) as conn:
            saver = AsyncPostgresSaver(conn)
            return await saver.aput(config, checkpoint, metadata, new_versions)

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        async with self.write_connection(False) as conn:
            saver = AsyncPostgresSaver(conn)
            await saver.aput_writes(config, writes, task_id, task_path)

    async def aget(self, config: RunnableConfig) -> Checkpoint | None:
        return await self.inner.aget(config)

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return await self.inner.aget_tuple(config)

    async def alist(self, config: RunnableConfig | None, **kwargs):
        async for item in self.inner.alist(config, **kwargs):
            yield item

    def get_next_version(self, current, channel):
        return self.inner.get_next_version(current, channel)


if __name__ == "__main__":
    import asyncio
    import os

    from dotenv import dotenv_values, load_dotenv

    from .config import PROJECT_DIR

    load_dotenv(PROJECT_DIR / ".env")
    database_url = os.getenv("DATABASE_URL") or dotenv_values(
        PROJECT_DIR / "web" / ".env.local"
    ).get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL_REQUIRED")
    asyncio.run(setup_postgres_checkpoints(database_url))
