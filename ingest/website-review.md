# Community website artifact review

A community website is eligible only after the existing source, license, content-safety and editorial gates plus a trusted review of its actual hosted result. This first path supports attributed `prompts.chat` entries pinned to a 40-character repository revision with `CC0-1.0`; it does not add a source allowlist entry or grant native X publication permission. The six bundled original websites retain their existing behavior.

The result uses the current catalog fields `media.demoURL` and `media.imageURL`. The app already opens an external demo from these fields; no new native schema, executable bundle or language-pack field is introduced. Synthetic v1/v2 nine-language roundtrip tests check the contract; they do not claim native UI testing.

## Host an original, self-contained artifact

Keep the source prompt, original HTML, screenshots and review records outside Git, normally beneath `~/.local/share/prompix/`. Finish the artifact before reviewing it. It must be original CC0 HTML, at most 2,000,000 decoded bytes, with inline CSS/JavaScript and optional data images. No remote scripts, styles, images, frames, fonts or network APIs are permitted. Do not make untested service, payment, customer or privacy claims. Label fictional example testimonials/pricing, and implement meaningful interactions instead of simulated submission success.

After separate operational authorization to host, upload the exact HTML bytes to the existing R2 content bucket as `examples/<sha256>.html`. The only accepted public origin/path is `https://api.prompix.dev/examples/<lowercase-64-character-sha256>.html`, with no query, fragment, credentials or redirect. This lives independently of static-site deployments. Do not overwrite a content-addressed object with changed bytes: any edit gets a new hash, URL and browser review.

The read-only Worker serves a forced `text/html; charset=utf-8` type and the shared policy from `packages/schema/website-artifact.ts`. Its opaque-origin `sandbox allow-scripts` omits same-origin, forms, popups and top navigation privileges; CSP blocks network resources, connections and framing. Permissions policy disables sensitive capabilities. Inline demo JavaScript can run, so these limits do not replace trusted inspection of actual behavior or links. The browser review must take place at the hosted URL under these exact response headers, not only on a local file.

Prepare a final JPEG preview from the actual rendered demo, then host those exact bytes as `media/<sha256>.jpg`. It must be at most 8,000,000 bytes. Any JPEG resizing/compression must happen **before** calculating the reviewed hash. Daily deliberately bypasses normal media mirroring/re-encoding for these web entries. The independent gate fetches and verifies both the hosted HTML and the preview with no redirects and decoded byte limits every normal publishing run. A filename or screenshot alone never establishes correctness.

## Preserve the attachment across source refreshes

Do not edit the replaceable `candidates/prompts-chat.json` discovery snapshot. Use the existing external editorial metadata file and command:

```sh
npm run review -- <candidate-id> /absolute/external/editorial-metadata.json
```

In addition to required title, summary, example, tags and previewLabel, the metadata must include the exact final hosted `imageURL` and `demoURL`. This persists the fingerprint-bound override in `<content-root>/editorial.json`; `applyEditorialReviews` restores it after each source recollection. The command prepares metadata only and does not approve browser behavior or publish. Keep the original prompt and attribution unchanged.

## Record genuine browser evidence

The operator chooses trusted reviewer IDs in a separate `<content-root>/web-review/trust.json`:

```json
{"version":1,"demoOrigin":"https://api.prompix.dev","reviewers":["operator-reviewer"]}
```

A source, content artifact or automatic model output may not add itself to this trust file or create its own approval. A human operator or authorized agent can act as the trusted reviewer after genuine browser interaction and comparison. Treat the trust file with the same operator control as editorial records. No signing service is introduced.

The reviewer must inspect the complete source prompt against the hosted result, its source attribution and the actual public JPEG preview. Use a mobile viewport (320–600 CSS pixels wide) and a desktop viewport (at least 1024 pixels wide), with separate screenshots. At both sizes check layout and keyboard behavior, and record actual actions, expected results and observations for the important interactions. At minimum exercise each CTA, navigation/menu, planner or other working feature, and FAQ. A passing screenshot, automated metadata decision or image-only model response is insufficient. Do not mark controls passed without operating them.

Store the exact preview and viewport screenshots privately at `web-review/evidence/<sha256>.jpg` or `.png`. Each is bounded at 8,000,000 bytes. The review is a strict `WebsiteReview` record defined by `websiteReviewSchema` in `website-review.ts`, containing:

- `version: 1`, `identity`, item `id`, `promptSHA256` over exact published UTF-8 text and `sourceSHA256` from `websiteSourceSHA256(item)`.
- `artifact`: exact URL, SHA-256, byteLength, `format: "self-contained-html"`, original artifact author and `license: "CC0-1.0"`.
- `preview`: SHA-256, byteLength and `format: "jpg"` for the exact public JPEG.
- Trusted `reviewerID`, actual ISO `reviewedAt`, `verdict: "approve"`, `method: "browser-interaction"`.
- `attestations`: all seven explicitly true only after verification: `completePromptCompared`, `hostedArtifactInspected`, `previewMatchesHostedArtifact`, `sourceAttributionVerified`, `sampleContentClearlyLabeled`, `noSimulatedSuccess`, `noRemoteSubresources`.
- `mobile` and `desktop`: width/height, a distinct screenshot descriptor, `layoutPassed`, `keyboardPassed`, and an array of `{action, expected, observed, passed}` records.

Calculate `identity` with `websiteReviewIdentity(item, artifactSHA256)` on the final planned item after editorial media overrides and existing `publicationText` expansion. The identity binds exact prompt bytes, all source attribution, model, content type, artifact and selected media. Changes to prompt whitespace, source author/revision/license, HTML or preview invalidate the approval. Editorial wording and translated presentation do not grant a new approval or alter the source instructions. The current path requires the pinned `pc-` identity still match its published prompt, so unsupported upstream macro transformations remain withheld.

Write the completed, schema-validated record under its exact identity in `<content-root>/web-review/reviews.json`:

```json
{"version":1,"reviews":{"<exact-review-identity>":"<complete WebsiteReview object>"}}
```

The string above is explanatory, not a valid approval record. Only the actual completed object passes. Use the existing content lock and atomic file replacement when updating operator records; preserve other records. `websiteReviewer(contentRoot)` is a read-only verifier that can be called against the final item before the normal collector runs. It validates the store, evidence bytes, trusted reviewer and hosted responses; it writes no approval or publication state.

## Publication and failure behavior

Normal publishing calls the website verifier before admitting a new or changed item, including when the image model is disabled or its request allowance is exhausted. `visualReview.websitesReviewed` and each `website-reviewed` item status distinguish these checks from automated `approved` counts and model `requests`. Missing, stale, incomplete or tampered evidence defers the candidate. Corrupt trust/review files stop publication rather than silently discarding approvals. A missing store simply leaves community web items deferred.

A prior web snapshot cannot serve as a new browser approval. The existing retention merger preserves a complete previously published snapshot when a replacement is withheld; it never silently removes the item or pretends the failed check passed. Explicit tombstones still remove it. A new unreviewed web item stays absent. Daily dry-runs stay offline and do not verify hosted web artifacts; use the explicit read-only verifier for a network preflight.

This change supplies the code path and synthetic checks, not an already completed community website publication. Actual hosting, mobile/desktop browser review, screenshots, editorial attachment, translation, publication and native opening remain separate acceptance steps. No video or X eligibility gate is relaxed.
