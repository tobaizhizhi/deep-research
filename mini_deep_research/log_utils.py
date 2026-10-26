"""日志初始化、节点计时和异常链；导入模块不会创建日志文件。"""

import asyncio
import inspect
from collections.abc import Awaitable, Callable
import logging
from contextvars import ContextVar
from functools import wraps
from time import perf_counter

from .config import OUTPUT_DIR

logger = logging.getLogger("mini_deep_research")
service_identity: ContextVar[tuple[str, str] | None] = ContextVar(
    "service_identity",
    default=None,
)
researcher_identity: ContextVar[str | None] = ContextVar(
    "researcher_identity",
    default=None,
)
ServiceEventSink = Callable[[str, dict], Awaitable[None]]
service_event_sink: ContextVar[ServiceEventSink | None] = ContextVar(
    "service_event_sink",
    default=None,
)
service_checkpoint: ContextVar[Callable[[], Awaitable[None]] | None] = ContextVar(
    "service_checkpoint",
    default=None,
)

# 服务层为父图登记稳定的子任务身份，并在子图完成后保存不可变结果。
# 这些回调不进入 LangGraph state，避免凭证、数据库连接或运行时对象被序列化。
SubtaskRegistry = Callable[[str, str, int, list[str]], Awaitable[list[dict]]]
SubtaskResultSink = Callable[[str, dict], Awaitable[None]]
service_subtask_registry: ContextVar[SubtaskRegistry | None] = ContextVar(
    "service_subtask_registry",
    default=None,
)
service_subtask_result_sink: ContextVar[SubtaskResultSink | None] = ContextVar(
    "service_subtask_result_sink",
    default=None,
)

# checkpointer 本身由 service/worker 注入；CLI 继续使用无持久检查点的全局图。
service_checkpointer: ContextVar[object | None] = ContextVar(
    "service_checkpointer",
    default=None,
)
service_execution: ContextVar[tuple[str, str, bool] | None] = ContextVar(
    "service_execution",
    default=None,
)


async def emit_service_event(event_type: str, payload: dict | None = None) -> None:
    sink = service_event_sink.get()
    if sink is None:
        return
    await sink(event_type, payload or {})


async def service_checkpoint_now() -> None:
    checkpoint = service_checkpoint.get()
    if checkpoint is not None:
        await checkpoint()


def setup_logging() -> None:
    """在程序入口调用，配置终端和文件日志。"""

    # 防止多次调用时重复添加输出器。
    if logger.handlers:
        return

    logger.setLevel("INFO")
    logger.propagate = False

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    console = logging.StreamHandler()
    file = logging.FileHandler(
        OUTPUT_DIR / "research.log",
        encoding="utf-8",
    )

    for handler in (console, file):
        handler.setFormatter(formatter)
        logger.addHandler(handler)


def log_node(
    level: int,
    name: str,
    event: str,
    state: dict,
    elapsed: float = 0.0,
    error: BaseException | None = None,
) -> None:
    identity = service_identity.get()
    if identity is not None:
        # 服务日志只记录定位信息，不写供应商原始异常、问题全文或网页材料。
        logger.log(
            level,
            "task=%s attempt=%s node=%s event=%s elapsed=%.2fs "
            "search_round=%s supervisor_round=%s sources=%d findings=%d error_type=%s",
            *identity,
            name,
            event,
            elapsed,
            state.get("search_round", "-"),
            state.get("supervisor_round", "-"),
            len(state.get("sources", [])),
            len(state.get("findings", [])),
            type(error).__name__ if error else "-",
        )
        return
    logger.log(
        level,
        "run=%s node=%s event=%s topic=%r question=%r "
        "search_round=%s supervisor_round=%s "
        "queries=%d sources=%d findings=%d elapsed=%.2fs "
        "done=%s should_stop=%s stop_reason=%r "
        "citation_warnings=%d error_type=%s",
        state.get("run_id", "-"),
        name,
        event,
        state.get("topic", "-"),
        state.get("question", "")[:160],
        state.get("search_round", "-"),
        state.get("supervisor_round", "-"),
        len(state.get("queries", [])),
        len(state.get("sources", [])),
        len(state.get("findings", [])),
        elapsed,
        state.get("done", "-"),
        state.get("should_stop", "-"),
        state.get("stop_reason", ""),
        len(state.get("citation_warnings", [])),
        type(error).__name__ if error is not None else "-",
        exc_info=error is not None,
    )


