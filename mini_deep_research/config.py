"""配置、项目路径和模型客户端；不在导入时发起请求。"""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI

PROJECT_DIR = Path(__file__).resolve().parents[1]
OUTPUT_DIR = PROJECT_DIR / "outputs"


@dataclass(frozen=True)
class Settings:
    model_name:str
    max_search_rounds:int
    max_results_per_query:int
    openai_api_key:str|None
    tavily_api_key:str|None
    base_url:str|None

def load_settings() -> Settings:
    load_dotenv(PROJECT_DIR / ".env")

    return Settings(
        model_name=os.getenv("MODEL_NAME", "deepseek-v4-pro"),
        max_search_rounds =int(os.getenv("MAX_SEARCH_ROUNDS", 2)),
        max_results_per_query =int(os.getenv("MAX_RESULTS_PER_QUERY", 5)),
        openai_api_key=os.getenv("OPENAI_API_KEY") or None,
        tavily_api_key=os.getenv("TAVILY_API_KEY") or None,
        base_url=os.getenv("OPENAI_API_BASE_URL") or None,
    )

def create_model() -> ChatOpenAI:
    settings = load_settings()

    if not settings.openai_api_key:
        raise ValueError("请在.env文件中配置模型api秘钥")
    
    return ChatOpenAI(
        model=settings.model_name,
        api_key=settings.openai_api_key,
        base_url=settings.base_url,
        temperature=0.0,
        timeout=60.0,
        max_retries=1,
        max_tokens=4096,
        extra_body={"thinking":{"type":"disabled"}},
    )
