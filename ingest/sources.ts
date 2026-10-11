import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "csv-parse/sync";
import type { Prompt } from "../packages/schema/catalog.ts";
import { download } from "./network.ts";
const exec = promisify(execFile);
export const repositories = [
  {
    id: "youmind-nano",
    repo: "YouMind-OpenLab/awesome-nano-banana-pro-prompts",
    kind: "image",
    model: "Nano Banana Pro",
    tool: "https://gemini.google.com/",
  },
  {
    id: "youmind-gpt-image",
    repo: "YouMind-OpenLab/awesome-gpt-image-2",
    kind: "image",
    model: "GPT Image 2",
    tool: "https://chatgpt.com/",
  },
  {
    id: "youmind-seedance",
    repo: "YouMind-OpenLab/awesome-seedance-2-prompts",
    kind: "video",
    model: "Seedance 2.0",
    tool: "https://dreamina.capcut.com/",
  },
] as const;
export type Repository = (typeof repositories)[number];
// The last upstream release map with complete downloadable video examples.
// Keep this immutable; backfills are explicitly staged for editorial review.
export const videoArchive = {
  id: "youmind-seedance-archive",
  repo: "YouMind-OpenLab/awesome-seedance-2-prompts",
  revision: "145d838af98657e4a45ec0cb58c4df31b55e7e52",
  filename: "README_zh.md",
} as const;
export type Candidate = Prompt & {
  fingerprint: string;
  featured: boolean;
  editorialRank?: number;
  reviewStatus: "candidate" | "draft";
};
export const fingerprint = (text: string) =>
  createHash("sha256")
    .update(text.normalize("NFKC").replace(/\s+/g, " ").trim())
    .digest("hex");
const clean = (text: string) =>
  text
    .replace(/<[^>]*>/g, "")
    .replace(/\*\*/g, "")
    .trim();

/** README headings inside a fenced prompt belong to that prompt, not the feed. */
function sourceBlocks(markdown: string, source: Repository): string[] {
  const heading = source.kind === "video" ? /^### / : /^### No\. \d+: /;
  const blocks: string[] = [];
  let block: string[] | undefined;
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    if (!fence && heading.test(line)) {
      if (block) blocks.push(block.join("\n"));
      block = [line.replace(heading, "")];
      continue;
    }
    if (block) block.push(line);
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
    }
  }
  if (block) blocks.push(block.join("\n"));
  return blocks;
}

const completeVideo = (item: Candidate) =>
  item.kind === "video" && Boolean(item.media?.imageURL && item.media?.videoURL);

