import { withPublisherDatabase } from "./database-publication.ts";
import type { TwitterAPIClient } from "./twitterapi.ts";
import type { XMedia, XPost } from "./x-intake.ts";
import { creatorRules, perCreatorDaily, ruleQuery, ruleQuotas, xSearchRules, type XSearchRule } from "./x-search-rules.ts";

export type XRuleStats = { rule: string; lane: string; kind: string; label: string; quota: number; requests: number; returned: number; admitted: number;
  known: number; capped: number; wrongMedia: number; error?: string };
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

/** One window under the approved rules: each rule pages until its share of the day's posts is
 * admitted, skipping known posts, posts without the rule's media and creators over their cap. */
export async function searchXDay(client: Pick<TwitterAPIClient, "search">, options: { since: number; until: number; dailyPosts: number;
  creators: readonly string[]; known: ReadonlySet<string>; progress?: (stats: XRuleStats[]) => Promise<void> }): Promise<XDaySearch> {
  const searchRules: { rule: XSearchRule; creators: string[] }[] = [...xSearchRules.map(rule => ({ rule, creators: [] })), ...creatorRules([...options.creators])];
  const quotas = ruleQuotas(searchRules.map(entry => entry.rule), options.dailyPosts);
  const result: XDaySearch = { stats: [], admitted: new Map(), media: new Map(), profiles: new Map(), metrics: new Map() };
  const perCreator = new Map<string, number>();
  for (const { rule, creators: group } of searchRules) {
    const entry: XRuleStats = { rule: rule.id, lane: rule.lane, kind: rule.kind, label: rule.label, quota: quotas.get(rule.id) ?? 0,
      requests: 0, returned: 0, admitted: 0, known: 0, capped: 0, wrongMedia: 0 };
    result.stats.push(entry);
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 3 && entry.admitted < entry.quota; page++) {
        const { result: found } = await client.search(ruleQuery(rule, options.since, options.until, group), cursor, async raw => {
          for (const tweet of (raw as { tweets?: { id?: string; likeCount?: number; viewCount?: number }[] }).tweets ?? [])
            if (tweet.id) result.metrics.set(tweet.id, { likes: tweet.likeCount, views: tweet.viewCount });
        });
        entry.requests++; entry.returned += found.posts.length;
        for (const item of found.media) result.media.set(item.media_key, item);
        for (const creator of found.creators) result.profiles.set(creator.externalID ?? creator.id, creator);
        for (const post of found.posts) {
          if (entry.admitted >= entry.quota) break;
          if (options.known.has(post.id) || result.admitted.has(post.id)) { entry.known++; continue; }
          const kinds = (post.attachments?.media_keys ?? []).map(key => result.media.get(key)?.type);
          if (!kinds.some(kind => rule.kind === "video" ? kind === "video" : kind === "photo")) { entry.wrongMedia++; continue; }
          if ((perCreator.get(post.author_id) ?? 0) >= perCreatorDaily) { entry.capped++; continue; }
          perCreator.set(post.author_id, (perCreator.get(post.author_id) ?? 0) + 1);
          result.admitted.set(post.id, { post, rule: rule.id }); entry.admitted++;
        }
        cursor = found.nextToken;
        if (!cursor) break;
      }
    } catch (error) { entry.error = (error as Error).message.slice(0, 200); }
    await options.progress?.(result.stats);
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
