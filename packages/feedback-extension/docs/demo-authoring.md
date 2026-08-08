# Authoring narrated demo scripts (`sassfully/demo-script/v1`)

This guide is self-contained: hand it to an LLM (or a person) and they can
write a good demo script with no other context. A demo script is a JSON
document played live in a real, user-paired Chrome tab by the sassfully
feedback extension: each step spotlights an element, shows a caption, speaks a
narration, optionally performs a real click/fill/keypress, then dwells before
the next step. Delivery mechanics (bridge, pairing, MCP) live in
[`../RUNBOOK.md`](../RUNBOOK.md); this document is only about writing scripts
that play well.

## 1. The script and step contract

```json
{
  "version": "sassfully/demo-script/v1",
  "steps": [
    {
      "id": "s1-welcome",
      "spotlight": "[data-testid=\"host-header\"] h1",
      "caption": "Welcome to Acme Docs",
      "narration": "This page hosts the sassfully feedback widget.",
      "action": { "kind": "click", "selector": "[data-testid=\"demo-go\"]" },
      "dwellMs": 1000
    }
  ]
}
```

Every field on a step is optional, but **each step must include at least one of
`spotlight`, `caption`, `narration`, or `action`** — an empty step is rejected.
`version` may be omitted, but always pin it explicitly in checked-in scripts.

Hard bounds (enforced identically by the extension and the stdio server, in
`ext/story-bridge-policy.mjs` — a script violating any of these is rejected
before anything plays):

| Field | Type | Bound |
|---|---|---|
| `steps` | array | 1–50 steps |
| `id` | string | ≤ 100 chars (optional but recommended: makes failures reportable) |
| `spotlight` | CSS selector string | ≤ 500 chars |
| `caption` | string | ≤ 500 chars |
| `narration` | string | ≤ 2000 chars |
| `dwellMs` | number | 0–60000 (default 800) |
| `action.kind` | string | exactly `click`, `fill`, or `press` |
| `action.selector` | CSS selector string | ≤ 500 chars; required for `click` and `fill` |
| `action.value` | string | ≤ 2000 chars; required for `fill` (text) and `press` (key) |

All non-empty strings: `""` is invalid wherever a string is given.

## 2. How a step plays (the timeline you are pacing)

Per step, in order:

1. Wait (bounded, **10 s max**) for the `spotlight` target to exist and be
   visible. A selector that never appears fails the step — and **the first
   error stops the whole run** (the overlay is always cleared).
2. Spotlight the target and dim the rest of the page; show the `caption` in
   the bottom-center banner.
3. Start speaking `narration` (browser `speechSynthesis`).
4. If `action` is present: pulse the target, then perform the real
   click/fill/press through the extension's story-command machinery.
5. Wait for the narration to finish (when TTS is unavailable a timed fallback
   based on narration length is used instead).
6. Wait `dwellMs` (default 800), then advance.

Two consequences worth internalizing:

- **Narration length is the step's main clock.** The step does not advance
  until speech ends; `dwellMs` is *additional* settle time after speech.
- **The whole run must fit the transport budget.** The MCP request times out
  at 120 s — keep total runtime comfortably under ~90 s. Estimate ≈ 2.5
  spoken words/second, plus each step's dwell, plus ~0.5 s/step overhead.
  A 10-step tour with ~15 words/step and ~1 s dwells lands around 75 s.

## 3. Pacing

- **One idea per step.** If a narration contains "and then" twice, split it.
  A step should point at one thing and say one thing about it.
- **Narration: 1–2 short sentences (roughly 8–25 words).** Under ~5 words the
  spotlight jumps away before the viewer has registered it; over ~30 the
  viewer stares at a frozen highlight. Never approach the 2000-char bound —
  that is a safety cap, not a target.
- **Dwell carries the visual rhythm.** Use it deliberately:
  - 600–800 ms — connective steps mid-flow (about to act, short explanation).
  - 900–1200 ms — opening/framing steps; anything the viewer should read.
  - 1500–2500 ms — payoff steps: a result appearing, the closing frame.
- **Vary it.** Uniform dwell reads as robotic; a demo breathes when framing
  steps are slower and action beats are quicker.
- **Explain, then act.** Give a control its own narrated step *before* the
  step that clicks it ("Next, the generate button…" → click). An unannounced
  click reads as the page acting on its own; an action step after a framing
  step needs little or no narration of its own.
- **After every action, show the consequence.** Follow a click/fill with a
  step spotlighting what changed, with a generous dwell. An action whose
  effect is never framed might as well not have happened.

## 4. Spotlight etiquette

- **Never cover what you're narrating.** The caption banner sits bottom-center.
  If the element you're discussing lives at the bottom of the viewport, the
  banner will sit on top of it — restructure (spotlight the enclosing card, or
  talk about it while it is higher in the page) rather than narrate a hidden
  element.
- **Spotlight exactly what the narration is about.** If the words say "this
  input", the spotlight is the input — not its whole card, not the page.
  Mismatched spotlight and narration is the fastest way to lose a viewer.
- **Prefer stable, specific selectors**: `[data-testid="…"]` > `#id` > short
  semantic paths. Avoid `:nth-child` chains and class soup — the demo plays
  against the live page, and a stale selector is a run-killing error.
- **Right-size the highlight.** Spotlighting a huge container dims almost
  nothing and points at nothing. Spotlighting a 12px icon strands the viewer.
  Aim at the smallest element that reads as "the thing being discussed".
- **For an action step, spotlight the action's target** (usually
  `spotlight === action.selector`) so the click-pulse and the highlight agree.
