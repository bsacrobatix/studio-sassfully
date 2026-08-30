# Set up Kitsoki Feedback

This guide configures one project with both capture modes, a durable evidence
destination, and GitHub issue routing. You may stop after the extension step and
add application integration later.

## 1. Create the project

From the repository that owns the product, run:

```sh
kitsoki feedback init
```

The command creates `.kitsoki/feedback.yaml` and a local project identity. It
does not enable capture, create a remote bucket, or send data.

```yaml
version: kitsoki.feedback/config/v1

project:
  id: acme-console
  display_name: Acme Console

privacy:
  profile: customer-safe
  pseudonym_scope: report
  retention_days: 30

capture:
  allowed_origins:
    - https://console.acme.example
  rolling_window_seconds: 90
  max_local_bytes: 8388608

routing:
  default: github
```

Commit this file. It contains policy and opaque role names, never credentials.

Validate it before continuing:

```sh
kitsoki feedback doctor
```

`doctor` checks the project identity, privacy profile, origin rules, evidence
destination, GitHub connection, and local browser integration. It reports each
capability separately; it never treats an unavailable evidence store as an
empty, successful one.

## 2. Install the Chrome extension

Install **Kitsoki Feedback** from the Chrome Web Store and pin it to the
toolbar. On a page you want to test:

1. Open the extension.
2. Select **Enable for this site**.
3. Choose **Rolling buffer** or **Record on demand**.
4. Confirm the toolbar badge says **ON** or **REC**.

Enablement is per origin and stored locally. Disabling the origin stops capture
and clears its live ring. The extension never depends on the page implementing
an SDK or exposing a test hook.

For an unpacked development build, use:

```sh
make ext-install
```

Then load `packages/feedback-extension/dist` at `chrome://extensions`.

## 3. Add the embedded toolbar

An integrated product mounts the reporter once near its application root:

```js
import { createFeedbackReporter } from "@kitsoki/feedback-core";

const feedback = createFeedbackReporter({
  project: "acme-console",
  anchor: () => ({
    producer: "acme-console",
    artifactId: router.currentRoute.value.name,
    revision: window.__APP_REVISION__,
  }),
  privacyManifest: "/feedback/privacy-manifest.json",
});

feedback.mountToolbar(document.body);
```

The toolbar starts with the same conservative capture providers as the
extension. Add semantic anchors and typed providers progressively; callers do
not need to redesign routing or evidence storage when integration gets richer.

When the extension is also enabled, the page and extension negotiate the
versioned bridge. The toolbar owns the report, privacy manifest, review, and
sinks; the extension contributes its bounded browser evidence.

## 4. Configure an evidence destination

The report is intentionally small. Replays, screenshots, traces, and network
records belong in an evidence destination that supports immutable objects,
digest verification, retention, and signed reads.

Kitsoki Feedback supports:

- **Kitsoki Evidence**, the managed destination;
- an **S3-compatible bucket**, including Cloudflare R2, Amazon S3, and MinIO;
- **local only**, for evaluation and air-gapped work.

### Managed destination

```sh
kitsoki feedback evidence add managed --name primary
kitsoki feedback evidence verify primary
```

The first command opens an authorization flow. The credential is held by the
Kitsoki runtime and the configuration records only `feedback.evidence.primary`.

### S3-compatible destination

Create a private bucket with object versioning or write-once retention enabled,
then run:

```sh
kitsoki feedback evidence add s3 \
  --name primary \
  --bucket acme-feedback-evidence \
  --region auto \
  --endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com \
  --credential-role feedback.evidence.primary

kitsoki credential bind feedback.evidence.primary
kitsoki feedback evidence verify primary
```

`credential bind` stores the authority in the configured secret provider. It
does not write a secret into `.kitsoki/feedback.yaml`, a story, a trace, or a
test fixture.

The resulting policy is declarative:

```yaml
evidence:
  destination: primary
  object_prefix: projects/acme-console
  encryption: provider-managed
  signed_read_ttl: 15m
  delete_after_days: 30
```

Objects are addressed by report reference and content digest. A retry cannot
silently replace different bytes at the same address.

### Local-only destination

```sh
kitsoki feedback evidence add local --name local-review
```

Local mode stores reviewed bundles and approved sidecars under the Kitsoki
artifact store. Export produces a JSONL ledger plus an `evidence/` directory.
Nothing is uploaded, and GitHub issues contain local-only evidence markers
rather than broken links.

## 5. Connect GitHub

Install the Kitsoki GitHub App on the repository that should receive reports:

```sh
kitsoki feedback github connect --repo acme/acme-console
kitsoki feedback github verify
```

Choose the minimum repository permissions offered by the setup screen: read
metadata and write issues. Add pull-request or contents permissions only if a
separate agent workflow needs them; feedback filing itself does not.

Configure routing:

```yaml
github:
  repository: acme/acme-console
  labels:
    default: [feedback]
    bug: [bug, feedback]
    usability: [ux, feedback]
    qa_failure: [bug, qa, feedback]
  include:
    evidence_manifest: true
    signed_evidence_links: true
    raw_sidecars: false
```

The GitHub issue receives reviewed text, the semantic anchor, environment and
revision metadata, reproduction steps, evidence digests, and short-lived links
authorized for the viewer. Raw sidecars are not copied into GitHub by default.

Test the connection without filing an issue:

```sh
kitsoki feedback github verify --dry-run-report
```

## 6. Set review and retention policy

The `customer-safe` profile is the normal default:

- report-scoped deterministic pseudonyms;
- capture-time input masking;
- credential-shaped values removed;
- query strings and home-directory paths normalized;
- raw evidence unchecked for upload;
- explicit reviewer approval per sidecar;
- 30-day evidence retention.

Use `internal-qa` only for controlled employee environments, and use
`export-safe` when the resulting bundle will leave your organization. A looser
profile does not turn credentials into acceptable trace data.

Finish with:

```sh
kitsoki feedback doctor --require extension,evidence,github
```

The command exits successfully only when all three named capabilities return
valid receipts.
