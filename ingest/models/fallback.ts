import { ModelProviderError, type Effort, type ModelErrorCode, type ModelProvider, type ModelRequest } from "./types.ts";

/** Errors that mean the route cannot serve right now: not signed in, no model, no credit, or
 * rate limited / out of quota. A refusal or an invalid answer is a verdict on the content and
 * never goes to another model. */
export const fallbackCodes: readonly ModelErrorCode[] = ["unavailable", "rate_limited"];

/** Serves each call from the primary route, and from the fallback when the primary cannot.
 * The fallback is built on first use, so a broken fallback never blocks a working primary. */
export function withFallback(primary: ModelProvider, fallbackProvider: () => ModelProvider, fallbackEffort: Effort | undefined,
  onSwitch: (code: ModelErrorCode, message: string) => Promise<void>): ModelProvider {
  return {
    id: primary.id, kind: primary.kind, model: primary.model, capabilities: primary.capabilities,
    async complete(request: ModelRequest) {
      try {
        return await primary.complete(request);
      } catch (error) {
        if (!(error instanceof ModelProviderError) || !fallbackCodes.includes(error.code)) throw error;
        const fallback = fallbackProvider();
        if (request.images?.length && !fallback.capabilities.images) throw error;
        await onSwitch(error.code, error.message);
        return fallback.complete(fallbackEffort ? { ...request, effort: fallbackEffort } : request);
      }
    },
  };
}
