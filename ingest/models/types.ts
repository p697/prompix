/** A model provider turns one trusted instruction plus untrusted source data into
 * schema-shaped JSON. Pipeline stages depend only on this contract, so the vendor,
 * model and billing route (local subscription CLI or metered API) stay configuration. */

export const providerIds = ["codex-cli", "claude-cli", "kimi-code", "kimi-api", "deepseek-api", "openai-api", "anthropic-api"] as const;
export type ProviderId = typeof providerIds[number];
export type ProviderKind = "subscription" | "api";
export type Effort = "low" | "medium" | "high";
export type JsonSchema = Record<string, unknown>;
export type ModelImage = { path: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };

export type ModelRequest = {
  /** Trusted operator instructions. Never interpolate source text here. */
  instructions: string;
  /** Untrusted source data; providers wrap it as data before sending. */
  input: string;
  /** JSON Schema for the single object the model must return. */
  schema: JsonSchema;
  schemaName?: string;
  images?: readonly ModelImage[];
  effort?: Effort;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export type ModelUsage = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };

export type ModelResult = {
  output: unknown;
  text: string;
  provider: ProviderId;
  model: string;
  usage: ModelUsage;
  startedAt: string;
  finishedAt: string;
};

export type ProviderCapabilities = {
  images: boolean;
  /** native: the vendor enforces the schema; prompted: the schema is in the prompt and the caller validates. */
  structuredOutput: "native" | "prompted";
};

export interface ModelProvider {
  readonly id: ProviderId;
  readonly kind: ProviderKind;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: ModelRequest): Promise<ModelResult>;
}

export type ModelErrorCode = "unavailable" | "rate_limited" | "refused" | "invalid_output" | "timeout" | "unsupported" | "failed";

/** Retryable errors may succeed later on the same provider; the rest need a new route or a person. */
export class ModelProviderError extends Error {
  constructor(message: string, readonly code: ModelErrorCode, readonly retryable = code === "rate_limited" || code === "timeout" || code === "failed") {
    super(message);
    this.name = "ModelProviderError";
  }
}
