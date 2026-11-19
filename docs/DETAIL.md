# Forward to Claude - detail

This page describes the implementation that ships in this package. It is
written for the Plugin Manager detail view.

## What it does

The bundle adds one global tool, `forward_to_claude`, that builds a
session-specific, English-only, China-trace-free handoff folder so a person can
ask Claude to continue the work. Nothing is sent anywhere: the tool writes
local files, the user copies `PROMPT.md` into Claude themselves.

The tool has three actions: `start`, `finalize`, and `status`. It is visible to
every agent and is announced by a system-prompt section named
`tool:forward-to-claude` (order 2750) that only appears while the tool is
visible.

## Workflow

### 1. start

`start` asks the user, through the Host user-question service, which sources to
forward:

| Option | Meaning |
| --- | --- |
| Conversation so far (Recommended) | All user and assistant text messages in this session. |
| Text files from this project | UTF-8 text files under the current working directory. |
| A handoff note I write now | A note typed into the answer box. |

When files are selected, a follow-up question asks for one path per line
(relative paths, or absolute paths inside the working directory). When a note
is selected, a second follow-up asks for the note text. Skipped scope answers
return a normal `nothing_selected` result; skipped follow-ups are errors.

Sources are gathered in a fixed order - conversation chunks, then each file in
the order listed, then the note - and each becomes one section with an id
`S1`, `S2`, ... Sections record the inline single-backtick spans that are
printable ASCII, 2 to 160 characters long, and free of any regional trace;
those spans are re-checked at finalize. A trace-bearing span is not required to
be reproduced: it must be replaced by a neutral alias.

The staging folder is
`<working-directory>/forward-to-claude/<safe-session-id>/handoff-<YYYYMMDD-HHmmss>/`.
`SOURCE.md` and ASCII-only `BRIEF.json` are written atomically (a temporary
file in the destination directory, then a rename) and the tool returns:

- `folder`, `source_path`, `source_chars`, `message`;
- one summary row per section;
- English translation and scrub instructions;
- `regional_trace_summary` with neutral category ids and counts only;
- `trace_ledger` with one trace-free T entry per canonically grouped detected
  term (id, neutral category, affected sections, per-section occurrence counts);
- a `review_template` with one deliberately false placeholder row per section;
- a `scrub_template` with all six attestations false and a placeholder note;
- a `consistency_template` with audited/all flags false, empty
  `sections_reviewed` and notes, and one placeholder row per T id.

Finalize rejects untouched review/scrub templates and an unfinished consistency
audit until the translating agent has compared each section, attested the
scrub, and performed the separate whole-document read-through.

`BRIEF.json` also carries the trace-free `traces` ledger; the matched terms are
kept only inside start and are never stored, returned, or echoed.

Write containment is checked before any handoff data is written. `start`
realpath-checks the existing `forward-to-claude` root and the session folder
against the working directory, creates the new handoff folder with a
non-recursive `mkdir` on a fresh unique name, then realpath-checks that new
folder before writing `SOURCE.md` and `BRIEF.json`. A directory junction or
symlink that redirects any of those paths outside the working directory is
rejected with nothing written outside it; nothing outside the working directory
is deleted.

The conversation is capped at 240,000 characters. Files are capped at 20
entries, 1 MiB each, and 4 MiB total. Every path is realpathed and must stay
inside the working directory; directories, non-regular files, NUL bytes, and
invalid UTF-8 are rejected. Labels are ASCII: a printable-ASCII relative path
with forward slashes that contains no regional trace, otherwise `file-<n>`.
Traced or CJK-bearing paths are never written into any emitted file, and the
working directory is never stored in `BRIEF.json`.

`BRIEF.json` includes only neutral regional-trace category ids and counts for
the staged source; matched terms, cwd, original CJK paths, and note text are
never stored. A session id carrying a regional trace becomes a deterministic
`session-<sha256-prefix>` folder segment; the raw id is never stored, so no
mapping is persisted. Clean ids are unchanged.

### 2. Translate and scrub

The translating agent reads `SOURCE.md` and translates every section into
natural technical English, then replaces identifying China-related details with
neutral aliases. Required behaviour:

- keep every `[S#]` heading;
- preserve safe code identifiers, commands, paths, and numbers, including every
  safe stored inline code span;
- if a code identifier, path, URL, or command contains a trace, do not
  reproduce it: replace it with a neutral alias and do not list it among the
  preserved spans;
