import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
  realpath,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(
  process.env.PROMPIX_CONTENT_DIR ??
    join(homedir(), ".local/share/prompix/content"),
);
const publishing = process.argv.includes("--publish");
const base = "https://api.prompix.dev";
const bucket = "prompix-content";
const mediaHosts = [
  "cms-assets.youmind.com",
  "cdn.youmind.com",
  "customer-qs6wnyfuv0gcybzj.cloudflarestream.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, path);
}
async function json<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}
async function upload(key: string, path: string, type: string) {
  await exec(
    process.env.PROMPIX_WRANGLER ?? "wrangler",
    [
      "r2",
      "object",
      "put",
      `${bucket}/${key}`,
      "--remote",
      "--file",
      path,
      "--content-type",
      type,
    ],
    {
      cwd: repo,
      timeout: 120000,
      maxBuffer: 100000,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
    },
  );
}
async function aspectRatio(path: string): Promise<number> {
  const result = await exec('/usr/bin/sips', ['-g','pixelWidth','-g','pixelHeight',path], {timeout:30000});
  const width = Number(result.stdout.match(/pixelWidth: (\d+)/)?.[1]);
  const height = Number(result.stdout.match(/pixelHeight: (\d+)/)?.[1]);
  if (!width || !height) throw new Error('Invalid image dimensions');
  return width / height;
}
async function run() {
  await mkdir(root, { recursive: true });
  const rel = relative(await realpath(repo), await realpath(root));
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel)))
    throw new Error("Content must stay outside repository");
  const lock = join(root, "daily.lock");
  try {
    await mkdir(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const owner = await json<{ pid: number } | null>(
      join(lock, "owner.json"),
      null,
    );
    let alive = false;
    try {
      if (owner) {
        process.kill(owner.pid, 0);
        alive = true;
      }
    } catch {}
    if (alive || Date.now() - (await stat(lock)).mtimeMs < 3600000)
      throw new Error("Another collection is running");
    await rm(lock, { recursive: true });
    await mkdir(lock);
  }
  await atomic(join(lock, "owner.json"), { pid: process.pid });
  const report: {
    startedAt: string;
    published: boolean;
    version?: string;
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
    const moderation = await json<{ removedIDs: string[] }>(
      join(root, "moderation.json"),
      { removedIDs: [] },
    );
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
          const media = { ...prompt.media };
          for (const field of ["imageURL", "videoURL"] as const) {
            const url = media[field];
            if (!url) continue;
            if (mediaMap[url]) {
              media[field] = mediaMap[url];
              if (field === 'imageURL') {
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
              field === "videoURL" ? 60_000_000 : 20_000_000,
            );
            const video = field === "videoURL";
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
                aspects[url] = await aspectRatio(output); media.aspectRatio = aspects[url];
                await atomic(join(root,'media-aspects.json'),aspects);
              }
              const hash = createHash("sha256")
                .update(await readFile(output))
                .digest("hex");
              const key = `media/${hash}.${video ? "mp4" : "jpg"}`;
              await upload(key, output, video ? "video/mp4" : "image/jpeg");
              media[field] = `${base}/${key}`;
              mediaMap[url] = media[field];
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
    const contentHash = fingerprint(
      JSON.stringify({ prompts, removedIDs: moderation.removedIDs }),
    );
    const version = `edition-${contentHash.slice(0, 16)}`;
    const latestPath = join(root, "latest.json");
    const current = await json<{ version?: string }>(latestPath, {});
    if (current.version === version && publishing) {
      report.version = version;
      report.published = true;
      return;
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
      publishedAt: catalog.publishedAt,
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
      report.published = true;
    }
    report.version = version;
  } finally {
    await atomic(join(root, "status.json"), {
      ...report,
      finishedAt: new Date().toISOString(),
    });
    console.log(JSON.stringify(report));
    await rm(lock, { recursive: true });
  }
}
run().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
