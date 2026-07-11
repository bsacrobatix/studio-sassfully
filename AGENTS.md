# Agent conventions for sassfully

sassfully is a generic contextual-feedback framework (see README.md and
docs/concept.md). Apache-2.0, ConstructorFabric-bound: treat everything in
this repo as public from the moment it is committed — drafts and scratch work
belong in `.context/`, never in tracked files.

- **Catalog-first development.** Requirements, use cases, and acceptance
  criteria live in the typed object graph (`pog/catalog.yaml`, seeded from
  docs/ — coming with plan step 0.5); code changes trace back to catalog
  nodes. Don't grow features in README prose.
- **Privacy is a requirement, not a patch.** Feedback capture may touch user
  PII and replays; capture is opt-in, PII stripping is the default, and the
  privacy requirements get catalog nodes with acceptance criteria *before*
  any capture code exists.
- **Feedback ≠ mutation.** The reviewed note is the artifact; anything that
  changes a host system is a downstream outcome. Keep the boundary in every
  design.

<!-- pack:conventions:begin — managed by the pog conventions pack installer; edits inside this block are overwritten on reinstall -->
## Repo conventions (studio-sassfully)

- **Protected main.** The primary checkout stays on `main` at its tip — a
  `reference-transaction` git hook blocks branch switches and off-tip detaches
  here. All implementation work happens in branch worktrees:
  `git worktree add .worktrees/<name> -b <branch> main`.
- **Landing path.** Land a branch with `scripts/merge-to-main.sh <branch>`
  (fast-forward only), or `scripts/land-branch.sh <branch> [--gate "<cmd>"]`
  when main has advanced. No direct-to-main commits, including docs.
- **Private-by-default folders** (all gitignored, never committed):
  `.context/` transient working markdown, `.artifacts/` generated review and
  build output, `.worktrees/` branch worktrees.
- **Validation:** `scripts/checks.sh` must exit 0 before landing.
- **Testing rule:** no live LLM calls in tests or CI — cassettes, flows, and
  mocks only.
- **Doctor:** `scripts/pog-doctor` lints these conventions deterministically
  (CI-safe: skips the hook check in CI checkouts); keep it green.
<!-- pack:conventions:end -->
