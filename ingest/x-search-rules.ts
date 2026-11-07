/** Owner-approved X search strategy (2026-11-07): images and video first, searched by use, by
 * model, from a curated creator list and a small exploration lane, in Chinese, English, Japanese
 * and Korean. Quality and diversity gates apply before any post enters review.
 * Proposed 2026-11-07 (awaiting the owner): a craft lane searches words that appear inside
 * prompts themselves (framing, light, camera), which found 91% usable posts on a measured day. */

export type XSearchLane = "use" | "model" | "creator" | "craft" | "explore";
export type XSearchRule = { id: string; lane: XSearchLane; kind: "image" | "video"; label: string; terms: string };

/** Share of the day's acquisitions per lane. */
export const laneShares: Record<XSearchLane, number> = { use: 0.35, model: 0.15, creator: 0.25, craft: 0.2, explore: 0.05 };
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
  { id: "use-poster", lane: "use", kind: "image", label: "海报和字体", terms: "(poster OR typography OR 海报 OR ポスター)" },
  { id: "use-brand", lane: "use", kind: "image", label: "Logo 和品牌", terms: "(logo OR branding OR 品牌 OR ロゴ)" },
  { id: "use-space", lane: "use", kind: "image", label: "室内和建筑", terms: "(interior OR architecture OR 室内设计 OR 建筑)" },
  { id: "use-character", lane: "use", kind: "image", label: "角色设定", terms: "(\"character sheet\" OR \"character design\" OR 角色设定 OR キャラクター)" },
  { id: "use-edit", lane: "use", kind: "image", label: "修图和换装", terms: "(\"photo edit\" OR \"reference image\" OR 修图 OR 换装 OR 参考图)" },
  { id: "use-sticker", lane: "use", kind: "image", label: "贴纸和表情包", terms: "(sticker OR emoji OR 表情包 OR スタンプ)" },
  { id: "use-miniature", lane: "use", kind: "image", label: "3D 和微缩", terms: "(3D OR miniature OR isometric OR 微缩 OR 手办)" },
  { id: "use-illustration", lane: "use", kind: "image", label: "插画", terms: "(illustration OR 插画 OR イラスト OR 일러스트)" },
  { id: "use-fashion", lane: "use", kind: "image", label: "时尚和人像", terms: "(fashion OR portrait OR 穿搭 OR 人像)" },
  // Each of these returned two or three posts a day alone; together they fill one share.
  { id: "use-goods", lane: "use", kind: "image", label: "商品、美食、壁纸和图解",
    terms: "(\"product photography\" OR \"product shot\" OR 产品摄影 OR 商品图 OR 电商 OR food OR 美食 OR 料理 OR 음식 OR wallpaper OR 壁纸 OR 壁紙 OR infographic OR diagram OR 信息图 OR 图解)" },
  { id: "use-film", lane: "use", kind: "video", label: "短片和分镜", terms: "(\"short film\" OR storyboard OR 短片 OR 分镜)" },
  { id: "use-video-ad", lane: "use", kind: "video", label: "视频广告", terms: "(commercial OR \"product video\" OR 广告片 OR 广告)" },
  { id: "use-animation", lane: "use", kind: "video", label: "动画", terms: "(animation OR anime OR 动画 OR アニメ)" },
  { id: "use-dance", lane: "use", kind: "video", label: "舞蹈", terms: "(dance OR ダンス OR 舞蹈 OR 跳舞 OR 댄스)" },
  // By model: the generators people are using now. Flux, Seedream, Ideogram, Veo, Kling, Hailuo,
  // Runway and Wan returned no usable prompt on a measured day (2026-11-02) and are searched only through
  // the other lanes.
  { id: "model-gpt-image", lane: "model", kind: "image", label: "GPT Image", terms: "(\"gpt image\" OR \"gpt-image\" OR chatgpt)" },
  { id: "model-nano-banana", lane: "model", kind: "image", label: "Nano Banana", terms: "(\"nano banana\" OR \"gemini image\")" },
  { id: "model-midjourney", lane: "model", kind: "image", label: "Midjourney", terms: "(midjourney OR niji)" },
  { id: "model-grok-image", lane: "model", kind: "image", label: "Grok Imagine", terms: "grok" },
  { id: "model-seedance", lane: "model", kind: "video", label: "Seedance", terms: "seedance" },
  { id: "model-grok-video", lane: "model", kind: "video", label: "Grok Imagine", terms: "grok" },
  // By craft: words that appear inside prompts rather than around them.
  { id: "craft-photo", lane: "craft", kind: "image", label: "写实和相机", terms: "(realistic OR photorealistic OR camera OR lens OR 8k OR 写实 OR カメラ OR リアル)" },
  { id: "craft-framing", lane: "craft", kind: "image", label: "构图和画幅",
    terms: "(composition OR \"close-up\" OR \"aspect ratio\" OR \"9:16\" OR \"16:9\" OR \"3:4\" OR \"4:5\" OR \"--ar\" OR 构图 OR 構図 OR 竖幅 OR 縦長 OR 구도)" },
  { id: "craft-light", lane: "craft", kind: "image", label: "光线和电影感", terms: "(cinematic OR lighting OR 光线 OR ライティング OR 电影感 OR 镜头 OR 조명)" },
  { id: "craft-anime", lane: "craft", kind: "image", label: "二次元标签", terms: "(masterpiece OR \"best quality\" OR 1girl)" },
  { id: "craft-video-camera", lane: "craft", kind: "video", label: "镜头", terms: "(camera OR lens OR \"close-up\" OR cinematic OR 镜头 OR カメラ)" },
  { id: "craft-video-light", lane: "craft", kind: "video", label: "光线和写实", terms: "(lighting OR realistic OR photorealistic OR 光线 OR 写实 OR リアル OR \"9:16\" OR \"16:9\")" },
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
