FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.12.15 /uv /uvx /bin/
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev
COPY mini_deep_research ./mini_deep_research
COPY contracts ./contracts

USER 65532:65532
CMD ["/app/.venv/bin/python", "-m", "mini_deep_research.worker"]
