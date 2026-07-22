#!/usr/bin/env bash
# End-to-end regression gate for standalone Capsule -> protected source main.
# Uses throwaway local repositories and an injected deterministic resolver;
# never launches a provider or touches the caller's refs.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

new_fixture() {
  local name="$1"
  source_repo="$tmp/$name/source"
  capsule="$source_repo/.capsules/workspaces/$name"
  mkdir -p "$source_repo/scripts"
  git init -q -b main "$source_repo"
  git -C "$source_repo" config user.name "POG promotion test"
  git -C "$source_repo" config user.email "promotion-test@example.invalid"
  cp "$script_dir/merge-to-main.sh" "$source_repo/scripts/merge-to-main.sh"
  cp "$script_dir/land-branch.sh" "$source_repo/scripts/land-branch.sh"
  cp "$script_dir/promote-to-main.sh" "$source_repo/scripts/promote-to-main.sh"
  cp "$script_dir/process-promotion-queue.sh" "$source_repo/scripts/process-promotion-queue.sh"
  cp "$script_dir/mark-promotion-emergency.sh" "$source_repo/scripts/mark-promotion-emergency.sh"
  chmod +x "$source_repo/scripts/"*.sh
  printf '.artifacts/\n.capsules/\n.worktrees/\n.kitsoki-dev-workspace.json\n' >"$source_repo/.gitignore"
  printf 'base\n' >"$source_repo/shared.txt"
  git -C "$source_repo" add -A
  git -C "$source_repo" commit -qm "base"
  base_sha="$(git -C "$source_repo" rev-parse HEAD)"

  mkdir -p "$(dirname "$capsule")"
  git clone -q --no-local "$source_repo" "$capsule"
  git -C "$capsule" remote rename origin source
  git -C "$capsule" config user.name "POG promotion test"
  git -C "$capsule" config user.email "promotion-test@example.invalid"
  git -C "$capsule" switch -q -c "agent/$name" source/main
  cat >"$capsule/.kitsoki-dev-workspace.json" <<EOF
{
  "base": "main",
  "branch": "agent/$name",
  "id": "$name",
  "source": "$source_repo",
  "target": "main",
  "workspace": "$capsule"
}
EOF
}

# Source-side landing is explicitly non-recursive. A stale or malformed
# Capsule marker must fail closed instead of respawning the promoter until the
# host runs out of process slots.
new_fixture recursion-guard
printf 'candidate\n' >"$capsule/candidate.txt"
git -C "$capsule" add candidate.txt
git -C "$capsule" commit -qm "candidate"
set +e
(cd "$capsule" && POG_PROMOTION_LEGACY_DIRECT=1 POG_PROMOTION_HANDOFF_DEPTH=2 scripts/promote-to-main.sh --gate 'test -f candidate.txt') >"$tmp/recursion-guard.log" 2>&1
recursion_status=$?
set -e
[ "$recursion_status" -ne 0 ] || fail "recursive Capsule promotion handoff was not blocked"
grep -q 'recursive Capsule promotion handoff blocked' "$tmp/recursion-guard.log" || fail "recursive handoff failure was not actionable"

# Fast-forward promotion must advance only the source checkout's main.
new_fixture fast-forward
printf 'candidate\n' >"$capsule/candidate.txt"
git -C "$capsule" add candidate.txt
git -C "$capsule" commit -qm "candidate"
candidate_sha="$(git -C "$capsule" rev-parse HEAD)"
# Simulate another source-checkout owner finishing a small local edit while
# promotion waits. The promoter must neither fail nor stash/reset those bytes.
printf 'busy\n' >"$source_repo/busy.tmp"
(sleep 1; rm -f "$source_repo/busy.tmp") &
busy_owner=$!
(cd "$capsule" && POG_PROMOTION_LEGACY_DIRECT=1 scripts/promote-to-main.sh --gate 'test -f candidate.txt') >/dev/null
wait "$busy_owner"
[ "$(git -C "$source_repo" rev-parse main)" = "$candidate_sha" ] || fail "fast-forward did not move source main to the candidate"
[ "$(git -C "$capsule" rev-parse main)" = "$base_sha" ] || fail "fast-forward moved Capsule-local main"
[ "$(git -C "$capsule" rev-parse source/main)" = "$candidate_sha" ] || fail "Capsule source/main tracking ref was not refreshed"
git -C "$source_repo" rev-parse --verify "refs/heads/promotion/capsule-fast-forward/$candidate_sha" >/dev/null || fail "immutable candidate ref was not retained"

