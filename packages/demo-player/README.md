# @sassfully/demo-player

Environment-neutral narrated demo player for apps that embed sassfully
directly. Plays `sassfully/demo-script/v1` scripts — per step: spotlight +
page dim, caption banner, speechSynthesis narration, click-pulse, and **real**
DOM actions (click / fill / press) — with zero extension involvement. An LLM
or automation session opens a tab of the app and drives the demo through a
page-level API.

Extracted from the feedback-extension demo overlay POC
(`packages/feedback-extension/ext/content/demo-player.mjs` /
`demo-overlay.mjs`); plain ESM, no chrome.\* APIs, no build step.

## Enabling demo mode (host SDK init flag)

Demo mode is **never on by default**. A host that mounts the feedback SDK
opts in explicitly:

```js
import { mountReporter } from "@sassfully/feedback-core"; // or the src path in browser-native ESM

const api = mountReporter({
  anchorFor, manifest, router,
  demoMode: true,        // must be exactly `true` — a dev/demo-only switch
  demoOrigins: [],       // postMessage caller allowlist; [] (default) = postMessage disabled
});
const embed = await api.demo; // resolves once window.__sassfullyDemo is live; embed.uninstall() tears it down
```

The example host page (`examples/host-page/`) wires this to the `?demo=1`
query param and shows a visible "demo mode" badge while it is on.

Without the SDK, `installDemoEmbed({window, document, allowedOrigins})` from
this package does the same thing directly.

## Page API: `window.__sassfullyDemo`

When demo mode is enabled the page exposes:

- `run(script)` — validates the script, plays it, returns a promise of
  `{completed: true, completedSteps: [{index, id, ok}]}` (rejects on the
  first failing step; a run cancelled mid-flight resolves
  `{stopped: true, completedSteps}`). Starting a run cancels any prior run.
- `stop()` — cancels the active run, silences narration, clears the overlay.
- `status()` — `{running, lastResult}`.

## postMessage protocol (off by default)

Only when init supplied a **non-empty** `demoOrigins` allowlist does the page
listen for cross-window messages; senders from any other origin are ignored
silently (no reply, no probing oracle). Replies go to `event.source` with
`targetOrigin` pinned to the sender's origin.

```
caller → page : { type: "sassfully:demo:run",  script, requestId? }
caller → page : { type: "sassfully:demo:stop", requestId? }
page  → caller: { type: "sassfully:demo:result", requestId,
                  ok: true,  demo }            // run finished
                { type: "sassfully:demo:result", requestId,
                  ok: true,  stopped: true }   // stop acknowledged
                { type: "sassfully:demo:result", requestId,
                  ok: false, error }           // validation / step failure
```

## Script format

`sassfully/demo-script/v1` — see `src/demo-script.mjs` for the full bounded
contract (≤50 steps; capped string lengths; actions limited to
`click`/`fill`/`press`). Each step: `{id?, spotlight?, caption?, narration?,
dwellMs?, action?}`. This sample runs against `examples/host-page/?demo=1`:

```json
{
  "version": "sassfully/demo-script/v1",
  "steps": [
    { "id": "s1-welcome", "spotlight": "[data-testid=\"host-header\"] h1",
      "caption": "Welcome to Acme Docs",
      "narration": "This is Acme Docs, a real host application embedding the sassfully feedback widget.",
      "dwellMs": 1000 },
    { "id": "s2-fill-name", "spotlight": "[data-testid=\"demo-name\"]",
      "caption": "Let's try the interactive form",
      "narration": "First, we type a name into the demo form.",
      "action": { "kind": "fill", "selector": "[data-testid=\"demo-name\"]", "value": "Ada Lovelace" },
      "dwellMs": 800 },
    { "id": "s3-click-go", "spotlight": "[data-testid=\"demo-go\"]",
      "caption": "Generate the greeting",
      "narration": "Then we click the button to generate a greeting.",
      "action": { "kind": "click", "selector": "[data-testid=\"demo-go\"]" },
      "dwellMs": 800 },
    { "id": "s4-result", "spotlight": "[data-testid=\"demo-output\"]",
      "caption": "And there is the result",
      "narration": "The page responds instantly. That concludes this narrated demo.",
      "dwellMs": 1500 }
  ]
}
```

Try it: `node examples/host-page/serve.mjs`, open
`http://127.0.0.1:7893/examples/host-page/index.html?demo=1`, paste the JSON
into the console as `script`, then `await window.__sassfullyDemo.run(script)`.

## Security posture

- **Opt-in only.** Nothing installs itself; production mounts that don't pass
  `demoMode: true` expose no global, no listener, no demo code (the module
  graph is dynamically imported only when enabled).
- **postMessage is allowlist-or-nothing.** Default `[]` means the listener is
  never registered. Origins must match `event.origin` exactly.
- **Scripts are validated before any side effect**, with hard bounds on step
  count and string sizes.
- **Demos click the real UI.** Actions are genuine DOM interactions on the
  live page — keep demo scripts on safe, reversible paths (demo tenants,
  sample forms), never on destructive or billing-relevant controls.
