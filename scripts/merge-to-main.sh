#!/usr/bin/env bash
# merge-to-main.sh <branch> [--gate "<command>"] - validate the exact
# candidate tree, then fast-forward it into protected local main.
#
# Implementation work happens in .worktrees/* branches; this helper is the
# intentional landing path onto main. It refuses non-fast-forward merges:
# rebase or rebuild the branch in its worktree first when main has advanced
# (or use land-branch.sh, which automates that recipe).
#
# Read-only regime (opt-in): when `git config --bool pog.readOnlyMain` is
# true, the primary checkout keeps tracked files read-only as a second guard
# against accidental direct edits. This script then lifts write permission on
# exactly the files and directories the fast-forward touches, merges, and
# restores the guard. With the config unset/false (the default), it is a
# plain checked fast-forward and never chmods anything. In either mode, the
# gate runs from a detached scratch worktree at the immutable candidate SHA.
# The helper then compare-and-swaps both main and the candidate branch: if
# either moved while validation ran, protected main is not changed.
#
# Run from the primary checkout, while on main:
#   scripts/merge-to-main.sh <branch> [--gate "<command>"]
#
# Lineage: generalized from kitsoki scripts/merge-to-main.sh (the goal-ledger
# integration is kitsoki instance tooling and was dropped; the guard became
# config-gated). Managed by the pog conventions pack.
set -euo pipefail

usage() {
  echo 'usage: scripts/merge-to-main.sh <branch> [--gate "<shell command>"]' >&2
}

branch=""
gate=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --gate)
      gate="${2:?--gate requires a value}"
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
        exit 1
      fi
      branch="$1"
      shift
      ;;
  esac
done
[ -n "$branch" ] || { usage; exit 1; }

repo_root="$(git rev-parse --show-toplevel)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Standalone Capsules have a private local main. Route legacy invocations
# through the source-aware one-command promoter instead of ever advancing it.
if [ -f "$repo_root/.kitsoki-dev-workspace.json" ] && command -v jq >/dev/null 2>&1; then
  capsule_source="$(jq -r '.source // empty' "$repo_root/.kitsoki-dev-workspace.json" 2>/dev/null || true)"
  if [ -n "$capsule_source" ] && [ "$(cd "$capsule_source" 2>/dev/null && pwd -P || true)" != "$repo_root" ]; then
    promote_args=("$branch")
    [ -z "$gate" ] || promote_args+=(--gate "$gate")
    exec "$script_dir/promote-to-main.sh" "${promote_args[@]}"
  fi
fi

if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
  echo "error: run this in the primary checkout, not a linked worktree" >&2
  exit 1
fi
if [ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)" != "main" ]; then
  echo "error: the primary checkout is not on main" >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "$branch" >/dev/null; then
  echo "error: no such branch: $branch" >&2
  exit 1
fi
if ! git merge-base --is-ancestor HEAD "$branch"; then
  echo "error: $branch is not a fast-forward of main; rebase it onto main in its worktree first (or use scripts/land-branch.sh)" >&2
  exit 1
fi

cd "$repo_root"
main_sha="$(git rev-parse --verify HEAD)"
candidate_sha="$(git rev-parse --verify "$branch^{commit}")"

changed_files_file="$(mktemp "${TMPDIR:-/tmp}/pog-merge-files.XXXXXX")"
git diff --name-only -z --no-renames "$main_sha" "$candidate_sha" >"$changed_files_file"

# A protected checkout must be clean, full stop. The compatibility helper does
# not stash or ignore unrelated WIP; preserve it in a managed workspace first.
primary_status="$(git status --porcelain --untracked-files=all)"
if [ -n "$primary_status" ]; then
  rm -f "$changed_files_file"
  echo "error: protected main checkout is dirty; preserve and repair it in a managed workspace before landing:" >&2
  printf '%s\n' "$primary_status" >&2
  exit 1
fi

if [ -z "$gate" ]; then
  if [ -x "$script_dir/checks.sh" ]; then
    gate="scripts/checks.sh"
  elif [ -x "$script_dir/pog-doctor" ]; then
    gate="scripts/pog-doctor ."
  else
    rm -f "$changed_files_file"
    echo "error: no default gate found; pass --gate explicitly" >&2
    exit 1
  fi
fi

# Green-receipt memo: a (tree, gate command) pair this helper has already
# validated green is not re-run. Only green runs are recorded, the key binds
# the exact tree and the exact gate string, and the deterministic red probe
# plus POG_LANDING_GATE_MEMO=0 both force revalidation — so the memo can
# never skip a red or unproven gate. What it removes is byte-identical
# revalidation, e.g. a duplicate queue submission of an already-landed
# candidate re-gating the tree that landed green minutes earlier.
candidate_tree="$(git rev-parse --verify "$candidate_sha^{tree}")"
gate_fingerprint="$(printf '%s' "$gate" | shasum -a 256 | cut -d' ' -f1)"
receipts_dir="$repo_root/.artifacts/gate-receipts"
receipt="$receipts_dir/${candidate_tree}-${gate_fingerprint}.json"
memo_enabled=1
[ "${POG_LANDING_GATE_MEMO:-1}" != "0" ] || memo_enabled=0
[ "${POG_GX10_INJECT_FAILURE:-}" != "1" ] || memo_enabled=0
command -v jq >/dev/null 2>&1 || memo_enabled=0
memo_hit=0
if [ "$memo_enabled" -eq 1 ] && [ -f "$receipt" ] && \
   jq -e --arg tree "$candidate_tree" --arg gate "$gate" \
     '.schema == "pog/gate-receipt/v1" and .tree == $tree and .gate == $gate' \
     "$receipt" >/dev/null 2>&1; then
  memo_hit=1