def observed_node(func):
    """为当前项目中的节点增加统一日志。"""

    @wraps(func)
    async def wrapped(state):
        started = perf_counter()

        await service_checkpoint_now()

        log_node(
            logging.INFO,
            func.__name__,
            "start",
            state,
        )

        if func.__name__ == "write_report":
            await emit_service_event(
                "report.started",
                {"attempt_id": state.get("attempt_id", "-")},
            )

        try:
            update = func(state)

            if inspect.isawaitable(update):
                update = await update

        except asyncio.CancelledError:
            log_node(
                logging.WARNING,
                func.__name__,
                "cancelled",
                state,
                perf_counter() - started,
            )
            raise

        except Exception as exc:
            log_node(
                logging.ERROR,
                func.__name__,
                "error",
                state,
                perf_counter() - started,
                error=exc,
            )
            raise
        # 当前项目使用覆盖更新，可以这样计算更新后的状态摘要。
        after = {
            **state,
            **update,
        }

        await service_checkpoint_now()

        event_type: str | None = None
        payload: dict = {}
        if func.__name__ == "search":
            event_type = "search.completed"
            payload = {
                "researcher_id": after.get("researcher_id"),
                "search_round": after.get("search_round"),
                "new_sources": len(after.get("latest_sources", [])),
            }
        elif func.__name__ == "extract_findings":
            event_type = "findings.extracted"
            payload = {
                "researcher_id": after.get("researcher_id"),
                "finding_count": len(after.get("findings", [])),
                "gap_count": len(after.get("gaps", [])),
            }
        elif func.__name__ == "review_research":
            event_type = "researcher.reviewed"
            payload = {
                "researcher_id": after.get("researcher_id"),
                "done": after.get("done", False),
                "search_round": after.get("search_round"),
            }
        elif func.__name__ == "compress_research":
            if after.get("compression_used"):
                event_type = "brief.completed"
                payload = {
                    "researcher_id": after.get("researcher_id"),
                    "compression_used": True,
                }
            elif after.get("compression_warning"):
                event_type = "brief.fallback"
                payload = {
                    "researcher_id": after.get("researcher_id"),
                    "compression_used": False,
                    "warning": after.get("compression_warning", "")[:200],
                }
        elif func.__name__ == "supervisor_review":
            event_type = "supervisor.reviewed"
            payload = {
                "done": after.get("done", False),
                "should_stop": after.get("should_stop", False),
                "supervisor_round": after.get("supervisor_round"),
                "gap_count": len(after.get("gaps", [])),
                "topic_count": len(after.get("topics", [])),
            }
        elif func.__name__ == "validate_citations":
            event_type = "citation.checked"
            payload = {"warning_count": len(after.get("citation_warnings", []))}

        if event_type:
            await emit_service_event(event_type, payload)

        limited = after.get("should_stop") is True and after.get("done") is not True

        warned = bool(after.get("citation_warnings"))

        log_node(
            logging.WARNING if limited or warned else logging.INFO,
            func.__name__,
            "end",
            after,
            perf_counter() - started,
        )

        return update

    return wrapped


def error_info(exc: BaseException) -> dict:
    """把异常及其原因转换为可保存到 JSON 的字典。"""

    chain = []
    seen = set()
    current = exc

    while current is not None and id(current) not in seen:
        seen.add(id(current))

        chain.append(
            {
                "type": type(current).__name__,
                "message": str(current),
            }
        )

        if current.__cause__ is not None:
            current = current.__cause__

        elif not current.__suppress_context__:
            current = current.__context__

        else:
            current = None

    return {
        "type": type(exc).__name__,
        "message": str(exc),
        "chain": chain,
    }