# Legacy helpers invoked from a Capsule must also route to the real source and
# leave clone-local main untouched.
(cd "$capsule" && POG_PROMOTION_LEGACY_DIRECT=1 scripts/merge-to-main.sh main --gate 'test -f candidate.txt') >/dev/null
[ "$(git -C "$capsule" rev-parse main)" = "$base_sha" ] || fail "legacy merge helper advanced Capsule-local main"

# A conflict that outlives one resolver attempt must remain resumable. The
# second invocation resolves it and lands a merge commit containing both
# histories, without deleting the immutable candidate or failed-attempt state.
new_fixture conflict-retry
printf 'main change\n' >"$source_repo/shared.txt"
git -C "$source_repo" add shared.txt
git -C "$source_repo" commit -qm "main change"
main_sha="$(git -C "$source_repo" rev-parse HEAD)"
printf 'candidate change\n' >"$capsule/shared.txt"
git -C "$capsule" add shared.txt
git -C "$capsule" commit -qm "candidate change"
candidate_sha="$(git -C "$capsule" rev-parse HEAD)"

set +e
(cd "$capsule" && POG_PROMOTION_LEGACY_DIRECT=1 POG_PROMOTION_RESOLVER_ATTEMPTS=1 \
  scripts/promote-to-main.sh --gate 'test "$(cat shared.txt)" = resolved' --resolver-command 'exit 9') >/dev/null 2>&1
first_status=$?
set -e
[ "$first_status" -ne 0 ] || fail "failed resolver attempt unexpectedly succeeded"
[ "$(git -C "$source_repo" rev-parse main)" = "$main_sha" ] || fail "failed resolver attempt moved source main"
[ "$(git -C "$capsule" rev-parse main)" = "$base_sha" ] || fail "failed resolver attempt moved Capsule-local main"

promotion_worktree="$(find "$source_repo/.capsules/workspaces" -maxdepth 1 -type d -name 'promotion-*' -print -quit)"
[ -n "$promotion_worktree" ] || fail "failed conflict attempt did not retain its integration worktree"
[ -f "$(git -C "$promotion_worktree" rev-parse --git-path MERGE_HEAD)" ] || fail "failed conflict attempt did not retain resumable merge state"
git -C "$source_repo" rev-parse --verify "refs/heads/promotion/capsule-conflict-retry/$candidate_sha" >/dev/null || fail "failed conflict attempt lost the candidate ref"

(cd "$capsule" && POG_PROMOTION_LEGACY_DIRECT=1 scripts/promote-to-main.sh \
  --gate 'test "$(cat shared.txt)" = resolved' \
  --resolver-command 'printf "%s\n" resolved > "$POG_LAND_WORKTREE/shared.txt"') >/dev/null

landed_sha="$(git -C "$source_repo" rev-parse main)"
[ "$(cat "$source_repo/shared.txt")" = "resolved" ] || fail "resolved tree did not reach source checkout"
git -C "$source_repo" merge-base --is-ancestor "$main_sha" "$landed_sha" || fail "landing lost current-main ancestry"
git -C "$source_repo" merge-base --is-ancestor "$candidate_sha" "$landed_sha" || fail "landing lost candidate ancestry"
[ "$(git -C "$source_repo" rev-list --parents -n1 "$landed_sha" | wc -w | tr -d ' ')" = "3" ] || fail "divergent promotion did not create a reversible merge commit"
[ "$(git -C "$capsule" rev-parse main)" = "$base_sha" ] || fail "conflict promotion moved Capsule-local main"
[ ! -e "$promotion_worktree" ] || fail "successful retry did not clean its integration worktree"

