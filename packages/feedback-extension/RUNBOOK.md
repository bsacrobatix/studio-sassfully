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

5. **Start the story bridge** (prints a one-time pairing code):

   ```sh
   node packages/feedback-extension/story-bridge/stdio-server.mjs
   ```

6. **Pair via the popup**: with the host-page tab focused, open the extension
   popup, paste the pairing code (port 8765), and click Pair. The loopback
   demo host is pairable alongside LinkedIn for this POC.

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

   (Re-pair the popup with `<CODE...>` if you restart the server with a new
   code. From an MCP client, simply call tool `linkedin_story` with
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
  send the `demo_run`, and retry while no tab is paired. The pairing code is
  per server instance: pair the popup against the code THIS run prints on
  stderr, and the queued demo starts. Without `--exec` it prints the exact
  JSON-RPC lines to feed to a bridge's stdin. `--stop --exec` sends
  `demo_stop`.

## Troubleshooting

- **Port 8765 is taken (or the bridge pairs but behaves oddly).** The default
  port collides with common local services — Docker helpers and Agent Mail
  both like 8765. Check who owns it with `lsof -nP -iTCP:8765 -sTCP:LISTEN`;
  if it isn't your bridge, start the bridge on another port
  (`--port 8877`) and enter that port when pairing in the popup. Verify the
  bridge is the listener before pairing.
- **Popup says "paired" but nothing happens.** The popup's paired badge can be
  stale while the underlying socket is down (a fix making it honest is in
  flight, but verify anyway). Check for a live connection:
  `lsof -nP -iTCP:<port> | grep ESTABLISHED` — you should see Chrome connected
  to the bridge's port. No ESTABLISHED line means the extension is not
  actually connected; re-pair before blaming the demo script.
- **Restarted the bridge? Unpair, then re-pair.** Pairing codes are one-time
  and per server instance: a new bridge process mints a new code (unless you
  pass `--pairing-code`), and the extension will not reconnect to it on its
  own. In the popup: unpair, then pair again with the new code.
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
