import { appendEvent, pipelineRoot, readConfig, readEvents, type PipelineStage } from "./pipeline-control.ts";
import type { ModelCallSummary } from "./models/call.ts";
import { estimateUSD } from "./models/pricing.ts";
import { fallbackCodes, withFallback } from "./models/fallback.ts";
import { createProvider, modelEnvironment } from "./models/registry.ts";
import { ModelProviderError, type ModelProvider, type ModelUsage } from "./models/types.ts";

/** The owner's hard ceiling on metered Anthropic spend per UTC day, across every pipeline route. */
export const anthropicDailyCapUSD = 2;

/** Estimated Anthropic spend logged today, by any actor. */
export async function anthropicSpentToday(root = pipelineRoot(), now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return (await readEvents(root, Number.MAX_SAFE_INTEGER)).filter(event => event.type === "model.call" && event.provider === "anthropic-api" && event.at.startsWith(day))
    .reduce((sum, event) => sum + estimateUSD(String(event.model), event.usage as ModelUsage | undefined), 0);
}

/** Past the ceiling an Anthropic route reports itself unavailable: the stage stops (or another
 * fallback serves) and the daily report says so. Spend is tracked from each call's summary. */
function capped(provider: ModelProvider, spent: { usd: number }): ModelProvider {
  if (provider.id !== "anthropic-api") return provider;
  return { ...provider, async complete(request) {
    if (spent.usd >= anthropicDailyCapUSD)
      throw new ModelProviderError(`今天的 Anthropic API 花费已达 $${anthropicDailyCapUSD} 上限`, "unavailable", false);
    return provider.complete(request);
  } };
}

/** The provider a stage is routed to in the pipeline config (`npm run pipeline -- route`), with
 * every call summarized in the pipeline log. Read per run, so a route change needs no restart.
 * A stage with a fallback route switches to it whenever the primary cannot serve, and logs why. */
export async function routedProvider(stage: PipelineStage, task: string, root = pipelineRoot()) {
  const route = (await readConfig(root)).routing[stage], env = (await modelEnvironment()).env;
  const spent = { usd: await anthropicSpentToday(root) };
  const record = (summary: ModelCallSummary) => {
    if (summary.provider === "anthropic-api") spent.usd += estimateUSD(summary.model, summary.usage);
    return appendEvent(root, "pipeline", "model.call", { ...summary, task }).then(() => undefined);
  };
  const build = (id: Parameters<typeof createProvider>[0], model?: string) => capped(createProvider(id, model, env), spent);
  const backup = route.fallback;
  const switched = (code: string, message: string) => appendEvent(root, "pipeline", "route.fallback", { stage, task,
    from: `${route.provider}·${route.model ?? "default"}`, to: `${backup!.provider}·${backup!.model ?? "default"}`, code, message: message.slice(0, 200) }).then(() => undefined);
  let primary;
  try {
    primary = build(route.provider, route.model);
  } catch (error) {
    if (!backup || !(error instanceof ModelProviderError) || !fallbackCodes.includes(error.code)) throw error;
    await switched(error.code, error.message);
    return { provider: build(backup.provider, backup.model), effort: backup.effort, record };
  }
  const provider = backup ? withFallback(primary, () => build(backup.provider, backup.model), backup.effort, switched) : primary;
  return { provider, effort: route.effort, record };
}