# Concurrent promotion requests serialize at the source repo and converge. The
# later candidate integrates against the newly landed main instead of failing a
# stale compare-and-swap or updating either Capsule's private main.
new_fixture concurrent-a
capsule_a="$capsule"
capsule_b="$source_repo/.capsules/workspaces/concurrent-b"
git clone -q --no-local "$source_repo" "$capsule_b"
git -C "$capsule_b" remote rename origin source
git -C "$capsule_b" config user.name "POG promotion test"
git -C "$capsule_b" config user.email "promotion-test@example.invalid"
git -C "$capsule_b" switch -q -c agent/concurrent-b source/main
cat >"$capsule_b/.kitsoki-dev-workspace.json" <<EOF
{
  "base": "main",
  "branch": "agent/concurrent-b",
  "id": "concurrent-b",
  "source": "$source_repo",
  "target": "main",
  "workspace": "$capsule_b"
}
EOF
printf 'a\n' >"$capsule_a/a.txt"
git -C "$capsule_a" add a.txt
git -C "$capsule_a" commit -qm "candidate a"
candidate_a="$(git -C "$capsule_a" rev-parse HEAD)"
printf 'b\n' >"$capsule_b/b.txt"
git -C "$capsule_b" add b.txt
git -C "$capsule_b" commit -qm "candidate b"
candidate_b="$(git -C "$capsule_b" rev-parse HEAD)"

(cd "$capsule_a" && POG_PROMOTION_LEGACY_DIRECT=1 scripts/promote-to-main.sh --gate 'git diff --check') >"$tmp/concurrent-a.log" 2>&1 &
pid_a=$!
(cd "$capsule_b" && POG_PROMOTION_LEGACY_DIRECT=1 scripts/promote-to-main.sh --gate 'git diff --check') >"$tmp/concurrent-b.log" 2>&1 &
pid_b=$!
set +e
wait "$pid_a"; status_a=$?
wait "$pid_b"; status_b=$?
set -e
if [ "$status_a" -ne 0 ] || [ "$status_b" -ne 0 ]; then
  cat "$tmp/concurrent-a.log" "$tmp/concurrent-b.log" >&2
  fail "concurrent promotions did not both converge"
fi
concurrent_main="$(git -C "$source_repo" rev-parse main)"
git -C "$source_repo" merge-base --is-ancestor "$candidate_a" "$concurrent_main" || fail "concurrent landing lost candidate a"
git -C "$source_repo" merge-base --is-ancestor "$candidate_b" "$concurrent_main" || fail "concurrent landing lost candidate b"
[ -f "$source_repo/a.txt" ] && [ -f "$source_repo/b.txt" ] || fail "concurrent landing tree is incomplete"
[ "$(git -C "$capsule_a" rev-parse main)" = "$base_sha" ] || fail "concurrent promotion moved Capsule A main"
[ "$(git -C "$capsule_b" rev-parse main)" = "$base_sha" ] || fail "concurrent promotion moved Capsule B main"

# Default promotion submits a Capsule-CI receipt to the durable queue and
# returns immediately. The worker, not the producing agent, later owns main.
new_fixture queue-submit
printf 'queued\n' >"$capsule/queued.txt"
git -C "$capsule" add queued.txt
git -C "$capsule" commit -qm "queued candidate"
candidate_sha="$(git -C "$capsule" rev-parse HEAD)"
mkdir -p "$source_repo/.capsules/queue"
printf '%s\n' '{"schema":"capsule-merge-queue/v1","candidates":[]}' >"$source_repo/.capsules/queue/state.json"
fake_bin="$tmp/fake-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/kitsoki" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$POG_TEST_KITSOKI_LOG"
if [ -n "${POG_TEST_QUEUE_STATE:-}" ]; then
  printf '%s\n' "{\"schema\":\"capsule-merge-queue/v1\",\"candidates\":[{\"id\":\"queue-test\",\"branch\":\"agent/queue-submit\",\"sha\":\"$POG_TEST_QUEUE_SHA\",\"receipt_id\":\"sha256:test\",\"position\":1,\"status\":\"queued\"}]}" >"$POG_TEST_QUEUE_STATE"
