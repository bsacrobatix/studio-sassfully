#!/usr/bin/env bash
# Mark a receipt-admitted POG candidate for the emergency promotion lane.
#
# The emergency lane has precedence over the normal durable queue, but is FIFO
# within itself.  This command never lands a candidate, edits main, bypasses a
# receipt, or preempts work already holding the protected landing lock.
set -euo pipefail

usage() {
  echo 'usage: scripts/mark-promotion-emergency.sh [--source-root <path>] [--skip-tests] <candidate-id-or-sha>' >&2
}

source_root=""
candidate=""
skip_tests=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-root) source_root="${2:?--source-root requires a value}"; shift 2 ;;
    --skip-tests) skip_tests=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      [ -z "$candidate" ] || { usage; exit 2; }
      candidate="$1"
      shift
      ;;
  esac
done
[ -n "$candidate" ] || { usage; exit 2; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[ -n "$source_root" ] || source_root="$(git -C "$script_dir/.." rev-parse --show-toplevel)"
source_root="$(cd "$source_root" && pwd -P)"
state="$source_root/.capsules/queue/state.json"
lane="$source_root/.capsules/queue/pog-emergency.json"
lock="$source_root/.capsules/queue/state.lock"

[ -f "$state" ] || { echo "error: no receipt-admitted queue state at $state" >&2; exit 1; }
mkdir -p "$(dirname "$lane")"

# The receipt queue and this sidecar share a lock so a mark never races a
# submission/state rewrite.  The full gate never holds this lock.
deadline=$(( $(date +%s) + 60 ))
while ! (set -C; : >"$lock") 2>/dev/null; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "error: timed out marking emergency candidate" >&2; exit 1; }
  sleep 1
done
cleanup() { rm -f "$lock"; }
trap cleanup EXIT

row="$(jq -cer --arg candidate "$candidate" '
  [.candidates[]
   | select((.id == $candidate or .sha == $candidate)
       and (.status == "queued" or .status == "retry_wait"))]
  | if length == 1 then .[0] else empty end
' "$state")" || {
  echo "error: emergency candidate must name exactly one queued or retry-wait receipt candidate: $candidate" >&2
  exit 1
}
id="$(jq -r '.id' <<<"$row")"
sha="$(jq -r '.sha' <<<"$row")"

if [ -f "$lane" ]; then
  jq -e '.schema == "pog/emergency-promotion-lane/v1" and (.entries | type == "array") and (.sequence | type == "number")' "$lane" >/dev/null || {
    echo "error: invalid emergency promotion lane: $lane" >&2
    exit 1
  }
else
  printf '%s\n' '{"schema":"pog/emergency-promotion-lane/v1","sequence":0,"entries":[]}' >"$lane"
fi

# Idempotence preserves the original emergency sequence.  A later request can
# never leapfrog a previously declared emergency item.
if jq -e --arg id "$id" --arg sha "$sha" '.entries[] | select(.id == $id and .sha == $sha)' "$lane" >/dev/null; then
  echo "promotion emergency: already queued id=$id sha=$sha"
  exit 0
fi

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tmp="$(mktemp "$(dirname "$lane")/.pog-emergency.XXXXXX")"
jq --arg id "$id" --arg sha "$sha" --arg now "$now" --argjson skip_tests "$skip_tests" '
  .sequence += 1 |
  .entries += [{id:$id, sha:$sha, sequence:.sequence, requested_at:$now, skip_tests:($skip_tests == 1)}]
' "$lane" >"$tmp"
chmod 0600 "$tmp"
mv "$tmp" "$lane"
if [ "$skip_tests" -eq 1 ]; then
  echo "promotion emergency: queued id=$id sha=$sha test_gates=waived"
else
  echo "promotion emergency: queued id=$id sha=$sha"
fi
