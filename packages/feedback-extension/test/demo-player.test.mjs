import test from "node:test";
import assert from "node:assert/strict";
import { createDemoRunState, demoActionToStoryCommand, runDemoScript } from "../ext/content/demo-player.mjs";

function makeDeps({ targets = {}, failAct = false } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      waitForTarget: async (selector) => { calls.push(["wait", selector]); return selector in targets ? targets[selector] : { selector }; },
      spotlight: (el) => calls.push(["spotlight", el.selector]),
      caption: (text) => calls.push(["caption", text]),
      pulse: (el) => calls.push(["pulse", el.selector]),
      narrate: async (text) => calls.push(["narrate", text]),
      act: async (action) => { calls.push(["act", action.kind, action.selector ?? action.value]); if (failAct) throw new Error("boom"); },
      delay: async (ms) => calls.push(["delay", ms]),
      clear: () => calls.push(["clear"]),
    },
  };
}

test("demo actions translate to the existing story-command shapes", () => {
  assert.deepEqual(demoActionToStoryCommand({ kind: "click", selector: "#go" }), { action: "click", selector: "#go" });
  assert.deepEqual(demoActionToStoryCommand({ kind: "fill", selector: "#name", value: "Ada" }), { action: "fill", selector: "#name", text: "Ada" });
  assert.deepEqual(demoActionToStoryCommand({ kind: "press", value: "Enter" }), { action: "press", key: "Enter" });
});

test("a step runs spotlight, caption, narration, pulse, action, dwell in order and clears at the end", async () => {
  const { deps, calls } = makeDeps();
  const script = { steps: [
    { id: "s1", spotlight: "h1", caption: "Hi", narration: "Hello there", dwellMs: 300 },
    { id: "s2", spotlight: "#name", action: { kind: "fill", selector: "#name", value: "Ada" }, dwellMs: 100 },
  ] };
  const outcome = await runDemoScript({ script, deps });
  assert.equal(outcome.completed, true);
  assert.deepEqual(outcome.completedSteps.map((s) => s.id), ["s1", "s2"]);
  assert.deepEqual(calls, [
    ["wait", "h1"], ["spotlight", "h1"], ["caption", "Hi"], ["narrate", "Hello there"], ["delay", 300],
    ["wait", "#name"], ["spotlight", "#name"], ["wait", "#name"], ["pulse", "#name"], ["act", "fill", "#name"], ["delay", 100],
    ["clear"],
  ]);
});

test("a missing spotlight target stops the run at the first error and still clears", async () => {
  const { deps, calls } = makeDeps({ targets: { ".gone": null } });
  const script = { steps: [{ caption: "ok" }, { id: "s2", spotlight: ".gone" }, { caption: "never" }] };
  await assert.rejects(() => runDemoScript({ script, deps }), /s2: spotlight target not found: \.gone/);
  assert.deepEqual(calls.at(-1), ["clear"]);
  assert.ok(!calls.some(([kind, value]) => kind === "caption" && value === "never"), "later steps never run");
});

test("an action failure carries the step label and stops the run", async () => {
  const { deps } = makeDeps({ failAct: true });
  const script = { steps: [{ id: "sX", action: { kind: "click", selector: "#go" } }] };
  await assert.rejects(() => runDemoScript({ script, deps }), /sX: boom/);
});

test("cancellation between steps stops the run without an error", async () => {
  const state = createDemoRunState();
  const { deps, calls } = makeDeps();
  deps.delay = async () => { state.cancel(); calls.push(["delay"]); };
  const script = { steps: [{ caption: "one" }, { caption: "two" }] };
  const outcome = await runDemoScript({ script, deps, state });
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.completedSteps.length, 1);
  assert.ok(!calls.some(([kind, value]) => kind === "caption" && value === "two"));
  assert.deepEqual(calls.at(-1), ["clear"]);
});

test("an invalid script is rejected before any step runs", async () => {
  const { deps, calls } = makeDeps();
  await assert.rejects(() => runDemoScript({ script: { steps: [] }, deps }), /non-empty steps array/);
  assert.deepEqual(calls, [], "validation happens before side effects, including clear");
});
