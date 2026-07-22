#!/usr/bin/env bash
# Durably park (supersede) a queued/retrying POG candidate in the
# receipt-admitted durable queue so a single bad head cannot block every
# later candidate forever (report 01KXNX5Y445).
#
# This command never lands a candidate, edits main, or rewrites the history
# of a candidate that already reached the terminal "landed" state. It reuses
# the same "needs_input" terminal vocabulary scripts/process-promotion-queue.sh
# already uses when a persistently red head is parked past its retry budget,
# and it appends an auditable park decision (reason, actor, timestamp) rather
# than replacing any existing evidence.
set -euo pipefail

usage() {
  echo 'usage: scripts/park-promotion-candidate.sh --reason "<text>" [--source-root <path>] [--json] [--dry-run] [--force] <candidate-id-or-sha>' >&2
}

source_root=""
candidate=""
reason=""
json=0
dry_run=0
force=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-root) source_root="${2:?--source-root requires a value}"; shift 2 ;;
    --reason) reason="${2:?--reason requires a value}"; shift 2 ;;
    --json) json=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      [ -z "$candidate" ] || { usage; exit 2; }
      candidate="$1"
      shift
      ;;
  esac
done
[ -n "$candidate" ] || { usage; exit 2; }
[ -n "$reason" ] || { echo "error: --reason is required" >&2; exit 2; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[ -n "$source_root" ] || source_root="$(git -C "$script_dir/.." rev-parse --show-toplevel)"
source_root="$(cd "$source_root" && pwd -P)"
state="$source_root/.capsules/queue/state.json"
worker_lock="$source_root/.capsules/queue/pog-worker.lock"
lock="$source_root/.capsules/queue/state.lock"

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 127; }
[ -f "$state" ] || { echo "error: no receipt-admitted queue state at $state" >&2; exit 1; }

lock_owner_pid() {
  sed -n '1p' "$worker_lock/pid" 2>/dev/null || true
}

# The same exclusive worker lock scripts/process-promotion-queue.sh takes
# while it is validating/landing a candidate. A park must never race that: a
# live owner means a gate or a protected-main CAS may be in flight right now.
# Refuse rather than force, unless the caller explicitly accepts the risk.
# A lock directory whose recorded pid is no longer alive is not a live owner
# (the same distinction scripts/process-promotion-queue.sh's own stale-lock
# recovery makes); parking may proceed in that case without --force, but this
# script deliberately does not remove or steal the stale lock directory
# itself -- that recovery remains the worker's own responsibility.
if [ -d "$worker_lock" ]; then
  owner_pid="$(lock_owner_pid)"
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    if [ "$force" -ne 1 ]; then
      echo "error: promotion queue worker is active (owner pid=$owner_pid); refusing to park without --force" >&2
      exit 1
    fi
    echo "promotion park: worker lock is held by active owner pid=$owner_pid; proceeding because --force was passed" >&2
  fi
fi

# Serialize the state.json mutation with the same tiny state.lock that
# scripts/process-promotion-queue.sh and scripts/mark-promotion-emergency.sh
# already use, so a park can never interleave with another writer's
# read-modify-write cycle.
deadline=$(( $(date +%s) + 60 ))
while ! (set -C; : >"$lock") 2>/dev/null; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "error: timed out acquiring queue state lock" >&2; exit 1; }
  sleep 1
done
cleanup() { rm -f "$lock"; }
trap cleanup EXIT

row="$(jq -cer --arg candidate "$candidate" '
  [.candidates[] | select(.id == $candidate or .sha == $candidate)]
  | if length == 1 then .[0] else empty end
' "$state")" || {
  echo "error: candidate must identify exactly one durable queue entry: $candidate" >&2
  exit 1
}
id="$(jq -r '.id' <<<"$row")"
sha="$(jq -r '.sha' <<<"$row")"
phase="$(jq -r '.phase // .status' <<<"$row")"

if [ "$phase" = "landed" ]; then
  echo "error: candidate $id (sha=$sha) is already landed; parking a landed candidate would rewrite terminal history and is refused" >&2
  exit 1
fi

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
who="${POG_PARK_ACTOR:-${USER:-unknown}}"
detail="parked as needs_input by $who at $now: $reason"

if [ "$dry_run" -eq 1 ]; then
  if [ "$json" -eq 1 ]; then
    jq -n --arg id "$id" --arg sha "$sha" --arg reason "$reason" --arg now "$now" --arg who "$who" --arg from_phase "$phase" '
      {schema:"pog/promotion-park/v1", dry_run:true, id:$id, sha:$sha, from_phase:$from_phase, status:"needs_input", reason:$reason, parked_at:$now, parked_by:$who}
    '
  else
    echo "promotion park (dry-run): would park candidate $id (sha=$sha, phase=$phase) as needs_input: $reason"
  fi
  exit 0
fi

tmp="$(mktemp "$(dirname "$state")/.state.XXXXXX")"
jq --arg id "$id" --arg reason "$reason" --arg detail "$detail" --arg now "$now" --arg who "$who" '
  .candidates |= map(if .id == $id then
    .status = "needs_input" |
    .phase = "needs_input" |
    .retry_reason = $reason |
    .retry_at = null |
    .parked_at = $now |
    .parked_by = $who |
    .evidence = ((.evidence // []) + [$detail])
  else . end)
' "$state" >"$tmp"
chmod 0600 "$tmp"
mv "$tmp" "$state"

if [ "$json" -eq 1 ]; then
  jq -n --arg id "$id" --arg sha "$sha" --arg reason "$reason" --arg now "$now" --arg who "$who" '
    {schema:"pog/promotion-park/v1", dry_run:false, id:$id, sha:$sha, status:"needs_input", reason:$reason, parked_at:$now, parked_by:$who}
  '
else
  echo "promotion park: candidate $id (sha=$sha) parked as needs_input: $reason"
fi
