import { selectLibrary } from "./library.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseYouMind,
  repositories,
  parseCommunityCSV,
  collectRepository,
  parseVideoArchive,
  mergeCandidates,
  videoArchive,
} from "./sources.ts";
import { download } from "./network.ts";
import { applyEditorialReviews } from "./editorial.ts";
import { automaticReviewEligibility } from "./editorial-runner.ts";
test("repository collection rejects unlisted sources and files before starting Git", async () => {
  await assert.rejects(collectRepository("other/private", "README_zh.md"), /not allowlisted/);
  await assert.rejects(collectRepository(repositories[0].repo, "../../secret"), /not allowlisted/);
  await assert.rejects(collectRepository("f/prompts.chat", "README_zh.md"), /not allowlisted/);
});
const block =
  '### No. 1: Folded paper city\n\n#### 📖 Description\n\nCreate a city made of folded paper.\n\n#### 📝 Prompt\n\n```\nBuild an original miniature paper city with folded roofs and warm light. Keep the background quiet and make shadows soft.\n```\n<img src="https://cms-assets.youmind.com/media/test.jpg">\n- **Author:** [Studio](https://x.com/studio)\n- **Source:** [Post](https://x.com/studio/status/123)\n';
test("source parser retains provenance and rejects incomplete cards; editorial gate respects removals", () => {
  const parsed = parseYouMind(block + "\n" + block, repositories[0], "abc");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].source.author, "Studio");
  assert.equal(
    parsed[0].media?.imageURL,
    "https://cms-assets.youmind.com/media/test.jpg",
  );
  assert.equal(selectLibrary(parsed, new Set([parsed[0].id])).length, 0);
  assert.equal(
    parseYouMind(
      block.replace("- **Source:**", "- Removed:"),
      repositories[0],
      "abc",
    ).length,
    0,
  );
});
test("GPT Image 1.5 preserves repository attribution and has distinct stable source IDs", () => {
  const source = repositories.find(item => item.id === "youmind-gpt-image-15")!;
  const revision = "a".repeat(40);
  const [item] = parseYouMind(block, source, revision);
  assert.equal(repositories[2].id, "youmind-seedance", "Appending a source must preserve existing source order");
  assert.match(item.id, /^youmind-gpt-image-15-[a-f0-9]{16}$/);
  assert.equal(item.kind, "image");
  assert.equal(item.model, "GPT Image 1.5");
  assert.equal(item.toolURL, "https://chatgpt.com/");
  assert.deepEqual(item.source, {
    name: "YouMind OpenLab", url: "https://x.com/studio/status/123", author: "Studio",
    license: "CC-BY-4.0", method: "社区收录", repository: `https://github.com/${source.repo}`, revision,
  });
  assert.equal(item.creator?.username, "studio");
  assert.equal(item.media?.imageURL, "https://cms-assets.youmind.com/media/test.jpg");
  assert.equal(parseYouMind(block.replace("paper city with", "paper village with"), source, "b".repeat(40))[0].id, item.id);
  assert.notEqual(parseYouMind(block, repositories[1], revision)[0].id, item.id);
  assert.deepEqual(parseYouMind(block.replace(/<img[^>]+>/, ""), source, revision), []);
});
test("GPT Image 1.5 follows current-fingerprint editorial review before library publication", () => {
  const source = repositories.find(item => item.id === "youmind-gpt-image-15")!;
  const items = parseYouMind(block, source, "a".repeat(40));
  const [item] = items;
  assert.equal(automaticReviewEligibility(item), undefined, "The allowlisted image source can enter automatic metadata review");
  const unreviewed = applyEditorialReviews(items, {});
  assert.equal(unreviewed[0].reviewStatus, "draft");
  assert.deepEqual(selectLibrary(unreviewed, new Set()), []);
  const reviews = { [item.id]: {
    fingerprint: item.fingerprint, reviewedAt: "2026-10-12T00:00:00.000Z",
    metadata: { title: "A paper neighborhood", summary: "Explore folded paper rooftops.",
      example: "使用建议：描述你想要的建筑与灯光。", tags: ["Craft"], previewLabel: "来源附图" },
  } };
  const approved = applyEditorialReviews(items, reviews);
  assert.deepEqual(selectLibrary(approved, new Set()).map(value => value.id), [item.id]);
  assert.equal(approved[0].prompt, item.prompt);
  assert.deepEqual(approved[0].source, item.source);
  assert.deepEqual(approved[0].media, item.media);
  assert.deepEqual(selectLibrary(approved, new Set([item.id])), []);
  const edited = parseYouMind(block.replace("paper city with", "paper village with"), source, "b".repeat(40));
  assert.deepEqual(selectLibrary(applyEditorialReviews(edited, reviews), new Set()), [], "A changed source body needs its own review");
});
test("community parser distinguishes a website brief from ordinary text and preserves multiline CSV", () => {
  const items = parseCommunityCSV(
    'act,prompt,type,contributor\nWebsite brief,"Build a website with HTML,\nand CSS",TEXT,studio\nTarot,"Ask a reflective question",TEXT,studio\n',
    "abc",
  );
  assert.deepEqual(
    items.map((x) => x.kind),
    ["web", "text"],
  );
  assert.match(items[0].prompt, /\nand CSS/);
});
test("network boundary rejects unknown hosts and credentials before a request", async () => {
  await assert.rejects(
    download("https://127.0.0.1/private", ["raw.githubusercontent.com"]),
  );
  await assert.rejects(
    download("http://raw.githubusercontent.com/file", [
      "raw.githubusercontent.com",
    ]),
  );
  await assert.rejects(
    download("https://user:pass@raw.githubusercontent.com/file", [
      "raw.githubusercontent.com",
    ]),
  );
});

