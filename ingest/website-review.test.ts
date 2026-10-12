import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSchema, localizationLanguages, type Prompt } from "../packages/schema/catalog.ts";
import { websiteContentSecurityPolicy, websiteArtifactByteLimit, websiteReviewIdentity, websiteSourceSHA256,
  verifyWebsiteReview, websiteReviewer, websiteMediaNeedsMirroring, type WebsiteReview, type WebsiteReviewTrust } from "./website-review.ts";
import { fingerprint, type Candidate } from "./sources.ts";
import { applyEditorialReviews, type Reviews } from "./editorial.ts";
import { publicationText } from "./templates.ts";
import { prepareDailyVisualReview } from "./visual-daily.ts";
import { retainPublishedLibrary, selectLibrary } from "./library.ts";
import { splitLanguagePacks, joinLanguagePacks } from "./language-packs.ts";
import { translationFingerprint } from "./translation.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const html = Buffer.from('<!doctype html><html lang="en"><title>Original test planner</title><button>Plan locally</button></html>');
// Original byte fixtures exercise integrity, not browser layout or image decoding.
const jpeg = Buffer.from([255, 216, 255, 224, 12, 34, 56, 255, 217]);
const png = (value: number) => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, value]);
const mobile = png(1), desktop = png(2), revision = "a".repeat(40), now = "2026-10-12T12:00:00Z";
const trust: WebsiteReviewTrust = { version: 1, demoOrigin: "https://api.prompix.dev", reviewers: ["synthetic-reviewer"] };
function fixture() {
  const prompt = "Build an original landing page for a small planning tool with an in-page working demonstration, features, pricing examples and an accessible FAQ.";
  const item: Prompt = { id: `pc-${fingerprint(prompt).slice(0, 20)}`, kind: "web", title: "Original planner", summary: "Synthetic fixture, not community content.",
    prompt, example: "Try the local planner.", tags: ["Planning"], model: "Any web tool", toolURL: null, artwork: "test", previewLabel: "Original demo preview",
    source: { name: "prompts.chat", url: `https://github.com/f/prompts.chat/blob/${revision}/prompts.csv`, author: "synthetic-author",
      license: "CC0-1.0", method: "Synthetic source attribution fixture", revision },
    media: { image: null, video: null, demoURL: `https://api.prompix.dev/examples/${hash(html)}.html`, imageURL: `https://api.prompix.dev/media/${hash(jpeg)}.jpg` } };
  const screenshot = (bytes: Buffer, format: "png" | "jpg") => ({ sha256: hash(bytes), byteLength: bytes.length, format });
  const viewport = (width: number, bytes: Buffer) => ({ width, height: 900, screenshot: screenshot(bytes, "png"),
    interactions: [{ action: "Activate the planner", expected: "The local plan changes", observed: "The local plan changed", passed: true as const }],
    layoutPassed: true as const, keyboardPassed: true as const });
  const review: WebsiteReview = { version: 1, identity: websiteReviewIdentity(item, hash(html)), id: item.id,
    promptSHA256: hash(prompt), sourceSHA256: websiteSourceSHA256(item),
    artifact: { url: item.media!.demoURL!, sha256: hash(html), byteLength: html.length, format: "self-contained-html", author: "Original fixture author", license: "CC0-1.0" },
    preview: { ...screenshot(jpeg, "jpg"), format: "jpg" }, reviewerID: "synthetic-reviewer", reviewedAt: now, verdict: "approve", method: "browser-interaction",
    attestations: { completePromptCompared: true, hostedArtifactInspected: true, previewMatchesHostedArtifact: true, sourceAttributionVerified: true,
      sampleContentClearlyLabeled: true, noSimulatedSuccess: true, noRemoteSubresources: true }, mobile: viewport(390, mobile), desktop: viewport(1440, desktop) };
  const evidence = new Map([jpeg, mobile, desktop].map(bytes => [hash(bytes), bytes]));
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input); requests.push(url); assert.equal(options?.redirect, "error");
    if (url === item.media!.demoURL) return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": websiteContentSecurityPolicy } });
    if (url === item.media!.imageURL) return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
    throw new Error("Unexpected network target");
  };
  const dependencies = { fetch: fetcher, now: () => new Date(now), readEvidence: async (sha: string) => {
    const bytes = evidence.get(sha); if (!bytes) throw new Error("Missing local evidence"); return bytes;
  } };
  return { item, review, evidence, requests, fetcher, dependencies };
}

