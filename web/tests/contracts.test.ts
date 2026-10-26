import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  createResearchSchema,
  researchConfigSchema,
  researchJobSchema,
} from "../lib/contracts";
import { buildResearchConfig } from "../lib/server/research-config";

const root = new URL("../../contracts/", import.meta.url);
const models = {
  "create-research": createResearchSchema,
  "research-config": researchConfigSchema,
  "research-job": researchJobSchema,
};
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const schemas = Object.fromEntries(
  Object.keys(models).map((name) => [
    name,
    ajv.compile(
      JSON.parse(readFileSync(new URL(`${name}.v1.schema.json`, root), "utf8")),
    ),
  ]),
);
const fixtures: {
  contract: keyof typeof models;
  name: string;
  input: unknown;
  valid: boolean;
  normalized?: unknown;
}[] = JSON.parse(readFileSync(new URL("fixtures.json", root), "utf8"));

for (const fixture of fixtures)
  test(`${fixture.contract}: ${fixture.name}`, () => {
    const parsed = models[fixture.contract].safeParse(fixture.input);
    assert.equal(parsed.success, fixture.valid);
    if (parsed.success) {
      assert.equal(
        schemas[fixture.contract](parsed.data),
        true,
        JSON.stringify(schemas[fixture.contract].errors),
      );
      if (fixture.normalized) assert.deepEqual(parsed.data, fixture.normalized);
    } else {
      assert.equal(schemas[fixture.contract](fixture.input), false);
    }
  });

test("depth selects a bounded, frozen server profile without credentials", () => {
  const quick = buildResearchConfig("quick");
  const standard = buildResearchConfig("standard");
  assert.equal(quick.max_search_rounds, 1);
  assert.equal(quick.total_timeout_seconds, 300);
  assert.equal(standard.max_search_rounds, 2);
  assert.equal(standard.total_timeout_seconds, 600);
  assert.equal(Object.isFrozen(quick), true);
  assert.equal("api_key" in quick, false);
  assert.equal("base_url" in quick, false);
});
