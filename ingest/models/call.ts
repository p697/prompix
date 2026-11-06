import type { z } from "zod";
import { ModelProviderError, type ModelErrorCode, type ModelProvider, type ModelRequest, type ModelResult, type ModelUsage, type ProviderId } from "./types.ts";

/** What the control-plane log keeps about a call: timing, tokens, outcome. Never prompts or outputs. */
export type ModelCallSummary = { stage: string; provider: ProviderId; model: string; ok: boolean; durationMs: number;
  usage?: ModelUsage; error?: ModelErrorCode; images: number };

/** One call, validated against the stage's own schema. A provider that enforces the schema
 * natively is still checked here, so every route fails closed the same way. */
export async function completeValidated<T>(provider: ModelProvider, stage: string, request: ModelRequest, schema: z.ZodType<T>,
  record?: (summary: ModelCallSummary) => Promise<void>): Promise<{ value: T; result: ModelResult }> {
  const started = Date.now();
  const summary = (ok: boolean, usage?: ModelUsage, error?: ModelErrorCode): ModelCallSummary =>
    ({ stage, provider: provider.id, model: provider.model, ok, durationMs: Date.now() - started, usage, error, images: request.images?.length ?? 0 });
  let result: ModelResult;
  try {
    if (request.images?.length && !provider.capabilities.images) throw new ModelProviderError(`${provider.id} does not accept images`, "unsupported", false);
    result = await provider.complete(request);
  } catch (error) {
    const code = error instanceof ModelProviderError ? error.code : "failed";
    await record?.(summary(false, undefined, code));
    throw error;
  }
  const parsed = schema.safeParse(result.output);
  if (!parsed.success) {
    await record?.(summary(false, result.usage, "invalid_output"));
    throw new ModelProviderError(`${provider.id} output did not match the ${stage} schema`, "invalid_output", false);
  }
  await record?.(summary(true, result.usage));
  return { value: parsed.data, result };
}
