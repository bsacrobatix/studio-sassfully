#!/usr/bin/env bash
# Process one receipt-admitted POG candidate from Kitsoki's durable queue.
#
# This is deliberately not `kitsoki queue process`: that command's current
# production adapter owns staging/local, while POG's protected target is main.
# The worker therefore consumes the same receipt-bound queue state but delegates
# the actual prospective-tree validation and protected-main CAS to land-branch.
# Agents submit and exit; a long-lived worker invokes this script repeatedly.
set -euo pipefail

usage() {
  echo 'usage: scripts/process-promotion-queue.sh [--gate "<command>"] [--once] [--watch] [--poll-seconds N] [--retry-delay-seconds N] [--max-retry-delay-seconds N] [--max-attempts N]' >&2
}

gate="scripts/checks.sh"
once=0
watch=0
poll_seconds="${POG_PROMOTION_QUEUE_POLL_SECONDS:-15}"
retry_delay_seconds="${POG_PROMOTION_QUEUE_RETRY_DELAY_SECONDS:-300}"
max_retry_delay_seconds="${POG_PROMOTION_QUEUE_MAX_RETRY_DELAY_SECONDS:-1800}"
max_attempts="${POG_PROMOTION_MAX_ATTEMPTS:-5}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --gate) gate="${2:?--gate requires a value}"; shift 2 ;;
    --once) once=1; shift ;;
    --watch) watch=1; shift ;;
    --poll-seconds) poll_seconds="${2:?--poll-seconds requires a value}"; shift 2 ;;
    --retry-delay-seconds) retry_delay_seconds="${2:?--retry-delay-seconds requires a value}"; shift 2 ;;
    --max-retry-delay-seconds) max_retry_delay_seconds="${2:?--max-retry-delay-seconds requires a value}"; shift 2 ;;
    --max-attempts) max_attempts="${2:?--max-attempts requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

case "$poll_seconds" in
  ''|*[!0-9]*) echo 'error: --poll-seconds must be a positive integer' >&2; exit 2 ;;
