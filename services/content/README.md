# Content Worker

The read-only Worker streams published R2 objects through the existing `CONTENT` binding. Only `GET` and `HEAD` are accepted; other methods return `405` without reading storage.

Public paths:

- `/health`
- `/v1/latest.json` and `/v2/latest.json`
- `/releases/<version>/catalog.json`
- `/releases/<version>/v2/base.json`
- `/releases/<version>/v2/locales/<locale>.json`
- `/media/<sha256>.jpg`, `.png`, `.webp`, or `.mp4`
- `/examples/<sha256>.html`

Versions accept lowercase ASCII letters, digits and hyphens. Locale names must be exactly `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `es`, `pt-BR`, `fr`, or `de`. Release manifests, indexes, draft files and unsupported paths return `404` without reading R2. `/v2/latest.json` contains the complete v2 manifest; no separate release manifest or index is publicly exposed.

Both latest pointers use `Cache-Control: public, max-age=60`. Versioned artifacts and content-addressed media use `public, max-age=86400`. R2 ETags and GET byte ranges are preserved. Conditional GET and HEAD return `304` when unchanged, failed write-style preconditions return `412`, and HEAD responses have no body. Storage read failures return `503` rather than appearing as missing content.

Website examples require exactly 64 lowercase hexadecimal SHA-256 characters and the `.html` suffix, with no query or fragment. They use the same one-day cache, ETags, GET ranges and GET/HEAD preconditions. The full R2 object size must be at most 2,000,000 bytes, including for ranges and conditional requests; oversized objects return `413` with `no-store`, and any returned stream is cancelled. The Worker streams accepted bodies without buffering or fetching external resources. Publishing must bind the object bytes to their digest and complete the separate browser review; serving a path does not approve its content.

Example responses use fixed `text/html; charset=utf-8`, `no-referrer`, `X-Frame-Options: DENY` and a restrictive Permissions-Policy. Stored HTTP metadata is ignored for HTML. The shared `packages/schema/website-artifact.ts` CSP permits inline scripts/styles and data images, blocks external resource loads and connections, and applies `sandbox allow-scripts` without `allow-same-origin`, keeping demos in an opaque origin. The browser-review gate uses the same policy. The policy does not replace review of navigation, interactions, accessibility or content.

Run local synthetic checks with `npm test` and `npm run typecheck`; these do not contact production. After an explicitly authorized deployment, `npm run check:deployment` checks v1 and any available v2 release. Only a direct `404` at `/v2/latest.json` permits v2 to be absent during bootstrap. Redirects, server errors, malformed manifests, missing packs and integrity failures fail the check. `npm run check:deployment -- --require-v2` additionally requires an active v2 release.

The deployment check downloads every advertised v2 language pack with decoded byte limits, verifies SHA-256, byte counts and release identities through the pure full-join codec, and probes ETags, caches, conditional GET and HEAD for every artifact. The result reports each channel separately because v1 and v2 may intentionally point to different releases.
