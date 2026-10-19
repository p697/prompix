import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VerifiedCapacityRejection, isPreOutputCapacityRejection } from "./provider-capacity.ts";
import { reviewTranslationSemantics } from "./translation-semantic.ts";
import { translationFingerprint, translationText } from "./translation.ts";
import { catalogSchema } from "../packages/schema/catalog.ts";
const message = "Selected model is at capacity. Please try a different model.";
const events = [{ type: "thread.started", thread_id: "synthetic" }, { type: "turn.started" }, { type: "error", message }, { type: "turn.failed", error: { message } }];
const raw = events.map(e => JSON.stringify(e)).join("\n") + "\n";
test("capacity evidence never classifies partial generation, malformed output or different failures as safe retry", () => {
  assert.equal(isPreOutputCapacityRejection(raw), true);
  for (const bad of ["", "broken", raw + '{}', raw.replace(message, "network error"), JSON.stringify(events[3]),
    [...events.slice(0, 2), { type: "item.completed" }, ...events.slice(2)].map(e => JSON.stringify(e)).join("\n")]) {
    assert.equal(isPreOutputCapacityRejection(bad), false);
    assert.throws(() => new VerifiedCapacityRejection(bad));
  }
});
test("semantic capacity retry requires persisted events and absence of retained results", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-capacity-"));
  try {
    const fixture = catalogSchema.parse(JSON.parse(await readFile(new URL("../ios/Prompix/Resources/catalog.json", import.meta.url), "utf8"))).prompts[0];
    const original = { ...fixture, prompt: "Draw a quiet garden." };
    const item = { ...original, localization: { sourceLanguage: "en", sourceFingerprint: translationFingerprint(original), translations: { "zh-Hans": { ...translationText(original), prompt: "画一座安静的花园。" } } } };
    const executable = join(root, "provider");
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(raw)});process.exit(1);\n`);
    await chmod(executable, 0o700);
    const directory = join(root, "safe");
    await assert.rejects(reviewTranslationSemantics([item], "zh-Hans", directory, executable), VerifiedCapacityRejection);
    assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"), raw);
    for (const file of ["output.json", "result.json"]) {
      const retained = join(root, file); await mkdir(retained); await writeFile(join(retained, file), "{}");
      await assert.rejects(reviewTranslationSemantics([item], "zh-Hans", retained, executable), error => error instanceof Error && !(error instanceof VerifiedCapacityRejection));
    }
    const conflicting = join(root, "conflicting");await mkdir(conflicting);await writeFile(join(conflicting, "events.jsonl"), "retained unknown response");
    await assert.rejects(reviewTranslationSemantics([item], "zh-Hans", conflicting, executable), error => error instanceof Error && !(error instanceof VerifiedCapacityRejection));
  } finally { await rm(root, { recursive: true, force: true }); }
});
export { raw as syntheticCapacityEvents };
