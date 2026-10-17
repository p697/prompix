// Synthetic original content only; no provider captures or credentials.
export const text = "Image prompt:\nCreate an original watercolor garden with warm morning light, delicate green leaves and a clear focal point.";
export const at = "2026-10-17T14:00:00.000Z";
export const photo = (key: string) => ({ media_key: key, type: "photo", media_url_https: `https://pbs.twimg.com/media/${key}.jpg`,
  ext_media_availability: { status: "Available" } });
export function tweet(id = "101"): any {
  return { __typename: "Tweet", rest_id: id,
    core: { user_results: { result: { __typename: "User", rest_id: "9", core: { name: "Fixture", screen_name: "fixture" },
      privacy: { protected: false }, legacy: {} } } },
    legacy: { id_str: id, user_id_str: "9", full_text: text, created_at: at, conversation_id_str: id,
      is_quote_status: false, entities: { urls: [] }, extended_entities: { media: [photo("first"), photo("second")] } } };
}
export const envelope = (...tweets: unknown[]) => ({ result: { tweetResult: tweets.map(result => ({ result })) } });

