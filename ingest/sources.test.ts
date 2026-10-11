import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseYouMind,
  repositories,
  selectEdition,
  parseCommunityCSV,
  collectRepository,
  parseVideoArchive,
  mergeCandidates,
  videoArchive,
} from "./sources.ts";
import { download } from "./network.ts";
import { applyEditorialReviews } from "./editorial.ts";
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
  assert.equal(selectEdition(parsed, new Set([parsed[0].id]), 10).length, 0);
  assert.equal(
    parseYouMind(
      block.replace("- **Source:**", "- Removed:"),
      repositories[0],
      "abc",
    ).length,
    0,
  );
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
  assert.equal(selectEdition(archive, new Set(), 12).length, 0);
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
  assert.equal(mergeCandidates(archive, [duplicate]).length, 1);
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
  assert.equal(selectEdition(approved, new Set(), 12).length, 1);
  assert.equal(selectEdition(approved, new Set([live[0].id]), 12).length, 0);
  assert.equal(applyEditorialReviews(merged, reviews)[0].editorialRank, undefined);
});
