# `stories/land` — autonomous fast-forward landing

Land a committed branch worktree onto `origin/staging/local` without a human in
the loop, or produce an artifact that explains exactly why it didn't.

```
kitsoki run stories/land/app.yaml
```

then submit `land`. World-in:

| key | default | meaning |
|---|---|---|
| `worktree_path` | `.` | the worktree holding the committed branch |
| `workspace_branch` | *(none)* | the branch to land |
| `target` | `staging/local` | **remote** branch name — never checked out locally |
| `remote` | `origin` | |
| `gate_command` | `bash scripts/checks.sh` | this repo's deterministic gate |
| `max_attempts` | `5` | bound on the optimistic push-race retry |

Exits: `landed` (`landed_sha`), `pr-opened` (`pr_url`), `needs-human`
(`last_error`). `status` carries the same three words, so a caller never has to
infer the outcome from which key happens to be non-empty.

## Imported, not copied

The loop itself is Kitsoki's `@kitsoki/land`, imported under the alias `ln`:

```
ready --land--> ln (@kitsoki/land, entry: fetch)
                  fetch -> rebase -> [conflict-resolve] -> gate -> push
```

`app.yaml` here is ~160 lines and almost all of it is comment; the only
behaviour it owns is *which target, which gate, which remote*. This is
deliberate. A landing loop is exactly the kind of thing that must not exist in
three divergent copies — the copy that drifts is the copy that force-pushes.

`@kitsoki/land` resolves through Kitsoki's import resolver, in this order:

1. `--kitsoki-repo` / `$KITSOKI_REPO`,
2. an on-disk kitsoki checkout discovered by walking up from this directory,
3. **the story library embedded in the `kitsoki` binary** — the tier that
   applies here, since this repo is not inside a kitsoki checkout.

This repo already depends on that mechanism — `.kitsoki/stories/studio-sassfully-dev`
imports `@kitsoki/dev-story` the same way — so it is a proven path here, not a
new bet. Verified empirically: `@kitsoki/land` resolves and all five fixtures
below pass from this repo with no kitsoki checkout in scope.

**The cost is that the resolution is ambient.** Tier 1 reads `$KITSOKI_REPO`,
which the CLI populates from a *saved pointer* at `~/.kitsoki/repo` — during the
work that produced this story that pointer changed twice under us, swinging
`@kitsoki/land` between an on-disk Kitsoki worktree and the embedded copy, which
are different versions of the story. So the same commit of this repo can exhibit
different landing behaviour on two machines, or on one machine an hour apart.
The flow fixtures here are written to be version-agnostic for that reason, and
"Known gaps §2" is a direct consequence of it.

## What the flows prove

`kitsoki test flows stories/land/app.yaml` — 5 fixtures, no LLM, no network:

| fixture | proves |
|---|---|
| `lands.yaml` | the happy path, and that the rebase is onto `origin/staging/local` while the push is a plain refspec push to `refs/heads/staging/local` — no local branch for the target, no force |
| `push_race_retries_then_lands.yaml` | a lost push race is a re-fetch → re-rebase → **re-gate** → retry, landing on attempt 2 with the sha that was gated on top of the winner's commit |
| `push_race_exhausted.yaml` | the retry loop is bounded, and exhausting it reports `needs-human` with the real git rejection — not a landing |
| `gate_red_needs_human.yaml` | a red `scripts/checks.sh` stops the landing and carries the gate's **own output** out to the caller |
| `conflicts_escalate_to_pr.yaml` | an unresolvable conflict opens a PR against `staging/local` instead of stalling; `landed_sha` stays empty |

They run as part of `scripts/checks.sh` whenever a `kitsoki` binary is
resolvable, and are skipped loudly in CI, which has none.

## Relationship to the shell scripts

`scripts/merge-to-main.sh`, `scripts/land-branch.sh` and
`scripts/integrate-branch.sh` are the hand-driven landing path and are
unchanged. This story is the autonomous one: an agent that finishes work in
`.worktrees/<name>` submits `land` and the result is either a commit on the
remote or a PR that says why not.

## Known gaps

Two, both upstream in `@kitsoki/land`, both recorded here so nobody rediscovers
them by being burned.

### 1. The escalation PR body loses the resolver's reason

Pinned by `conflicts_escalate_to_pr.yaml`. When conflicts escalate, the PR is
opened with the correct base, head and title, but its **body** arrives with an
empty resolver report.

