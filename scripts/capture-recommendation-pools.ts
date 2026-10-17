/** Public API acceptance fixture. Keep captured cards outside this repository. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { realpath, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { atomic, repo } from "../ingest/publication.ts";
import { readResponseBytes } from "../ingest/network.ts";
import { feedPageSchema } from "../packages/schema/feed.ts";

process.umask(0o077);
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !isAbsolute(args[1]))
  throw new Error("Use --output /absolute/external/directory/pools.json; the parent directory must exist");
const parent = await realpath(dirname(args[1])), output = resolve(parent, args[1].split("/").at(-1)!);
const location = relative(await realpath(repo), output);
if (!location.startsWith("../") && !isAbsolute(location)) throw new Error("Third-party fixtures must stay outside the repository");
const claim = await open(output, "wx", 0o600); await claim.close();
const sessions = [
  ...Array.from({ length: 12 }, (_, index) => ({ name: `all-${index}`, kind: undefined as string | undefined })),
  ...["image", "video", "web", "text", "skill"].flatMap(kind => Array.from({ length: 2 }, (_, index) => ({ name: `${kind}-${index}`, kind }))),
].map(value => ({ ...value, seed: randomBytes(16).toString("hex"), items: [] as unknown[], pages: 0, nextCursor: undefined as string | undefined }));
const report = { version: 1, startedAt: new Date().toISOString(), complete: false,
  origin: "https://api.prompix.dev", release: undefined as string | undefined, calls: 0, sessions };
await atomic(output, report);
for (const session of sessions) {
  do {
    await new Promise(done => setTimeout(done, 1100));
    const query = new URLSearchParams({ sort: "recommended", seed: session.seed, locale: "zh-Hans", limit: "30",
      ...(session.kind ? { kind: session.kind } : {}), ...(session.nextCursor ? { cursor: session.nextCursor } : {}) });
    const response = await fetch(`${report.origin}/v3/feed?${query}`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    report.calls++;
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const page = feedPageSchema.parse(JSON.parse((await readResponseBytes(response, 1_000_000)).toString()));
    report.release ??= page.release; assert.equal(page.release, report.release, "Publication changed; inspect the partial fixture before recapturing");
    assert.ok(page.items.length <= 30);
    if (session.kind) assert.ok(page.items.every(card => session.kind === "skill" ? card.contentType === "skill" : card.kind === session.kind && card.contentType !== "skill"));
    assert.ok(!session.nextCursor || session.nextCursor !== page.nextCursor);
    session.items.push(...page.items); session.pages++; session.nextCursor = page.nextCursor ?? undefined;
    assert.equal(new Set((session.items as { id: string }[]).map(card => card.id)).size, session.items.length);
    await atomic(output, report);
  } while (session.pages < 3 && session.nextCursor);
}
report.complete = true; await atomic(output, report);
console.log(JSON.stringify({ complete: true, release: report.release, sessions: sessions.length, calls: report.calls, output }));
