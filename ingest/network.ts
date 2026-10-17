/** Count decoded response bytes, including when HTTP advertises a compressed length. */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Download exceeds size limit");
  }
  if (!response.body) throw new Error("Empty download");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Download exceeds size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

class DownloadHTTPError extends Error {
  constructor(readonly status: number, host: string, readonly retryAfterMS: number) { super(`Download HTTP ${status} from ${host}`); }
}
function transientDownload(error: unknown): boolean {
  if (error instanceof DownloadHTTPError) return [408, 429, 500, 502, 503, 504].includes(error.status) && error.retryAfterMS <= 30000;
  if (!(error instanceof Error)) return false;
  if (["AbortError", "TimeoutError"].includes(error.name)) return true;
  const cause = (error as Error & { cause?: { code?: string } }).cause;
  const code = (error as NodeJS.ErrnoException).code ?? cause?.code;
  return ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code ?? "")
    || (error instanceof TypeError && error.message === "fetch failed" && !cause);
}

/** Bounded idempotent reads with explicit hosts and checked redirects, including GitHub release assets. */
export async function download(
  url: string,
  hosts: readonly string[],
  maxBytes = 20_000_000,
  headers: Record<string, string> = {},
  options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ bytes: Buffer; type: string }> {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (
      current.protocol !== "https:" ||
      !hosts.includes(current.hostname) ||
      current.username ||
      current.password
    )
      throw new Error("Download host is not allowlisted");
    let location: string | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await (options.fetch ?? fetch)(current, {
          headers, redirect: "manual", signal: AbortSignal.timeout(60_000),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new Error("Missing redirect");
          break;
        }
        if (!response.ok) {
          const retry = response.headers.get("retry-after");
          const retryAfter = retry === null ? 0 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          await response.body?.cancel();
          throw new DownloadHTTPError(response.status, current.hostname, Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : Infinity);
        }
        return {
          bytes: await readResponseBytes(response, maxBytes),
          type: (response.headers.get("content-type") ?? "").split(";")[0],
        };
      } catch (error) {
        if (attempt >= 2 || !transientDownload(error)) throw error;
        const retryAfter = error instanceof DownloadHTTPError ? error.retryAfterMS : 0;
        await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(Math.max([1000, 3000][attempt], retryAfter));
      }
    }
    current = new URL(location!, current);
  }
  throw new Error("Too many redirects");
}
