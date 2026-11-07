#!/usr/bin/env bash
# Run the required `content` checks that apply to this branch before opening a
# pull request, so CI is not the first place a localization or type error shows.
# Usage: scripts/preflight.sh            (compares with origin/main)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base=$(git merge-base HEAD origin/main)
changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)
touches() { grep -qE "$1" <<<"$changed"; }
step() { printf '\n== %s\n' "$1"; }

step "Interface localizations"
python3 scripts/check-localizations.py >/dev/null && echo "ok"

if touches '^scripts/.*\.py$'; then
  step "Scheduler and release audit safety"
  python3 -m unittest discover -s scripts -p 'test_scheduler.py' -q
  python3 -m unittest discover -s scripts -p 'test_release_audit.py' -q
fi

if touches '^services/site/public/site\.js$'; then
  step "Website script"
  node --check services/site/public/site.js && echo "ok"
fi

# TypeScript, Workers and the bundled catalog need node_modules; skip them
# when nothing they read has changed.
if touches '^(services|ingest|packages|scripts)/.*\.(ts|js|mjs|json)$|^package(-lock)?\.json$|^tsconfig|^ios/Prompix/Resources/catalog\.json$'; then
  [[ -d node_modules ]] || { step "Install dependencies"; npm ci --ignore-scripts --silent; }
  step "Typecheck"
  npm run --silent typecheck && echo "ok"
  step "Bundled catalog"
  npm run --silent validate -- ios/Prompix/Resources/catalog.json >/dev/null && echo "ok"
  for service in feed monitor site; do
    if touches "^services/$service/|^packages/"; then
      step "Build $service Worker"
      npx wrangler deploy --dry-run --config "services/$service/wrangler.jsonc" >/dev/null && echo "ok"
    fi
  done
fi

printf '\nPreflight passed. Also run the affected tests (see AGENTS.md).\n'
