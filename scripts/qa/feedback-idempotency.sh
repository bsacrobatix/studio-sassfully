#!/usr/bin/env bash
# qa-feedback-idempotency — deterministic gate for qa-feedback-idempotency
# (verifies req-idempotent-submission). Runs the package's idempotency QA
# suite: submitting the same reviewed bundle twice must yield one sink item
# keyed by the bundle's idempotency key. Fails (honest red) until
# packages/feedback-core and its QA suite exist (Stage 2.3).
set -eu
cd "$(dirname "$0")/../.."
exec node --test packages/feedback-core/test/qa-idempotency.test.mjs
