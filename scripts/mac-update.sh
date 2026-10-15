#!/bin/bash
# The Mac's update. Run by the schedule at 7:30am and 6:30pm, or by hand.
#
#  1. Pull the latest from GitHub.
#  2. Collect the stores set to run_on: mac, but ONLY those whose new specials are due this cycle
#     (Woolworths from Wednesday, Coles' small weekly read from Wednesday). Most runs are just
#     checks: nothing is due, nothing is collected, nothing is committed.
#  3. If something was collected: commit its history, pull again, rebuild the page data, push.
#  4. Weekly backup to iCloud Drive, straight after the Wednesday update (only if due).
#  Problems show a Mac notification and are written to data/logs/collect.log.
#
#   ./scripts/mac-update.sh            normal run
#   ./scripts/mac-update.sh --force    collect the Mac's stores even if not due
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Family Specials\"" >/dev/null 2>&1 || true; }

log "Update started"
# Keep the Mac awake until this script finishes, but only when it's plugged in (caffeinate -s
# only works on mains power). On battery the Mac may sleep; the run then finishes when it wakes.
caffeinate -s -w $$ &
if ! git pull -q --rebase --autostash; then
  log "Couldn't pull from GitHub"; notify "Update stopped: couldn't pull from GitHub"; exit 1
fi

status=0
uv run specials update --where mac "$@" || status=$?

git add history
if git diff --cached --quiet; then
  log "Nothing new collected on the Mac (just a check)."
  git checkout -- site/data 2>/dev/null || true
else
  git commit -q -m "Prices: $(date +%Y-%m-%d) Mac run"
  # Pick up anything GitHub pushed meanwhile, then rebuild the page data from everything.
  git checkout -- site/data 2>/dev/null || true
  if git pull -q --rebase && uv run specials update --no-collect --no-publish; then
    git add site/data
    git diff --cached --quiet || git commit -q -m "Page data: $(date +%Y-%m-%d) (Mac)"
    if git push -q; then log "Pushed. The family page updates in a minute or two."
    else log "Couldn't push to GitHub"; notify "Update: couldn't push to GitHub"; status=1; fi
  else
    log "Couldn't merge GitHub's changes"; notify "Update: couldn't merge GitHub's changes"; status=1
  fi
fi
if [ "$status" -ne 0 ]; then
  notify "A store was blocked or failed on the Mac. See data/logs/collect.log"
fi

# Weekly backup straight after the Wednesday update. It notifies by itself if it fails.
uv run specials backup --if-due || status=1

log "Update finished (status $status)"
exit "$status"
