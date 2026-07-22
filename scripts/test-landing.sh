#!/usr/bin/env bash
# Regression gate for protected-main landing semantics. Uses only throwaway
# repositories and never touches the caller's refs or working tree.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"

git init -q -b main "$repo"
git -C "$repo" config user.name "POG landing test"
git -C "$repo" config user.email "landing-test@example.invalid"
mkdir -p "$repo/scripts"
cp "$script_dir/merge-to-main.sh" "$repo/scripts/merge-to-main.sh"
cp "$script_dir/land-branch.sh" "$repo/scripts/land-branch.sh"
chmod +x "$repo/scripts/merge-to-main.sh" "$repo/scripts/land-branch.sh"
printf '.worktrees/\n.capsules/\n.artifacts/\n' >"$repo/.gitignore"
echo base >"$repo/base.txt"
git -C "$repo" add -A
git -C "$repo" commit -qm "base"
base="$(git -C "$repo" rev-parse HEAD)"

# Cut a future divergent branch before main advances.
git -C "$repo" worktree add -q "$tmp/side" -b side main

git -C "$repo" worktree add -q "$tmp/feature" -b feature main
echo candidate >"$tmp/feature/candidate.txt"
git -C "$tmp/feature" add candidate.txt
git -C "$tmp/feature" commit -qm "candidate"

set +e
(cd "$repo" && scripts/land-branch.sh feature --gate 'test -f candidate.txt && exit 73') >/dev/null 2>&1
status=$?
set -e
if [ "$status" -eq 0 ] || [ "$(git -C "$repo" rev-parse HEAD)" != "$base" ]; then
  echo "FAIL: a red fast-forward candidate changed main" >&2
  exit 1
fi

set +e
(cd "$repo" && scripts/land-branch.sh feature --gate 'git commit --allow-empty -qm gate-created-commit') >/dev/null 2>&1
status=$?
set -e
if [ "$status" -eq 0 ] || [ "$(git -C "$repo" rev-parse HEAD)" != "$base" ]; then
  echo "FAIL: a gate-created commit escaped candidate identity checks" >&2
  exit 1
fi

(cd "$repo" && scripts/land-branch.sh feature --gate 'test -f candidate.txt && test -z "$(git branch --show-current)"') >/dev/null
feature_sha="$(git -C "$tmp/feature" rev-parse HEAD)"
if [ "$(git -C "$repo" rev-parse HEAD)" != "$feature_sha" ]; then
  echo "FAIL: green prospective candidate did not fast-forward main" >&2
  exit 1
fi

# Even non-overlapping dirt means the protected checkout is not a trustworthy
# landing surface. Preserve it elsewhere before any ref advancement.
echo unrelated-wip >"$repo/unrelated.tmp"
set +e
(cd "$repo" && scripts/land-branch.sh feature --gate 'exit 0') >/dev/null 2>&1
status=$?
set -e
rm -f "$repo/unrelated.tmp"
if [ "$status" -eq 0 ] || [ "$(git -C "$repo" rev-parse HEAD)" != "$feature_sha" ]; then
  echo "FAIL: dirty protected main was allowed to land" >&2
  exit 1
fi

# A contained/no-op source still validates current main; it is not a silent
# success path around a red gate.
set +e
(cd "$repo" && scripts/land-branch.sh feature --gate 'exit 74') >/dev/null 2>&1
status=$?
set -e
if [ "$status" -eq 0 ] || [ "$(git -C "$repo" rev-parse HEAD)" != "$feature_sha" ]; then
  echo "FAIL: contained branch skipped its gate or changed main" >&2
  exit 1
fi

# A (tree, gate) pair that already validated green is memoized: an identical
# duplicate submission skips revalidation, while any other gate string (see
# the red-gate case above) still runs, and POG_LANDING_GATE_MEMO=0 opts out.
memo_log="$tmp/memo-gate-runs"
memo_gate="echo run >>$memo_log && test -f candidate.txt"
(cd "$repo" && scripts/land-branch.sh feature --gate "$memo_gate") >/dev/null
(cd "$repo" && scripts/land-branch.sh feature --gate "$memo_gate") >/dev/null
if [ "$(grep -c run "$memo_log")" -ne 1 ]; then
  echo "FAIL: identical green gate was re-run for an unchanged tree (or never ran)" >&2
  exit 1
fi
set +e
(cd "$repo" && POG_LANDING_GATE_MEMO=0 scripts/land-branch.sh feature --gate "$memo_gate") >/dev/null 2>&1
memo_optout_status=$?
set -e
if [ "$memo_optout_status" -ne 0 ] || [ "$(grep -c run "$memo_log")" -ne 2 ]; then
  echo "FAIL: POG_LANDING_GATE_MEMO=0 did not force revalidation" >&2
  exit 1
fi

# The non-fast-forward path must gate the exact combined tree (new main plus
# the source delta), then land that same tree.
echo side >"$tmp/side/side.txt"
git -C "$tmp/side" add side.txt
git -C "$tmp/side" commit -qm "side"
(cd "$repo" && scripts/land-branch.sh side --gate 'test -f candidate.txt && test -f side.txt') >/dev/null
if [ ! -f "$repo/candidate.txt" ] || [ ! -f "$repo/side.txt" ]; then
  echo "FAIL: non-fast-forward landing did not preserve the prospective combined tree" >&2
  exit 1
fi

# Dirty primary WIP that overlaps a candidate is protected before Git can
# overwrite it. The ref and local bytes both remain unchanged.
git -C "$repo" worktree add -q "$tmp/overlap" -b overlap main
echo committed >"$tmp/overlap/overlap.txt"
git -C "$tmp/overlap" add overlap.txt
git -C "$tmp/overlap" commit -qm "overlap"
before_overlap="$(git -C "$repo" rev-parse HEAD)"
echo local-wip >"$repo/overlap.txt"
set +e
(cd "$repo" && scripts/land-branch.sh overlap --gate 'exit 0') >/dev/null 2>&1
status=$?
set -e
if [ "$status" -eq 0 ] || [ "$(git -C "$repo" rev-parse HEAD)" != "$before_overlap" ] || [ "$(cat "$repo/overlap.txt")" != "local-wip" ]; then
  echo "FAIL: overlapping primary WIP was not preserved" >&2
  exit 1
fi

echo "PASS: exact prospective tree gated; red/no-op/dirty main cannot advance"
