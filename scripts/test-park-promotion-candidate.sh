#!/usr/bin/env bash
# Regression coverage for scripts/park-promotion-candidate.sh: the missing
# park/supersede primitive from report 01KXNX5Y445. Uses only a throwaway
# repository and never touches the caller's refs.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

new_source_repo() {
  local name="$1"
  local repo="$tmp/$name"
  mkdir -p "$repo/.capsules/queue"
  git init -q -b main "$repo"
  git -C "$repo" config user.name "POG park test"
  git -C "$repo" config user.email "park-test@example.invalid"
  printf 'base\n' >"$repo/base.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -qm base
  printf '%s\n' "$repo"
}

# --- park by sha: a queued candidate becomes needs_input with a durable
# reason, actor, and timestamp; earlier evidence is preserved, not replaced.
source_repo="$(new_source_repo park-by-sha)"
sha="$(git -C "$source_repo" rev-parse HEAD)"
printf '%s\n' "{\"candidates\":[{\"id\":\"cand-1\",\"branch\":\"agent/x\",\"sha\":\"$sha\",\"position\":1,\"status\":\"queued\",\"phase\":\"queued\",\"evidence\":[\"prior-evidence\"]}]}" >"$source_repo/.capsules/queue/state.json"

result="$("$script_dir/park-promotion-candidate.sh" --source-root "$source_repo" --reason "ancestor of main; no-op landing" --json "$sha")"
jq -e --arg sha "$sha" '
  .schema == "pog/promotion-park/v1"
  and .status == "needs_input"
  and .sha == $sha
  and .reason == "ancestor of main; no-op landing"
  and (.parked_at | length > 0)
  and (.parked_by | length > 0)
' <<<"$result" >/dev/null || fail "park by sha did not return a durable park record"

jq -e --arg sha "$sha" '
  .candidates[0].status == "needs_input"
  and .candidates[0].phase == "needs_input"
  and .candidates[0].retry_reason == "ancestor of main; no-op landing"
  and .candidates[0].retry_at == null
  and (.candidates[0].parked_at | length > 0)
  and (.candidates[0].evidence | length == 2 and .[0] == "prior-evidence")
' "$source_repo/.capsules/queue/state.json" >/dev/null || fail "park by sha did not durably transition the candidate or preserve prior evidence"

# --- park refuses a landed candidate: never rewrite terminal history.
source_repo="$(new_source_repo park-refuses-landed)"
sha="$(git -C "$source_repo" rev-parse HEAD)"
printf '%s\n' "{\"candidates\":[{\"id\":\"cand-landed\",\"branch\":\"agent/x\",\"sha\":\"$sha\",\"position\":1,\"status\":\"landed\",\"phase\":\"landed\",\"validated_sha\":\"$sha\"}]}" >"$source_repo/.capsules/queue/state.json"
set +e
"$script_dir/park-promotion-candidate.sh" --source-root "$source_repo" --reason "should be refused" "cand-landed" >"$tmp/park-landed.log" 2>&1
status=$?
set -e
[ "$status" -ne 0 ] || fail "parking a landed candidate unexpectedly succeeded"
grep -qi 'already landed' "$tmp/park-landed.log" || fail "landed refusal was not actionable"
jq -e '.candidates[0].status == "landed" and .candidates[0].phase == "landed"' "$source_repo/.capsules/queue/state.json" >/dev/null || fail "landed candidate state was rewritten despite refusal"

# --- park refuses while a live worker holds the exclusive lock, unless
# --force is passed; a stale (dead-pid) lock does not block parking.
source_repo="$(new_source_repo park-refuses-live-worker)"
sha="$(git -C "$source_repo" rev-parse HEAD)"
printf '%s\n' "{\"candidates\":[{\"id\":\"cand-locked\",\"branch\":\"agent/x\",\"sha\":\"$sha\",\"position\":1,\"status\":\"queued\",\"phase\":\"queued\"}]}" >"$source_repo/.capsules/queue/state.json"
mkdir -p "$source_repo/.capsules/queue/pog-worker.lock"
printf '%s\n' "$$" >"$source_repo/.capsules/queue/pog-worker.lock/pid"

set +e
"$script_dir/park-promotion-candidate.sh" --source-root "$source_repo" --reason "should be refused" "cand-locked" >"$tmp/park-locked.log" 2>&1
status=$?
set -e
[ "$status" -ne 0 ] || fail "parking while a live worker holds the lock unexpectedly succeeded"
grep -qi 'worker is active' "$tmp/park-locked.log" || fail "live-worker refusal was not actionable"
jq -e '.candidates[0].status == "queued"' "$source_repo/.capsules/queue/state.json" >/dev/null || fail "candidate state changed despite an active worker lock"

"$script_dir/park-promotion-candidate.sh" --source-root "$source_repo" --reason "operator override" --force "cand-locked" >"$tmp/park-forced.log" 2>&1
grep -qi 'proceeding because --force was passed' "$tmp/park-forced.log" || fail "--force override was not reported"
jq -e '.candidates[0].status == "needs_input"' "$source_repo/.capsules/queue/state.json" >/dev/null || fail "--force did not allow parking past a live worker lock"
rm -rf "$source_repo/.capsules/queue/pog-worker.lock"

# A stale lock (recorded owner no longer alive) must not require --force.
source_repo="$(new_source_repo park-stale-lock)"
sha="$(git -C "$source_repo" rev-parse HEAD)"
printf '%s\n' "{\"candidates\":[{\"id\":\"cand-stale\",\"branch\":\"agent/x\",\"sha\":\"$sha\",\"position\":1,\"status\":\"queued\",\"phase\":\"queued\"}]}" >"$source_repo/.capsules/queue/state.json"
mkdir -p "$source_repo/.capsules/queue/pog-worker.lock"
printf '999999\n' >"$source_repo/.capsules/queue/pog-worker.lock/pid"
"$script_dir/park-promotion-candidate.sh" --source-root "$source_repo" --reason "stale lock should not block" "cand-stale" >"$tmp/park-stale.log"
jq -e '.candidates[0].status == "needs_input"' "$source_repo/.capsules/queue/state.json" >/dev/null || fail "a stale (dead-pid) worker lock incorrectly blocked parking"
rm -rf "$source_repo/.capsules/queue/pog-worker.lock"

# --- --dry-run reports the intended park without mutating durable state.
source_repo="$(new_source_repo park-dry-run)"
sha="$(git -C "$source_repo" rev-parse HEAD)"
printf '%s\n' "{\"candidates\":[{\"id\":\"cand-dry\",\"branch\":\"agent/x\",\"sha\":\"$sha\",\"position\":1,\"status\":\"queued\",\"phase\":\"queued\"}]}" >"$source_repo/.capsules/queue/state.json"
before="$(cat "$source_repo/.capsules/queue/state.json")"
result="$("$script_dir/park-promotion-candidate.sh" --source-root "$source_repo" --reason "dry run only" --json --dry-run "cand-dry")"
jq -e '.dry_run == true and .status == "needs_input"' <<<"$result" >/dev/null || fail "dry-run did not report the intended park"
after="$(cat "$source_repo/.capsules/queue/state.json")"
[ "$before" = "$after" ] || fail "dry-run mutated durable queue state"

echo "PASS: park-promotion-candidate parks by sha, refuses landed and live-worker-locked candidates, honors --force and --dry-run"
