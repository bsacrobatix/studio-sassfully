import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateScene, formatFindings } from '../vendor/slidey-stage/validate.mjs';
import { resolveCast, rosterOf, buildTimeline } from '../vendor/slidey-stage/engine.mjs';
import { stageMarkup, backdropSvg, BACKDROPS } from '../vendor/slidey-stage/render.mjs';

const scene = JSON.parse(readFileSync(new URL('../examples/sample-scene.json', import.meta.url), 'utf8'));

test('the sample scene passes the vendored validator clean', () => {
  const report = validateScene(scene, scene.cast, null);
  const findings = report.findings ?? report;
  assert.deepEqual(findings, [], formatFindings(findings));
});

test('PATCH(demo-stage): transparent backdrop emits no markup at all', () => {
  assert.ok(BACKDROPS.includes('transparent'));
  assert.equal(backdropSvg(scene.stage), '');
  // Upstream 'none' still paints its wall — the patch must not change that.
  assert.match(backdropSvg({ ...scene.stage, backdrop: 'none' }), /<rect/);
});

test('stageMarkup renders the cast but nothing opaque behind it', () => {
  const chars = resolveCast(scene.cast);
  const roster = rosterOf(scene, scene.cast);
  buildTimeline(scene, chars, null);   // sanity: resolvable end to end
  const svg = stageMarkup(scene, chars, roster);
  assert.match(svg, /stage-actors/);
  assert.match(svg, /st-a-pip/);
  // The caption/bubble carry their own gradients; only the backdrop *wall*
  // gradient (id `st-wall`) must be gone in a transparent stage.
  assert.ok(!svg.includes('st-wall'), 'no backdrop wall in a transparent stage');
});
