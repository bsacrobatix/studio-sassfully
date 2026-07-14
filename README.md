# sassfully

A generic, contextual-feedback framework: bring your own presentation, let
users file feedback — bug reports, feature requests, mistranslation reports,
customization asks — anchored to a semantic location inside your system, and
route each item to the outcome it deserves (a comment, an issue, an AI edit
instruction, a local note, a support request).

Feedback is not mutation: the reviewed note is the artifact; anything that
changes the host system is a downstream outcome. Capture is opt-in and
privacy-controlled per host — PII stripping by default, optional
screenshot/replay evidence per feedback kind.

**Status: pre-code.** Requirements live in [docs/](docs/) (the concept and the
host-neutral feedback brief); the typed catalog (`pog/catalog.yaml`) and the
first package (feedback-core: anchor contract + capture widget + local-note
outcome) come next. Development follows a catalog-first loop — the object
graph exists before the first line of code.

## License

Apache-2.0 — see [LICENSE](LICENSE).

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
