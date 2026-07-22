#!/usr/bin/env bash
# PreToolUse(Bash) guard: keep the MAIN checkout pinned to its current branch.
#
# Goal: this folder (the primary worktree) must always be the default branch at its
# tip. An agent must never switch it onto a feature branch OR detach it onto an old
# commit / tag via `git checkout` / `git switch`. That work belongs in a linked
# worktree under .worktrees/. Linked worktrees (where .git is a file, not a directory)
# are exempt — switching branches there is the point.
#
# Emits a PreToolUse "deny" decision with a remediation message when it catches a
# branch-changing OR detaching checkout/switch aimed at the main checkout. Everything
# else (file-restoring `git checkout -- path` / `git checkout <commit> <path>`,
# checkouts inside .worktrees/, non-git commands) is allowed through untouched.
#
# This is the agent-facing layer; the git-enforced companion (scripts/git-hooks/
# reference-transaction, installed by `make setup`) catches the same thing from a
# human terminal too.
#
# POG-local fix (2026-07-13, not yet upstream in Kitsoki -- filed as a bug
# node in Kitsoki's federated catalog): the origin/HEAD lookup below is
# wrapped in `|| true`, matching every other fragile git call in this file.
# Kitsoki's source is missing that guard on this one line; it never surfaces
# there because that repo always has an origin/HEAD symref. POG has no remote
# at all, so the unguarded pipeline failed under `set -e`+`pipefail` and made
# the whole hook silently no-op (allow everything) -- caught by
# scripts/launch-policy-gate.sh check (a).

set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
[ -z "$cmd" ] && exit 0

# Fast path: nothing to do unless the command mentions a checkout/switch.
case "$cmd" in
  *"git checkout"*|*"git switch"*|*"git -C"*"checkout"*|*"git -C"*"switch"*) ;;
  *) exit 0 ;;
esac

allow() { exit 0; }

