#!/usr/bin/env bash
# checks.sh - sassfully's deterministic gate: exit 0 or the landing waits.
#
#   1. pog-doctor  — conventions lint (CI-safe: skips the hook check in CI)
#   2. tests       — every package with a package.json test script
#   3. graph lint  — pog/catalog.yaml validated by the kitsoki engine.
#      Resolution order: $KITSOKI_BIN (prebuilt binary), else build from
#      $POG_KITSOKI_SRC (a kitsoki checkout with the object-graph engine;
#      binary cached in .artifacts/bin by source HEAD sha). In CI, where no
#      kitsoki source is available yet, the lint is SKIPPED loudly — pinning
#      a build for CI is its own tracked step (POG plan 1.4); locally the
#      lint is mandatory.
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

lint_catalog() {
  if [ -n "${KITSOKI_BIN:-}" ] && [ -x "${KITSOKI_BIN}" ]; then
    "$KITSOKI_BIN" graph lint pog/catalog.yaml
    echo "catalog: lint green (KITSOKI_BIN)"
    return 0
  fi
  local src="${POG_KITSOKI_SRC:-$HOME/code/Kitsoki/.worktrees/project-object-graph}"
  if [ -d "$src" ]; then
    local sha bin
    sha="$(git -C "$src" rev-parse --short HEAD)"
    bin="$PWD/.artifacts/bin/kitsoki-$sha"
    if [ ! -x "$bin" ]; then
      mkdir -p .artifacts/bin
      echo "building kitsoki@$sha from $src ..."
      (cd "$src" && go build -o "$bin" ./cmd/kitsoki)
    fi
    "$bin" graph lint pog/catalog.yaml
    echo "catalog: lint green (kitsoki@$sha)"
    return 0
  fi
  if [ "${CI:-}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "catalog: LINT SKIPPED in CI — no kitsoki build available; CI pinning is POG plan 1.4"
    return 0
  fi
  echo "error: no kitsoki available to lint pog/catalog.yaml (set KITSOKI_BIN or POG_KITSOKI_SRC)" >&2
  return 1
}

if [ -f pog/catalog.yaml ]; then
  lint_catalog
fi

echo "checks: green"
