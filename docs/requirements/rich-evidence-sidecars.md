# Rich evidence sidecars: public privacy and transport contract

**Status:** accepted 2026-07-14. This source supersedes the narrower
"raw stays local" and "HAR/rrweb off" wording where that wording would forbid
the explicitly reviewed sidecar flow below. It preserves the default: no raw
browser evidence leaves a device without an individual reviewer approval.

## Capture and review

Hosts may opt in to bounded, always-on **local** capture rings. Attaching
evidence creates a frozen snapshot; capture-time redaction and input masking
occur before that snapshot. The reviewed bundle is lean: kind, label, digest,
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
sidecar envelope. Its digest is the public `contentDigest` contract: FNV-1a
64-bit over canonical JSON (object keys sorted recursively; arrays ordered),
encoded as 16 lowercase hexadecimal characters. Intake recomputes that digest
from the parsed raw payload and rejects a mismatch before it constructs a
storage path or writes data. Public hosted intake accepts at most 2 MiB per sidecar,
while bundle intake remains separately bounded. Intake applies its existing
rate policy to both routes, validates keys and digests before building paths,
and stores only under `evidence/<key>/<digest>.<ext>`. It never writes a client
IP. Bundle-key lookup is rebuilt from relevant monthly ledgers at startup, so
a sidecar retry survives month rollover. Same-key bundle retries serialize
check-and-append, and same key-plus-digest evidence retries use exclusive
creation with `EEXIST` treated as a deduped success.

A browser-originated server-trace item is a correlation marker/summary only: it
must not contain browser trace body bytes. A host may resolve that reviewed
marker into a separate bounded backend log or trace sidecar under the
[observability provider contract](observability-evidence-providers.md). The
provider result receives its own privacy review, digest, retention policy, and
source receipt. HAR/replay capture follows the same capture-time redaction,
masking, bounded retention, review, and per-item approval policy.
