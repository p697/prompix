import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicSpentToday, routedProvider } from "./model-routes.ts";
import { withFallback } from "./models/fallback.ts";
import { ModelProviderError, type ModelErrorCode, type ModelProvider, type ModelRequest } from "./models/types.ts";
import { readConfig, readEvents, updateConfig } from "./pipeline-control.ts";

const request: ModelRequest = { instructions: "Return the color.", input: "The sky is blue.", schema: {}, effort: "low" };
function fake(id: "codex-cli" | "anthropic-api", failure?: ModelErrorCode, calls: ModelRequest[] = []): ModelProvider {
  return { id, kind: "api", model: `${id}-model`, capabilities: { images: true, structuredOutput: "native" }, async complete(sent) {
    calls.push(sent);
    if (failure) throw new ModelProviderError(`${id} failed`, failure);
    return { output: {}, text: "{}", provider: id, model: `${id}-model`, usage: {}, startedAt: "", finishedAt: "" };
  } };
}

test("a route answers from its fallback only when the primary cannot serve", async () => {
  const switches: string[] = [], calls: ModelRequest[] = [];
  const onSwitch = async (code: ModelErrorCode) => { switches.push(code); };
  for (const code of ["unavailable", "rate_limited"] as const) {
    const result = await withFallback(fake("codex-cli", code), () => fake("anthropic-api", undefined, calls), "high", onSwitch).complete(request);
    assert.equal(result.provider, "anthropic-api");
  }
  assert.deepEqual(switches, ["unavailable", "rate_limited"]);
  assert.ok(calls.every(sent => sent.effort === "high"), "the fallback runs at its own effort");
  // A refusal or a bad answer is about the content: no second model sees it.
  for (const code of ["refused", "invalid_output", "failed", "timeout"] as const)
    await assert.rejects(withFallback(fake("codex-cli", code), () => { throw new Error("must not be built"); }, undefined, onSwitch).complete(request),
      error => error instanceof ModelProviderError && error.code === code);
  assert.equal(switches.length, 2);
});

test("a stage whose primary cannot be built starts on its fallback and logs the switch", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "prompix-routes-")), "pipeline");
  await updateConfig(root, "claude-code", undefined, config => ({ ...config, routing: { ...config.routing,
    translate: { provider: "kimi-api", fallback: { provider: "codex-cli", model: "gpt-6.1-terra", effort: "low" } } } }));
  assert.equal((await readConfig(root)).routing.translate.fallback?.model, "gpt-6.1-terra");
  const routed = await routedProvider("translate", "test", root);
  assert.equal(routed.provider.id, "codex-cli");
  assert.equal(routed.effort, "low");
  const event = (await readEvents(root)).find(item => item.type === "route.fallback");
  assert.equal(event?.from, "kimi-api·default");
  assert.equal(event?.to, "codex-cli·gpt-6.1-terra");
  await assert.rejects(updateConfig(root, "claude-code", undefined, config => ({ ...config, routing: { ...config.routing,
    review: { provider: "codex-cli", fallback: { provider: "codex-cli", fallback: { provider: "codex-cli" } } as never } } })));
});

test("an Anthropic route stops serving once today's logged spend reaches the cap", async t => {
  // CI has no key; a placeholder is enough because the cap refuses before any request.
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-placeholder";
  t.after(() => { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; });
  const root = join(await mkdtemp(join(tmpdir(), "prompix-cap-")), "pipeline");
  await updateConfig(root, "codex", undefined, config => ({ ...config, routing: { ...config.routing,
    review: { provider: "anthropic-api", model: "claude-sonnet-5-5" } } }));
  const { appendEvent } = await import("./pipeline-control.ts");
  // 200,000 Sonnet output tokens at $10 per million is $2.
  await appendEvent(root, "claude-code", "model.call", { stage: "review", provider: "anthropic-api", model: "claude-sonnet-5-5", usage: { outputTokens: 200_000 } });
  assert.equal(await anthropicSpentToday(root), 2);
  const { provider } = await routedProvider("review", "test", root);
  await assert.rejects(provider.complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "unavailable" && /\$2/.test(error.message));
});
