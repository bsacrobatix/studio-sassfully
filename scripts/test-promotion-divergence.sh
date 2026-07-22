#!/usr/bin/env bash
# Regression coverage for the stale-head admission defect: when capsule
# control's recorded workspace head (only advanced by
# `kitsoki capsule workspace commit`) diverges from the live branch tip,
# scripts/promote-to-main.sh must refuse to promote BEFORE spending any
# Capsule CI or admitting anything -- Kitsoki exposes no way to pin Capsule CI
# or `capsule promote --current` to an arbitrary SHA, so there is no POG-side
# self-heal for the stale head itself (that refresh/rebind primitive is a
# known upstream Kitsoki gap). The one path that remains safe while diverged
# is reusing an already-passing receipt bound to the exact live SHA, since
# that match never consults the recorded head. This also covers that an
# admitted candidate whose SHA is not actually published in the source
# repository is refused loudly. Uses only throwaway local repositories and a
# fake `kitsoki` stand-in; never launches a provider or touches the caller's
# refs.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

new_fixture() {
  local name="$1"
  source_repo="$tmp/$name/source"
  capsule="$source_repo/.capsules/workspaces/$name"
  mkdir -p "$source_repo/scripts" "$source_repo/.capsules/ci"
  git init -q -b main "$source_repo"
  git -C "$source_repo" config user.name "POG divergence test"
  git -C "$source_repo" config user.email "divergence-test@example.invalid"
  cp "$script_dir/merge-to-main.sh" "$source_repo/scripts/merge-to-main.sh"
  cp "$script_dir/land-branch.sh" "$source_repo/scripts/land-branch.sh"
  cp "$script_dir/promote-to-main.sh" "$source_repo/scripts/promote-to-main.sh"
  cp "$script_dir/mark-promotion-emergency.sh" "$source_repo/scripts/mark-promotion-emergency.sh"
  cp "$script_dir/process-promotion-queue.sh" "$source_repo/scripts/process-promotion-queue.sh"
  chmod +x "$source_repo/scripts/"*.sh
  printf '.artifacts/\n.capsules/\n.worktrees/\n.kitsoki-dev-workspace.json\n' >"$source_repo/.gitignore"
  printf 'base\n' >"$source_repo/shared.txt"
  git -C "$source_repo" add -A
  git -C "$source_repo" commit -qm "base"
  base_sha="$(git -C "$source_repo" rev-parse HEAD)"

  mkdir -p "$(dirname "$capsule")"
  git clone -q --no-local "$source_repo" "$capsule"
  git -C "$capsule" remote rename origin source
  git -C "$capsule" config user.name "POG divergence test"
  git -C "$capsule" config user.email "divergence-test@example.invalid"
  git -C "$capsule" switch -q -c "agent/$name" source/main
  cat >"$capsule/.kitsoki-dev-workspace.json" <<EOF
{
  "base": "main",
  "branch": "agent/$name",
  "id": "$name",
  "source": "$source_repo",
  "target": "main",
  "workspace": "$capsule"
}
EOF
}

# A fake kitsoki whose capsule-control head is whatever POG_TEST_STALE_HEAD
# says, so the promote path sees the same divergence a rebase produces. Any
# `capsule ci` or `capsule promote` call is a test failure by construction:
# both would gate and admit the recorded head rather than the live candidate,
# which is the whole defect. `queue submit` is the one SHA-exact seam.
write_fake_kitsoki() {
  mkdir -p "$1"
  cat >"$1/kitsoki" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$POG_TEST_KITSOKI_LOG"
if [ "${1:-}" = "capsule" ] && [ "${2:-}" = "workspace" ] && [ "${3:-}" = "status" ]; then
  printf '{"head":"%s"}\n' "$POG_TEST_STALE_HEAD"
  exit 0
fi
if [ "${1:-}" = "queue" ] && [ "${2:-}" = "submit" ]; then
  printf '{"id":"div-test","status":"queued","sha":"%s","receipt_id":"sha256:divergence-reused"}\n' "$POG_TEST_CANDIDATE_SHA"
  exit 0
fi
echo "unexpected kitsoki invocation: $*" >&2
exit 90
EOF
  chmod +x "$1/kitsoki"
}

