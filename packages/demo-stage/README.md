# @sassfully/demo-stage

Animated cartoon cast for narrated browser demos. Characters walk on, talk in
speech bubbles, gesture, point at things, and walk off — rendered as a
transparent SVG layer floating over live page content, which stays fully
interactive underneath (`pointer-events: none` throughout).

The animation runtime is **slidey's stage system, vendored** under
`vendor/slidey-stage/` — deliberately dependency-free ESM, "data plus a pure
function of time": `stageStateAt(t)` replays from beat 0 on every call, so
seeking is exact and nothing drifts. Provenance, the exact source commit, and
the single patch (a `transparent` backdrop) are recorded in
[`vendor/VENDORED.md`](vendor/VENDORED.md).

## API

```js
import { mountStageLayer } from '@sassfully/demo-stage';

const layer = mountStageLayer(document, { zIndex });  // zIndex optional
await layer.playScene({ scene, chars, roster, audio, placement, presenter });
layer.stop();      // end the current scene early (its promise resolves)
layer.destroy();   // stop + remove the layer container
```

`mountStageLayer(document, opts)` appends a full-viewport, `position:fixed`,
transparent, `pointer-events:none` container to the page. Its default z-index
(`STAGE_LAYER_Z` = 2147483647) sits above the sparse spotlight/dimmer and
below the caption/click-pulse band, so a presenter is never dimmed.

`playScene` accepts:

- `scene` — a slidey stage scene (see authoring, below). Required unless a
  static `presenter` is supplied.
- `presenter` — a host-validated static raster cutout `{id?, src, alt?}`.
  demo-player only accepts local project assets; this adapter mounts it inside
  the same stage layer and can place it above an animated scene.
- `chars` / `roster` — pre-resolved cast and roster; omitted, they resolve
  from `scene.cast` via the vendored engine.
- `audio` — a slidey clip table `{ clips: { key: { a, d } } }`. Omitted, each
  beat times out on the engine's word-count estimate, so **scenes play fine
  with no audio built** (silent, but fully animated with bubbles/captions).
- `placement` — where the stage box sits in the viewport:
  - `{ mode: 'full' }` (default) — whole viewport; characters stand at the
    bottom (`preserveAspectRatio: xMidYMax`).
  - `{ mode: 'dock', edge, size? }` — a box pinned to `top-left | top |
    top-right | left | right | bottom-left | bottom | bottom-right`;
    `size` is a viewport-width fraction (default 0.38).
  - `{ mode: 'anchor', anchor: { x, y, w, h }, size? }` — the box stands
    beside a DOM element's bounding box (below it, or above when there's no
    room). **Element → bbox resolution is the caller's job**: pass
    `getBoundingClientRect()` numbers; this package never queries the page.

It resolves when the scene ends, or when superseded by another `playScene` /
`stop()` / `destroy()`. One scene plays at a time.

`computeStageBox(placement, viewport, aspect)` — the pure placement math — is
exported for hosts and tests.

## Authoring scenes and casts

The scene format is slidey's: a `cast` (body `plans` + `characters` with
palettes), a `roster`, and `beats` — each beat a line or narration plus `act`
directives (`enter/exit/move/at/state/face/jump`) with act states like `walk`,
`gesture`, `point`, `shrug`. The authoritative authoring guide is slidey's
`docs/stage-scenes.md`; the vendored `validate.mjs` (`validateScene`) lints a
scene against its cast. One overlay-specific addition: set
`stage.backdrop: "transparent"` so nothing is painted behind the actors.

`examples/sample-scene.json` is a complete self-contained example: one
character (Pip, riding the `human` body plan adapted from slidey's examples)
who walks on, points, delivers a line, and walks off in three beats.

## Try it

```sh
cd packages/demo-stage
python3 -m http.server 8123      # or: npx serve .
open http://localhost:8123/demo.html
```

`demo.html` is a no-build page with placeholder app content and buttons for
each placement mode. Tests: `npm test` (plain `node --test`, no dependencies,
DOM stubbed by hand per repo convention).

## Intended demo-player integration (later pass)

A demo step gains an optional `stage` field:

```jsonc
{ "id": "step-3",
  "caption": "…",
  "stage": { "scene": { … }, "chars": null, "roster": null,
             "anchor": "#magic-panel" }   // selector resolved by the player
}
```

When present, the player mounts one shared `mountStageLayer` for the run,
resolves `anchor` to a bbox, and `await`s `playScene(...)` for that step's
beats **alongside or instead of** the step's caption + narration (a stage
beat carries its own lines and speaker voices). The layer's z-index keeps the
existing spotlight/caption chrome above the cast. Nothing in this package
depends on the demo player; the coupling is one call site in the player.

`assets/nova-source-magenta.png` is Nova’s retained source; the alpha-checked
`assets/nova-cutout.png` is the presenter shipped to hosts. See
[`docs/embedded-demo-control.md`](../../docs/embedded-demo-control.md) for
the no-dim embedded MCP example.