export function parseYouMind(
  markdown: string,
  source: Repository,
  revision: string,
): Candidate[] {
  const items: Candidate[] = [];
  const seen = new Set<string>();
  for (const block of sourceBlocks(markdown, source)) {
    const title = block.split("\n")[0].replace(/^No\. \d+: /, "").trim();
    const prompt = block
      .match(/#### 📝[^\n]*\n+```[^\n]*\n([\s\S]*?)\n```/)?.[1]
      ?.trim();
    const summary = block
      .match(/#### 📖[^\n]*\n+([\s\S]*?)(?=\n####)/)?.[1]
      ?.trim() ?? block.match(/^> (.+)$/m)?.[1]?.trim();
    const original = block.match(
      /\*\*(?:来源|Source):\*\* \[[^\]]+\]\((https:[^)]+)\)/,
    )?.[1];
    const author = block.match(/\*\*(?:作者|Author):\*\* \[([^\]]+)\]/)?.[1];
    const image = block.match(/<img src="(https:[^"]+)"/)?.[1];
    const video = block.match(/<a href="(https:[^"]+\.mp4)"/)?.[1];
    if (
      !prompt ||
      !summary ||
      !original ||
      !author ||
      (source.kind === "image" && !image)
    )
      continue;
    const hash = fingerprint(prompt);
    const id = `${source.id}-${fingerprint(original).slice(0, 16)}`;
    // Preserve every source post's current fingerprint, even if another post
    // has the same text. Content deduplication belongs after eligibility checks.
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      kind: source.kind,
      title: clean(title),
      summary: clean(summary),
      prompt,
      example: clean(summary),
      tags: ["创作灵感", source.kind === "image" ? "视觉实验" : "动态影像"],
      model: source.model,
      toolURL: source.tool,
      artwork: "editorial",
      previewLabel: "社区创作者生成示例",
      source: {
        name: "YouMind OpenLab",
        url: original,
        author,
        license: "CC-BY-4.0",
        method: "社区收录",
        repository: `https://github.com/${source.repo}`,
        revision,
      },
      media: {
        image: null,
        video: null,
        demoURL: null,
        ...(image ? { imageURL: image } : {}),
        ...(video ? { videoURL: video } : {}),
      },
      fingerprint: hash,
      featured: block.includes("badge/⭐-Featured"),
      // Keep watch-page-only posts as drafts so updated text can block a stale
      // archive review without pretending a watch page is a downloadable clip.
      reviewStatus: source.kind === "video" && (!image || !video) ? "draft" : "candidate",
    });
  }
  return items;
}
/** Current content wins when the same source post also appears in the archive. */
export function mergeCandidates(...groups: readonly Candidate[][]): Candidate[] {
  const posts = new Map<string, Candidate>();
  for (const candidate of groups.flat()) {
    const current = posts.get(candidate.id);
    if (!current) posts.set(candidate.id, candidate);
    // The archive can fill missing media only while the source text is unchanged.
    // Retain archive provenance and draft status; it still needs editorial review.
    else if (current.kind === "video" && !completeVideo(current) &&
      current.fingerprint === candidate.fingerprint && completeVideo(candidate) &&
      candidate.reviewStatus === "draft") posts.set(candidate.id, candidate);
  }
  return [...posts.values()];
}
export function parseVideoArchive(markdown: string): Candidate[] {
  const source = repositories.find((item) => item.repo === videoArchive.repo)!;
  return parseYouMind(markdown, source, videoArchive.revision)
    .filter(completeVideo)
    .map((candidate) => ({ ...candidate, reviewStatus: "draft" }));
}
export async function collectVideoArchive(): Promise<Candidate[]> {
  const raw = await download(
    `https://raw.githubusercontent.com/${videoArchive.repo}/${videoArchive.revision}/${videoArchive.filename}`,
    ["raw.githubusercontent.com"],
  );
  // Unlike the existing live feed, historical backfill must never ship unreviewed.
  return parseVideoArchive(raw.bytes.toString());
}
export function parseCommunityCSV(csv: string, revision: string): Candidate[] {
  const rows = parse(csv, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
  return rows
    .filter(
      (row) =>
        row.act &&
        row.prompt &&
        (row.type === "TEXT" || row.type === "WEB") &&
        !/vulnerability|security checker|testing skill|girl of dreams/i.test(
          row.act,
        ),
    )
    .map((row) => {
      const isWeb =
        row.type === "WEB" ||
        (/website|landing page|web app|网页|网站/i.test(row.act) &&
          /html|css|react|web|网站|网页/i.test(row.prompt));
      const playful =
        /\b(tarot|roast|fortune|story|storyteller|dream|character|poet)\b|塔罗|算命/i.test(
          row.act,
        );
      const kind = isWeb ? "web" : "text";
      const hash = fingerprint(row.prompt);
      return {
        id: `pc-${hash.slice(0, 20)}`,
        kind,
        title: row.act.trim(),
        summary: isWeb
          ? "将完整需求交给代码工具，创作你自己的网页。"
          : "一个来自 prompts.chat 社区的对话创意。把变量换成你的想法，再开始对话。",
        prompt: row.prompt.trim(),
        example: isWeb
          ? "这是网页生成提示词，尚未附带经过验证的网页效果。"
          : "这张卡片展示提示词主题；实际回复取决于你使用的模型和输入。",
        tags: [
          isWeb ? "创作灵感" : playful ? "好玩一点" : "日常有用",
          isWeb ? "做个网站" : "社区灵感",
        ],
        model: isWeb ? "通用代码模型" : "通用对话模型",
        toolURL: isWeb ? "https://claude.ai/" : "https://chatgpt.com/",
        artwork: isWeb ? "web-editorial" : "text-editorial",
        previewLabel: "提示词主题封面",
        source: {
          name: "prompts.chat",
          url: `https://github.com/f/prompts.chat/blob/${revision}/prompts.csv`,
          license: "CC0-1.0",
          method: "社区收录",
          author: row.contributor || "prompts.chat contributors",
          revision,
        },
        media: null,
        fingerprint: hash,
        featured: playful || isWeb,
        reviewStatus: "draft",
      } as Candidate;
    });
}
export async function collectRepository(
  repo: string,
  filename: string,
): Promise<{ text: string; revision: string }> {
  const allowed = repo === "f/prompts.chat"
    ? filename === "prompts.csv"
    : repositories.some((source) => source.repo === repo) && filename === "README_zh.md";
  if (!allowed) throw new Error("Repository file is not allowlisted");
  // Resolve the default branch without consuming the shared, unauthenticated REST quota.
  // Fetch the file at that immutable commit, even if HEAD moves during this run.
  const metadata = await exec(
    "git",
    ["ls-remote", "--exit-code", `https://github.com/${repo}.git`, "HEAD"],
    { timeout: 60_000, maxBuffer: 200_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  const revision = metadata.stdout.match(/^([a-f0-9]{40})\tHEAD\r?$/m)?.[1];
  if (!revision)
    throw new Error("Invalid repository revision");
  const result = await download(
    `https://raw.githubusercontent.com/${repo}/${revision}/${filename}`,
    ["raw.githubusercontent.com"],
  );
  return { text: result.bytes.toString(), revision };
}
// A small, predictable edition. Raw candidates stay local; only complete entries can ship.
export function selectEdition(
  items: Candidate[],
  excluded: Set<string>,
  limit: number,
): Candidate[] {
  const seen = new Set<string>();
  const eligible = items.filter((item) => {
    if (
      excluded.has(item.id) ||
      seen.has(item.fingerprint) ||
      item.prompt.length < (item.editorialRank !== undefined ? 20 : 80) ||
      item.prompt.length > 30000 ||
      item.title.length > 160 ||
      item.reviewStatus !== "candidate" ||
      (item.kind === "video" && !completeVideo(item))
    )
      return false;
    if (
      /nsfw|porn|nudity|nude |jailbreak|越狱|裸体|色情|鬼灭之刃|demon slayer|dragon ball|naruto|蜘蛛侠|spider-man|血腥|gore/i.test(
        item.title + " " + item.prompt,
      )
    )
      return false;
    seen.add(item.fingerprint);
    return true;
  });
  const curated = eligible.filter((x) => x.editorialRank !== undefined)
    .sort((a, b) => (b.editorialRank ?? 0) - (a.editorialRank ?? 0));
  const selected = [...curated, ...eligible.filter((x) => x.featured && !curated.includes(x))]
    .slice(0, Math.max(curated.length, Math.ceil(limit / 2)));
  const recent = eligible
    .filter((x) => !selected.includes(x))
    .sort((a, b) => {
      const left = BigInt(a.source.url?.match(/status\/(\d+)/)?.[1] ?? "0");
      const right = BigInt(b.source.url?.match(/status\/(\d+)/)?.[1] ?? "0");
      return left === right ? 0 : left > right ? -1 : 1;
    });
  return [...selected, ...recent].slice(0, limit);
}
