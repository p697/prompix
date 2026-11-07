# One file per decision, preflight before PRs, and a shipping script

Shipping one app change on 2026-11-07 took far longer than the work. Three causes were each fixed in the workflow:

- Every session appended to `docs/decisions.md`, so any pull request merged first put the next one in conflict. While a pull request conflicts, CI does not start and auto-merge waits silently. New decisions are now one file each under `docs/decisions/`; the old file is kept read-only.
- A hand-written wait loop read an empty answer from a failed GitHub request as "no longer open". It installed main on the owner's iPhone before the change was merged. `scripts/ship-pr.sh` replaces these loops. It retries network errors and treats only MERGED as merged. It stops at once on a conflict, a failed required check or a closed pull request. It cleans up the worktree and branches and fast-forwards the main checkout. With `--ios`, it installs only after confirming main contains the merge.
- A localization error first appeared in CI. `scripts/preflight.sh` runs the required `content` checks that apply to the branch before a pull request is opened.

The owner asked for faster delivery without lowering quality, so local tests and checks still run before every pull request.
