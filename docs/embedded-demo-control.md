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

## Concurrent MCP clients

Do not configure every local MCP client to launch `stdio-server.mjs` directly:
each process owns the one page bridge port, so only the first client can start.
Use the relay instead. Each MCP client gets its own stdio relay, while the
relay starts or connects to one local daemon over a mode-`0600` Unix socket.
The daemon is the only process that listens on the page bridge port and keeps
the shared draft/session state.

```toml
[mcp_servers.sassfully-embedded-demo]
command = "node"
args = [
  "/absolute/path/to/packages/feedback-extension/story-bridge/mcp-relay.mjs",
  "--socket", "/tmp/sassfully-embedded-demo.sock",
  "--port", "8931",
  "--allow-embedded-demo",
]
```

The Unix socket is an internal relay transport, not a browser-control API.
Only the typed MCP methods are forwarded. Do not point an MCP client at port
8931: it is a WebSocket endpoint exclusively for an opt-in resident page.

## MCP tool: `embedded_demo`

`embedded_demo` has two separate lanes. Tours remain page-bound and never
launch or navigate a browser. QA owns a fresh local Chromium process for an
explicit loopback URL, in headed or headless mode, but never forwards a
generic browser-evaluation endpoint. Its actions are:

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
| `qa_start` | Starts owned local Chromium at a loopback URL; `mode` is `headed` or `headless` (default headless). |
| `qa_action` | Runs exactly one typed operation: `snapshot`, `click`, `fill`, `press`, or `screenshot`; optional `narration` is spoken without a tour overlay. |
| `qa_test_narrated_replay` | Test-only: runs a validated script twice through the bound page after its owned QA browser receives the private CDP audio-test admission; returns explicit audio, spotlight, caption, and completed-step receipts. |
| `qa_stop` | Closes the owned Chromium and removes its disposable profile. |

Drafts are process-local and in memory. A stale CAS revision fails rather
than overwriting another author’s revision. Any update invalidates prior tab
validation. A push result includes completed steps, anchor drift, and media
outcomes; it is the execution acknowledgement, not a claim that physical
speakers were audible.

### QA lifecycle

QA start is the only browser launch/navigation operation, and accepts only
`127.0.0.1`, `localhost`, or `::1`. Internally it uses CDP, but callers get no
CDP or JavaScript-evaluation surface: selectors and values feed fixed actions.
`snapshot` returns post-JavaScript HTML and `screenshot` returns the actual
Chrome PNG as base64. QA narration invokes only the resident narrator; it does
not mount a demo overlay, dimmer, caption, stage, or presenter. A screenshot
receipt therefore reports `presenter:"suppressed"`. Narration requires the
launched page to bind the normal demo bridge and configure narration; audio is
still subject to the browser's gesture/device limits.

### Automated narrated replay

Production and human-facing tours never get a remote audio-unlock operation:
the visible host control must be clicked by the user. `qa_start` alone adds
the private `__sassfully_qa_audio_test=1` marker to its disposable,
MCP-owned loopback page. Only that page can accept the page-side
`embedded-demo:qa-audio-unlock` request, which is bound to both its
`qaSessionId` and embedded session id and reports `source:"qa-cdp"`.

`qa_test_narrated_replay` is the sole consumer of that admission. It accepts
`qaSessionId`, `sessionId`, a normal bounded demo script, and `runs:2`; it
refuses any other run count. The result proves both replays completed and
contains, per run, every completed step, narration `started`/`ended` counts,
and explicit `presentation` receipts for shown spotlights and captions. It is
an automated test facility, not a normal tour-control primitive.

### Opt-in CDP inspection and QA evidence

For an owned QA session only, `qa_cdp` sends a CDP command to the single page
session created by `qa_start`; `qa_events` polls its bounded event transcript.
It supports DOM/layout (`DOM.*`), runtime/console (`Runtime.*`, `Log.*`),
network and screenshot inspection. This is not a user-browser connection: the
browser is launched by this process, its initial URL is loopback-only, and
`Target.*`, `Browser.*`, and page-navigation CDP commands are refused so it
cannot attach/create/close another target or leave the local app.

`qa_capture_start` enables Network, Runtime and Log collection;
`qa_capture_export` returns at most 16 response bodies/65,536 body characters,
100 console-or-exception entries and 500 events. Credential-shaped
authorization/cookie/token/secret/password assignments in text bodies are
redacted; base64-encoded bodies are omitted rather than decoded, and body
retrieval is best-effort because Chrome may evict responses. The same export
includes `har`, a bounded HAR 1.2-shaped `log` with request/response metadata,
redacted textual content, and `_sassfully.omission`/`truncated` markers where
content is omitted or capped; its zero timings are explicitly not a timing
measurement. `qa_har_export` returns that HAR object directly for a caller to
save as a `.har` artifact; the MCP itself never chooses or writes a filesystem
path.

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

HMR may reinstall demo mode before its prior socket closes. The bridge keeps
one authoritative embedded session per canonical loopback page URL; a new
hello for that page replaces the old session, and a later close from the old
socket cannot remove the replacement. QA narration and screenshot cleanup
select that page identity from the owned QA session URL, never from connection
arrival order.

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
