import type { ModelUsage } from "./types.ts";

/** Per-million-token list prices for metered models, used only to estimate spend; the provider
 * console holds the real balance. Subscription routes are not metered per call. */
export const modelPrices: Record<string, { input: number; output: number; cachedInput: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.2 }, "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cachedInput: 0.01 },
};

/** Estimated USD for one call; 0 for a model without a list price. */
export function estimateUSD(model: string, usage: ModelUsage = {}): number {
  const price = modelPrices[model];
  return price ? ((usage.inputTokens ?? 0) * price.input + (usage.outputTokens ?? 0) * price.output + (usage.cachedInputTokens ?? 0) * price.cachedInput) / 1e6 : 0;
}
