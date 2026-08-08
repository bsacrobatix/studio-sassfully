# Vendored: slidey stage runtime

Source repo: `/Users/brad/code/slidey` (studio-slidey)
Source path: `web/stage/`
Source commit: `f1e6621c3b401ab8b0b3f23a1559332b38c5e81f`
Vendored on: 2026-08-08

## Files

| File | Copied from | Modified? |
|---|---|---|
| `slidey-stage/engine.mjs` | `web/stage/engine.mjs` | No — verbatim |
| `slidey-stage/render.mjs` | `web/stage/render.mjs` | **Yes — one patch, see below** |
| `slidey-stage/player.mjs` | `web/stage/player.mjs` | No — verbatim |
| `slidey-stage/validate.mjs` | `web/stage/validate.mjs` | No — verbatim |
| `slidey-stage/refs.mjs` | `web/stage/refs.mjs` | No — verbatim |

Not vendored: `shell.mjs` (dev-viewer UI chrome), `steps.mjs` (slidey deck
step/PDF integration), `player.css` (deck-viewer styling — the overlay layer
styles its own container inline and wants no background), `index.html` (dev
viewer; `../demo.html` plays that role here).

Import graph is closed: `player.mjs` imports only `engine.mjs` + `render.mjs`;
`validate.mjs` imports only `engine.mjs` + `render.mjs`; `refs.mjs` and
`engine.mjs` import nothing. No deck-viewer dependencies had to be trimmed.

The example cast body plan in `../examples/sample-scene.json` (`plans.human`)
is copied from `examples/stage/mongodb.cast.json` at the same commit; the
character riding it is original to this package.

## Patch: `render.mjs` — `transparent` backdrop

Upstream `backdrop: "none"` still paints an opaque wall + floor (a stage scene
in a deck always has a stage). An overlay over live page content needs true
transparency, so the vendored copy adds one backdrop token:

- `BACKDROPS` gains `'transparent'`.
- `backdropSvg()` returns `''` (no markup at all) for it.

Both edits are marked `PATCH(demo-stage)` inline. Nothing else in any vendored
file was changed.

## Re-vendoring

```sh
for f in engine render player validate refs; do
  cp /Users/brad/code/slidey/web/stage/$f.mjs vendor/slidey-stage/$f.mjs
done
# then re-apply the transparent-backdrop patch to render.mjs (grep PATCH(demo-stage))
# and update the commit hash above:  git -C /Users/brad/code/slidey rev-parse HEAD
```
