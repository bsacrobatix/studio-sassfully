# Generic feedback requirements from Slidey

## Goal

Build a generic feedback package that can be used from Slidey decks and other
apps. The package should reuse the useful shape of Kitsoki bug reporting, but
must not be bug-specific, GitHub-specific, HAR-specific, or Slidey-specific.

From the Slidey perspective, the core job is:

- let a user give feedback at any visible point in a deck;
- preserve enough semantic context to make the feedback actionable;
- route the reviewed feedback to different outcomes such as a comment, issue,
  AI instruction, local note, or product-support request;
- keep capture optional and privacy-controlled.

## Existing Slidey primitives to build on

Slidey already exposes a host-neutral embed protocol:

- `embed:view` tells an embedding parent the current deck scope and reveal step.
  In Slidey, `scope` is the scene index and `step` is the reveal transition.
- `embed:annotate` lets a host turn on annotation mode.
- `embed:pick` returns a visible element anchor with producer, scope, ref, label,
  and bbox.

The important requirement is to preserve this generic shape. A feedback system
should not need to know that `scope` means "Slidey scene index" or that `ref`
means `sceneIndex/field`. Those are producer-owned opaque anchors.

Slidey also has scene-relative edit paths (`data-edit-path`) and scene
references. Those are useful context, but feedback anchors must remain distinct
from direct mutations. A feedback item may later become an AI edit instruction,
but the first-class artifact is the reviewed feedback note.

Slidey has an app-agnostic rrweb rolling buffer, but HAR is not normally needed
for deck feedback. In Slidey the common capture should be: deck identity, scene,
reveal step, semantic anchor, visible label, optional screenshot/thumbnail, and
optional user prose. Replay or network data should be opt-in per host and per
feedback kind.

## Product requirements

1. Feedback must be generic by kind.

   The model must support at least:

   - `bug`
   - `content_comment`
   - `copy_feedback`
   - `design_feedback`
   - `question`
   - `ai_instruction`
   - `issue_request`
   - `approval`
   - `rejection`

   The kind may change copy, required fields, review UI, and sink routing. It
   must not fork the anchor or evidence model.

2. Feedback must be anchorable at any deck point.

   A feedback item must be able to target:

   - the whole deck;
   - the current scene;
   - the current scene plus reveal step;
   - a visible element selected by annotation mode;
   - a reference opened from the scene reference rail;
   - a time position inside media/replay when the active scene supports it.

3. Anchors must be producer-owned and portable.

   The package should define a generic anchor envelope:

   ```ts
   interface FeedbackAnchor {
     producer: string;          // "slidey", "kitsoki", "app", etc.
     artifactId?: string;       // deck/report/build id when known
     scope?: string;            // opaque producer scope
     step?: string;             // opaque producer state within scope
     ref?: string;              // opaque producer element/reference id
     label?: string;            // reviewed display label
     bbox?: [number, number, number, number];
     mediaTimeMs?: number;
     url?: string;
     extra?: Record<string, unknown>;
   }
   ```

   Consumers may display these fields, but only the producer should interpret
   `scope`, `step`, and `ref`.

4. The report model must separate capture, review, and sink submission.

   The package should collect a draft locally, show the draft for review, then
   submit only the reviewed bundle. This should hold even for low-friction deck
   comments.

5. HAR must be optional and disabled for Slidey by default.

   The evidence model should support network summaries, but Slidey deck feedback
   should default to no HAR and no request/response bodies. For most Slidey use,
   semantic anchors and deck context are more valuable and much safer.

6. rrweb must be optional.

   Use replay only when the host opts in or when the feedback kind requires
   temporal context. For simple Slidey copy/design comments, a scene/step anchor
   plus thumbnail is enough.

7. The same feedback can route to multiple sinks.

   The sink contract must support outcomes such as:

   - append a local JSONL note;
   - create a GitHub/Jira/Linear issue;
   - add an issue or PR comment;
   - create a review comment;
   - dispatch an AI instruction to an authoring/refine story;
   - store a reviewed artifact bundle;
   - no-op preview/dry-run.

   The frontend must not know upload mechanics, labels, issue templates, auth,
   or final storage layout.

8. Feedback must preserve enough state for AI action.

   For an `ai_instruction` or issue-to-agent path, the reviewed bundle should
   include:

   - user instruction;
   - anchor envelope;
   - artifact/deck identity;
   - scene JSON excerpt or stable scene pointer when allowed;
   - visible label/text snippet only after review;
   - any relevant scene references;
   - preferred action, such as comment-only, propose patch, patch deck, or file
     issue.

9. Slidey should be able to generate a feedback artifact deck.

   A reviewed feedback bundle should be renderable as a small Slidey report deck:

   - summary/title scene;
   - target scene/anchor scene;
   - optional before/after or thumbnail scene;
   - evidence/privacy review scene;
   - sink receipt scene.

   This deck is an artifact, not the primary data model.

10. The UI must work in standalone and embedded modes.

   Requirements:

   - standalone deck: feedback trigger can live inside the deck shell;
   - embedded deck: parent host can own the trigger and use `embed:view` /
     `embed:annotate` / `embed:pick`;
   - workspace edit mode: feedback must not conflict with inline editing;
   - present mode: feedback must be minimal and keyboard/mouse accessible;
   - read-only bundled deck: feedback can still be created, but deck mutation is
     not assumed.

## Privacy requirements

1. Privacy metadata is first-class.

   Every field in the reviewed bundle should carry source, sensitivity, policy,
   review state, and retention metadata.

2. Data avoidance is the default.

   Prefer producer ids, scene indices, field refs, roles, labels, bbox, hashes,
   and short reviewed snippets over raw DOM text, full screenshots, HAR, console
   objects, or replay logs.

3. Raw draft data stays local by default.

   Remote sinks and AI processors receive only the reviewed bundle.

4. User text is reviewed text.

   User-entered feedback is intentionally included, but it should still be shown
   in the review step and marked as user-provided.

5. Host policies decide high-risk evidence.

   A host must explicitly enable HAR, replay, screenshots, console capture,
   source excerpts, or raw scene JSON. The generic package should expose these as
   capabilities, not as always-on defaults.

## Suggested package boundaries

The new repo should have separable packages/modules:

- `core`: bundle schema, anchor schema, privacy manifest, state machine;
- `capture-dom`: optional DOM/screenshot/rrweb capture providers;
- `producer-embed`: generic `embed:view` / `embed:annotate` / `embed:pick`
  helpers;
- `review-ui`: chromeless review modal and annotation picker shell;
- `sinks`: sink interface plus test sink/local JSONL sink;
- `slidey`: Slidey adapter and Slidey report deck generator;
- `kitsoki`: Kitsoki bug-report compatibility adapter, if needed later.

## Non-goals

- Do not make the first version a bug-only reporter.
- Do not require HAR.
- Do not require rrweb.
- Do not require GitHub.
- Do not require Slidey.
- Do not treat screenshot/replay as the canonical source of truth when semantic
  anchors are available.
- Do not let AI processing see raw capture by default.

## Minimum viable Slidey slice

The smallest useful implementation is:

1. Add a generic feedback trigger that captures current `embed:view` state.
2. Support optional annotation mode and store the returned `embed:pick` anchor.
3. Collect user prose and feedback kind.
4. Show a review step with anchor, scene label, optional bbox thumbnail, and
   privacy manifest.
5. Submit to a local/test sink as a reviewed JSON bundle.
6. Convert that bundle into a small Slidey report deck.

This proves the generalized model without HAR, without GitHub, and without
rrweb as required dependencies.

