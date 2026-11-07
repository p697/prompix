import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageBase64, renderUntrustedInput } from "./prompt.ts";
import { classifyCliFailure, runProcess, type RunProcess } from "./process.ts";
import { ModelProviderError, type ModelProvider } from "./types.ts";

export type ClaudeCliOptions = { model: string; executable?: string; run?: RunProcess };

/** Claude Code local subscription. Every built-in tool, MCP server, skill and saved session is off,
 * so the model can only read the message it is given and answer in the requested schema. */
export function claudeCliProvider(options: ClaudeCliOptions): ModelProvider {
  const executable = options.executable ?? "claude", run = options.run ?? runProcess;
  return {
    id: "claude-cli", kind: "subscription", model: options.model,
    capabilities: { images: true, structuredOutput: "native" },
    async complete(request) {
      const startedAt = new Date().toISOString();
      const directory = await mkdtemp(join(tmpdir(), "prompix-claude-"));
      try {
        const content = [
          ...await Promise.all((request.images ?? []).map(async image => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: await imageBase64(image) } }))),
          { type: "text", text: renderUntrustedInput(request.input) },
        ];
        const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
          "--json-schema", JSON.stringify(request.schema), "--model", options.model, "--system-prompt", request.instructions,
          "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--permission-mode", "dontAsk",
          ...(request.effort ? ["--effort", request.effort] : [])];
        const result = await run(executable, args, { stdin: JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n", cwd: directory,
          timeoutMs: request.timeoutMs ?? 300000, maxStdoutBytes: 8_000_000, env: subscriptionEnvironment(process.env) });
        const final = lastResult(result.stdout);
        if (!final) throw classifyCliFailure("Claude Code", result.exitCode, result.stderrTail);
        if (final.is_error) throw classifyCliFailure("Claude Code", result.exitCode, `${final.result ?? ""} ${final.api_error_status ?? ""} ${result.stderrTail}`);
        if (final.stop_reason === "refusal") throw new ModelProviderError("Claude declined this request", "refused", false);
        if (!final.structured_output || typeof final.structured_output !== "object") throw new ModelProviderError("Claude Code returned no structured output", "invalid_output", false);
        const usage = final.usage ?? {};
        return { output: final.structured_output, text: JSON.stringify(final.structured_output), provider: "claude-cli", model: options.model,
          usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cachedInputTokens: usage.cache_read_input_tokens },
          startedAt, finishedAt: new Date().toISOString() };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

/** Claude Code bills an API key in place of the signed-in subscription, outside the Anthropic
 * daily cap, so the pipeline's key never reaches the CLI. */
export function subscriptionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  return rest;
}

type ResultEvent = { type: "result"; is_error?: boolean; result?: string; api_error_status?: unknown; stop_reason?: string;
  structured_output?: unknown; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };

function lastResult(stream: string): ResultEvent | undefined {
  let found: ResultEvent | undefined;
  for (const line of stream.split("\n")) {
    try { const event = JSON.parse(line); if (event?.type === "result") found = event; } catch { /* Non-JSON lines are progress. */ }
  }
  return found;
}
