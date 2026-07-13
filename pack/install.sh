#!/usr/bin/env bash
# Install the tracked gitflow defense-in-depth layers into a checkout.
set -euo pipefail
pack_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="$(cd "${1:?usage: pack/install.sh <checkout>}" && pwd)"
git -C "$target" rev-parse --is-inside-work-tree >/dev/null
hooks_dir="$(git -C "$target" rev-parse --git-path hooks)"
mkdir -p "$target/.claude/hooks" "$hooks_dir"
if ! cmp -s "$pack_dir/git-hooks/reference-transaction" "$hooks_dir/reference-transaction"; then
  cp "$pack_dir/git-hooks/reference-transaction" "$hooks_dir/reference-transaction"
fi
guard="$pack_dir/../.claude/hooks/block-bare-checkout.sh"
if ! cmp -s "$guard" "$target/.claude/hooks/block-bare-checkout.sh"; then
  cp "$guard" "$target/.claude/hooks/block-bare-checkout.sh"
fi
chmod +x "$hooks_dir/reference-transaction" "$target/.claude/hooks/block-bare-checkout.sh"
echo "install: reference-transaction hook and Claude guard are installed"
