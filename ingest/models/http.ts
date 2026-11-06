import { ModelProviderError } from "./types.ts";

export type Fetch = typeof fetch;

/** POST JSON with no redirects and a hard timeout. API keys never enter error messages. */
export async function postJson(fetcher: Fetch, label: string, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  let response: Response;
  try {
    response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ModelProviderError(timedOut ? `${label} timed out after ${timeoutMs} ms` : `${label} request failed before a response`, timedOut ? "timeout" : "failed");
  }
  if (!response.ok) throw httpFailure(label, response.status);
  try { return await response.json(); }
  catch { throw new ModelProviderError(`${label} returned a body that is not JSON`, "invalid_output", false); }
}

export function httpFailure(label: string, status: number): ModelProviderError {
  if (status === 429) return new ModelProviderError(`${label} is rate limited or out of quota`, "rate_limited");
  if (status === 401 || status === 403) return new ModelProviderError(`${label} rejected the credentials`, "unavailable", false);
  if (status === 402) return new ModelProviderError(`${label} needs a top-up or a paid plan`, "unavailable", false);
  if (status === 404) return new ModelProviderError(`${label} does not offer the requested model`, "unavailable", false);
  if (status >= 500) return new ModelProviderError(`${label} server error ${status}`, "failed");
  return new ModelProviderError(`${label} rejected the request (${status})`, "failed", false);
}
