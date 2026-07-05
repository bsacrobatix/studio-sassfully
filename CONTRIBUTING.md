# Contributing to sassfully

sassfully is Apache-2.0. Development is catalog-first: changes trace to nodes
in the typed object graph (see AGENTS.md for the repo conventions — protected
main, `.worktrees` branch worktrees, `scripts/checks.sh` as the landing gate).

Until the GitHub remote is wired, contributions land locally via
`scripts/merge-to-main.sh`; after that, PRs gate on the same `checks.sh`.
