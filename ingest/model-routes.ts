import { appendEvent, pipelineRoot, readConfig, type PipelineStage } from "./pipeline-control.ts";
import type { ModelCallSummary } from "./models/call.ts";
import { fallbackCodes, withFallback } from "./models/fallback.ts";
import { createProvider, modelEnvironment } from "./models/registry.ts";
import { ModelProviderError } from "./models/types.ts";

/** The provider a stage is routed to in the pipeline config (`npm run pipeline -- route`), with
 * every call summarized in the pipeline log. Read per run, so a route change needs no restart.
 * A stage with a fallback route switches to it whenever the primary cannot serve, and logs why. */
export async function routedProvider(stage: PipelineStage, task: string, root = pipelineRoot()) {
  const route = (await readConfig(root)).routing[stage], env = (await modelEnvironment()).env;
  const record = (summary: ModelCallSummary) => appendEvent(root, "pipeline", "model.call", { ...summary, task }).then(() => undefined);
  const backup = route.fallback;
  const switched = (code: string, message: string) => appendEvent(root, "pipeline", "route.fallback", { stage, task,
    from: `${route.provider}·${route.model ?? "default"}`, to: `${backup!.provider}·${backup!.model ?? "default"}`, code, message: message.slice(0, 200) }).then(() => undefined);
  let primary;
  try {
    primary = createProvider(route.provider, route.model, env);
  } catch (error) {
    if (!backup || !(error instanceof ModelProviderError) || !fallbackCodes.includes(error.code)) throw error;
    await switched(error.code, error.message);
    return { provider: createProvider(backup.provider, backup.model, env), effort: backup.effort, record };
  }
  const provider = backup ? withFallback(primary, () => createProvider(backup.provider, backup.model, env), backup.effort, switched) : primary;
  return { provider, effort: route.effort, record };
}
