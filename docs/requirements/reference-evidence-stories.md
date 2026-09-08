# Reference-backed feedback through native Stories

**Status: proposed detailed design, 2026-09-08. Not an implementation or live
service guarantee.** This extends the existing feedback intake, reviewed
projection, dispatch, and evidence contracts. It makes native Kitsoki Stories
and Starlark the extension mechanism; it does not require a new provider
framework, plugin server, or observability-specific workflow engine.

## Outcome and scope

A reporter describes a problem and supplies fundamental references, such as a
session ID and the request IDs involved. The configured Story verifies those
references against authoritative records, retrieves permitted evidence, and
builds a custom bundle. A downstream GitHub issue contains a safe summary. Its
assigned bugfix agent receives the permitted evidence immediately, in its
prompt or through issue-scoped host access, without collecting logs separately.

For example, a user reports that an invitation failed in session S at request
R. The host authenticates the user; the application's Story establishes that S
belongs to that user and R occurred in S in the intended application and
environment. It resolves R to server records and, if permitted, downstream
traces. An invented R or another user's R cannot qualify the submission.
Successful validation proves the interaction happened, not that the user's
explanation of the defect is correct. Recorded user input remains untrusted.

This mode requires validated references, not screenshots, pasted logs, or file
uploads. Browser sidecars remain a separate optional capture flow with their
existing individual approval rules. A product may also allow general feedback
without references, but must label and route it separately; it must not silently
bypass a reference-required issue gate. Bugs occurring before a request exists
need another configured authoritative reference, such as a client crash receipt,
or an explicit unsupported-evidence result.

## Existing substrate and integration gaps

Current feedback facilities include `runstatus.application.feedback`, generic
`feedback.report`, `host.feedback.list_reviewed`, and `host.feedback.dispatch`.
The application path already derives application/session/frame identity from
its canonical frame and derives report idempotency from canonical reviewed
content. Host feedback scope and actor context are server-derived. These are
boundaries to extend, not replace.

The missing contract is general reference validation and resolution, policy
release, durable issue-to-evidence binding, and issue/job-scoped retrieval.
Existing intake or a successful GitHub write does not prove those contracts.
The earlier [observability design](observability-evidence-providers.md) supplies
useful telemetry conventions; its advertised plan/fetch APIs are design names,
not prerequisites or evidence that those endpoints are implemented.

## Configure ordinary Stories in `.kitsoki`

Administrators put application-specific `app.yaml` and Starlark in their
`.kitsoki/stories` tree and use normal Story discovery, imports, runtime
execution, host capability bindings, and deployment revision handling. The
existing `.kitsoki.yaml` supports `story_dirs`. The following additional
`feedback` binding is **illustrative proposed configuration**, not a schema
accepted by today's parser:

```yaml
story_dirs: [./.kitsoki/stories, ./stories]
feedback:
  reference_submission:
    story: ./.kitsoki/stories/issue-evidence/app.yaml
    intent: submit
    require_validated_references: true
    destination: product-bugs
```

The configured Story owns custom reference schemas, application authorization
checks, record lookups, joins, redaction, bundle construction, and routing
policy. One application can fetch runtime sessions; another can validate a
support case through an external system and assemble billing-event projections.
Both use the same surrounding evidence binding contract. A multi-stage
`validate → resolve → release` Story is a useful convention, not a mandatory
set of plugin methods or a restriction on internal Story structure.

The destination is an administrator-owned GitHub route. The caller cannot
select a repository, Story path, source revision, credential role, query,
provider URL, storage key, or policy. Story source and imports are admitted
through the normal deployment process. Editing untrusted issue text or a
repository checkout during a bugfix job cannot replace the governing Story.

Starlark can compose available typed host operations and implement custom
authorization logic. It does not receive credentials or unrestricted network,
filesystem, or shell access. If an external system needs a missing capability,
extend the appropriate typed Kitsoki host operation; do not add a sidecar or
endpoint-specific service. Custom logic can narrow permissions and apply
business rules, but cannot widen the host's tenant, resource, credential, or
egress limits.

