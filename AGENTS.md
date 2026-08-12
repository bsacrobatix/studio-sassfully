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
mechanical, not advisory — the shims, hooks, and the landing story enforce
them. The capsule + merge-queue landing path is **retired**; fast-forward
landing through an isolated Git worktree replaces it:

- **Launch through the shims.** `claude` and `codex` resolve to
  `.kitsoki/bin/` wrappers (activate with `source .kitsoki/launch-policy.sh`;
  interactive shells can hook this on `cd`). Every launch passes
  `agent_launch_policy` preflight: this repo's root and its sibling repos
  are protected roots; agent work happens in an isolated worktree under
  `.worktrees/<name>` via `kitsoki agent launch --exec`, with
  `--profile pog-drive` as the sanctioned catalog-drive entry.
- **Full-permissions agents are a last resort.** Use a sanctioned escape
  hatch only when the governed path cannot do the job — and file the gap that
  forced it (feedback or requirement node) so the workaround becomes
  unnecessary next time. The governed arm is `claude superagent` / `codex
  superagent`; `kitsoki agent launch --raw --interactive` is the underlying
  command. Whichever isolated working directory the shim materializes,
  landing from it is the fast-forward worktree flow below — direct
  `git commit`, no merge-queue wait. See
  `docs/guide/agents/launch.md` for the arms and their working directories.
- **Never edit a sibling repo.** Anything this repo needs from another is
  proposed as a typed requirement/bug node into that repo's federated
  catalog via `graph_propose`; its own fleet prioritizes it.
- **Work in a worktree, land by fast-forward.** `git worktree add -b
  <branch> .worktrees/<name> origin/staging/local`; commit there with plain
  `git commit` (worktrees are hook-exempt); land with `stories/land` or by
  hand — `git fetch origin`, `git rebase origin/<target>`, run the gate
  command (capsule CI is still the gate; in Kitsoki that is
  `bash scripts/capsule-ci-quick-gate.sh`), `git push origin
  HEAD:refs/heads/<target>`. The push is the only serialization point: it
  succeeds only as a fast-forward, so a losing racer is rejected and retries
  (refetch, rebase, re-gate, push again) rather than being overwritten. A
  rejected non-fast-forward push is an *expected* outcome of concurrent
  landing, not an error to escalate. Never force-push: a force-push to
  `staging/local` on 2026-07-31 silently dropped 116 landed commits.
  Protected `main` is never committed to directly; promotion to `main` (where
  applicable) happens on GitHub, gated on CI. Do not use `capsule submit`,
  `kitsoki queue *`, or `scripts/dev-workspace.sh` to land — that path is
  retired.