fi
printf '{"schema":"capsule-promote/v1","status":"queued","candidate_sha":"%s","receipt_id":"sha256:test","queue_candidate":{"id":"queue-test","status":"queued"}}\n' "$POG_TEST_QUEUE_SHA"
EOF
chmod +x "$fake_bin/kitsoki"
(cd "$capsule" && POG_TEST_KITSOKI_LOG="$tmp/queue-submit.log" POG_TEST_QUEUE_SHA="$candidate_sha" POG_TEST_QUEUE_STATE="$source_repo/.capsules/queue/state.json" PATH="$fake_bin:$PATH" \
  POG_PROMOTION_NO_AUTOSTART=1 scripts/promote-to-main.sh --emergency --skip-tests) >"$tmp/queue-submit.out" 2>"$tmp/queue-submit.err"
grep -q 'queue worker: scripts/process-promotion-queue.sh' "$tmp/queue-submit.out" || fail "autostart opt-out did not fall back to the manual worker hint"
[ "$(git -C "$source_repo" rev-parse main)" = "$base_sha" ] || fail "queue submission moved protected main"
git -C "$source_repo" rev-parse --verify "refs/heads/promotion/capsule-queue-submit/$candidate_sha" >/dev/null || fail "queue submission did not retain immutable candidate"
if grep -q 'fatal: Not a valid commit name' "$tmp/queue-submit.err"; then
  fail "first candidate publish emitted an invalid-object diagnostic"
fi
grep -q -- 'capsule promote --current --pipeline change --target main --gate : --json' "$tmp/queue-submit.log" || fail "test waiver did not reach Capsule queue admission"
jq -e '.entries | length == 1 and .[0].id == "queue-test" and .[0].sha != "" and .[0].skip_tests == true' "$source_repo/.capsules/queue/pog-emergency.json" >/dev/null || fail "emergency submit did not record the test waiver"

# The POG worker consumes the receipt-admitted FIFO state and records landed
# only after the protected land-branch path has completed its exact-tree gate.
(cd "$source_repo" && scripts/process-promotion-queue.sh --once --gate 'exit 55')
[ "$(git -C "$source_repo" rev-parse main)" = "$candidate_sha" ] || fail "queue worker did not land immutable candidate"
jq -e '.candidates[0].status == "landed" and .candidates[0].validated_sha != "" and (.candidates[0].evidence | join(" ") | contains("test_gates=waived"))' "$source_repo/.capsules/queue/state.json" >/dev/null || fail "queue worker did not record terminal waived landing state"

# A completed Capsule-CI run can outlive its front-door promoter. Retrying a
# candidate with its exact passing receipt must use queue admission directly,
# rather than re-running the story wrapper and risking another stalled run.
queue_submit_source_repo="$source_repo"
queue_submit_capsule="$capsule"
queue_submit_base_sha="$base_sha"
queue_submit_candidate_sha="$candidate_sha"
new_fixture queue-receipt-reuse
printf 'receipt reuse\n' >"$capsule/reuse.txt"
git -C "$capsule" add reuse.txt
git -C "$capsule" commit -qm "receipt reuse candidate"
candidate_sha="$(git -C "$capsule" rev-parse HEAD)"
mkdir -p "$source_repo/.capsules/ci"
cat >"$source_repo/.capsules/ci/reused.receipt.json" <<EOF
{
  "schema": "capsule-ci-receipt/v1",
  "receipt_id": "sha256:reuse",
  "envelope": {"source_digest": "$candidate_sha"},
  "verdict": {"outcome": "passed", "promotion_eligible": true}
}
EOF
fake_bin="$tmp/fake-reuse-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/kitsoki" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$POG_TEST_KITSOKI_LOG"
if [ "${1:-}" = "queue" ] && [ "${2:-}" = "submit" ]; then
  printf '{"id":"queue-reuse","status":"queued","sha":"%s","receipt_id":"sha256:reuse","position":1}\n' "$POG_TEST_QUEUE_SHA"
  exit 0
fi
echo 'capsule promote must not rerun when an exact passing receipt exists' >&2
exit 77
EOF
chmod +x "$fake_bin/kitsoki"
(cd "$capsule" && POG_TEST_KITSOKI_LOG="$tmp/receipt-reuse.log" POG_TEST_QUEUE_SHA="$candidate_sha" PATH="$fake_bin:$PATH" \
  scripts/promote-to-main.sh) >"$tmp/receipt-reuse.out"
