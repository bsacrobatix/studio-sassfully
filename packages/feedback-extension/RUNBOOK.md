# Narrated demo overlay POC — runbook

An LLM can run a live, narrated browser demo — spotlight/dim overlay, captions,
click-pulse affordances, and spoken narration — in the paired Chrome tab by
sending a JSON demo script through the existing story-bridge MCP.

## Demo script format (`sassfully/demo-script/v1`)

```json
{
  "version": "sassfully/demo-script/v1",
  "steps": [
    {
      "id": "s1",
      "spotlight": "<css selector, optional>",
      "caption": "shown in the bottom-center banner",
      "narration": "spoken via speechSynthesis",
      "action": { "kind": "click|fill|press", "selector": "…", "value": "…" },
      "dwellMs": 800
    }
  ]
}
```

Per step: wait (bounded, 10 s) for the spotlight target to be visible →
spotlight + dim → show caption → start narration → if `action`, click-pulse the
target then execute it via the existing autonomous story-command machinery →
wait for narration end (dwell-time fallback if TTS is unavailable) → wait
`dwellMs` (default 800) → next step. First error stops the run; the overlay is
always cleared at the end. `demo_stop` clears the overlay and cancels speech
mid-run.

Bounds (enforced in `ext/story-bridge-policy.mjs`, shared with the stdio
server): ≤ 50 steps; `id` ≤ 100 chars, `spotlight`/`caption`/`action.selector`
≤ 500, `narration`/`action.value` ≤ 2000; `dwellMs` 0–60000; `action.kind` only
`click`/`fill`/`press`; every step must do something.

## Running the sample demo end to end

1. **Serve the host page** (from the worktree root):

   ```sh
   node examples/host-page/serve.mjs        # http://127.0.0.1:7893/
   ```

2. **Build and load the extension**:

   ```sh
   cd packages/feedback-extension
   npm run build
   ```

   In Chrome: `chrome://extensions` → Developer mode → Load unpacked →
   select `packages/feedback-extension/dist/`.

3. **Open the host page** at `http://127.0.0.1:7893/` in a tab.

4. **Enable the origin**: click the extension's toolbar icon on that tab and
   enable capture for `http://127.0.0.1:7893` (this registers the content
   scripts; the story receiver needs them).

5. **Start the story bridge** (prints a one-line pairing token):

   ```sh
   node packages/feedback-extension/story-bridge/stdio-server.mjs
   ```

   Look for `Sassfully Story pairing token: <port>.<code>` on stderr — e.g.
   `8931.tR4…`. The token carries both the port (default 8931) and the
   per-instance secret code, so there is no separate port field to get wrong.

6. **Pair via the popup**: with the host-page tab focused, open the extension
   popup, paste the whole pairing token into the single "Pairing token" field,
   and click Pair. The loopback demo host is pairable alongside LinkedIn for
   this POC.

7. **Send `demo_run`**. The stdio server is an MCP server on stdin/stdout;
   after `initialize`, call the `linkedin_story` tool. Raw JSON-RPC (one line,
   with `<script>` replaced by the contents of
   `packages/feedback-extension/examples/host-page-demo.json`):

   ```json
   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
   {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"linkedin_story","arguments":{"action":"demo_run","script":<script>}}}
   ```

   One-liner that does exactly that:

   ```sh
   cd packages/feedback-extension
   { echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
     node -e 'const s=require("fs").readFileSync("examples/host-page-demo.json","utf8");console.log(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"linkedin_story",arguments:{action:"demo_run",script:JSON.parse(s)}}}))';
     sleep 60; } | node story-bridge/stdio-server.mjs --pairing-code <CODE-FROM-STEP-5>
   ```

   (`--pairing-code` takes only the code — the part of the token after the
   first dot. Reusing the same port and code lets the already-paired extension
   reconnect on its own; a new code means re-pairing the popup with the new
   token. From an MCP client, simply call tool `linkedin_story` with
   `{"action":"demo_run","script":{...}}`.)

8. **Stop early** (optional): `{"action":"demo_stop"}` clears the overlay and
   cancels narration.

## Convenience scripts

From `packages/feedback-extension/` (see `docs/demo-authoring.md` for how to
write scripts):

- `npm run demo:serve` — start the host-page server (`http://127.0.0.1:7893/`).
- `npm run demo:sync-desktop` — build, then
  `rsync -a --delete dist/ ~/Desktop/sassfully-demo-extension/`; load the
  unpacked extension from that Desktop folder so rebuilds only need this one
  command plus a reload in `chrome://extensions`.
- `npm run demo:send -- examples/host-page-demo.json --exec` — validate the
  script, spawn a fresh story bridge (pass `--port`/`--pairing-code` through),
  send the `demo_run`, and retry while no tab is paired. The pairing token is
  per server instance: pair the popup against the token THIS run prints on
  stderr, and the queued demo starts. Without `--exec` it prints the exact
  JSON-RPC lines to feed to a bridge's stdin. `--stop --exec` sends
  `demo_stop`.

## Troubleshooting

- **Bridge fails to listen, or pairs but behaves oddly.** The default port is
  8931, chosen to dodge common local squatters (Docker helpers and Agent Mail
  both like 8765). If 8931 is taken on your machine the bridge exits with the
  listen error; check who owns the port with
  `lsof -nP -iTCP:8931 -sTCP:LISTEN`, or start the bridge on another port
  (`--port 8877`) — the printed token starts with that port, so pairing picks
  it up automatically. Verify the bridge is the listener before pairing.
- **Popup shows "Paired · NOT connected (retrying…)".** The popup now reports
  the live socket state, not just the stored pairing: "Paired · connected"
  means the bridge really has the tab; "NOT connected" means the extension is
  dialing and failing (the last error is shown inline). Make sure the bridge
  process is running on the token's port — cross-check with
  `lsof -nP -iTCP:<port> | grep ESTABLISHED` if in doubt.
- **Restarted the bridge?** The extension reconnects on its own (fast retry
  plus a 30 s alarms backstop that survives service-worker restarts) as long
  as the port and code are unchanged — i.e. you restarted with
  `--pairing-code` (and the same `--port`). A fresh bridge without
  `--pairing-code` mints a new code, and the old pairing can never match it:
  unpair in the popup, then pair again with the new token.
- **Demo appears to do nothing.** Watch the bridge's stderr. "No user-paired
  Chrome tab is connected to the loopback bridge" means pairing, not the
  script, is the problem (see above). If the bridge accepts the command but
  nothing plays, confirm the host-page tab has the origin enabled (toolbar
  icon → enable capture) — the story receiver runs in the content scripts.

## Notes

- The MCP request times out after 120 s; keep demos comfortably shorter.
- Narration needs no user gesture in normal Chrome; when TTS is unavailable
  (headless, no voices), each step falls back to a timed wait.
- Audit entries for `demo_run`/`demo_stop` land in the existing bounded
  `storyBridgeAudit` log (extension storage), like every story command.

## Tests

```sh
cd packages/feedback-extension && npm test
```

`test/demo-script-policy.test.mjs` covers `demo_run` validation (including the
checked-in sample script); `test/demo-player.test.mjs` covers step sequencing,
first-error stop, cancellation, and overlay cleanup with mocked deps — no DOM,
no speech.
