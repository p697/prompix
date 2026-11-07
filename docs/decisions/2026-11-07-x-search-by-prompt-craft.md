# Search X by the words inside prompts, and drop rules that find nothing

Proposed 2026-11-07, pending the owner's approval. It changes the search rules approved the same day (`ingest/x-search-rules.ts`).

Research on real searches of 2 November 2026 (Japan day, $0.77 of X spend in total) measured every rule against the whole pool of posts that any rule can return: a prompt word, an image or video, at least 20 likes. That pool held 1,104 posts and 291 usable prompts. The approved rules returned 334 of them. Replaying the nightly quotas, they admitted 168 posts, 93 of them usable.

- Words that appear inside prompts, such as composition, lighting, camera, aspect ratios, 构图, 縦長 and masterpiece, find prompt posts precisely. The new craft rules returned 305 posts in real searches, and 278 (91%) held a usable prompt, against 26% for the pool as a whole. A new craft lane takes a fifth of the day.
- Eight model rules (Flux, Seedream, Ideogram, Veo, Kling, Hailuo, Runway, Wan) returned no usable prompt that day, and most returned nothing at all; their quota went unused. They are removed, and posts about those models still arrive through the use and craft lanes. Grok Imagine (16 usable images and 4 videos that day) and dance video replace them.
- Product, food, wallpaper and infographic returned two or three posts a day each. They are searched as one rule so their share is used.
- Exploration found 4 usable prompts in 25 posts and drops from 10% to 5%. Use drops from 40% to 35% and model from 25% to 15%. Creators keep 25%.

Replayed on the same day, the new rules admit 222 posts, 138 of them usable (93 before), and 66 of those are not portraits (41 before). X spend per night stays about the same.
