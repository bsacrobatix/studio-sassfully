#!/usr/bin/env bash
# Refuse unsafe Claude Code Bash calls before they reach the shell.
set -euo pipefail

payload="$(cat)"
decision="$(HOOK_PAYLOAD="$payload" python3 - <<'PY'
import json
import os
import pathlib
import shlex
import sys

try:
    payload = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    print("deny\tmalformed hook input")
    raise SystemExit(0)

if payload.get("tool_name", "Bash") not in ("Bash", "bash"):
    print("allow\tnon-Bash tool")
    raise SystemExit(0)

tool_input = payload.get("tool_input") or {}
command = str(tool_input.get("command") or "")
cwd = pathlib.Path(str(payload.get("cwd") or os.getcwd())).expanduser().resolve()
repo = pathlib.Path(os.environ.get("SASSFULLY_REPO_ROOT", os.getcwd())).resolve()
siblings = [repo.parent / name for name in ("Kitsoki", "POG", "slidey")]
allowed_workspace = repo / ".capsules" / "workspaces"

def in_root(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False

in_primary = cwd == repo and not in_root(cwd, allowed_workspace)
in_sibling = any(in_root(cwd, root) for root in siblings)
try:
    words = shlex.split(command)
except ValueError:
    words = command.split()

agent_launch = (
    any(word in {"claude", "codex", "agy", "copilot"} for word in words)
    or ("kitsoki" in words and "launch" in words)
)
git_checkout = any(words[i:i + 2] in (["git", "checkout"], ["git", "switch"])
                   for i in range(len(words) - 1))
git_commit = any(words[i:i + 2] == ["git", "commit"]
                 for i in range(len(words) - 1))
mutating = bool({"commit", "push", "write", "mv", "rm", "cp", "install", "touch"} & set(words))

if in_primary and (agent_launch or git_checkout or git_commit):
    print("deny\tprotected primary checkout: use a capsule/worktree")
elif in_sibling and mutating:
    print("deny\tsibling repository is protected: propose the requirement in its catalog")
elif any(str(root) in command for root in siblings) and mutating:
    print("deny\tsibling repository write detected")
else:
    print("allow\tcommand permitted")
PY
)"

status="${decision%%$'\t'*}"
reason="${decision#*$'\t'}"
if [ "$status" = "deny" ]; then
  echo "Blocked by studio-sassfully launch policy: $reason" >&2
  exit 2
fi
exit 0
