import { imageDataURL, parseJsonObject, renderUntrustedInput, schemaName } from "./prompt.ts";
import { postJson, type Fetch } from "./http.ts";
import { ModelProviderError, type ModelProvider } from "./types.ts";

export type OpenAIResponsesOptions = { apiKey: string; model: string; baseURL?: string; fetch?: Fetch };

/** OpenAI metered API through the Responses endpoint with strict JSON Schema output. Nothing is stored. */
export function openAIResponsesProvider(options: OpenAIResponsesOptions): ModelProvider {
  if (!options.apiKey) throw new ModelProviderError("OpenAI API needs an API key", "unavailable", false);
  const fetcher = options.fetch ?? fetch, endpoint = `${(options.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
  return {
    id: "openai-api", kind: "api", model: options.model,
    capabilities: { images: true, structuredOutput: "native" },
    async complete(request) {
      const startedAt = new Date().toISOString();
      const content = [{ type: "input_text", text: renderUntrustedInput(request.input) },
        ...await Promise.all((request.images ?? []).map(async image => ({ type: "input_image", image_url: await imageDataURL(image) })))];
      const body = await postJson(fetcher, "OpenAI API", endpoint, { Authorization: `Bearer ${options.apiKey}` }, {
        model: options.model, store: false, instructions: request.instructions, max_output_tokens: request.maxOutputTokens ?? 16000,
        ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
        input: [{ role: "user", content }],
        text: { format: { type: "json_schema", name: schemaName(request), strict: true, schema: request.schema } },
      }, request.timeoutMs ?? 300000);
      const parts = (body?.output ?? []).flatMap((item: { content?: { type: string; text?: string; refusal?: string }[] }) => item.content ?? []);
      if (parts.some((part: { type: string }) => part.type === "refusal")) throw new ModelProviderError("OpenAI declined this request", "refused", false);
      if (body?.status !== "completed") throw new ModelProviderError(`OpenAI response ${body?.status ?? "missing status"}`, "invalid_output", false);
      const text = parts.filter((part: { type: string }) => part.type === "output_text").map((part: { text?: string }) => part.text ?? "").join("");
      return { output: parseJsonObject(text), text, provider: "openai-api", model: body.model ?? options.model,
        usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens, cachedInputTokens: body.usage?.input_tokens_details?.cached_tokens },
        startedAt, finishedAt: new Date().toISOString() };
    },
  };
}
