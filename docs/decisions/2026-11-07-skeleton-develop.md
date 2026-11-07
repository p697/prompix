# Skeletons share one sweep of light, and pictures develop in

The owner found the skeletons careless: the feed showed one tall and one short grey tile with nothing below, and the same two tiles stood in for search results, topics, creator works and related works. Three directions were mocked up on four screens (feed, detail body, feed rails, creator list), each looping from waiting to arrival: a static contact sheet, a single sweep of light with pictures developing in, and a breathing film grain. The owner chose the sweep ("显影").

What changed across the app:
- Every skeleton fills the screen in the real layout: the grid's columns, gaps and corners with the library's common shapes; the creator list in `CreatorRow`'s geometry with separators; the detail body as seven lines in the folded prompt's own rhythm under the real PROMPT row. Known titles stay visible; only what is missing is a skeleton. Text bars sit inside the real line height, so nothing moves when words arrive.
- One faint diagonal band passes over all skeletons at once. Each `LoadingSurface` draws its slice from a shared clock and its position on screen, so the light runs on across tiles and gaps instead of every tile shimmering on its own. It stops with Reduce Motion, in Low Power Mode, off screen and in the background.
- A work whose picture has not arrived shows its own main colour (`palette`) instead of grey. A picture that arrives from the network develops in, grey and flat to its own colour; cached pictures appear as they are.

This replaces the static-skeleton rule in `decisions.md` ("2026-10-17：以轻翻页取代圆圈粒子") for skeletons only; refresh and paging keep the page activity.

Rejected:
- The static contact sheet gives no sign that anything is still happening after a second.
- The breathing grain was the most distinctive but risked looking dirty in light mode across a full screen of tiles.
- Per-tile shimmer reads as a generic web loading pattern.
