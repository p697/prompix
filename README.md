# Prompix

An open-source, native mobile app for discovering interesting AI prompts across text, images, video, and websites. Explore a feed, see what a prompt can do, save it, and use it in your preferred tool.

> Status: product planning and design direction review. There is nothing to install yet. Client development starts after the user approves the design direction.

## What it is

- A discovery experience inspired by browsing mobile Taobao and Xiaohongshu: engaging cards, useful topics, and room to explore without a search query.
- A native iOS app first, followed by a separate native Android app.
- All four prompt types in v1, with previews suited to each type, keyword search, filters, local favorites, editing, copying, and system sharing.
- A lightweight, self-built collection and publishing pipeline. No complex operations agent or dedicated admin system is required for v1.

The first installable milestone is an iPhone build for user acceptance. Simulator testing supports development; device installation requires suitable Apple signing and distribution arrangements.

## Scope

V1 includes text, image, video, and website prompts. Skills, MCP, accounts and sync, community features, in-app generation, personalized recommendations, and a full web companion are deferred. Website prompts are content in the app; they are distinct from a future Prompix website product.

## Content and licensing

The repository code is MIT licensed. Collected prompts and media retain their own licenses and attribution. Original and adapted prompts are labeled accordingly. Third-party datasets and media are not committed to this repository. Content removal requests can be raised through GitHub issues.

Prompix is independent and is not affiliated with the AI tool providers. Product names describe intended compatibility, not guaranteed results or a partnership.

## Docs and design

Read [docs/README.md](docs/README.md) for the current product, technical plan, roadmap, and decisions. Product documents are written in Chinese.

[design/v2](design/v2/index.html) contains historical HTML mockups, not an app implementation or the approved v1 design. The next milestone is to confirm a design direction and core screens before client development.

## Repository layout (planned)

| Path | Purpose |
|---|---|
| `ios/` | Native iOS app |
| `ingest/` | Collection, validation, media processing, and publishing scripts |
| `packages/schema/` | Shared content and manifest schema |
| `site/` | Product, privacy, and support pages needed for release |
| `docs/` | Product and technical documents |
| `design/` | Design references and mockups |

See [AGENTS.md](AGENTS.md) for the required worktree and pull request workflow.
