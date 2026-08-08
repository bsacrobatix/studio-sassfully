# Embedded demo control — local MCP lifecycle

This is the zero-install path for an app that deliberately enables
`demoMode:true`. The app keeps one resident browser API:
`window.__sassfullyDemo.run(script)`. An MCP client sends a bounded
`sassfully/demo-script/v1` document to that existing page; it does not reload,
navigate, inject JavaScript, or require an extension/pairing code.

The local control server is the existing story bridge, not a second daemon:

```sh
node packages/feedback-extension/story-bridge/stdio-server.mjs \
  --port 8931 --allow-embedded-demo
node examples/host-page/serve.mjs
# open http://127.0.0.1:7893/?demo=1&bridgePort=8931
```

Both endpoints are loopback-only. The page binds only when `demoMode:true`
and `demoBridge` was explicitly supplied by its host. Embedded mode uses no
extension pairing; extension mode retains its user-consented per-tab pairing.

## MCP tool: `embedded_demo`

`embedded_demo` is intentionally a tour/control surface, not a generic
browser-evaluation or navigation endpoint. Its actions are:

| Action | Result |
| --- | --- |
| `sessions` | Bound demoMode sessions: stable `sessionId`, page URL, bind time. |
| `propose` | Stores a locally validated script as revision 1. The page receives nothing. |
| `validate` | Resolves semantic anchors in the specified current tab; returns `errors` and ranked-anchor `drift`. |
| `update` | Replaces draft content with compare-and-swap `revision`; creates the next unvalidated revision. |
| `push` | Requires the exact revision to have passed `validate` against the exact session, then calls the resident page `run`. |
| `run` | Direct one-off validated run, retained for controlled local use; lifecycle clients should prefer `propose → validate → push`. |
| `stop` | Stops the resident run and clears its overlay/stage. |
| `resume` | Re-runs the last resident script after an explicit audio unlock. |
| `evidence_start`, `evidence_stop`, `evidence_export` | Controls the host's existing opt-in evidence capture; `start` requires `permission:true`. |

Drafts are process-local and in memory. A stale CAS revision fails rather
than overwriting another author’s revision. Any update invalidates prior tab
validation. A push result includes completed steps, anchor drift, and media
outcomes; it is the execution acknowledgement, not a claim that physical
speakers were audible.

### Lifecycle example

After normal MCP `initialize`, use JSON-RPC calls such as:

```jsonc
// 1. Find an already-bound page.
{"method":"tools/call","params":{"name":"embedded_demo","arguments":{"action":"sessions"}}}

// 2. Keep authorship local until the draft is reviewed/preflighted.
{"method":"tools/call","params":{"name":"embedded_demo","arguments":{"action":"propose","script":{ "version":"sassfully/demo-script/v1", "steps":[/* … */] }}}}

// 3. Validate the exact draft revision against the exact open tab.
{"method":"tools/call","params":{"name":"embedded_demo","arguments":{"action":"validate","sessionId":"<session>","draftId":"<draft>","revision":1}}}

// 4. Push only that validated revision; no browser navigation occurs.
{"method":"tools/call","params":{"name":"embedded_demo","arguments":{"action":"push","sessionId":"<session>","draftId":"<draft>","revision":1}}}
```

For a revision, call `update` with the last revision and the whole replacement
script, then validate and push the returned revision. Anchor preflight follows
the script contract’s `role → testid → text → css` order. It returns a drift
record when a lower-ranked fallback healed the anchor and fails on ambiguity.

## No-reload and reconnect semantics

Running a second script through the same resident API is supported: a new
`run` cancels the prior one and retains the page, DOM, API object, and bound
session. The embedded loopback WebSocket has bounded exponential reconnect
after a bridge restart and reuses its session ID. Restart the bridge on the
same loopback port; the page rebinds without navigation. Source changes still
need normal HMR/reload deployment before an already-loaded page can understand
new script fields—MCP script pushes themselves never require one.

## Audio, stage, and capability boundaries

`@sassfully/demo-tts` is a loopback Edge-TTS service. The page reports
`narration.status:"started"` only after `HTMLMediaElement.play()` resolves;
it reports `blocked_user_gesture` plus `needs_audio_unlock:true` for a
`NotAllowedError`/suspended audio context, and `failed` for other errors. A
resolved play promise cannot detect speakers, tab muting, or hardware volume,
so receipts truthfully use `audible:"unobservable"`.

The demoMode host displays **Enable Pip audio**. A user must click it once to
prime/resume media only; it never launches a tour. Then call `resume` or push
the script again. Do not silently replace a gesture block with speechSynthesis.

Stage presentation sits above a sparse/optional dimmer and below captions.
Showcase steps should set `dim:false`. The new static `stage.presenter` shape
accepts only project-served `/packages/demo-stage/assets/*.png|*.webp` paths:

```json
"stage": {
  "presenter": {
    "id": "nova",
    "src": "/packages/demo-stage/assets/nova-cutout.png",
    "alt": "Nova, the turquoise fox presenter"
  },
  "anchor": { "mode": "dock", "edge": "bottom-left", "size": 0.3 },
  "persistent": true
}
```

Nova’s original magenta-background source and its alpha cutout are tracked in
`packages/demo-stage/assets/`; the cutout is mounted by the existing stage
layer, never as an arbitrary remote image fetch.

## Evidence reuse, not a parallel recorder

`evidence_*` adapts the existing `createBrowserEvidenceCapture` provider
surface. `evidence_start` requires explicit `permission:true`; export is the
existing feedback-evidence artifact with bounded/redacted demo execution
stamps (step, anchor drift, action, stage, narration). It is not Chrome HAR:
full HAR remains an extension/CDP-only capability. No evidence is exported or
uploaded merely by running a demo.

## Example live run

Use `examples/host-page/nova-tour.json` after enabling the local host and
audio. It starts Nova persistently bottom-left, fills the sample name field,
and clicks its real button. Every step is `dim:false`. A successful push has
three completed steps, no drift, a `stage` mount record, and one Edge media
record per narration step.
