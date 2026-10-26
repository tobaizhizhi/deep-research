"""Tavily 搜索适配器，以及搜索查询的清理和去重。"""

import asyncio
from datetime import datetime, timezone
from hashlib import sha256

from tavily import AsyncTavilyClient

from .config import load_settings
from .models import SearchResult


class SearchError(RuntimeError):
    """搜索服务失败；Worker 对外只公开稳定错误码。"""


async def search_web(
    queries: list[str],
    *,
    max_results: int = 5,
    timeout: float = 30.0,
) -> list[SearchResult]:
    """调用 Tavily 搜索，整理结果并按 URL 去重。"""

    # 1. 检查输入参数。
    if not 1 <= max_results <= 20:
        raise ValueError("max_results 必须在 1 到 20 之间")
    if timeout <= 0:
        raise ValueError("timeout 必须大于 0")

    # 去除首尾空格，跳过空查询。
    queries = [query.strip() for query in queries if query.strip()]

    if not queries:
        return []

    # 2. 读取搜索服务的密钥。
    settings = load_settings()

    if not (settings.tavily_api_key):
        raise ValueError("请在.env中配置 TAVILY_API_KEY 环境变量")
    # 3. 并发执行多条搜索查询。
    async with AsyncTavilyClient(
        api_key=settings.tavily_api_key,
    ) as client:
        responses = await asyncio.gather(
            *[
                client.search(
                    query=query,
                    max_results=max_results,
                    search_depth="basic",
                    include_raw_content=True,
                    timeout=timeout,
                )
                for query in queries
            ],
            return_exceptions=True,
        )
    # 4. 检查是否有查询失败。
    for query, response in zip(queries, responses):
        if isinstance(response, Exception):
            raise SearchError(
                f"Tavily 搜索失败，查询：{query!r}{type(response).__name__}"
            ) from response

    # 5. 整理结果，并以 URL 为键去重。
    unique: dict[str, SearchResult] = {}
    for response in responses:
        for item in response["results"]:
            url = (item.get("url") or "").strip()
            if not url or url in unique:
                continue

            snippet = item.get("content") or ""
            content = item.get("raw_content") or snippet

            unique[url] = SearchResult(
                title=(item.get("title") or "").strip() or url,
                url=url,
                snippet=snippet,
                content=content,
                fetched_at=datetime.now(timezone.utc),
                content_hash=sha256(content.encode("utf-8")).hexdigest(),
                content_source="raw_content" if item.get("raw_content") else "snippet",
            )
    return list(unique.values())


def select_new_queries(
    candidates: list[str],
    searched_queries: list[str],
) -> list[str]:
    """过滤空查询和已经执行过的查询，每轮最多保留 3 条。"""

    searched = {" ".join(query.split()).casefold() for query in searched_queries}

    selected = []

    for query in candidates:
        cleaned = " ".join(query.split())
        normalized = cleaned.casefold()

        if not cleaned or normalized in searched:
            continue

        selected.append(cleaned)
        searched.add(normalized)

        if len(selected) >= 3:
            break

    return selected
