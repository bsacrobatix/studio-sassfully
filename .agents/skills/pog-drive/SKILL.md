---
name: pog-drive
description: Drive studio-sassfully's own object-graph catalog (pog/catalog.yaml) — compute what's ready, execute the next node with a recorded dev-story session or implementation worktree, verify the deterministic gate, flip status with evidence, and report what only a human can decide. Use when the user says "drive pog", "what's next", "work the ready set", "advance the catalog", or asks for studio-sassfully status with execution intent.
---

# pog-drive — the per-repo catalog operating loop

This is the **standalone, per-repo** driver: it needs nothing outside this
checkout. Everything it reads and writes lives in `studio-sassfully` —
`pog/catalog.yaml`, `scripts/checks.sh`, `scripts/merge-to-main.sh`, and
whatever skills/agents are installed under `.agents/`. It does not assume a
POG program repo, another product's catalog, or any cross-repo graph — if
this repo is ever wired into a larger program, that program's own driver
dispatches *into* this loop rather than this loop reaching out.

The operator model: a human authors intent (requirements, use cases,
decisions) and reviews evidence; everything else — sequencing, execution,
status bookkeeping — is yours. Proceed on the catalog's stated assumptions;
flag decisions, don't block on them.

## The loop

Every invocation runs this cycle at least once:

1. **Ground.** Read `pog/catalog.yaml` in full, starting with its
   `type_registry` — node types, edge fields, and status vocabulary are
   defined *by this catalog*, not by any fixed schema, so learn them fresh
   each time (a different repo's catalog can use different type names).
   Trust `status:` fields only after spot-verifying: run `scripts/checks.sh`
   (it lints the catalog itself, among other things). If a status disagrees
   with what the gate/evidence shows, the observable wins — fix the catalog
   first.
2. **Ready set.** A node is *ready* iff every node it points to through an
   acyclic sequencing edge (commonly named `after`, `depends_on`, or
   `blocked_by` in this catalog's `type_registry` — check `edge_fields` for
   `acyclic: true`) is at a terminal/shipped status, and the node's own
   status is this catalog's earliest actionable one (often `planned`,
   `draft`, or `proposed` — read the vocabulary, don't assume).
3. **Pick.** Prefer, in order: (a) the node the user named; (b) the
   earliest node in sequencing order toward whatever the user cares about;
   (c) the cheapest ready node that unblocks the most others. Announce the
   pick and how you'll know it's done before starting.
4. **Execute.**
   - Design / requirements / use-case work → a **recorded dev-story
     session**: dispatch to whatever dev-story driver agent this repo has
     installed under `.agents/agents/` (e.g. a `*-mcp-driver` agent), or to
     a `work-decomposition` skill under `.agents/skills/` to turn a
     requirement into change-node briefs. The session trace is the
     evidence — don't hand-wave a design decision into the catalog without
     one.
   - Implementation → a `.worktrees/<branch>` worktree, landed via
     `scripts/merge-to-main.sh` (fast-forward only; use
     `scripts/land-branch.sh` if main has advanced). Never commit to a
     protected main directly.
   - No live LLM in any CI/test path — cassettes, flows, and mocks only
     (this repo's own conventions block in `AGENTS.md` states the specifics).
5. **Verify the gate.** `scripts/checks.sh` must exit 0. That, or another
   stated observable fact on the node, is the only thing that justifies a
   status flip — never assert `done` on the strength of a plausible-looking
   diff.
6. **Record.** Update the node's `status:` and rewrite its `summary:` with
   dated evidence (what landed, SHAs, session/run ids, what was deliberately
   left out). Re-run `scripts/checks.sh` so the catalog still lints. Land the
   catalog edit itself through a worktree + `scripts/merge-to-main.sh`, same
   as any other change.
7. **File friction immediately.** Any gap in the toolchain (dev-story
   driver, work-decomposition, the catalog schema itself) goes upstream the
   moment you hit it — file an issue, don't silently work around it.
8. **Report.** End with: what shipped (with evidence), what the catalog now
   says, the new ready set, and a short **human-only** list — pending
   decisions the work touched, review debt, and any one-time manual steps.
   Never present a human-only step as blocking work that has an unblocked
   part.

Repeat the loop while ready nodes remain in the user's stated scope; stop
when the scope is done or the only remaining nodes are human-only.

## Standing constraints

- **This repo's catalog is the live status record.** If this repo also has
  prose docs describing the same plan, reconcile catalog and prose in the
  same change — never let them drift.
- **Statuses are earned, not asserted:** no terminal status without its
  gate run in this session, or evidence of a prior green run cited in the
  summary.
- **Decisions are a human's.** Work under the catalog's recorded assumption,
  name the assumption in your report, and never flip a pending-decision node
  yourself.