deny() {
  local reason="$1"
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# Resolve the directory the git command effectively runs in:
#   - a leading `cd <dir> &&|;` prefix
#   - a `git -C <dir>` flag
# Fall back to the hook's cwd.
target_dir="$PWD"
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;]+) ]]; then
  cd_arg="${BASH_REMATCH[1]}"
  cd_arg="${cd_arg%\"}"; cd_arg="${cd_arg#\"}"
  cd_arg="${cd_arg%\'}"; cd_arg="${cd_arg#\'}"
  case "$cd_arg" in
    /*) target_dir="$cd_arg" ;;
    *)  target_dir="$PWD/$cd_arg" ;;
  esac
fi
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_arg="${BASH_REMATCH[1]}"
  c_arg="${c_arg%\"}"; c_arg="${c_arg#\"}"
  case "$c_arg" in
    /*) target_dir="$c_arg" ;;
    *)  target_dir="$target_dir/$c_arg" ;;
  esac
fi

# Anything explicitly under .worktrees/ is an allowed branch playground.
case "$target_dir" in
  *"/.worktrees/"*|*"/.worktrees") allow ;;
esac

# Find the repo root for target_dir; bail open if it isn't a git dir.
toplevel="$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$toplevel" ] && allow

# Linked worktrees have a .git FILE; the primary checkout has a .git DIRECTORY.
# Only the primary checkout is pinned.
[ -f "$toplevel/.git" ] && allow
[ -d "$toplevel/.git" ] || allow

# Isolate the git subcommand + its args (strip a leading cd ... && / ; prefix and
# any leading `git -C <dir>`).
gitpart="$cmd"
gitpart="${gitpart##*&&}"
gitpart="${gitpart##*;}"
# drop everything up to and including the first 'git'
gitpart="git${gitpart#*git}"

# Tokenize.
read -r -a tok <<< "$gitpart"
# Walk to the subcommand, skipping `git`, `-C <dir>`, and other top-level flags.
sub=""; i=0
while [ "$i" -lt "${#tok[@]}" ]; do
  t="${tok[$i]}"
  case "$t" in
    git) ;;
    -C) i=$((i+1)) ;;          # skip its arg too
    -c) i=$((i+1)) ;;          # `git -c key=val`
    -*) ;;                     # other global flags
    checkout|switch) sub="$t"; break ;;
    *) break ;;
  esac
  i=$((i+1))
done
[ -z "$sub" ] && allow

# Remaining args after the subcommand.
args=("${tok[@]:$((i+1))}")

# The default branch this checkout is allowed to sit on. Prefer origin/HEAD;
# fall back to whichever of main/master exists, then to "main".
default_branch="$(git -C "$toplevel" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || true)"
if [ -z "$default_branch" ]; then
  if git -C "$toplevel" show-ref --verify --quiet refs/heads/main 2>/dev/null; then
    default_branch="main"
  elif git -C "$toplevel" show-ref --verify --quiet refs/heads/master 2>/dev/null; then
    default_branch="master"
  else
    default_branch="main"
  fi
fi

remedy="The main checkout '$toplevel' may only sit on '$default_branch'. Do branch work in a worktree instead, e.g.:  git worktree add .worktrees/<branch> -b <branch>  (then run there). Linked worktrees under .worktrees/ are exempt from this guard."

if [ "$sub" = "switch" ]; then
  # `git switch -c/-C <name>` creates a branch here → always blocked.
  for a in "${args[@]}"; do
    case "$a" in
      -c|-C|--orphan)
        deny "Blocked '$sub $a' (creates a branch here). $remedy" ;;
    esac
  done
  # `git switch <name>`: allow only if the target is the default branch.
  for a in "${args[@]}"; do
    case "$a" in
      -*) ;;
      "$default_branch") allow ;;
      *) deny "Blocked '$sub $a' (switches the main checkout off '$default_branch'). $remedy" ;;
    esac
  done
  # Bare `git switch` with no target (e.g. `git switch -`) → block.
  deny "Blocked '$sub' on the main checkout. $remedy"
fi

# checkout: distinguish branch-changing / detaching forms from file-restoring ones.
# Collect every positional (not just the first) so `git checkout <commit> <path>`
# (a file restore) is told apart from a bare `git checkout <commit>` (a detach).
saw_dashdash=0
positionals=()
for a in "${args[@]}"; do
  case "$a" in
    --) saw_dashdash=1; break ;;
    -b|-B|--orphan)
      deny "Blocked '$sub $a' (creates a branch here). $remedy" ;;
    -*) ;;                     # other flags: --quiet, --detach, etc.
    *) positionals+=("$a") ;;
  esac
done

# A `--` means everything after is a pathspec → file restore, allow.
[ "$saw_dashdash" -eq 1 ] && allow
[ "${#positionals[@]}" -eq 0 ] && allow
first="${positionals[0]}"

# Switching to the default branch is exactly what we want — allow it.
[ "$first" = "$default_branch" ] && allow

# If the positional names an existing local or remote branch, it's a branch switch.
if git -C "$toplevel" show-ref --verify --quiet "refs/heads/$first" 2>/dev/null \
   || git -C "$toplevel" show-ref --verify --quiet "refs/remotes/$first" 2>/dev/null \
   || git -C "$toplevel" show-ref --verify --quiet "refs/remotes/origin/$first" 2>/dev/null; then
  deny "Blocked '$sub $first' (switches the main checkout off '$default_branch'). $remedy"
fi

# More than one positional → `git checkout <commit-ish> <pathspec...>` → file restore, allow.
[ "${#positionals[@]}" -gt 1 ] && allow

# A lone positional that resolves to a commit is a DETACHED checkout (old commit, tag,
# sha) — this checkout must stay on the tip of '$default_branch', so block it. The one
# exception (parity with the git-layer guard): detaching exactly at main's tip is still
# "main at its tip", so allow it.
first_oid="$(git -C "$toplevel" rev-parse --verify --quiet "${first}^{commit}" 2>/dev/null || true)"
if [ -n "$first_oid" ]; then
  main_tip="$(git -C "$toplevel" rev-parse --verify --quiet "refs/heads/$default_branch" 2>/dev/null || true)"
  if [ -z "$main_tip" ] || [ "$first_oid" != "$main_tip" ]; then
    deny "Blocked '$sub $first' (detaches the main checkout off the tip of '$default_branch'). $remedy"
  fi
fi

# Otherwise it's a pathspec (a filename) → file restore — allow.
allow
