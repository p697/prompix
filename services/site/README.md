# Public website

The bilingual product, support, privacy and content-reporting site at
`https://prompix.dev`. This is a static companion to the native iOS app, not a web
implementation of the app. It has no user accounts, analytics, third-party
scripts, database or forms that submit user data.

## Build and preview

From the repository root, with Python 3, Node 22 and the repository dependencies:

```sh
python3 services/site/build.py
node --check services/site/site.js
npx wrangler dev --config services/site/wrangler.jsonc --port 8788
```

English pages live at `/`, `/support`, `/privacy`, `/content` and `/report`.
Chinese pages use `/zh` and the same suffixes. The example dialog uses only
original Prompix Studio prompts from the bundled catalog. Website assets are
first-party; do not add collected media to this directory.

## Publish

```sh
python3 services/site/build.py
npx wrangler deploy --config services/site/wrangler.jsonc
```

The `prompix-site` Worker serves static assets on the root custom domain. It has
no bindings and is independent of the `prompix-content` API Worker. Generated
files in `dist/` are ignored by Git. Verify every localized page, the custom 404,
security headers, mobile example dialog and copy action after deployment.

`/report?id=<public-prompt-id>` shows a public ID and prefills the repository's
content issue form. It does not submit a report; the user reviews and submits
on GitHub. Personal drafts and saved state never enter this URL. Issue templates
must exist on the default branch before the feedback links can work. GitHub
feedback is public and requires an account; the UI states this before leaving.

Support, privacy and content-report pages also offer `support@prompix.dev` as a
private email contact. Cloudflare Email Routing forwards only that exact address
to the account owner's existing verified destination; the private destination
must never appear in the repository. No Prompix or GitHub account is required.
The website opens the user's mail app and sends nothing itself. Include the
displayed public prompt ID manually when emailing a content report.

Routing configuration is enabled and its DNS records resolve. This does not by
itself prove end-to-end delivery; no outbound test email was sent during setup.
Sanitized configuration evidence lives outside Git at
`~/.local/share/prompix/release-candidate/support-routing.json`.

Before App Store submission, review the privacy text against the final build's
network behavior, SDKs and Cloudflare settings. Keep the support channel and
the support page in agreement.
