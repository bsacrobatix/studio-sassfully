# Rich evidence sidecars: public privacy and transport contract

**Status:** accepted 2026-07-14. This source supersedes the narrower
"raw stays local" and "HAR/rrweb off" wording where that wording would forbid
the explicitly reviewed sidecar flow below. It preserves the default: no raw
browser evidence leaves a device without an individual reviewer approval.

## Capture and review

Hosts may keep bounded, always-on **local** capture rings. Attaching evidence
creates a frozen snapshot; capture-time redaction and input masking occur
before that snapshot. The reviewed bundle is lean: kind, label, digest,
snippet, content type, byte size, transport, and the per-item upload decision.
It never includes raw payload bytes. Annotations are geometric/semantic only;
they never include a screenshot.

Raw upload is unchecked by default. A reviewer approves each item separately.
The bundle is submitted first. Only after a successful (including idempotently
deduped) bundle receipt may approved sidecars be sent, addressed by
`idempotencyKey` and digest. A sink without sidecar support records a
non-failing `skipped` result and retains digest-only evidence.

## Transport and intake

The versioned `sassfully/feedback-sidecar-envelope/v1` fixture defines the
sidecar envelope. Public hosted intake accepts at most 2 MiB per sidecar,
while bundle intake remains separately bounded. Intake applies its existing
rate policy to both routes, validates keys and digests before building paths,
and stores only under `evidence/<key>/<digest>.<ext>`. It never writes a client
IP. Bundle-key lookup is rebuilt from relevant monthly ledgers at startup, so
a sidecar retry survives month rollover.

Server-trace evidence is a marker/summary only: it must not contain browser
trace body bytes. HAR/replay capture follows the same capture-time redaction,
masking, bounded retention, review, and per-item approval policy.
