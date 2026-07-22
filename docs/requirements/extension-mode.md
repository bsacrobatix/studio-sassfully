# Extension mode: zero-integration capture with an enrichment bridge

**Status:** draft 2026-07-20. Extends, and defers to,
[rich-evidence-sidecars](rich-evidence-sidecars.md) for everything about
capture rings, capture-time redaction, review, per-item approval, and
bundle-first sidecar transport.

Sassfully gains a browser-extension mode (Chrome MV3 first): the extension
provides rrweb session replay and browser telemetry (console, network
summaries, errors) on sites the user chooses, and files feedback through the
same capture → privacy-fail-closed review → submit pipeline — with **zero
integration by the site**. The integrated SDK mode remains fully supported and
remains the richer mode; the extension enriches it rather than competing with
it.

## Zero-integration capture

The extension may observe a page only after the user explicitly enables that
origin. Enablement is per-origin, stored locally in the extension, and never
synced or transmitted by default. On non-enabled origins the extension injects
nothing and records nothing. Disabling an origin stops capture immediately and
clears its ring.

## Recording visibility

Recording state is never ambiguous. Whenever a rolling buffer is active on the
focused tab, the browser-action badge shows a persistent, distinct state;
on-demand recording shows its own distinct state ("REC"); a page bridged to a
host SDK shows a bridged state; otherwise the icon is neutral. The popup states
the same fact in words ("Rolling buffer is ON for this site"). There is no
configuration in which capture runs without the badge saying so.

## Bounded rings, both recording modes

Two recording modes feed one ring implementation:

- **Rolling buffer**: a bounded ring (event-count and byte budgets) holding the
  trailing window of rrweb events plus telemetry. rrweb full-snapshot
  checkouts recur on a fixed cadence, and eviction never removes the newest
  full snapshot needed to replay the retained window — the trailing window is
  always independently replayable.
- **On-demand**: the user starts and stops recording explicitly; same ring,
  no trailing-window trim, same hard byte cap.

Masking and redaction are applied at capture time, before events enter the
ring (rrweb input masking on by default; network/console redaction as in the
existing browser-capture providers). Attaching evidence freezes a snapshot;
the ring keeps rolling. All of this is the extension instantiating the
bounded-local-capture-ring contract of rich-evidence-sidecars.

## Standalone anchors and privacy manifest

In standalone mode the extension is an ordinary producer
(`producer: "sassfully-ext"`): artifactId is the normalized origin+path (query
stripped), with optional `bbox` from an element pick and `mediaTimeMs` from
the replay clip. The extension ships its own privacy manifest classifying
exactly the fields its bundles produce; `anchor.url` is classified high with
an explicit allow policy — the user enabled the origin, and the review screen
still shows it. Any unclassified field blocks submission, unchanged.

## Local-first sink

Reviewed bundles and their approved sidecars persist to extension-local
storage and can be exported to files (bundle JSONL plus per-item sidecar
files). Submitting to a remote intake is strictly opt-in: the user configures
an intake URL in the extension options, and pushing stored bundles through the
existing httpSink/intake contract is an explicit action. Nothing leaves the
device otherwise.

## Sidecar chunking

A replay clip larger than the sidecar transport cap is split into ordered
chunk items (`replay-chunk i/N`) sharing a `clipId`, each with its own digest,
each individually reviewable and approvable, each under the cap. Chunking is a
transport concern; review semantics per item are unchanged.

## Detect + enrich bridge

When a page runs the integrated SDK, the extension and the SDK handshake over
a versioned same-origin postMessage protocol (`sassfully-ext/bridge/v1`). On a
successful handshake the extension contributes its evidence providers (replay,
network, console, errors) to the host's reporter; the host's anchors, privacy
manifest, review flow, and sinks own everything downstream. The extension's
standalone UI never activates on a bridged page. Hosts opt in via a small
bridge helper in feedback-core; hosts that do nothing see no change.
