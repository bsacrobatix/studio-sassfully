import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedSynthesize, cacheKeyFor } from '../src/cache.mjs';

function mockSynth() {
  const calls = [];
  const fn = async (text, opts = {}) => {
    calls.push({ text, opts });
    return {
      mp3: Buffer.from(`MP3:${text}:${opts.voice ?? 'default'}`),
      durationMs: 1234,
      estimated: false,
    };
  };
  return { fn, calls };
}

test('cacheKeyFor is stable and distinguishes every audio-affecting input', () => {
  const base = { text: 'hi', voice: 'v', rate: '+0%', pitch: '+0Hz' };
  assert.equal(cacheKeyFor(base), cacheKeyFor({ ...base }));
  assert.match(cacheKeyFor(base), /^[0-9a-f]{32}$/);
  for (const change of [{ text: 'yo' }, { voice: 'w' }, { rate: '-6%' }, { pitch: '+4Hz' }]) {
    assert.notEqual(cacheKeyFor({ ...base, ...change }), cacheKeyFor(base), JSON.stringify(change));
  }
});

test('cachedSynthesize synthesizes once, then serves hits from disk', async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'demo-tts-cache-test-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const { fn, calls } = mockSynth();

  const first = await cachedSynthesize('hello world', { cacheDir, synthesize: fn });
  assert.equal(first.cacheHit, false);
  assert.equal(first.durationMs, 1234);
  assert.equal(calls.length, 1);

  const second = await cachedSynthesize('hello world', { cacheDir, synthesize: fn });
  assert.equal(second.cacheHit, true);
  assert.equal(second.durationMs, 1234);
  assert.deepEqual(second.mp3, first.mp3);
  assert.equal(calls.length, 1, 'hit must not re-synthesize');

  // Different opts → different entry → new synthesis.
  const third = await cachedSynthesize('hello world', { cacheDir, synthesize: fn, voice: 'en-GB-RyanNeural' });
  assert.equal(third.cacheHit, false);
  assert.equal(calls.length, 2);

  // No leftover tmp files from the atomic writes.
  const leftovers = (await readdir(cacheDir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('cachedSynthesize requires a cacheDir', async () => {
  await assert.rejects(() => cachedSynthesize('x', {}), /cacheDir/);
});
