#!/usr/bin/env bash
# checks.sh - sassfully's deterministic gate: exit 0 or the landing waits.
#
#   1. pog-doctor  — conventions lint (CI-safe: skips the hook check in CI)
#   2. tests       — empty suite today, green by definition; real tests hang
#                    off this hook as feedback-core lands
#   3. (coming with the seed catalog) `kitsoki graph lint pog/catalog.yaml`
#
# No network, no live LLM — safe for CI.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

scripts/pog-doctor .

echo "tests: empty suite (no code yet) — green"

if [ -f pog/catalog.yaml ]; then
  echo "error: pog/catalog.yaml exists but checks.sh doesn't lint it yet — wire the graph lint step" >&2
  exit 1
fi

echo "checks: green"