[ "$(git -C "$source_repo" rev-parse main)" = "$base_sha" ] || fail "receipt reuse moved protected main"
git -C "$source_repo" rev-parse --verify "refs/heads/promotion/capsule-queue-receipt-reuse/$candidate_sha" >/dev/null || fail "receipt reuse did not retain immutable candidate"
grep -q -- 'queue submit --project' "$tmp/receipt-reuse.log" || fail "receipt reuse did not use direct queue admission"
if grep -q -- 'capsule promote' "$tmp/receipt-reuse.log"; then fail "receipt reuse reran Capsule promotion"; fi
awk 'BEGIN {seen=0} /^{$/ {seen=1} seen && /^promotion queued:/ {exit} seen {print}' "$tmp/receipt-reuse.out" | \
jq -e --arg sha "$candidate_sha" \
  '.schema == "capsule-promote/v1" and .status == "queued" and .candidate_sha == $sha and .queue_candidate.id == "queue-reuse"' \
  >/dev/null || fail "receipt reuse did not return a normalized queued result"
source_repo="$queue_submit_source_repo"
capsule="$queue_submit_capsule"
base_sha="$queue_submit_base_sha"
candidate_sha="$queue_submit_candidate_sha"

# A crashed worker must not strand the durable queue behind a dead mkdir lock;
# a live worker lock must remain exclusive and visibly leave state untouched.
# Older workers wrote a terminal `status` without updating `phase`. A terminal
# candidate with that stale phase must still be treated as drained, never
# revalidated or re-landed.
jq '.candidates[0].phase = "queued"' "$source_repo/.capsules/queue/state.json" >"$tmp/legacy-terminal-state.json"
mv "$tmp/legacy-terminal-state.json" "$source_repo/.capsules/queue/state.json"
mkdir -p "$source_repo/.capsules/queue/pog-worker.lock"
printf '999999\n' >"$source_repo/.capsules/queue/pog-worker.lock/pid"
(cd "$source_repo" && scripts/process-promotion-queue.sh --once --gate 'git diff --check') >"$tmp/stale-worker.log" 2>&1
grep -q 'recovering stale lock' "$tmp/stale-worker.log" || fail "worker did not report stale-lock recovery"
[ ! -e "$source_repo/.capsules/queue/pog-worker.lock" ] || fail "worker left its recovered lock behind"
mkdir -p "$source_repo/.capsules/queue/pog-worker.lock"
printf '%s\n' "$$" >"$source_repo/.capsules/queue/pog-worker.lock/pid"
(cd "$source_repo" && scripts/process-promotion-queue.sh --once --gate 'exit 99') >"$tmp/live-worker.log" 2>&1
grep -q 'already active' "$tmp/live-worker.log" || fail "worker did not identify the active owner lock"
[ "$(git -C "$source_repo" rev-parse main)" = "$candidate_sha" ] || fail "second worker changed protected main despite active lock"
rm -rf "$source_repo/.capsules/queue/pog-worker.lock"

# A failed candidate goes to the BACK of the line and keeps a durable retry
# deadline. Two properties follow, and they are deliberately in tension with the
# strict-FIFO rule this replaced (a failed head used to hold the queue until its
# deadline elapsed, which stalled every later candidate behind one red head):
#
#   1. ready work behind a waiting candidate PROCEEDS — it does not wait out a
#      deadline it has nothing to do with;
#   2. the waiting candidate is still not gated early, and when it is the only
#      work left the worker reports its deadline rather than calling the queue
#      idle or burning the gate.
#
# (1) ready work is not blocked by a candidate serving its backoff.
jq '.candidates = [
  {id:"retry-head",branch:"agent/queue-submit",sha:$sha,position:1,status:"retry_wait",phase:"retry_wait",retry_at:"2999-01-01T00:00:00Z"},
  {id:"later",branch:"agent/queue-submit",sha:$sha,position:2,status:"queued",phase:"queued"}
]' --arg sha "$candidate_sha" "$source_repo/.capsules/queue/state.json" >"$tmp/retry-state.json"
mv "$tmp/retry-state.json" "$source_repo/.capsules/queue/state.json"
(cd "$source_repo" && scripts/process-promotion-queue.sh --once --gate 'git diff --check') >"$tmp/leapfrog.log" 2>&1
jq -e '(.candidates[] | select(.id == "later") | .status) == "landed"' \
  "$source_repo/.capsules/queue/state.json" >/dev/null || fail "ready candidate did not proceed past one serving its retry backoff"
