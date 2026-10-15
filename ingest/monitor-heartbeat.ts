import { heartbeatSchema } from "../services/monitor/state.ts";

type Options = { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void> };
/** Project only allowlisted operational fields: raw errors, source text and URLs never leave the collector. */
export async function sendHeartbeat(record: Record<string, unknown>, options: Options = {}): Promise<void> {
  const env = options.env ?? process.env;
  const endpoint = env.PROMPIX_MONITOR_URL, secret = env.PROMPIX_MONITOR_SECRET;
  if (!endpoint && !secret) return;
  if (!endpoint || !secret) throw new Error("Incomplete monitor configuration");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/heartbeat")
    throw new Error("Invalid monitor endpoint");
  const event = heartbeatSchema.parse({ runID: record.runID, startedAt: record.startedAt, state: record.state,
    finishedAt: record.finishedAt, published: record.published,
    degraded: [record.sources, record.editorial, record.visualReview, record.translations].some(value => degraded(value)) });
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt++) {
    let retry = true;
    try {
      const response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(event) });
      await response.body?.cancel();
      if (response.ok) return;
      retry = response.status === 429 || response.status >= 500;
    } catch { /* Network failure or timeout: retry the same event, never the collection. */ }
    if (!retry || attempt === 2) throw new Error("Monitor heartbeat could not be delivered");
    await sleep([1000, 3000][attempt]);
  }
}

function degraded(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return false;
  const report = value as Record<string, unknown>;
  if (["failed", "partial", "prior-attempt-blocked"].includes(String(report.status))) return true;
  return Object.values(report).some(child => degraded(child, depth + 1));
}
