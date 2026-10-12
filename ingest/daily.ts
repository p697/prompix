import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { repo, contentRoot as root, base, atomic, json, lockContent, upload, moderationSchema, currentManifest, remoteCatalog, editionVersion } from "./publication.ts";
import { catalogSchema, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import {
  repositories,
  collectRepository,
  parseYouMind,
  parseCommunityCSV,
  type Candidate,
  mergeCandidates,
  videoArchive,
} from "./sources.ts";
import { download } from "./network.ts";
import { searchX } from "./x.ts";
import { applyEditorialReviews, reviewsSchema } from "./editorial.ts";
import { aspectRatio, prepareJPEG, publishStudioImages } from "./images.ts";
import { publicationText } from "./templates.ts";
import { assertLibraryDownloadSize, countByKind, interleaveLibrary, libraryDelta, selectLibrary, type KindCounts } from "./library.ts";
const publishing = process.argv.includes("--publish");
const resumePublishing = process.argv.includes("--resume-publishing");
if (resumePublishing && !publishing) throw new Error("--resume-publishing requires --publish");
const mediaHosts = [
  "api.prompix.dev",
  "cms-assets.youmind.com",
  "cdn.youmind.com",
  "customer-qs6wnyfuv0gcybzj.cloudflarestream.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];
async function run() {
  const unlock = await lockContent(root);
  const report: {
    startedAt: string;
    published: boolean;
    version?: string;
    publicationHold?: unknown;
    error?: string;
    sources: Record<string, unknown>;
    mediaErrors: string[];
    changed?: boolean;
    comparisonVersion?: string;
    changes?: ReturnType<typeof libraryDelta>;
    counts: {
      candidates: KindCounts | null;
      reviewed: KindCounts | null;
      eligible: KindCounts | null;
      bundled: KindCounts | null;
      prepared: KindCounts | null;
      published: KindCounts | null;
      mediaFailed: KindCounts;
    };
  } = {
    startedAt: new Date().toISOString(),
    published: false,
    sources: {},
    mediaErrors: [],
    counts: { candidates: null, reviewed: null, eligible: null, bundled: null, prepared: null, published: null, mediaFailed: countByKind([]) },
  };
  try {
    const all: Candidate[] = [];
    for (const source of [
      ...repositories,
      { id: "prompts-chat", repo: "f/prompts.chat" },
    ]) {
      const path = join(root, "candidates", `${source.id}.json`);
      try {
        const raw = await collectRepository(
          source.repo,
          source.id === "prompts-chat" ? "prompts.csv" : "README_zh.md",
        );
        const candidates =
          "kind" in source
            ? parseYouMind(raw.text, source, raw.revision)
            : parseCommunityCSV(raw.text, raw.revision);
        if (!candidates.length)
          throw new Error("Empty parsed source; retaining previous snapshot");
        await atomic(path, candidates);
        all.push(...candidates);
        report.sources[source.id] = {
          status: "ok",
          count: candidates.length,
          revision: raw.revision,
        };
      } catch (e) {
        all.push(...(await json<Candidate[]>(path, [])));
        report.sources[source.id] = { status: "failed", message: String(e) };
      }
    }
    const xStatePath = join(root, "x-state.json");
    const xState = await json<{ day?: string; newest?: string }>(
      xStatePath,
      {},
    );
    const day = new Date().toISOString().slice(0, 10);
    if (process.env.X_BEARER_TOKEN && xState.day !== day) {
      // Persist the daily attempt BEFORE making a paid request. No retries on ambiguous responses.
      await atomic(xStatePath, { ...xState, day });
      try {
        const result = await searchX(process.env.X_BEARER_TOKEN, xState.newest);
        await atomic(join(root, "x-discovery", `${day}.json`), {
          ...result,
          reviewStatus: "draft",
        });
        await atomic(xStatePath, {
          day,
          newest: result.newest ?? xState.newest,
        });
        report.sources.x = { status: "ok", count: result.posts.length };
      } catch (e) {
        report.sources.x = { status: "failed", message: String(e) };
      }
    } else
      report.sources.x = {
        status: process.env.X_BEARER_TOKEN ? "daily-limit" : "not-configured",
      };
    const archive = await json<Candidate[]>(join(root, "candidates", `${videoArchive.id}.json`), []);
    report.sources[videoArchive.id] = {
      status: archive.length ? "staged" : "not-staged",
      count: archive.length,
      revision: videoArchive.revision,
    };
    const reviews = reviewsSchema.parse(await json(join(root, "editorial.json"), {}));
    const candidates = mergeCandidates(all, archive);
    const reviewed = applyEditorialReviews(candidates, reviews);
    report.counts.candidates = countByKind(candidates);
    report.counts.reviewed = countByKind(reviewed.filter((item) => item.reviewStatus === "candidate"));
    const hold = await json<unknown | null>(join(root, "publication-hold.json"), null);
    if (publishing && hold && !resumePublishing) {
      report.publicationHold = hold;
      return;
    }
    const moderation = moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] }));
    let previous: Catalog | undefined;
    let previousManifest: Awaited<ReturnType<typeof currentManifest>> | undefined;
    if (publishing) {
      // Compare against the verified online library, not a possibly stale local latest.json.
      previousManifest = await currentManifest();
      previous = await remoteCatalog(previousManifest);
      report.comparisonVersion = previous.version;
      moderation.removedIDs = [...new Set([...moderation.removedIDs, ...(previous.removedIDs ?? [])])].sort();
      await atomic(join(root, "moderation.json"), moderation);
    }
    const excluded = new Set(moderation.removedIDs);
    const picked = selectLibrary(reviewed, excluded);
    report.counts.eligible = countByKind(picked);
    const planned = picked.map((candidate): Prompt => {
      const { fingerprint: _, featured: __, reviewStatus: ___, editorialRank: ____, ...prompt } = candidate;
      return { ...prompt, prompt: publicationText(candidate, reviews) };
    });
    let bundled = catalogSchema.parse(JSON.parse(await readFile(join(repo, "ios/Prompix/Resources/catalog.json"), "utf8")))
      .prompts.filter((item) => !excluded.has(item.id));
    report.counts.bundled = countByKind(bundled);
    // Fail before uploading media if the complete library exceeds the current client protocol.
    interleaveLibrary(planned, bundled, excluded);
    const mediaMap = await json<Record<string, string>>(
      join(root, "media-map.json"),
      {},
    );
    const aspects = await json<Record<string,number>>(join(root,"media-aspects.json"),{});
    const published: Prompt[] = [];
    for (const prompt of planned) {
      try {
        if (prompt.media && publishing) {
          const media = { ...prompt.media, ...(prompt.media.imageURLs ? { imageURLs: [...prompt.media.imageURLs] } : {}) };
          const targets = [
            ...(["imageURL", "videoURL"] as const).flatMap(field => media[field] ? [{
              url: media[field]!, video: field === "videoURL", cover: field === "imageURL",
              assign: (url: string) => { media[field] = url; },
            }] : []),
            ...(media.imageURLs ?? []).map((url, index) => ({
              url, video: false, cover: false,
              assign: (mirrored: string) => { media.imageURLs![index] = mirrored; },
            })),
          ];
          for (const target of targets) {
            const { url, video, cover } = target;
            if (mediaMap[url]) {
              target.assign(mediaMap[url]);
              if (cover) {
                if (!aspects[url]) {
                  const cached = await download(mediaMap[url], ['api.prompix.dev'], 8_000_000);
                  const file = join(root, `aspect-${process.pid}.jpg`);
                  try { await writeFile(file,cached.bytes); aspects[url] = await aspectRatio(file); }
                  finally { await rm(file,{force:true}); }
                  await atomic(join(root,'media-aspects.json'),aspects);
                }
                media.aspectRatio = aspects[url];
              }
              continue;
            }
            const data = await download(
              url,
              mediaHosts,
              video ? 60_000_000 : 20_000_000,
            );
            if (video && data.bytes.subarray(4, 8).toString() !== "ftyp")
              throw new Error("Invalid MP4 signature");
            if (
              video
                ? data.type !== "video/mp4" &&
                  data.type !== "application/octet-stream"
                : !["image/jpeg", "image/png", "image/webp"].includes(data.type)
            )
              throw new Error("Unexpected media type");
            await mkdir(join(root, "tmp"), { recursive: true });
            const input = join(
              root,
              "tmp",
              `media-${process.pid}.${video ? "mp4" : data.type === "image/png" ? "png" : data.type === "image/webp" ? "webp" : "jpg"}`,
            );
            const output = video
              ? input
              : join(root, "tmp", `preview-${process.pid}.jpg`);
            try {
              await writeFile(input, data.bytes);
              if (!video) await prepareJPEG(input, output);
              if (!video) {
                aspects[url] = await aspectRatio(output); if (cover) media.aspectRatio = aspects[url];
                await atomic(join(root,'media-aspects.json'),aspects);
              }
              const hash = createHash("sha256")
                .update(await readFile(output))
                .digest("hex");
              const key = `media/${hash}.${video ? "mp4" : "jpg"}`;
              await upload(key, output, video ? "video/mp4" : "image/jpeg");
              mediaMap[url] = `${base}/${key}`;
              target.assign(mediaMap[url]);
              await atomic(join(root, "media-map.json"), mediaMap);
            } finally {
              await rm(input, { force: true });
              if (output !== input) await rm(output, { force: true });
            }
          }
          prompt.media = media;
        }
        published.push(prompt);
      } catch (e) {
        report.mediaErrors.push(`${prompt.id}: ${String(e)}`);
        report.counts.mediaFailed.total++;
        report.counts.mediaFailed[prompt.kind]++;
      }
    }
    if (publishing) {
      bundled = await publishStudioImages(bundled, join(repo, "ios/Prompix/Resources/Assets.xcassets"), mediaMap, async input => {
        await mkdir(join(root, "tmp"), { recursive: true });
        const output = join(root, "tmp", `studio-${process.pid}.jpg`);
        try {
          await prepareJPEG(input, output);
          const hash = createHash("sha256").update(await readFile(output)).digest("hex");
          const key = `media/${hash}.jpg`;
          await upload(key, output, "image/jpeg");
          return `${base}/${key}`;
        } finally { await rm(output, { force: true }); }
      });
      await atomic(join(root, "media-map.json"), mediaMap);
    }
    const prompts = interleaveLibrary(published, bundled, excluded);
    report.counts.prepared = countByKind(prompts);
    if (previous) report.changes = libraryDelta(previous.prompts, prompts);
    if (
      publishing &&
      published.filter((p) => p.source.name === "YouMind OpenLab").length < 6
    )
      throw new Error(
        "Too few verified community previews; current release preserved",
      );
    const version = editionVersion(prompts, moderation.removedIDs);
    const latestPath = join(root, "latest.json");
    if (publishing && previousManifest?.version === version) {
      const active = await currentManifest();
      if (active.version === version && active.sha256 === previousManifest.sha256) {
        await remoteCatalog(active);
        await atomic(latestPath, active);
        report.version = version;
        report.published = true;
        report.changed = false;
        report.counts.published = countByKind(prompts);
        if (resumePublishing) await rm(join(root, "publication-hold.json"), { force: true });
        return;
      }
      throw new Error("The active library changed during preparation; refusing to overwrite it");
    }
    const catalog = catalogSchema.parse({
      schemaVersion: 1,
      version,
      publishedAt: new Date().toISOString(),
      removedIDs: moderation.removedIDs,
      prompts,
    });
    const release = join(root, "releases", version);
    await mkdir(release, { recursive: true });
    const catalogPath = join(release, "catalog.json");
    // Reuse identical version bytes on retry so published hashes never change.
    const existing = await json<unknown | null>(catalogPath, null);
    if (!existing) await atomic(catalogPath, catalog);
    const bytes = await readFile(catalogPath);
    assertLibraryDownloadSize(bytes);
    const manifest = {
      schemaVersion: 1,
      version,
      publishedAt: catalogSchema.parse(JSON.parse(bytes.toString())).publishedAt,
      count: prompts.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      catalog: `${base}/releases/${version}/catalog.json`,
    };
    const manifestPath = join(release, "manifest.json");
    await atomic(manifestPath, manifest);
    if (publishing) {
      await upload(
        `releases/${version}/catalog.json`,
        catalogPath,
        "application/json",
      );
      const verified = await download(manifest.catalog, ["api.prompix.dev"]);
      if (
        createHash("sha256").update(verified.bytes).digest("hex") !==
        manifest.sha256
      )
        throw new Error("Remote verification failed");
      // Activate LAST. Any earlier failure leaves clients on the previous complete edition.
      await upload("v1/latest.json", manifestPath, "application/json");
      await atomic(latestPath, manifest);
      const active = await currentManifest();
      if (active.version !== version || active.sha256 !== manifest.sha256) throw new Error("Activation verification failed");
      report.published = true;
      report.changed = true;
      report.counts.published = countByKind(prompts);
      if (resumePublishing) await rm(join(root, "publication-hold.json"), { force: true });
    }
    report.version = version;
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    try {
      await atomic(join(root, "status.json"), {
        ...report,
        finishedAt: new Date().toISOString(),
      });
      console.log(JSON.stringify(report));
    } finally { await unlock(); }
  }
}
run().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
