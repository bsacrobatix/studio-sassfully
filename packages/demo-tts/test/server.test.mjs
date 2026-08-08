import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, LOOPBACK_HOST } from '../src/server.mjs';
import { MAX_TEXT_LENGTH } from '../src/synthesize.mjs';

function mockSynth() {
  const calls = [];
  const fn = async (text, opts = {}) => {
    calls.push({ text, opts });
    return { mp3: Buffer.from(`MP3:${text}`), durationMs: 2500, estimated: false };
  };
  return { fn, calls };
}

async function withServer(t, opts = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'demo-tts-server-test-'));
  const started = await startServer({ port: 0, cacheDir, ...opts });
  t.after(async () => {
    await started.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  return started;
}

test('binds to 127.0.0.1 only', async (t) => {
  const { server } = await withServer(t, { synthesize: mockSynth().fn });
  assert.equal(server.address().address, LOOPBACK_HOST);
  assert.equal(LOOPBACK_HOST, '127.0.0.1');
});

test('GET /health reports ok and the cache dir', async (t) => {
  const { url } = await withServer(t, { synthesize: mockSynth().fn });
  const res = await fetch(`${url}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(typeof body.cacheDir === 'string' && body.cacheDir.length > 0);
});

test('POST /narration returns audio bytes with a duration header, cached on repeat', async (t) => {
  const { fn, calls } = mockSynth();
  const { url } = await withServer(t, { synthesize: fn });

  const res = await fetch(`${url}/narration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'step one narration' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(res.headers.get('x-narration-duration-ms'), '2500');
  assert.equal(res.headers.get('x-narration-estimated'), 'false');
  assert.equal(res.headers.get('x-narration-cache'), 'miss');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(bytes, Buffer.from('MP3:step one narration'));
  assert.equal(calls.length, 1);

  const again = await fetch(`${url}/narration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'step one narration' }),
  });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('x-narration-cache'), 'hit');
  assert.equal(again.headers.get('x-narration-duration-ms'), '2500');
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), bytes);
  assert.equal(calls.length, 1, 'cache hit must not re-synthesize');
});

test('POST /narration passes voice/rate/pitch through to synthesis', async (t) => {
  const { fn, calls } = mockSynth();
  const { url } = await withServer(t, { synthesize: fn });
  const res = await fetch(`${url}/narration`, {
    method: 'POST',
    body: JSON.stringify({ text: 'hi', voice: 'en-GB-RyanNeural', rate: '-6%', pitch: '+4Hz' }),
  });
  assert.equal(res.status, 200);
  assert.equal(calls[0].opts.voice, 'en-GB-RyanNeural');
  assert.equal(calls[0].opts.rate, '-6%');
  assert.equal(calls[0].opts.pitch, '+4Hz');
});

test('POST /narration rejects bad input with 400', async (t) => {
  const { fn, calls } = mockSynth();
  const { url } = await withServer(t, { synthesize: fn });
  const post = (body) => fetch(`${url}/narration`, { method: 'POST', body });

  for (const body of ['not json', '{}', '{"text":""}', '{"text":42}']) {
    const res = await post(body);
    assert.equal(res.status, 400, `expected 400 for body ${body}`);
    assert.ok((await res.json()).error);
  }

  const over = await post(JSON.stringify({ text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }));
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, new RegExp(`exceeds ${MAX_TEXT_LENGTH}`));

  assert.equal(calls.length, 0, 'no bad input may reach synthesis');
});

test('synthesis failure surfaces as 500 with the error message', async (t) => {
  const { url } = await withServer(t, {
    synthesize: async () => { throw new Error('edge-tts exploded'); },
  });
  const res = await fetch(`${url}/narration`, {
    method: 'POST',
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /edge-tts exploded/);
});

test('unknown routes 404', async (t) => {
  const { url } = await withServer(t, { synthesize: mockSynth().fn });
  assert.equal((await fetch(`${url}/nope`)).status, 404);
  assert.equal((await fetch(`${url}/narration`)).status, 404, 'GET /narration is not a route');
});
