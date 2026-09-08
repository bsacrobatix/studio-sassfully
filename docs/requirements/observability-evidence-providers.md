# Correlated observability evidence: provider and privacy contract

**Status:** design requirements, originally accepted 2026-08-30; refined
2026-09-08. Provider and API examples are not a claim of implementation.

The governing extension model is [reference-backed feedback through native
Stories](reference-evidence-stories.md). Application-owned Starlark validates
authoritative references, fetches through permitted host capabilities, and builds
custom bundles. This document specializes that contract for telemetry; it does
not require a separate provider framework.

This contract defines how a reviewed feedback journey links to backend logs and
distributed traces without making a browser, an agent, or a story a privileged
observability client. It applies equally to extension capture, the embedded
toolbar, manual QA, agent QA, and repeatable test runs.

## Standards boundary

Kitsoki uses [W3C Trace Context](https://www.w3.org/TR/trace-context/) and the
[OpenTelemetry logs data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
as the canonical cross-service correlation shape. `TraceId`, `SpanId`, resource
identity, timestamps, and typed attributes remain recognizable when telemetry
moves between vendors.

OpenTelemetry is the interoperability layer, not the evidence store. An OTLP
pipeline may deliver telemetry to Jaeger, Grafana Tempo and Loki, Elastic, a
cloud service, or another backend. Jaeger v2 is built on the OpenTelemetry
Collector framework; Kitsoki therefore treats Jaeger as a trace-query provider,
not as a competing propagation format.

Browser OpenTelemetry is an optional source adapter. The OpenTelemetry
JavaScript project currently describes browser client instrumentation as
experimental and mostly unspecified, so Kitsoki relies on W3C trace identity
and its own versioned correlation envelope rather than depending on one browser
SDK's private span layout.

An integrated browser registers a non-exporting Kitsoki span processor with its
existing OpenTelemetry web tracer provider. The processor retains a bounded
local ring of trace and span identity; it does not install another provider,
exporter, sampler, or propagation policy. Extension-only capture cannot inspect
an application's in-memory SDK and instead uses explicitly allowlisted network
headers or an admitted page bridge.

## Correlation envelope

A capture source may offer one or more correlation values:

- W3C trace ID and, when known, span ID;
- application request or operation ID;
- session, conversation, execution, or job ID;
- a provider request ID;
- a timestamp window and service or environment scope.

The source records how each value was obtained: active browser span, explicitly
allowlisted response header, integrated application context, runtime trace, or
operator entry. The browser never supplies a provider URL, index, bucket,
namespace, query language, or credential.

Correlation values are classified before submission. A trace ID is normally a
direct lookup identifier, not PII, but it can still enable cross-event
profiling. Policy may preserve it, seal it for server-side lookup, or omit it.
Session and customer-derived identifiers default to sealed lookup handles.
Credential, cookie, authorization, and baggage values are never correlation
handles.

The reviewed report contains an opaque correlation handle plus its kind,
source, scope, time bounds, classification, and digest. The resolver receives
the underlying value only inside the trusted host boundary.

## Provider interface

A telemetry Story may organize its read-only work using these conventions.
They are optional Story boundaries, not a mandatory adapter interface:

| Operation | Input | Result |
| --- | --- | --- |
| `capabilities` | Provider configuration. | Signals, supported correlation kinds, and hard limits. |
| `plan` | Reviewed handle, scope, and bounds. | Resolved read plan with no telemetry records. |
| `fetch` | Approved plan revision. | Normalized candidate records, omissions, continuation, and source receipt. |

`plan` binds a reviewed correlation handle to an administrator-defined query
template. It rejects arbitrary browser- or agent-authored query strings.
`fetch` applies exact time, service, environment, record, byte, and duration
bounds before returning data.

Telemetry payloads should use OpenTelemetry-shaped trace or log records where a
lossless mapping exists. Other custom bundle schemas remain valid under the
common envelope. Unmapped provider fields remain namespaced attributes.
Every result records provider, query-template revision, source identities,
window, truncation, sampling, inaccessible sources, returned count, content
digest, privacy transform, and read receipt.

Credentials are resolved from host credential roles. They never enter a
report, MCP argument, Starlark value, trace, scenario, or evidence artifact.

## Initial adapters

Possible application-owned Story integrations include:

- local JSONL, NDJSON, and text artifacts through a bounded literal search;
- S3-compatible immutable objects and manifests;
- OpenTelemetry/OTLP trace identity;
- Jaeger v2 and Grafana Tempo trace lookup by trace ID;
- Grafana Loki and Elasticsearch bounded log queries;
- Kubernetes current or previous container log snapshots;
- a composite adapter that joins trace records to log records by trace and span
  identity.

`grep`, `rg`, `kubectl`, provider CLIs, and HTTP APIs are executor details
behind these adapters. They are not exposed as commands to an agent or story.

## Trust and refusal rules

- Fetch is read-only and requires authenticated scope and a validated reference.
  A reviewed handle alone does not prove ownership or request/session membership;
  the configured Story verifies those relationships through authoritative host
  lookups before broader retrieval.
- Browser capture uses an explicit response-header allowlist; it never captures
  every header.
- Trace baggage is not imported by default.
- A request ID may locate a trace, but it does not prove that all services were
  sampled or all logs were retained.
- Missing, sampled, rotated, evicted, or unauthorized telemetry is reported as
  missing with a reason, never rendered as an empty successful result.
- Kubernetes pod logs are ephemeral evidence unless copied into a durable
  reviewed bundle; cluster-level storage is preferred for retained proof.
- Raw provider responses remain outside GitHub. GitHub receives the normalized
  summary, permitted digest, and opaque internal evidence binding; no bearer link.
- Every retained result requires an exact-digest release decision and retention
  policy. Individual review remains the default; an explicit configured policy
  may release a classified projection automatically under the
  [Story evidence contract](reference-evidence-stories.md#review-automatic-release-and-privacy).
  Browser sidecar upload approvals remain unchanged.

## Microservice traversal

A single browser action can produce a frontend span, an HTTP client span, an
ingress or gateway span, and server spans across several services. Context
propagation preserves the trace ID while span IDs identify each operation.
Kitsoki fetches the trace first, derives the participating service and span
identities, and then asks configured log providers for the bounded records
correlated to those identities.

Application request and session IDs remain useful compatibility joins. They may
locate the first server record when browser tracing is unavailable, after which
the resolver follows its trace ID. This progressive path lets an existing C#,
Java, Go, Node, or Kubernetes service integrate without replacing its logging
stack first.
