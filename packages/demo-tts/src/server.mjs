/**
 * @sassfully/demo-tts — loopback-only narration HTTP server.
 *
 * Tiny node:http server, no deps, bound to 127.0.0.1 ONLY (hardcoded — there
 * is deliberately no host option). No auth by design: the trust boundary is
 * the loopback interface. Never expose it beyond localhost.
 *
 *   POST /narration  {text, voice?, rate?, pitch?}
 *     → 200 audio/mpeg bytes
 *       X-Narration-Duration-Ms: measured (or estimated) clip length
 *       X-Narration-Estimated:   "true" only when ffprobe was unavailable
 *       X-Narration-Cache:       "hit" | "miss"
 *     → 400 {error} on bad input (missing/empty/over-2000-char text)
 *     → 500 {error} on synthesis failure
 *   GET /health → {ok: true, cacheDir}
 *
 * Responses are cached content-addressed on disk (see cache.mjs), so repeat
 * narrations cost one sha lookup, not a re-synthesis.
 */

import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedSynthesize } from './cache.mjs';
import { MAX_TEXT_LENGTH } from './synthesize.mjs';

export const LOOPBACK_HOST = '127.0.0.1';

/** Body cap: generous for a ≤2000-char text plus opts, hostile to abuse. */
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
  });
  res.end(bytes);
}

/**
 * Build (but do not bind) the server.
 *
 * @param {object} [opts]
 * @param {string} [opts.cacheDir] — default os.tmpdir()/demo-tts-cache.
 * @param {Function} [opts.synthesize] — injectable synth (tests mock this).
 * @param {string} [opts.voice] [opts.rate] [opts.pitch] — server-wide
 *   defaults applied when a request omits them.
 */
export function createServer(opts = {}) {
  const cacheDir = opts.cacheDir || join(tmpdir(), 'demo-tts-cache');

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, `http://${LOOPBACK_HOST}`);

    if (req.method === 'GET' && pathname === '/health') {
      return sendJSON(res, 200, { ok: true, cacheDir });
    }

    if (req.method === 'POST' && pathname === '/narration') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req) || '{}');
      } catch (err) {
        return sendJSON(res, 400, { error: `invalid JSON body: ${err.message}` });
      }
      const { text, voice, rate, pitch } = payload || {};
      if (typeof text !== 'string' || !text.trim()) {
        return sendJSON(res, 400, { error: 'text (non-empty string) is required' });
      }
      if (text.length > MAX_TEXT_LENGTH) {
        return sendJSON(res, 400, { error: `text exceeds ${MAX_TEXT_LENGTH} chars (got ${text.length})` });
      }
      try {
        const result = await cachedSynthesize(text, {
          cacheDir,
          voice: voice ?? opts.voice,
          rate: rate ?? opts.rate,
          pitch: pitch ?? opts.pitch,
          ...(opts.synthesize ? { synthesize: opts.synthesize } : {}),
        });
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': result.mp3.length,
          'X-Narration-Duration-Ms': String(result.durationMs),
          'X-Narration-Estimated': String(!!result.estimated),
          'X-Narration-Cache': result.cacheHit ? 'hit' : 'miss',
        });
        return res.end(result.mp3);
      } catch (err) {
        return sendJSON(res, 500, { error: String(err.message || err) });
      }
    }

    return sendJSON(res, 404, { error: `no route: ${req.method} ${pathname}` });
  });

  return server;
}

/**
 * Create, bind to 127.0.0.1:<port>, and resolve once listening.
 *
 * @returns {Promise<{ server, port: number, url: string, close: () => Promise<void> }>}
 */
export function startServer({ port = 0, ...opts } = {}) {
  const server = createServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, () => {
      const bound = server.address().port;
      resolve({
        server,
        port: bound,
        url: `http://${LOOPBACK_HOST}:${bound}`,
        close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}