async function store(root: string, f: ReturnType<typeof fixture>) {
  const directory = join(root, "web-review"); await mkdir(join(directory, "evidence"), { recursive: true });
  await writeFile(join(directory, "trust.json"), JSON.stringify(trust));
  await writeFile(join(directory, "reviews.json"), JSON.stringify({ version: 1, reviews: { [f.review.identity]: f.review } }));
  for (const descriptor of [f.review.preview, f.review.mobile.screenshot, f.review.desktop.screenshot])
    await writeFile(join(directory, "evidence", `${descriptor.sha256}.${descriptor.format}`), f.evidence.get(descriptor.sha256)!);
}

test("a trusted browser review binds exact hosted HTML, preview and both interaction records", async () => {
  const f = fixture(); await verifyWebsiteReview(f.item, f.review, trust, f.dependencies);
  assert.deepEqual(f.requests, [f.item.media!.demoURL, f.item.media!.imageURL]);
  const before = structuredClone(f.item);
  assert.equal(websiteMediaNeedsMirroring(f.item), false, "Daily must not re-encode an already reviewed screenshot or consult an old media map");
  assert.deepEqual(f.item, before);
  assert.equal(websiteMediaNeedsMirroring({ ...f.item, kind: "image" }), true);
});

test("missing or screenshot-only approval never proves mobile and desktop interactions", async () => {
  const changes: ((review: WebsiteReview) => void)[] = [
    value => { value.reviewerID = "untrusted"; }, value => { value.reviewedAt = "2099-01-01T00:00:00Z"; },
    value => { value.mobile.interactions = []; }, value => { value.desktop.interactions = []; },
    value => { value.desktop.screenshot = value.mobile.screenshot; }, value => { value.mobile.width = 1440; },
    value => { value.desktop.width = 390; }, value => { delete (value.attestations as Partial<WebsiteReview["attestations"]>).previewMatchesHostedArtifact; },
  ];
  for (const change of changes) { const f = fixture(); change(f.review);
    await assert.rejects(verifyWebsiteReview(f.item, f.review, trust, f.dependencies)); assert.deepEqual(f.requests, []); }
});

test("prompt whitespace, every attribution field, artifact and preview replacements invalidate the exact approval", async () => {
  const changes: ((item: Prompt) => void)[] = [
    value => { value.prompt += " "; }, value => { value.source.author = "another author"; },
    value => { value.source.revision = "b".repeat(40); }, value => { value.source.method += " revised"; },
    value => { value.source.repository = "https://github.com/example/replacement"; }, value => { value.source.license = "Unspecified"; },
    value => { value.media!.demoURL = `https://api.prompix.dev/examples/${"b".repeat(64)}.html`; },
    value => { value.media!.imageURL = `https://api.prompix.dev/media/${"b".repeat(64)}.jpg`; },
    value => { value.media!.imageURLs = [value.media!.imageURL!, `https://api.prompix.dev/media/${"b".repeat(64)}.jpg`]; },
    value => { value.media!.videoURL = `https://api.prompix.dev/media/${"b".repeat(64)}.mp4`; },
    value => { value.model += " changed"; }, value => { value.contentType = "skill"; }, value => { value.source.name = "X"; },
  ];
  for (const change of changes) { const f = fixture(); change(f.item);
    await assert.rejects(verifyWebsiteReview(f.item, f.review, trust, f.dependencies)); assert.deepEqual(f.requests, []); }
});

test("only exact approved-origin content-addressed demo paths and hosted JPEG previews enter web review", async () => {
  const urls = ["http://api.prompix.dev", "https://127.0.0.1", "https://localhost", "https://api.prompix.dev.evil.test", "https://user@api.prompix.dev", "https://prompix.dev"]
    .map(origin => `${origin}/examples/${hash(html)}.html`);
  urls.push(`https://api.prompix.dev/other/${hash(html)}.html`, `https://api.prompix.dev/examples/${hash(html)}.html?x=1`,
    `https://api.prompix.dev/examples/${hash(html)}.html#x`, `https://api.prompix.dev/examples/${hash(html)}.html\n`);
  for (const url of urls) { const f = fixture(); f.item.media!.demoURL = url;
    await assert.rejects(verifyWebsiteReview(f.item, f.review, trust, f.dependencies)); assert.deepEqual(f.requests, []);
    assert.throws(() => websiteMediaNeedsMirroring(f.item)); }
  for (const url of ["https://example.com/preview.jpg", `https://api.prompix.dev/media/${hash(jpeg)}.jpg?query=1`]) {
    const f = fixture(); f.item.media!.imageURL = url; assert.throws(() => websiteMediaNeedsMirroring(f.item));
  }
});

test("missing, corrupt and substituted local screenshot evidence fails before a hosted fetch", async () => {
  for (const variant of ["missing", "corrupt", "wrong-length"] as const) {
    const f = fixture();
    if (variant === "missing") f.evidence.delete(f.review.mobile.screenshot.sha256);
    if (variant === "corrupt") f.evidence.set(f.review.desktop.screenshot.sha256, Buffer.from("tampered"));
    if (variant === "wrong-length") f.review.preview.byteLength++;
    await assert.rejects(verifyWebsiteReview(f.item, f.review, trust, f.dependencies)); assert.deepEqual(f.requests, []);
  }
});

