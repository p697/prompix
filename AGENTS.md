# Working on Prompix

Prompix is built mostly by AI coding agents. These rules apply to every agent and human working in this repository.

## Start here

- Read [docs/README.md](docs/README.md) before starting any task. Key decisions are in `docs/decisions/` (one file each) and, before 2026-11-07, `docs/decisions.md`, milestones and task breakdowns in `docs/roadmap.md`, specs in the other files under `docs/`, and UI mockups in `design/v2/`.
- Before changing UI, read [docs/design-language.md](docs/design-language.md) for the current palette, page-loading motion, recovery states and native component rules.
- When code and docs disagree, the code wins; update the docs in the same PR.
- Record each new key decision as its own file in `docs/decisions/` (see its README). Never append to `docs/decisions.md`, which is read-only history, and never rewrite earlier entries.

## Workflow

- Never commit to `main` directly. For each task, create a git worktree outside the main checkout (for example `../worktrees/<branch>`) on a new branch from the latest `origin/main`.
- Every change goes through a pull request. Merge your own PR with a squash merge as soon as your own verification passes and CI (when it runs) is green. Do not ask the owner for permission to merge; that is the default. If verification or CI fails, fix it before merging. Right after opening the PR, enable auto-merge with squash (`gh pr merge --auto --squash`); `main` requires the `content` and `ios` checks (types, builds and data validation, about two minutes), so it lands only when they pass. The full suites run without holding the merge: `node-tests` on each pull request, `ios-tests` once per merge on `main`; run the affected tests and `scripts/preflight.sh` locally before opening the PR. Do not deploy a service until `node-tests` is green. An app build may go to the owner's device once the required checks pass, since the affected tests already ran locally; do not hold it for `ios-tests`. If either suite fails after merging, fixing it comes before anything else.
- After a PR is merged or abandoned: delete the remote branch, remove the worktree and the local branch, then fast-forward the main checkout to `origin/main`. If the main checkout has uncommitted changes, leave it alone and report it. `scripts/ship-pr.sh <n>` does all of this once the PR is merged; add `--ios` to install the merged app on the owner's device (`~/.config/prompix/device.env`).
- Write commit messages and PR titles in concise, imperative English.
- Drive agreed work to the end without waiting on the owner. Once a change is merged, deploy it yourself (for example `npx wrangler deploy --config services/<name>/wrangler.jsonc` from the updated main checkout) and verify it on the live service. Then move on to the next agreed step. Ask only for real product decisions or for actions the safety rules reserve for the owner.
- To wait for CI or a merge, run `scripts/ship-pr.sh <n>` in the background; it wakes you when the PR is merged, or as soon as it conflicts with `main` or fails a required check, so rebase or fix at once instead of waiting. Never treat an unknown or failed GitHub answer as merged, and never install a build until `main` contains the merge. Do not ask the owner to report progress, and do not poll in a loop.

## Data pipeline control

- Operate the content pipeline only through `npm run pipeline -- <command>`; see [docs/data-pipeline-v2.md](docs/data-pipeline-v2.md). Never edit files under `~/.local/share/prompix/pipeline/` by hand.
- Every change names its author: `--by codex`, `--by claude-code`, or the person. Add `--reason` when the owner gave one.
- To answer "is the pipeline running and how is it going", run `status --brief`, then `log` only if something looks wrong.
- To answer why items are not online, how many are pending, or where one item is stuck, run `funnel` or `item <id>` and quote its output. Do not count by reading the content stores by hand, and label anything the command does not cover as unverified. Do not poll more often than every two hours unless the owner asks; failures alert through the monitor.
- Model choice is routing (`route <stage> <provider>`), not code. Add a vendor as an adapter under `ingest/models/`.

## Secrets

- Never commit secrets. Real values live outside the repository in `~/.config/prompix/*.env`; only variable names may appear in the repository, for example in an `.env.example` file.
- GitHub push protection is enabled for this public repository. Never bypass it.

## Content and legal

- Never commit third-party content (prompt datasets, images, videos) to this repository. Content is produced by the agent pipeline and published to object storage with per-item license and attribution.
- Ingest only allowlisted sources, and honor each source's license and terms. Do not scrape sites that forbid it.
- Never add private research notes or internal documents of any company.

## Engineering

- Performance and stability come first. Do not break existing behavior.
- Keep implementations simple and maintainable: remove dead code, and extract shared logic once it is reused.
- Write code, comments and identifiers in English. Product docs may be written in Chinese.
