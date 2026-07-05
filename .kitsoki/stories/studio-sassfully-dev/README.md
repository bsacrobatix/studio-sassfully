# studio-sassfully-dev

Kitsoki dev-story instance for the Studio Sassfully checkout.

Run from the Studio Sassfully repo root:

```sh
kitsoki run
```

`kitsoki run` starts the profile-driven implicit dev-story root for this
checkout. Use the materialized wrapper explicitly only after editing it:

```sh
kitsoki run .kitsoki/stories/studio-sassfully-dev/app.yaml
```

Start the browser UI:

```sh
kitsoki web
```

This instance imports `@kitsoki/dev-story` from the Kitsoki binary. The shared
dev-story hub defines the general workflow; this repository owns the local
profile, command defaults, and any project-specific extensions.

Project profile: `.kitsoki/project-profile.yaml`
Readiness verifier: `.kitsoki/check-readiness.py`
Session mining promotion helper: `.kitsoki/promote-session-mining.py`

Generated PRDs publish under `.context/prd` and design drafts
publish under `.context/designs`. Update
`.kitsoki/project-profile.yaml` and `.kitsoki/stories/studio-sassfully-dev/app.yaml`
together if this project later adopts a different documentation layout.

Inferred project commands:

```sh
# No project commands were inferred during onboarding.
```

Command map:

- No project commands were inferred; update `.kitsoki/project-profile.yaml` and this README after choosing them.

Testing:

No deterministic flow fixtures are generated for this project instance yet. Use the imported dev-story fixtures in the Kitsoki checkout for hub coverage, and add project-local flows when this repo needs its own story-specific assertions.

Post-apply readiness:

Onboarding does not run project commands automatically. Review the checks, then
run them explicitly when you are ready:

```sh
python3 .kitsoki/check-readiness.py --list
python3 .kitsoki/check-readiness.py --json
python3 .kitsoki/check-readiness.py --json --update-profile
```

The report is written to `.artifacts/kitsoki-readiness.json`. Add
`--update-profile` when you want the summarized pass/fail result persisted into
`.kitsoki/project-profile.yaml`.

Session-mining customization:

When a mining pass emits `.artifacts/mining/jobs/<job>/analysis.json`, review the
candidate profile customizations and promote the pending ones explicitly:

```sh
python3 .kitsoki/promote-session-mining.py --dry-run
python3 .kitsoki/promote-session-mining.py --json
```

The helper updates `onboarding.story_customizations` only; it does not edit the
shared `@kitsoki/dev-story` or run an LLM.

