#!/usr/bin/env bash
# land-branch.sh <branch> [--gate "<command>"] [--resolver-command "<command>"]
#
# Integrate a committed candidate with protected local main, validate the exact
# resulting tree, and advance main through merge-to-main.sh. Divergent history
# is preserved with a merge commit. Conflicts are resolved through Kitsoki's
# fenced git-ops resolver (or an injected deterministic resolver in tests).
#
# Integration is intentionally durable:
#   - the candidate ref is never rewritten or deleted;
#   - each candidate/main pair gets a stable integration branch and worktree;
#   - a failed resolver or gate leaves that state in place for the next retry;
#   - successful worktrees are removed, but the integrated ref remains.
#
# When invoked inside a standalone managed Capsule, this script delegates to
# promote-to-main.sh, which publishes the Capsule candidate into the source
# repository and runs this helper in the real protected checkout.
set -euo pipefail

usage() {
  echo 'usage: scripts/land-branch.sh <branch> [--gate "<command>"] [--resolver-command "<command>"]' >&2
}

branch=""
gate=""
resolver_command="${POG_LAND_RESOLVER_COMMAND:-}"

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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$branch" ]; then
        echo "error: unexpected argument: $1" >&2
        usage
        exit 2
      fi
      branch="$1"
      shift
      ;;
  esac
done

