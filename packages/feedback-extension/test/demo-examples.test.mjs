// Every checked-in demo script in examples/ must pass the same validation the
// extension and the stdio server apply to a live demo_run. This test reads the
// shared policy module (never modifies it) so docs/examples cannot drift from
// the enforced contract.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_SCRIPT_VERSION, validateStoryCommand } from "../ext/story-bridge-policy.mjs";

const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples");
const names = (await readdir(examplesDir)).filter((name) => name.endsWith(".json")).sort();

test("examples/ contains the documented demo scripts", () => {
  for (const expected of ["host-page-demo.json", "host-page-demo-minimal.json", "host-page-demo-tour.json"]) {
    assert.ok(names.includes(expected), `missing examples/${expected}`);
  }
});

for (const name of names) {
  test(`examples/${name} is a valid demo_run script`, async () => {
    const script = JSON.parse(await readFile(path.join(examplesDir, name), "utf8"));
    assert.equal(script.version, DEMO_SCRIPT_VERSION, "examples pin the explicit version string");
    const check = validateStoryCommand({ action: "demo_run", script });
    assert.equal(check.ok, true, `examples/${name}: ${check.error ?? "ok"}`);
  });
}

test("the minimal example really is minimal", async () => {
  const script = JSON.parse(await readFile(path.join(examplesDir, "host-page-demo-minimal.json"), "utf8"));
  assert.equal(script.steps.length, 2);
});