## Inputs and authority

The JSON-RPC transport delegates to the configured Story through the existing
feedback path. The final method name and wire schema must be settled during
integration; this example describes the logical input, not a callable endpoint:

```json
{
  "description": "Inviting a member returned an error",
  "references": [
    {"kind": "application-request/v1", "session_id": "S", "request_id": "R"}
  ],
  "idempotency_key": "client-generated-retry-key"
}
```

| Value | Authority and enforcement |
| --- | --- |
| Description and reference values | Caller-controlled claims; schema and size checked, never authorization. |
| Actor, tenant, application and environment | Authenticated host context; reject conflicting caller claims. |
| Reference relationships | Authoritative source lookup or verified source receipt, plus Story business rules. |
| Fetch capabilities and destination | Admitted deployment configuration constrained by host grants. |
| Release and processing permissions | Configured policy evaluated against current host visibility restrictions. |
| Issue and job identity | Verified durable host records and assignment, never issue-body text. |

Validation must establish both permission to submit and permission to resolve
this specific reference. For a request reference, verify actor/session access,
request membership in that session, application/environment ownership, and any
permitted time range. These are application-domain rules implemented by the
configured Story, not a universal ownership database imposed by core. Bounded
lookup needed to establish authorization is allowed under a specific host grant;
it must not disclose records before authorization succeeds. The host must not
infer these relationships from matching strings in
caller-supplied logs. A legitimate support operator acting on another user's
case requires an explicit delegated role and an audited policy decision.

Opaque identifiers are not secrets or access grants. Failed lookups must not
become an existence oracle: return a non-enumerating refusal to the caller while
retaining the precise authorized audit reason internally. Cross-service trace
links require authorization for each destination; participation in the same
trace does not grant access to every service or tenant. Bound reference count,
lookup work, bytes, records, time, traversal depth, and retries before execution.

## Durable lifecycle and retries

1. **Accept:** authenticate, validate input shape, bind scope and admitted Story
   revision, and persist a submission receipt. A receipt means accepted work,
   not validated evidence or a filed issue.
2. **Validate:** resolve authoritative ownership and relationships. Persist the
   decision, reference digests, source receipts, and policy revision. Invalid
   references produce a refusal and cannot reach GitHub filing.
3. **Resolve:** fetch bounded records and construct the custom candidate bundle
   within the existing Story execution lifecycle. Long operations return a
   durable pending reference and resume through normal Story persistence; no
   long-lived RPC, separate scheduler, or laptop controller is required.
4. **Release:** require the configured minimum authoritative evidence before
   filing, then classify and project the candidate for each audience. Record an
   exact-digest policy decision or require individual review as described below.
5. **Bind and file:** persist an internal issue-evidence binding and a filing
   intent, then write only the approved GitHub projection. Store the canonical
   repository and provider issue identity in the binding and return a filing
   receipt once reconciliation confirms the external outcome.
6. **Assign and consume:** when the existing bugfix lane creates a job, bind its
   admitted issue identity to the permitted evidence manifest and retrieval
   scope. Record accesses and any new released bundle revision.

Reuse existing report idempotency and sink reconciliation. A client retry key
is scoped to actor/application and bound to a canonical submission digest;
reuse with different content is refused. Stage operations have stable keys so
retries reuse completed validation and fetch receipts where still authorized.
If GitHub accepted creation but its reply was lost, reconcile the filing intent
with the existing sink's durable identity before retrying. Do not blindly create
a second issue. A binding with pending filing remains visibly pending; an
accepted dispatch is not an evidence-consumed or bug-fixed receipt.

Cancellation, deadlines, and retry exhaustion produce explicit terminal states.
Partial evidence is allowed only when configured minimum validation and release
requirements hold, with omissions visible. A transient fetch failure may resume
within its budget. It must never downgrade into accepting uploaded assertions.

## Custom bundles, common envelope

