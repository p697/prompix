import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectTweetAPILookup, TweetAPIPilotClient } from "./tweetapi-pilot.ts";
import { XSpendBudget, XBudgetExceeded } from "./x-spend.ts";
import { atomic, json } from "./publication.ts";
const time = () => new Date("2026-10-17T11:00:00Z");
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-tweetapi-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const body = (ids: readonly string[]) => ({ data: { tweets: ids.map(id => ({ id, text: "Synthetic fixture" })) } });

test("200 IDs bill one call, empties still bill, and trial usage shares the existing dollar ledger", () => fixture(async root => {
  const budget = new XSpendBudget(root, 20, 1, time), ids = Array.from({ length: 200 }, (_, i) => String(i + 1));
  const client = new TweetAPIPilotClient("test-secret", budget, (async (_url, options) => {
    const ledger = await json<any>(join(root, "2026-10.json"), null);
    assert.equal(ledger.entries.at(-1).provider, "tweetapi");
    assert.equal(ledger.entries.at(-1).state, "reserved");
    assert.equal(ledger.entries.at(-1).reserved, 500);
    assert.equal(options?.redirect, "manual");
    assert.equal(new Headers(options?.headers).get("X-API-Key"), "test-secret");
    return Response.json(body(ids));
  }) as typeof fetch);
  let saved: unknown;
  const response = await client.lookup(ids, async raw => { saved = raw; });
  assert.equal(response.inspection.returnedIDs.length, 200);
  assert.equal(response.inspection.sourceFidelityVerified, false);
  assert.deepEqual(saved, body(ids));
  await new TweetAPIPilotClient("test-secret", budget, (async () => Response.json(body([]))) as typeof fetch).lookup(["1"], async () => {});
  await (await budget.reserve("official", "lookup", "official", 1)).finish(1);
  await (await budget.reserve("twitterapi", "lookup", "existing-provider", 1)).finish(1);
  const ledger = await json<any>(join(root, "2026-10.json"), null);
  assert.deepEqual(ledger.entries.map((e: any) => e.accounted), [500, 500, 5000, 150]);
  assert.ok(ledger.entries.every((e: any) => e.state === "completed"));
  assert.equal(JSON.stringify(ledger).includes("test-secret"), false);
}));

test("the shared cap rejects a trial call before HTTP and does not reset existing uncertain charges", () => fixture(async root => {
  const budget = new XSpendBudget(root, 20, 1, time);
  await atomic(join(root, "2026-10.json"), { version: 1, month: "2026-10", opening: 19_999_500, entries: [] });
  await budget.reserve("tweetapi", "lookup", "uncertain", 1);
  let calls = 0;
  const client = new TweetAPIPilotClient("test-secret", new XSpendBudget(root, 20, 1, time), (async () => { calls++; return Response.json(body([])); }) as typeof fetch);
  await assert.rejects(client.lookup(["1"], async () => {}), XBudgetExceeded);
  assert.equal(calls, 0);
  assert.equal((await json<any>(join(root, "2026-10.json"), null)).entries[0].state, "reserved");
  await assert.rejects(budget.reserve("tweetapi", "lookup", "per-post-would-be-wrong", 200), /one lookup call/);
  await assert.rejects(budget.reserve("tweetapi", "users", "unsupported", 1), /one lookup call/);
}));

test("bad or duplicate request IDs fail before spending; missing IDs do not prove deletion", () => fixture(async root => {
  let calls = 0;
  const client = new TweetAPIPilotClient("test-secret", new XSpendBudget(root, 20, 1, time), (async () => { calls++; return Response.json(body([])); }) as typeof fetch);
  for (const ids of [[], ["1", "1"], ["bad"], Array.from({ length: 201 }, (_, i) => String(i + 1))])
    await assert.rejects(client.lookup(ids, async () => {}));
  assert.equal(calls, 0);
  assert.equal(await json(join(root, "2026-10.json"), null), null);
  assert.deepEqual(inspectTweetAPILookup(body(["1"]), ["1", "2"]), { returnedIDs: ["1"], missingIDs: ["2"], sourceFidelityVerified: false });
  for (const raw of [body(["3"]), body(["1", "1"]), { ...body([]), error: "failure" }, { ...body([]), errors: [] }])
    assert.throws(() => inspectTweetAPILookup(raw, ["1", "2"]));
}));

test("HTTP, transport and malformed JSON failures keep costs and never automatically retry", () => fixture(async root => {
  for (const failure of [302, 400, 401, 403, 404, 429, 500, "transport", "json", "capture"] as const) {
    const dir = join(root, String(failure)); let calls = 0;
    const client = new TweetAPIPilotClient("test-secret", new XSpendBudget(dir, 20, 1, time), (async () => {
      calls++;
      if (failure === "transport") throw new Error("test-secret");
      return failure === "capture" ? Response.json(body(["1"])) : new Response("test-secret", { status: typeof failure === "number" ? failure : 200 });
    }) as typeof fetch);
    await assert.rejects(client.lookup(["1"], async () => { if (failure === "capture") throw new Error("test-secret"); }),
      e => e instanceof Error && !e.message.includes("test-secret"));
    assert.equal(calls, 1);
    const ledger = await json<any>(join(dir, "2026-10.json"), null);
    assert.equal(ledger.entries[0].accounted, 500);
    assert.equal(ledger.entries[0].state, "uncertain");
  }
}));

test("unfamiliar source responses are captured before validation without paying to repair them", () => fixture(async root => {
  const raw = { data: { tweets: [{ id: "2", other: "Synthetic malformed identity" }] } }; let saved: unknown;
  const client = new TweetAPIPilotClient("test-secret", new XSpendBudget(root, 20, 1, time), (async () => Response.json(raw)) as typeof fetch);
  await assert.rejects(client.lookup(["1"], async value => { saved = value; }), /inconsistent identities/);
  assert.deepEqual(saved, raw);
  const entry = (await json<any>(join(root, "2026-10.json"), null)).entries[0];
  assert.equal(entry.state, "completed"); assert.equal(entry.accounted, 500);
}));
