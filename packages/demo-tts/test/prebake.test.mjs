import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prebake, validateScript, SCRIPT_VERSION } from '../src/prebake.mjs';

const script = (steps) => ({ version: SCRIPT_VERSION, steps });

function mockSynth() {
  const calls = [];
  const fn = async (text) => {
    calls.push(text);
    return { mp3: Buffer.from(`MP3:${text}`), durationMs: 100 * text.length, estimated: false };
  };
  return { fn, calls };
}

test('validateScript enforces version and steps shape', () => {
  assert.throws(() => validateScript(null), /must be an object/);
  assert.throws(() => validateScript({}), /script\.version/);
  assert.throws(() => validateScript({ version: 'other/v2', steps: [] }), /script\.version/);
  assert.throws(() => validateScript(script([])), /non-empty array/);
  assert.throws(() => validateScript({ version: SCRIPT_VERSION }), /non-empty array/);
  assert.equal(validateScript(script([{ id: 's1' }])).length, 1);
});

test('prebake writes one clip per narrated step plus a manifest', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'demo-tts-prebake-test-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const { fn, calls } = mockSynth();

  const { manifest, manifestPath } = await prebake(script([
    { id: 's1', narration: 'first step', caption: 'one' },
    { id: 's2', caption: 'no narration here' },
    { id: 's3', narration: 'third step speaks' },
  ]), { outDir, synthesize: fn });

  // Only narrated steps synthesize, in order.
  assert.deepEqual(calls, ['first step', 'third step speaks']);

  // Manifest shape: [{stepId, file, durationMs}] (+ estimated flag).
  assert.deepEqual(manifest, [
    { stepId: 's1', file: 's1.mp3', durationMs: 1000, estimated: false },
    { stepId: 's3', file: 's3.mp3', durationMs: 1700, estimated: false },
  ]);

  // manifest.json on disk matches what was returned.
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest);

  // The clips exist and carry the synthesized bytes.
  for (const entry of manifest) {
    const bytes = await readFile(join(outDir, entry.file));
    assert.ok(bytes.length > 0);
  }
});

test('prebake sanitizes hostile step ids into safe filenames', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'demo-tts-prebake-test-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));

  const { manifest } = await prebake(script([
    { id: '../../evil step', narration: 'contained' },
    { narration: 'no id at all' },
  ]), { outDir, synthesize: mockSynth().fn });

  assert.equal(manifest[0].file, '.._.._evil_step.mp3');
  assert.equal(manifest[1].stepId, 'step-2');
  assert.equal(manifest[1].file, 'step-2.mp3');
  for (const entry of manifest) {
    assert.ok(!entry.file.includes('/'));
    assert.ok((await stat(join(outDir, entry.file))).isFile());
  }
});

test('prebake requires an outDir and a valid script', async () => {
  await assert.rejects(() => prebake(script([{ id: 's1', narration: 'x' }]), {}), /outDir/);
  await assert.rejects(
    () => prebake({ version: 'nope', steps: [{}] }, { outDir: tmpdir(), synthesize: mockSynth().fn }),
    /script\.version/,
  );
});