# --- Divergence with no SHA-exact receipt -> refuse BEFORE spending any
# Capsule CI, and never admit anything. POG cannot mint a receipt for an
# arbitrary SHA (`capsule ci run change` has no candidate flag) and cannot
# advance the recorded head, so failing loudly is the honest outcome.
new_fixture divergence-refuses
printf 'candidate\n' >"$capsule/candidate.txt"
git -C "$capsule" add candidate.txt
git -C "$capsule" commit -qm "candidate"
candidate_sha="$(git -C "$capsule" rev-parse HEAD)"

fake_bin="$tmp/fake-bin-divergence"
write_fake_kitsoki "$fake_bin"

status=0
(cd "$capsule" && \
  POG_TEST_KITSOKI_LOG="$tmp/divergence.log" \
  POG_TEST_STALE_HEAD="$base_sha" \
  POG_TEST_CANDIDATE_SHA="$candidate_sha" \
  PATH="$fake_bin:$PATH" \
  POG_PROMOTION_NO_AUTOSTART=1 \
  scripts/promote-to-main.sh) >"$tmp/divergence.out" 2>"$tmp/divergence.err" || status=$?

[ "$status" -ne 0 ] || fail "promote-to-main.sh exited 0 despite a stale capsule-control head"
grep -q -- 'recorded head is stale' "$tmp/divergence.err" || fail "the stale recorded head was not reported"
grep -q -- "$candidate_sha" "$tmp/divergence.err" || fail "the refusal did not name the live candidate SHA"
grep -q -- "$base_sha" "$tmp/divergence.err" || fail "the refusal did not name the stale capsule-control head"
grep -q -- 'kitsoki capsule workspace commit' "$tmp/divergence.err" || fail "the refusal did not name the reconcile remedy"
if grep -q -- 'capsule ci' "$tmp/divergence.log"; then
  fail "Capsule CI was spent while the recorded head was stale; it would have gated the wrong tree"
fi
if grep -q -- 'capsule promote' "$tmp/divergence.log"; then
  fail "fell back to 'capsule promote --current', which would have admitted the stale recorded head"
fi
if grep -q -- 'queue submit' "$tmp/divergence.log"; then
  fail "a candidate was admitted to the durable queue despite the stale recorded head"
fi
[ "$(git -C "$source_repo" rev-parse main)" = "$base_sha" ] || fail "a refused promotion moved protected main"
git -C "$source_repo" rev-parse --verify "refs/heads/promotion/capsule-divergence-refuses/$candidate_sha" >/dev/null \
  || fail "a refused promotion did not retain the immutable published candidate"

# --- Divergence BUT a passing receipt already bound to the exact live SHA ->
# admission still proceeds. That reuse path matches on
# envelope.source_digest and submits that SHA directly, so it never consults
# the recorded head and stays correct while diverged.
new_fixture divergence-reuses-exact-receipt
printf 'candidate\n' >"$capsule/candidate.txt"
git -C "$capsule" add candidate.txt
git -C "$capsule" commit -qm "candidate"
candidate_sha="$(git -C "$capsule" rev-parse HEAD)"

fake_bin="$tmp/fake-bin-reuse"
write_fake_kitsoki "$fake_bin"

mkdir -p "$source_repo/.capsules/ci"
printf '{"schema":"capsule-ci-receipt/v1","receipt_id":"sha256:divergence-reused","envelope":{"source_digest":"%s"},"verdict":{"outcome":"passed","promotion_eligible":true}}\n' \
  "$candidate_sha" >"$source_repo/.capsules/ci/exact.receipt.json"

