"""日志初始化、节点计时和异常链；导入模块不会创建日志文件。"""

import asyncio
import inspect
import logging
from functools import wraps
from time import perf_counter

from .config import OUTPUT_DIR

logger = logging.getLogger("mini_deep_research")


def setup_logging() -> None:
    """在程序入口调用，配置终端和文件日志。"""
    
    # 防止多次调用时重复添加输出器。
    if logger.handlers:
        return
    
    logger.setLevel("INFO")
    logger.propagate = False

    formatter =logging.Formatter(
        "%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    console = logging.StreamHandler()
    file = logging.FileHandler(
        OUTPUT_DIR / "research.log",
        encoding="utf-8",
    )

    for handler in (console,file):
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

        log_node(
            logging.INFO,
            func.__name__,
            "start",
            state,
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
                perf_counter()-started,
            )
            raise

        except Exception as exc:
            log_node(
                logging.ERROR,
                func.__name__,
                "error",
                state,
                perf_counter()-started,
                error=exc,
            )
            raise
        # 当前项目使用覆盖更新，可以这样计算更新后的状态摘要。
        after = {
            **state,
            **update,
        }    

        limited = (
            after.get("should_stop") is True
            and after.get("done") is not True
        )

        warned = bool(after.get("citation_warnings"))

        log_node(
            logging.WARNING if limited or warned else logging.INFO,
            func.__name__,
            "end",
            after,
            perf_counter()-started,
        )

        return update

    return wrapped

def error_info(exc: BaseException) -> dict:
    """把异常及其原因转换为可保存到 JSON 的字典。"""

    chain = []
    seen = set()
    current = exc

    while (
        current is not None
        and id(current) not in seen
    ):
        seen.add(id(current))

        chain.append({
            "type": type(current).__name__,
            "message": str(current),
        })

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
