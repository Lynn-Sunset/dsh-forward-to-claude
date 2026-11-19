# Changelog

All notable changes to this project are documented here.

## [1.0.3] - 2026-11-19

Runtime compatibility fix.

- Removed the undeclared `ctx.clock` service access from `start`. Production
  folder naming now uses the standard `new Date()`; Cordis rejects reading an
  uninjected service property even through optional chaining.
- Tests no longer inject a mock `clock` into the Host context. The harness now
  installs a throwing `clock` getter that mirrors Cordis, and fixed-time tests
  freeze the standard `Date` constructor instead.
- Added a regression that calls `start` against the throwing-clock harness.
- Version bumped to 1.0.3; release archives rebuilt.

## [1.0.2] - 2026-11-19

Interrupted-publish recovery and completeness fixes.

- Finalize saves a private staging snapshot beside the bundle before removing
  `SOURCE.md`/`BRIEF.json`. If the process exits mid-publish, status reports
  `incomplete` with the recovery message, and a repeated finalize call with the
  same arguments resumes from the snapshot. The snapshot is removed after a
  successful commit.
- `manifest.json` is committed only after the prepared artifacts, folder
  inventory, and their read-back contents pass verification.
- `status` requires both `SOURCE.md` and `BRIEF.json` for
  `awaiting_translation`; a missing staging file is `incomplete`, and finalize
  refuses it.
- The fresh-process interruption regression now launches the child with
  ignored stdio, so it also runs in the DSH Windows sandbox instead of failing
  before the child starts.
- Version bumped to 1.0.2; release archives rebuilt.

## [1.0.1] - 2026-11-19

Safety and portability fixes found in the 1.0.0 review.

- Finalize is transactional: it preflights the handoff folder, writes
  `HANDOFF.md`, `REVIEW.md`, and `PROMPT.md`, verifies them, deletes staging,
  then publishes `manifest.json` last as the success marker. A failure after
  writing rolls back the final artifacts, restores `SOURCE.md` and `BRIEF.json`,
  and leaves status `awaiting_translation` instead of a false `ready`.
- `status` validates the manifest and all four final artifacts. It reports
  `ready` only for a parsed `status: "ready"` manifest listing all four regular
  files, otherwise `awaiting_translation`, `incomplete`, or `invalid`. Finalize
  refuses an incomplete/invalid latest bundle.
- Unexpected entries and symlinked/non-regular bundle files are refused before
  writes. `BRIEF.json`, `SOURCE.md`, `HANDOFF.md`, and `manifest.json` reads go
  through an lstat/realpath boundary check that refuses symlinks and escapes.
- Same-second handoff folders sort by numeric suffix (`-10` is newer than
  `-9`), with the unsuffixed form treated as suffix 0.
- `npm test` now runs `node --test tests/integration.mjs`, compatible with the
  declared Node.js >=22 engine range. Docs record `node tests/integration.mjs`
  as the direct fallback for the DSH Windows sandbox.
- Added regressions for extra drafts, manifest-last publishing, rollback,
  status validation, numeric ordering, file symlinks, and the package
  test/engine contract.

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
