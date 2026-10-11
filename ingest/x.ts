import { download } from "./network.ts";
/** X search is discovery only: tweets are not automatically republished as licensed prompts. */
export async function searchX(bearer: string, since?: string) {
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set(
    "query",
    '("prompt" OR "提示词") ("Seedance" OR "Nano Banana" OR "website" OR "tarot") -is:retweet -is:reply',
  );
  url.searchParams.set("max_results", "10");
  url.searchParams.set("tweet.fields", "created_at,author_id,public_metrics");
  if (since && /^\d+$/.test(since)) url.searchParams.set("since_id", since);
  const result = await download(url.toString(), ["api.x.com"], 500_000, {
    Authorization: `Bearer ${bearer}`,
  });
  const body = JSON.parse(result.bytes.toString());
  if (body.errors?.length)
    throw new Error("X returned partial errors; cursor unchanged");
  return {
    posts: body.data ?? [],
    newest: body.meta?.newest_id as string | undefined,
  };
}
