import assert from "node:assert/strict";
import test from "node:test";
import { creatorRules, laneShares, ruleQuery, ruleQuotas, xSearchRules } from "./x-search-rules.ts";

test("every lane has rules of both kinds and the lane shares cover the whole day", () => {
  assert.equal(Object.values(laneShares).reduce((sum, share) => sum + share, 0).toFixed(6), "1.000000");
  for (const lane of Object.keys(laneShares).filter(lane => lane !== "creator"))
    for (const kind of ["image", "video"])
      assert.ok(xSearchRules.some(rule => rule.lane === lane && rule.kind === kind), `${lane} has a ${kind} rule`);
  assert.equal(new Set(xSearchRules.map(rule => rule.id)).size, xSearchRules.length);
});

test("rules that returned no usable prompt on a measured day are gone, and craft words are searched", () => {
  for (const model of ["flux", "seedream", "ideogram", "veo", "kling", "hailuo", "runway", "wan"])
    assert.ok(!xSearchRules.some(rule => rule.id === `model-${model}`), model);
  assert.ok(xSearchRules.some(rule => rule.id === "model-grok-image") && xSearchRules.some(rule => rule.id === "model-grok-video"));
  const craft = xSearchRules.filter(rule => rule.lane === "craft").map(rule => rule.terms).join(" ");
  for (const word of ["cinematic", "lighting", "composition", "构图", "縦長"]) assert.ok(craft.includes(word), word);
});

test("a leading dash inside a term is quoted, so X does not read it as an exclusion", () => {
  for (const rule of xSearchRules) assert.ok(!/(^|[\s(])-(?!is:)[\w-]/.test(rule.terms), rule.id);
});

test("every query, including a full creator group, stays within the TwitterAPI query limit", () => {
  const creators = Array.from({ length: 48 }, (_, index) => `creator_name_${String(index).padStart(2, "0")}`);
  for (const rule of xSearchRules) assert.ok(ruleQuery(rule, 1794000000, 1794086400).length <= 1500, rule.id);
  for (const { rule, creators: group } of creatorRules(creators)) assert.ok(ruleQuery(rule, 1794000000, 1794086400, group).length <= 1500);
});

test("the craft lane gets a fifth of the day and exploration a twentieth", () => {
  const quotas = ruleQuotas(xSearchRules, 300);
  const lane = (name: string) => xSearchRules.filter(rule => rule.lane === name).reduce((sum, rule) => sum + quotas.get(rule.id)!, 0);
  assert.ok(Math.abs(lane("craft") - 60) <= 4, `craft ${lane("craft")}`);
  assert.ok(Math.abs(lane("explore") - 15) <= 2, `explore ${lane("explore")}`);
});
