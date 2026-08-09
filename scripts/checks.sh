#!/usr/bin/env bash
# checks.sh - sassfully's deterministic gate: exit 0 or the landing waits.
#
#   1. pog-doctor  — conventions lint (CI-safe: skips the hook check in CI)
#   2. tests       — every package with a package.json test script
#   3. graph lint  — pog/catalog.yaml validated by the kitsoki engine.
#   4. story flows — every stories/*/flows fixture replayed (no LLM, no network).
#
# Steps 3 and 4 both need a kitsoki binary. Resolution order (resolve_kitsoki):
#   a. $KITSOKI_BIN            — an explicitly pinned prebuilt binary
#   b. $POG_KITSOKI_SRC        — a kitsoki checkout to build from, cached in
#                                .artifacts/bin by that checkout's HEAD sha
#   c. `kitsoki` on PATH       — the ordinary installed binary
# In CI, where none of the three exist, both steps are SKIPPED LOUDLY — pinning
# a build for CI is its own tracked step (POG plan 1.4). Locally they are
# mandatory: a gate you cannot run is not a gate.
#
# No network, no live LLM — safe for CI.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

scripts/pog-doctor .

# Prepare all sibling file: links before testing. A package can depend on a
# sibling that itself has a sibling dependency, so setup must precede tests.
while IFS= read -r package; do
  if node -e 'const p=require("./" + process.argv[1]); process.exit(Object.values(p.dependencies || {}).some((v) => v.startsWith("file:")) ? 0 : 1)' "$package"; then
    dir="$(dirname "$package")"
    npm --prefix "$dir" install --ignore-scripts --no-audit --no-fund --package-lock=false
  fi
done < <(find packages -mindepth 2 -maxdepth 2 -name package.json -type f | sort)

while IFS= read -r package; do
  if node -e 'const p=require("./" + process.argv[1]); process.exit(p.scripts && p.scripts.test ? 0 : 1)' "$package"; then
    dir="$(dirname "$package")"
    echo "tests: $dir"
    npm --prefix "$dir" test
  fi
done < <(find packages -mindepth 2 -maxdepth 2 -name package.json -type f | sort)

# Sets $KITSOKI_RESOLVED to an absolute path to a usable kitsoki binary (empty
# if there is none) and $KITSOKI_RESOLVED_HOW to which tier answered. It assigns
# rather than prints on purpose: a $(...) call would run it in a subshell and
# throw the memo and the provenance away.
KITSOKI_RESOLVED=""
KITSOKI_RESOLVED_HOW=""
KITSOKI_RESOLVE_DONE=""
resolve_kitsoki() {
  [ -n "$KITSOKI_RESOLVE_DONE" ] && return 0
  KITSOKI_RESOLVE_DONE=1
  if [ -n "${KITSOKI_BIN:-}" ] && [ -x "${KITSOKI_BIN}" ]; then
    KITSOKI_RESOLVED="$KITSOKI_BIN"
    KITSOKI_RESOLVED_HOW="KITSOKI_BIN"
  else
    local src="${POG_KITSOKI_SRC:-$HOME/code/Kitsoki/.worktrees/project-object-graph}"
    if [ -d "$src" ]; then
      local sha bin
      sha="$(git -C "$src" rev-parse --short HEAD)"
      bin="$PWD/.artifacts/bin/kitsoki-$sha"
      if [ ! -x "$bin" ]; then
        mkdir -p .artifacts/bin
        echo "building kitsoki@$sha from $src ..." >&2
        (cd "$src" && go build -o "$bin" ./cmd/kitsoki)
      fi
      KITSOKI_RESOLVED="$bin"
      KITSOKI_RESOLVED_HOW="kitsoki@$sha"
    elif command -v kitsoki >/dev/null 2>&1; then
      KITSOKI_RESOLVED="$(command -v kitsoki)"
      KITSOKI_RESOLVED_HOW="kitsoki on PATH"
    fi
  fi
  return 0
}

in_ci() { [ "${CI:-}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]; }

lint_catalog() {
  resolve_kitsoki
  if [ -n "$KITSOKI_RESOLVED" ]; then
    "$KITSOKI_RESOLVED" graph lint pog/catalog.yaml
    echo "catalog: lint green ($KITSOKI_RESOLVED_HOW)"
    return 0
  fi
  if in_ci; then
    echo "catalog: LINT SKIPPED in CI — no kitsoki build available; CI pinning is POG plan 1.4"
    return 0
  fi
  echo "error: no kitsoki available to lint pog/catalog.yaml (set KITSOKI_BIN or POG_KITSOKI_SRC, or install kitsoki)" >&2
  return 1
}

# Replay every story's flow fixtures. These are deterministic: host calls are
# cassetted in the fixture and no model is called, so they are as much a unit
# test as anything under packages/. stories/land in particular is only worth
# having if its landing arcs are proven on every gate run.
check_story_flows() {
  local ran=0
  resolve_kitsoki
  if [ -z "$KITSOKI_RESOLVED" ]; then
    if in_ci; then
      echo "flows: SKIPPED in CI — no kitsoki build available; CI pinning is POG plan 1.4"
      return 0
    fi
    echo "error: no kitsoki available to replay story flows" >&2
    return 1
  fi
  while IFS= read -r flows_dir; do
    local app="${flows_dir%/flows}/app.yaml"
    [ -f "$app" ] || continue
    echo "flows: $app"
    "$KITSOKI_RESOLVED" test flows "$app"
    ran=$((ran + 1))
  done < <(find stories -name flows -type d | sort)
  echo "flows: $ran story app(s) replayed green ($KITSOKI_RESOLVED_HOW)"
}

if [ -f pog/catalog.yaml ]; then
  lint_catalog
fi

if [ -d stories ]; then
  check_story_flows
fi

echo "checks: green"
