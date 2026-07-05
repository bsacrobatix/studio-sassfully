# sassfully

A generic, contextual-feedback framework: bring your own presentation, let
users file feedback — bug reports, feature requests, mistranslation reports,
customization asks — anchored to a semantic location inside your system, and
route each item to the outcome it deserves (a comment, an issue, an AI edit
instruction, a local note, a support request).

Feedback is not mutation: the reviewed note is the artifact; anything that
changes the host system is a downstream outcome. Capture is opt-in and
privacy-controlled per host — PII stripping by default, optional
screenshot/replay evidence per feedback kind.

**Status: pre-code.** Requirements live in [docs/](docs/) (the concept and the
host-neutral feedback brief); the typed catalog (`pog/catalog.yaml`) and the
first package (feedback-core: anchor contract + capture widget + local-note
outcome) come next. Development follows a catalog-first loop — the object
graph exists before the first line of code.

## License

Apache-2.0 — see [LICENSE](LICENSE).
