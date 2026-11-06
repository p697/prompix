import { access, constants, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { anthropicAPIProvider } from "./anthropic-api.ts";
import { chatCompletionsProvider } from "./chat-completions.ts";
import { claudeCliProvider } from "./claude-cli.ts";
import { codexCliProvider } from "./codex-cli.ts";
import type { Fetch } from "./http.ts";
import { openAIResponsesProvider } from "./openai-responses.ts";
import type { RunProcess } from "./process.ts";
import { ModelProviderError, providerIds, type ModelProvider, type ProviderId, type ProviderKind } from "./types.ts";

export type ProviderDefinition = {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  /** Model used when routing names none. Undefined means the route must name one. */
  defaultModel?: string;
  /** A local command for subscriptions, or the environment variable holding the API key. */
  requires: { command: string; commandEnv: string } | { apiKeyEnv: string };
  baseURLEnv?: string;
  images: boolean;
  note?: string;
};

/** Adding a vendor means one entry here and one adapter; pipeline stages never change. */
export const providerDefinitions: Record<ProviderId, ProviderDefinition> = {
  "codex-cli": { id: "codex-cli", label: "Codex 本地订阅", kind: "subscription", defaultModel: "gpt-5.6-luna",
    requires: { command: "codex", commandEnv: "PROMPIX_CODEX" }, images: true },
  "claude-cli": { id: "claude-cli", label: "Claude Code 本地订阅", kind: "subscription", defaultModel: "claude-opus-5-5",
    requires: { command: "claude", commandEnv: "PROMPIX_CLAUDE" }, images: true },
  "kimi-code": { id: "kimi-code", label: "Kimi 会员订阅", kind: "subscription", defaultModel: "k3.1-pro",
    requires: { apiKeyEnv: "KIMI_CODE_API_KEY" }, baseURLEnv: "KIMI_CODE_BASE_URL", images: true,
    note: "会员 Key 官方定位为编程工具使用，批量调用前请确认会员条款" },
  "kimi-api": { id: "kimi-api", label: "Kimi 开放平台 API", kind: "api",
    requires: { apiKeyEnv: "MOONSHOT_API_KEY" }, baseURLEnv: "MOONSHOT_BASE_URL", images: true,
    note: "路由里需要写明开放平台的模型名" },
  "deepseek-api": { id: "deepseek-api", label: "DeepSeek 官方 API", kind: "api", defaultModel: "deepseek-chat",
    requires: { apiKeyEnv: "DEEPSEEK_API_KEY" }, baseURLEnv: "DEEPSEEK_BASE_URL", images: false },
  "openai-api": { id: "openai-api", label: "OpenAI 官方 API", kind: "api", defaultModel: "gpt-6.1-sol",
    requires: { apiKeyEnv: "OPENAI_API_KEY" }, baseURLEnv: "OPENAI_BASE_URL", images: true },
  "anthropic-api": { id: "anthropic-api", label: "Anthropic 官方 API", kind: "api", defaultModel: "claude-opus-5-5",
    requires: { apiKeyEnv: "ANTHROPIC_API_KEY" }, images: true },
};

const defaultBaseURLs: Partial<Record<ProviderId, string>> = {
  "kimi-code": "https://api.kimi.com/coding/v1",
  "kimi-api": "https://api.moonshot.ai/v1",
  "deepseek-api": "https://api.deepseek.com",
};

export function isProviderId(value: string): value is ProviderId {
  return (providerIds as readonly string[]).includes(value);
}

export const modelEnvFile = () => process.env.PROMPIX_MODELS_ENV ?? join(homedir(), ".config/prompix/models.env");

/** Reads KEY=VALUE lines. Values stay in memory only; callers report names, never values. */
export async function loadEnvFile(path: string): Promise<{ values: Record<string, string>; warning?: string }> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return { values: {} };
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return { values, warning: (info.mode & 0o077) !== 0 ? `${path} 的权限应为 600` : undefined };
}

/** Process environment wins over the file, so a one-off override needs no file edit. */
export async function modelEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<{ env: NodeJS.ProcessEnv; warning?: string }> {
  const file = await loadEnvFile(modelEnvFile());
  return { env: { ...file.values, ...env }, warning: file.warning };
}

async function findCommand(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = command.includes("/") ? [command] : (env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, command));
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

export type ProviderAvailability = { id: ProviderId; label: string; kind: ProviderKind; ready: boolean; missing?: string; defaultModel?: string; images: boolean; note?: string };

/** Answers "could this route be used now" without calling the vendor or revealing a secret. */
export async function providerAvailability(id: ProviderId, env: NodeJS.ProcessEnv): Promise<ProviderAvailability> {
  const definition = providerDefinitions[id];
  const base = { id, label: definition.label, kind: definition.kind, defaultModel: definition.defaultModel, images: definition.images, note: definition.note };
  if ("command" in definition.requires) {
    const command = env[definition.requires.commandEnv] || definition.requires.command;
    return await findCommand(command, env) ? { ...base, ready: true } : { ...base, ready: false, missing: `找不到命令 ${command}` };
  }
  return env[definition.requires.apiKeyEnv] ? { ...base, ready: true } : { ...base, ready: false, missing: `缺少 ${definition.requires.apiKeyEnv}` };
}

export type ProviderDependencies = { fetch?: Fetch; run?: RunProcess };

export function createProvider(id: ProviderId, model: string | undefined, env: NodeJS.ProcessEnv, dependencies: ProviderDependencies = {}): ModelProvider {
  const definition = providerDefinitions[id];
  const selected = model || definition.defaultModel;
  if (!selected) throw new ModelProviderError(`${definition.label} 需要在路由里指定模型`, "unavailable", false);
  const key = "apiKeyEnv" in definition.requires ? env[definition.requires.apiKeyEnv] ?? "" : "";
  const baseURL = (definition.baseURLEnv && env[definition.baseURLEnv]) || defaultBaseURLs[id];
  switch (id) {
    case "codex-cli": return codexCliProvider({ model: selected, executable: env.PROMPIX_CODEX || "codex", run: dependencies.run });
    case "claude-cli": return claudeCliProvider({ model: selected, executable: env.PROMPIX_CLAUDE || "claude", run: dependencies.run });
    case "kimi-code": case "kimi-api": case "deepseek-api":
      return chatCompletionsProvider({ id, label: definition.label, kind: definition.kind, baseURL: baseURL!, apiKey: key, model: selected, images: definition.images, fetch: dependencies.fetch });
    case "openai-api": return openAIResponsesProvider({ apiKey: key, model: selected, baseURL, fetch: dependencies.fetch });
    case "anthropic-api": return anthropicAPIProvider({ apiKey: key, model: selected });
  }
}
