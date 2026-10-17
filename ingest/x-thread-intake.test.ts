import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic } from "./publication.ts";
import { promptSchema } from "../packages/schema/catalog.ts";
import { convertXThread, readAllXIntake } from "./x-thread-intake.ts";
import { saveXReplyPage, xReplyRequest } from "./x-replies.ts";
import { nativeXSourceDigest, nativeXSourceIssue } from "./x-source.ts";
import { prepareXAvailability, filterXAvailability } from "./x-availability.ts";
import { extractMarkedXPrompt } from "./x-intake.ts";
import { automaticReviewEligibility } from "./editorial-runner.ts";

const now = new Date().toISOString(), earlier = new Date(Date.now() - 60_000).toISOString();
const creator = { id: "x-fixture", externalID: "9", platform: "x" as const, username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" };
const root = { id: "100", author_id: "9", conversation_id: "100", created_at: earlier, text: "My animated film made in Claude Code. Prompt in first reply.", attachments: { media_keys: ["v1"] } };
const reply = { id: "101", author_id: "9", conversation_id: "100", in_reply_to_user_id: "9", created_at: now,
  referenced_tweets: [{ type: "replied_to" as const, id: "100" }], text: "Prompt:\nDirect a short animated film. Create images in ChatGPT and animate in Remotion.\nFinal output: out/promo.mp4, exactly thirty seconds. Write a script, render the film and inspect the final result." };
const media = [{ media_key: "v1", type: "video" as const, preview_image_url: "https://pbs.twimg.com/media/fixture.jpg", variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/fixture.mp4", bit_rate: 100 }] }];
const snapshot = { capturedAt: now, posts: [root, reply], creators: [creator], media };
const candidate = () => convertXThread(snapshot, "100").candidates[0];
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "prompix-thread-intake-"));
  try {
    const lead = { post: root, creator, capturedAt: now, snapshot: "fixture", media }, request = xReplyRequest(lead);
    await saveXReplyPage(directory, lead, {}, now, { ...snapshot, request, newest: "101", coverage: {} as never });
    await run(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("reply instructions retain their own identity while media names its distinct original source", () => {
  const item = candidate();
  assert.equal(item.id, "x-post-101"); assert.equal(item.kind, "video"); assert.equal(item.model, "Remotion");
  assert.equal(item.source.post!.text, reply.text); assert.equal(item.source.context![0].text, root.text);
  assert.equal(item.source.post!.parentID, "100"); assert.equal(item.source.mediaPostID, "100");
  assert.equal(item.source.url, "https://x.com/i/web/status/101");
  assert.equal(item.media!.videoURL, media[0].variants[0].url);
  assert.equal(item.prompt, reply.text.slice("Prompt:\n".length));
  assert.equal(promptSchema.safeParse(item).success, true); assert.equal(nativeXSourceIssue(item), undefined);
  assert.equal(automaticReviewEligibility(item), undefined);
});

test("declared video artifacts outrank intermediate image and text tools, but explicit text prompts still win", () => {
  assert.equal(candidate().kind, "video");
  const extracted = extractMarkedXPrompt({ ...reply, text: reply.text.replace("Prompt:", "Text prompt:") });
  assert.ok("kind" in extracted); assert.equal(extracted.kind, "text");
});

test("attachment-based reply modality follows its own verified media before root media", () => {
  const plainRoot = { ...root, text: "My latest experiment. Prompt in first reply." };
  const photo = { media_key: "p1", type: "photo" as const, url: "https://pbs.twimg.com/media/reply.jpg" };
  const plainReply = { ...reply, text: "Prompt:\nA tiny blue cottage beneath a glowing moon, watercolor texture, soft shadows and a restrained color palette.",
    attachments: { media_keys: ["p1"] } };
  for (const rootAttachments of [undefined, root.attachments]) {
    const result = convertXThread({ ...snapshot, posts: [{ ...plainRoot, attachments: rootAttachments }, plainReply], media: [...media, photo] }, "100");
    assert.equal(result.candidates.length, 1);
    const item = result.candidates[0];
    assert.equal(item.kind, "image"); assert.equal(item.media?.imageURL, photo.url);
    assert.equal(item.media?.videoURL, undefined); assert.equal(item.source.mediaPostID, plainReply.id);
    assert.equal(item.prompt, plainReply.text.slice("Prompt:\n".length));
    assert.equal(nativeXSourceIssue(item), undefined);
  }
  // Unattached or unverified media must not override a verified root attachment.
  for (const replyAttachments of [undefined, { media_keys: ["unknown"] }, { media_keys: ["unsafe"] }]) {
    const result = convertXThread({ ...snapshot, posts: [plainRoot, { ...plainReply, attachments: replyAttachments }],
      media: [...media, photo, { ...photo, media_key: "unsafe", url: "https://example.com/unverified.jpg" }] }, "100");
    assert.equal(result.candidates[0].kind, "video");
    assert.equal(result.candidates[0].source.mediaPostID, root.id);
    assert.equal(result.candidates[0].media?.videoURL, media[0].variants[0].url);
  }
  const mixed = convertXThread({ ...snapshot, posts: [plainRoot, { ...plainReply, attachments: { media_keys: ["p1", "v1"] } }], media: [...media, photo] }, "100");
  assert.equal(mixed.candidates.length, 0);
  assert.equal(mixed.records[0].reason, "ambiguous-modality");
});

test("context changes invalidate approval while recheck timestamps do not", () => {
  const item = candidate(), before = nativeXSourceDigest(item);
  const changed = structuredClone(item); changed.source.context![0].text += " Changed reference.";
  assert.notEqual(nativeXSourceDigest(changed), before);
  for (const source of [...changed.source.context!, changed.source.post!]) source.checkedAt = new Date(Date.now() + 1000).toISOString();
  changed.source.context![0].text = item.source.context![0].text;
  assert.equal(nativeXSourceDigest(changed), before);
  changed.source.context![0].checkedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
  assert.match(nativeXSourceIssue(changed)!, /rechecked/);
});

test("foreign parents, missing roots, truncated context and invalid source chains cannot publish", () => {
  assert.equal(convertXThread({ ...snapshot, posts: [reply] }, "100").candidates.length, 0);
  assert.equal(convertXThread({ ...snapshot, posts: [{ ...root, author_id: "8" }, reply] }, "100").candidates.length, 0);
  assert.equal(convertXThread({ ...snapshot, posts: [{ ...root, truncated: true }, reply] }, "100").candidates.length, 0);
  const item = candidate();
  for (const edit of [(x: typeof item) => { x.source.context![0].authorID = "8"; },
    (x: typeof item) => { x.source.post!.parentID = "200"; },
    (x: typeof item) => { x.source.mediaPostID = "200"; },
    (x: typeof item) => { x.source.context![0].id = "101"; },
    (x: typeof item) => { x.source.context = []; }]) {
    const bad = structuredClone(item); edit(bad); assert.equal(promptSchema.safeParse(bad).success, false);
  }
});

test("recorded pages replay into drafts and fresh lookups bind every required post", () => fixture(async directory => {
  assert.equal((await readAllXIntake(directory)).candidates.length, 1);
  const check = await prepareXAvailability(directory, { enabled: true, bearer: "fixture", now, lookup: async (_, ids) => {
    assert.deepEqual(ids, ["100", "101"]); return { ...snapshot, unavailable: [] };
  } });
  assert.equal(check.report.checked, 2); assert.equal(check.state["x-post-101"].status, "ready");
  const item = (await readAllXIntake(directory)).candidates[0];
  assert.equal(filterXAvailability([item], check.state).prompts.length, 1);
  const next = new Date(Date.now() + 13 * 3600_000).toISOString();
  const withdrawal = await prepareXAvailability(directory, { enabled: true, bearer: "fixture", now: next, lookup: async () => ({ posts: [reply], creators: [creator], media: [], unavailable: ["100"] }) });
  assert.equal(withdrawal.state[item.id].removed, true);
  assert.equal(filterXAvailability([item], withdrawal.state).prompts.length, 0);
  assert.equal((await readAllXIntake(directory)).candidates.length, 0);
}));

test("source edits refresh the candidate and invalidate the former revision", () => fixture(async directory => {
  const old = candidate(), changed = { ...reply, text: reply.text + " Use a night palette." };
  const check = await prepareXAvailability(directory, { enabled: true, bearer: "fixture", now, lookup: async () => ({ posts: [root, changed], creators: [creator], media, unavailable: [] }) });
  assert.equal(filterXAvailability([old], check.state).prompts.length, 0);
  const current = (await readAllXIntake(directory)).candidates[0];
  assert.equal(current.source.post!.text, changed.text);
  assert.equal(filterXAvailability([current], check.state).prompts.length, 1);
}));


test("dependency batches stay below one hundred IDs and an expanded budget preserves prior reservations", () => fixture(async directory => {
  const checkTime = new Date(Date.parse(now) + 13 * 3600_000).toISOString();
  const posts = Array.from({ length: 99 }, (_, index) => ({ id: String(1000 + index), author_id: "9", created_at: earlier,
    text: `Text prompt:\nWrite an original story about creative discovery number ${index}. Ask me for the subject, audience and tone first, then offer three distinct directions.` }));
  await atomic(join(directory, "x-discovery", `${now.slice(0, 10)}-feed-001.json`), { capturedAt: earlier, posts, creators: [creator], media: [] });
  const calls: string[][] = [];
  const lookup = async (_: string, ids: readonly string[]) => {
    calls.push([...ids]); assert.ok(ids.length <= 100);
    return { posts: [...posts, root, reply].filter(post => ids.includes(post.id)), creators: [creator], media, unavailable: [] };
  };
  const first = await prepareXAvailability(directory, { enabled: true, bearer: "fixture", now: checkTime, lookup, maxRequests: 2 });
  assert.equal(first.report.requests, 2); assert.deepEqual(calls.map(ids => ids.length), [99, 2]);
  const extra = { ...posts[0], id: "2000" }; posts.push(extra);
  await atomic(join(directory, "x-discovery", `${now.slice(0, 10)}-feed-002.json`), { capturedAt: now, posts: [extra], creators: [creator], media: [] });
  const limited = await prepareXAvailability(directory, { enabled: true, bearer: "fixture", now: checkTime, lookup, maxRequests: 2 });
  assert.equal(limited.report.status, "daily-limit"); assert.equal(calls.length, 2);
  const expanded = await prepareXAvailability(directory, { enabled: true, bearer: "fixture", now: checkTime, lookup, maxRequests: 3 });
  assert.equal(expanded.report.requests, 1); assert.deepEqual(calls[2], ["2000"]);
  assert.equal((await prepareXAvailability(directory, { enabled: true, bearer: "fixture", now: checkTime, lookup, maxRequests: 3 })).report.status, "daily-limit");
  await assert.rejects(() => prepareXAvailability(directory, { enabled: true, bearer: "fixture", now: checkTime, lookup, maxRequests: 5 }));
}));

test("a partial root refresh withholds dependent approvals without erasing drafts needed for a full recheck", () => fixture(async directory => {
  const item = candidate();
  await atomic(join(directory, "x-availability", "state.json"), { [item.id]: { checkedAt: now, status: "ready", revision: item.source.revision } });
  const currentRoot = { ...root, text: "Video prompt:\nAnimate an original warm cartoon world with rounded characters and a clear story. Use a recognizable location, a coherent palette and a simple concluding scene." };
  await atomic(join(directory, "x-discovery", `${now.slice(0, 10)}-feed-001.json`), { capturedAt: earlier, posts: [currentRoot], creators: [creator], media });
  const checked = await prepareXAvailability(directory, { enabled: true, bearer: "fixture", now, lookup: async (_, ids) => {
    assert.deepEqual(ids, ["100"]); return { posts: [currentRoot], creators: [creator], media, unavailable: [] };
  } });
  assert.equal(checked.state[item.id].status, "withheld");
  assert.equal(filterXAvailability([item], checked.state).prompts.length, 0);
  assert.ok((await readAllXIntake(directory)).candidates.some(value => value.id === item.id));
}));
