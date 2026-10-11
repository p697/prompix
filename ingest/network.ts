/** Bounded downloads with explicit hosts and checked redirects, including GitHub release assets. */
export async function download(
  url: string,
  hosts: readonly string[],
  maxBytes = 20_000_000,
  headers: Record<string, string> = {},
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
    const response = await fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Missing redirect");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Download HTTP ${response.status} from ${current.hostname}`,
      );
    }
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
    } finally {
      await reader.cancel();
    }
    return {
      bytes: Buffer.concat(chunks),
      type: (response.headers.get("content-type") ?? "").split(";")[0],
    };
  }
  throw new Error("Too many redirects");
}