- do not summarize, merge, or omit sections;
- produce no Han, Hiragana, Katakana, Hangul, CJK punctuation, or fullwidth
  characters;
- replace identifying country/region, city/region, organization/platform,
  domain/contact, currency/unit, locale/language, political/cultural, and
  personal-name details with structured neutral aliases such as Person A, Team
  member A, Vendor A, Platform A, City A, Region A, Currency A, the target
  locale, the authorities, or a public holiday;
- use only the shared structured alias grammar in HANDOFF.md; natural names,
  bare names, and unsupported personal-name forms are rejected in consistency
  rows;
- do not include a mapping back to the original details;
- preserve technical meaning, numbers, logic, and constraints;
- review each section against its source and complete the six-field scrub
  checklist with short English notes that do not repeat removed details;
- after translation and scrub, perform a separate whole-document read-through of
  HANDOFF.md, complete one consistency row per T id, add M rows for
  scanner-missed entities, keep every alias identical in every affected section,
  and keep every section heading and file label exact.

The agent writes the result to `HANDOFF.md` or passes it as
`handoff_markdown`.

### 3. finalize

`finalize` locates the newest `handoff-*` folder for the session by timestamp and
then numeric duplicate suffix (`-10` is newer than `-9`; the unsuffixed form is
suffix 0). It first preflights the folder: only `SOURCE.md`, `BRIEF.json`,
`HANDOFF.md`, `REVIEW.md`, `PROMPT.md`, and `manifest.json` may exist, and known
files must be regular files, not symlinks. An unexpected entry fails before any
final artifact is written, with staging untouched. `BRIEF.json`, `SOURCE.md`,
`HANDOFF.md`, and `manifest.json` are read through an lstat/realpath boundary
check that refuses symlinks, non-regular files, and paths outside the bundle or
working directory.

Before writing anything it validates all in-memory artifact strings and planned
names:

- every `BRIEF.json` section id appears as a Markdown heading matching
  `^#{1,6}\s*\[S#\]`, and the heading carries the exact source section label
  (ASCII file names and file-N labels included);
- every safe stored ASCII code span occurs verbatim in the handoff;
- the handoff has zero forbidden codepoints. The scan uses Unicode script
  properties for Han, Hiragana, Katakana, Hangul, and Bopomofo - covering
  newer Han extensions (including H U+31350-323AF and I U+2EBF0-2EE5F) and
  kana blocks (including Kana Extended-B U+1AFF0-1AFFF) without block lists -
  plus explicit ranges for CJK radicals, ideographic description characters,
  CJK punctuation, kana voicing marks and punctuation, CJK strokes, enclosed
  CJK, compatibility/vertical/small forms, and fullwidth/halfwidth forms;
- the handoff has no known high-confidence regional trace. The scanner reports
  only neutral category ids and line numbers; matched terms are never echoed;
- `review` has exactly one row per section, no duplicates and no extras;
- every row sets `meaning_preserved: true` and has non-empty, CJK-free,
  trace-free notes;
- `scrub` is present, every one of its six fields is true, and its notes are
  non-empty, CJK-free, and trace-free. Missing, false, empty-notes, CJK-notes,
  or trace-bearing-notes checklists are refused;
- `consistency` is present and complete: audited and all three flags true,
  `sections_reviewed` exactly every source section once, one T row per ledger id
  with the exact category/sections and either a structured alias present in
  every affected section or a no-alias removed disposition, unique M ids for
  scanner-missed entities with structured aliases present in their sections,
  every alias-like token declared, and every known file label present;
- `REVIEW.md`, `PROMPT.md`, `manifest.json`, every planned artifact name, and
  the reported folder path are all CJK-free and trace-free.

Validation problems are listed up to 20 items. CJK and trace problems are
reported by line number and neutral category only, and no final artifact is
written when the gate fails. `SOURCE.md` and `BRIEF.json` remain so the agent
can fix the translation or scrub and call finalize again.

Finalize saves a private staging snapshot beside the handoff folder, writes
the three Markdown artifacts, and removes the staging files from the handoff
folder. It verifies the folder inventory and reads back the Markdown files to
match them against the content that passed the scan. It then verifies the
pending manifest and atomically renames it into the handoff folder. That rename
commits the publication. The tool removes the private snapshot and returns the
ready folder, artifact names, and ready-to-paste prompt.