jq -e '(.candidates[] | select(.id == "retry-head") | .status) == "retry_wait"
       and (.candidates[] | select(.id == "retry-head") | .retry_at) == "2999-01-01T00:00:00Z"' \
  "$source_repo/.capsules/queue/state.json" >/dev/null || fail "the waiting candidate was gated early or lost its deadline"

# (2) alone in the queue, it still defers to its deadline instead of gating.
jq '.candidates = [
  {id:"retry-head",branch:"agent/queue-submit",sha:$sha,position:1,status:"retry_wait",phase:"retry_wait",retry_at:"2999-01-01T00:00:00Z"}
]' --arg sha "$candidate_sha" "$source_repo/.capsules/queue/state.json" >"$tmp/retry-state.json"
mv "$tmp/retry-state.json" "$source_repo/.capsules/queue/state.json"
(cd "$source_repo" && scripts/process-promotion-queue.sh --once --gate 'exit 99') >"$tmp/retry-wait.log" 2>&1
grep -q 'retry scheduled at 2999-01-01T00:00:00Z' "$source_repo/.artifacts/promotion-queue/worker-status.json" || fail "worker did not persist retry deadline status"
[ "$(git -C "$source_repo" rev-parse main)" = "$candidate_sha" ] || fail "deferred retry ran a gate before its deadline"

# A persistently red head is parked as needs_input at the bounded attempt cap
# instead of wedging every later candidate forever. The park is loud (failure
# exit, durable reason, retained attempts) and the next worker run proceeds
# straight to later queued work.
jq '.candidates = [
  {id:"red-head",branch:"agent/queue-submit",sha:$sha,position:1,status:"retry_wait",phase:"retry_wait",retry_at:"2000-01-01T00:00:00Z",attempts:4},
  {id:"green-later",branch:"agent/queue-submit",sha:$sha,position:2,status:"queued",phase:"queued"}
]' --arg sha "$candidate_sha" "$source_repo/.capsules/queue/state.json" >"$tmp/park-state.json"
mv "$tmp/park-state.json" "$source_repo/.capsules/queue/state.json"
# The bounded attempt cap is enforced from the durable retry-ledger.json, not
# state.json's own .attempts (report 01KXQEKXS9TA23432XSTXQ8JZG: state.json's
# .attempts is a POG-only overlay an external queue-submit rewrite can silently
# reset). Seed the ledger to match this fixture's hand-seeded attempts:4.
printf '%s\n' '{"schema":"pog/promotion-retry-ledger/v1","candidates":{"red-head":{"promotion_failed":{"attempts":4,"first_attempt_at":"2000-01-01T00:00:00Z","last_attempt_at":"2000-01-01T00:00:00Z"}}}}' >"$source_repo/.capsules/queue/retry-ledger.json"
set +e
(cd "$source_repo" && scripts/process-promotion-queue.sh --once --gate 'exit 99') >"$tmp/park.log" 2>&1
park_status=$?
set -e
[ "$park_status" -ne 0 ] || fail "parking a persistently red head did not report failure"
jq -e '.candidates[0].status == "needs_input" and .candidates[0].attempts == 5 and .candidates[0].retry_reason == "promotion_failed"' \
  "$source_repo/.capsules/queue/state.json" >/dev/null || fail "red head was not parked as needs_input at the attempt cap"
(cd "$source_repo" && scripts/process-promotion-queue.sh --once --gate 'git diff --check') >/dev/null 2>&1 || fail "parked head still blocked a later green candidate"
jq -e '.candidates[1].status == "landed"' "$source_repo/.capsules/queue/state.json" >/dev/null || fail "later candidate did not land after the head was parked"