Applications may build arbitrary versioned payload schemas: logs and traces are
one example, not the universal format. A billing bundle might contain permitted
ledger observations; a runtime bundle might contain session transitions and
request outcomes. Kitsoki validates a small standard envelope around them:

| Envelope field | Required meaning |
| --- | --- |
| Identity and revision | Durable bundle ID, schema name/version, content digest, parent revision when enriched. |
| Subject binding | Internal report, issue binding, tenant/application/environment, validated reference handles. |
| Provenance | Source receipts or immutable source versions/digests, validation result, retrieval time, admitted Story/import revision. |
| Policy | Classification, transform revision, release decision/digest, permitted audiences and purposes. |
| Completeness | Requested and returned scope, bounds, omissions, truncation, source availability states. |
| Retention | Storage mode, expiry, source expiry where known, deletion state, revocation checks. |
| Payload | Application-defined typed content or authorized handles, plus a bounded safe summary. |

A content digest establishes integrity, not factual truth. A source receipt
establishes where a record came from, not that every sentence in it is trusted.
Unknown schemas can be displayed only through an authorized generic projection;
agents must not guess payload semantics. Schema migrations or additional fetches
create new revisions and new release decisions, never silently mutate approved
bytes. Payload size and count limits apply even to custom formats.

Bundles may retain only references and fetch projections on demand, or retain a
policy-approved snapshot for reproducibility. Record which mode applies. A
reference is not a promise that its source will still exist tomorrow. Digests
and minimal receipts may outlive payloads only where retention policy allows;
deleting evidence must not leave sensitive copies in prompts or artifact stores
outside that policy.

## OpenTelemetry-aligned telemetry profile

For bundles containing logs or traces, reuse OpenTelemetry data structures and
semantic conventions instead of inventing a competing telemetry model. This is
a telemetry payload profile inside the common evidence envelope, not a
requirement that every application emit OpenTelemetry or that non-telemetry
custom bundles become spans. Application-owned Stories still choose the source,
authorization logic, projection, and bundle schema.

| Payload | Preserve when present and permitted |
| --- | --- |
| Logs | `Timestamp`, `ObservedTimestamp`, `SeverityNumber`, `SeverityText`, `Body`, typed `Attributes`, `TraceId`, `SpanId`, and `TraceFlags`, with their resource and instrumentation scope. |
| Spans | Trace/span identity, parent span identity, trace flags/state where permitted, name, kind, start/end times, typed attributes, events, links, status, and source-reported dropped counts, with resource and instrumentation scope. |
| Resource and scope | Resource attributes identifying the emitting service/deployment and instrumentation scope name/version/attributes; preserve applicable schema URLs. |

Keep log fields and span fields in their proper models: a log's body and
severity are not a span status, and a span event or link should not become an
invented log record. Preserve the distinction between event time and observed
time. Request, session, execution, and domain IDs that are not trace/span IDs
remain classified custom reference fields or namespaced attributes; never coerce
them into W3C identifiers. Validate the applicable ID shape and encoding, but
remember that even a valid propagated trace ID is caller-influenced correlation,
not proof of ownership, authenticity, or permission to fetch related records.
Telemetry describing the evidence-fetch workflow remains distinct from incident
telemetry; use links for that relationship rather than fabricate parent spans.

Use existing semantic conventions where their meaning fits; record the bundle
schema version and the applicable convention/schema version when known. Do not
label guessed mappings as source facts or claim a schema URL the source did not
supply unless an explicit versioned transform performed that conversion. Keep
application-specific attributes in an application-owned namespace, and do not
silently change their type or meaning across bundle revisions. Classification
and redaction apply to bodies, attributes, events, links, resource identity, and
trace state as well as obvious session IDs.

A released bundle is an authorized projection, not necessarily a complete OTLP
message or a replayable export. Record field omissions and transforms in the
evidence envelope, separately from source-reported sampling and dropped counts.
Missing spans, filtered services, or expired logs must not be filled with
synthetic successful records or presented as a complete trace. Preserve source
provenance and access decisions outside telemetry fields: OpenTelemetry shape
and a content digest do not establish trust or grant access.

