#!/usr/bin/env bash
# promote-to-main.sh [<branch>] [--emergency] [--skip-tests] [--gate "<command>"] [--resolver-command "<command>"]
#
# One-command promotion. In a managed standalone Capsule, the authoritative
# source/branch/target identity comes from .kitsoki-dev-workspace.json; the
# candidate is first published under an immutable source-repo ref and then the
# real protected checkout performs integration and landing. The Capsule's own
# local main ref is never a landing target.
set -euo pipefail

usage() {
  echo 'usage: scripts/promote-to-main.sh [<branch>] [--emergency] [--skip-tests] [--gate "<command>"] [--resolver-command "<command>"]' >&2
}

requested_branch=""
gate=""
resolver_command="${POG_LAND_RESOLVER_COMMAND:-}"
emergency=0
skip_tests=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --gate)
      gate="${2:?--gate requires a value}"
      shift 2
      ;;
    --resolver-command)
      resolver_command="${2:?--resolver-command requires a value}"
      shift 2
      ;;
    --emergency)
      emergency=1
      shift
      ;;
    --skip-tests)
      skip_tests=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$requested_branch" ]; then
        echo "error: unexpected argument: $1" >&2
        usage
        exit 2
      fi
      requested_branch="$1"
      shift
      ;;
  esac
done

[ "$skip_tests" -eq 0 ] || [ "$emergency" -eq 1 ] || {
  echo 'error: --skip-tests requires --emergency so the waiver is explicit and ordered ahead of normal work' >&2
  exit 2
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(git -C "$script_dir/.." rev-parse --show-toplevel)"
metadata="$repo_root/.kitsoki-dev-workspace.json"
handoff_depth="${POG_PROMOTION_HANDOFF_DEPTH:-0}"
case "$handoff_depth" in
  *[!0-9]*|'') echo "error: POG_PROMOTION_HANDOFF_DEPTH must be a non-negative integer" >&2; exit 2 ;;
esac
if [ "$handoff_depth" -ge 2 ]; then
  echo "error: recursive Capsule promotion handoff blocked at $repo_root" >&2
  exit 1
fi

if [ ! -f "$metadata" ]; then
  [ -n "$requested_branch" ] || {
    echo "error: no Capsule metadata found; pass a branch when promoting from the protected checkout" >&2
    exit 2
  }
  args=("$requested_branch")
  [ "$emergency" -eq 0 ] || { echo "error: --emergency requires a receipt-admitted Capsule candidate" >&2; exit 2; }
  [ "$skip_tests" -eq 0 ] || { echo "error: --skip-tests requires a managed Capsule candidate" >&2; exit 2; }
  [ -z "$gate" ] || args+=(--gate "$gate")
  [ -z "$resolver_command" ] || args+=(--resolver-command "$resolver_command")
  exec "$script_dir/land-branch.sh" "${args[@]}"
fi

command -v jq >/dev/null 2>&1 || { echo "error: jq is required to validate Capsule metadata" >&2; exit 127; }

source_root="$(jq -r '.source // empty' "$metadata")"
workspace="$(jq -r '.workspace // empty' "$metadata")"
branch="$(jq -r '.branch // empty' "$metadata")"
target="$(jq -r '.target // empty' "$metadata")"
id="$(jq -r '.id // empty' "$metadata")"

[ -n "$source_root" ] && [ -n "$workspace" ] && [ -n "$branch" ] && [ -n "$id" ] || {
  echo "error: incomplete Capsule identity in $metadata" >&2
  exit 1
}
[ "$target" = "main" ] || { echo "error: Capsule target is '$target', not protected main" >&2; exit 1; }

