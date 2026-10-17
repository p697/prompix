import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Retry only identical, content-addressed media. Mutable publication pointers keep their reconciliation protocol. */
export async function retryMediaUpload(key: string, path: string, upload: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const identity = /^media\/([a-f0-9]{64})\.(?:jpg|png|webp|mp4)$/.exec(key)?.[1];
  if (!identity) { await upload(); return; }
  for (let attempt = 0; ; attempt++) {
    if (createHash("sha256").update(await readFile(path)).digest("hex") !== identity)
      throw new Error("Media upload bytes changed; immutable object was not written");
    try { await upload(); return; }
    catch (error) {
      const value = error as { message?: string; stderr?: string; stdout?: string; code?: string } | null;
      const diagnostic = [value?.message, value?.stderr, value?.stdout, value?.code].filter(s => typeof s === "string").join("\n")
        .replace(/\x1b\[[0-9;]*m/g, "");
      const permanent = /\b(?:401|403)\s*:|\b(?:CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID|EACCES|ENOENT)\b/i.test(diagnostic);
      const temporary = !permanent && /\b(?:408|429|500|502|503|504)\s*:|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED)\b|\bfetch failed\b/i.test(diagnostic);
      const retryAfter = diagnostic.match(/retry-after\s*[:=]\s*(\d+)/i)?.[1];
      const delay = retryAfter ? Number(retryAfter) * 1000 : [1000, 3000][attempt];
      if (!temporary || attempt >= 2 || delay > 30000)
        throw new Error(`Media upload failed after ${attempt + 1} attempt(s): ${temporary ? "temporary storage failure" : "non-retryable storage failure"}`);
      await sleep(Math.max(1000, delay));
    }
  }
}
