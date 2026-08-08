# Autonomous paired-tab Story bridge

The MV3 extension can be paired with a local Kitsoki Story/MCP workflow for a
single LinkedIn tab. Pairing is the one-time authorization for autonomous MCP
control of that exact tab; there is no per-action confirmation modal.

## Safety boundary

- The server binds only to `127.0.0.1`; it has no HTTP endpoint or remote
  listener.
- Pairing requires a locally generated code entered by a human in the extension
  popup, after enabling `https://www.linkedin.com`; any page at that exact
  origin can be paired.
- The server accepts one paired tab, not a browser debugging connection.
- The MCP tool supports `navigate(url)`, `snapshot()`, `click(selector | target)`,
  `fill(selector, text)`, `press(key)`, `extract(selector?, captureEvidence?)`,
  and `run_script(steps)`.
  There is no route-specific workflow gate after pairing.
- Requests receive generated IDs and their action/outcome is retained in a
  bounded local audit log. Collected page text and replay payloads are not
  copied into that audit log.
- The tab used at pairing is the only tab the bridge addresses. Unpairing
  deletes the local pairing code and revokes that session.

## Install and pair

From this repository checkout:

```sh
cd /absolute/path/to/studio-sassfully/.capsules/workspaces/extension-local-test-20260730/packages/feedback-extension
npm run build
```

Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**,
and select the resulting `dist` directory. Reload that extension after future
builds. Open `https://www.linkedin.com/jobs/search/`, open the Sassfully popup,
and choose **Enable** for that origin.

Generate a pairing code and retain it only locally:

```sh
CODE="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
printf '%s\n' "$CODE"
```

In the popup, paste it under **Local Kitsoki Story bridge** and choose **Pair
this LinkedIn Jobs tab**. The extension reconnects to the bridge whenever it
is available; unpairing deletes the local code and closes the socket.

## Captured replay fixture

Use **Export replay fixture** in the popup to download one
`sassfully-replay-fixture.json` file. Unlike the ordinary JSONL manifest
export, this envelope includes only reviewed replay sidecars; it omits network,
console, error, and user-text payloads. It verifies that every reviewed replay
manifest entry has a stored payload, redacts sensitive values, and preserves
rrweb control/timing data for deterministic local extraction.

Run the fixture checks without opening a browser or contacting LinkedIn:

```sh
cd /absolute/path/to/packages/feedback-extension
npm run test:replay-fixture
```

The current workspace has no bundled Playwright/Puppeteer dependency, so the
fixture extractor is the deterministic headless prerequisite. A Chromium MV3
E2E runner should consume the exported envelope rather than inventing a
LinkedIn DOM fixture.

## MCP configuration

The server itself is the stdio MCP process. Configure the Story’s MCP client
with this equivalent command, replacing the code but retaining the absolute
path:

```toml
[mcp_servers.sassfully_linkedin_story]
command = "node"
args = ["/absolute/path/to/packages/feedback-extension/story-bridge/stdio-server.mjs", "--pairing-code", "YOUR_GENERATED_CODE"]
```

Restart the MCP client after changing its configuration. Its sole tool,
`linkedin_story`, acts immediately in the paired tab.

For example, navigate and extract visible text:

```json
{"action":"navigate","url":"https://www.linkedin.com/jobs/search-results/?keywords=product%20designer"}
```

```json
{"action":"extract","selector":".job-card-container","captureEvidence":true}
```

For an ordered script, use one call; it returns completed per-step results and
stops at the first error:

```json
{"action":"run_script","steps":[{"action":"fill","selector":"input[aria-label='Search by title']","text":"product designer"},{"action":"press","key":"ENTER"},{"action":"extract","selector":".job-card-container"}]}
```