If a step fails before the commit, finalize restores the staging files and any
pre-existing handoff draft, then removes the incomplete output. If the process
exits or rollback fails, retry finalize with the same arguments to use the
saved staging snapshot. If interruption occurs after the commit but before
snapshot cleanup, status reports the ready bundle and identifies the remaining
cleanup. Calling finalize again retries that cleanup.

The integration harness can pause or interrupt publication through the optional
Host-context hook `ctx.forwardToClaudeTestHooks.beforeManifest({ folder })`,
which runs before the final verification.

`manifest.json` records the version, `ready` status, creation time, neutral
session segment, a trace-free `folder` reference, source section count and
character count, source checksum, handoff checksum, review summary, a
trace-free `regional_trace_scrub` summary (attestations, notes checksum, and
`mechanical_scan.total`), a trace-free `consistency` summary (flags, sections
reviewed count, trace/model-entity/aliased/removed counts, and notes checksum),
per-file labels with byte counts and checksums, and the artifact name list.
Every emitted file is CJK-free and trace-free. If the absolute folder path
contains CJK or a regional trace, `PROMPT.md`, the manifest `folder` field, the
message, and the start/status results use the trace-free relative path instead.

### 4. status

`status` reports `ready`, `awaiting_translation`, `incomplete`, `invalid`, or
`none` for the newest bundle of this session, with its folder and files. It
never writes, renames, or deletes anything. `ready` is returned only when
`manifest.json` exists, parses, has `status: "ready"`, lists all four final
artifacts, and all four are regular files. With no manifest, both regular
staging files are required for `awaiting_translation`. A missing artifact or
staging file yields `incomplete`. A malformed manifest or unsafe expected file
yields `invalid`. Traced file names and folder paths are neutralized in the
response.

## Regional-trace scanner

The scanner classifies text with neutral category ids:

| Category id | Coverage |
| --- | --- |
| `country_or_region` | Country/region names, adjectives, abbreviations, and prefixes. |
| `city_or_region` | Major cities, provinces, autonomous regions, and Special Administrative Regions. |
| `organization_or_platform` | Chinese-origin companies, products, platforms, and host-platform brands including Lenovo, TikTok, Shein, and Temu. |
| `domain_or_contact` | `.cn`, `.com.cn`, `.net.cn`, `.org.cn`, `.gov.cn`, `.edu.cn`, `.hk`, `.tw`, `.mo`, known platform domains, +86/0086/86- prefixes, mainland mobile numbers, 15/18-digit identity numbers, and 18-character USCC patterns starting 91/92/93. |
| `currency_or_unit` | RMB, CNY, CNY symbol forms, Renminbi, Yuan, `¥`, and Chinese units used with a number (jin, mu, cun, chi). |
| `locale_or_language` | `zh`, `zh-CN`, `zh_CN`, `zh-Hans`, `zh-Hant`, language labels, Mandarin, Cantonese, Pinyin, Hanyu, Putonghua, GB2312, GBK, GB18030, Big5. |
| `political_or_cultural` | Political bodies and titles, national day references, lunar/spring/mid-autumn/dragon-boat holidays, Double Eleven, Singles' Day, Red Packet/hongbao, guanxi, hukou, danwei. |
| `personal_name` | High-confidence pinyin personal-name patterns: capitalized common surname plus given name, separator forms, and surname+given+digits usernames. |

The same scanner checks all planned final artifacts and their names. Errors
contain only the category id, counts, and line numbers.
No code path echoes a matched term, including missing-code-span lists, file
labels, review notes, and scrub notes.

Documented decisions:

- Bare `CN` and bare `HK` are not flagged (X.509 `CN=` fields, HKDF).
- Bare pinyin syllables such as `li` and `ma` are not flagged; high-confidence
  pinyin personal-name patterns are. Arbitrary pinyin names, usernames,
  transliterations, and paraphrases are covered by the checklist attestation.
- `¥` is flagged conservatively despite its JPY ambiguity.
- Host-platform brand names are flagged in content and labels; on a host whose
  fixed user-profile path itself contains a flagged brand, the absolute path is
  not emitted and the trace-free relative path is used instead.
- Word/identifier boundaries avoid obvious false positives; the country
  adjective is also matched at identifier start so a camel-case identifier is
  caught without matching a Latin word such as "machina".

## Context consistency audit

