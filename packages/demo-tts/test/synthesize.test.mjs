import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesize, validateText, estimateDurationMs,
  edgeTtsAvailable, ffprobeAvailable,
  DEFAULT_VOICE, MAX_TEXT_LENGTH,
} from '../src/synthesize.mjs';

test('validateText enforces the demo-script bounds', () => {
  assert.equal(validateText('hello'), 'hello');
  assert.throws(() => validateText(''), /non-empty/);
  assert.throws(() => validateText('   '), /non-empty/);
  assert.throws(() => validateText(42), /must be a string/);
  assert.throws(() => validateText(null), /must be a string/);
  assert.equal(validateText('x'.repeat(MAX_TEXT_LENGTH)).length, MAX_TEXT_LENGTH);
  assert.throws(
    () => validateText('x'.repeat(MAX_TEXT_LENGTH + 1)),
    new RegExp(`exceeds ${MAX_TEXT_LENGTH}`),
  );
});

test('synthesize rejects out-of-bounds text without invoking the CLI', async () => {
  await assert.rejects(() => synthesize(''), /non-empty/);
  await assert.rejects(() => synthesize('x'.repeat(MAX_TEXT_LENGTH + 1)), /exceeds/);
});

test('estimateDurationMs scales with word count at ~155 wpm', () => {
  // 155 words → exactly one minute.
  const words155 = Array.from({ length: 155 }, (_, i) => `w${i}`).join(' ');
  assert.equal(estimateDurationMs(words155), 60_000);
  // Floor: a one-word clip is never 0ms.
  assert.ok(estimateDurationMs('hi') >= 300);
  // Monotonic: more words, longer estimate.
  assert.ok(estimateDurationMs(words155) > estimateDurationMs('just five words right here'));
});

test('default voice matches slidey', () => {
  assert.equal(DEFAULT_VOICE, 'en-AU-NatashaNeural');
});

// Live synthesis: skipped unless edge-tts is actually on PATH.
const edge = edgeTtsAvailable();
test('live edge-tts synthesis produces mp3 bytes with a measured duration', {
  skip: edge.ok ? false : edge.detail,
}, async () => {
  const { mp3, durationMs, estimated } = await synthesize(
    'Hello from the sassfully demo narration service.',
  );
  assert.ok(Buffer.isBuffer(mp3));
  assert.ok(mp3.length > 1000, `mp3 too small: ${mp3.length} bytes`);
  assert.ok(durationMs > 500 && durationMs < 30_000, `implausible duration ${durationMs}ms`);
  if (ffprobeAvailable().ok) {
    assert.equal(estimated, false, 'ffprobe present, duration must be measured');
  }
});
