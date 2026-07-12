#!/usr/bin/env bash
# qa-feedback-privacy — deterministic gate for qa-feedback-privacy
# (verifies req-privacy-fail-closed + req-raw-drafts-stay-local).
# Runs the package's privacy QA suite: an unclassified field must block
# submit, and no sink/network call may happen before review. Fails (honest
# red) until packages/feedback-core and its QA suite exist (Stage 2.3).
set -eu
cd "$(dirname "$0")/../.."
exec node --test packages/feedback-core/test/qa-privacy.test.mjs
