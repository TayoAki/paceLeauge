#!/usr/bin/env bash
# Builds the board-style evidence sheets in docs/evidence/web/ from a walkthrough run.
#   OUT_DIR=/tmp/shots npm run e2e:web && bash scripts/e2e/evidence-sheets.sh /tmp/shots
set -euo pipefail
SHOTS="${1:?usage: evidence-sheets.sh <screenshot dir> [out dir]}"
OUT="${2:-docs/evidence/web}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$OUT"

sheet() {
  local name="$1" title="$2"
  shift 2
  local files=()
  for shot in "$@"; do files+=("$SHOTS/$shot.png"); done
  node "$ROOT/scripts/e2e/contact-sheet.mjs" "$OUT/$name.jpg" "$title" "${files[@]}"
}

sheet 01-run-loop "01 · The run loop (board 01)" 03-today 05-running 07-summary
sheet 02-compete-progress-share "02 · Compete, see progress, share (board 02)" 09-league 11-progress 13-share
sheet 03-start-private "03 · A clear start, private by default (board 03)" 01-welcome 04-preflight-ready 14b-privacy
sheet 04-sign-in-and-recording "Sign-in, preflight and recording states" 01c-sign-in-code 04a-preflight-permission 04b-countdown 05a-running-early 06-paused
sheet 05-after-the-run "After the run: accepted, offline, personal-only" 03b-today-after 07b-summary-offline 07c-summary-synced-later 07d-summary-personal-only 11b-progress-after
sheet 06-new-runner-and-invites "New runner, no crew, invite and join" 02-onboarding 03c-today-new-runner 08-league-empty 10-invite 10b-joined-league
sheet 07-league-details "League details" 09b-invite-sheet 09c-league-rules 09d-league-last-week 09e-member-sheet 09f-manage-league
sheet 08-run-detail "Run detail" 12-run-detail 12b-run-detail-splits
sheet 09-profile "Profile" 14-profile 14c-edit-profile 14d-notifications 14e-blocked 14f-support
sheet 10-export-and-deletion "Export and account deletion" 15-export 16-delete-account 16b-delete-confirm 16c-after-deletion
