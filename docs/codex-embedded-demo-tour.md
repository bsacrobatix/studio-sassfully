# Codex embedded-demo tour — fresh-session brief

Use the explicit local `sassfully-embedded-demo` MCP server for a tour. It is
the supported Sassfully surface for a page which has deliberately bound
`demoMode:true` plus its loopback `demoBridge`; it exposes only
`embedded_demo`, not arbitrary browser evaluation, navigation, credentials or
an extension-pairing control.

This is intentionally **not** the static Kitsoki Studio MCP. Kitsoki's native
`kitsoki-authoring` tools (`browser.status`, `demo.*`, `evidence.*`) are minted
for a single selected application session with a short-lived bearer and cannot
be safely listed in a project-wide Codex config. The explicit embedded-demo
MCP has no bearer and binds only to an already-open loopback demo page.

## One-time install and configuration

From a checkout that contains this script, install the pinned minimal artifact:

```sh
node packages/feedback-extension/scripts/install-embedded-demo-mcp.mjs
```

It prints a revisioned path such as
`~/.local/share/sassfully/embedded-demo-mcp/<source-sha>`. Its `manifest.json`
records the exact source commit, three permitted files, and the combined
content SHA-256. Do not point Codex at a temporary worktree or copy a token
into its configuration.

The workspace configurations must both declare:

```json
"sassfully-embedded-demo": {
  "command": "node",
  "args": [
    "/Users/brad/.local/share/sassfully/embedded-demo-mcp/<source-sha>/story-bridge/stdio-server.mjs",
    "--port", "8931", "--allow-embedded-demo"
  ]
}
```

The server listens only on `127.0.0.1:8931`; embedded mode has no static
credential. A second live Codex session cannot share the same port, so finish
or close the first session before starting another one.

## Bring up the page

Run a consumer app through a current Kitsoki app-dev surface. Its application
definition must opt in declaratively:

```yaml
application:
  sassfully_demo:
    enabled: true
    bridge_port: 8931
```

The generic toolbar mounts the vendored resident player and creates only
`ws://127.0.0.1:8931/embedded-demo`. `bridge_port` accepts only 1024–65535;
an application cannot set a host, path, code, bearer, script or remote URL.
Open the app URL in the in-app Browser. The toolbar should show **Sassfully
ready** and the app page must remain open; do not use a reload as a tour step.

## Fresh Codex prompt

> Use the `sassfully-embedded-demo` MCP tool `embedded_demo` to give me a
> live tour of the already-open local application. First call `sessions` and
> stop if it is empty. Propose a `sassfully/demo-script/v1` with persistent
> Nova/Pip presentation, `dim:false` on every spotlight, and one real
> low-risk click or fill. Validate the exact draft against the returned
> session, use CAS `update` only if revision changes are needed, validate
> again, then call `evidence_start` with `permission:true`, `push`,
> `evidence_stop`, and `evidence_export`. Report the session id, draft id,
> revision, action receipt, stage receipt, drift, evidence export, and whether
> the page reloaded. Never use page eval, navigation, generic RPC, or a
> static credential.

Expected tool discovery is one MCP tool: `embedded_demo`. Its actions are
`sessions`, `propose`, `validate`, `update`, `push`, `run`, `stop`, `resume`,
`evidence_start`, `evidence_stop`, and `evidence_export`.

## Troubleshooting

- `sessions: []`: the app is not open, `sassfully_demo` is missing, or its
  `bridge_port` does not match this server. Keep the page open; the binding
  reconnects to the same port after the bridge restarts.
- `validate` errors: repair the typed script, then CAS-update and validate the
  new revision. A prior validation never authorizes a changed revision.
- `blocked_user_gesture`: the human must click the visible Enable audio
  control; use `resume` afterward. Never bypass this with speech synthesis.
- `EADDRINUSE`: another bridge already owns 8931. Stop that MCP client rather
  than changing an application's bridge to a remote endpoint.
- A push receipt is an execution acknowledgement, not proof speakers are
  audible. Inspect the visible persistent presenter, outline spotlight, and
  changed form/button state in the Browser.
