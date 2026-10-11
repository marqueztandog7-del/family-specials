#!/bin/bash
# One command for the Mac: pull the latest, run the stores GitHub can't (run_on: mac in
# config/stores.yaml), append their prices to the history files, rebuild the page data, push.
#
#   ./scripts/mac-update.sh            only stores that are due this cycle
#   ./scripts/mac-update.sh --force    run them even if already collected this cycle
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

git pull -q --rebase --autostash
uv run specials update --where mac "$@"

git add history
if ! git diff --cached --quiet; then
  git commit -q -m "Prices: $(date +%Y-%m-%d) Mac run"
fi
# Pick up anything GitHub pushed meanwhile, then rebuild the page data from everything.
git checkout -- site/data 2>/dev/null || true
git pull -q --rebase
uv run specials update --no-collect --no-publish
git add site/data
git diff --cached --quiet || git commit -q -m "Page data: $(date +%Y-%m-%d) (Mac)"
git push -q
echo "Done. The family page updates in a minute or two."
