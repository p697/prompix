# Prompix

An open-source, mobile-first gallery of AI image and video prompts and agent skills. Browse it like a shop, then open a prompt in your favorite AI app with one tap.

> Status: early development. There is nothing to install yet.

## What it is

- A native iOS app (Android later) with a masonry feed, categories, search and personal collections that work offline.
- One-tap handoff: open ChatGPT, Claude, Gemini or Grok with the prompt filled in, or copied to the clipboard where an app does not support prefilling.
- A content operations agent that curates openly licensed content every day, with an admin console where humans review and edit.

## Content and licensing

- The code in this repository is released under the MIT License.
- Prompts, images and skills shown in the app keep their original licenses and attribution. Prompix only shows content whose license allows it.
- Creators can ask for their work to be removed by opening a GitHub issue; takedown requests are handled promptly.

## Not affiliated

Prompix is an independent project and is not affiliated with OpenAI, Anthropic, Google or xAI. Product names are used only to describe compatibility.

## Repository layout (planned)

| Path | Purpose |
|---|---|
| `ios/` | Native iOS app (SwiftUI) |
| `agent/` | Content operations agent |
| `admin/` | Admin console (Payload CMS) |
| `web/` | Web companion (Next.js) |
| `docs/` | Product and technical docs |

## Contributing

Prompix is built mostly by AI coding agents. Rules for agents and humans working in this repository are in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