At start, the same scanner also builds a trace-free cross-section ledger from
the source sections. Matched terms are retained internally only; they are
canonically grouped by normalized term and assigned `T1`, `T2`, ... in
first-occurrence order. `BRIEF.json` and the start result carry only
`{id, category, sections, occurrences}`. A matched term or mapping back to it is
never stored or returned.

After translation and scrub, the translating agent performs a separate
whole-document read-through of `HANDOFF.md` and supplies a required
`consistency` object:

- `audited`, `alias_stability`, `file_references_consistent`, and
  `no_unmapped_entities` must all be true;
- `sections_reviewed` lists every source section exactly once;
- notes are non-empty, CJK-free, and trace-free;
- one row per T id with the exact ledger category/sections and disposition
  `alias` (structured alias present in every affected section) or `removed` (no
  alias; the entity is absent);
- `M1`, `M2`, ... rows for entities the scanner missed, with category
  `model_identified`, a structured alias, and non-empty valid source sections;
- every alias-like token in HANDOFF.md is declared by an alias row, every
  declared alias occurs, and multiple T/M rows may share one structured alias
  only when they denote the same entity (the consistency notes must attest that
  the shared alias denotes one entity);
- every section heading carries its exact source label after `[S#]`; every
  `file-N`/`file-N~K` token is a known bundle label and every known label
  appears.

The shared alias grammar is one of `Person`, `Team member`, `Vendor`,
`Platform`, `Organization`, `Company`, `City`, `Region`, `Country`, `Currency`,
`Locale`, `Language`, `Holiday`, `Authority`, `Identifier`, `Account`,
`Contact`, `Domain`, `Project`, `Product`, or `File`, followed by
`[A-Z][A-Z0-9-]*` (for example `Person A` or `Account B-2`). Existing file
labels keep the `file-N` / `file-N~K` form. Natural names and unsupported
personal-name forms are rejected in consistency rows. Multiple rows may share
one structured alias only when they denote the same entity (for example a full
name and a short name); the consistency notes must attest that. The plugin
mechanically checks ledger coverage, row shape, alias grammar/presence,
undeclared alias-like tokens, exact section labels, and file labels, but it
cannot distinguish one entity described by two source terms from two distinct
entities assigned one alias. Semantic identity and completeness of the
model-authored ledger remain the translating agent's attestation, not proof;
entities outside the structured grammar are not caught mechanically and are
covered by the model's separate read-through and M rows.

## Files produced

| File | Contents |
| --- | --- |
| `SOURCE.md` (staging) | Every selected section under `## [S#]` headings; may contain Chinese and regional details; deleted on success. |
| `BRIEF.json` (staging) | ASCII metadata used by the gates: neutral session segment, sections, safe code spans, file checksums, neutral trace counts, and the trace-free T ledger; deleted on success. |
| `HANDOFF.md` | The translated, English-only, trace-free, alias-consistent handoff. |
| `REVIEW.md` | Title "Fidelity review", counts, Section / Meaning preserved / Notes table, a "Regional trace scrub" section, and a "Context consistency review" section with the audit fields, notes, and the T/M table. |
| `PROMPT.md` | A copyable English prompt naming `HANDOFF.md`, `REVIEW.md`, and `manifest.json`, mentioning neutral aliases used consistently across sections and no mapping. |
| `manifest.json` | ASCII checksums, inventory, trace-free folder reference, trace-free scrub summary, and trace-free consistency summary. |

## What is and is not guaranteed

Guaranteed by construction and covered by the automated test:

- a session-specific folder under the working directory;
- preserved source order and one review row per section;
- every section heading plus its exact source label, and every safe stored
  ASCII code span present in the final handoff; trace-bearing spans exempted and
  replaced;
- no CJK or fullwidth codepoints in any emitted file name or content;
- no known high-confidence regional trace in any emitted artifact or planned
  name;
- a complete, true scrub attestation with clean notes;
- complete consistency ledger coverage: one T row per ledger id, structured
  aliases present in every affected section, shared aliases allowed only for an
  attested single entity, unique M ids validly placed, declared alias-like
  tokens only, and exact section/file labels;
- no final artifact written on a failed gate, including missing or false scrub
  attestations or consistency drift/omission;
- a prompt that names all three handoff files, mentions neutral aliases and no
  mapping, and asks Claude not to assume access to the original conversation.

Not guaranteed:

- semantic fidelity. The plugin cannot prove that an English section means the
  same as its source; that judgment is the translating agent's, recorded
  section by section in `REVIEW.md`. The mechanical checks make silent
  omissions and untranslated Chinese visible, but they are not a substitute for
  reading the translation.
