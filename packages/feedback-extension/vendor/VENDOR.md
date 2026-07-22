# Vendored third-party artifacts

## rrweb-record.iife.js

- Package: `rrweb` (record-only prebuilt browser build)
- Version: `2.0.0-alpha.4`
- Source URL: <https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.4/dist/record/rrweb-record.min.js>
- SHA-256: `bf8fa2f53188426c64b26fabfd595b76a688e13fd3fa3ba0a1684680cc962c82`
- License: MIT (rrweb-io/rrweb)
- Fetched: 2026-07-20

Exposes the `rrwebRecord` global consumed by `ext/main-world.js`. The player
is deliberately not shipped — exported clips replay in external rrweb tooling;
an in-extension viewer is a catalog follow-on. To upgrade: pin a new version,
re-record the URL and hash here, and re-run the build smoke test.
