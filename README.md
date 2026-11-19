# Forward to Claude

[![CI](https://github.com/OWNER/dsh-forward-to-claude/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/dsh-forward-to-claude/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

A Host-only [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
bundle that prepares a reviewed, English-only handoff for Claude.

The plugin asks what to include, stages the selected session/project material,
rewrites identifying regional, organizational, and personal details into stable
neutral aliases, runs a model-authored whole-document consistency audit, and
returns a ready-to-paste prompt. It never contacts Claude and makes no network
requests.

## Features

- Asks through native DSH question cards; no separate UI is required.
- Includes the current conversation, selected UTF-8 text files, and a typed
  handoff note, in any combination.
- Creates a session-specific
  `forward-to-claude/<session-id>/handoff-<timestamp>/` folder under the
  current working directory.
- Replaces known high-confidence regional traces and personal-name patterns
  with neutral aliases; never writes a mapping back to the originals.
- Requires a model-authored **trace ledger** and **whole-document consistency
  audit** before publishing, so the same entity keeps one alias across sections.
- Mechanically checks ledger coverage, alias grammar and presence, declared
  alias-like tokens, exact section/file labels, and known file labels.
- Fails closed: validation happens before any final artifact is written, and
  `SOURCE.md` + `BRIEF.json` are deleted only after successful verification.
- Produces `HANDOFF.md`, `REVIEW.md`, `PROMPT.md`, and `manifest.json`.
- Imports only Node built-ins. No dependencies, no build step, no client entry.

## Requirements

- A DSH profile with `tools`, `systemPrompt`, `userQuestions`, and
  `workingDirectory`.
- Node.js 22 or newer.
- An interactive DSH UI (Web or CLI) with a user-questions answerer. Headless
  environments without an answerer cannot complete `start`.
- Tested against DSH `0.2.2-rc.5`.

## Install

### From a local clone

```powershell
git clone https://github.com/OWNER/dsh-forward-to-claude.git
cd dsh-forward-to-claude
```

Then in DSH:

1. Open **Plugins**.
2. Choose **Add plugin** and select the cloned package directory.
3. Enable **Forward to Claude**.

The equivalent agent/API action is:

```json
{
  "action": "install_bundle",
  "target": "C:/absolute/path/to/dsh-forward-to-claude"
}
```

### From GitHub

After the repository is public, a Git install spec can be used:

```text
plugin_manager install_bundle target: "github:OWNER/dsh-forward-to-claude"
```

Replace `OWNER` with the GitHub account or organization. Pin a commit if you
need a reproducible install.

## Use

In a session whose working directory is the project you want to hand off, say:

```text
把这个项目/这段会话整理成交接包，我要交给 Claude。
```

or explicitly:

```text
Please call forward_to_claude with action "start".
```

The model calls the global `forward_to_claude` tool. You then answer up to three
cards:

1. **What should Claude receive?** (multi-select)
   - Conversation so far
   - Text files from this project
   - A handoff note I write now
2. **Project files** — one path per line, relative to the working directory.
3. **Handoff note** — free text; it will be translated and scrubbed.

There is no slash command. If a model does not call the tool, ask it to call
`forward_to_claude` with action `start`.

### Check status

```text
Check the forward_to_claude status for this session.
```

The tool returns `none`, `awaiting_translation`, `ready`, `incomplete`, or
`invalid` without changing files. `ready` requires a manifest with
`status: "ready"` listing all four final artifacts as regular files; an
incomplete or invalid latest bundle is not treated as finalized.

### Output

```text
forward-to-claude/
  <session-id>/
    handoff-<UTC timestamp>/
      HANDOFF.md
      REVIEW.md
      PROMPT.md
      manifest.json
```

During processing the folder also holds `SOURCE.md` and `BRIEF.json`. Finalize
preflights the folder, writes `HANDOFF.md`, `REVIEW.md`, and `PROMPT.md`,
verifies them, deletes staging, and publishes `manifest.json` last as the
success marker. If a later step fails, finalize removes the published artifacts,
restores `SOURCE.md` and `BRIEF.json`, and leaves the bundle
`awaiting_translation` rather than claiming `ready`.

Copy the fenced block from `PROMPT.md` into Claude. The prompt tells Claude to
read `HANDOFF.md`, `REVIEW.md`, and `manifest.json`, reconstruct the project
context, and ask before irreversible changes.

## How the consistency audit works

`start` builds a trace-free ledger:

```json
{
  "id": "T1",
  "category": "city_or_region",
  "sections": ["S1", "S3"],
  "occurrences": { "S1": 1, "S3": 1 }
}
```

The ledger never stores the matched term or a mapping back to it. The model
gets a template with one empty row per `T` id.

After translating and scrubbing, the model performs a separate read-through and
passes a `consistency` object to `finalize`:

- every source section reviewed exactly once;
- one row per `T` id with exact category/sections and disposition `alias` or
  `removed`;
- optional `M1`, `M2`, ... rows for entities the mechanical scanner missed;
- structured aliases such as `Person A`, `Vendor A`, `City A`, `Currency A`;
- exact source section labels and known file labels.

The plugin rejects missing/duplicate/extra T rows, alias drift, missing aliases
in an affected section, undeclared alias-like tokens, changed headings/file
labels, invented `file-N` tokens, and incomplete review or scrub attestations.

Multiple rows may share one structured alias when they refer to the same entity
(for example, a name and its adjective). The model's consistency notes must
attest that the shared alias denotes one entity. The plugin cannot mechanically
distinguish one entity described by two terms from two distinct entities
assigned the same alias; that remains a model-attested limit.

The full rule tables, ambiguity decisions, and residual limits are in
[docs/DETAIL.md](docs/DETAIL.md).

## Privacy model

- No network access, telemetry, or Claude communication.
- Local reads are limited to the current working directory; selected files are
  realpath-checked against symlink/junction escapes.
- Writes are confined to the handoff folder, with atomic temp-file writes.
- Start realpath-checks the existing `forward-to-claude` root, the session
  folder, and the new handoff folder before writing.
- Finalize and status re-check the folder they open.
- Only `SOURCE.md` and `BRIEF.json` are removed; no source file is deleted.
- No alias-to-original mapping is written into the published bundle.

## Limits

- Mechanical rules cover known high-confidence forms. Novel pinyin personal
  names, unusual transliterations, and semantic paraphrases rely on the model's
  M rows and consistency attestation.
- Semantic fidelity and entity identity are model-attested, not machine-proven.
- Natural names outside the structured alias grammar are not caught
  mechanically.
- UTF-8 text only. Files with NUL bytes or invalid UTF-8 are rejected.
- At most 20 files per handoff, 1 MiB per file, 4 MiB total.
- Conversation is capped at 240,000 characters.
- Only files under the current working directory can be included.
- On hosts whose absolute user-profile path contains a flagged term (for
  example a user directory containing a Chinese-origin brand name), the prompt
  and manifest intentionally use a trace-free relative path.
- Headless profiles without a user-questions answerer cannot use `start`.
- Rendered Plugin Manager display is not exercised by the automated suite.

## Development

No dependencies are required.

```bash
npm test
# direct fallback for the DSH Windows sandbox (test-runner child pipes denied):
node tests/integration.mjs
```

`npm test` is the portable Node.js >=22 command used by CI. The direct file
invocation runs the identical suite in-process and is the supported fallback
when the sandbox denies the test runner's child-process pipes.

The suite covers the end-to-end start/finalize flow, junction containment,
CJK/fullwidth handling, regional-trace categories, no-echo errors, scrub
checklists, code-span exemption, traced session/cwd/file labels, T/M ledger
coverage, alias drift, shared aliases, exact section/file labels, fail-closed
behavior, transactional preflight/rollback and manifest-last publishing, status
manifest validation, same-second numeric suffix ordering, and file-symlink
boundary checks. File-symlink cases skip only when the host denies symlink
creation. It writes only to fresh temporary directories.

### Package layout

```text
.
├── index.js                  Host plugin and tool implementation
├── cordis.patch.yml          DSH bundle row
├── locale/en.json            Plugin Manager title/description
├── locale/zh.json            Chinese UI metadata
├── icon.svg                  Original plugin icon
├── docs/DETAIL.md            Full behavior and rule reference
├── tests/integration.mjs     Node built-in test suite
├── .github/workflows/ci.yml  CI on Linux and Windows
├── .gitattributes             LF policy
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── REPO_SETUP.md
├── LICENSE
└── package.json
```

## Repository setup

The repository metadata uses `OWNER` as a placeholder. Before publishing:

```bash
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin git@github.com:OWNER/dsh-forward-to-claude.git
git push -u origin main
```

Then replace `OWNER` in `package.json`, the README badges, and
`REPO_SETUP.md` with the real GitHub account. See [REPO_SETUP.md](REPO_SETUP.md)
for release and optional npm publishing steps.

## License

MIT. See [LICENSE](LICENSE).