- semantic scrubbing. Pattern checks cover known high-confidence forms; the
  six-field checklist is the translating agent's attestation, **not proof**
  that every possible trace was removed. Novel pinyin names, unusual
  transliterations, and semantic paraphrases can pass the mechanical scan.
  `REVIEW.md` states this boundary.
- semantic entity identity and ledger completeness. The plugin can verify row
  coverage, alias grammar/presence, exact labels, and undeclared alias tokens,
  but it cannot prove that an alias maps to the correct source entity or that
  every scanner-missed natural name was captured. It also cannot mechanically
  distinguish one entity described by two source terms (for example a country
  name and its adjective) from two distinct entities assigned one alias;
  allowing a shared alias is therefore correct only when the consistency notes
  attest that the shared alias denotes one entity. The model's read-through and
  M rows are the attested layer for that; natural names outside the structured
  grammar are not caught mechanically.
- rendered Plugin Manager display. The automated suite does not verify the
  visual result; confirm the title, description, detail page, and icon after
  installation.

## Privacy and safety

- No network access, no telemetry, and no communication with Claude; the only
  I/O is local file reads and writes inside the session working directory.
- Reads are limited to explicitly listed files under the working directory and
  are realpath-checked against escapes.
- `start` realpath-checks the
  existing `forward-to-claude` root, the session folder, and the newly created
  handoff folder before writing; finalize and status check the folder they open.
  Finalize uses temporary files and a private staging snapshot beside the
  handoff folder so the shareable folder contains only verified artifacts once
  ready.
- Publication and rollback clean up plugin-created staging and incomplete
  output files. The original project files are preserved.

## Package and installation

Host-only bundle: `package.json` declares `dsh.bundle.patch` pointing at
`cordis.patch.yml`, and `index.js` exports `name`, `inject`, and
`apply(ctx)`. The tool is registered inside `ctx.effect` together with the
system-prompt section, and the returned cleanup disposes both. There are no
dependencies, no client entry, no build step, and no install scripts.

Install through **Plugins > Add plugin** with this package directory (or
`plugin_manager` `action: install_bundle`), then enable the row. A Git install
spec can be used after the repository is published.

## Test

The automated suite at `tests/integration.mjs` has forty-one test cases: the
end-to-end `start`/`finalize` path; negative finalize cases (false review
placeholders, dropped section, injected CJK from every covered block,
dishonest review, missing handoff); a skipped-answer case; loud-failure cases;
two junction-outside-the-working-directory regressions; a normal-path control;
a CJK working-directory case; a two-sequential-starts case; an all-category
regional-trace corpus with literal fixtures for every required country/region,
city/region, organization/platform, domain/contact, currency/unit,
locale/language, political/cultural, and personal-name form, asserting neutral
category plus line numbers and zero literal echo; scrub checklist validation
(missing, every false field, empty/CJK/trace-bearing notes); traced code-span
exemption and neutral replacement; deterministic traced-session neutralization;
traced-cwd relative path fallback in prompt, manifest, and message; traced file
label neutralization; neutral source-trace summaries; context-consistency
cases covering the trace-free T ledger and false template,
alias drift/missing/undeclared refusals, exact section/file-label and invented
file-token refusals, T-row and sections_reviewed coverage, removed rows, M-row
validation and acceptance, consistency-required/flag/notes validation, a
complete T+M audit publishing the REVIEW table and manifest summary, and a
red->green shared-alias regression where two distinct T rows share one
structured alias for one entity and publish under it; transactional finalize
preflight/rollback/manifest-last; interrupted-publish recovery and fresh-process
resume; status incomplete/invalid/ready validation with both staging files
required; eleven same-second numeric-suffix ordering; timestamp and
unsuffixed-suffix ordering; a throwing-clock Host harness regression proving
`start` does not read an uninjected clock service; and file-symlink boundary
cases that skip only when the OS denies file symlinks. The package test/engine
contract is asserted as well. The junction cases skip only when the OS denies
junction creation. Run:

```
node --test tests/integration.mjs
```

The suite writes only to fresh temporary directories by default. `npm test` uses
the portable `node --test tests/integration.mjs` command on the declared
Node.js >=22 range; CI runs it on Node 22 and 24. In the DSH Windows sandbox,
where test-runner child-process pipes are denied, the supported fallback is:

```
node tests/integration.mjs
```
