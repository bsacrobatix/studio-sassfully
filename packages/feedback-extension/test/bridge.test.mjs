import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionBridge } from "../src/bridge.mjs";
import { createHostBridge } from "../src/deps.mjs";
import { fakeWindow, settle } from "./helpers.mjs";

const replayProvider = { id: "ext-replay", label: "Session replay", capture: () => [{ kind: "replay", label: "Session replay", payload: { events: [1, 2] }, transport: "sidecar-json" }] };

test("handshake either way round: offer, accept, providers delivered to the host", async () => {
  for (const hostFirst of [true, false]) {
    const win = fakeWindow();
    let delivered = null; let acceptedIds = null;
    const startHost = () => createHostBridge({ window: win, producer: "acme-docs", artifactId: "doc-1", onProviders(providers) { delivered = providers; } });
    const startExt = () => createExtensionBridge({ window: win, providers: [replayProvider], sessionId: "s1", onAccepted(ids) { acceptedIds = ids; } });
    const first = hostFirst ? startHost() : startExt();
    await settle();
    const second = hostFirst ? startExt() : startHost();
    await settle(); await settle();
    assert.deepEqual(acceptedIds, ["ext-replay"], `hostFirst=${hostFirst}`);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].id, "ext-replay");
    const items = await delivered[0].capture();
    assert.equal(items[0].kind, "replay");
    first.stop(); second.stop();
  }
});

test("extension exposes bridged state and host identity after accept", async () => {
  const win = fakeWindow();
  const ext = createExtensionBridge({ window: win, providers: [replayProvider] });
  assert.equal(ext.bridged, false);
  const host = createHostBridge({ window: win, producer: "acme-docs", artifactId: "doc-1", onProviders() {} });
  await settle(); await settle();
  assert.equal(ext.bridged, true);
  assert.deepEqual(ext.hostInfo, { producer: "acme-docs", artifactId: "doc-1" });
  ext.stop(); host.stop();
});

test("host accept() filters the offer; unaccepted captures fail", async () => {
  const win = fakeWindow();
  const failing = { id: "ext-network", label: "Network", capture: () => { throw new Error("boom"); } };
  let delivered = null;
  const ext = createExtensionBridge({ window: win, providers: [replayProvider, failing] });
  const host = createHostBridge({ window: win, accept: (offered) => offered.map((p) => p.id).filter((id) => id !== "ext-replay"), onProviders(providers) { delivered = providers; } });
  await settle(); await settle();
  assert.deepEqual(delivered.map((p) => p.id), ["ext-network"]);
  await assert.rejects(() => delivered[0].capture(), /boom/);
  ext.stop(); host.stop();
});

test("ext-bye rejects pending captures and notifies the host", async () => {
  const win = fakeWindow();
  let delivered = null; let bye = false;
  const slow = { id: "ext-replay", label: "Replay", capture: () => new Promise(() => {}) };
  const ext = createExtensionBridge({ window: win, providers: [slow] });
  const host = createHostBridge({ window: win, timeoutMs: 5000, onProviders(providers) { delivered = providers; }, onBye() { bye = true; } });
  await settle(); await settle();
  const pending = delivered[0].capture().then(() => null, (error) => error);
  await settle();
  ext.stop();
  await settle();
  assert.match((await pending).message, /disconnected/);
  assert.equal(bye, true);
  host.stop();
});

test("messages from another session or missing protocol tag are ignored", async () => {
  const win = fakeWindow();
  let delivered = null;
  const ext = createExtensionBridge({ window: win, providers: [replayProvider], sessionId: "mine" });
  const host = createHostBridge({ window: win, onProviders(providers) { delivered = providers; } });
  await settle(); await settle();
  win.postMessage({ $protocol: "sassfully-ext/bridge/v1", sessionId: "other", type: "capture", id: "ext-replay", nonce: "x" });
  win.postMessage({ type: "capture", id: "ext-replay", nonce: "y" });
  await settle();
  assert.equal(delivered.length, 1);
  ext.stop(); host.stop();
});
