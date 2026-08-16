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
| `qa_start` | Starts owned local Chromium at a loopback URL, or a URL on an origin the server was started with `--allow-origin` for; `mode` is `headed` or `headless` (default headless). |
| `qa_action` | Runs exactly one typed operation: `snapshot`, `click`, `fill`, `press`, or `screenshot`; optional `narration` is spoken without a tour overlay. |

`qa_action snapshot` returns a **bounded structured digest** by default
(`detail: "digest"`): `url`, `title`, true `counts`, and capped lists of
`interactive` elements (`role`, `name`, `selector`, `testid`, `disabled`),
`headings` and `landmarks` — the anchor vocabulary
`packages/demo-player/src/anchor-resolve.mjs` already resolves, so an entry's
`selector` can be handed straight back as a `click`/`fill` selector. Every cap
that bites is declared in `truncated`, and `counts` always reports the real
totals. `detail: "full"` opts into the raw document; it is still bounded (64
KiB) and always reports `htmlChars`, the true size it was cut from. The
unbounded form this replaced measured 265,507 characters on one line — past the
MCP tool-result limit, spilled to a temp file whose lines were then too long to
read back, so the caller could not read its own observation at all.

`qa_action screenshot` clears the tour presenter first, but that is a courtesy
and never blocks the evidence: the stop is bounded, and a page that cannot
answer it (reloaded, navigated, socket open with nobody listening) yields the
capture anyway with `presenter: "stop_timed_out"` and a `presenterDetail`
naming what was waited for.
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

Before the typed page-side QA unlock request, it sends one CDP pointer gesture
to the fixed visible `[data-testid="sassfully-demo-audio"]` control in the
owned page. The control must exist, be enabled, and have clickable geometry.
Callers cannot supply a selector or evaluate code; ordinary tour controls do
not expose this activation path.

Its receipt includes a `sassfully/qa-narrated-replay-diagnostics/v1` phase
trace. Audio unlock has a 10-second bound and each replay a 45-second bound;
a timeout names `audio_unlock`, `run_1`, or `run_2`, the bound session, and the
canonical QA page. A timeout is a failed test—not an assumed narration or
presentation success.

### Opt-in CDP inspection and QA evidence

For an owned QA session only, `qa_cdp` sends a CDP command to the single page
session created by `qa_start`; `qa_events` polls its bounded event transcript.
It supports DOM/layout (`DOM.*`), runtime/console (`Runtime.*`, `Log.*`),
network and screenshot inspection. This is not a user-browser connection: the
browser is launched by this process, its initial URL is loopback-only unless
`--allow-origin` explicitly names its origin, and `Target.*`, `Browser.*`, and
page-navigation CDP commands are refused so it cannot attach/create/close
another target or leave the launched page's origin.

### Targeting an allowlisted remote origin (e.g. staging)

By default `qa_start`/`embedded_demo run` only ever admit a loopback URL —
this is the whole "cannot navigate off the owned page" boundary. To let a
narrated demo/QA session target one explicit remote deployment (for example
`https://staging.kitsoki.dev`), start the server with:

```sh
node packages/feedback-extension/story-bridge/stdio-server.mjs \
  --port 8931 --allow-embedded-demo \
  --allow-origin https://staging.kitsoki.dev \
  --auth-bearer-env KITSOKI_STAGING_SERVICE_TOKEN
```

Or, through the multiplexing relay ([`mcp-relay.mjs`](../packages/feedback-extension/story-bridge/mcp-relay.mjs) — the entry point an `.mcp.json` config actually launches), which forwards every one of these flags verbatim to the daemon it spawns:

```sh
node packages/feedback-extension/story-bridge/mcp-relay.mjs \
  --socket /tmp/sassfully-embedded-demo.sock --port 8931 --allow-embedded-demo \
  --allow-origin https://staging.kitsoki.dev \
  --auth-bearer-env KITSOKI_STAGING_SERVICE_TOKEN
```

`--allow-origin` is repeatable and takes a bare origin (scheme + host[:port],
no path); with none given, behavior is unchanged from before this existed —
through the relay too, since the daemon-multiplexing model means the daemon
is only ever spawned with the *first* relay's flags (the same pre-existing
limitation `--allow-embedded-demo` already has).

`--auth-bearer-env` names an **environment variable** whose value (never the
flag's own argv value) is attached as `Authorization: Bearer <value>` to
requests whose resolved origin is *exactly* the allowlisted one — never to a
third-party subresource (a CDN, a font host, analytics) the page may also
load. The credential is read once per `qa_start` against that origin and is
never logged, never placed in an MCP tool result, and never written to a
screenshot. `qa_capture_export`/`qa_har_export`/`qa_events` redact
`Authorization`, `Proxy-Authorization`, `Cookie`, and `Set-Cookie` header
values by NAME (unconditionally, not by pattern-matching the value text) in
both the raw event transcript and the HAR entries — this covers the value
regardless of which of the two sources below produced it.

**An MCP launch environment (an `.mcp.json`-declared stdio server, for
example) does not reliably carry an operator's own shell env vars.** So when
the named env var is absent or empty *at the point of use*, the driver falls
back to resolving the same logical secret from the macOS Keychain, once,
in-process, held only in memory — never written to argv, config, logs,
evidence, or an error message. The default lookup is
`security find-generic-password -a kitsoki-staging -s <the --auth-bearer-env name> -w`;
override either half with `--auth-bearer-keychain-service <name>` /
`--auth-bearer-keychain-account <name>` if the real entry uses a different
`-s`/`-a`. `qa_start` refuses (naming both the env var and the exact
Keychain `-s`/`-a` it tried) only when *both* the env var and the Keychain
lookup come up empty; a loopback target never attempts either, even when
`--auth-bearer-env` is configured.

**A remote-origin QA session launches Chromium with one extra flag.** Chrome
enforces Local Network Access (LNA): a page on a public origin cannot open a
plain `ws://127.0.0.1` connection at all — confirmed empirically (headless
Chrome 151.0.7922.138, a page on a public https origin, a real WebSocket
handshake server on loopback): `new WebSocket("ws://127.0.0.1:…")` fails
with `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, on every public
origin tested, not just staging specifically. Headless Chrome auto-denies
with no prompt; headed Chrome would at best interrupt a tour with a
permission dialog, and there is no scriptable CDP/Playwright grant for this
permission. So `qa_start` launches its owned Chromium with
`--disable-features=LocalNetworkAccessChecks` **only when the target is a
remote allowlisted origin** — confirmed to reliably restore the connection
(2/2 reruns); two guessed sibling feature names
(`LocalNetworkAccessChecksForNavigations`, `LocalNetworkAccessChecksWeb`)
do **not** work alone and are not used. A loopback `qa_start` — the
overwhelming majority of traffic — keeps today's exact launch args,
unchanged.

The embedded-session websocket handshake (`embeddedPageIdentity`, used by
`sessions`/`propose`/`validate`/`push`/`run`) accepts the same allowlisted
origins, so a demoMode page served by staging can bind exactly like a
loopback one — this is additive and requires no change to the page's own
demo-bridge wiring beyond it being reachable.

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
arrival order. For the MCP-owned QA browser only, canonical identity is its
loopback origin and path plus the private `__sassfully_qa_audio_test=1`
marker; application-owned query state such as `study=<id>` is ignored, while
normal page sessions retain their full query identity.

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
