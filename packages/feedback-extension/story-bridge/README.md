# LinkedIn Jobs Story bridge

This is a local MCP stdio server for a single, explicitly paired Chrome tab.
It binds only to `127.0.0.1`, accepts one WebSocket connection with a pairing
code, and exposes one narrow tool: `linkedin_story`. Its action set is
`navigate`, `snapshot`, `click`, `fill`, `press`, `extract`, and `run_script`.

Pairing is the one-time authorization for an explicit autonomous session on
that tab. There is no per-action modal and no page-specific workflow gate.
Every command carries a generated request ID and the extension keeps a bounded
local outcome audit trail. The tool cannot switch tabs or connect to anything
other than the paired loopback bridge.

The exact tool arguments are: `navigate(url)`, `snapshot()`,
`click(selector | target)`, `fill(selector, text)`, `press(key)`,
`extract(selector?, captureEvidence?)`, and `run_script(steps)`. `target` is an accessible label used
when a selector is not supplied. `extract` returns visible matching text;
`captureEvidence:true` adds a lightweight capture marker, while existing rrweb
recording remains available through the extension's normal feedback flow.

`run_script` runs ordered basic steps, returns each completed result, and stops
at the first error. Example:

```json
{"action":"run_script","steps":[{"action":"fill","selector":"input[aria-label='Search by title']","text":"product designer"},{"action":"press","key":"ENTER"},{"action":"extract","selector":".job-card-container"}]}
```

## Embedded demoMode control

With `--allow-embedded-demo`, this same loopback server also exposes the
`embedded_demo` MCP tool to an app that has explicitly bound its own
`demoMode:true` page. It is zero-pairing only for that opt-in embedded page;
the extension path above remains user-paired. Its lifecycle is
`sessions → propose → validate → update? → push`, with CAS revisions and
current-tab semantic-anchor preflight. It also has `run`, `stop`, `resume`, and
explicitly-consented `evidence_start|stop|export`; it cannot navigate a page
or evaluate arbitrary code. Full instructions and capability boundaries are in
[`docs/embedded-demo-control.md`](../../../docs/embedded-demo-control.md).

The extension accepts the bridge only after the user has enabled the exact
`https://www.linkedin.com` origin and entered the code
in the extension popup. Commands apply only to that paired tab until it is
unpaired. The paired session is intentionally direct: use unpair to revoke it.

Run it with a code you generate yourself:

```sh
CODE="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
node packages/feedback-extension/story-bridge/stdio-server.mjs --pairing-code "$CODE"
```

Use that same code in the extension popup. For an MCP client, configure the
same command and fixed code; do not put this server on a network interface.

For Codex, add the following to the project-scoped `.codex/config.toml` (with
your generated code substituted), then start a new Codex session:

```toml
[mcp_servers.sassfully_linkedin_story]
command = "node"
args = ["/absolute/path/to/packages/feedback-extension/story-bridge/stdio-server.mjs", "--pairing-code", "YOUR_GENERATED_CODE"]
```
