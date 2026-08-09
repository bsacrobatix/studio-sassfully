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
- **Landing is fast-forward onto `staging/local`.** `main` trails it by dozens
  of commits; it is not the integration branch. An agent finishing work in a
  branch worktree lands with `stories/land` (`kitsoki run
  stories/land/app.yaml`, then `land`) — fetch → rebase onto
  `origin/staging/local` → `scripts/checks.sh` on the *rebased* sha → refspec
  push, with an optimistic retry on a lost race and a PR escalation for
  conflicts the headless resolver can't settle. The loop is imported from
  `@kitsoki/land`, not copied; read `stories/land/README.md` before changing it,
  especially "Known gaps". `scripts/land-branch.sh` remains the hand-driven
  path. Run `make setup` once per clone so the `.gitattributes` mergiraf merge
  driver and rerere are actually configured — without it those rules are inert.

<!-- pack:conventions:begin — managed by the pog conventions pack installer; edits inside this block are overwritten on reinstall -->
## Repo conventions (studio-sassfully)

- **Protected main.** The primary checkout stays on `main` at its tip — a
  `reference-transaction` git hook blocks branch switches and off-tip detaches
  here. All implementation work happens in branch worktrees:
  `git worktree add .worktrees/<name> -b <branch> main`.
- **Agent-layer guard.** `.claude/hooks/block-bare-checkout.sh`, wired via
  `.claude/settings.json` `PreToolUse` on the `Bash` matcher, blocks the same
  bare `git checkout`/`git switch` off `main` from an agent's tool calls —
  the companion to `reference-transaction` for the Claude Code agent layer.
- **Capsule creation:** use `codex superagent` or `kitsoki capsule workspace
  create-script --project <repo> --id <id> --owner <owner> --json`. Do not use
  short-form `scripts/dev-workspace.sh create`; it is blocked because it
  creates a legacy clone without the Capsule-control identity required by
  Capsule CI and promotion.
- **Promotion path.** From a managed Capsule, run
  `scripts/promote-to-main.sh` with no branch argument. It publishes an
  immutable source candidate, reuses a valid passed exact-SHA Capsule CI
  receipt (or runs it once), submits the exact SHA plus
  receipt to the durable queue, prints its queue identity, and exits; agents
  must not wait on a promotion lock. In the primary checkout, the long-lived
  `scripts/process-promotion-queue.sh` worker owns retries, conflict
  integration, the full prospective-tree gate, and protected-main CAS.
  A successful queue admission auto-starts that worker (`--watch`) when none
  is alive, so a queued candidate never sits unprocessed
  (`POG_PROMOTION_NO_AUTOSTART=1` opts out). A persistently red head is
  parked as `needs_input` after bounded retries (`POG_PROMOTION_MAX_ATTEMPTS`,
  default 5) — loudly, with retained evidence — rather than blocking every
  later candidate forever. A (tree, gate) pair already validated green is
  memoized in `.artifacts/gate-receipts/`, so a duplicate submission of an
  already-landed candidate revalidates in seconds instead of re-running the
  full gate (`POG_LANDING_GATE_MEMO=0` opts out; a red gate is never skipped).
  For a blocked operational emergency, submit with
  `scripts/promote-to-main.sh --emergency` or mark an already admitted item
  using `scripts/mark-promotion-emergency.sh <candidate-id-or-sha>`. Emergency
  candidates precede normal FIFO but are FIFO among themselves; they never
  interrupt a running gate or bypass the final protected-main CAS.
  **Human-only test waiver:** agents must never invoke `--skip-tests`, pass
  `--gate ':'`, or describe a waived promotion as tested. When a production or
  similarly time-critical incident requires the exception, stop and give the
  responsible human this exact instruction: **“I cannot waive promotion tests.
  Run this yourself only for an emergency, after accepting that both the
  Capsule and prospective-tree gate commands will be `:`:
  `scripts/promote-to-main.sh --emergency --skip-tests`.”** This keeps the
  receipt-bound immutable candidate, durable waiver record, emergency FIFO,
  integration, and protected-main CAS, but it does not execute the configured
  gate at either test point. The human owns the waiver decision and follow-up
  validation.
  Candidate/integration refs and failure logs remain retained for retry;
  Capsule-local `main` never moves. `POG_PROMOTION_LEGACY_DIRECT=1` is only
  migration compatibility for already-running promotions. No direct commits
  to `main`, including docs.
  **Promotion completion:** a commit, immutable ref, running Capsule-CI job,
  or `queued` state is not completion. For the exact candidate, use
  `scripts/promotion-status.sh --candidate <id-or-sha> --json` before a retry
  or worker invocation and follow its `next_action`. Do not start duplicate
  Capsule CI or workers while it reports an active exact-candidate receipt or
  queue worker. Continue until `landed` (and verify ancestry on protected
  `main`), or stop with the durable `retry_wait`/`needs_input` evidence and
  required human action. Details: `docs/promotion-operations.md`.
