import { withPublisherDatabase } from "./database-publication.ts";
import type { TwitterAPIClient } from "./twitterapi.ts";
import type { XMedia, XPost } from "./x-intake.ts";
import { creatorRules, perCreatorDaily, ruleQuery, ruleQuotas, xSearchRules, type XSearchRule } from "./x-search-rules.ts";

export type XRuleStats = { rule: string; lane: string; kind: string; label: string; quota: number; requests: number; returned: number; admitted: number;
  known: number; capped: number; wrongMedia: number; error?: string;
  /** Quota taken over from rules that could not fill theirs. */
  reused?: number };
export type XDaySearch = { stats: XRuleStats[]; admitted: Map<string, { post: XPost; rule: string }>;
  media: Map<string, XMedia>; profiles: Map<string, unknown>; metrics: Map<string, { likes?: number; views?: number }> };

/** Curated creators: three or more live works, not dominated by portraits, most productive first. */
export async function curatedCreators(env: NodeJS.ProcessEnv): Promise<string[]> {
  return withPublisherDatabase(async db => (await db.query<{ username: string }>(`
    select v.card#>>'{creator,username}' as username from prompix.state s
    join prompix.release_entries e on e.release_id = s.active_release join prompix.revisions v on v.id = e.revision_id
    join prompix.content c on c.id = e.content_id
    where s.singleton and c.removed_at is null and v.card#>>'{creator,platform}' = 'x' and v.card#>>'{creator,username}' ~ '^[A-Za-z0-9_]{1,15}$'
    group by 1 having count(*) >= 3
      and avg(case when coalesce(v.card->'facets'->'useCase','[]'::jsonb) ? 'portraits' then 1 else 0 end) <= 0.6
    order by count(*) desc, 1 limit 48`)).rows.map(row => row.username), env);
}

/** Lanes that get unused quota first: prompt-wording and creator searches have the most usable prompts. */
const reuseOrder: readonly XRuleStats["lane"][] = ["craft", "creator", "use", "model", "explore"];

/** One window under the approved rules: each rule pages until its share of the day's posts is
 * admitted, skipping known posts, posts without the rule's media and creators over their cap.
 * Quota a thin rule cannot fill then goes to rules that still have posts, so the day's
 * allowance is used. */
export async function searchXDay(client: Pick<TwitterAPIClient, "search">, options: { since: number; until: number; dailyPosts: number;
  creators: readonly string[]; known: ReadonlySet<string>; progress?: (stats: XRuleStats[]) => Promise<void> }): Promise<XDaySearch> {
  const searchRules: { rule: XSearchRule; creators: string[] }[] = [...xSearchRules.map(rule => ({ rule, creators: [] })), ...creatorRules([...options.creators])];
  const quotas = ruleQuotas(searchRules.map(entry => entry.rule), options.dailyPosts);
  const result: XDaySearch = { stats: [], admitted: new Map(), media: new Map(), profiles: new Map(), metrics: new Map() };
  const perCreator = new Map<string, number>();
  type State = { rule: XSearchRule; group: string[]; entry: XRuleStats; cursor?: string; done: boolean; unread: XPost[] };
  const admit = (state: State) => {
    const { rule, entry } = state;
    while (state.unread.length && entry.admitted < entry.quota) {
      const post = state.unread.shift()!;
      if (options.known.has(post.id) || result.admitted.has(post.id)) { entry.known++; continue; }
      const kinds = (post.attachments?.media_keys ?? []).map(key => result.media.get(key)?.type);
      if (!kinds.some(kind => rule.kind === "video" ? kind === "video" : kind === "photo")) { entry.wrongMedia++; continue; }
      if ((perCreator.get(post.author_id) ?? 0) >= perCreatorDaily) { entry.capped++; continue; }
      perCreator.set(post.author_id, (perCreator.get(post.author_id) ?? 0) + 1);
      result.admitted.set(post.id, { post, rule: rule.id }); entry.admitted++;
    }
  };
  /** Up to `pages` more pages, posts left on the last page first, until the rule's quota is met. */
  const pull = async (state: State, pages: number) => {
    admit(state);
    try {
      for (let page = 0; page < pages && state.entry.admitted < state.entry.quota && !state.done; page++) {
        const { result: found } = await client.search(ruleQuery(state.rule, options.since, options.until, state.group), state.cursor, async raw => {
          for (const tweet of (raw as { tweets?: { id?: string; likeCount?: number; viewCount?: number }[] }).tweets ?? [])
            if (tweet.id) result.metrics.set(tweet.id, { likes: tweet.likeCount, views: tweet.viewCount });
        });
        state.entry.requests++; state.entry.returned += found.posts.length;
        for (const item of found.media) result.media.set(item.media_key, item);
        for (const creator of found.creators) result.profiles.set(creator.externalID ?? creator.id, creator);
        state.unread.push(...found.posts);
        admit(state);
        state.cursor = found.nextToken;
        if (!state.cursor) state.done = true;
      }
    } catch (error) { state.entry.error = (error as Error).message.slice(0, 200); state.done = true; }
    await options.progress?.(result.stats);
  };
  const states: State[] = [];
  for (const { rule, creators: group } of searchRules) {
    const entry: XRuleStats = { rule: rule.id, lane: rule.lane, kind: rule.kind, label: rule.label, quota: quotas.get(rule.id) ?? 0,
      requests: 0, returned: 0, admitted: 0, known: 0, capped: 0, wrongMedia: 0 };
    result.stats.push(entry);
    const state: State = { rule, group, entry, done: false, unread: [] };
    states.push(state);
    await pull(state, 3);
  }
  // Unused quota goes to rules that filled theirs and have more posts, a few pages each.
  for (const lane of reuseOrder) for (const state of states.filter(value => value.entry.lane === lane && (value.unread.length || !value.done))) {
    const left = options.dailyPosts - result.admitted.size;
    if (left <= 0) return result;
    const before = state.entry.admitted;
    state.entry.quota += left;
    await pull(state, 2);
    const taken = state.entry.admitted - before;
    state.entry.quota += taken - left;
    if (taken) state.entry.reused = (state.entry.reused ?? 0) + taken;
  }
  return result;
}

/** Intake snapshots of admitted posts, at most 100 posts each, with only their own media and authors. */
export function xDaySnapshots(search: Pick<XDaySearch, "admitted" | "media" | "profiles">, capturedAt: string) {
  const posts = [...search.admitted.values()].map(entry => entry.post), snapshots = [];
  for (let offset = 0; offset < posts.length; offset += 100) {
    const batch = posts.slice(offset, offset + 100), keys = new Set(batch.flatMap(post => post.attachments?.media_keys ?? []));
    snapshots.push({ provider: "twitterapi" as const, capturedAt, posts: batch, media: [...search.media.values()].filter(item => keys.has(item.media_key)),
      creators: [...search.profiles.values()].filter(creator => batch.some(post => (creator as { externalID?: string }).externalID === post.author_id)) });
  }
  return snapshots;
}