esac
[ "$poll_seconds" -gt 0 ] || { echo 'error: --poll-seconds must be a positive integer' >&2; exit 2; }
[ "$retry_delay_seconds" -ge 0 ] 2>/dev/null || { echo 'error: --retry-delay-seconds must be a non-negative integer' >&2; exit 2; }
[ "$max_retry_delay_seconds" -ge "$retry_delay_seconds" ] 2>/dev/null || { echo 'error: --max-retry-delay-seconds must be a non-negative integer at least as large as --retry-delay-seconds' >&2; exit 2; }
[ "$max_attempts" -gt 0 ] 2>/dev/null || { echo 'error: --max-attempts must be a positive integer' >&2; exit 2; }
[ "$once" -eq 0 ] || [ "$watch" -eq 0 ] || { echo 'error: --once and --watch cannot be combined' >&2; exit 2; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir/.." rev-parse --show-toplevel)"
state="$root/.capsules/queue/state.json"
ledger="$root/.capsules/queue/retry-ledger.json"
emergency_lane="$root/.capsules/queue/pog-emergency.json"
worker_lock="$root/.capsules/queue/pog-worker.lock"
status_dir="$root/.artifacts/promotion-queue"
mkdir -p "$(dirname "$worker_lock")" "$status_dir"

lock_owner_pid() {
  sed -n '1p' "$worker_lock/pid" 2>/dev/null || true
}

lock_age_seconds() {
  local modified now
  modified="$(stat -f %m "$worker_lock" 2>/dev/null || stat -c %Y "$worker_lock" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  case "$modified" in ''|*[!0-9]*) echo 0 ;; *) echo $((now - modified)) ;; esac
}

recover_stale_worker_lock() {
  local owner age
  [ -d "$worker_lock" ] || return 0
  owner="$(lock_owner_pid)"
  if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
    return 1
  fi
  # A just-created mkdir lock may not have written its pid yet.  Give it a
  # short grace period so a second worker cannot steal a live startup.
  age="$(lock_age_seconds)"
  if [ -z "$owner" ] && [ "$age" -lt 10 ]; then
    return 1
  fi
  echo "promotion queue worker: recovering stale lock (owner=${owner:-unknown}, age=${age}s): $worker_lock" >&2
  rm -rf "$worker_lock"
}

if ! recover_stale_worker_lock || ! mkdir "$worker_lock" 2>/dev/null; then
  echo "promotion queue worker is already active: $worker_lock (owner=$(lock_owner_pid || true))" >&2
  exit 0
fi
printf '%s\n' "$$" >"$worker_lock/pid"
release_worker_lock() {
  [ "$(lock_owner_pid)" = "$$" ] && rm -rf "$worker_lock"
}
trap release_worker_lock EXIT

write_status() {
  local phase candidate_sha candidate_id detail now tmp
  phase="$1"; candidate_sha="${2:-}"; candidate_id="${3:-}"; detail="${4:-}"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$(mktemp "$status_dir/.worker-status.XXXXXX")"
  jq -n --arg phase "$phase" --arg sha "$candidate_sha" --arg id "$candidate_id" --arg detail "$detail" --arg updated "$now" --arg pid "$$" \
    '{schema:"pog/promotion-queue-worker/v1",phase:$phase,candidate_sha:$sha,candidate_id:$id,detail:$detail,updated_at:$updated,owner_pid:$pid}' >"$tmp"
  chmod 0600 "$tmp"
  mv "$tmp" "$status_dir/worker-status.json"
}

update_candidate() {
  local id status sha reason evidence retry_at attempts now tmp
  id="$1"; status="$2"; sha="$3"; reason="$4"; evidence="$5"; retry_at="${6:-}"; attempts="${7:-}"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Use the queue's own serializer filename for this tiny state transition.
  # Do not hold it while the full candidate gate is running: submissions stay
  # cheap and the immutable candidate remains safely queued.
  local lock="$root/.capsules/queue/state.lock" deadline=$(( $(date +%s) + 60 ))
  while ! (set -C; : >"$lock") 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "error: timed out recording queue result" >&2; return 1; }
    sleep 1
  done
  tmp="$(mktemp "$(dirname "$state")/.state.XXXXXX")"
  jq --arg id "$id" --arg status "$status" --arg sha "$sha" --arg reason "$reason" --arg evidence "$evidence" --arg retry_at "$retry_at" --arg now "$now" --arg attempts "$attempts" '
    # A candidate that fails goes to the BACK of the line: it is re-queued past
    # every candidate currently known, rather than keeping the front slot it
    # arrived in. `.position` is the queue-ordering field; `.sequence` stays put
    # as the immutable submission identity, so audit/evidence still refer to the
    # candidate by the number it was admitted under.
    (([.candidates[].position // 0] | max) // 0) as $tail |
    .candidates |= map(if .id == $id then
      .status = $status |
      .phase = $status |
      .position = (if $status == "retry_wait" then ($tail + 1) else .position end) |
      .completed_at = (if $status == "landed" then $now else null end) |
      .validated_sha = (if $status == "landed" then $sha else .validated_sha end) |
      .retry_reason = (if $status == "retry_wait" or $status == "needs_input" then $reason else "" end) |
      .retry_at = (if $status == "retry_wait" then $retry_at else null end) |
      .attempts = (if ($attempts | length) > 0 then ($attempts | tonumber) else (.attempts // 0) end) |
      .evidence = ((.evidence // []) + [$evidence])
    else . end)' "$state" >"$tmp"
  chmod 0600 "$tmp"
  mv "$tmp" "$state"
  rm -f "$lock"
}

# state.json's own .attempts field is a POG-only overlay: the upstream
# capsule-merge-queue/v1 schema written by `kitsoki queue submit` doesn't
# carry it, so a candidate admission racing a worker retry can silently drop
# it back to 0 (report 01KXQEKXS9TA23432XSTXQ8JZG: observed 1/5 -> 2/5 ->
# 1/5, --max-attempts never tripped). retry-ledger.json is a POG-only sidecar
# that nothing else writes, so it stays the durable source of truth for the
# attempt count; state.json's .attempts is kept in sync from it purely for
# display.
ledger_bump() {
  local id="$1" reason="$2" now tmp
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local lock="$root/.capsules/queue/state.lock" deadline=$(( $(date +%s) + 60 ))
  while ! (set -C; : >"$lock") 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "error: timed out recording retry ledger" >&2; return 1; }
    sleep 1
  done
  [ -f "$ledger" ] || printf '%s\n' '{"schema":"pog/promotion-retry-ledger/v1","candidates":{}}' >"$ledger"
  tmp="$(mktemp "$(dirname "$ledger")/.retry-ledger.XXXXXX")"
  jq --arg id "$id" --arg reason "$reason" --arg now "$now" '
    .candidates[$id][$reason].attempts = ((.candidates[$id][$reason].attempts // 0) + 1) |
    .candidates[$id][$reason].first_attempt_at = (.candidates[$id][$reason].first_attempt_at // $now) |
    .candidates[$id][$reason].last_attempt_at = $now
  ' "$ledger" >"$tmp"
  chmod 0600 "$tmp"
  mv "$tmp" "$ledger"
  rm -f "$lock"
  jq -r --arg id "$id" --arg reason "$reason" '.candidates[$id][$reason].attempts' "$ledger"
}

retry_at_after_delay() {
  local seconds="$1"
  date -u -v+"${seconds}"S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+${seconds} seconds" +%Y-%m-%dT%H:%M:%SZ
}

# Exponential backoff off the ledger's durable attempt count, capped so a
# long-lived head never waits longer than max_retry_delay_seconds between
# attempts.
backoff_delay_seconds() {
  local attempt="$1" delay
  delay=$(( retry_delay_seconds * (1 << (attempt - 1)) ))
  if [ "$delay" -gt "$max_retry_delay_seconds" ] || [ "$delay" -lt 0 ]; then
    delay="$max_retry_delay_seconds"
  fi
  printf '%s\n' "$delay"
}

# Record a failed attempt for the loop's current candidate. Below the bounded
# attempt cap the candidate goes to the BACK of the line with a durable retry
# deadline, so ready work behind it lands while it waits out its backoff; at
# the cap it is parked as needs_input — loudly, with retained evidence —
# so one persistently red candidate cannot wedge every later landing forever.
# next_attempts comes from retry-ledger.json, not state.json, so it survives
# an external rewrite of state.json between worker runs.
record_failure() {
  local reason="$1" detail="$2" next_attempts retry_at delay
  next_attempts="$(ledger_bump "$id" "$reason")"
  if [ "$next_attempts" -ge "$max_attempts" ]; then
    detail="$detail; parked as needs_input after $next_attempts/$max_attempts attempts — later candidates continue; repair and resubmit"
    update_candidate "$id" needs_input '' "$reason" "$detail" '' "$next_attempts"
    write_status needs_input "$sha" "$id" "$detail"
  else
    delay="$(backoff_delay_seconds "$next_attempts")"
    retry_at="$(retry_at_after_delay "$delay")"
    detail="$detail; retry $next_attempts/$max_attempts scheduled at $retry_at"
    update_candidate "$id" retry_wait '' "$reason" "$detail" "$retry_at" "$next_attempts"
    write_status retry_wait "$sha" "$id" "$detail"
  fi
}

candidate_ref() {
  local branch="$1" sha="$2" ref
  if git -C "$root" rev-parse --verify --quiet "$branch^{commit}" >/dev/null 2>&1 && \
     [ "$(git -C "$root" rev-parse "$branch^{commit}")" = "$sha" ]; then
    printf '%s\n' "$branch"
    return 0
  fi
  # A legacy admission may retain the reconciled immutable integration ref
  # rather than its original Capsule publication ref. Both are exact objects;
  # accept either instead of stranding a receipt-bound candidate whose working
  # branch was later cleaned up.
  ref="$(git -C "$root" for-each-ref --format='%(refname)' --points-at "$sha" refs/heads/promotion/ | LC_ALL=C sort | head -n 1)"
  [ -n "$ref" ] || return 1
  printf '%s\n' "$ref"
}

[ -f "$state" ] || {
  write_status idle '' '' 'no receipt-admitted candidates'
  [ "$watch" -eq 1 ] && while :; do sleep "$poll_seconds"; [ -f "$state" ] && break; write_status idle '' '' 'no receipt-admitted candidates'; done
  [ -f "$state" ] || exit 0
}
while :; do
  # Emergency candidates always precede normal candidates, but the emergency
  # lane is itself append-only FIFO.  Nothing interrupts an in-flight gate:
  # this choice happens only before land-branch acquires its protected lock.
  if [ -f "$emergency_lane" ]; then
    jq -e '.schema == "pog/emergency-promotion-lane/v1" and (.entries | type == "array")' "$emergency_lane" >/dev/null || {
      write_status needs_input '' '' "invalid emergency promotion lane: $emergency_lane"
      exit 1
    }
    # An empty queue is a normal idle condition, not a jq -e failure. Keep
    # malformed JSON fatal while allowing the worker to recover a stale lock,
    # record idle, and exit 0 when no candidate remains.
    row="$(jq -cr --slurpfile emergency "$emergency_lane" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
      [.candidates[]
       | select((.status // .phase) == "queued" or (.status // .phase) == "reprepare" or (.status // .phase) == "retry_wait")
       # A candidate still inside its retry window is not runnable yet. Rank
       # ready work ahead of it so it cannot block the queue, but keep it in the
       # list: when nothing else is ready it is still selected, and the retry
       # backstop below reports its deadline rather than calling the queue idle.
       | {id,branch,sha,position,phase:(.status // .phase),retry_at:(.retry_at // null),
          ready:(((.status // .phase) != "retry_wait") or ((.retry_at // "") == "") or ((.retry_at) <= $now))}]
      as $pending |
      ($emergency[0].entries // [])
      | sort_by(.sequence)
      | map(. as $entry | $pending[] | select(.id == $entry.id and .sha == $entry.sha) | . + {lane:"emergency", skip_tests:($entry.skip_tests // false)})
      | .[0] // ($pending | sort_by([(if .ready then 0 else 1 end), .position]) | .[0] | if . == null then empty else . + {lane:"normal"} end)
    ' "$state")"
  else
    row="$(jq -cr --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '[.candidates[]
      | select((.status // .phase) == "queued" or (.status // .phase) == "reprepare" or (.status // .phase) == "retry_wait")
      | {id,branch,sha,position,phase:(.status // .phase),retry_at:(.retry_at // null),lane:"normal",
         ready:(((.status // .phase) != "retry_wait") or ((.retry_at // "") == "") or ((.retry_at) <= $now))}]
      | sort_by([(if .ready then 0 else 1 end), .position]) | .[0] // empty' "$state")"
  fi
  if [ -z "$row" ]; then
    write_status idle '' '' 'queue drained'
    [ "$watch" -eq 1 ] || exit 0
    sleep "$poll_seconds"
    continue
  fi
  id="$(jq -r '.id' <<<"$row")"
  branch="$(jq -r '.branch' <<<"$row")"
  sha="$(jq -r '.sha' <<<"$row")"
  lane="$(jq -r '.lane // "normal"' <<<"$row")"
  skip_tests="$(jq -r '.skip_tests // false' <<<"$row")"
  phase="$(jq -r '.phase // .status' <<<"$row")"
  retry_at="$(jq -r '.retry_at // empty' <<<"$row")"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Backstop only: selection already skips a candidate inside its retry window,
  # so reaching here means it is the only work left. Sleeping is then correct —
  # there is nothing behind it to bypass — and the bounded deadline still keeps
  # a watcher from burning the full gate in a tight loop.
  if [ "$phase" = "retry_wait" ] && [ -n "$retry_at" ] && [[ "$retry_at" > "$now" ]]; then
    write_status retry_wait "$sha" "$id" "retry scheduled at $retry_at; no other candidate is ready"
    [ "$watch" -eq 1 ] || exit 0
    sleep "$poll_seconds"
    continue
  fi
  ref="$(candidate_ref "$branch" "$sha" || true)"
  if [ -z "$ref" ]; then
    record_failure candidate_ref_unavailable "immutable candidate ref for $sha is unavailable"
    [ "$watch" -eq 1 ] || exit 1
    continue
  fi
  # merge-to-main refuses to touch a dirty protected checkout (correctly), so
  # un-managed WIP left directly in the source tree would otherwise burn this
  # candidate's bounded retries doing nothing until a human intervenes.
  # Ruling 2026-07-17: preserve that WIP as its own immutable candidate
  # branch, hand it off to a managed Capsule for normal receipt-bound
  # promotion (asynchronously — Capsule CI must not block this landing),
  # re-lock the checkout — then continue with the queued candidate.
  # See docs/protected-main-wip-preservation.md; recover moved files with
  # scripts/preserved-wip-status.sh.
  if [ -n "$(git -C "$root" status --porcelain --untracked-files=all)" ]; then
    preserve_log="$status_dir/preserve-wip.log"
    set +e
    preserved_branch="$( (cd "$root" && scripts/preserve-protected-wip.sh --quiet) 2>>"$preserve_log")"
    preserve_status=$?
    set -e
    if [ "$preserve_status" -ne 0 ]; then
      record_failure protected_checkout_dirty "protected checkout is dirty and automatic WIP preservation failed; see $preserve_log"
      [ "$watch" -eq 1 ] || exit 1
      continue
    fi
    if [ -n "$preserved_branch" ]; then
      handoff="${POG_PRESERVE_WIP_HANDOFF_COMMAND:-scripts/preserved-wip-to-capsule.sh}"
      write_status preserving_wip "$sha" "$id" "protected-checkout WIP preserved to $preserved_branch; capsule handoff started"
      echo "preserved WIP branch $preserved_branch; starting capsule handoff: $handoff $preserved_branch" >>"$preserve_log"
      (cd "$root" && nohup sh -c "$handoff $preserved_branch" >>"$preserve_log" 2>&1 &)
    fi
  fi
  effective_gate="$gate"
  [ "$skip_tests" != "true" ] || effective_gate=':'
  write_status validating "$sha" "$id" "lane=$lane candidate=$ref gate=$effective_gate skip_tests=$skip_tests"
  log="$status_dir/${id}.log"
  if (cd "$root" && scripts/land-branch.sh "$ref" --gate "$effective_gate") >"$log" 2>&1; then
    landed="$(git -C "$root" rev-parse refs/heads/main)"
    evidence="pog:landed=$landed log=$log"
    [ "$skip_tests" != "true" ] || evidence="$evidence test_gates=waived"
    update_candidate "$id" landed "$landed" '' "$evidence"
    write_status landed "$sha" "$id" "main=$landed log=$log skip_tests=$skip_tests"
  else
    record_failure promotion_failed "POG prospective-tree gate or conflict integration failed; retained log=$log"
    [ "$watch" -eq 1 ] || exit 1
    continue
  fi
  [ "$once" -eq 0 ] || exit 0
done