- **Private-by-default folders** (all gitignored, never committed):
  `.context/` transient working markdown, `.artifacts/` generated review and
  build output, `.worktrees/` branch worktrees.
- **Durable agent reports.** For implementation, investigation, or review work
  that spans more than one substantive step, create
  `.context/agent-reports/<task-or-branch>.md` when work begins and update it
  at meaningful milestones. Record scope, decisions, changed paths, commands
  and outcomes, and blockers there while context is still available. At handoff
  or completion, return the report path plus compact status/gate facts; never
  make a long prose report a required final structured response. Report files
  are private working artifacts and must not be committed unless explicitly
  requested.
- **Validation:** `scripts/checks.sh` must exit 0 before landing.
- **Testing rule:** no live LLM calls in tests or CI — cassettes, flows, and
  mocks only.
- **Doctor:** `scripts/pog-doctor` lints these conventions deterministically
  (CI-safe: skips the hook check in CI checkouts); keep it green.
<!-- pack:conventions:end -->

<!-- BEGIN kitsoki:launch-policy (managed by pack/launch-policy/install.sh; edits inside are overwritten on upgrade) -->
## Agent operating principles (kitsoki launch policy)

This repository is governed by the parallel-agent gitflow. The rules are
mechanical, not advisory — the shims, hooks, and capsule CI enforce them:

- **Launch through the shims.** `claude` and `codex` resolve to
  `.kitsoki/bin/` wrappers (activate with `source .kitsoki/launch-policy.sh`;
  interactive shells can hook this on `cd`). Every launch passes
  `agent_launch_policy` preflight: this repo's root and its sibling repos
  are protected roots; agent work happens in `.capsules/workspaces/`
  (or legacy `.worktrees/`) via `kitsoki agent launch --exec`, with
  `--profile pog-drive` as the sanctioned catalog-drive entry.
- **Full-permissions agents are a last resort.** Use the sanctioned escape
  hatch (the `claude superagent` / `codex superagent` aliases, or
  `kitsoki agent launch --raw --interactive`) only when the governed path
  cannot do the job — and file the gap that forced it (feedback or
  requirement node) so the workaround becomes unnecessary next time.
- **Never edit a sibling repo.** Anything this repo needs from another is
  proposed as a typed requirement/bug node into that repo's federated
  catalog via `graph_propose`; its own fleet prioritizes it.
- **CI is capsule CI.** Run `kitsoki capsule ci doctor change --workspace
  <id>` before claiming work; `kitsoki capsule ci run` produces the typed
  verdict and receipt that admit a candidate to the merge queue
  (`kitsoki queue submit`). Protected `main` is never committed to
  directly — landings are fast-forward through the queue or the repo's
  merge-to-main helper, gated on green.
- **Disk is a first-class resource.** Workspaces have owners and get
  reaped; when the doctor's disk-capacity floor trips, run
  `kitsoki capsule cleanup plan` and apply a reviewed plan before
  launching more work.
<!-- END kitsoki:launch-policy -->
