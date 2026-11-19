# Changelog

All notable changes to this project are documented here.

## [1.0.0] - 2026-11-19

Initial public release.

- Host-only DSH bundle exposing the global `forward_to_claude` tool.
- Interactive source selection through DSH question cards: conversation,
  UTF-8 project files, and a typed handoff note.
- Session-specific `forward-to-claude/<session-id>/handoff-<timestamp>/` output.
- English-only handoff generation with a section-by-section fidelity review.
- Known high-confidence regional-trace scan with neutral aliases and a
  six-field scrub checklist.
- Trace-free T ledger and model-authored whole-document consistency audit.
- Optional M rows for entities the mechanical scanner missed.
- Exact section/file-label checks, alias-declaration checks, and fail-closed
  finalize.
- Ready-to-paste `PROMPT.md` plus `HANDOFF.md`, `REVIEW.md`, and
  `manifest.json`.
- Twenty-five integration tests covering the happy path, containment,
  redaction, no-echo errors, consistency drift, shared aliases, and failure
  handling.