const videoBlock = block
  .replace("### No. 1: Folded paper city", "### Folded paper city")
  .replace("#### 📖 Description\n\nCreate a city made of folded paper.", "> Create a city made of folded paper.")
  + '<a href="https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts/releases/download/videos/123.mp4">Watch</a>\n';
test("video parser accepts both archive headings and blockquote summaries without inventing media", () => {
  const source = repositories[2];
  const live = parseYouMind(videoBlock.replace("### Folded", "### No. 1: Folded"), source, "new-revision");
  const legacy = parseYouMind(block + '<a href="https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts/releases/download/videos/123.mp4">Watch</a>', source, "old-revision");
  const archive = parseVideoArchive(videoBlock);
  assert.equal(archive.length, 1);
  assert.equal(archive[0].id, live[0].id);
  assert.equal(archive[0].id, legacy[0].id);
  assert.equal(archive[0].source.revision, videoArchive.revision);
  assert.equal(archive[0].source.repository, `https://github.com/${videoArchive.repo}`);
  assert.equal(archive[0].source.author, "Studio");
  assert.equal(archive[0].source.license, "CC-BY-4.0");
  assert.equal(archive[0].reviewStatus, "draft");
  assert.equal(selectLibrary(archive, new Set()).length, 0);
  const watchPage = videoBlock.replace(/https:[^\"]+123\.mp4/, "https://youmind.com/seedance-2-0-prompts?id=123");
  assert.deepEqual(parseVideoArchive(watchPage), []);
  assert.equal(parseVideoArchive(watchPage + "\n" + videoBlock.replaceAll("123", "456")).length, 1);
});
test("current source wins archive duplicates; reviews bind to exact text and removals keep stable IDs", () => {
  const archive = parseVideoArchive(videoBlock);
  const live = parseYouMind(videoBlock.replace("paper city with", "paper village with"), repositories[2], "new-revision");
  const duplicate = { ...archive[0], id: "youmind-seedance-other-post" };
  const merged = mergeCandidates(live, archive, [duplicate]);
  assert.equal(merged.filter(item => item.id === live[0].id).length, 1);
  assert.equal(merged[0].prompt, live[0].prompt);
  assert.equal(merged[0].source.revision, "new-revision");
  assert.equal(mergeCandidates(archive, [duplicate]).length, 2);
  assert.equal(selectLibrary([archive[0], duplicate].map(item => ({ ...item, reviewStatus: "candidate" as const })), new Set()).length, 1);
  const reviews = {
    [archive[0].id]: {
      fingerprint: archive[0].fingerprint,
      reviewedAt: new Date(0).toISOString(),
      metadata: {
        title: "A paper neighborhood", summary: "Explore warm folded paper rooftops.",
        example: "The camera glides across a small paper city.", tags: ["Craft"],
        previewLabel: "Creator example", priority: 80,
      },
    },
  };
  const approved = applyEditorialReviews(archive, reviews);
  assert.equal(selectLibrary(approved, new Set()).length, 1);
  assert.equal(selectLibrary(approved, new Set([live[0].id])).length, 0);
  assert.equal(applyEditorialReviews(merged, reviews)[0].editorialRank, undefined);
});

test("video source headings inside fenced prompts preserve text and subsequent records", () => {
  const markdownPrompt = videoBlock.replace(
    "Keep the background quiet and make shadows soft.",
    "Keep the background quiet and make shadows soft.\n### Camera direction\nEnd with a wide shot.",
  );
  const next = videoBlock.replaceAll("123", "456").replace("paper city with", "paper village with");
  const parsed = parseVideoArchive(markdownPrompt + "\n" + next);
  assert.equal(parsed.length, 2);
  assert.match(parsed[0].prompt, /\n### Camera direction\nEnd with a wide shot\.$/);
  assert.equal(parsed[0].source.url, "https://x.com/studio/status/123");
  assert.equal(parsed[1].source.url, "https://x.com/studio/status/456");
});

test("every current post owns its ID before fingerprint deduplication", () => {
  const archive = parseVideoArchive(videoBlock);
  const changed = videoBlock.replace("paper city with", "paper village with");
  const live = parseYouMind(changed.replaceAll("123", "456") + "\n" + changed, repositories[2], "new-revision");
  assert.equal(live.length, 2, "Identical current text must not discard a second source post's identity");
  const merged = mergeCandidates(live, archive);
  const originalPost = merged.find(item => item.id === archive[0].id)!;
  assert.equal(originalPost.prompt, live[1].prompt);
  assert.equal(originalPost.source.revision, "new-revision");
  assert.notEqual(originalPost.fingerprint, archive[0].fingerprint);
  assert.equal(selectLibrary(merged, new Set()).length, 1, "Eligible duplicates are removed within their channel");
});

test("watch-page drafts block changed archive text and reuse only unchanged complete examples", () => {
  const archive = parseVideoArchive(videoBlock);
  const watchPage = videoBlock.replace(/https:[^\"]+123\.mp4/, "https://youmind.com/seedance-2-0-prompts?id=123");
  const live = parseYouMind(watchPage, repositories[2], "new-revision");
  assert.equal(live.length, 1);
  assert.equal(live[0].reviewStatus, "draft");
  assert.equal(live[0].media?.videoURL, undefined);
  assert.equal(selectLibrary(live, new Set()).length, 0);
  const unchanged = mergeCandidates(live, archive);
  assert.equal(unchanged[0].source.revision, videoArchive.revision);
  assert.equal(unchanged[0].reviewStatus, "draft");
  const reviews = {
    [archive[0].id]: {
      fingerprint: archive[0].fingerprint, reviewedAt: new Date(0).toISOString(),
      metadata: { title: "A paper neighborhood", summary: "Warm folded paper rooftops.", example: "A paper city.", tags: ["Craft"], previewLabel: "Creator example", priority: 80 },
    },
  };
  const approved = applyEditorialReviews(unchanged, reviews);
  assert.equal(selectLibrary(approved, new Set()).length, 1);
  assert.equal(selectLibrary(approved, new Set([archive[0].id])).length, 0);
  const changed = parseYouMind(watchPage.replace("paper city with", "paper village with").replace(/<img[^>]+>/, ""), repositories[2], "changed-revision");
  assert.equal(changed.length, 1, "Missing poster and MP4 must still preserve current identity");
  const merged = mergeCandidates(changed, archive);
  assert.equal(merged[0].source.revision, "changed-revision");
  assert.equal(applyEditorialReviews(merged, reviews)[0].reviewStatus, "draft");
  assert.equal(selectLibrary(applyEditorialReviews(merged, reviews), new Set()).length, 0);
  reviews[archive[0].id].fingerprint = changed[0].fingerprint;
  assert.equal(selectLibrary(applyEditorialReviews(merged, reviews), new Set()).length, 0,
    "Reviewing changed text cannot invent a missing video/poster pair");
});
