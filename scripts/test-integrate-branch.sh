#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/scripts/integrate-branch.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
git init -q "$repo"
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.invalid
cd "$repo"
printf 'base\n' > README.md
git add README.md
git commit -qm base
git branch -M main
git worktree add -qb feature .worktrees/feature main
printf 'feature\n' > .worktrees/feature/README.md
git -C .worktrees/feature commit -am feature -q
printf 'main-wip\n' > README.md
mkdir -p scripts
cp "$script" scripts/integrate-branch.sh
chmod +x scripts/integrate-branch.sh
cat >"$tmp/resolve" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test -f "$SASSFULLY_INTEGRATE_PROMPT_FILE"
printf 'main-wip\nfeature\n' > README.md
git add README.md
EOF
chmod +x "$tmp/resolve"
scripts/integrate-branch.sh feature --gate true --auto-resolve --resolver-command "$tmp/resolve" --promote >"$tmp/out"
grep -q landed: "$tmp/out"
grep -q main-wip README.md
grep -q feature README.md
git branch --list 'recovery/main-before-*' | grep -q .
echo "integrate-branch tests passed"