fi

if [ "$memo_hit" -eq 1 ]; then
  echo "merge-to-main: tree $candidate_tree already validated green by an identical gate at $(jq -r '.validated_at // "an unrecorded time"' "$receipt"); skipping revalidation" >&2
else
  safe_branch="$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._-' '-')"
  verify_worktree="$repo_root/.worktrees/.landing-verify-${safe_branch}-$$"
  cleanup_verify() {
    git worktree remove "$verify_worktree" --force >/dev/null 2>&1 || true
    rm -f "$changed_files_file"
  }
  trap cleanup_verify EXIT
  mkdir -p "$repo_root/.worktrees"
  POG_LANDING_SCRATCH_WORKTREE=1 git worktree add --detach "$verify_worktree" "$candidate_sha" >/dev/null
  echo "merge-to-main: validating prospective main $candidate_sha: $gate" >&2
  (cd "$verify_worktree" && sh -c "$gate")

  if [ "$(git -C "$verify_worktree" rev-parse --verify HEAD)" != "$candidate_sha" ]; then
    echo "error: gate moved candidate HEAD; validation commands must not create commits" >&2
    exit 1
  fi
  if ! git -C "$verify_worktree" diff --quiet || ! git -C "$verify_worktree" diff --cached --quiet; then
    echo "error: gate modified tracked candidate files; refusing to land an unproven tree" >&2
    exit 1
  fi
  git worktree remove "$verify_worktree" --force >/dev/null
  trap - EXIT
fi

if [ "$(git rev-parse --verify HEAD)" != "$main_sha" ]; then
  echo "error: main moved during validation; candidate must be revalidated against the new target" >&2
  exit 1
fi
if [ "$(git rev-parse --verify "$branch^{commit}")" != "$candidate_sha" ]; then
  echo "error: $branch moved during validation; refusing to land an unproven commit" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$main_sha" "$candidate_sha"; then
  echo "error: validated candidate is no longer a fast-forward of main" >&2
  exit 1
fi

if [ "$memo_enabled" -eq 1 ] && [ "$memo_hit" -eq 0 ]; then
  mkdir -p "$receipts_dir"
  tmp_receipt="$(mktemp "$receipts_dir/.receipt.XXXXXX")"
  jq -n --arg tree "$candidate_tree" --arg gate "$gate" --arg candidate "$candidate_sha" \
        --arg main "$main_sha" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{schema:"pog/gate-receipt/v1",tree:$tree,gate:$gate,candidate_sha:$candidate,main_sha:$main,validated_at:$at}' >"$tmp_receipt"
  chmod 0600 "$tmp_receipt"
  mv "$tmp_receipt" "$receipt"
fi

if [ ! -s "$changed_files_file" ]; then
  rm -f "$changed_files_file"
  echo "nothing to merge; validated main already contains $branch"
  exit 0
fi

files="$(tr '\0' '\n' <"$changed_files_file")"
rm -f "$changed_files_file"

read_only="$(git config --bool pog.readOnlyMain 2>/dev/null || echo false)"

if [ "$read_only" != "true" ]; then
  POG_LANDING_MAIN_FAST_FORWARD=1 git merge --ff-only "$branch"
  echo "main -> $(git rev-parse --short HEAD)"
  exit 0
fi

dirs="$(printf '%s\n' "$files" | xargs -n1 dirname | sort -u)"
guard_paths="$(
  printf '%s\n' "$files" | while IFS= read -r f; do
    [ -e "$f" ] && printf '%s\n' "$f"
    d="$(dirname "$f")"
    [ "$d" = "." ] && printf '%s\n' "."
    while [ "$d" != "." ] && [ "$d" != "/" ]; do
      [ -e "$d" ] && printf '%s\n' "$d"
      parent="$(dirname "$d")"
      [ "$parent" = "$d" ] && break
      d="$parent"
    done
  done | sort -u
)"

restore_guard() {
  printf '%s\n' "$files" | while IFS= read -r f; do
    [ -e "$f" ] && chmod a-w "$f" || true
  done
  printf '%s\n' "$dirs" | while IFS= read -r d; do
    [ -n "$d" ] && [ -e "$d" ] && chmod a-w "$d" 2>/dev/null || true
  done
  printf '%s\n' "$guard_paths" | while IFS= read -r p; do
    [ -n "$p" ] && [ -e "$p" ] && chmod a-w "$p" 2>/dev/null || true
  done
}

trap restore_guard EXIT

printf '%s\n' "$guard_paths" | while IFS= read -r p; do
  [ -n "$p" ] && chmod u+w "$p" 2>/dev/null || true
done
printf '%s\n' "$files" | while IFS= read -r f; do
  [ -e "$f" ] && chmod u+w "$f" || true
done

POG_LANDING_MAIN_FAST_FORWARD=1 git merge --ff-only "$branch"

restore_guard
trap - EXIT

echo "main -> $(git rev-parse --short HEAD); read-only guard restored for changed paths"
