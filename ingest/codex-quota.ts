import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomic } from "./publication.ts";

const windowSchema = z.object({ usedPercent: z.number().finite().min(0).max(100), windowDurationMins: z.number().positive(), resetsAt: z.number().positive() });
const bucketSchema = z.object({ primary: windowSchema.nullable(), secondary: windowSchema.nullable(),
  spendControlReached: z.boolean(), rateLimitReachedType: z.string().nullable(), individualLimit: z.null(), planType: z.string().min(1) });

/** Derive conservative ordinary-use permission from actual account windows, never credit balance. */
export function quotaObservation(raw: unknown, expectedAccountID: string, now = Date.now()) {
  const result = z.object({ accountId: z.string().min(1), rateLimits: z.unknown(), rateLimitsByLimitId: z.record(z.string(), z.unknown()).optional() }).parse(raw);
  if (!expectedAccountID || result.accountId !== expectedAccountID) throw new Error("Quota account mismatch");
  const bucket = bucketSchema.parse(result.rateLimitsByLimitId ? result.rateLimitsByLimitId.codex : result.rateLimits);
  const windows = [bucket.primary, bucket.secondary].filter(w => w !== null);
  const weekly = windows.filter(w => w.windowDurationMins === 10080);
  if (weekly.length !== 1 || windows.some(w => w.resetsAt * 1000 <= now)) throw new Error("Missing or expired quota window");
  return { observedAt: new Date(now).toISOString(), ordinaryUsageAllowed: !bucket.spendControlReached && bucket.rateLimitReachedType === null && windows.every(w => w.usedPercent < 100),
    weeklyUsedPercent: weekly[0].usedPercent, source: "codex-account-rate-limits", accountId: result.accountId,
    evidence: { method: "account/rateLimits/read", permissionDerivedFrom: "validated-account-windows-and-limit-state", windows,
      spendControlReached: bucket.spendControlReached, rateLimitReachedType: bucket.rateLimitReachedType } };
}

/** No model/thread calls, no token files, no reset consumption, no credit purchases. */
export function readCodexRateLimits(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PROMPIX_CODEX_BIN || "codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "", bytes = 0, done = false, initialized = false;
    const finish = (error?: Error, value?: unknown) => {
      if (done) return; done = true; clearTimeout(timer); child.kill();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Quota read timed out")), 30000);
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    child.on("error", () => finish(new Error("Quota reader could not start")));
    child.stdin.on("error", () => finish(new Error("Quota reader input closed")));
    child.on("close", () => finish(new Error("Quota reader exited without a response")));
    child.stdout.on("data", chunk => {
      bytes += chunk.length; if (bytes > 128000) return finish(new Error("Quota response exceeds bound"));
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 0 && !initialized) {
            if (message.error) return finish(new Error("Quota initialization failed"));
            initialized = true; send({ method: "initialized", params: {} }); send({ id: 1, method: "account/rateLimits/read" });
          } else if (message.id === 1 && initialized) {
            if (message.error) return finish(new Error("Quota account read failed"));
            finish(undefined, message.result);
          }
        } catch { finish(new Error("Invalid quota protocol response")); }
      }
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "prompix_quota", version: "1.0.0" } } });
  });
}

/** In-process before-request refresh; no scheduler or chat heartbeat is created. */
export function campaignQuotaReader(root: string, expectedAccountID: string,
  read: () => Promise<unknown> = readCodexRateLimits, now: () => number = Date.now) {
  let nextRead = 0, pending: Promise<void> | undefined;
  return async () => {
    if (pending) return pending;
    if (now() < nextRead) return;
    pending = (async () => {
      try {
        const snapshot = quotaObservation(await read(), expectedAccountID, now());
        await appendFile(join(root, "subscription-quota-history.jsonl"), JSON.stringify(snapshot) + "\n", { mode: 0o600 });
        await atomic(join(root, "subscription-quota-evidence.json"), snapshot);
        const { observedAt, ordinaryUsageAllowed, weeklyUsedPercent, source } = snapshot;
        await atomic(join(root, "subscription-quota.json"), { observedAt, ordinaryUsageAllowed, weeklyUsedPercent, source });
        nextRead = now() + 20 * 60_000;
      } catch (error) {
        // Preserve the last real snapshot. Existing 65-minute admission check still decides.
        nextRead = now() + 60_000;
        await atomic(join(root, "subscription-quota-read-error.json"), { at: new Date(now()).toISOString(), error: "Account quota refresh failed; retained snapshot unchanged" });
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
