import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paceTwitterAPI } from "./twitterapi-pacing.ts";
import { atomic, json } from "./publication.ts";
import { TransientXReadError } from "./x.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-twitterapi-pacing-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("separate callers serialize network work and retain their spacing across calls", () => fixture(async root => {
  const starts: number[] = []; let active = 0, peak = 0;
  const call = () => paceTwitterAPI(root, async () => {
    starts.push(Date.now()); active++; peak = Math.max(active, peak);
    await new Promise(resolve => setTimeout(resolve, 15)); active--;
  }, { intervalMS: 30, waitMS: 2000 });
  await Promise.all([call(), call(), call()]);
  assert.equal(peak, 1);
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 28);
  const before = Date.now(); await call();
  assert.ok(starts[3] >= before);
  assert.ok(starts[3] - starts[2] >= 28);
}));
test("busy and stale locks never run the financial or HTTP callback", () => fixture(async root => {
  const lock = join(root, "twitterapi-request.lock"); await mkdir(lock);
  await atomic(join(lock, "owner.json"), { pid: 999999999 });
  let calls = 0;
  await assert.rejects(paceTwitterAPI(root, async () => { calls++; }, { waitMS: 10 }), /busy; no request sent/);
  assert.equal(calls, 0);
  assert.deepEqual(await json(join(lock, "owner.json"), null), { pid: 999999999 });
}));
test("a rate-limited request keeps its failure and shares cooldown without retry", () => fixture(async root => {
  const ledger = join(root, "retained-ledger.json"); await atomic(ledger, { state: "uncertain", accounted: 150 });
  const before = await readFile(ledger); let calls = 0;
  await assert.rejects(paceTwitterAPI(root, async () => { calls++; throw new TransientXReadError("HTTP 429", 200); }, { intervalMS: 10 }), /429/);
  await assert.rejects(paceTwitterAPI(root, async () => { calls++; }, { intervalMS: 10, waitMS: 20 }), /cooldown/);
  assert.equal(calls, 1); assert.deepEqual(await readFile(ledger), before);
  assert.ok((await json<{ notBefore: number }>(join(root, "twitterapi-pacing.json"), { notBefore: 0 })).notBefore > Date.now());
}));
test("corrupt pacing evidence fails before the callback and separate accounts remain independent", () => fixture(async root => {
  await atomic(join(root, "twitterapi-pacing.json"), { notBefore: "invalid" });
  let calls = 0;
  await assert.rejects(paceTwitterAPI(root, async () => { calls++; }));
  await paceTwitterAPI(join(root, "other-account"), async () => { calls++; });
  assert.equal(calls, 1);
}));
test("independent Node processes coordinate through the shared account directory", () => fixture(async root => {
  const script = `import { paceTwitterAPI } from ${JSON.stringify(new URL("./twitterapi-pacing.ts", import.meta.url).href)};
    await paceTwitterAPI(process.argv[1], async () => {
      const start = Date.now(); await new Promise(resolve => setTimeout(resolve, 40));
      console.log(JSON.stringify({ start, end: Date.now() }));
    }, { intervalMS: 75, waitMS: 3000 });`;
  const run = () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, root]);
  const results = (await Promise.all([run(), run()])).map(result => JSON.parse(result.stdout)).sort((a, b) => a.start - b.start);
  assert.ok(results[1].start - results[0].start >= 73);
  assert.ok(results[1].start >= results[0].end);
}));