### Transport and retrieval

[OTLP](https://opentelemetry.io/docs/specs/otlp/) transports telemetry over gRPC
with protobuf, or HTTP POST with binary protobuf or protobuf JSON encoding.
OTLP/HTTP is a telemetry export protocol, not a general REST API for
querying historical records or opening issues. Reuse an application's existing
SDK and Collector/export pipeline. Kitsoki does not introduce a second exporter
or require changing the logging backend to support reference evidence.

Keep JSON-RPC as feedback/Story control: submit references, inspect durable
status, and obtain issue-scoped evidence. Configured Stories use permitted typed
host reads against the system retaining records. Those backend APIs may use HTTP,
gRPC, or another admitted protocol, but their query dialect and authentication
stay behind host capabilities. OTLP compatibility does not imply a standard
cross-vendor historical query API. The [telemetry integration contract](observability-evidence-providers.md)
describes optional lookup conventions within this boundary.

The governing references are the [OpenTelemetry logs data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/),
[trace API model](https://opentelemetry.io/docs/specs/otel/trace/api/),
[resource conventions](https://opentelemetry.io/docs/specs/semconv/resource/),
[semantic conventions](https://opentelemetry.io/docs/specs/semconv/),
and [W3C Trace Context](https://www.w3.org/TR/trace-context/).

## Review, automatic release, and privacy

Unreleased candidates remain in bounded, expiring quarantine with no ordinary
agent or GitHub access. The existing per-item exact-digest review remains the
default for browser uploads and for fetched data without an applicable automatic
release policy. This design adds an explicit deployment-controlled alternative:
a policy can automatically release a specified classified projection to a
specified audience and purpose. Its receipt binds the exact projection digest,
policy and transform revisions, scope, and expiry. It is not a blanket bypass
of review and cannot authorize unknown classifications or raw-provider export.

Evaluate GitHub publication, agent prompt insertion, host retrieval, and model
processing as separate destinations. Permission to show a user a record does
not imply permission to publish it or send it to a model. GitHub receives a
safe description and an opaque internal evidence reference, not production
logs, session IDs, secrets, or bearer links. Treat public issue content as
irreversible disclosure; later internal revocation cannot recall it.

A configured zero-retention model route can be required for an authorized
projection. Enforce that route in the host, refuse unavailable or disallowed
fallbacks, and apply existing visibility controls before sending data. Provider
retention settings do not eliminate PII from runtime traces, prompts, job
artifacts, caches, or GitHub. Each storage and processing path needs the same
classification and retention enforcement. Sensitive raw data must not leak
through Story debug output, error messages, audit logs, or capability receipts.

Pin the admitted Story, schema, and transform revisions for reproducibility;
check current authorization, revocation, and retention restrictions at every
fetch and release. A historic approval cannot override a revoked role or expired
record. Current policy may narrow access; widening it requires a new release
decision. Record both the pinned execution revision and current authorization
decision so a later investigation can explain the result.

## Bugfix-agent handoff

The existing dispatch path supplies a server-owned evidence binding alongside
its issue context. It must not accept an arbitrary evidence handle from
`job_inputs` or trust a handle pasted into the GitHub issue body. Assignment
validation checks the canonical repository/issue, job, tenant, and release
purpose; a copied issue link grants no access.

The prompt receives a bounded manifest: schema/version, safe summary, available
projections, omissions, expiry, and the issue-scoped retrieval handle. If policy
allows it, small released projections can be included directly. Larger or
sensitive projections remain available through the same native Starlark/typed
host boundary. An illustrative `read_issue_evidence` operation derives the
issue and job from trusted execution context; its caller can request an admitted
projection or narrower bounds, never another tenant, raw query, or credential.
The operation name is a design placeholder, not a shipped API.

Lazy reads recheck current authorization and return receipts. An unassigned or
terminal job, changed assignment, revoked role, expired bundle, or deleted source
must refuse further access as policy requires. Already inserted prompt text
cannot be recalled; minimize prompt content and apply job/session retention.
Provider errors must not trigger a privileged fallback or arbitrary agent web
fetch. Evidence content is marked as data and cannot change agent instructions,
issue identity, allowed tools, or release policy.

## Availability semantics

Track validation, retrieval, release, filing, and assignment separately. An
issue can have validated references while some records are unavailable. The
internal manifest distinguishes `no_match`, `not_sampled`, `expired`, `rotated`,
`deleted`, `unauthorized`, `provider_unavailable`, `budget_exhausted`, and
`truncated`. Preserve counts and continuation limits where permitted. Public
and caller projections may coarsen these states to avoid disclosing existence.
Neither an empty list nor a successful transport response is evidence of a
complete fetch. Policy determines whether a partial bundle is sufficient to
file; failure of mandatory ownership validation is always a refusal.

## Acceptance and adversarial cases

These are implementation acceptance requirements, not tests claimed to pass:

| Case | Required observable outcome |
| --- | --- |
| Own session and real request | Authoritative relationship receipt, safe filed issue, assigned job can read its permitted evidence. |
| Missing reference or fabricated request | Reference-required route refuses before filing; no pasted log can substitute. |
| Real request in another session/tenant | Refused without caller-visible existence leakage; internal audit records reason. |
| Authorized delegated support role | Explicit scoped delegation permits the expected reference; unrelated cases remain denied. |
| Valid trace with restricted downstream service | Allowed projection only; restricted traversal is bounded and omitted. |
| Caller changes Story, query, destination, scope, or policy | Unknown or privileged fields rejected; configured bindings remain authoritative. |
| Two custom Story bundle schemas | Both work through the common envelope without core vendor-specific adapters. |
| Telemetry profile and redaction | Log/span fields, resource/scope, typed values, and IDs preserve their model; filtered fields and missing spans are explicit and cannot imply a complete trace. |
| OTLP-compatible source | Existing export pipeline stays intact; historical reads still require authorized backend lookup and cannot treat trace identity as permission. |
| Retry, concurrent submit, lost GitHub reply | One canonical filing outcome; conflict on retry key with changed content. |
| Fetch timeout, partial trace, expired source | Durable classified state, bounded retry, no false complete success. |
| Custom payload includes secrets or unknown classification | Quarantine/refusal; nothing reaches GitHub or an ordinary agent. |
| Automatic release vs review | Exact permitted projection receives a policy receipt; all other data requires review. |
| Revocation after validation or before lazy read | Current policy refuses release/read despite a pinned older Story or approval. |
| Handle copied to another issue/job or forged in issue text | No access; trusted assignment controls lookup. |
| Prompt injection inside real logs | Treated as evidence content; cannot invoke extra capabilities or alter policy. |
| Required zero-retention route unavailable | Processing refused; no silent model-route fallback. |
| Retention expiry and deletion | All governed copies follow policy; receipt states what remains and why. |

## Small integration sequence

1. Confirm the existing application feedback and generic report routes that
   need the optional reference gate; preserve canonical identity, report
   idempotency, reviewed listing, and dispatch behavior. Define the narrow
   envelope and refusal results before adding configuration.
2. Bind one ordinary `.kitsoki` Story to intake. Reuse an existing typed host
   session/request lookup if available after verifying its authorization contract;
   otherwise identify the narrow missing auth-bound host operation. Prove
   authenticated relationship validation and one custom bundle end to end.
3. Extend existing evidence persistence/review with policy release receipts and
   the durable issue binding; exercise filing reconciliation and refusals.
4. Pass that binding through existing bugfix dispatch and prompt assembly;
   expose bounded issue-scoped retrieval through the host. Prove a real assigned
   agent can obtain only that issue's released records.
5. Demonstrate a second application-defined Starlark resolver and bundle schema
   using a different source, plus the adversarial cases above. This establishes
   extensibility without making a catalog of vendor adapters a prerequisite.

Record implementation and live proof separately as these steps land. This
brief changes the design contract only; it does not enable reference-required
submission or automatic evidence access in a running environment.