- **Every primary checkout is read-only — every repo's, not just this one.**
  A primary checkout is someone else's workspace: it carries other sessions'
  modified and untracked files, often on a branch unrelated to the integration
  branch, and this repo's is `chmod 444` besides. Never edit, commit, `git
  pull`, or check out a branch in one; cut a worktree first and do the whole
  job there, including the steps that "resolve naturally" in the primary tree.
  On 2026-08-11 a SOPS secrets file was edited in a primary checkout because
  `sops` and `.sops.yaml` resolved there, then had to be copied into a worktree
  to commit — one rule (worktree-only) beats two (worktree-except-when-awkward).
  If a tool only resolves its config from the primary root, run it with an
  explicit config path against the worktree, and file the gap.
- **Never answer "what does this repo do today" from a checked-out file.**
  `git show origin/<branch>:<path>`, after `git fetch origin` if the ref is
  cold. A primary checkout can be arbitrarily far behind: on 2026-08-11 a
  workflow file read from one 78 commits behind produced a wrong statement to
  the operator that a change had no automatic deployment path, when the landed
  file had carried the trigger all along. The `SessionStart` advisory prints
  each checkout's distance from its upstream; when it is silent that checkout
  is level and clean, and only then.
- **Never add a backend to an application.** A Kitsoki application is
  `app.yaml`, Starlark, a component package and taxonomy — that is the whole
  list. No Node or Express server, no Python service, no shell behind an
  endpoint, no `.mjs` carrying logic, no worker, no sidecar, no "thin
  adapter". Not for a proof of concept, not for a prototype, not for a spike,
  not "temporarily": those four words have justified every prior instance and
  none of them stayed temporary. **If the story cannot express it, the
  capability is missing from the Go service, and adding it there is the
  task** — reporting *"this needs a Kitsoki capability, here is precisely
  what and where"* is the correct outcome, not a blocked agent, and not
  permission to build something else instead. Presentation JavaScript is
  fine: Vue SFCs in a component package, and the browser-native `.mjs` that
  package legitimately ships.
  The prohibition is on **logic and services** — control flow, data
  access, validation, orchestration, persistence, business rules — and a Vue
  component that decides control flow has already crossed the line, which
  `presentation: custom` makes easy to do by accident, since the web surface
  does not enforce `app.yaml`'s card bindings there. Build and check tooling
  is not an application and is not covered, though the direction of travel is
  the same: meaningful commands belong in `kitsoki`, not Make or shell.
  Vendored third-party assets already in the tree stay; adding a new one is a
  decision to raise. If you believe a case warrants an exception, **ask the
  operator before writing it** — afterwards it exists, and removing it is a
  negotiation.
- **Never background a long command and end your turn waiting to be
  notified.** Backgrounded work does not wake a subagent — you will wait
  forever, and on 2026-08-11 two agents did, ~20 minutes each. Run gates and
  other long commands in the **foreground**, or background them and *poll*
  their log to completion within the same turn. "I'll report back when it
  finishes" is not a turn ending; it is a stall.
- **Report only what you verified, and quote the evidence.** Give the failing
  test name and its assertion, the SHA, the count you actually recounted —
  not an exit code and not a summary of what you expected to happen. A
  flattering number needs the same check as a discouraging one: on 2026-08-11
  a sweep agent reported closing 21 PRs when it had closed 30. **"Pre-existing"
  is not "not a problem"** — say pre-existing *and* whether it is a real gap,
  because the same failure was waved away twice as unrelated and was in fact a
  genuine gap in a commit landed that morning. Where the operator gave you a
  hypothesis, **disproving it is a success**, and shipping a fix for a bug that
  is not there is the failure. Where you lack a capability the task needs,
  **refuse and name the missing capability** — an agent that declined for want
  of a `host.git.close_pr` rather than inventing a credentialed workaround did
  the right thing. That is the expected response, not an exceptional one.
- **Grep for an existing implementation before building a new mechanism.** On
  2026-08-11 a scratch-file exclusion was added as an `info/exclude` mechanism
  when the same policy was already implemented one layer down as `:(exclude)`
  pathspecs; the two collided, broke the lane outright, and killed a run that
  had already produced a correct fix. Search first, then extend what you find
  or say why it cannot be extended.
- **Never `git stash`.** The stash stack is repo-global, not worktree-scoped:
  every worktree shares one `refs/stash`, so a `pop` can take another agent's
  entry, land it in your tree, and drop theirs. Save your own work with
  `git diff HEAD > /tmp/<name>.patch`, take a baseline with a detached worktree
  (`git worktree add --detach .worktrees/<name>-baseline <sha>`), and use a
  second worktree when you need a clean tree. `list`/`show`/`store` stay
  allowed; the guard refuses the rest.
- **Disk is a first-class resource.** Worktrees have owners; remove one you
  are done with rather than leaving it behind — through the repo's supported
  removal path where it has one (in Kitsoki, `make worktree-remove
  NAME=<name> ARGS=--delete-branch`). A bare `git worktree remove` on a
  bootstrapped worktree fails on read-only staged files *after* unlinking the
  admin record, which leaves a directory git can no longer see; always
  `git worktree prune` if you ever remove one by hand.
<!-- END kitsoki:launch-policy -->
