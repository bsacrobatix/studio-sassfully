import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveCast, rosterOf, buildTimeline, stageStateAt, actorTransforms, estimateSpeech,
} from '../vendor/slidey-stage/engine.mjs';

const scene = JSON.parse(readFileSync(new URL('../examples/sample-scene.json', import.meta.url), 'utf8'));

const setup = () => {
  const chars = resolveCast(scene.cast);
  const roster = rosterOf(scene, scene.cast);
  const timeline = buildTimeline(scene, chars, null);   // no audio → word-count estimates
  return { chars, roster, timeline };
};

test('timeline builds without audio via the word-count fallback', () => {
  const { timeline } = setup();
  assert.equal(timeline.beats.length, 3);
  assert.equal(timeline.measured, 0);                  // nothing has a real clip
  assert.ok(timeline.total > 0);
  // Beat durations follow the estimate (or the explicit dur when longer).
  assert.equal(timeline.beats[0].dur, estimateSpeech(scene.beats[0].narration));
  assert.equal(timeline.beats[2].dur, Math.max(2.6, estimateSpeech(scene.beats[2].line)));
  // Starts are cumulative.
  assert.equal(timeline.beats[1].start, timeline.beats[0].dur);
});

test('stageStateAt is a pure function of time: same t, same state', () => {
  const { roster, timeline } = setup();
  for (const t of [0, 0.5, timeline.beats[1].start + 0.2, timeline.total - 0.01, timeline.total + 5]) {
    const a = stageStateAt(scene, timeline, t, roster);
    const b = stageStateAt(scene, timeline, t, roster);
    assert.deepEqual(a, b, `state at t=${t} not stable`);
  }
});

test('seeking backwards replays exactly (no accumulated state)', () => {
  const { roster, timeline } = setup();
  const t = timeline.beats[1].start + 0.3;
  const before = stageStateAt(scene, timeline, t, roster);
  // "Play" past the end, then come back — must be byte-identical.
  stageStateAt(scene, timeline, timeline.total + 1, roster);
  const after = stageStateAt(scene, timeline, t, roster);
  assert.deepEqual(after, before);
});

test('the sample scene acts out: walk on, point + speak, walk off', () => {
  const { roster, timeline } = setup();
  const [b0, b1, b2] = timeline.beats;

  // Mid-entrance: visible, walking in from the left (x below its target).
  const enter = stageStateAt(scene, timeline, b0.start + b0.dur * 0.5, roster).actors.pip;
  assert.equal(enter.visible, true);
  assert.equal(enter.state, 'walk');
  assert.ok(enter.x < 30, `mid-entrance x=${enter.x} should still be short of 30`);

  // Entrance landed by the speaking beat; pointing and speaking.
  const talk = stageStateAt(scene, timeline, b1.start + 0.1, roster);
  assert.equal(Math.round(talk.actors.pip.x), 30);
  assert.equal(talk.actors.pip.state, 'point');
  assert.equal(talk.actors.pip.speaking, true);
  assert.equal(talk.beat.index, 1);

  // After the exit beat completes the actor is gone.
  const gone = stageStateAt(scene, timeline, b2.start + b2.dur + 0.1, roster).actors.pip;
  assert.equal(gone.visible, false);
});

test('actorTransforms is deterministic through the vendored resolve pipeline', () => {
  const { chars, roster, timeline } = setup();
  const t = timeline.beats[1].start + 0.25;
  const st = stageStateAt(scene, timeline, t, roster);
  const a = actorTransforms(chars.pip, st.actors.pip, t, scene.stage.ground);
  const b = actorTransforms(chars.pip, st.actors.pip, t, scene.stage.ground);
  assert.deepEqual(a, b);
  assert.match(a.root, /^translate\(/);
  assert.ok(Object.keys(a.parts).length > 0, 'vector character has posed parts');
});
