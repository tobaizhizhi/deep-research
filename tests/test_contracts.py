"""与 Web 测试使用相同样例；不调用模型、搜索或数据库。"""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from mini_deep_research.contracts import CreateResearchInput, ResearchConfig, ResearchJob

FIXTURES = json.loads((Path(__file__).parents[1] / "contracts/fixtures.json").read_text())
MODELS = {"create-research": CreateResearchInput, "research-config": ResearchConfig, "research-job": ResearchJob}


@pytest.mark.parametrize("case", FIXTURES, ids=lambda case: f"{case['contract']}:{case['name']}")
def test_shared_contract(case):
    model = MODELS[case["contract"]]
    if case["valid"]:
        result = model.model_validate(case["input"])
        if "normalized" in case:
            assert result.model_dump(mode="json") == case["normalized"]
    else:
        with pytest.raises(ValidationError):
            model.model_validate(case["input"])


def test_json_integral_number_is_allowed_but_boolean_is_not():
    # Python json.loads 保留 2.0 为 float，JS JSON.parse 不区分 2 与 2.0。
    data = next(case["input"] for case in FIXTURES if case["contract"] == "research-config" and case["valid"]).copy()
    data["max_search_rounds"] = 2.0
    assert ResearchConfig.model_validate(data).max_search_rounds == 2
    data["max_search_rounds"] = True
    with pytest.raises(ValidationError):
        ResearchConfig.model_validate(data)
