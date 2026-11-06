import { appendEvent, pipelineRoot, readConfig, type PipelineStage } from "./pipeline-control.ts";
import type { ModelCallSummary } from "./models/call.ts";
import { createProvider, modelEnvironment } from "./models/registry.ts";

/** The provider a stage is routed to in the pipeline config (`npm run pipeline -- route`), with
 * every call summarized in the pipeline log. Read per run, so a route change needs no restart. */
export async function routedProvider(stage: PipelineStage, task: string, root = pipelineRoot()) {
  const route = (await readConfig(root)).routing[stage];
  const provider = createProvider(route.provider, route.model, (await modelEnvironment()).env);
  const record = (summary: ModelCallSummary) => appendEvent(root, "pipeline", "model.call", { ...summary, task }).then(() => undefined);
  return { provider, effort: route.effort, record };
}
