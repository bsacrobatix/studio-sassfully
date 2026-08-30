# Interactive QA with an agent

Interactive QA is the bridge between a human report and a deterministic test.
The agent observes a bounded product surface, takes typed actions, records what
it saw, and works with the operator to decide which behavior is a defect. The
session can file a GitHub issue immediately and can save a reviewed journey for
test promotion.

## Start from a report

Open a reviewed report and select **Start QA session**, or use MCP:

```text
feedback.list -> choose reviewed report -> grant evidence handles
              -> embedded_demo {action: qa_start}
```

Choose:

- the exact application and environment;
- headed mode when you want to watch and steer;
- headless mode for a known reproduction;
- the approved evidence items the agent may read;
- whether the agent may create a local ticket, file a GitHub issue, or only
  return findings.

The agent gets evidence handles scoped to the session. It does not receive an
evidence-store credential or unreviewed capture.

## Start from a product surface

Use **Feedback > QA > Start session** in the embedded toolbar or extension.
The toolbar binds the focused tab. In extension mode, the site still does not
need to cooperate; integrated pages add application identity and semantic
anchors.

For an agent-owned browser, call `embedded_demo` with `qa_start`:

```json
{
  "action": "qa_start",
  "url": "http://127.0.0.1:4173/settings",
  "mode": "headed"
}
```

The server launches a disposable Chromium profile. A remote target must be an
explicitly allowlisted origin. Environment-held authentication is injected by
the runtime and redacted from captures; the agent never receives it.

## The interactive loop

Use a short observe–act–verify cycle:

1. **Observe.** Request a semantic snapshot. It returns roles, accessible names,
   test IDs, selectors, headings, and landmarks within declared bounds.
2. **State a hypothesis.** Record what should happen and what evidence would
   distinguish success from failure.
3. **Act once.** Click, fill, press, or select one named target.
4. **Observe the consequence.** Prefer semantic state; take a screenshot when
   layout or visual appearance matters.
5. **Mark evidence.** Add a marker at the action or symptom worth retaining.
6. **Ask the operator.** When product intent is ambiguous, do not convert the
   agent's guess into an assertion.

Example typed operations:

```jsonc
{"action":"qa_action","qaSessionId":"QA","operation":{"kind":"snapshot"}}
{"action":"qa_action","qaSessionId":"QA","operation":{"kind":"fill","selector":"[data-testid=display-name]","value":"Ada Example"}}
{"action":"qa_action","qaSessionId":"QA","operation":{"kind":"click","selector":"[data-testid=save]"}}
{"action":"qa_action","qaSessionId":"QA","operation":{"kind":"screenshot"}}
```

There is no general `eval` operation. CDP inspection, when enabled for an owned
QA browser, is allowlisted and bound to that single page session.

## Steer the agent

Useful steering is specific and observable:

- “Use the team-admin role and verify the Invite button is present.”
- “Reproduce report `FB-...`; stop after the first failed request.”
- “Explore keyboard behavior only; do not submit the form.”
- “Compare the empty, loading, populated, and error states.”
- “Record a candidate scenario, but ask before choosing assertions.”

Avoid instructions such as “test everything” or “make sure it works.” They do
not define a stopping condition or a reviewable verdict.

The operator can pause, take over the headed browser, annotate the timeline,
change the hypothesis, and return control. Operator actions and agent actions
are distinguished in the session receipt.

## File a defect with evidence

When the symptom is confirmed, call `issue.create` with the stopped visual
recording and report reference:

```json
{
  "title": "Team invite remains disabled after selecting a role",
  "body": "Expected the invite action to become available after a valid role was selected.",
  "labels": ["bug", "qa"],
  "repo": "acme/acme-console",
  "sink": "github",
  "include_visual_recordings": ["RECORDING_ID"]
}
```

Kitsoki renders the issue body, redacts the trace projection, stores the
evidence bundle, and files through the configured GitHub authority. The result
includes both an issue URL and evidence receipts. If GitHub is unavailable, the
local ticket and composed evidence remain available for retry.

## End the session

Before stopping:

1. Record the disposition of the original report.
2. Stop all recordings so their manifests are finalized.
3. Save useful journeys as scenario candidates.
4. File or link any GitHub issue.
5. Close the browser session and confirm the disposable profile receipt.

`done` without these receipts means the agent stopped; it does not mean the QA
outcome is durable.

## Common interactive testing patterns

### Happy path plus one boundary

Prove the main user goal, then test the nearest meaningful boundary: empty
input, maximum length, duplicate submission, or navigation away.

### State matrix

Visit empty, loading, populated, partial, error, and recovered states. Capture
an assertion for each state that matters rather than relying on screenshots
alone.

### Role and permission matrix

Run the same journey with role-bound synthetic identities. Credentials remain
outside the trace; receipts record only the abstract role and environment.

### Form validation

Use synthetic, type-correct values. Assert field-level error, submit admission,
focus behavior, and persistence separately. Do not put real customer data in a
fixture to make it “realistic.”

### Keyboard and accessibility

Drive focus using `press`, observe roles and accessible names, and assert focus
or visible state through the supported semantic snapshot. Use a visual capture
for clipping and focus-ring appearance.

### Error and recovery

Use an environment-provided fault fixture or cassette. Assert the visible
failure, retry action, and recovered state. Do not intercept arbitrary network
traffic with agent-supplied scripts.

### Visual regression

Pin viewport, locale, theme, data fixture, and application revision. Use
semantic assertions for behavior and a screenshot artifact for layout. Pixel
differences alone should not decide functional correctness.

### Exploratory tour review

Run the tour in headed mode, pause after each action, and compare the narration
with the visible consequence. Record anchor drift and pacing separately from
product behavior.

### Production observation

Use read-only actions against an allowlisted deployment. Never run a scenario
that writes unless the environment declares an isolated disposable realm. The
receipt must name the exact served application digest before and after the run.
