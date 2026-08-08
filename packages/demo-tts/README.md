# @sassfully/demo-tts

edge-tts narration service for sassfully's narrated demos. Instead of browser
`speechSynthesis` (voice varies per machine, silent when headless,
unrecordable), narration is pre-synthesized to MP3 with a **measured**
duration, so a demo step's timing locks to the voice: works headless,
consistent voice, recordable.

Requires the [`edge-tts`](https://pypi.org/project/edge-tts/) Python CLI on
PATH (`pipx install edge-tts`) and, for measured durations, `ffprobe`
(`brew install ffmpeg`). Without ffprobe everything still works, but durations
are word-count estimates (~155 wpm) flagged `estimated: true`. No npm
dependencies.

## API

```js
import { synthesize, cachedSynthesize, startServer, prebake } from '@sassfully/demo-tts';

// One clip. Default voice: en-AU-NatashaNeural (slidey's default).
const { mp3, durationMs, estimated } = await synthesize(
  'Welcome to the demo.',
  { voice: 'en-AU-NatashaNeural', rate: '+0%', pitch: '+0Hz' },
);
```

- `synthesize(text, {voice?, rate?, pitch?})` → `{mp3: Buffer, durationMs, estimated}`.
  Text is capped at **2000 chars**, matching the demo-script policy.
- `cachedSynthesize(text, {cacheDir, ...})` — same, through a content-addressed
  disk cache (sha256 of text+voice+rate+pitch); adds `{cacheKey, cacheHit}`.
- `startServer({port?, cacheDir?, voice?, rate?, pitch?})` — the HTTP server below.
- `prebake(script, {outDir, ...})` — the prebake flow below.

## HTTP server (live demos)

```sh
demo-tts serve --port 4547 --cache ~/.cache/demo-tts
```

| Route | Behavior |
|---|---|
| `POST /narration` `{text, voice?, rate?, pitch?}` | `200` `audio/mpeg` bytes. Headers: `X-Narration-Duration-Ms` (measured clip length), `X-Narration-Estimated` (`true` only when ffprobe was unavailable), `X-Narration-Cache` (`hit`/`miss`). `400` on missing/empty/over-2000-char text; `500` on synthesis failure. |
| `GET /health` | `{ok: true, cacheDir}` |

Responses are cached content-addressed on disk, so repeat narrations cost a
sha lookup, not a re-synthesis.

## Prebake (recorded / CI demos)

```sh
demo-tts prebake demo-script.json --out ./narration [--voice V --rate R --pitch P]
```

Takes a `sassfully/demo-script/v1` script (steps carry `narration` strings —
see `packages/feedback-extension/RUNBOOK.md`), synthesizes every narrated step
into `--out`, and writes `manifest.json`:

```json
[
  { "stepId": "s1", "file": "s1.mp3", "durationMs": 4210, "estimated": false }
]
```

A recorded/CI demo run loads the manifest and plays the files — no TTS engine
in the loop at demo time, and the timing is byte-for-byte reproducible.

## How the demo player consumes this

Per step (wired in a later pass):

1. Fetch the step's MP3 — live: `POST /narration` with the step's `narration`
   text; prebaked: read `manifest.json` and load the step's `file`.
2. Play it through an `<audio>` element or AudioContext.
3. Step duration = `max(audio durationMs, dwellMs)` — the measured duration
   (from the `X-Narration-Duration-Ms` header or the manifest) replaces the
   speechSynthesis "wait for narration end" event, so the same timing works
   headless and in recordings.

## Security posture

Loopback only, **no auth by design**. The server hardcodes its bind address to
`127.0.0.1` — there is no host option — and the trust boundary is the loopback
interface: anything that can reach it is already running on your machine. Do
not expose it (no port-forward, no reverse proxy, no 0.0.0.0 rebind); if you
need narration on another machine, prebake and ship the files instead.

## Tests

```sh
npm test   # node --test test/*.test.mjs
```

Synthesis is injectable everywhere (`opts.synthesize`), so cache, server, and
prebake tests always run with a mock. The live edge-tts test is skipped
automatically when the CLI is not on PATH.
