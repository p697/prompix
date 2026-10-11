import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseYouMind,
  repositories,
  selectEdition,
  parseCommunityCSV,
} from "./sources.ts";
import { download } from "./network.ts";
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
