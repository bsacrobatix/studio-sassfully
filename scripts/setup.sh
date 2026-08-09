#!/usr/bin/env bash
# setup.sh - one-time (re-runnable) local clone setup.
#
# Everything here is about MERGING, because this repo lands ~20 parallel branch
# worktrees onto one remote target and conflict handling is the bottleneck:
#
#   1. mergiraf   - the syntax-aware merge driver .gitattributes names. The
#                   `merge=mergiraf` attributes in .gitattributes are INERT
#                   without both the binary and the git config written here;
#                   git silently falls back to its line merge and says nothing.
#   2. rerere     - record a conflict resolution once, replay it on every later
#                   rebase of the same hunk. `stories/conflict-resolve` depends
#                   on this: its whole value is that a resolution is learned.
#   3. zdiff3     - conflict markers that include the merge base, so a human
#                   (or an LLM resolver) can see what each side changed.
#   4. autostash  - never lose a dirty tree to a rebase.
#
# It does NOT install node/npm or the kitsoki binary — see README.md — and it
# does not touch the main-protection hook, which the conventions pack owns.
#
# Run via `make setup`. Safe to run repeatedly.
set -euo pipefail

MERGIRAF_VERSION=0.18.0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- mergiraf ---------------------------------------------------------------
# Not packaged by apt or dnf, so on Linux we fetch the upstream prebuilt binary.
# The musl build is static and runs on any glibc vintage. A failure here is a
# warning, not an error: without mergiraf git falls back to its line merge,
# which is exactly the behaviour this repo had before .gitattributes existed.
install_mergiraf() {
	if have mergiraf; then
		log "mergiraf $(mergiraf --version 2>/dev/null | awk '{print $2}') OK"
		return
	fi
	log "installing mergiraf $MERGIRAF_VERSION"
	if have brew; then
		brew install mergiraf || warn "mergiraf not installed; merges fall back to git's line merge"
		return
	fi
	local arch target url tmp
	case "$(uname -m)" in
		x86_64|amd64)  arch=x86_64 ;;
		aarch64|arm64) arch=aarch64 ;;
		*) warn "no mergiraf build for $(uname -m); merges fall back to git's line merge"; return ;;
	esac
	case "$(uname -s)" in
		Darwin) target="${arch}-apple-darwin" ;;
		*)      target="${arch}-unknown-linux-musl" ;;
	esac
	url="https://codeberg.org/mergiraf/mergiraf/releases/download/v${MERGIRAF_VERSION}/mergiraf_${target}.tar.gz"
	tmp="$(mktemp -d)"
	if curl -fsSL "$url" -o "$tmp/mergiraf.tar.gz" \
		&& tar -C "$tmp" -xzf "$tmp/mergiraf.tar.gz" \
		&& [ -f "$tmp/mergiraf" ] \
		&& install -m 0755 "$tmp/mergiraf" /usr/local/bin/mergiraf; then
		log "installed mergiraf to /usr/local/bin/mergiraf"
	else
		warn "could not install mergiraf from $url; merges fall back to git's line merge"
	fi
	rm -rf "$tmp"
}

# --- git config -------------------------------------------------------------
# Written into the common .git/config, so every .worktrees/<name> linked
# worktree inherits it too.
configure_git() {
	git -C "$ROOT" config rerere.enabled true
	git -C "$ROOT" config rerere.autoupdate true
	git -C "$ROOT" config merge.conflictStyle zdiff3
	git -C "$ROOT" config rebase.autostash true
	if have mergiraf; then
		git -C "$ROOT" config merge.mergiraf.name "mergiraf: syntax-aware merge"
		git -C "$ROOT" config merge.mergiraf.driver \
			'mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L'
		log "configured git (rerere + autoupdate, zdiff3, rebase.autostash, merge.mergiraf)"
	else
		warn "mergiraf not on PATH; .gitattributes merge=mergiraf rules fall back to git's line merge"
		log "configured git (rerere + autoupdate, zdiff3, rebase.autostash)"
	fi
}

main() {
	install_mergiraf
	configure_git
	echo
	echo "Verify the driver is live:"
	echo "  git check-attr merge -- packages/feedback-core/src/index.mjs   # -> mergiraf"
	echo "  git config merge.mergiraf.driver                               # -> mergiraf merge --git ..."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	main "$@"
fi
