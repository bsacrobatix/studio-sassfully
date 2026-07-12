#!/usr/bin/env bash
# record-unit-evidence.sh — run packages/feedback-core's unit suite
# (node --test) and drop a flow-evidence-shaped envelope under pog/evidence/
# for ts-feedback-core-unit's flows_recorded.star gate. Same honesty contract
# as record-flow-evidence.sh: evidence is written even when the run fails
# (exit != 0, report: null) — including the pre-code state where
# packages/feedback-core does not exist yet (Stage 2.3 builds it), so the
# gate always judges recorded reality, never absence.
set -u

cd "$(dirname "$0")/.."
mkdir -p pog/evidence

out="pog/evidence/feedback-core-unit.json"
tap="pog/evidence/feedback-core-unit.tap"
cmd="node --test --test-reporter=tap packages/feedback-core/test/*.test.mjs"

echo "recording feedback-core unit suite: ${cmd}"
if [ -d packages/feedback-core/test ]; then
  node --test --test-reporter=tap packages/feedback-core/test/*.test.mjs >"${tap}" 2>"pog/evidence/feedback-core-unit.log"
  exit_code=$?
else
  echo "packages/feedback-core/test does not exist (pre-code; Stage 2.3 builds it)" >"pog/evidence/feedback-core-unit.log"
  : >"${tap}"
  exit_code=2
fi

commit="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

report=null
if [ -s "${tap}" ]; then
  passed="$(grep -c '^ok ' "${tap}" || true)"
  failed="$(grep -c '^not ok ' "${tap}" || true)"
  report="{\"Passed\": ${passed:-0}, \"Failed\": ${failed:-0}}"
fi

cat >"${out}" <<EOF
{
  "schema": "pog/evidence-flow-run/v0",
  "repo": "studio-sassfully",
  "app": "packages/feedback-core",
  "command": "${cmd}",
  "exit": ${exit_code},
  "recorded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "repo_commit": "${commit}",
  "report": ${report}
}
EOF
echo "  -> ${out} (exit ${exit_code})"
