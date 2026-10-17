import { limitNewPublications } from "./publication-quota.ts";
import { withPublisherDatabase } from "./database-publication.ts";
import { prepareDiscoveredSkills } from "./discovered-skill-daily.ts";
import { preparePublisherSkills } from "./publisher-skill-daily.ts";
import { prepareXAvailability, filterXAvailability, assertXAvailability } from "./x-availability.ts";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { repo, contentRoot as root, base, atomic, json, upload, moderationSchema, currentManifest, remoteCatalog, editionVersion, writeCatalog, manifestSchema } from "./publication.ts";
import { withDailyStatus } from "./daily-status.ts";
import { catalogSchema, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import {
  repositories,
  collectRepository,
  parseCommunityCSV,
  type Candidate,
  mergeCandidates,
  videoArchive,
} from "./sources.ts";
import { download } from "./network.ts";
import { discoverX } from "./x-discovery.ts";
import { collectXDiscovery } from "./x-collection.ts";
import { readAllXIntake as readXIntake } from "./x-thread-intake.ts";
import { collectSkill, skillRepositoryRevision, skillSources } from "./skills.ts";
import { prepareClawHub, filterClawHubAvailability, assertClawHubAvailability } from "./clawhub-daily.ts";
import { enrichCreators, mergeCreatorCache, mirrorCreatorAvatars, type CreatorCache } from "./creators.ts";
import { publishAvatar } from "./creator-images.ts";
import { refreshCreatorProfiles } from "./creator-refresh.ts";
import { prepareDailyTranslations, type DailyTranslationStatus } from "./translation-daily.ts";
import { inheritPreviousTranslations } from "./translation.ts";
import { applyEditorialReviews, reviewsSchema } from "./editorial.ts";
import { prepareDailyEditorial } from "./editorial-daily.ts";
import type { EditorialReport } from "./editorial-runner.ts";
import { applyDailyVisualPresentation, prepareDailyVisualReview } from "./visual-daily.ts";
import { websiteMediaNeedsMirroring } from "./website-review.ts";
import type { VisualReport } from "./visual-review.ts";
import { aspectRatio, prepareJPEG, publishStudioImages } from "./images.ts";
import { publicationText } from "./templates.ts";
import { countByKind, interleaveLibrary, libraryDelta, retainPublishedLibrary, selectLibrary, type KindCounts, type RetentionReport } from "./library.ts";
import { beginDailyPublication, clearMatchingPublicationHold, prepareDailyStaging, publishDailyCatalog } from "./daily-publication.ts";
import { languagePackEditionVersion, preserveCatalogText, stageRelease } from "./release-publication.ts";
import { databaseLibraryLimit, preservePublicationInput } from "../services/feed/publication.ts";
import { applyQualityHolds, assertNoQualityHolds, readQualityHolds } from "./quality-holds.ts";
const publishing = process.argv.includes("--publish");
const resumePublishing = process.argv.includes("--resume-publishing");
if (resumePublishing && !publishing) throw new Error("--resume-publishing requires --publish");
const mediaHosts = [
  "api.prompix.dev",
  "pbs.twimg.com",
  "video.twimg.com",
  "cms-assets.youmind.com",
  "cdn.youmind.com",
  "customer-qs6wnyfuv0gcybzj.cloudflarestream.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];
async function run() {
  const report: {
    startedAt: string;
    published: boolean;
    version?: string;
    publicationHold?: unknown;
    error?: string;
    sources: Record<string, unknown>;
    mediaErrors: string[];
    avatarErrors: string[];
    translations?: DailyTranslationStatus;
    changed?: boolean;
    comparisonVersion?: string;
    recoveredPublication?: boolean;
    channels?: { v1: string; v2: string; v1Frozen: boolean };
    changes?: ReturnType<typeof libraryDelta>;
    retainedPrevious?: RetentionReport;
    editorial?: EditorialReport;
    visualReview?: VisualReport;
    qualityHeldIDs?: string[];
    registryWithheldIDs?: string[];
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
    avatarErrors: [],
    counts: { candidates: null, reviewed: null, eligible: null, bundled: null, prepared: null, published: null, mediaFailed: countByKind([]) },
  };
  await withDailyStatus(root, report, async () => {
    const qualityHolds = await readQualityHolds(root);
    // Registry availability must be fresh even when resuming a retained target.
    const xAvailability = await prepareXAvailability(root, { enabled: publishing, bearer: process.env.X_BEARER_TOKEN });
    report.sources["x-availability"] = xAvailability.report;
    if (publishing) {
      const removed = Object.entries(xAvailability.state).filter(([, state]) => state.removed).map(([id]) => id);
      if (removed.length) {
        const moderationPath = join(root, "moderation.json");
        const current = moderationSchema.parse(await json(moderationPath, { removedIDs: [] }));
        await atomic(moderationPath, { ...current, removedIDs: [...new Set([...current.removedIDs, ...removed])].sort() });
      }
    }
    const communitySkills = await prepareClawHub(root);
    report.sources.clawhub = communitySkills.report;
    // Reconcile retained publication work before any collectors or paid models run.
    const publication = publishing ? await beginDailyPublication(root, { resumePublishing }) : await prepareDailyStaging(root);
    const libraryLimit = publication.previous?.database ? databaseLibraryLimit : 1000;
    if (publication?.recovered) {
      const recovered = publication.recovered;
      report.version = recovered.authoritative.version;
      report.published = true;
      report.recoveredPublication = true;
      report.counts.published = countByKind(recovered.authoritative.prompts);
      report.channels = { v1: recovered.v1.manifest.version, v2: recovered.v2!.manifest.version, v1Frozen: recovered.state.v1Frozen };
      if (publication.held !== undefined) report.publicationHold = publication.held;
      return;
    }
    if (publication?.held !== undefined) { report.publicationHold = publication.held; return; }
    const publisherSkills = await preparePublisherSkills(root);
    report.sources["publisher-skills"] = publisherSkills.report;
    const all: Candidate[] = [...communitySkills.candidates, ...publisherSkills.candidates];
    const creatorsPath = join(root, "creators.json");
    let creators = await json<CreatorCache>(creatorsPath, {});
    for (const source of [
      { id: "prompts-chat", repo: "f/prompts.chat" },
    ]) {
      const path = join(root, "candidates", `${source.id}.json`);
      try {
        const raw = await collectRepository(
          source.repo,
          "prompts.csv",
        );
        const candidates = parseCommunityCSV(raw.text, raw.revision);
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
    // Resolve one immutable revision per repository, but preserve each failed
    // Skill snapshot independently so one deleted file cannot drop the shelf.
    const skillRevisions = new Map<string, string | Error>();
    for (const source of skillSources) {
      const path = join(root, "candidates", `skill-${source.id}.json`);
      try {
        if (!skillRevisions.has(source.repo)) {
          try { skillRevisions.set(source.repo, await skillRepositoryRevision(source.repo)); }
          catch (error) { skillRevisions.set(source.repo, error instanceof Error ? error : new Error(String(error))); }
        }
        const revision = skillRevisions.get(source.repo)!;
        if (revision instanceof Error) throw revision;
        const candidate = await collectSkill(source, revision);
        await atomic(path, [candidate]);
        all.push(candidate);
        report.sources[`skill-${source.id}`] = { status: "ok", count: 1, revision };
      } catch (error) {
        all.push(...(await json<Candidate[]>(path, [])));
        report.sources[`skill-${source.id}`] = { status: "failed", message: String(error) };
      }
    }
    // OpenLab remains historical attribution only; never fetch or grow from it.
    for (const source of repositories) report.sources[source.id] = { status: "retired", count: 0 };
    if (process.env.PROMPIX_X_LOOKUP_IDS !== undefined) {
      const discovery = await discoverX(root, { publishing, bearer: process.env.X_BEARER_TOKEN,
        lookupIDs: process.env.PROMPIX_X_LOOKUP_IDS.split(",").map(id => id.trim()) });
      report.sources.x = discovery.report;
      if (discovery.result) {
        creators = mergeCreatorCache(creators, discovery.result.creators);
        await atomic(creatorsPath, creators);
      }
    } else {
      report.sources.x = await collectXDiscovery(root, { enabled: publishing, bearer: process.env.X_BEARER_TOKEN });
    }
    // Cached discoveries still enter intake when today's paid search is disabled.
    // Marked source bodies are drafts; incomplete posts keep an explicit reason.
    let reviews = reviewsSchema.parse(await json(join(root, "editorial.json"), {}));
    creators = await json<CreatorCache>(creatorsPath, creators);
    const xIntake = await readXIntake(root, creators);
    xIntake.report.reviewedDrafts = xIntake.candidates.filter(item => reviews[item.id]?.fingerprint === item.fingerprint).length;
    report.sources["x-intake"] = xIntake.report;
    report.sources["x-reply-intake"] = xIntake.threads;
    all.push(...filterXAvailability(xIntake.candidates, xAvailability.state).prompts);
    await atomic(join(root, "candidates", "x-native.json"), xIntake.candidates);
    await atomic(join(root, "x-intake", "status.json"), { updatedAt: new Date().toISOString(), ...xIntake.report, threads: xIntake.threads, records: xIntake.records });
    const discoveredSkills = await prepareDiscoveredSkills(root, xIntake.records, { enabled: publishing });
    report.sources["skill-discovery"] = discoveredSkills.report;
    all.push(...discoveredSkills.candidates);
    report.sources[videoArchive.id] = { status: "retired", count: 0 };
    const candidates = enrichCreators(mergeCandidates(all), creators);
    report.counts.candidates = countByKind(candidates);
    const moderation = moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] }));
    let previous: Catalog | undefined;
    let previousManifest: Awaited<ReturnType<typeof currentManifest>> | undefined;
    if (publishing || publication.enabled) {
      // Compare against the verified online library, not a possibly stale local latest.json.
      previousManifest = publication?.previous?.v1.manifest ?? await currentManifest();
      previous = publication?.previous?.authoritative ?? await remoteCatalog(previousManifest);
      report.comparisonVersion = previous.version;
      moderation.removedIDs = [...new Set([...moderation.removedIDs, ...(previous.removedIDs ?? [])])].sort();
      if (publishing) await atomic(join(root, "moderation.json"), moderation);
    }
    const excluded = new Set(moderation.removedIDs);
    const editorial = await prepareDailyEditorial(candidates.filter(item => !excluded.has(item.id)), reviews, previous?.prompts ?? [], root, publishing);
    reviews = editorial.reviews;
    report.editorial = editorial.report;
    const reviewed = applyEditorialReviews(candidates, reviews);
    report.counts.reviewed = countByKind(reviewed.filter((item) => item.reviewStatus === "candidate"));
    const picked = selectLibrary(reviewed, excluded);
    report.counts.eligible = countByKind(picked);
    let planned = picked.map((candidate): Prompt => {
      const { fingerprint: _, featured: __, reviewStatus: ___, editorialRank: ____, ...prompt } = candidate;
      return { ...prompt, prompt: publicationText(candidate, reviews) };
    });
    const refreshed = await refreshCreatorProfiles(planned, creators, root, {
      enabled: process.env.PROMPIX_CREATOR_LOOKUP_ENABLED === "true", publishing, bearer: process.env.X_BEARER_TOKEN,
    });
    report.sources["x-creators"] = refreshed.report;
    creators = refreshed.cache;
    planned = enrichCreators(planned, creators);
    let bundled = catalogSchema.parse(JSON.parse(await readFile(join(repo, "ios/Prompix/Resources/catalog.json"), "utf8")))
      .prompts.filter((item) => !excluded.has(item.id));
    report.counts.bundled = countByKind(bundled);
    // Fail before uploading media if the complete library exceeds the publisher's safety bound.
    interleaveLibrary(planned, bundled, excluded, libraryLimit);
    const mediaMap = await json<Record<string, string>>(
      join(root, "media-map.json"),
      {},
    );
    const aspects = await json<Record<string,number>>(join(root,"media-aspects.json"),{});
    const published: Prompt[] = [];
    const mediaFailedIDs = new Set<string>();
    for (const prompt of planned) {
      try {
        if (prompt.media && publishing && websiteMediaNeedsMirroring(prompt)) {
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
        mediaFailedIDs.add(prompt.id);
        report.mediaErrors.push(`${prompt.id}: ${String(e)}`);
        report.counts.mediaFailed.total++;
        report.counts.mediaFailed[prompt.kind]++;
      }
    }
    const visual = await prepareDailyVisualReview(published, previous?.prompts ?? [], root, publishing);
    report.visualReview = visual.report;
    for (const id of visual.blockedIDs) excluded.add(id);
    const mediaAwaitingReview = new Set(visual.withheldIDs);
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
    const reviewedByID = new Map(reviewed.map(item => [item.id, item]));
    const retained = retainPublishedLibrary(interleaveLibrary(visual.prompts, bundled, excluded, libraryLimit), previous?.prompts ?? [], excluded, item => {
      if (mediaFailedIDs.has(item.id)) return "media-failed";
      if (mediaAwaitingReview.has(item.id)) return "awaiting-media-review";
      const candidate = reviewedByID.get(item.id);
      if (!candidate) return "source-missing";
      return candidate.reviewStatus === "draft" ? "awaiting-review" : "not-prepared";
    }, libraryLimit);
    // Retained snapshots receive the same creator enrichment and translations
    // as fresh candidates, including older editions without creator metadata.
    // A quality hold removes public discovery only, after retention can restore old snapshots.
    const labeled = await applyDailyVisualPresentation(retained.prompts, root);
    const visible = applyQualityHolds(labeled.filter(item => item.presentation !== "explicit"), qualityHolds);
    report.qualityHeldIDs = visible.withheldIDs;
    const registryVisible = filterClawHubAvailability(visible.prompts, communitySkills.state);
    report.registryWithheldIDs = registryVisible.withheldIDs;
    const xVisible = filterXAvailability(registryVisible.prompts, xAvailability.state);
    report.sources["x-withheld"] = { ids: xVisible.withheldIDs };
    let complete = enrichCreators(xVisible.prompts, creators);
    // Only publishable records consume a slot. A cached visual deferral or a
    // failed download must not block all later approvals on every run.
    if (publishing && publication.previous?.database) {
      const quota = await withPublisherDatabase(db => limitNewPublications(db, complete));
      complete = quota.prompts;
      report.sources["publication-quota"] = quota.report;
    }
    if (publishing) complete = await mirrorCreatorAvatars(complete, async url => {
      const mirrored = await publishAvatar(url, root, mediaMap, upload);
      await atomic(join(root, "media-map.json"), mediaMap);
      return mirrored;
    }, (creatorID, error) => report.avatarErrors.push(`${creatorID}: ${String(error)}`));
    // Dry-run only reads validated translations; it never starts a paid batch.
    const localized = await prepareDailyTranslations(inheritPreviousTranslations(complete, previous?.prompts ?? []), root, process.env, publishing);
    const prompts = localized.prompts;
    report.translations = localized.report;
    report.retainedPrevious = retained.retainedPrevious;
    report.counts.prepared = countByKind(prompts);
    if (previous) report.changes = libraryDelta(previous.prompts, prompts);
    if (
      publishing &&
      prompts.filter((p) => p.kind === "image" && p.media?.imageURL).length < 6
    )
      throw new Error(
        "Too few verified community previews; current release preserved",
      );
    const version = (publication.enabled ? languagePackEditionVersion : editionVersion)(prompts, moderation.removedIDs);
    const latestPath = join(root, "latest.json");
    if (publishing && !publication?.enabled && previousManifest?.version === version) {
      const active = await currentManifest();
      if (active.version === version && active.sha256 === previousManifest.sha256) {
        await remoteCatalog(active);
        await atomic(latestPath, active);
        report.version = version;
        report.published = true;
        report.changed = false;
        report.counts.published = countByKind(prompts);
        await clearMatchingPublicationHold(root, { holdToClear: publication?.holdToClear });
        return;
      }
      throw new Error("The active library changed during preparation; refusing to overwrite it");
    }
    const catalog = (publication.previous?.database ? preservePublicationInput : publication.enabled ? preserveCatalogText : catalogSchema.parse)({
      schemaVersion: 1,
      version,
      publishedAt: new Date().toISOString(),
      removedIDs: moderation.removedIDs,
      prompts,
    });
    if (publishing && publication?.enabled) {
      const result = await publishDailyCatalog(root, catalog, publication);
      report.version = result.authoritative.version;
      report.published = true;
      report.changed = result.authoritative.version !== previous?.version;
      report.counts.published = countByKind(result.authoritative.prompts);
      report.channels = { v1: result.v1.manifest.version, v2: result.v2!.manifest.version, v1Frozen: result.state.v1Frozen };
      return;
    }
    if (publication.enabled) {
      const staged = await stageRelease(root, catalog, publication.previous!);
      report.version = staged.targets.v2.version;
      report.channels = { v1: staged.targets.v1.version, v2: staged.targets.v2.version, v1Frozen: staged.freezeV1 };
      return;
    }
    const release = join(root, "releases", version);
    await mkdir(release, { recursive: true });
    const catalogPath = join(release, "catalog.json");
    // Media may already be mirrored, but an oversized catalog must never upload or activate.
    const { bytes, catalog: stored } = await writeCatalog(catalogPath, catalog, { reuseExistingPublishedAt: true });
    const manifest = manifestSchema.parse({
      schemaVersion: 1,
      version,
      publishedAt: stored.publishedAt!,
      count: prompts.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      catalog: `${base}/releases/${version}/catalog.json`,
    });
    const manifestPath = join(release, "manifest.json");
    await atomic(manifestPath, manifest);
    if (publishing) {
      assertNoQualityHolds(stored, await readQualityHolds(root));
      await assertClawHubAvailability(root, stored);
      await assertXAvailability(root, stored);
      await upload(
        `releases/${version}/catalog.json`,
        catalogPath,
        "application/json",
      );
      await remoteCatalog(manifest);
      assertNoQualityHolds(stored, await readQualityHolds(root));
      await assertClawHubAvailability(root, stored);
      await assertXAvailability(root, stored);
      // Activate LAST. Any earlier failure leaves clients on the previous complete edition.
      await upload("v1/latest.json", manifestPath, "application/json");
      await atomic(latestPath, manifest);
      const active = await currentManifest();
      if (active.version !== version || active.sha256 !== manifest.sha256) throw new Error("Activation verification failed");
      report.published = true;
      report.changed = true;
      report.counts.published = countByKind(prompts);
      await clearMatchingPublicationHold(root, { holdToClear: publication?.holdToClear });
    }
    report.version = version;
  });
}
run().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
