import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonObject, renderUntrustedInput } from "./prompt.ts";
import { classifyCliFailure, runProcess, type RunProcess } from "./process.ts";
import { ModelProviderError, type ModelProvider, type ModelUsage } from "./types.ts";

export type CodexCliOptions = { model: string; executable?: string; run?: RunProcess };

/** Codex local subscription. Runs read-only in an empty directory with shell and web disabled. */
export function codexCliProvider(options: CodexCliOptions): ModelProvider {
  const executable = options.executable ?? "codex", run = options.run ?? runProcess;
  return {
    id: "codex-cli", kind: "subscription", model: options.model,
    capabilities: { images: true, structuredOutput: "native" },
    async complete(request) {
      const startedAt = new Date().toISOString();
      const directory = await mkdtemp(join(tmpdir(), "prompix-codex-"));
      try {
        const schema = join(directory, "schema.json"), output = join(directory, "output.json");
        await writeFile(schema, JSON.stringify(request.schema));
        const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
          "--sandbox", "read-only", "--cd", directory, "--model", options.model, "--json",
          "-c", `model_reasoning_effort="${request.effort ?? "low"}"`, "-c", "features.shell_tool=false", "-c", 'web_search="disabled"',
          ...(request.images ?? []).flatMap(image => ["-i", image.path]),
          "--output-schema", schema, "--output-last-message", output, "-"];
        const result = await run(executable, args, { stdin: `${request.instructions}\n\n${renderUntrustedInput(request.input)}`, cwd: directory,
          timeoutMs: request.timeoutMs ?? 300000, maxStdoutBytes: 4_000_000, env: process.env });
        if (result.exitCode !== 0) throw classifyCliFailure("Codex", result.exitCode, result.stderrTail + result.stdout.slice(-4000));
        const size = await stat(output).then(info => info.size, () => -1);
        if (size < 0) throw new ModelProviderError("Codex finished without a final message", "invalid_output", false);
        if (size > (request.maxOutputTokens ?? 16000) * 12) throw new ModelProviderError("Codex output exceeded the bounded size", "invalid_output", false);
        const text = await readFile(output, "utf8");
        return { output: parseJsonObject(text), text, provider: "codex-cli", model: options.model, usage: codexUsage(result.stdout),
          startedAt, finishedAt: new Date().toISOString() };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

function codexUsage(events: string): ModelUsage {
  let usage: ModelUsage = {};
  for (const line of events.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "turn.completed" && event.usage) usage = {
        inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens, cachedInputTokens: event.usage.cached_input_tokens };
    } catch { /* Progress lines are not usage data. */ }
  }
  return usage;
}
