import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountStageLayer, computeStageBox, STAGE_LAYER_Z } from '../src/stage-layer.mjs';

const scene = JSON.parse(readFileSync(new URL('../examples/sample-scene.json', import.meta.url), 'utf8'));

/* ── DOM double, per the demo-player test convention (no jsdom in this repo) ── */

function fakeElement(tag = 'div') {
  return {
    tag, style: {}, children: [], attrs: {}, parent: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
  };
}

const makeDocument = () => {
  const documentElement = fakeElement('html');
  return {
    documentElement,
    createElement: (tag) => fakeElement(tag),
    defaultView: { innerWidth: 1000, innerHeight: 600 },
  };
};

/** A stand-in for the vendored mountStagePlayer: records mounts, ends on demand. */
function makeFakePlayer() {
  const calls = [];
  const mountPlayer = (host, opts) => {
    const player = {
      host, opts, destroyed: 0,
      svg: fakeElement('svg'),
      destroy() { this.destroyed += 1; },
      end: () => opts.onEnd?.(),
    };
    calls.push(player);
    return player;
  };
  return { calls, mountPlayer };
}

/* ── computeStageBox: pure placement math ──────────────────────────────────── */

const VP = { w: 1000, h: 600 };
const ASPECT = 2; // 100x50 stage units

test('full placement covers the viewport', () => {
  assert.deepEqual(computeStageBox({ mode: 'full' }, VP, ASPECT), { left: 0, top: 0, width: 1000, height: 600 });
  assert.deepEqual(computeStageBox(undefined, VP, ASPECT), { left: 0, top: 0, width: 1000, height: 600 });
});

test('dock placement pins a sized box to a corner or edge', () => {
  const bl = computeStageBox({ mode: 'dock', edge: 'bottom-left' }, VP, ASPECT);
  assert.equal(bl.left, 16);
  assert.equal(bl.top, 600 - bl.height - 16);
  assert.equal(bl.width, 380);
  assert.equal(bl.height, 190);

  const tr = computeStageBox({ mode: 'dock', edge: 'top-right', size: 0.5 }, VP, ASPECT);
  assert.equal(tr.width, 500);
  assert.equal(tr.left, 1000 - 500 - 16);
  assert.equal(tr.top, 16);

  const bottom = computeStageBox({ mode: 'dock', edge: 'bottom' }, VP, ASPECT);
  assert.equal(bottom.left, Math.round((1000 - bottom.width) / 2));

  assert.throws(() => computeStageBox({ mode: 'dock', edge: 'center' }, VP, ASPECT), /unknown dock edge/);
});

test('anchor placement stands the box beside the anchor bbox, inside the viewport', () => {
  // Room below: box sits under the anchor, horizontally centered on it.
  const below = computeStageBox({ mode: 'anchor', anchor: { x: 100, y: 50, w: 300, h: 40 } }, VP, ASPECT);
  assert.equal(below.top, 50 + 40 + 8);
  assert.equal(below.left, Math.round(100 + 150 - below.width / 2));

  // No room below: box steps above the anchor.
  const above = computeStageBox({ mode: 'anchor', anchor: { x: 100, y: 500, w: 300, h: 60 } }, VP, ASPECT);
  assert.ok(above.top + above.height <= 500, `expected above the anchor, got top=${above.top} h=${above.height}`);

  assert.throws(() => computeStageBox({ mode: 'anchor' }, VP, ASPECT), /anchor placement/);
});

/* ── mountStageLayer: container lifecycle ──────────────────────────────────── */

test('mount creates a fixed, transparent, pointer-events:none layer; destroy removes it', () => {
  const doc = makeDocument();
  const layer = mountStageLayer(doc, { mountPlayer: makeFakePlayer().mountPlayer });

  assert.equal(doc.documentElement.children.length, 1);
  const el = doc.documentElement.children[0];
  assert.equal(el.attrs['data-demo-stage-layer'], '');
  assert.equal(el.style.position, 'fixed');
  assert.equal(el.style.pointerEvents, 'none');
  assert.equal(el.style.background, 'transparent');
  assert.equal(el.style.zIndex, String(STAGE_LAYER_Z));

  layer.destroy();
  assert.equal(doc.documentElement.children.length, 0);
});

test('zIndex is configurable', () => {
  const doc = makeDocument();
  mountStageLayer(doc, { zIndex: 42, mountPlayer: makeFakePlayer().mountPlayer });
  assert.equal(doc.documentElement.children[0].style.zIndex, '42');
});

test('playScene mounts the player in a placed box and resolves on scene end', async () => {
  const doc = makeDocument();
  const fake = makeFakePlayer();
  const layer = mountStageLayer(doc, { mountPlayer: fake.mountPlayer });

  const done = layer.playScene({ scene, placement: { mode: 'dock', edge: 'bottom-left' } });
  assert.equal(fake.calls.length, 1);
  const p = fake.calls[0];

  // The player got a resolved cast, roster, and a built timeline.
  assert.ok(p.opts.chars.pip, 'cast resolved from scene.cast');
  assert.deepEqual(p.opts.roster, ['pip']);
  assert.equal(p.opts.timeline.beats.length, 3);
  assert.equal(p.opts.autoplay, true);

  // The stage box carries the computed dock geometry and blocks no pointers.
  const host = p.host;
  assert.equal(host.attrs['data-demo-stage-box'], '');
  assert.equal(host.style.left, '16px');
  assert.equal(host.style.pointerEvents, 'none');
  assert.equal(p.svg.attrs.preserveAspectRatio, 'xMidYMax meet');

  p.end();                                   // scene finishes
  await done;                                // promise resolves
  assert.equal(p.destroyed, 1);
  assert.equal(layer.container.children.length, 0, 'stage box removed after end');
});

test('stop() ends the running scene early and resolves its promise', async () => {
  const doc = makeDocument();
  const fake = makeFakePlayer();
  const layer = mountStageLayer(doc, { mountPlayer: fake.mountPlayer });

  const done = layer.playScene({ scene });
  layer.stop();
  await done;
  assert.equal(fake.calls[0].destroyed, 1);
  assert.equal(layer.container.children.length, 0);
});

test('a second playScene supersedes the first (one scene at a time)', async () => {
  const doc = makeDocument();
  const fake = makeFakePlayer();
  const layer = mountStageLayer(doc, { mountPlayer: fake.mountPlayer });

  const first = layer.playScene({ scene });
  const second = layer.playScene({ scene });
  await first;                               // superseded → resolved
  assert.equal(fake.calls[0].destroyed, 1);
  assert.equal(fake.calls.length, 2);
  fake.calls[1].end();
  await second;
  layer.destroy();
});

test('playScene after destroy rejects', async () => {
  const doc = makeDocument();
  const layer = mountStageLayer(doc, { mountPlayer: makeFakePlayer().mountPlayer });
  layer.destroy();
  await assert.rejects(() => layer.playScene({ scene }), /destroyed/);
});