source_root="$(cd "$source_root" 2>/dev/null && pwd -P || true)"
workspace="$(cd "$workspace" 2>/dev/null && pwd -P || true)"
[ -n "$source_root" ] && [ -n "$workspace" ] || { echo "error: Capsule source/workspace path is unavailable" >&2; exit 1; }
[ "$workspace" = "$repo_root" ] || { echo "error: Capsule metadata workspace does not match this clone" >&2; exit 1; }
[ "$source_root" != "$repo_root" ] || { echo "error: Capsule source points back to the Capsule clone" >&2; exit 1; }
git -C "$source_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "error: Capsule source is not a Git repository: $source_root" >&2; exit 1; }
[ "$(git -C "$source_root" rev-parse --git-dir)" = "$(git -C "$source_root" rev-parse --git-common-dir)" ] || {
  echo "error: Capsule source is not the primary checkout: $source_root" >&2
  exit 1
}
[ "$(git -C "$source_root" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" = "main" ] || {
  echo "error: protected source checkout is not on main: $source_root" >&2
  exit 1
}

if [ -n "$requested_branch" ] && [ "$requested_branch" != "$branch" ]; then
  echo "promotion: ignoring clone-local branch argument '$requested_branch'; Capsule identity pins '$branch'" >&2
fi
if ! git rev-parse --verify --quiet "$branch^{commit}" >/dev/null; then
  echo "error: Capsule candidate branch is missing: $branch" >&2
  exit 1
fi

dirty="$(git status --porcelain --untracked-files=all)"
if [ -n "$dirty" ]; then
  echo "error: Capsule has uncommitted work; commit it before promotion so every byte has a durable candidate SHA:" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

candidate_sha="$(git rev-parse --verify "$branch^{commit}")"
capsule_main_before="$(git rev-parse --verify refs/heads/main 2>/dev/null || true)"
safe_id="$(printf '%s' "$id" | tr -c 'A-Za-z0-9._-' '-')"
candidate_ref="refs/heads/promotion/capsule-${safe_id}/${candidate_sha}"

# Promotion is idempotent for an exact candidate SHA. A prior invocation can
# already have landed it, be waiting for Capsule CI, or be receipt-admitted to
# the source queue. Starting another run in those states only creates duplicate
# CI load and FIFO entries, so return the durable status pointer instead.
# The protected source does not learn a fresh Capsule SHA until the immutable
# candidate ref is published below.  Do not ask merge-base about an object it
# cannot yet resolve: that is normal first-publish state, not a diagnostic.
if git -C "$source_root" cat-file -e "$candidate_sha^{commit}" 2>/dev/null \
  && git -C "$source_root" merge-base --is-ancestor "$candidate_sha" refs/heads/main; then
  echo "promotion complete: candidate $candidate_sha is already contained in protected main $(git -C "$source_root" rev-parse refs/heads/main)"
  exit 0
