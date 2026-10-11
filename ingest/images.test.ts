import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSchema } from "../packages/schema/catalog.ts";
import { publishStudioImages } from "./images.ts";

test("studio mirrors preserve local fallback, reuse content hashes and refresh changed image bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-studio-"));
  try {
    const catalog = catalogSchema.parse(JSON.parse(await readFile(new URL("../ios/Prompix/Resources/catalog.json", import.meta.url), "utf8")));
    const item = catalog.prompts.find(p => p.kind === "image")!;
    const folder = join(root, item.media!.image + ".imageset");
    await mkdir(folder);
    await writeFile(join(folder, "Contents.json"), JSON.stringify({ images: [{ filename: "example.jpg" }] }));
    await writeFile(join(folder, "example.jpg"), "first image bytes");
    const cache: Record<string, string> = {};
    let uploads = 0;
    const publish = async () => `https://api.prompix.dev/media/${String(++uploads).repeat(64)}.jpg`;
    const first = (await publishStudioImages([item], root, cache, publish))[0];
    assert.equal(first.media?.image, item.media?.image);
    assert.equal(item.media?.imageURL, undefined);
    assert.deepEqual(first.source, item.source);
    await publishStudioImages([item], root, cache, publish);
    assert.equal(uploads, 1);
    await writeFile(join(folder, "example.jpg"), "changed image bytes");
    const second = (await publishStudioImages([item], root, cache, publish))[0];
    assert.equal(uploads, 2);
    assert.notEqual(first.media?.imageURL, second.media?.imageURL);
    await writeFile(join(folder, "Contents.json"), JSON.stringify({ images: [{ filename: "../private.jpg" }] }));
    await assert.rejects(() => publishStudioImages([item], root, cache, publish), /Invalid studio image resource/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