test("hosted redirects, wrong response URLs, CSP overrides, MIME changes and hash changes fail closed", async () => {
  const cases: (() => Response)[] = [
    () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } }),
    () => new Response("missing", { status: 404 }),
    () => new Response(html, { headers: { "Content-Type": "application/octet-stream", "Content-Security-Policy": websiteContentSecurityPolicy } }),
    () => new Response(html, { headers: { "Content-Type": "text/html" } }),
    () => new Response(html, { headers: { "Content-Type": "text/html", "Content-Security-Policy": `${websiteContentSecurityPolicy}; connect-src https:` } }),
    () => new Response(html, { headers: { "Content-Type": "text/html", "Content-Security-Policy": websiteContentSecurityPolicy.replace("sandbox allow-scripts", "sandbox allow-scripts allow-same-origin") } }),
    () => new Response("different HTML", { headers: { "Content-Type": "text/html", "Content-Security-Policy": websiteContentSecurityPolicy } }),
    () => { const response = new Response(html); Object.defineProperty(response, "url", { value: "https://evil.test" }); return response; },
    () => { const response = new Response(html); Object.defineProperty(response, "redirected", { value: true }); return response; },
  ];
  for (const response of cases) { const f = fixture();
    await assert.rejects(verifyWebsiteReview(f.item, f.review, trust, { ...f.dependencies, fetch: async () => response() })); }
});

test("decoded HTML and preview byte caps apply even when compressed length is small", async () => {
  for (const preview of [false, true]) {
    const f = fixture(), limit = preview ? 8_000_000 : websiteArtifactByteLimit;
    await assert.rejects(verifyWebsiteReview(f.item, f.review, trust, { ...f.dependencies, fetch: async (url, options) => {
      if (preview && String(url) === f.item.media!.demoURL) return f.fetcher(url, options);
      return new Response(new Uint8Array(limit + 1), { headers: { "Content-Type": preview ? "image/jpeg" : "text/html",
        "Content-Security-Policy": websiteContentSecurityPolicy, "Content-Length": "1", "Content-Encoding": "gzip" } });
    } }), /size limit/);
  }
});

test("the public preview is verified separately from private screenshot evidence", async () => {
  for (const kind of ["missing", "redirect", "type", "changed"]) { const f = fixture();
    await assert.rejects(verifyWebsiteReview(f.item, f.review, trust, { ...f.dependencies, fetch: async (url, options) => {
      if (String(url) === f.item.media!.demoURL) return f.fetcher(url, options);
      return new Response(kind === "changed" ? Buffer.from("changed preview") : jpeg,
        { status: kind === "missing" ? 404 : kind === "redirect" ? 302 : 200, headers: { "Content-Type": kind === "type" ? "image/png" : "image/jpeg" } });
    } }), /preview/);
  }
});

