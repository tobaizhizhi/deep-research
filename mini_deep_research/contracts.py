"""Web / Worker 的传输契约；不与图状态、LLM 输出模型混用。"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator


def json_integer(value: object) -> int:
    # JSON 的 1 与 1.0 同为整数值；拒绝 True 和 "1"，与 JS / JSON Schema 一致。
    if type(value) is int:
        return value
    if type(value) is float and value.is_integer():
        return int(value)
    raise ValueError("expected a JSON integer")


JsonInt = Annotated[int, BeforeValidator(json_integer)]
Version = Annotated[Literal[1], BeforeValidator(json_integer)]
Label = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$")]
UUIDText = Annotated[str, Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class CreateResearchInput(Contract):
    question: str = Field(min_length=1, max_length=4000)
    requirements: str = Field(default="", max_length=2000)
    language: Literal["auto", "zh", "en"] = "auto"
    depth: Literal["quick", "standard"] = "standard"

    @field_validator("question", "requirements", mode="before")
    @classmethod
    def trim_input(cls, value: object) -> object:
        if isinstance(value, str) and "\x00" in value:
            raise ValueError("text cannot contain NUL")
        return value.strip(" \t\n\r\f\v") if isinstance(value, str) else value


class ResearchConfig(Contract):
    schema_version: Version
    graph_mode: Literal["fixed"]
    model_name: Label
    model_profile: Label
    code_version: Label
    prompt_version: Label
    max_search_rounds: JsonInt = Field(ge=1, le=5)
    max_supervisor_rounds: JsonInt = Field(ge=1, le=5)
    max_concurrent_researchers: JsonInt = Field(ge=1, le=4)
    max_results_per_query: JsonInt = Field(ge=1, le=10)
    total_timeout_seconds: JsonInt = Field(ge=30, le=1800)
    enable_research_compression: bool


class ResearchJob(Contract):
    schema_version: Version
    message_id: UUIDText
    type: Literal["research.run"]
    task_id: UUIDText
    attempt_id: UUIDText
    created_at: str = Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$")

    @field_validator("created_at")
    @classmethod
    def valid_timestamp(cls, value: str) -> str:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value


RESEARCH_STREAM = "research:jobs:v1"
RESEARCH_CONSUMER_GROUP = "research-workers-v1"
