#!/usr/bin/env bash
# Red-team gate for the local agent-launch defense-in-depth layer.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root="$PWD"
hook="$root/.claude/hooks/block-bare-checkout.sh"
[ -x "$hook" ] || { echo "error: missing executable hook: $hook" >&2; exit 1; }

expect_blocked() {
  local name="$1" cwd="$2" command="$3" status
  set +e
  SASSFULLY_REPO_ROOT="$root" "$hook" <<EOF >/dev/null 2>&1
{"tool_name":"Bash","cwd":"$cwd","tool_input":{"command":"$command"}}
EOF
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "FAIL: $name was allowed" >&2
    return 1
  fi
  echo "blocked: $name"
}

expect_blocked "bare checkout in primary" "$root" "git checkout feature"
expect_blocked "direct commit to main" "$root" "git commit -m unsafe"
expect_blocked "agent launch from repo root" "$root" "codex exec -- work"
expect_blocked "sibling-repo write" "$root/../POG" "touch generated.txt"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/sassfully-launch-gate.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.capsules/workspaces/worker"
if SASSFULLY_REPO_ROOT="$root" "$hook" <<EOF >/dev/null 2>&1
{"tool_name":"Bash","cwd":"$tmp/.capsules/workspaces/worker","tool_input":{"command":"git status"}}
EOF
then
  echo "allowed: capsule workspace"
else
  echo "FAIL: capsule workspace was blocked" >&2
  exit 1
fi

echo "launch-policy-gate: green"
