# Kitsoki Feedback documentation

## Use the product

The [Kitsoki Feedback guide](guide/README.md) covers the complete workflow:

- [01 — project setup, evidence storage, and GitHub](guide/01-setup.md);
- [02 — What's new and feature tours](guide/02-whats-new-and-feature-tours.md);
- [03 — feedback capture and triage](guide/03-collect-and-triage.md);
- [04 — product tours](guide/04-product-tours.md);
- [05 — interactive QA with agents](guide/05-interactive-agent-qa.md);
- [06 — repeatable browser tests](guide/06-repeatable-tests.md);
- [07 — MCP, Starlark, and host automation](guide/07-surfaces.md);
- [08 — backend logs and distributed traces](guide/08-observability-evidence.md).

## Understand the contracts

- [Concept](concept.md)
- [Chrome extension mode](requirements/extension-mode.md)
- [Rich evidence sidecars](requirements/rich-evidence-sidecars.md)
- [Reference-backed feedback through native Stories — detailed proposed design](requirements/reference-evidence-stories.md)
- [Correlated observability evidence](requirements/observability-evidence-providers.md)
- [Embedded demo control](embedded-demo-control.md)

The guide is task-oriented. The requirement and control documents define the
wire formats, privacy boundaries, bounds, and refusal behavior used by those
tasks.