fi
queue_state="$source_root/.capsules/queue/state.json"
if [ -f "$queue_state" ]; then
  queued_row="$(jq -cer --arg sha "$candidate_sha" '
    [.candidates[]
     | select(.sha == $sha and ((.phase // .status) == "queued" or (.phase // .status) == "reprepare" or (.phase // .status) == "retry_wait"))]
    | sort_by(.position) | .[0] // empty
  ' "$queue_state")" || queued_row=""
  if [ -n "$queued_row" ]; then
    queued_id="$(jq -r '.id' <<<"$queued_row")"
    queued_phase="$(jq -r '.phase // .status' <<<"$queued_row")"
    echo "promotion already admitted: id=$queued_id phase=$queued_phase sha=$candidate_sha"
    echo "observe: scripts/promotion-status.sh --candidate $queued_id --json"
    exit 0
  fi
fi
ci_dir="$source_root/.capsules/ci"
if [ -d "$ci_dir" ]; then
  shopt -s nullglob
  for ci_run in "$ci_dir"/*.run.json; do
    if jq -e --arg sha "$candidate_sha" '
      (.result.envelope.source_digest // "") == $sha
      and ((.result.stage // "") == "running" or (.result.job.Status // "") == "running")
    ' "$ci_run" >/dev/null 2>&1; then
      job_id="$(jq -r '.job_id // .result.job.ID // "unknown"' "$ci_run")"
      echo "promotion already running: Capsule CI job=$job_id sha=$candidate_sha"
      echo "observe: scripts/promotion-status.sh --candidate $candidate_sha --json"
      exit 0
    fi
  done
  shopt -u nullglob
fi

echo "promotion: publishing immutable candidate $candidate_sha to $source_root"
git push "$source_root" "$candidate_sha:$candidate_ref" >/dev/null

# Receipt admission is intentionally asynchronous. Reuse a valid passed
# receipt for this exact managed Capsule when it exists; otherwise `capsule
# promote` runs the declared Capsule CI. Either path appends the exact SHA to
# the durable queue without parking the producing agent behind integration.
# The POG queue worker owns the later prospective-tree gate, conflict retry,
# and protected-main CAS.
#
# POG_PROMOTION_LEGACY_DIRECT=1 is a migration escape hatch for candidates
# already being handled by an older source checkout. It preserves the previous
# durable land-branch path and must not be the normal agent entrypoint.
if [ "${POG_PROMOTION_LEGACY_DIRECT:-0}" != "1" ]; then
  command -v kitsoki >/dev/null 2>&1 || {
    echo "error: Kitsoki is required for receipt-bound queue admission; candidate remains safely published at $candidate_ref" >&2
    exit 127
  }

  # A previous Capsule-CI attempt may have completed and persisted a passing
  # receipt while its front-door process was interrupted before queue
  # admission. Re-running `capsule promote` in that state can stall in the
  # story runner or reject the retry because the in-memory run is no longer a
  # valid promotion receipt. A receipt is safe to resume only when it is
  # already bound to this immutable candidate, reports a passing verdict, and
  # the queue serializer accepts its full content/digest. Re-submit that exact
  # receipt directly; otherwise fall through to a fresh Capsule-CI run.
  reuse_existing_receipt() {
    local receipt_path admitted receipt_id
    for receipt_path in "$source_root"/.capsules/ci/*.receipt.json; do
      [ -f "$receipt_path" ] || continue
      jq -e --arg sha "$candidate_sha" '
        .schema == "capsule-ci-receipt/v1"
        and .envelope.source_digest == $sha
        and .verdict.outcome == "passed"
        and .verdict.promotion_eligible == true
        and (.receipt_id | type == "string" and length > 0)
      ' "$receipt_path" >/dev/null 2>&1 || continue
      if ! admitted="$(kitsoki queue submit \
          --project "$source_root" \
          --branch "$branch" \
          --sha "$candidate_sha" \
          --receipt "$receipt_path" \
          --backend local 2>/dev/null)"; then
        continue
      fi
      if ! jq -e --arg sha "$candidate_sha" '
        .status == "queued"
        and .sha == $sha
        and (.id | type == "string" and length > 0)
        and (.receipt_id | type == "string" and length > 0)
      ' <<<"$admitted" >/dev/null; then
        continue
      fi
      receipt_id="$(jq -r '.receipt_id' <<<"$admitted")"
      echo "promotion: reusing existing passing Capsule-CI receipt $(basename "$receipt_path") for $candidate_sha" >&2
      jq -n --arg sha "$candidate_sha" --arg receipt_id "$receipt_id" --argjson candidate "$admitted" '
        {
          schema: "capsule-promote/v1",
          status: "queued",
          candidate_sha: $sha,
          receipt_id: $receipt_id,
          queue_candidate: $candidate
        }
      '
      return 0
    done
    return 1
  }

  # `kitsoki capsule promote --current` derives its candidate from CAPSULE
  # CONTROL's recorded workspace head, not the live branch tip. That recorded
  # head only advances via `kitsoki capsule workspace commit`; any rebase (or a
  # raw `git commit`) leaves it stale. Promoting in that state is not a no-op:
  # it spends a full Capsule-CI run gating the wrong tree, then admits the
  # stale SHA to the durable queue with a passing receipt. When that stale SHA
  # was never published to the source (the usual case for a pre-rebase commit),
  # the worker cannot resolve its ref, so the candidate can never land and
  # wedges the FIFO behind it. Observed twice on 2026-07-17: live tip 440b938
  # vs recorded head 004d783, admitted as queue sequence 24.
  #
  # POG cannot repair the divergence itself. Advancing the recorded head
  # requires `kitsoki capsule workspace commit`, and `kitsoki capsule ci run
  # change` exposes no way to pin an arbitrary SHA, so there is no POG-side
  # path that mints a receipt bound to the live tip. A safe refresh-and-rebind
  # primitive is a known upstream gap; Kitsoki is external and unowned here.
  # So detect the divergence, refuse before spending any CI, and say exactly
  # how to reconcile.
  capsule_control_head=""
  if capsule_status_output="$(kitsoki capsule workspace status --project "$source_root" --id "$id" --json 2>/dev/null)"; then
    capsule_control_head="$(jq -r '.head // empty' <<<"$capsule_status_output" 2>/dev/null || true)"
  fi
  heads_diverged=0
  if [ -n "$capsule_control_head" ] && [ "$capsule_control_head" != "$candidate_sha" ]; then
    heads_diverged=1
  fi

  effective_gate="${gate:-scripts/checks.sh}"
  [ "$skip_tests" -eq 0 ] || effective_gate=':'
  # The receipt reuse path above is SHA-exact: it matches on
  # envelope.source_digest == $candidate_sha and submits that SHA directly,
  # never consulting the recorded head. It is therefore safe to try even when
  # the heads disagree, and is the one way a diverged workspace can still
  # promote without re-committing.
  if ! queue_output="$(reuse_existing_receipt)"; then
    if [ "$heads_diverged" -eq 1 ]; then
      cat >&2 <<EOF
error: refusing to promote — the Capsule's recorded head is stale.

  live candidate (branch tip): $candidate_sha
  capsule control head:        $capsule_control_head

'kitsoki capsule promote --current' would gate and admit the recorded head,
not your candidate, and admitting an unpublished SHA wedges the queue. No
Capsule CI was run and nothing was queued.

Reconcile the recorded head, then re-run this script:
  kitsoki capsule workspace commit --project "$source_root" --id "$id" --message "<msg>"
(--project must be the SOURCE root, not the workspace directory.)

The candidate remains safely published at $candidate_ref
EOF
      exit 1
    fi
    queue_output="$(kitsoki capsule promote --current --pipeline change --target main --gate "$effective_gate" --json)"
  fi
  # Whatever path admitted a candidate, never accept one bound to a SHA that
  # is not actually published in the source repo: an admitted-but-unresolvable
  # ref can never land and would otherwise wedge the FIFO behind it forever.
  admitted_sha="$(jq -r '.candidate_sha // empty' <<<"$queue_output" 2>/dev/null || true)"
  if [ -n "$admitted_sha" ] && ! git -C "$source_root" cat-file -e "$admitted_sha^{commit}" 2>/dev/null; then
    echo "error: Kitsoki admitted candidate $admitted_sha is not published in the source repository $source_root; refusing admission. candidate remains safely published at $candidate_ref" >&2
    printf '%s\n' "$queue_output" >&2
    exit 1
  fi
  if ! jq -e --arg sha "$candidate_sha" '
      .schema == "capsule-promote/v1"
      and .status == "queued"
      and .candidate_sha == $sha
      and (.receipt_id | type == "string" and length > 0)
      and (.queue_candidate.status == "queued")
    ' <<<"$queue_output" >/dev/null; then
    echo "error: Kitsoki did not return a receipt-bound queued candidate; candidate remains safely published at $candidate_ref" >&2
    printf '%s\n' "$queue_output" >&2
    exit 1
  fi
  printf '%s\n' "$queue_output"
  if [ "$emergency" -eq 1 ]; then
    queue_id="$(jq -r '.queue_candidate.id // empty' <<<"$queue_output")"
    printf '%s\n' "$queue_output"
    [ -n "$queue_id" ] || { echo "error: queued candidate has no durable id for emergency promotion" >&2; exit 1; }
    emergency_args=(--source-root "$source_root")
    [ "$skip_tests" -eq 0 ] || emergency_args+=(--skip-tests)
    "$script_dir/mark-promotion-emergency.sh" "${emergency_args[@]}" "$queue_id"
  fi
  [ "$skip_tests" -eq 0 ] || echo 'promotion waiver: Capsule and prospective-tree test gates were explicitly bypassed'
  echo "promotion queued: immutable candidate retained at $candidate_ref"
  # A queued candidate is only useful if a worker is alive to consume it;
  # candidates otherwise sit in "queued" until someone remembers to start one.
  # Agents submit and exit, so ensure a long-lived watch worker here. The
  # worker's own lock guarantees single ownership — a concurrent spawn just
  # observes "already active" and exits 0. POG_PROMOTION_NO_AUTOSTART=1 opts
  # out (test fixtures manage their own deterministic workers).
  if [ "${POG_PROMOTION_NO_AUTOSTART:-0}" != "1" ]; then
    worker_log_dir="$source_root/.artifacts/promotion-queue"
    mkdir -p "$worker_log_dir"
    worker_log="$worker_log_dir/worker-watch.log"
    (cd "$source_root" && nohup scripts/process-promotion-queue.sh --watch >>"$worker_log" 2>&1 &)
    echo "queue worker: ensured a live watch worker in $source_root (log: $worker_log)"
  else
    echo "queue worker: scripts/process-promotion-queue.sh"
  fi
  exit 0
fi

# Busy protected checkouts are normal when several local agents are active.
# Do not fail immediately and do not stash/reset somebody else's bytes. The
# immutable candidate is already safe in the source repo, so wait for the
# checkout owner to finish and then continue from the fresh main tip.
clean_wait="${POG_PROMOTION_CLEAN_WAIT_SECONDS:-600}"
case "$clean_wait" in *[!0-9]*|'') echo "error: POG_PROMOTION_CLEAN_WAIT_SECONDS must be an integer" >&2; exit 2 ;; esac
clean_deadline=$(( $(date +%s) + clean_wait ))
announced_dirty=0
while [ -n "$(git -C "$source_root" status --porcelain --untracked-files=all)" ]; do
  if [ "$announced_dirty" -eq 0 ]; then
    echo "promotion: protected source is busy; candidate is safe and promotion will resume when it is clean"
    announced_dirty=1
  fi
  if [ "$(date +%s)" -ge "$clean_deadline" ]; then
    echo "error: timed out waiting for the protected source checkout to become clean; candidate remains at $candidate_ref" >&2
    exit 1
  fi
  sleep 2
done

args=("$candidate_ref")
[ -z "$gate" ] || args+=(--gate "$gate")
[ -z "$resolver_command" ] || args+=(--resolver-command "$resolver_command")
(
  cd "$source_root"
  POG_PROMOTION_SOURCE_HANDOFF=1 \
    POG_PROMOTION_HANDOFF_DEPTH=$((handoff_depth + 1)) \
    scripts/land-branch.sh "${args[@]}"
)

source_main="$(git -C "$source_root" rev-parse --verify refs/heads/main)"
if [ -n "$capsule_main_before" ] && [ "$(git rev-parse --verify refs/heads/main)" != "$capsule_main_before" ]; then
  echo "error: invariant violated: Capsule-local main moved during source promotion" >&2
  exit 1
fi
git fetch "$source_root" "refs/heads/main:refs/remotes/source/main" >/dev/null 2>&1 || true

echo "promotion complete: protected main is $source_main"
echo "source repository: $source_root"
echo "candidate retained: $candidate_ref"