# Emergency candidates precede normal work but retain their own immutable FIFO
# order. Re-marking the first candidate must never let a later emergency jump it.
new_fixture emergency-lane
normal_capsule="$capsule"
emergency_one="$tmp/emergency-one"
emergency_two="$tmp/emergency-two"
git clone -q --no-local "$source_repo" "$emergency_one"
git clone -q --no-local "$source_repo" "$emergency_two"
for clone in "$normal_capsule" "$emergency_one" "$emergency_two"; do
  git -C "$clone" config user.name "POG promotion test"
  git -C "$clone" config user.email "promotion-test@example.invalid"
done
printf 'normal\n' >"$normal_capsule/normal.txt"
git -C "$normal_capsule" add normal.txt && git -C "$normal_capsule" commit -qm "normal candidate"
git -C "$normal_capsule" push -q source HEAD:refs/heads/agent/emergency-normal
normal_sha="$(git -C "$normal_capsule" rev-parse HEAD)"
git -C "$emergency_one" switch -q -c agent/emergency-one origin/main
printf 'emergency one\n' >"$emergency_one/emergency-one.txt"
git -C "$emergency_one" add emergency-one.txt && git -C "$emergency_one" commit -qm "emergency one"
git -C "$emergency_one" push -q origin HEAD:refs/heads/agent/emergency-one
emergency_one_sha="$(git -C "$emergency_one" rev-parse HEAD)"
git -C "$emergency_two" switch -q -c agent/emergency-two origin/main
printf 'emergency two\n' >"$emergency_two/emergency-two.txt"
git -C "$emergency_two" add emergency-two.txt && git -C "$emergency_two" commit -qm "emergency two"
git -C "$emergency_two" push -q origin HEAD:refs/heads/agent/emergency-two
emergency_two_sha="$(git -C "$emergency_two" rev-parse HEAD)"
mkdir -p "$source_repo/.capsules/queue"
printf '%s\n' "{\"schema\":\"capsule-merge-queue/v1\",\"candidates\":[{\"id\":\"normal\",\"branch\":\"agent/emergency-normal\",\"sha\":\"$normal_sha\",\"position\":1,\"status\":\"queued\"},{\"id\":\"emergency-one\",\"branch\":\"agent/emergency-one\",\"sha\":\"$emergency_one_sha\",\"position\":2,\"status\":\"queued\"},{\"id\":\"emergency-two\",\"branch\":\"agent/emergency-two\",\"sha\":\"$emergency_two_sha\",\"position\":3,\"status\":\"queued\"}]}" >"$source_repo/.capsules/queue/state.json"
(cd "$source_repo" && scripts/mark-promotion-emergency.sh emergency-one)
(cd "$source_repo" && scripts/mark-promotion-emergency.sh emergency-two)
(cd "$source_repo" && scripts/mark-promotion-emergency.sh emergency-one) >"$tmp/emergency-idempotent.log"
grep -q 'already queued' "$tmp/emergency-idempotent.log" || fail "emergency marker did not preserve first emergency position"
(cd "$source_repo" && scripts/process-promotion-queue.sh --once --gate 'git diff --check')
first_emergency_main="$(git -C "$source_repo" rev-parse main)"
git -C "$source_repo" merge-base --is-ancestor "$emergency_one_sha" "$first_emergency_main" || fail "first emergency candidate was not selected before normal work"
if git -C "$source_repo" merge-base --is-ancestor "$emergency_two_sha" "$first_emergency_main"; then fail "later emergency candidate displaced earlier emergency"; fi
(cd "$source_repo" && scripts/process-promotion-queue.sh --once --gate 'git diff --check')
second_emergency_main="$(git -C "$source_repo" rev-parse main)"
git -C "$source_repo" merge-base --is-ancestor "$emergency_two_sha" "$second_emergency_main" || fail "second emergency candidate was not selected before normal work"
if git -C "$source_repo" merge-base --is-ancestor "$normal_sha" "$second_emergency_main"; then fail "normal candidate ran before all emergency work"; fi

