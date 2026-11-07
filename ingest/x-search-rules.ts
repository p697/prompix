/** Owner-approved X search strategy (2026-11-07): images and video first, searched by use, by
 * model, from a curated creator list and a small exploration lane, in Chinese, English, Japanese
 * and Korean. Quality and diversity gates apply before any post enters review. */

export type XSearchLane = "use" | "model" | "creator" | "explore";
export type XSearchRule = { id: string; lane: XSearchLane; kind: "image" | "video"; label: string; terms: string };

/** Share of the day's acquisitions per lane. */
export const laneShares: Record<XSearchLane, number> = { use: 0.4, model: 0.25, creator: 0.25, explore: 0.1 };
/** Target share of video among the day's acquisitions. */
export const videoShare = 0.3;
export const minimumLikes = 20;
export const perCreatorDaily = 3;
/** Portraits and people may fill at most this share of a day's new works. */
export const portraitShare = 0.5;

const promptWords = "(prompt OR prompts OR 提示词 OR プロンプト OR 프롬프트)";
const exclusions = "-is:retweet -is:reply -is:quote -sora -giveaway -抽奖";

export const xSearchRules: readonly XSearchRule[] = [
  // By use: what people would make with it.
  { id: "use-product", lane: "use", kind: "image", label: "产品摄影和广告", terms: "(\"product photography\" OR \"product shot\" OR 产品摄影 OR 商品图 OR 电商)" },
  { id: "use-poster", lane: "use", kind: "image", label: "海报和字体", terms: "(poster OR typography OR 海报 OR ポスター)" },
  { id: "use-brand", lane: "use", kind: "image", label: "Logo 和品牌", terms: "(logo OR branding OR 品牌 OR ロゴ)" },
  { id: "use-space", lane: "use", kind: "image", label: "室内和建筑", terms: "(interior OR architecture OR 室内设计 OR 建筑)" },
  { id: "use-food", lane: "use", kind: "image", label: "美食", terms: "(food OR 美食 OR 料理 OR 음식)" },
  { id: "use-character", lane: "use", kind: "image", label: "角色设定", terms: "(\"character sheet\" OR \"character design\" OR 角色设定 OR キャラクター)" },
  { id: "use-edit", lane: "use", kind: "image", label: "修图和换装", terms: "(\"photo edit\" OR \"reference image\" OR 修图 OR 换装 OR 参考图)" },
  { id: "use-sticker", lane: "use", kind: "image", label: "贴纸和表情包", terms: "(sticker OR emoji OR 表情包 OR スタンプ)" },
  { id: "use-wallpaper", lane: "use", kind: "image", label: "壁纸", terms: "(wallpaper OR 壁纸 OR 壁紙)" },
  { id: "use-miniature", lane: "use", kind: "image", label: "3D 和微缩", terms: "(3D OR miniature OR isometric OR 微缩 OR 手办)" },
  { id: "use-illustration", lane: "use", kind: "image", label: "插画", terms: "(illustration OR 插画 OR イラスト OR 일러스트)" },
  { id: "use-infographic", lane: "use", kind: "image", label: "信息图和图解", terms: "(infographic OR diagram OR 信息图 OR 图解)" },
  { id: "use-fashion", lane: "use", kind: "image", label: "时尚和人像", terms: "(fashion OR portrait OR 穿搭 OR 人像)" },
  { id: "use-film", lane: "use", kind: "video", label: "短片和分镜", terms: "(\"short film\" OR storyboard OR 短片 OR 分镜)" },
  { id: "use-video-ad", lane: "use", kind: "video", label: "视频广告", terms: "(commercial OR \"product video\" OR 广告片 OR 广告)" },
  { id: "use-animation", lane: "use", kind: "video", label: "动画", terms: "(animation OR anime OR 动画 OR アニメ)" },
  // By model: the generators people are using now.
  { id: "model-gpt-image", lane: "model", kind: "image", label: "GPT Image", terms: "(\"gpt image\" OR \"gpt-image\" OR chatgpt)" },
  { id: "model-nano-banana", lane: "model", kind: "image", label: "Nano Banana", terms: "(\"nano banana\" OR \"gemini image\")" },
  { id: "model-midjourney", lane: "model", kind: "image", label: "Midjourney", terms: "(midjourney OR niji)" },
  { id: "model-flux", lane: "model", kind: "image", label: "Flux", terms: "flux" },
  { id: "model-seedream", lane: "model", kind: "image", label: "Seedream", terms: "(seedream OR 即梦)" },
  { id: "model-ideogram", lane: "model", kind: "image", label: "Ideogram", terms: "ideogram" },
  { id: "model-seedance", lane: "model", kind: "video", label: "Seedance", terms: "seedance" },
  { id: "model-veo", lane: "model", kind: "video", label: "Veo", terms: "veo" },
  { id: "model-kling", lane: "model", kind: "video", label: "Kling", terms: "(kling OR 可灵)" },
  { id: "model-hailuo", lane: "model", kind: "video", label: "海螺", terms: "(hailuo OR 海螺 OR minimax)" },
  { id: "model-runway", lane: "model", kind: "video", label: "Runway", terms: "runway" },
  { id: "model-wan", lane: "model", kind: "video", label: "Wan", terms: "(\"wan 2\" OR 万相)" },
  // Exploration: new tools and techniques, held to a higher engagement bar.
  { id: "explore-image", lane: "explore", kind: "image", label: "新玩法（图片）", terms: "(new OR trend OR 新玩法 OR 爆款)" },
  { id: "explore-video", lane: "explore", kind: "video", label: "新玩法（视频）", terms: "(new OR trend OR 新玩法 OR 爆款)" },
];

