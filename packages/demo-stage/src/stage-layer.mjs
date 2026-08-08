/**
 * demo-stage — overlay adapter
 *
 * Mounts slidey's stage runtime (vendored, see ../vendor/VENDORED.md) as a
 * transparent layer above live page content, the same way the demo overlay
 * does its spotlight/caption chrome: a full-viewport, position:fixed,
 * pointer-events:none container whose z-index sits just *below* the demo
 * spotlight band (2147483645/2147483646), so a spotlight can still outline
 * things over a character's head.
 *
 * The layer owns a container and at most one live scene at a time. The stage
 * box itself (where the SVG stage is drawn inside the viewport) is a pure
 * computation over a `placement`:
 *
 *   { mode: 'full' }                                    whole viewport
 *   { mode: 'dock', edge: 'bottom-left', size: 0.38 }   corner / edge box
 *   { mode: 'anchor', anchor: { x, y, w, h } }          near an element bbox
 *
 * Element → bbox resolution is the caller's job (getBoundingClientRect and
 * hand the rect over); this module never queries the page.
 *
 *   const layer = mountStageLayer(document, { zIndex });
 *   await layer.playScene({ scene, chars, roster, audio, placement });
 *   layer.stop();      // end the current scene early (its promise resolves)
 *   layer.destroy();   // stop + remove the container
 */

import { mountStagePlayer } from '../vendor/slidey-stage/player.mjs';
import { resolveCast, rosterOf, buildTimeline } from '../vendor/slidey-stage/engine.mjs';

/** Just below the demo overlay's spotlight (2147483645) and caption (2147483646). */
export const STAGE_LAYER_Z = 2147483644;

const DOCK_EDGES = new Set([
  'top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right',
]);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Where the stage box sits in the viewport, in px. Pure — exported for tests.
 *
 * @param {object} placement   see module doc
 * @param {{w:number,h:number}} viewport
 * @param {number} aspect      stage w/h from scene.stage.units
 */
export function computeStageBox(placement, viewport, aspect) {
  const { w: vw, h: vh } = viewport;
  const margin = 16;
  const p = placement ?? { mode: 'full' };

  if (p.mode === 'dock') {
    if (!DOCK_EDGES.has(p.edge)) throw new Error(`unknown dock edge "${p.edge}"`);
    const width = clamp(Math.round(vw * (p.size ?? 0.38)), 240, vw - margin * 2);
    const height = Math.round(width / aspect);
    const left = p.edge.endsWith('left') ? margin
      : p.edge.endsWith('right') ? vw - width - margin
      : Math.round((vw - width) / 2);
    const top = p.edge.startsWith('top') ? margin
      : p.edge.startsWith('bottom') ? vh - height - margin
      : Math.round((vh - height) / 2);   // bare 'left' / 'right': vertically centered
    return { left, top, width, height };
  }

  if (p.mode === 'anchor') {
    const a = p.anchor;
    if (!a || ![a.x, a.y, a.w, a.h].every(Number.isFinite)) {
      throw new Error('anchor placement needs anchor: {x, y, w, h}');
    }
    const gap = 8;
    const width = clamp(Math.round(Math.max(a.w, vw * (p.size ?? 0.3))), 240, Math.round(vw * 0.5));
    const height = Math.round(width / aspect);
    const left = clamp(Math.round(a.x + a.w / 2 - width / 2), margin, Math.max(margin, vw - width - margin));
    // Prefer standing below the anchor; step above it when there is no room.
    let top = a.y + a.h + gap;
    if (top + height > vh - margin) top = a.y - height - gap;
    top = clamp(Math.round(top), margin, Math.max(margin, vh - height - margin));
    return { left, top, width, height };
  }

  return { left: 0, top: 0, width: vw, height: vh };   // 'full'
}

export function mountStageLayer(doc, opts = {}) {
  const {
    zIndex = STAGE_LAYER_Z,
    viewport = null,                    // {w,h} override; defaults to the window
    mountPlayer = mountStagePlayer,     // injectable for tests
  } = opts;

  const container = doc.createElement('div');
  container.setAttribute('data-demo-stage-layer', '');
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    top: '0', left: '0', width: '100%', height: '100%',   // `inset` fallback
    pointerEvents: 'none',
    zIndex: String(zIndex),
    overflow: 'hidden',
    background: 'transparent',
  });
  doc.documentElement.appendChild(container);

  let current = null;   // { host, player, settle }
  let destroyed = false;

  const viewportNow = () => viewport
    ?? { w: doc.defaultView?.innerWidth ?? 1280, h: doc.defaultView?.innerHeight ?? 800 };

  /** End the live scene: tear down its player + host, resolve its promise. */
  function stop() {
    if (!current) return;
    const c = current;
    current = null;
    try { c.player?.destroy(); } catch { /* already torn down */ }
    c.host.remove();
    c.settle();
  }

  /**
   * Play one scene; resolves when the scene ends (or on stop()/destroy()).
   * `chars`/`roster` may be passed pre-resolved; otherwise they come from
   * `scene.cast`. `audio` is the slidey clip table; omitted, beats time out on
   * the engine's word-count estimate, so a scene is playable with no audio.
   */
  function playScene({ scene, chars, roster, audio, placement } = {}) {
    if (destroyed) return Promise.reject(new Error('stage layer destroyed'));
    if (!scene) return Promise.reject(new Error('playScene needs a scene'));
    stop();   // one scene at a time; the previous one resolves as "ended"

    const cast = chars ?? resolveCast(scene.cast);
    const onStage = roster ?? rosterOf(scene, scene.cast);
    const clips = audio ?? scene.audio ?? null;
    const timeline = buildTimeline(scene, cast, clips);

    const units = scene.stage.units;
    const box = computeStageBox(placement, viewportNow(), units.w / units.h);
    const host = doc.createElement('div');
    host.setAttribute('data-demo-stage-box', '');
    Object.assign(host.style, {
      position: 'absolute',
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      pointerEvents: 'none',
    });
    container.appendChild(host);

    return new Promise((resolve) => {
      current = { host, player: null, settle: resolve };
      const mine = current;
      const player = mountPlayer(host, {
        scene, chars: cast, roster: onStage, timeline, audio: clips,
        autoplay: true,
        onEnd: () => { if (current === mine) stop(); },
      });
      // Feet toward the bottom of the box, whatever its aspect.
      player.svg?.setAttribute?.('preserveAspectRatio', 'xMidYMax meet');
      if (player.svg?.style) Object.assign(player.svg.style, { width: '100%', height: '100%', display: 'block' });
      if (current === mine) current.player = player;
      else player.destroy?.();          // onEnd fired synchronously (empty scene)
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stop();
    container.remove();
  }

  return { container, playScene, stop, destroy };
}