status=0
(cd "$capsule" && \
  POG_TEST_KITSOKI_LOG="$tmp/reuse.log" \
  POG_TEST_STALE_HEAD="$base_sha" \
  POG_TEST_CANDIDATE_SHA="$candidate_sha" \
  PATH="$fake_bin:$PATH" \
  POG_PROMOTION_NO_AUTOSTART=1 \
  scripts/promote-to-main.sh) >"$tmp/reuse.out" 2>"$tmp/reuse.err" || status=$?

[ "$status" -eq 0 ] || fail "a SHA-exact passing receipt was not admitted while diverged (exit $status): $(cat "$tmp/reuse.err")"
grep -q -- 'queue submit' "$tmp/reuse.log" || fail "the SHA-exact receipt was not submitted directly"
if grep -q -- 'capsule promote' "$tmp/reuse.log"; then
  fail "reuse path fell back to 'capsule promote --current'"
fi
[ "$(git -C "$source_repo" rev-parse main)" = "$base_sha" ] || fail "receipt reuse moved protected main"

# --- An admitted candidate whose SHA is not actually published in the source
# repository must be refused loudly, never left queued behind an unresolvable
# ref (the exact failure mode that wedged the FIFO in report 01KXNX5Y445).
new_fixture unpublished-refusal
printf 'candidate\n' >"$capsule/candidate.txt"
git -C "$capsule" add candidate.txt
git -C "$capsule" commit -qm "candidate"
candidate_sha="$(git -C "$capsule" rev-parse HEAD)"
unpublished_sha="0123456789abcdef0123456789abcdef01234567"

fake_bin="$tmp/fake-bin-unpublished"
mkdir -p "$fake_bin"
cat >"$fake_bin/kitsoki" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$POG_TEST_KITSOKI_LOG"
if [ "${1:-}" = "capsule" ] && [ "${2:-}" = "workspace" ] && [ "${3:-}" = "status" ]; then
  # Heads agree here: the bug this guards is Kitsoki's own admission
  # returning a candidate_sha that was never pushed, independent of the
  # stale-head divergence path above.
  printf '{"head":"%s"}\n' "$POG_TEST_CANDIDATE_SHA"
  exit 0
fi
if [ "${1:-}" = "capsule" ] && [ "${2:-}" = "promote" ]; then
  printf '{"schema":"capsule-promote/v1","status":"queued","candidate_sha":"%s","receipt_id":"sha256:unpublished","queue_candidate":{"id":"unpub-test","status":"queued"}}\n' "$POG_TEST_UNPUBLISHED_SHA"
  exit 0
fi
echo "unexpected kitsoki invocation: $*" >&2
exit 90
EOF
chmod +x "$fake_bin/kitsoki"

set +e
(cd "$capsule" && \
  POG_TEST_KITSOKI_LOG="$tmp/unpublished.log" \
  POG_TEST_CANDIDATE_SHA="$candidate_sha" \
  POG_TEST_UNPUBLISHED_SHA="$unpublished_sha" \
  PATH="$fake_bin:$PATH" \
  POG_PROMOTION_NO_AUTOSTART=1 \
  scripts/promote-to-main.sh) >"$tmp/unpublished.out" 2>"$tmp/unpublished.err"
status=$?
set -e
[ "$status" -ne 0 ] || fail "admission of an unpublished candidate SHA unexpectedly succeeded"
grep -q -- 'is not published in the source repository' "$tmp/unpublished.err" || fail "unpublished-SHA admission was not refused with an actionable message"
[ "$(git -C "$source_repo" rev-parse main)" = "$base_sha" ] || fail "unpublished-SHA refusal still moved protected main"
git -C "$source_repo" rev-parse --verify "refs/heads/promotion/capsule-unpublished-refusal/$candidate_sha" >/dev/null || fail "unpublished-SHA refusal lost the immutable live candidate"
if git -C "$source_repo" cat-file -e "$unpublished_sha^{commit}" 2>/dev/null; then
  fail "test fixture error: the unpublished SHA must not actually resolve in the source repository"
fi

echo "PASS: promotion refuses a stale capsule-control head before spending CI, still admits a SHA-exact receipt while diverged, and refuses unpublished candidate SHAs"
