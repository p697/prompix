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
export type Candidate = Prompt & {
  fingerprint: string;
  featured: boolean;
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
export function parseYouMind(
  markdown: string,
  source: Repository,
  revision: string,
): Candidate[] {
  const items: Candidate[] = [];
  const seen = new Set<string>();
  for (const block of markdown.split(/^### No\. \d+: /m).slice(1)) {
    const title = block.split("\n")[0].trim();
    const prompt = block
      .match(/#### 📝[^\n]*\n+```[^\n]*\n([\s\S]*?)\n```/)?.[1]
      ?.trim();
    const summary = block
      .match(/#### 📖[^\n]*\n+([\s\S]*?)(?=\n####)/)?.[1]
      ?.trim();
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
      !image ||
      (source.kind === "video" && !video)
    )
      continue;
    const hash = fingerprint(prompt);
    if (seen.has(hash)) continue;
    seen.add(hash);
    items.push({
      id: `${source.id}-${fingerprint(original).slice(0, 16)}`,
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
        imageURL: image,
        ...(video ? { videoURL: video } : {}),
      },
      fingerprint: hash,
      featured: block.includes("badge/⭐-Featured"),
      reviewStatus: "candidate",
    });
  }
  return items;
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
        reviewStatus: "candidate",
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
      item.prompt.length < 80 ||
      item.prompt.length > 30000 ||
      item.title.length > 160 ||
      item.reviewStatus !== "candidate"
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
  const selected = eligible
    .filter((x) => x.featured)
    .slice(0, Math.ceil(limit / 2));
  const recent = eligible
    .filter((x) => !selected.includes(x))
    .sort((a, b) => {
      const left = BigInt(a.source.url?.match(/status\/(\d+)/)?.[1] ?? "0");
      const right = BigInt(b.source.url?.match(/status\/(\d+)/)?.[1] ?? "0");
      return left === right ? 0 : left > right ? -1 : 1;
    });
  return [...selected, ...recent].slice(0, limit);
}
