# Bug report with replay evidence

The kitsoki-lineage case — a bug report carrying opt-in rrweb replay and network summary, with privacy review before submission.

## Step 1: User hits an issue in a host app embedding the widget; triggers the reporter (floating, chromeless trigger).

Acceptance: `req-host-policy-gates-evidence`

## Step 2: Widget captures an anchor at the trigger point (producer-owned) plus an optional rrweb replay clip and network summary, opt-in per host policy.

Acceptance: `req-producer-owned-anchors`

## Step 3: Review step surfaces the privacy manifest before submission — unclassified fields block submit; raw capture never leaves the device pre-review.

Acceptance: `req-privacy-fail-closed`

## Step 4: User adds prose and picks a kind (bug is one of several, not privileged) and submits; a client-side idempotency key dedupes accidental double-submits.

Acceptance: `req-idempotent-submission`

## Step 5: Bundle routes to a configured sink (local/bundle/dry-run in v0.1; GitHub is a later parity follow-on, never required).

Acceptance: `req-multi-sink-routing`

