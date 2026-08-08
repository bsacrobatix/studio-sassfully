/**
 * stage — reference resolution (environment-free)
 *
 * A stage scene points at its cast and audio by path so the storyboard stays
 * small and reviewable, and so several decks can share one cast. Either field
 * may also be given inline, which is what a bundled single-file build does.
 *
 * The reader is injected: Node passes one backed by fs, the browser player one
 * backed by fetch, and a test passes a Map. Nothing here knows which.
 */

export const isRef = (v) => typeof v === 'string';

/**
 * @param {object} scene            a stage scene, refs unresolved
 * @param {(ref:string)=>Promise<object>} read
 * @returns {Promise<object>} the scene with `cast` and `audio` as objects
 */
export async function resolveSceneRefs(scene, read) {
  const out = { ...scene };
  if (isRef(out.cast)) out.cast = await read(out.cast);
  if (isRef(out.audio)) out.audio = await read(out.audio);
  if (out.cast && isRef(out.cast.extends)) {
    const base = await read(out.cast.extends);
    out.cast = mergeCast(base, out.cast);
  }
  return out;
}

/** A deck-local cast may extend a shared library: plans merge, characters append. */
export function mergeCast(base, over) {
  const chars = new Map((base.characters ?? []).map((c) => [c.id, c]));
  for (const c of over.characters ?? []) chars.set(c.id, { ...(chars.get(c.id) ?? {}), ...c });
  return {
    ...base, ...over, extends: undefined,
    plans: { ...(base.plans ?? {}), ...(over.plans ?? {}) },
    characters: [...chars.values()],
  };
}

/** Every stage scene in a slidey deck, or the scene itself if given one bare. */
export function stageScenes(doc) {
  if (doc?.type === 'stage') return [{ index: 0, scene: doc, path: '$' }];
  return (doc?.scenes ?? [])
    .map((scene, index) => ({ index, scene, path: `scenes[${index}]` }))
    .filter((s) => s.scene?.type === 'stage');
}
