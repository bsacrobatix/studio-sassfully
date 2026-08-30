# Collect and triage feedback

Kitsoki Feedback keeps capture, review, storage, and downstream action as
separate steps. A person can abandon a draft without sending anything, submit a
report without uploading raw evidence, or retain evidence without creating a
GitHub issue.

## Report from the embedded toolbar

1. Open the product surface where the problem occurs.
2. Select **Feedback** in the embedded toolbar.
3. Choose a kind: **Bug**, **Usability**, **Content**, **Feature request**, or
   the project-defined kind.
4. Point at an element or use the application-provided semantic anchor.
5. Describe the expected and observed behavior.
6. Select **Attach recent activity** if the preceding journey matters.
7. Review the report and each evidence item.
8. Select **Submit**.

On an integrated page, the review screen shows both the human location and the
stable application anchor:

```text
Settings > Team > Invite member
application: acme-console
route: team-settings
component: invite-member-form
revision: sha256:8d4a...
```

That stable anchor survives copy changes and helps an agent find the same
surface in a newer revision.

## Report from the Chrome extension

1. Enable the origin and reproduce the problem.
2. Open the extension and select **Report this page**.
3. Optionally pick an element or draw a box.
4. Describe what happened.
5. Choose a replay window or attach a screenshot.
6. Review classifications, substitutions, and upload choices.
7. Save locally or submit to the configured project.

The extension strips the URL query and fragment from the default anchor. It can
use a CSS selector and bounding box for the picked element, but it cannot invent
the application's business meaning. An integrated product can later enrich the
same report with a semantic anchor.

## Review evidence

Evidence is itemized. A normal bug report might show:

| Item | Default | What is reviewed |
| --- | --- | --- |
| Screenshot | off | Exact image after redaction and crop. |
| Replay | off | Bounded event window, masked inputs, and duration. |
| Console | off | Redacted messages and exceptions. |
| Network | off | Method, origin, path, status, and bounded redacted bodies. |
| Application trace | off | Typed events and pseudonym substitutions. |
| Environment | on | Browser, viewport, locale, app revision, and feature flags approved by policy. |

Selecting an item approves that exact digest. Editing or recapturing it creates
a new digest and clears the approval.

The report is submitted before sidecars. Evidence upload starts only after the
report receipt exists, and retries use the report idempotency key plus sidecar
digest. A sink that does not support sidecars records `skipped`; it does not
pretend evidence was uploaded.

## Triage a report

Open **Feedback inbox** in Kitsoki or list reports through MCP. Triage records:

- disposition: reproduce, needs information, duplicate, expected behavior,
  convert to scenario, or route to product work;
- severity and affected surface;
- evidence sufficiency;
- linked GitHub issue, object-graph proposal, tour, and scenario;
- reviewer and receipt references.

The original report remains immutable. Triage appends decisions and links.

### Route to GitHub

Select **Create GitHub issue** or run:

```sh
kitsoki feedback issue create REPORT_REF --sink github
```

The issue body contains:

```text
Observed behavior
Expected behavior
Reproduction journey
Affected application revision
Semantic anchor
Evidence manifest and approved links
Privacy/review receipt
Kitsoki report reference
```

Repeated routing with the same report and destination returns the existing
issue receipt. It does not file a duplicate.

### Ask for more information

Add a question to the report thread. The reporter can answer without granting
new evidence. A new attachment goes through the same local review and creates a
new evidence digest.

### Send to an agent

Select **Start QA session**. Kitsoki creates a bounded agent session with:

- the reviewed report projection;
- the exact application/environment target;
- approved evidence handles, not ambient access to the evidence store;
- typed browser and feedback tools;
- no credential values;
- a session recording and receipt.

See [interactive agent QA](05-interactive-agent-qa.md) for the operating loop.

## Common reporting patterns

### A failure that just happened

Use the rolling buffer and attach the last 30–90 seconds. Keep the written
reproduction short; the replay preserves the exact sequence.

### An intermittent failure

Start on-demand recording before the risky action. Add a short marker when the
symptom appears so the reviewer and agent can jump to it.

### Sensitive forms

Prefer an integrated semantic anchor and environment metadata. Do not attach a
replay unless the privacy preview proves the form values are masked. Credentials
remain unrepresentable even in an internal profile.

### A visual defect

Attach a cropped screenshot, viewport information, and a semantic anchor. Add a
short replay only when animation, focus, scroll, or timing is part of the bug.

### A backend/API defect visible in the UI

Attach redacted request metadata and an application trace. Do not paste access
tokens, cookies, full connection strings, or arbitrary response bodies into the
description.

### Product feedback rather than a defect

Use the same anchor and report object, then route it to a catalog proposal or
product inbox. Feedback does not directly mutate the object graph; the routed
change remains a reviewed proposal.