# An exact SHA must not create a second queue entry or CI request when it is
# already receipt-admitted. The caller gets a durable status pointer instead.
new_fixture duplicate-admission
printf 'candidate\n' >"$capsule/candidate.txt"
git -C "$capsule" add candidate.txt && git -C "$capsule" commit -qm "candidate"
candidate_sha="$(git -C "$capsule" rev-parse HEAD)"
mkdir -p "$source_repo/.capsules/queue"
printf '%s\n' "{\"candidates\":[{\"id\":\"already-queued\",\"sha\":\"$candidate_sha\",\"position\":1,\"status\":\"queued\"}]}" >"$source_repo/.capsules/queue/state.json"
(cd "$capsule" && scripts/promote-to-main.sh) >"$tmp/duplicate-admission.log"
grep -q 'promotion already admitted: id=already-queued phase=queued' "$tmp/duplicate-admission.log" || fail "duplicate candidate did not report its durable queue entry"

# The same guard applies before receipt admission while an exact SHA's Capsule
# CI job is still running.
new_fixture duplicate-ci
printf 'candidate\n' >"$capsule/candidate.txt"
git -C "$capsule" add candidate.txt && git -C "$capsule" commit -qm "candidate"
candidate_sha="$(git -C "$capsule" rev-parse HEAD)"
mkdir -p "$source_repo/.capsules/ci"
printf '%s\n' "{\"job_id\":\"ci-running\",\"result\":{\"stage\":\"running\",\"job\":{\"Status\":\"running\"},\"envelope\":{\"source_digest\":\"$candidate_sha\"}}}" >"$source_repo/.capsules/ci/ci-running.run.json"
(cd "$capsule" && scripts/promote-to-main.sh) >"$tmp/duplicate-ci.log"
grep -q 'promotion already running: Capsule CI job=ci-running' "$tmp/duplicate-ci.log" || fail "running exact-candidate CI did not suppress a duplicate promotion"

# By default a successful fresh queue admission ensures a live watch worker,
# so a submitted candidate can never sit in "queued" because nobody started
# one. The fake kitsoki writes the queue state during admission (pre-writing
# it would trip the duplicate-admission guard above). Isolated as the final
# fixture: its watcher is killed after asserting, and even a leaked one dies
# with the fixture rather than racing earlier stages.
new_fixture autostart
printf 'auto\n' >"$capsule/auto.txt"
git -C "$capsule" add auto.txt
git -C "$capsule" commit -qm "auto candidate"
auto_sha="$(git -C "$capsule" rev-parse HEAD)"
mkdir -p "$source_repo/.capsules/queue"
# Use the queue-submit fixture's promote-capable fake kitsoki; $fake_bin was
# reassigned by the receipt-reuse fixture to a stub that rejects promotion.
autostart_bin="$tmp/fake-bin"
(cd "$capsule" && POG_TEST_KITSOKI_LOG="$tmp/autostart.log" POG_TEST_QUEUE_SHA="$auto_sha" \
  POG_TEST_QUEUE_STATE="$source_repo/.capsules/queue/state.json" PATH="$autostart_bin:$PATH" \
  POG_PROMOTION_QUEUE_POLL_SECONDS=1 scripts/promote-to-main.sh --emergency --skip-tests) >"$tmp/queue-autostart.out"
grep -q 'ensured a live watch worker' "$tmp/queue-autostart.out" || fail "queue admission did not ensure a live worker"
autostart_deadline=$(( $(date +%s) + 60 ))
until jq -e '.candidates[0].status == "landed"' "$source_repo/.capsules/queue/state.json" >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$autostart_deadline" ] || fail "autostarted worker never landed the queued candidate"
  sleep 1
done
[ "$(git -C "$source_repo" rev-parse main)" = "$auto_sha" ] || fail "autostarted worker landed the wrong tree"
autostart_worker_pid="$(sed -n '1p' "$source_repo/.capsules/queue/pog-worker.lock/pid" 2>/dev/null || true)"
[ -z "$autostart_worker_pid" ] || kill "$autostart_worker_pid" 2>/dev/null || true
rm -rf "$source_repo/.capsules/queue/pog-worker.lock"

echo "PASS: Capsule promotion queues receipt-bound candidates; worker preserves emergency FIFO, normal FIFO, and legacy convergence"
