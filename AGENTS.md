# Working on Prompix

Prompix is built mostly by AI coding agents. These rules apply to every agent and human working in this repository.

## Workflow

- Never commit to `main` directly. For each task, create a git worktree outside the main checkout (for example `../worktrees/<branch>`) on a new branch from the latest `origin/main`.
- Every change goes through a pull request. Once CI passes, or when no CI applies to the change, the author may merge their own PR with a squash merge.
- After a PR is merged or abandoned: delete the remote branch, remove the worktree and the local branch, then fast-forward the main checkout to `origin/main`. If the main checkout has uncommitted changes, leave it alone and report it.
- Write commit messages and PR titles in concise, imperative English.

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
