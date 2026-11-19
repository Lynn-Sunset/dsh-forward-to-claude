# Security

## Reporting

Do not open a public issue for a security-sensitive report. Contact the
maintainer privately through the repository's security contact or GitHub
Security Advisories.

## Design boundaries

- No network access, telemetry, or Claude communication.
- Reads are limited to explicitly selected files under the session working
  directory and are realpath-checked against symlink/junction escapes.
- Writes are confined to the handoff folder; start, finalize, and status check
  folder containment.
- The plugin never stores credentials and has no configuration secrets.
- The generated prompt is plain text; it is not sent by the plugin.

## Scope

The plugin cannot prove semantic fidelity or entity identity. Its mechanical
gates cover known high-confidence regional forms, alias grammar, ledger
coverage, and exact section/file labels. The model-authored review, scrub, and
consistency attestations are visible in `REVIEW.md` for the person who forwards
the bundle.
