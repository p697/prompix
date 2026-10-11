import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repo, contentRoot as root, base, atomic, json, lockContent, upload, moderationSchema, currentManifest, remoteCatalog, editionVersion } from "./publication.ts";
import { catalogSchema, type Prompt } from "../packages/schema/catalog.ts";
import {
  repositories,
  collectRepository,
  parseYouMind,
  parseCommunityCSV,
  selectEdition,
  type Candidate,
  fingerprint,
} from "./sources.ts";
import { download } from "./network.ts";
import { searchX } from "./x.ts";
import { applyEditorialReviews, reviewsSchema } from "./editorial.ts";
const exec = promisify(execFile);
const publishing = process.argv.includes("--publish");
const resumePublishing = process.argv.includes("--resume-publishing");
if (resumePublishing && !publishing) throw new Error("--resume-publishing requires --publish");
const mediaHosts = [
  "cms-assets.youmind.com",
  "cdn.youmind.com",
  "customer-qs6wnyfuv0gcybzj.cloudflarestream.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];
async function aspectRatio(path: string): Promise<number> {
  const result = await exec('/usr/bin/sips', ['-g','pixelWidth','-g','pixelHeight',path], {timeout:30000});
  const width = Number(result.stdout.match(/pixelWidth: (\d+)/)?.[1]);
  const height = Number(result.stdout.match(/pixelHeight: (\d+)/)?.[1]);
  if (!width || !height) throw new Error('Invalid image dimensions');
  return width / height;
}
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
  } = {
    startedAt: new Date().toISOString(),
    published: false,
    sources: {},
    mediaErrors: [],
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
    const hold = await json<unknown | null>(join(root, "publication-hold.json"), null);
    if (publishing && hold && !resumePublishing) {
      report.publicationHold = hold;
      return;
    }
    const moderation = moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] }));
    if (publishing) {
      // Preserve remote tombstones even if local moderation state has been restored from an older backup.
      const remote = await remoteCatalog(await currentManifest());
      moderation.removedIDs = [...new Set([...moderation.removedIDs, ...(remote.removedIDs ?? [])])].sort();
      await atomic(join(root, "moderation.json"), moderation);
    }
    const excluded = new Set(moderation.removedIDs);
    const reviewed = applyEditorialReviews(all, reviewsSchema.parse(await json(join(root, "editorial.json"), {})));
    const picked: Candidate[] = [];
    // Balanced mix: original text/web ideas remain available alongside real community imagery.
    for (const source of repositories)
      picked.push(
        ...selectEdition(
          reviewed.filter((x) => x.id.startsWith(source.id)),
          excluded,
          source.kind === "video" ? 6 : 12,
        ),
      );
    for (const kind of ["text", "web"] as const)
      picked.push(
        ...selectEdition(
          reviewed.filter((x) => x.id.startsWith("pc-") && x.kind === kind),
          excluded,
          kind === "text" ? 16 : 8,
        ),
      );
    picked.sort((a, b) => (b.editorialRank ?? -1) - (a.editorialRank ?? -1));
    const mediaMap = await json<Record<string, string>>(
      join(root, "media-map.json"),
      {},
    );
    const aspects = await json<Record<string,number>>(join(root,"media-aspects.json"),{});
    const published: Prompt[] = [];
    for (const candidate of picked) {
      const {
        fingerprint: _,
        featured: __,
        reviewStatus: ___,
        editorialRank: ____,
        ...prompt
      } = candidate;
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
              if (!video)
                await exec(
                  "/usr/bin/sips",
                  [
                    "-s",
                    "format",
                    "jpeg",
                    "-s",
                    "formatOptions",
                    "82",
                    "-Z",
                    "1200",
                    input,
                    "--out",
                    output,
                  ],
                  { timeout: 30000 },
                );
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
      }
    }
    const bundled = catalogSchema
      .parse(
        JSON.parse(
          await readFile(
            join(repo, "ios/Prompix/Resources/catalog.json"),
            "utf8",
          ),
        ),
      )
      .prompts.filter((x) => !excluded.has(x.id));
    // New community cards lead, with original ideas interleaved to preserve all four modalities.
    const groups = [
      published.filter((x) => x.kind === "image"),
      bundled.filter((x) => x.kind === "text"),
      published.filter((x) => x.kind === "video"),
      bundled.filter((x) => x.kind === "web"),
      published.filter((x) => x.kind === "text"),
      published.filter((x) => x.kind === "web"),
      // Keep development motion studies and abstract placeholders out of public editions.
      bundled.filter((x) => x.kind === "image" && x.media?.image),
    ];
    const prompts: Prompt[] = [];
    const seen = new Set<string>();
    for (let row = 0; groups.some((g) => g.length > row); row++)
      for (const group of groups) {
        const p = group[row];
        if (p && !seen.has(fingerprint(p.prompt))) {
          prompts.push(p);
          seen.add(fingerprint(p.prompt));
        }
      }
    if (
      publishing &&
      published.filter((p) => p.source.name === "YouMind OpenLab").length < 6
    )
      throw new Error(
        "Too few verified community previews; current release preserved",
      );
    const version = editionVersion(prompts, moderation.removedIDs);
    const latestPath = join(root, "latest.json");
    const current = await json<{ version?: string }>(latestPath, {});
    if (current.version === version && publishing) {
      const active = await currentManifest();
      if (active.version === version) {
        await remoteCatalog(active);
        report.version = version;
        report.published = true;
        if (resumePublishing) await rm(join(root, "publication-hold.json"), { force: true });
        return;
      }
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