/** X advanced search for one rule within a time window; creators are searched in groups. */
export function ruleQuery(rule: XSearchRule, since: number, until: number, creators: readonly string[] = []): string {
  const media = rule.kind === "video" ? "has:videos" : "has:images";
  const likes = rule.lane === "explore" ? minimumLikes * 5 : minimumLikes;
  const from = creators.length ? `(${creators.map(name => `from:${name}`).join(" OR ")})` : "";
  return [promptWords, rule.terms, from, media, exclusions, `min_faves:${likes}`, `since_time:${since}`, `until_time:${until}`]
    .filter(Boolean).join(" ");
}

/** Curated creators share one lane; they are searched in groups small enough for one query. */
export function creatorRules(creators: readonly string[], groupSize = 12): { rule: XSearchRule; creators: string[] }[] {
  const groups: { rule: XSearchRule; creators: string[] }[] = [];
  for (let index = 0; index < creators.length; index += groupSize)
    for (const kind of ["image", "video"] as const)
      groups.push({ rule: { id: `creator-${kind}-${index / groupSize + 1}`, lane: "creator", kind, label: "精选创作者", terms: "" },
        creators: creators.slice(index, index + groupSize) });
  return groups;
}

/** How many posts each rule may admit today, from the daily acquisition budget. */
export function ruleQuotas(rules: readonly XSearchRule[], dailyPosts: number): Map<string, number> {
  const quotas = new Map<string, number>();
  for (const lane of Object.keys(laneShares) as XSearchLane[]) {
    for (const kind of ["image", "video"] as const) {
      const members = rules.filter(rule => rule.lane === lane && rule.kind === kind);
      if (!members.length) continue;
      const share = laneShares[lane] * (kind === "video" ? videoShare : 1 - videoShare);
      const each = Math.max(1, Math.round(dailyPosts * share / members.length));
      for (const rule of members) quotas.set(rule.id, each);
    }
  }
  return quotas;
}

/** The 24 hours of one Japan day, so a trial can replay a day the pipeline never searched. */
export function japanDay(day: string): { since: number; until: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00+09:00`))) throw new Error(`Invalid trial day: ${day}`);
  const since = Date.parse(`${day}T00:00:00+09:00`) / 1000;
  return { since, until: since + 86400 };
}
