import { imageDataURL, parseJsonObject, promptedSchemaInstructions, renderUntrustedInput, requireNoImages } from "./prompt.ts";
import { postJson, type Fetch } from "./http.ts";
import { ModelProviderError, type ModelProvider, type ProviderId } from "./types.ts";

export type ChatCompletionsOptions = {
  id: Extract<ProviderId, "kimi-code" | "kimi-api" | "deepseek-api">;
  label: string;
  kind: "subscription" | "api";
  baseURL: string;
  apiKey: string;
  model: string;
  images: boolean;
  fetch?: Fetch;
};

/** OpenAI-compatible chat completions (Kimi Code membership, Moonshot platform, DeepSeek).
 * These routes offer JSON mode rather than schema enforcement, so the schema goes in the
 * prompt and the caller validates the returned object. */
export function chatCompletionsProvider(options: ChatCompletionsOptions): ModelProvider {
  if (!options.apiKey) throw new ModelProviderError(`${options.label} needs an API key`, "unavailable", false);
  const fetcher = options.fetch ?? fetch, endpoint = `${options.baseURL.replace(/\/$/, "")}/chat/completions`;
  return {
    id: options.id, kind: options.kind, model: options.model,
    capabilities: { images: options.images, structuredOutput: "prompted" },
    async complete(request) {
      if (!options.images) requireNoImages(options.label, request.images);
      const startedAt = new Date().toISOString();
      const text = renderUntrustedInput(request.input);
      const content = request.images?.length
        ? [{ type: "text", text }, ...await Promise.all(request.images.map(async image => ({ type: "image_url", image_url: { url: await imageDataURL(image) } })))]
        : text;
      const body = await postJson(fetcher, options.label, endpoint, { Authorization: `Bearer ${options.apiKey}` }, {
        model: options.model, max_tokens: request.maxOutputTokens ?? 16000, response_format: { type: "json_object" }, stream: false,
        messages: [{ role: "system", content: promptedSchemaInstructions(request) }, { role: "user", content }],
      }, request.timeoutMs ?? 300000);
      const choice = body?.choices?.[0];
      if (choice?.finish_reason === "content_filter") throw new ModelProviderError(`${options.label} declined this request`, "refused", false);
      if (choice?.finish_reason === "length") throw new ModelProviderError(`${options.label} stopped at the output limit`, "invalid_output", false);
      const answer = choice?.message?.content;
      if (typeof answer !== "string") throw new ModelProviderError(`${options.label} returned no message content`, "invalid_output", false);
      return { output: parseJsonObject(answer), text: answer, provider: options.id, model: body.model ?? options.model,
        usage: { inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens,
          cachedInputTokens: body.usage?.prompt_cache_hit_tokens ?? body.usage?.prompt_tokens_details?.cached_tokens ?? body.usage?.cached_tokens },
        startedAt, finishedAt: new Date().toISOString() };
    },
  };
}
