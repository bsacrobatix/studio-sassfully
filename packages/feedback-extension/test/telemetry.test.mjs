import test from "node:test";
import assert from "node:assert/strict";
import { startMainTelemetry, createTelemetryClient, telemetryProviders } from "../src/telemetry-main.mjs";
import { fakeWindow, settle } from "./helpers.mjs";

test("relay answers capture requests with redacted in-page telemetry", async () => {
  const win = fakeWindow();
  win.fetch = async () => ({ status: 200, ok: true, headers: new Headers({ "content-type": "application/json" }) });
  const main = startMainTelemetry({ window: win });
  assert.deepEqual(main.providerIds, ["network", "console", "error"]);
  await win.fetch("https://api.example/data?token=sekrit", { headers: { Authorization: "Bearer x" } });
  win.console.warn("careful");
  const client = createTelemetryClient({ window: win });
  const [network] = await client.capture("network");
  assert.equal(network.kind, "network");
  assert.equal(network.payload.entries.length, 1);
  assert.match(network.payload.entries[0].request.url, /token=%5Bredacted%5D/);
  assert.deepEqual(network.payload.entries[0].request.headers.find((h) => h.name.toLowerCase() === "authorization"), { name: "authorization", value: "[redacted]" });
  const [consoleItem] = await client.capture("console");
  assert.equal(consoleItem.payload.entries[0].text, "careful");
  client.stop(); main.stop();
});

test("unknown provider ids reject; stopped relay times out the client", async () => {
  const win = fakeWindow();
  const main = startMainTelemetry({ window: win });
  const client = createTelemetryClient({ window: win, timeoutMs: 30 });
  await assert.rejects(() => client.capture("nope"), /unknown provider/);
  main.stop();
  await assert.rejects(() => client.capture("network"), /timed out/);
  client.stop();
});

test("telemetryProviders map remote ids to reporter-shaped ext providers", async () => {
  const win = fakeWindow();
  const main = startMainTelemetry({ window: win });
  const client = createTelemetryClient({ window: win });
  const providers = telemetryProviders(client);
  assert.deepEqual(providers.map((p) => p.id), ["ext-network", "ext-console", "ext-error"]);
  const items = await providers[2].capture();
  assert.equal(items[0].kind, "error");
  client.stop(); main.stop();
});