- **Steps without a spotlight are legal but weak** (caption/narration with no
  element highlighted). Use them only as a spoken bridge between sections;
  prefer anchoring every step to something on screen.

## 5. Action safety — demos click the real page

Actions are **not simulated**: `click` clicks, `fill` fills, `press` presses,
in a live tab, through the same machinery as autonomous story commands.

- **Stay on non-destructive paths.** Never script actions that submit forms
  with side effects, delete/modify data, send messages, purchase, log out, or
  navigate away from the demo surface. If a click's effect can't be undone by
  reloading the page, it does not belong in a demo.
- **Prefer purpose-built demo surfaces** (like the example host page's demo
  form) whose handlers are known and local.
- **`fill` values are typed into real inputs** — no secrets, no PII, nothing
  you wouldn't show on a projector.
- **Remember first-error-stops.** A mid-run failure leaves the page in
  whatever state your earlier actions produced. Order steps so a partial run
  is harmless (framing first, actions late, destructive actions never).
- **Actions run without a per-action confirmation** — pairing was the user's
  authorization. That trust is exactly why scripts must be conservative.

## 6. Pre-flight checklist

1. `version` pinned to `sassfully/demo-script/v1`; ≤ 50 steps; every step does
   something.
2. Every `spotlight`/`action.selector` exists on the target page *at the
   moment its step runs* (elements created by earlier actions are fine — the
   10 s visibility wait covers render latency).
3. Total spoken words ÷ 2.5 + total dwell ≤ ~90 s.
4. No destructive or irreversible actions; no sensitive `fill` values.
5. Validate before sending: `npm test` validates every `examples/*.json`, and
   `npm run demo:send -- your-script.json` (see RUNBOOK) validates before it
   transmits.

## 7. Worked examples

All three play against the example host page (`npm run demo:serve`, then
`http://127.0.0.1:7893/`). They are checked in under `examples/` and validated
by `test/demo-examples.test.mjs`.

### 7.1 Minimal (2 steps) — `examples/host-page-demo-minimal.json`

The smallest script worth writing: one framing step, one action step. Note the
action step spotlights its own target and dwells longer at the end so the run
doesn't end abruptly.

```json
{
  "version": "sassfully/demo-script/v1",
  "steps": [
    {
      "id": "m1-hello",
      "spotlight": "[data-testid=\"host-header\"] h1",
      "caption": "A two-step demo",
      "narration": "This is the smallest useful narrated demo: one framing step, one action step.",
      "dwellMs": 800
    },
    {
      "id": "m2-click",
      "spotlight": "[data-testid=\"demo-go\"]",
      "caption": "Click the button",
      "narration": "And now we click the greeting button.",
      "action": { "kind": "click", "selector": "[data-testid=\"demo-go\"]" },
      "dwellMs": 1200
    }
  ]
}
```

### 7.2 Explain-then-act interaction (5 steps) — `examples/host-page-demo.json`

The original POC script: welcome → surface → fill → click → result. Each
action is narrated in the same step here (fine for a compact demo); the result
step gets the longest dwell as the payoff.

```json
{
  "version": "sassfully/demo-script/v1",
  "steps": [
    { "id": "s1-welcome", "spotlight": "[data-testid=\"host-header\"] h1",
      "caption": "Welcome to Acme Docs",
      "narration": "This is Acme Docs, a real host application embedding the sassfully feedback widget.",
      "dwellMs": 1000 },
    { "id": "s2-surface", "spotlight": "[data-testid=\"host-content\"] h2",
      "caption": "The product surface",
      "narration": "Every product surface on this page can carry contextual feedback anchors.",
      "dwellMs": 800 },
    { "id": "s3-fill-name", "spotlight": "[data-testid=\"demo-name\"]",
      "caption": "Let's try the interactive form",
      "narration": "First, we type a name into the demo form.",
      "action": { "kind": "fill", "selector": "[data-testid=\"demo-name\"]", "value": "Ada Lovelace" },
      "dwellMs": 800 },
    { "id": "s4-click-go", "spotlight": "[data-testid=\"demo-go\"]",
      "caption": "Generate the greeting",
      "narration": "Then we click the button to generate a greeting.",
      "action": { "kind": "click", "selector": "[data-testid=\"demo-go\"]" },
      "dwellMs": 800 },
    { "id": "s5-result", "spotlight": "[data-testid=\"demo-output\"]",
      "caption": "And there is the result",
      "narration": "The page responds instantly. That concludes this narrated demo.",
      "dwellMs": 1500 }
  ]
}
```

### 7.3 Full tour (9 steps) — `examples/host-page-demo-tour.json`

The reference structure for a longer demo, showing the patterns above at
scale: strict explain-then-act (t4 explains the field, t5 fills it, silently;
t6 explains the button, t7 clicks it), varied dwell (600 ms connective beats,
1200 ms opening, 1500–2000 ms payoffs), one idea per step, and a consequence
step after every action (t8 result, t9 closing frame on the sink panel). The
silent action steps (t5, t7: caption + action, no narration) keep the act
itself quick because the preceding step already said what would happen.

See the file for the full JSON; its shape:

| Step | Role | Dwell |
|---|---|---|
| t1-welcome | opening frame (header) | 1200 |
| t2-surface | context (product surface card) | 900 |
| t3-form-overview | announce the interaction | 900 |
| t4-explain-name | explain the input | 600 |
| t5-fill-name | act: fill (silent) | 700 |
| t6-explain-go | explain the button | 600 |
| t7-click-go | act: click (silent) | 700 |
| t8-result | consequence, payoff | 1500 |
| t9-sink | closing frame + sign-off | 2000 |
