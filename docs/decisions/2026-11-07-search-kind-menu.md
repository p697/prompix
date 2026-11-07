# Search narrows by kind with the discovery menu, not a pinned bar

The search results had a pinned bar of kind tabs (all, image, video, text) with a solid paper background under the system search field. Works scrolled behind the search field and were then cut off by the bar, so the top of the page read as a strip of pictures, a solid band, and pictures again. The owner found the bar odd and agreed to replace it.

Search now uses the same "Type ▾" menu as discovery, in a row above the works with the title "作品". The row scrolls away with the results. Kinds are changed rarely during a search, so they do not hold the top of the screen, and the app has one control for kind instead of two. The service returns no total, so the row shows no result count; the offline fallback, which knows its count, shows it as the title.

Changing the query or the kind, or cancelling the search, now returns the page to the top. Before, cancelling after scrolling kept the deep offset on the much shorter search home, which showed only blank paper until the owner scrolled back up.

Rejected:
- The system `searchScopes` control is another full-width bar under the field.
- Unpinned tabs would still differ from discovery.
