import test from "node:test";
import assert from "node:assert/strict";
import { authorTour, exportTour, replayTour } from "@sassfully/browser-tour-core";

test("an unrelated synthetic host validates, authors, exports and replays v2", async () => {
  const manifest = authorTour({ version: 2, id: "unrelated-fixture", origin: "https://fixture.invalid", steps: [{ id: "welcome", kind: "highlight", target: [{ testid: "obsolete" }, { role: "button", name: "Welcome" }] }] });
  assert.equal(JSON.parse(exportTour(manifest)).version, 2);
  const replay = await replayTour(manifest, { driver: { origin: () => "https://fixture.invalid", find: async (anchor) => anchor.testid ? [] : [{ neutral: true }], highlight: async () => {} } });
  assert.equal(replay.events[0].type, "heal");
});
