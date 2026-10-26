"""配置、项目路径和模型客户端；不在导入时发起请求。"""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values, load_dotenv
from langchain_openai import ChatOpenAI

PROJECT_DIR = Path(__file__).resolve().parents[1]
OUTPUT_DIR = PROJECT_DIR / "outputs"


@dataclass(frozen=True)
class Settings:
    model_name: str
    max_search_rounds: int
    max_results_per_query: int
    openai_api_key: str | None
    tavily_api_key: str | None
    base_url: str | None
    # 最多同时运行多少个 Researcher。
    max_concurrent_researchers: int = 2
    # 整理研究简报供 Supervisor 阅读；不承诺输入更短。
    enable_research_compression: bool = False


def load_settings() -> Settings:
    load_dotenv(PROJECT_DIR / ".env")

    compression_value = (
        os.getenv(
            "ENABLE_RESEARCH_COMPRESSION",
            "false",
        )
        .strip()
        .lower()
    )

    if compression_value not in {"true", "false"}:
        raise ValueError("ENABLE_RESEARCH_COMPRESSION 只能是 true 或 false")

    enable_research_compression = compression_value == "true"

    return Settings(
        model_name=os.getenv("MODEL_NAME", "deepseek-v4-pro"),
        max_search_rounds=int(os.getenv("MAX_SEARCH_ROUNDS", 2)),
        max_results_per_query=int(os.getenv("MAX_RESULTS_PER_QUERY", 5)),
        openai_api_key=os.getenv("OPENAI_API_KEY") or None,
        tavily_api_key=os.getenv("TAVILY_API_KEY") or None,
        base_url=os.getenv("OPENAI_API_BASE_URL") or None,
        max_concurrent_researchers=int(os.getenv("MAX_CONCURRENT_RESEARCHERS", "2")),
        enable_research_compression=enable_research_compression,
    )


class ConfigUnavailable(ValueError):
    """冻结配置引用了当前服务无法提供的模型配置档。"""


def resolve_model_settings(model_name: str, model_profile: str) -> tuple[str, str]:
    # 配置档由服务端维护；任务只能引用名称，不能提供地址或密钥。
    if model_profile != "deepseek-default-v1":
        raise ConfigUnavailable("CONFIG_UNAVAILABLE")
    settings = load_settings()
    if not model_name or not settings.openai_api_key:
        raise ConfigUnavailable("CONFIG_UNAVAILABLE")
    return settings.openai_api_key, settings.base_url or "https://api.deepseek.com"


def create_model(
    *,
    model_name: str | None = None,
    model_profile: str | None = None,
) -> ChatOpenAI:
    settings = load_settings()
    if model_profile is not None:
        if model_name is None:
            raise ConfigUnavailable("CONFIG_UNAVAILABLE")
        api_key, base_url = resolve_model_settings(model_name, model_profile)
    elif model_name is not None:
        raise ConfigUnavailable("CONFIG_UNAVAILABLE")
    else:
        api_key, base_url = settings.openai_api_key, settings.base_url
    if not api_key:
        raise ValueError("请在.env文件中配置模型api秘钥")

    return ChatOpenAI(
        model=model_name or settings.model_name,
        api_key=api_key,
        base_url=base_url,
        temperature=0.0,
        timeout=60.0,
        max_retries=1,
        max_tokens=4096,
        extra_body={"thinking": {"type": "disabled"}},
    )


@dataclass(frozen=True)
class WorkerSettings:
    database_url: str
    redis_url: str
    heartbeat_seconds: float = 10
    lease_seconds: int = 60
    poll_seconds: float = 1
    maintenance_seconds: float = 10
    outbox_claim_seconds: int = 30
    reconcile_after_seconds: int = 60
    stale_queue_seconds: int = 300

    def __post_init__(self):
        if not self.database_url or not self.redis_url:
            raise ValueError("Worker 需要 DATABASE_URL 和 REDIS_URL")
        if not 0 < self.heartbeat_seconds < self.lease_seconds / 2:
            raise ValueError("心跳间隔必须小于租约的一半")
        if (
            min(
                self.poll_seconds,
                self.maintenance_seconds,
                self.outbox_claim_seconds,
                self.reconcile_after_seconds,
                self.stale_queue_seconds,
            )
            <= 0
        ):
            raise ValueError("Worker 间隔必须为正数")


def load_worker_settings() -> WorkerSettings:
    """仅启动 Worker 时读取；CLI 不依赖数据库。环境变量优先于文件。"""
    load_dotenv(PROJECT_DIR / ".env")
    # 本地复用 Web 的连接地址；OAuth 配置不会进入 Worker 的设置或图状态。
    web = dotenv_values(PROJECT_DIR / "web" / ".env.local")
    return WorkerSettings(
        database_url=os.getenv("DATABASE_URL") or web.get("DATABASE_URL") or "",
        redis_url=os.getenv("REDIS_URL") or web.get("REDIS_URL") or "",
        heartbeat_seconds=float(os.getenv("WORKER_HEARTBEAT_SECONDS", "10")),
        lease_seconds=int(os.getenv("WORKER_LEASE_SECONDS", "60")),
        reconcile_after_seconds=int(os.getenv("WORKER_RECONCILE_AFTER_SECONDS", "60")),
        stale_queue_seconds=int(os.getenv("WORKER_STALE_QUEUE_SECONDS", "300")),
    )
