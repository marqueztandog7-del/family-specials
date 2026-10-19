#!/bin/bash
# The Mac's update. Run by the schedule at 7:30am and 6:30pm, or by hand.
#
#  1. Pull the latest from GitHub.
#  2. `specials update`: every store refreshes once a week, from Wednesday morning (its specials, its full range,
#     then its printed catalogue), and only when due. Most runs are just checks: nothing is due, nothing is
#     collected. After a refresh: matching, the public specials file, the product ranges and the family's private
#     watchlist to Supabase, and phone notifications.
#  3. If the public files changed (history: specials only; site/data: every store's specials), commit and push.
#  4. Weekly backup to iCloud Drive, straight after the Wednesday update (only if due).
#  A store that refuses us is paused until you run `uv run specials resume <store>`. Problems show a Mac
#  notification and are written to data/logs/collect.log.
#
#   ./scripts/mac-update.sh            normal run
#   ./scripts/mac-update.sh --force    refresh every store now, even if not due
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

# Only store data goes to GitHub: specials history and the public specials file. Never the watchlist.
git add history site/data
if git diff --cached --quiet; then
  log "Nothing new to publish (just a check)."
else
  git commit -q -m "Specials: $(date +%Y-%m-%d) (Mac)"
  if git pull -q --rebase && git push -q; then log "Pushed. The family page updates in a minute or two."
  else log "Couldn't push to GitHub"; notify "Update: couldn't push to GitHub"; status=1; fi
fi
if [ "$status" -ne 0 ]; then
  notify "A store refused us or failed on the Mac (it's paused until you resume it). See data/logs/collect.log"
fi

# Weekly backup straight after the Wednesday update. It notifies by itself if it fails.
uv run specials backup --if-due || status=1

log "Update finished (status $status)"
exit "$status"