test("operator store rejects mismatched keys, malformed files and symlinked evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "website-store-")), f = fixture();
  try {
    const missing = await websiteReviewer(root, f.fetcher); await assert.rejects(missing(f.item), /trusted reviewer/);
    await store(root, f);
    const reviewer = await websiteReviewer(root, f.fetcher); await reviewer(f.item);
    const evidencePath = join(root, "web-review/evidence", `${f.review.preview.sha256}.jpg`);
    await rm(evidencePath); await writeFile(join(root, "outside.jpg"), jpeg); await symlink(join(root, "outside.jpg"), evidencePath);
    await assert.rejects(reviewer(f.item));
    await writeFile(join(root, "web-review/reviews.json"), JSON.stringify({ version: 1, reviews: { ["a".repeat(64)]: f.review } }));
    await assert.rejects(websiteReviewer(root, f.fetcher), /identity/);
    await writeFile(join(root, "web-review/reviews.json"), "{"); await assert.rejects(websiteReviewer(root, f.fetcher));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daily website acceptance spends no image budget; stale hosted bytes cannot reuse an old snapshot or model", async t => {
  const root = await mkdtemp(join(tmpdir(), "website-daily-")), f = fixture();
  try {
    await store(root, f); t.mock.method(globalThis, "fetch", f.fetcher);
    const env = { PROMPIX_VISUAL_PROVIDER: "codex", PROMPIX_VISUAL_MAX_REQUESTS: "0", PROMPIX_CODEX: "/must-not-run" };
    const result = await prepareDailyVisualReview([f.item], [], root, true, env);
    assert.deepEqual(result.prompts, [f.item]); assert.equal(result.report.websitesReviewed, 1);
    assert.equal(result.report.requests, 0); assert.equal(result.report.prepared, 0);
    assert.deepEqual(await readdir(root), ["web-review"]);
    t.mock.method(globalThis, "fetch", async () => new Response("changed", { headers: { "Content-Type": "text/html", "Content-Security-Policy": websiteContentSecurityPolicy } }));
    const changed = await prepareDailyVisualReview([f.item], [f.item], root, true, env);
    assert.deepEqual(changed.prompts, []); assert.equal(changed.report.previousSnapshots, 0); assert.equal(changed.report.requests, 0);
    assert.deepEqual(retainPublishedLibrary(changed.prompts, [f.item], new Set(), () => "awaiting-media-review").prompts, [f.item]);
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Dry-run must not fetch"); });
    const dry = await prepareDailyVisualReview([f.item], [], root, false, env); assert.deepEqual(dry.prompts, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recollection restores durable editorial media overrides before exact website review without weakening safety gates", async t => {
  const root = await mkdtemp(join(tmpdir(), "website-recollection-")), f = fixture();
  try {
    await store(root, f); t.mock.method(globalThis, "fetch", f.fetcher);
    const fresh: Candidate = { ...f.item, media: null, fingerprint: fingerprint(f.item.prompt), featured: false, reviewStatus: "draft" };
    const reviews: Reviews = { [fresh.id]: { fingerprint: fresh.fingerprint, reviewedAt: now, metadata: {
      title: f.item.title, summary: f.item.summary, example: f.item.example, tags: f.item.tags, previewLabel: f.item.previewLabel,
      imageURL: f.item.media!.imageURL, demoURL: f.item.media!.demoURL!,
    } } };
    const reviewed = applyEditorialReviews([structuredClone(fresh)], reviews);
    const selected = selectLibrary(reviewed, new Set()); assert.equal(selected.length, 1);
    const { fingerprint: _, featured: __, reviewStatus: ___, editorialRank: ____, ...original } = selected[0];
    const planned = { ...original, prompt: publicationText(selected[0], reviews) };
    assert.deepEqual(planned.media, f.item.media);
    assert.equal(websiteMediaNeedsMirroring(planned), false);
    const result = await prepareDailyVisualReview([planned], [], root, true, {});
    assert.equal(result.report.websitesReviewed, 1); assert.deepEqual(result.prompts, [planned]);
    assert.equal(result.report.requests, 0); assert.equal(fresh.media, null, "Review must not mutate the replaceable discovery snapshot");
    assert.deepEqual(selectLibrary(applyEditorialReviews([fresh], {}), new Set()), [], "Website evidence does not grant metadata approval");
    assert.deepEqual(selectLibrary(reviewed, new Set([fresh.id])), [], "Tombstones still exclude the item");
    assert.deepEqual(selectLibrary([{ ...reviewed[0], title: "NSFW example" }], new Set()), [], "Existing content safety selection still applies");
    const changed = { ...fresh, prompt: fresh.prompt + " changed", fingerprint: fingerprint(fresh.prompt + " changed") };
    assert.deepEqual(selectLibrary(applyEditorialReviews([changed], reviews), new Set()), [], "Changed source text cannot reuse metadata approval");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("existing bundled web snapshots remain complete and new web artifacts use the existing native v1/v2 fields", async () => {
  const f = fixture();
  const originals = Array.from({ length: 6 }, (_, index): Prompt => ({ ...f.item, id: `studio-${index}`, prompt: `Original studio webpage ${index}`,
    source: { name: "Prompix Studio", url: null, license: "Original", method: "First-party original" }, media: null }));
  const retained = retainPublishedLibrary([f.item], originals, new Set()); assert.equal(retained.prompts.length, 7);
  assert.deepEqual(retained.prompts.slice(1), originals);
  const content = { title: f.item.title, summary: f.item.summary, prompt: f.item.prompt, example: f.item.example, previewLabel: f.item.previewLabel };
  f.item.localization = { sourceLanguage: "en", sourceFingerprint: translationFingerprint(f.item), translations: Object.fromEntries(localizationLanguages.map(locale => [locale, content])) };
  const catalog = catalogSchema.parse({ schemaVersion: 1, version: "synthetic-web-edition", publishedAt: now, prompts: [f.item] });
  const packs = splitLanguagePacks(catalog); assert.deepEqual(joinLanguagePacks(packs.manifestBytes, packs.baseBytes, packs.localeBytes), catalog);
  assert.equal(Object.keys(packs.localeBytes).length, 9);
  assert.equal(JSON.stringify(catalog).includes("reviewerID"), false); assert.equal(catalog.prompts[0].media!.demoURL, f.review.artifact.url);
});
