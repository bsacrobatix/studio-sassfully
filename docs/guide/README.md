# Kitsoki Feedback guide

Kitsoki Feedback turns a product conversation into durable, reviewable work.
Users can point at the part of a page they mean, describe what happened, attach
an approved replay or screenshot, and send one reviewed report. Teams can route
that report to GitHub, inspect it with an agent, replay the journey as a tour,
and promote a useful QA session into a deterministic browser test.

The same lifecycle works at every adoption level:

```text
capture locally -> review -> submit report -> upload approved evidence
                -> GitHub / agent QA / tour / repeatable test
```

## Choose a capture mode

| Mode | What the product must do | What Kitsoki Feedback can capture |
| --- | --- | --- |
| Chrome extension | Nothing. Enable the extension for an origin. | Page location, picked element, bounded replay, screenshot, console/error summaries, and network metadata. |
| Embedded toolbar | Mount the toolbar package. | Everything in extension mode plus application identity, semantic anchors, user/session-safe context, and host-defined evidence providers. |
| Integrated application | Declare feedback anchors, a privacy manifest, and test identities. | Typed provenance, stable semantic locations, business-object references, and higher-fidelity replay. |
| Kitlark v2 | Declare classifications and feedback/test contracts in the application specification. | Runtime-enforced classification, taint propagation, typed trace events, and deterministic synthetic replay. |

The extension detects an integrated page and becomes an evidence provider for
the embedded toolbar. It does not open a second reporter or create a second
report.

## Start here

1. [Set up a project, evidence destination, and GitHub](setup.md).
2. [Collect and triage feedback](collect-and-triage.md).
3. [Author and run product tours](tours.md).
4. [Run interactive QA with an agent](interactive-agent-qa.md).
5. [Turn a QA journey into a repeatable test](repeatable-tests.md).
6. Use the [MCP, Starlark, and host reference](surfaces.md) when automating the
   workflow.

## The four durable objects

Kitsoki Feedback uses four objects rather than treating a bug report as a blob:

- A **report** contains reviewed text, a semantic anchor, classifications,
  evidence metadata, and routing state.
- An **evidence bundle** contains approved sidecars such as replay, screenshot,
  console, network, and trace data. The report contains digests, not raw bytes.
- A **receipt** proves what was stored, uploaded, filed, or run. A successful
  command without a receipt is not durable completion.
- A **scenario** is a reviewed `test-flow/v1` program with explicit actions and
  assertions. A replay alone is not a scenario.

All four retain the report reference. That is the join key from the toolbar to
the evidence store, GitHub issue, agent session, tour execution, and test
receipt.

## Safety defaults

- Capture is off until a person enables a site or an application opts in.
- Raw capture stays local until review.
- Input values are masked at capture time.
- Every evidence item has its own upload approval.
- Secrets and credential values are never represented in reports, traces,
  scenarios, or tours. Runtime credential roles are bound separately.
- GitHub receives reviewed prose and evidence references by default, not raw
  replay or HAR files.
- Unknown privacy classifications block submission.
- Agents receive the reviewed projection unless a person explicitly grants a
  bounded evidence item for that session.

See [rich evidence sidecars](../requirements/rich-evidence-sidecars.md) for the
transport contract and [extension mode](../requirements/extension-mode.md) for
the zero-integration capture boundary.
