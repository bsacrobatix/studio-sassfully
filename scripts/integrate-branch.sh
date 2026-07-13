#!/usr/bin/env bash
# Integrate a feature branch with a dirty protected main without stashing or
# overwriting work. Inspired by Kitsoki git-ops' isolated conflict workflow.
set -euo pipefail

usage() { cat <<'EOF'
usage: scripts/integrate-branch.sh <branch> [--gate CMD] [--auto-resolve --resolver-command CMD] [--review-command CMD] [--promote]

The command snapshots dirty tracked main work into a committed recovery branch,
then cherry-picks the feature into an isolated worktree. A resolver receives a
prompt plus SASSFULLY_INTEGRATE_* variables; a reviewer may reject lost work.
--promote advances main only after the integration and gate are green.
EOF
}
die() { echo "error: $*" >&2; exit 1; }
branch="${1:-}"; [ -n "$branch" ] || { usage; exit 2; }; shift
gate="scripts/checks.sh"; auto=0; promote=0; resolver="${SASSFULLY_INTEGRATE_RESOLVE_CMD:-}"; reviewer="${SASSFULLY_INTEGRATE_REVIEW_CMD:-}"
while [ "$#" -gt 0 ]; do case "$1" in
  --gate) gate="$2"; shift 2;; --auto-resolve) auto=1; shift;; --resolver-command) resolver="$2"; shift 2;; --review-command) reviewer="$2"; shift 2;; --promote) promote=1; shift;; -h|--help) usage; exit 0;; *) die "unknown option: $1";; esac; done
root="$(git rev-parse --show-toplevel)"; cd "$root"
[ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ] || die "run from the primary checkout"
[ "$(git branch --show-current)" = main ] || die "primary checkout must be on main"
git rev-parse --verify --quiet "$branch" >/dev/null || die "no such branch: $branch"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"; safe="${branch//\//-}"; artifact=".artifacts/integrate-branch/$stamp"
mkdir -p "$artifact"; patch="$artifact/main-before.patch"; git diff --binary >"$patch"
recovery="recovery/main-before-$stamp"; recovery_wt=".worktrees/recovery-main-$stamp"; integration="integrate/$safe-$stamp"; integration_wt=".worktrees/integrate-$safe-$stamp"
cleanup() { [ "${keep_worktrees:-0}" = 1 ] || { git worktree remove --force "$integration_wt" >/dev/null 2>&1 || true; git worktree remove --force "$recovery_wt" >/dev/null 2>&1 || true; }; }
trap cleanup EXIT
git worktree add -b "$recovery" "$recovery_wt" main >/dev/null
if [ -s "$patch" ]; then git -C "$recovery_wt" apply --index "$root/$patch"; git -C "$recovery_wt" commit -m "recovery: snapshot dirty main before integrating $branch" >/dev/null; fi
git worktree add -b "$integration" "$integration_wt" "$recovery" >/dev/null
set +e; git -C "$integration_wt" cherry-pick "$(git rev-list --reverse main.."$branch")"; status=$?; set -e
prompt="$root/$integration_wt/.artifacts/integrate-branch/resolve-conflicts.md"; mkdir -p "$(dirname "$prompt")"
if [ "$status" -ne 0 ]; then
  { echo "# Resolve feature landing conflicts"; echo; echo "Preserve intentional recovery-main and feature-branch work. Stage only resolved conflict files; do not commit."; echo; git -C "$integration_wt" diff --name-only --diff-filter=U; } >"$prompt"
  if [ "$auto" -eq 0 ]; then keep_worktrees=1; die "conflicts isolated in $root/$integration_wt; rerun with --auto-resolve and a resolver command"
  fi
  [ -n "$resolver" ] || { keep_worktrees=1; die "--auto-resolve requires --resolver-command or SASSFULLY_INTEGRATE_RESOLVE_CMD"; }
  (cd "$integration_wt"; export SASSFULLY_INTEGRATE_WORKTREE="$PWD" SASSFULLY_INTEGRATE_BRANCH="$integration" SASSFULLY_INTEGRATE_FEATURE="$branch" SASSFULLY_INTEGRATE_RECOVERY="$recovery" SASSFULLY_INTEGRATE_PROMPT_FILE="$prompt"; "$resolver")
  [ -z "$(git -C "$integration_wt" diff --name-only --diff-filter=U)" ] || { keep_worktrees=1; die "resolver left conflicts unresolved"; }
  if ! GIT_EDITOR=true git -C "$integration_wt" cherry-pick --continue; then
    git -C "$integration_wt" status --short >&2
    keep_worktrees=1
    die "resolver did not produce a continuable cherry-pick"
  fi
fi
if [ -n "$reviewer" ]; then (cd "$integration_wt"; export SASSFULLY_INTEGRATE_WORKTREE="$PWD" SASSFULLY_INTEGRATE_PROMPT_FILE="$prompt"; "$reviewer"); else git -C "$integration_wt" diff --check; fi
(cd "$integration_wt" && bash -c "$gate")
if [ "$promote" -eq 1 ]; then
  # The original dirty state is now a committed recovery ancestor. Resetting
  # main is therefore a ref-preserving promotion, not a lost-work cleanup.
  git reset --hard "$integration" >/dev/null
  echo "landed: $(git rev-parse --short main) (recovery: $recovery)"
else
  keep_worktrees=1
  echo "ready: $integration in $root/$integration_wt"
  echo "review, then rerun with --promote after confirming recovery $recovery"
fi
