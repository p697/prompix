import { spawn } from "node:child_process";
import { ModelProviderError } from "./types.ts";

export type ProcessResult = { stdout: string; stderrTail: string; exitCode: number | null };
export type ProcessOptions = { stdin: string; cwd: string; timeoutMs: number; maxStdoutBytes: number; env?: NodeJS.ProcessEnv };
export type RunProcess = (executable: string, args: readonly string[], options: ProcessOptions) => Promise<ProcessResult>;

/** Runs a local CLI with bounded time and output. Source data travels on stdin, never in argv. */
export const runProcess: RunProcess = (executable, args, options) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let bytes = 0, stderrTail = "", failure: ModelProviderError | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (error: ModelProviderError) => {
    if (failure) return;
    failure = error;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 2000);
  };
  const timer = setTimeout(() => stop(new ModelProviderError(`${executable} timed out after ${options.timeoutMs} ms`, "timeout")), options.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > options.maxStdoutBytes) { stop(new ModelProviderError(`${executable} exceeded bounded output`, "invalid_output", false)); return; }
    chunks.push(chunk);
  });
  // Keep only a short tail: diagnostics can echo account details or source text.
  child.stderr.on("data", (chunk: Buffer) => { stderrTail = (stderrTail + String(chunk)).slice(-4000); });
  child.stdin.on("error", () => {});
  child.on("error", error => {
    clearTimeout(timer); if (escalation) clearTimeout(escalation);
    reject(new ModelProviderError(`${executable} could not start: ${error.message}`, "unavailable", false));
  });
  child.on("close", code => {
    clearTimeout(timer); if (escalation) clearTimeout(escalation);
    if (failure) reject(failure);
    else resolve({ stdout: Buffer.concat(chunks).toString(), stderrTail, exitCode: code });
  });
  child.stdin.end(options.stdin);
});

/** Shared mapping from CLI diagnostics to the provider error vocabulary. */
export function classifyCliFailure(label: string, exitCode: number | null, diagnostic: string): ModelProviderError {
  if (/usage limit|rate.?limit|quota|429|too many requests|overloaded/i.test(diagnostic)) return new ModelProviderError(`${label} is rate limited or out of quota`, "rate_limited");
  if (/not logged in|log ?in|authenticat|unauthori[sz]ed|401|403|not supported when using|model .*not (found|available)/i.test(diagnostic)) return new ModelProviderError(`${label} is not signed in or cannot use this model`, "unavailable", false);
  return new ModelProviderError(`${label} exited ${exitCode}`, "failed");
}
