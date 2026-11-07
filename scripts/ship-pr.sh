#!/usr/bin/env bash
# Wait until a pull request is really merged, then clean up and bring the main
# checkout to origin/main. With --ios, also build the merged app in Release and
# install it on the owner's device.
#
# Exits early, with the reason, when the pull request conflicts with main, a
# required check fails, or it is closed: those need an agent, not more waiting.
# Network errors from GitHub are retried; an unknown answer never counts as merged.
#
# Usage: scripts/ship-pr.sh <number> [--ios]
# --ios reads PROMPIX_DEVICE_ID and PROMPIX_TEAM_ID from ~/.config/prompix/device.env.
set -uo pipefail
pr=${1:?usage: scripts/ship-pr.sh <number> [--ios]}
ios=false; [[ ${2:-} == --ios ]] && ios=true
main=$(git worktree list --porcelain | awk 'NR==1 { print $2 }')

while true; do
  if ! view=$(gh pr view "$pr" --json state,mergeStateStatus,headRefName,mergeCommit \
      -q '[.state, .mergeStateStatus, .headRefName, (.mergeCommit.oid // "")] | @tsv' 2>&1); then
    [[ "$view" == *"Could not resolve"* ]] && { echo "#$pr does not exist."; exit 1; }
    sleep 15; continue
  fi
  IFS=$'\t' read -r state status branch commit <<<"$view"
  case "$state" in
    MERGED) [[ -n "$commit" ]] && break ;;
    CLOSED) echo "#$pr was closed without merging."; exit 1 ;;
  esac
  if [[ "$status" == DIRTY ]]; then
    echo "#$pr conflicts with main; CI will not start. Rebase onto origin/main and push."; exit 2
  fi
  if failed=$(gh pr checks "$pr" --required --json name,bucket -q '[.[] | select(.bucket == "fail") | .name] | join(", ")' 2>/dev/null) && [[ -n "$failed" ]]; then
    echo "#$pr failed required checks: $failed"; exit 3
  fi
  sleep 15
done
echo "#$pr merged as ${commit:0:7}."

# Remove the pull request's worktree and branches, from outside it.
cd "$main"
worktree=$(git worktree list --porcelain | awk -v ref="refs/heads/$branch" '/^worktree / { path = $2 } $0 == "branch " ref { print path }')
if [[ -n "$worktree" && "$worktree" != "$main" ]]; then
  git worktree remove "$worktree" && echo "Removed worktree $worktree."
fi
git -C "$main" branch -D "$branch" >/dev/null 2>&1 && echo "Deleted local branch $branch."
git -C "$main" push -q origin --delete "$branch" 2>/dev/null && echo "Deleted remote branch $branch."

git -C "$main" fetch -q origin
if [[ -n $(git -C "$main" status --porcelain --untracked-files=no) ]]; then
  echo "The main checkout has uncommitted changes; left it alone."
elif [[ $(git -C "$main" branch --show-current) == main ]]; then
  git -C "$main" merge -q --ff-only origin/main && echo "Main checkout is at $(git -C "$main" log --oneline -1)."
fi

$ios || exit 0
if ! git -C "$main" merge-base --is-ancestor "$commit" HEAD; then
  echo "The main checkout does not contain #$pr; not installing."; exit 4
fi
# shellcheck disable=SC1090
source ~/.config/prompix/device.env
: "${PROMPIX_DEVICE_ID:?set in ~/.config/prompix/device.env}" "${PROMPIX_TEAM_ID:?set in ~/.config/prompix/device.env}"
derived=${PROMPIX_DERIVED_DATA:-/Volumes/Lucy-SSD/DerivedData/device}
xcodebuild -project "$main/ios/Prompix.xcodeproj" -scheme Prompix -configuration Release \
  -destination "id=$PROMPIX_DEVICE_ID" -derivedDataPath "$derived" \
  DEVELOPMENT_TEAM="$PROMPIX_TEAM_ID" -allowProvisioningUpdates -quiet build || exit 5
app="$derived/Build/Products/Release-iphoneos/Prompix.app"
bundle=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")
xcrun devicectl device install app --device "$PROMPIX_DEVICE_ID" "$app" >/dev/null || exit 6
xcrun devicectl device process launch --device "$PROMPIX_DEVICE_ID" "$bundle" >/dev/null || exit 6
echo "Installed and launched #$pr ($bundle) on the device."
