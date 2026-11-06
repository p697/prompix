import Anthropic from "@anthropic-ai/sdk";
import { imageBase64, parseJsonObject, renderUntrustedInput } from "./prompt.ts";
import { ModelProviderError, type ModelProvider } from "./types.ts";

type MessagesClient = { messages: { create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { timeout?: number }): Promise<Anthropic.Message> } };
export type AnthropicAPIOptions = { apiKey: string; model: string; client?: MessagesClient };

/** Anthropic metered API with JSON Schema output. A refusal is reported, not retried on
 * another model: in a safety review it must send the item to a person. */
export function anthropicAPIProvider(options: AnthropicAPIOptions): ModelProvider {
  if (!options.apiKey && !options.client) throw new ModelProviderError("Anthropic API needs an API key", "unavailable", false);
  const client: MessagesClient = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 2 });
  return {
    id: "anthropic-api", kind: "api", model: options.model,
    capabilities: { images: true, structuredOutput: "native" },
    async complete(request) {
      const startedAt = new Date().toISOString();
      const images = await Promise.all((request.images ?? []).map(async image => ({ type: "image" as const,
        source: { type: "base64" as const, media_type: image.mediaType, data: await imageBase64(image) } })));
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: options.model, max_tokens: request.maxOutputTokens ?? 16000, system: request.instructions,
          messages: [{ role: "user", content: [...images, { type: "text", text: renderUntrustedInput(request.input) }] }],
          output_config: { format: { type: "json_schema", schema: request.schema }, ...(request.effort ? { effort: request.effort } : {}) },
        }, { timeout: request.timeoutMs ?? 300000 });
      } catch (error) {
        throw anthropicFailure(error);
      }
      if (message.stop_reason === "refusal") throw new ModelProviderError("Claude declined this request", "refused", false);
      if (message.stop_reason === "max_tokens") throw new ModelProviderError("Claude stopped at the output limit", "invalid_output", false);
      const text = message.content.filter(block => block.type === "text").map(block => block.text).join("");
      return { output: parseJsonObject(text), text, provider: "anthropic-api", model: message.model,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, cachedInputTokens: message.usage.cache_read_input_tokens ?? undefined },
        startedAt, finishedAt: new Date().toISOString() };
    },
  };
}

function anthropicFailure(error: unknown): ModelProviderError {
  if (error instanceof Anthropic.RateLimitError) return new ModelProviderError("Anthropic API is rate limited", "rate_limited");
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return new ModelProviderError("Anthropic API rejected the credentials", "unavailable", false);
  if (error instanceof Anthropic.NotFoundError) return new ModelProviderError("Anthropic API does not offer the requested model", "unavailable", false);
  if (error instanceof Anthropic.BadRequestError) return new ModelProviderError("Anthropic API rejected the request", "failed", false);
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ModelProviderError("Anthropic API timed out", "timeout");
  if (error instanceof Anthropic.APIError) return new ModelProviderError("Anthropic API request failed", "failed");
  return new ModelProviderError("Anthropic API request failed", "failed");
}