[ -n "$branch" ] || { usage; exit 2; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(git -C "$script_dir/.." rev-parse --show-toplevel)"

# A Capsule is a standalone clone, so its local main is not the protected
# source main. Never allow this helper to advance the clone-local ref.
if [ "${POG_PROMOTION_SOURCE_HANDOFF:-}" != "1" ] && [ -f "$repo_root/.kitsoki-dev-workspace.json" ] && command -v jq >/dev/null 2>&1; then
  capsule_source="$(jq -r '.source // empty' "$repo_root/.kitsoki-dev-workspace.json" 2>/dev/null || true)"
  if [ -n "$capsule_source" ] && [ "$(cd "$capsule_source" 2>/dev/null && pwd -P || true)" != "$repo_root" ]; then
    promote_args=()
    [ -z "$gate" ] || promote_args+=(--gate "$gate")
    [ -z "$resolver_command" ] || promote_args+=(--resolver-command "$resolver_command")
    exec "$script_dir/promote-to-main.sh" "${promote_args[@]}"
  fi
fi

if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
  echo "error: run this in the primary checkout, not a linked worktree" >&2
  exit 1
fi
if [ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)" != "main" ]; then
  echo "error: the protected checkout is not on main" >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "$branch^{commit}" >/dev/null; then
  echo "error: no such candidate commit: $branch" >&2
  exit 1
fi

cd "$repo_root"

git_common_dir="$(git rev-parse --git-common-dir)"
case "$git_common_dir" in
  /*) ;;
  *) git_common_dir="$repo_root/$git_common_dir" ;;
esac
lock_dir="$git_common_dir/pog-promotion.lock"
queue_dir="$git_common_dir/pog-promotion.queue"
lock_wait="${POG_PROMOTION_LOCK_WAIT_SECONDS:-600}"
case "$lock_wait" in *[!0-9]*|'') echo "error: POG_PROMOTION_LOCK_WAIT_SECONDS must be an integer" >&2; exit 2 ;; esac

ticket_dir=""

cleanup_stale_ticket() {
  local candidate pid
  for candidate in "$queue_dir"/ticket-*; do
    [ -d "$candidate" ] || continue
    pid="$(sed -n '1p' "$candidate/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -rf "$candidate" 2>/dev/null || true
    fi
  done
}

acquire_ticket() {
  local deadline issuer holder sequence
  deadline=$(( $(date +%s) + lock_wait ))
  mkdir -p "$queue_dir"
  issuer="$queue_dir/issuer.lock"
  while ! mkdir "$issuer" 2>/dev/null; do
    holder="$(sed -n '1p' "$issuer/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$issuer" 2>/dev/null || true
      continue
    fi
    [ "$(date +%s)" -lt "$deadline" ] || { echo "error: timed out issuing promotion queue ticket" >&2; return 1; }
    sleep 1
  done
  printf '%s\n' "$$" >"$issuer/pid"
  sequence="$(cat "$queue_dir/sequence" 2>/dev/null || echo 0)"
  case "$sequence" in *[!0-9]*|'') rm -rf "$issuer"; echo "error: invalid promotion queue sequence" >&2; return 1 ;; esac
  # Queue tickets are zero-padded for lexical FIFO ordering.  Force decimal
  # parsing so ticket 000...08 does not trip Bash's legacy octal arithmetic.
  sequence=$((10#$sequence + 1))
  printf '%020d\n' "$sequence" >"$queue_dir/sequence"
  ticket_dir="$queue_dir/ticket-$(printf '%020d' "$sequence")"
  mkdir "$ticket_dir"
  printf '%s\n' "$$" >"$ticket_dir/pid"
  rm -rf "$issuer"
}

first_ticket() {
  find "$queue_dir" -mindepth 1 -maxdepth 1 -type d -name 'ticket-*' -exec basename {} \; | LC_ALL=C sort | head -n 1
}

acquire_lock() {
  local deadline holder first
  deadline=$(( $(date +%s) + lock_wait ))
  acquire_ticket || return 1
  echo "promotion: queued as $(basename "$ticket_dir")" >&2
  while :; do
    cleanup_stale_ticket
    first="$(first_ticket)"
    if [ "$first" = "$(basename "$ticket_dir")" ] && mkdir "$lock_dir" 2>/dev/null; then
      printf '%s\n' "$$" >"$lock_dir/pid"
      rm -rf "$ticket_dir"
      ticket_dir=""
      return 0
    fi
    holder="$(sed -n '1p' "$lock_dir/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$lock_dir" 2>/dev/null || true
      continue
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "error: timed out waiting for promotion lock held by pid ${holder:-unknown}: $lock_dir" >&2
      return 1
    fi
    sleep 1
  done
}

release_lock() {
  if [ "$(sed -n '1p' "$lock_dir/pid" 2>/dev/null || true)" = "$$" ]; then
    rm -rf "$lock_dir"
  fi
  [ -z "$ticket_dir" ] || rm -rf "$ticket_dir"
}

acquire_lock
trap release_lock EXIT

main_sha="$(git rev-parse --verify refs/heads/main)"
candidate_sha="$(git rev-parse --verify "$branch^{commit}")"

if git merge-base --is-ancestor "$candidate_sha" "$main_sha"; then
  merge_args=(main)
  [ -z "$gate" ] || merge_args+=(--gate "$gate")
  "$script_dir/merge-to-main.sh" "${merge_args[@]}"
  echo "promotion: candidate $candidate_sha is already contained in protected main"
  echo "protected main ($repo_root) -> $(git rev-parse --short refs/heads/main)"
  exit 0
fi

# Fast-forward candidates do not need an integration merge commit.
if git merge-base --is-ancestor "$main_sha" "$candidate_sha"; then
  merge_args=("$branch")
  [ -z "$gate" ] || merge_args+=(--gate "$gate")
  "$script_dir/merge-to-main.sh" "${merge_args[@]}"
  echo "promotion path: direct fast-forward"
  echo "protected main ($repo_root) -> $(git rev-parse --short refs/heads/main)"
  exit 0
fi

# The main SHA is part of the identity. If main ever moves outside this lock,
# the next invocation creates a new attempt and retains the old one untouched.
candidate_short="${candidate_sha:0:12}"
main_short="${main_sha:0:12}"
integration_branch="promotion/integrated/${candidate_short}-onto-${main_short}"
worktree="$repo_root/.capsules/workspaces/promotion-${candidate_short}-onto-${main_short}"
merge_log="$repo_root/.artifacts/promotions/${candidate_short}-onto-${main_short}/merge.log"
mkdir -p "$(dirname "$merge_log")" "$repo_root/.capsules/workspaces"

if [ ! -e "$worktree" ]; then
  if git rev-parse --verify --quiet "refs/heads/$integration_branch" >/dev/null; then
    POG_LANDING_SCRATCH_WORKTREE=1 git worktree add "$worktree" "$integration_branch" >/dev/null
  else
    POG_LANDING_SCRATCH_WORKTREE=1 git worktree add -b "$integration_branch" "$worktree" "$main_sha" >/dev/null
  fi
fi

if [ "$(git -C "$worktree" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" != "$integration_branch" ]; then
  echo "error: durable promotion worktree is on an unexpected branch; preserved for inspection: $worktree" >&2
  exit 1
fi

merge_head_path="$(git -C "$worktree" rev-parse --git-path MERGE_HEAD)"
if [ ! -f "$merge_head_path" ] && ! git -C "$worktree" diff --quiet --ignore-submodules --; then
  echo "error: durable promotion worktree has uncommitted non-merge work; preserved for inspection: $worktree" >&2
  exit 1
fi
if [ ! -f "$merge_head_path" ] && ! git -C "$worktree" diff --cached --quiet --ignore-submodules --; then
  echo "error: durable promotion worktree has staged non-merge work; preserved for inspection: $worktree" >&2
  exit 1
fi

if [ ! -f "$merge_head_path" ] && ! git merge-base --is-ancestor "$candidate_sha" "refs/heads/$integration_branch"; then
  set +e
  git -C "$worktree" merge --no-ff --no-edit "$candidate_sha" >"$merge_log" 2>&1
  merge_status=$?
  set -e
  if [ "$merge_status" -ne 0 ] && [ ! -f "$merge_head_path" ]; then
    echo "error: integration merge failed before producing a resumable conflict state; branch and log preserved" >&2
    echo "  branch: $integration_branch" >&2
    echo "  worktree: $worktree" >&2
    echo "  log: $merge_log" >&2
    exit 1
  fi
fi

conflict_files() {
  git -C "$worktree" diff --diff-filter=U --name-only
}

resolution_is_clean() {
  local path
  git -C "$worktree" diff --check >/dev/null 2>&1 || return 1
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if [ -f "$worktree/$path" ] && grep -qE '^(<<<<<<< |=======|>>>>>>> )' "$worktree/$path" 2>/dev/null; then
      return 1
    fi
  done < <(conflict_files)
}

stage_resolved_conflicts() {
  local path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    git -C "$worktree" add -A -- "$path"
  done < <(conflict_files)
  ! conflict_files | grep -q .
}

run_resolver() {
  local files task kitsoki_src kitsoki_bin backend profile
  files="$(conflict_files)"
  [ -n "$files" ] || return 1
  task="$worktree/.artifacts/promotion-conflict-task.md"
  mkdir -p "$(dirname "$task")"
  cat >"$task" <<EOF
# Resolve protected-main promotion conflicts

Working directory: $worktree
Protected repository: $repo_root
Target main SHA: $main_sha
Candidate SHA: $candidate_sha
Conflicted files:
$files

Resolve every listed file now. Preserve the target main version as the base and
re-apply the candidate's complete additive intent without discarding either
side's unrelated work. Edit only conflicted files. Do not run Git commands,
stage, commit, push, switch branches, or modify protected main. Remove all
conflict markers before finishing.
EOF
  if [ -n "$resolver_command" ]; then
    (cd "$worktree" && \
      POG_LAND_WORKTREE="$worktree" \
      POG_LAND_CONFLICT_FILES="$files" \
      POG_LAND_TASK_FILE="$task" \
      sh -c "$resolver_command")
    return
  fi
  kitsoki_src="${POG_KITSOKI_SRC:-$(cd "$repo_root/../Kitsoki" 2>/dev/null && pwd -P || true)}"
  [ -f "$kitsoki_src/stories/git-ops/app.yaml" ] || {
    echo "error: Kitsoki git-ops resolver is unavailable; set POG_KITSOKI_SRC" >&2
    return 1
  }
  kitsoki_bin="${KITSOKI_BIN:-kitsoki}"
  command -v "$kitsoki_bin" >/dev/null 2>&1 || {
    echo "error: Kitsoki CLI is unavailable: $kitsoki_bin" >&2
    return 1
  }
  backend="${POG_LAND_RESOLVER_BACKEND:-codex}"
  profile="${POG_LAND_RESOLVER_PROFILE:-pog-driver-$backend}"
  "$kitsoki_bin" agent launch \
    --app "$kitsoki_src/stories/git-ops/app.yaml" \
    --agent conflict_resolver \
    --backend "$backend" \
    --profile "$profile" \
    --config "$repo_root/.kitsoki.yaml" \
    --task-file "$task" \
    --working-dir "$worktree" \
    --mode codeact \
    --exec
}

if [ -f "$merge_head_path" ]; then
  attempts="${POG_PROMOTION_RESOLVER_ATTEMPTS:-3}"
  case "$attempts" in *[!0-9]*|'') echo "error: POG_PROMOTION_RESOLVER_ATTEMPTS must be an integer" >&2; exit 2 ;; esac
  attempt=0
  git -C "$worktree" rerere >/dev/null 2>&1 || true
  while ! resolution_is_clean && [ "$attempt" -lt "$attempts" ]; do
    attempt=$((attempt + 1))
    echo "promotion: resolving integration conflicts automatically (attempt $attempt/$attempts)"
    run_resolver || true
  done
  if ! resolution_is_clean || ! stage_resolved_conflicts; then
    echo "error: automatic resolver exhausted its attempts; all candidate and integration work is preserved" >&2
    echo "  candidate: $branch ($candidate_sha)" >&2
    echo "  integration branch: $integration_branch" >&2
    echo "  integration worktree: $worktree" >&2
    echo "  retry: scripts/land-branch.sh $branch" >&2
    exit 1
  fi
  git -C "$worktree" rerere >/dev/null 2>&1 || true
  GIT_EDITOR=true git -C "$worktree" commit --no-edit >/dev/null
fi

if ! git merge-base --is-ancestor "$main_sha" "refs/heads/$integration_branch" || \
   ! git merge-base --is-ancestor "$candidate_sha" "refs/heads/$integration_branch"; then
  echo "error: integrated branch does not preserve both main and candidate ancestry; state retained at $worktree" >&2
  exit 1
fi

merge_args=("$integration_branch")
[ -z "$gate" ] || merge_args+=(--gate "$gate")
"$script_dir/merge-to-main.sh" "${merge_args[@]}"

# Main and the durable refs now retain every commit. The disposable worktree
# can be removed without deleting candidate or integration history.
git worktree remove "$worktree" --force >/dev/null 2>&1 || true

echo "promotion path: merge-and-land ($branch -> $integration_branch)"
echo "protected main ($repo_root) -> $(git rev-parse --short refs/heads/main)"