`land` composes that body from its own `last_error`, which its `cr` import
projection fills with a template referencing `world.cr__conflict_verdict`. That
projection template is not re-rewritten when `land` is itself imported, so at
this fold depth it renders to nothing. The structured verdict is still intact in
the world as `ln__cr__conflict_verdict`; only the prose is lost.

Nothing unsafe follows from it — no push happens, the PR exists, and the branch
is preserved. Reproduce with:

```sh
kitsoki test flows stories/land/app.yaml \
  --flows stories/land/flows/conflicts_escalate_to_pr.yaml \
  --trace-out /tmp/t.jsonl
# then look at the open_pr_exec args in /tmp/t.jsonl
```

The same fold behaviour is why this story's exit projections do **not** re-set
`last_error`: a child's `@exit:` transition effects already write the parent's
identically-named keys, and re-projecting `{{ world.ln__last_error }}` on top of
them overwrites the real message with nil.

### 2. `gate-repair` is deliberately NOT enabled

Upstream `land` grew a bounded, write-fenced repair arc
(`@kitsoki/gate-repair`): when the gate goes red on a *textually clean* rebase —
two branches that merged without a marker but disagree about behaviour — an
agent with `[Read, Edit]` and no Bash gets exactly one attempt at repairing the
source, and the story re-gates the repair commit before pushing it.

The property that makes that safe is the **anti-weakening fence**: the repair is
classified from the staged bytes, and a repair that touches a *test* file exits
to a PR instead of pushing, because a gate turned green by editing what it
asserts is not a repair. That classification is a `test_path_regex` knob on
`gate-repair`, and `land` does not project it across the import fold — a caller
of `@kitsoki/land` cannot set it and inherits the upstream default:

```
(^|/)(test|tests|testdata|__tests__)/|(_test\.go|_test\.py|_test\.rs|\.test\.[jt]sx?|\.spec\.[jt]sx?|^test_[^/]*\.py|/test_[^/]*\.py)$|(^|/)stories/[^/]+/flows/
```

Measured against this repo's tracked files, that default is **wrong here**. It
covers `packages/*/test/**`, but it does not match any of:

- `scripts/test-*.sh` — the tests for the landing/promotion scripts themselves
- `scripts/qa/*.sh` — the privacy and idempotency QA assertions
- `scripts/checks/*.star` — the materialize gate's own check scripts, i.e.
  literally the assertions
- `stories/flows/` — the top-level story's flow fixtures (the default requires a
  directory between `stories/` and `flows/`)
- `fixtures/**` and `stories/*/fixtures/**` — every demo/tour golden

A repair that quietly edited any of those would be pushed as if it were a source
fix. That is precisely the failure the fence exists to prevent. Note this
repo made the exposure worse, not better, by adding story flows to
`scripts/checks.sh`: a red gate can now BE a failing flow fixture, and the
tempting "repair" is to edit the fixture — a direct hit on the uncovered set.

**Why the arc is not simply switched off.** `max_repair_attempts: 0` in
`world_in` would disable it in one line, and that is the right fix — but that
world key exists only on `land` versions that HAVE the arc. Because resolution
is ambient (above), pinning the key makes this story fail to load, and takes the
whole gate down with it, on any machine or moment where resolution lands on an
older copy:

```
imports.ln: world_in.max_repair_attempts: child does not declare world key "max_repair_attempts"
```

Trading a documented exposure for a gate that fails at random is a bad trade, so
the arc is left at its upstream default and the exposure is written down here
instead. **This is the one thing in this story that is knowingly not right.**
It resolves the moment `land` projects `test_path_regex` — at which point both
`max_repair_attempts` and the regex get set together and this section becomes a
changelog entry.

**The regex this repo needs**, verified against every tracked path — it matches
all 120 assertion-bearing files, with zero false positives and zero `packages/*/src/**`
or `scripts/*.sh` source files caught:

```
(^|/)(test|tests|testdata|__tests__|fixtures|flows)/|(^|/)scripts/(test-[^/]*\.sh|qa/|checks/)|\.(test|spec)\.[cm]?[jt]sx?$
```

Note `[cm]?[jt]sx?` rather than `[jt]sx?`: this repo's tests are `.test.mjs`, and
the upstream alternation does not match `.mjs` at all.

**What unblocks adoption:** `@kitsoki/land` declaring a `test_path_regex` world
key and projecting it into its `gr` import. Once that exists, this story adds one
`world_in` line with the regex above and one `max_repair_attempts: 1`, plus flow
fixtures for the repaired / test-edits / unrepairable arcs.
