/**
 * Automated integration test for the forward-to-claude Host bundle.
 *
 * The test uses stubbed Host services only:
 *   - ctx.tools.register captures the plain tool definition,
 *   - ctx.effect runs the registration callback and keeps its cleanup,
 *   - ctx.systemPrompt.section captures the section and its disposer,
 *   - ctx.userQuestions.ask returns queued fixed answers,
 *   - ctx.workingDirectory.ensure returns a temporary working directory,
 *   - agent.session.deriveMessages returns a fixture transcript.
 *
 * Run from the package directory with:
 *   node --test tests/integration.mjs
 *
 * Optional capture: set FORWARD_EVIDENCE_DIR to a directory to write the
 * captured start/final artifacts there. With the variable unset, a run writes
 * them into a fresh temporary directory, so a normal test run never modifies
 * the package checkout.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.js'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE_OVERRIDE = process.env.FORWARD_EVIDENCE_DIR?.trim() ?? ''

/**
 * Choose where this run writes its captured evidence.
 * @returns {Promise<string>} Existing evidence directory.
 */
async function prepareEvidenceDir() {
  const directory = EVIDENCE_OVERRIDE === ''
    ? await mkdtemp(join(tmpdir(), 'dsh-forward-claude-evidence-'))
    : resolve(EVIDENCE_OVERRIDE)
  await mkdir(directory, { recursive: true })
  return directory
}

const OPTION_CONVERSATION = 'Conversation so far (Recommended)'
const OPTION_FILES = 'Text files from this project'
const OPTION_NOTE = 'A handoff note I write now'
const SESSION_ID = 'session-test-001'
const JUNCTION_UNAVAILABLE = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'UNKNOWN'])
const FILE_SYMLINK_UNAVAILABLE = new Set(['EPERM', 'EACCES', 'ENOTSUP'])

const FILE_TEXT = '# 项目笔记\n\n运行 `npm run build` 生成产物。\n\n配置位于 `config/app.json`。\n'
const CJK_NAME_DIR = '资料'
const CJK_NAME_FILE = '说明.md'
const CJK_NAME_TEXT = '交接时请保留 `deploy.sh` 的执行顺序。\n'
const NOTE_TEXT = '请保留现有的测试通过状态，并说明下一步。'

/**
 * Independent CJK/fullwidth scanner for the test itself. It mirrors the
 * property-based approach of the plugin gate (`Script=Han`, `Hiragana`,
 * `Katakana`, `Hangul`, `Bopomofo`) plus explicit non-script punctuation and
 * form ranges, so a missing class in the plugin shows up here. Property escapes
 * cover Han Extension H (U+31350-323AF), Han Extension I (U+2EBF0-2EE5F), and
 * Kana Extended-B (U+1AFF0-1AFFF) as the runtime's Unicode tables provide them.
 */
const CJK_PATTERN = new RegExp('['
  + '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Bopomofo}'
  + '\\u2E80-\\u2EFF\\u2F00-\\u2FDF\\u2FF0-\\u2FFF\\u3000-\\u303F'
  + '\\u3099-\\u309C\\u30A0\\u30FB-\\u30FC'
  + '\\u31C0-\\u31EF\\u3200-\\u33FF\\uFE10-\\uFE1F\\uFE30-\\uFE4F\\uFE50-\\uFE6F\\uFF00-\\uFFEF'
  + '\\u{1F200}-\\u{1F2FF}'
  + ']', 'u')

const FIXTURE_CONVERSATION = [
  {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '帮我把这个会话交接给 Claude。' }],
  },
  {
    role: 'assistant',
    source: { kind: 'model' },
    content: [
      { type: 'text', text: '我会先创建交接文件夹，然后翻译每个章节。' },
      { type: 'text', text: '核心参数是 `maxTokens`，文件位于 `src/store.ts`。' },
    ],
  },
  {
    role: 'user',
    source: { kind: 'tool' },
    content: [{ type: 'text', text: 'internal tool output must be ignored' }],
  },
  {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '   ' }, { type: 'image', source: 'ignored' }],
  },
  {
    role: 'assistant',
    source: { kind: 'model' },
    content: [{ type: 'text', text: 'The retry limit is `retryLimit`.' }],
  },
  {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '请同时保留 `build` 脚本的行为。' }],
  },
  {
    role: 'assistant',
    source: { kind: 'model' },
    content: [{ type: 'text', text: '明白，记录在案。' }],
  },
]

/* ------------------------------------------------------------------ */
/* Harness                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a stubbed Host context and execute one `apply(ctx)`.
 * @param {{ cwd: string, answers: object[][], messages: object[], sessionId?: string, visible?: boolean, forwardTestHooks?: object }} options - Fixtures.
 * @returns {object} Harness handles.
 */
function createHarness({ cwd, answers, messages, sessionId = SESSION_ID, visible = true, forwardTestHooks }) {
  const definitions = []
  const sections = []
  const asks = []
  const effects = []
  const disposed = { tool: false, prompt: false }
  const queue = answers.map((rows) => rows.map((row) => ({ ...row, selected: [...(row.selected ?? [])] })))
  const session = { id: sessionId, deriveMessages: () => messages }
  const exec = {
    callId: 'call-1',
    name: 'forward_to_claude',
    arguments: {},
    agent: { session },
    signal: new AbortController().signal,
  }
  const ctx = {
    effect(callback) {
      const cleanup = callback()
      effects.push(cleanup)
      return () => {}
    },
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {
          disposed.tool = true
        }
      },
      get(name) {
        return visible ? definitions.find((definition) => definition.name === name) : undefined
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          disposed.prompt = true
        }
      },
    },
    userQuestions: {
      async ask(request) {
        asks.push(request)
        const next = queue.shift()
        if (next === undefined) throw new Error('test harness: no queued answer for this ask() call')
        return { answers: next }
      },
    },
    workingDirectory: {
      async ensure(agent) {
        assert.equal(agent, exec.agent, 'the tool must ask for the exact calling agent')
        return cwd
      },
    },
  }
  // Real Cordis throws when a plugin reads a service it did not inject.
  // Reproduce that behavior for the clock service so the production path
  // cannot silently reintroduce an uninjected service access.
  Object.defineProperty(ctx, 'clock', {
    configurable: true,
    enumerable: false,
    get() {
      throw new Error('cannot get property "clock" without inject')
    },
  })
  if (forwardTestHooks === undefined) {
    Object.defineProperty(ctx, 'forwardToClaudeTestHooks', {
      configurable: true,
      enumerable: false,
      get() {
        throw new Error('cannot get property "forwardToClaudeTestHooks" without inject')
      },
    })
  } else {
    ctx.forwardToClaudeTestHooks = forwardTestHooks
  }
  plugin.apply(ctx)
  return { ctx, exec, definitions, sections, asks, effects, disposed, cwd, session }
}

/** Scope answers selecting all three sources. */
function allSourceAnswers(fileListText, noteText) {
  return [
    [{ id: 'scope', selected: [OPTION_CONVERSATION, OPTION_FILES, OPTION_NOTE], custom: '' }],
    [{ id: 'files', selected: [], custom: fileListText }],
    [{ id: 'note', selected: [], custom: noteText }],
  ]
}

/** Scope answers selecting only the handoff-note source. */
function noteOnlyAnswers(noteText) {
  return [
    [{ id: 'scope', selected: [OPTION_NOTE], custom: '' }],
    [{ id: 'note', selected: [], custom: noteText }],
  ]
}

/** Create a real, resolved temporary working directory. */
async function makeCwd() {
  return realpath(await mkdtemp(join(tmpdir(), 'dsh-forward-claude-')))
}

/** Create a temporary directory outside the working directory used by junction tests. */
async function makeOutsideDir() {
  return realpath(await mkdtemp(join(tmpdir(), 'dsh-forward-claude-outside-')))
}

/**
 * Run a callback with a fixed wall clock. The production path intentionally
 * uses `new Date()` rather than an injected clock service, so tests freeze the
 * standard Date constructor instead of adding a non-Cordis context property.
 * @param {() => number} getTime - Current fixed epoch milliseconds.
 * @param {() => Promise<unknown>} callback - Test body.
 * @returns {Promise<unknown>} Callback result.
 */
async function withFixedDate(getTime, callback) {
  const RealDate = globalThis.Date
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [getTime()] : args))
    }

    static now() {
      return getTime()
    }
  }
  globalThis.Date = FixedDate
  try {
    return await callback()
  } finally {
    globalThis.Date = RealDate
  }
}

/**
 * Start a bundle whose same trace appears in a file section and in the note
 * section, so the ledger spans S1 and S2.
 * @returns {Promise<object>} Harness, start result, folder, and brief.
 */
async function startTracedTwoSectionBundle() {
  const cwd = await makeCwd()
  await writeFile(join(cwd, 'plan.md'), 'Rollout in Beijing.\n', 'utf8')
  const harness = createHarness({
    cwd,
    answers: allSourceAnswers('plan.md', 'Beijing deadline and Beijing follow-up.'),
    messages: [],
  })
  const definition = harness.definitions[0]
  const started = await definition.execute({ action: 'start' }, harness.exec)
  const folder = fromCwd(started.folder, cwd)
  const brief = JSON.parse(await readFile(join(folder, 'BRIEF.json'), 'utf8'))
  return { cwd, harness, definition, started, folder, brief }
}

/** Assert a failed finalize left only the staging files. */
async function assertStagedOnly(folder) {
  assert.deepEqual((await readdir(folder)).sort(), ['BRIEF.json', 'SOURCE.md'])
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)
  assert.equal(await exists(join(folder, 'HANDOFF.md')), false)
  assert.equal(await exists(join(folder, 'REVIEW.md')), false)
  assert.equal(await exists(join(folder, 'manifest.json')), false)
}

/**
 * Start a note-only bundle and read back its staging brief.
 * @param {{ cwd: string, noteText?: string, sessionId?: string }} options - Fixture.
 * @returns {Promise<object>} Harness, start result, folder, and brief.
 */
async function startNoteBundle({ cwd, noteText = 'handoff note', sessionId = SESSION_ID, forwardTestHooks }) {
  const harness = createHarness({ cwd, answers: noteOnlyAnswers(noteText), messages: [], sessionId, forwardTestHooks })
  const definition = harness.definitions[0]
  const started = await definition.execute({ action: 'start' }, harness.exec)
  const folder = fromCwd(started.folder, cwd)
  const brief = JSON.parse(await readFile(join(folder, 'BRIEF.json'), 'utf8'))
  return { harness, definition, started, folder, brief }
}

/**
 * Start a note-only bundle and finalize it with the standard clean fixtures.
 * @param {{ cwd?: string, noteText?: string, forwardTestHooks?: object }} options - Fixture.
 * @returns {Promise<object>} Harness, definition, brief, folder, start result, finalize result.
 */
async function finalizeNoteBundle(options = {}) {
  const cwd = options.cwd ?? await makeCwd()
  const { harness, definition, started, folder, brief } = await startNoteBundle({
    cwd,
    noteText: options.noteText ?? 'clean handoff note',
    forwardTestHooks: options.forwardTestHooks,
  })
  const ready = await definition.execute({
    action: 'finalize',
    handoff_markdown: buildEnglishHandoff(brief),
    review: buildReviewRows(brief),
    scrub: cleanScrub(),
    consistency: buildConsistency(brief),
  }, harness.exec)
  return { cwd, harness, definition, started, folder, brief, ready }
}

/**
 * Create a file symlink, or skip the calling test when the OS denies it.
 * @param {object} t - node:test context.
 * @param {string} target - Symlink target.
 * @param {string} linkPath - Symlink path.
 * @returns {Promise<boolean>} True when created.
 */
async function createFileSymlinkOrSkip(t, target, linkPath) {
  try {
    await symlink(target, linkPath, 'file')
    return true
  } catch (error) {
    if (FILE_SYMLINK_UNAVAILABLE.has(error?.code)) {
      t.skip(`file symlink creation is unavailable on this host: ${error.code}`)
      return false
    }
    throw error
  }
}

/**
 * Create a directory junction (or symlink on non-Windows hosts), or skip the
 * calling test when the OS denies it.
 * @param {object} t - node:test context.
 * @param {string} target - Junction target.
 * @param {string} linkPath - Link path.
 * @returns {Promise<boolean>} True when the link was created.
 */
async function createJunctionOrSkip(t, target, linkPath) {
  try {
    await symlink(target, linkPath, 'junction')
    return true
  } catch (error) {
    if (JUNCTION_UNAVAILABLE.has(error?.code)) {
      t.skip(`directory junction creation is unavailable on this host: ${error.code}`)
      return false
    }
    throw error
  }
}

/** Build the English handoff used by the happy-path finalize. */
function buildEnglishHandoff(brief, options = {}) {
  const aliases = options.aliases ?? {}
  const sectionExtras = options.sectionExtras ?? {}
  const lines = [
    '# Project handoff',
    '',
    'This English handoff was reconstructed from the staged source sections and reviewed section by section.',
    '',
    '## Summary',
    '',
    'The project work described below is ready to be continued. Decisions and current state are preserved in the reviewed sections that follow.',
    '',
  ]
  for (const section of brief.sections) {
    lines.push(`## [${section.id}] ${section.label}`, '')
    lines.push(`Section ${section.id} was translated in full. It records the context, decisions, and current state that the source section described.`)
    lines.push('')
    for (const trace of Array.isArray(brief.traces) ? brief.traces : []) {
      if (typeof aliases[trace.id] === 'string' && aliases[trace.id] !== '' && trace.sections.includes(section.id)) {
        lines.push(`Context note: ${aliases[trace.id]} is the neutral reference for this item.`)
        lines.push('')
      }
    }
    for (const extra of sectionExtras[section.id] ?? []) {
      lines.push(extra, '')
    }
    if (section.code_spans.length > 0) {
      const spans = section.code_spans.map((span) => '`' + span + '`').join(', ')
      lines.push(`The following inline code spans are preserved verbatim: ${spans}.`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

/** Build one all-true review row per source section. */
function buildReviewRows(brief) {
  return brief.sections.map((section) => ({
    id: section.id,
    meaning_preserved: true,
    notes: `Section ${section.id} was translated in full and its meaning, code spans, and decisions were preserved.`,
  }))
}

/**
 * Build a completed consistency audit from the brief ledger.
 * @param {object} brief - Staged brief.
 * @param {{ aliases?: Record<string,string>, rows?: object[], overrides?: object }} options - Fixture overrides.
 * @returns {object} Consistency audit.
 */
function buildConsistency(brief, options = {}) {
  const aliases = options.aliases ?? {}
  const rows = (Array.isArray(brief.traces) ? brief.traces : []).map((trace) => {
    const alias = aliases[trace.id]
    if (typeof alias === 'string' && alias !== '') {
      return { trace_id: trace.id, category: trace.category, disposition: 'alias', alias, sections: [...trace.sections] }
    }
    return { trace_id: trace.id, category: trace.category, disposition: 'removed', sections: [...trace.sections] }
  })
  if (Array.isArray(options.rows)) rows.push(...options.rows)
  return {
    audited: true,
    sections_reviewed: brief.sections.map((section) => section.id),
    alias_stability: true,
    file_references_consistent: true,
    no_unmapped_entities: true,
    notes: 'Whole-document read-through completed; aliases, section labels, and file labels are consistent.',
    rows,
    ...options.overrides,
  }
}

/** Completed regional-trace scrub checklist used by positive finalize calls. */
function cleanScrub(overrides = {}) {
  return {
    personal_names_replaced: true,
    organizations_replaced: true,
    places_replaced: true,
    platforms_contacts_replaced: true,
    currency_units_locale_replaced: true,
    political_cultural_references_replaced: true,
    notes: 'Regional identifying details were replaced with neutral aliases; no mapping was retained.',
    ...overrides,
  }
}

/** Build one complete positive finalize call for a brief. */
function finalizeArgs(brief) {
  return {
    action: 'finalize',
    handoff_markdown: buildEnglishHandoff(brief),
    review: buildReviewRows(brief),
    scrub: cleanScrub(),
    consistency: buildConsistency(brief),
  }
}

/** Literal trace probes used by the test's independent clean-artifact check. */
const TRACE_PROBES = [
  'China', 'Chinese', 'Beijing', 'Shanghai', 'Shenzhen', 'Hong Kong', 'Taiwan',
  'Alibaba', 'Tencent', 'WeChat', 'Alipay', 'Baidu', 'Huawei', 'Xiaomi', 'BYD',
  'TikTok', 'Shein', 'Temu', 'RMB', 'CNY', 'Yuan', 'Mandarin', 'Pinyin', 'zh-CN', 'Lenovo',
  '+86', '.cn', 'hongbao', 'Zhang Wei',
]

/** Assert that text contains none of the literal trace probes (case-insensitive). */
function assertNoKnownTrace(text, label) {
  const folded = text.toLowerCase()
  for (const probe of TRACE_PROBES) {
    assert.equal(folded.includes(probe.toLowerCase()), false, `${label} must not contain the literal trace probe ${probe}`)
  }
}

/* ------------------------------------------------------------------ */
/* Test helpers                                                       */
/* ------------------------------------------------------------------ */

function toPosix(value) {
  return String(value).split('\\').join('/')
}

/** Resolve a reported path against the working directory when it is relative. */
function fromCwd(value, cwd) {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Return 1-based line numbers for every CJK/fullwidth codepoint. */
function findCjk(text) {
  const lines = []
  let line = 1
  let consumed = 0
  const pattern = new RegExp(CJK_PATTERN.source, 'gu')
  for (const match of text.matchAll(pattern)) {
    for (let index = consumed; index < match.index; index += 1) {
      if (text[index] === '\n') line += 1
    }
    consumed = match.index
    lines.push(line)
  }
  return lines
}

/** Assert that a value contains no CJK/fullwidth codepoint. */
function assertNoCjk(value, label) {
  const lines = findCjk(value)
  assert.deepEqual(lines, [], `${label} must contain no CJK/fullwidth codepoints, found on line(s) ${lines.join(', ')}`)
}

/** Recursively list regular files under a directory. */
async function listFiles(root) {
  const files = []
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) files.push({ full, rel: toPosix(relative(root, full)) })
    }
  }
  await visit(root)
  files.sort((left, right) => left.rel.localeCompare(right.rel))
  return files
}

/** Snapshot names and contents so "never mutate" can be asserted. */
async function snapshot(folder) {
  const files = await listFiles(folder)
  const rows = []
  for (const file of files) {
    rows.push({ rel: file.rel, sha256: sha256(await readFile(file.full, 'utf8')) })
  }
  return rows
}

/** Whether a path exists. */
async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

test('start stages every selected source and finalize publishes an English-only bundle', async () => {
  const cwd = await makeCwd()
  await mkdir(join(cwd, 'src'), { recursive: true })
  await mkdir(join(cwd, CJK_NAME_DIR), { recursive: true })
  await writeFile(join(cwd, 'src', 'notes.md'), FILE_TEXT, 'utf8')
  await writeFile(join(cwd, CJK_NAME_DIR, CJK_NAME_FILE), CJK_NAME_TEXT, 'utf8')

  const harness = createHarness({
    cwd,
    answers: allSourceAnswers(`src/notes.md\n${CJK_NAME_DIR}/${CJK_NAME_FILE}`, NOTE_TEXT),
    messages: FIXTURE_CONVERSATION,
  })
  const definition = harness.definitions[0]

  // Package and tool contract.
  assert.equal(plugin.name, 'forward-to-claude')
  assert.deepEqual(plugin.inject, ['tools', 'userQuestions', 'workingDirectory', 'systemPrompt'])
  assert.equal(harness.definitions.length, 1)
  assert.equal(definition.name, 'forward_to_claude')
  assert.equal(definition.timeoutMs, undefined, 'the tool must not set timeoutMs because the user may answer slowly')
  assert.match(definition.description, /start/)
  assert.match(definition.description, /finalize/)
  assert.match(definition.description, /never contacts Claude/i)
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['action'])
  assert.deepEqual(definition.parameters.properties.action.enum, ['start', 'finalize', 'status'])
  assert.equal(definition.parameters.properties.review.items.properties.meaning_preserved.type, 'boolean')
  assert.equal(definition.output.schema.additionalProperties, true)
  assert.deepEqual(definition.output.schema.required, ['ok', 'action', 'status'])
  assert.equal(typeof definition.output.render, 'function')

  // System-prompt section: present, gated on tool visibility, and clean.
  assert.equal(harness.sections.length, 1)
  const promptSection = harness.sections[0]
  assert.equal(promptSection.name, 'tool:forward-to-claude')
  assert.equal(promptSection.order, 2750)
  const sectionText = promptSection.text({ scope: harness.exec.agent })
  assert.match(sectionText, /forward_to_claude/)
  assert.match(sectionText, /never contact Claude/i)
  assertNoCjk(sectionText, 'system prompt section')
  const hiddenHarness = createHarness({ cwd, answers: [], messages: [], visible: false })
  assert.equal(hiddenHarness.sections[0].text({ scope: hiddenHarness.exec.agent }), '')

  // Cleanup disposer releases both registrations.
  const cleanup = harness.effects[0]
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.equal(harness.disposed.tool, true)
  assert.equal(harness.disposed.prompt, true)

  // start
  const started = await definition.execute({ action: 'start' }, harness.exec)
  assert.equal(harness.asks.length, 3, 'start must ask scope, files, then note')
  const scopeAsk = harness.asks[0]
  assert.equal(scopeAsk.agent, harness.exec.agent)
  assert.equal(scopeAsk.signal, harness.exec.signal)
  assert.equal(scopeAsk.questions.length, 1)
  const scopeQuestion = scopeAsk.questions[0]
  assert.equal(scopeQuestion.id, 'scope')
  assert.equal(scopeQuestion.header, 'Forward to Claude')
  assert.equal(scopeQuestion.question, 'What should Claude receive? Select one or more sources.')
  assert.equal(scopeQuestion.multiSelect, true)
  assert.deepEqual(scopeQuestion.options.map((option) => option.label), [OPTION_CONVERSATION, OPTION_FILES, OPTION_NOTE])
  assert.deepEqual(scopeQuestion.options.map((option) => option.description), [
    'All human and assistant text messages in this session.',
    'UTF-8 text files under the current working directory.',
    'A note typed in the answer box; it will be translated too.',
  ])
  const filesQuestion = harness.asks[1].questions[0]
  assert.equal(filesQuestion.id, 'files')
  assert.equal(filesQuestion.header, 'Project files')
  assert.equal(filesQuestion.multiSelect, false)
  assert.equal(filesQuestion.options, undefined)
  const noteQuestion = harness.asks[2].questions[0]
  assert.equal(noteQuestion.id, 'note')
  assert.equal(noteQuestion.header, 'Handoff note')
  assert.equal(noteQuestion.multiSelect, false)
  assert.equal(noteQuestion.options, undefined)

  assert.equal(started.ok, true)
  assert.equal(started.action, 'start')
  assert.equal(started.status, 'awaiting_translation')
  const folder = fromCwd(started.folder, cwd)
  const folderRel = toPosix(relative(cwd, folder))
  assert.match(folderRel, /^forward-to-claude\/session-test-001\/handoff-\d{8}-\d{6}$/)
  // A clean project under a path that itself carries a flagged host-brand name
  // must use the trace-free relative path; a trace-free absolute path is kept.
  const cwdHasKnownTrace = TRACE_PROBES.some((probe) => cwd.toLowerCase().includes(probe.toLowerCase()))
  if (cwdHasKnownTrace) {
    assert.equal(isAbsolute(started.folder), false, 'a traced absolute working directory must fall back to a relative path')
    assert.equal(isAbsolute(started.source_path), false)
  } else {
    assert.equal(isAbsolute(started.folder), true)
    assert.equal(isAbsolute(started.source_path), true)
  }
  const sourcePath = fromCwd(started.source_path, cwd)
  assert.equal(sourcePath, join(folder, 'SOURCE.md'))
  assert.equal(await exists(sourcePath), true)
  assert.equal(await exists(join(folder, 'BRIEF.json')), true)
  assert.deepEqual(started.sections.map((section) => section.id), ['S1', 'S2', 'S3', 'S4', 'S5'])
  assert.deepEqual(started.sections.map((section) => section.kind), ['conversation', 'conversation', 'file', 'file', 'note'])
  assert.deepEqual(started.sections.map((section) => section.label), [
    'Conversation part 1 of 2',
    'Conversation part 2 of 2',
    'src/notes.md',
    'file-2',
    'Handoff note',
  ])
  assert.equal(started.review_template.length, 5)
  for (const row of started.review_template) {
    assert.equal(row.meaning_preserved, false, 'start must offer deliberately false review placeholders')
    assert.match(row.notes, /placeholder/i)
    assert.match(row.notes, new RegExp(`section ${row.id}`))
  }
  const scrubFields = [
    'personal_names_replaced',
    'organizations_replaced',
    'places_replaced',
    'platforms_contacts_replaced',
    'currency_units_locale_replaced',
    'political_cultural_references_replaced',
  ]
  for (const field of scrubFields) assert.equal(started.scrub_template[field], false, 'start must offer false scrub attestations')
  assert.match(started.scrub_template.notes, /placeholder/i)
  assert.equal(started.regional_trace_summary.total, 0)
  assert.deepEqual(started.regional_trace_summary.categories, {})
  assert.deepEqual(started.trace_ledger, [])
  assert.equal(started.consistency_template.audited, false)
  assert.deepEqual(started.consistency_template.sections_reviewed, [])
  assert.equal(started.consistency_template.alias_stability, false)
  assert.equal(started.consistency_template.file_references_consistent, false)
  assert.equal(started.consistency_template.no_unmapped_entities, false)
  assert.equal(started.consistency_template.notes, '')
  assert.deepEqual(started.consistency_template.rows, [])
  assert.ok(started.instructions.some((line) => /scrub/i.test(line)))
  assert.ok(started.instructions.some((line) => /consistency/i.test(line)))
  assert.ok(started.instructions.some((line) => /neutral alias/i.test(line)))
  assert.ok(started.instructions.some((line) => /mapping back|do not include a mapping/i.test(line)))
  assert.ok(started.instructions.some((line) => /placeholders/i.test(line) && /finalize/i.test(line)))
  assert.ok(started.instructions.some((line) => /translate/i.test(line)))
  assert.ok(started.instructions.some((line) => /finalize/i.test(line)))
  assert.ok(started.instructions.some((line) => line.includes('HANDOFF.md')))
  assertNoCjk(JSON.stringify(started), 'start result')
  assertNoKnownTrace(JSON.stringify(started), 'start result')

  const source = await readFile(sourcePath, 'utf8')
  assert.equal(source.length, started.source_chars)
  assert.match(source, /^# Forward to Claude handoff source/)
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5']) assert.ok(source.includes(`## [${id}] `), `SOURCE.md must contain ${id}`)
  assert.ok(source.includes('帮我把这个会话交接给 Claude。'), 'staging file must contain the Chinese source text')
  assert.ok(source.includes('**User:**'))
  assert.ok(source.includes('**Assistant:**'))
  assert.ok(source.includes('请保留现有的测试通过状态'))
  assert.ok(source.includes('npm run build'))
  assert.ok(!source.includes('internal tool output must be ignored'), 'tool-role user messages must be excluded')
  assert.ok(!source.includes(CJK_NAME_DIR), 'a CJK-bearing path must never be emitted')
  assert.ok(!source.includes(CJK_NAME_FILE), 'a CJK-bearing file name must never be emitted')

  const briefText = await readFile(join(folder, 'BRIEF.json'), 'utf8')
  assert.ok(!/[^\x00-\x7F]/.test(briefText), 'BRIEF.json must be ASCII-only')
  const brief = JSON.parse(briefText)
  assert.equal(brief.version, 1)
  assert.equal(brief.status, 'awaiting_translation')
  assert.equal(brief.session_id, SESSION_ID)
  assert.equal(brief.source_file, 'SOURCE.md')
  assert.equal(brief.source_chars, source.length)
  assert.equal(brief.source_sha256, sha256(source))
  assert.deepEqual(brief.sections.map((section) => section.id), ['S1', 'S2', 'S3', 'S4', 'S5'])
  assert.deepEqual(brief.sections.map((section) => section.kind), ['conversation', 'conversation', 'file', 'file', 'note'])
  assert.deepEqual(brief.sections[0].code_spans, ['maxTokens', 'src/store.ts', 'retryLimit', 'build'])
  assert.deepEqual(brief.sections[1].code_spans, [])
  assert.deepEqual(brief.sections[2].code_spans, ['npm run build', 'config/app.json'])
  assert.deepEqual(brief.sections[3].code_spans, ['deploy.sh'])
  assert.deepEqual(brief.sections[4].code_spans, [])
  assert.deepEqual(brief.files.map((file) => file.label), ['src/notes.md', 'file-2'])
  assert.equal(brief.files[0].bytes, Buffer.byteLength(FILE_TEXT))
  assert.equal(brief.files[0].sha256, sha256(FILE_TEXT))
  assert.equal(brief.files[1].bytes, Buffer.byteLength(CJK_NAME_TEXT))
  assert.equal(brief.files[1].sha256, sha256(CJK_NAME_TEXT))
  assert.ok(!briefText.includes(cwd), 'BRIEF.json must not store the working directory')
  assert.ok(!briefText.includes('项目笔记'), 'BRIEF.json must not store source text')
  assert.ok(!briefText.includes(NOTE_TEXT), 'BRIEF.json must not store the note text')
  assert.equal(brief.regional_traces.total, 0, 'the clean fixture must have no source traces')
  assert.deepEqual(brief.regional_traces.categories, {})
  assertNoKnownTrace(briefText, 'BRIEF.json')

  // Capture the staging state for the Reviewer before finalize deletes it.
  // Evidence is written only to FORWARD_EVIDENCE_DIR, or to a temp dir.
  const evidenceDir = await prepareEvidenceDir()
  await writeFile(join(evidenceDir, 'start-result.json'), `${JSON.stringify(started, null, 2)}\n`, 'utf8')
  await writeFile(join(evidenceDir, 'staging-brief.json'), briefText, 'utf8')
  const stagingHeadings = source.split('\n').filter((line) => /^## \[S\d+\] /.test(line))
  await writeFile(join(evidenceDir, 'staging-headings.txt'), [
    'Staging SOURCE.md section headings (captured before finalize)',
    `handoff folder: ${toPosix(folder)}`,
    `staging files: ${(await readdir(folder)).sort().join(', ')}`,
    `source characters: ${source.length}`,
    '',
    ...stagingHeadings,
    '',
  ].join('\n'), 'utf8')
  assert.ok(stagingHeadings.length === brief.sections.length, 'every section must have one staging heading')
  assertNoCjk(stagingHeadings.join('\n'), 'staging headings')

  // status reports the staging state without mutating it.
  const stagingBefore = await snapshot(folder)
  const stagingStatus = await definition.execute({ action: 'status' }, harness.exec)
  const stagingAfter = await snapshot(folder)
  assert.deepEqual(stagingAfter, stagingBefore)
  assert.equal(stagingStatus.status, 'awaiting_translation')
  assert.equal(fromCwd(stagingStatus.folder, cwd), folder)
  assert.deepEqual(stagingStatus.files, ['BRIEF.json', 'SOURCE.md'])

  // A dropped source section is refused.
  const validHandoff = buildEnglishHandoff(brief)
  const reviewRows = buildReviewRows(brief)
  const droppedId = brief.sections[brief.sections.length - 1].id
  const droppedHandoff = validHandoff
    .split('\n')
    .filter((line) => !line.startsWith(`## [${droppedId}]`))
    .join('\n')
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: droppedHandoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec),
    (error) => {
      assert.match(error.message, /Missing section heading/)
      assert.ok(error.message.includes(droppedId))
      assertNoCjk(error.message, 'dropped-section error')
      return true
    },
  )
  assert.deepEqual((await readdir(folder)).sort(), ['BRIEF.json', 'SOURCE.md'])
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)
  assert.equal(await exists(join(folder, 'HANDOFF.md')), false)

  // An injected Chinese character is refused and reported by line number only.
  const injectedHandoff = validHandoff.replace('## [S1]', '## [S1] 中文')
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: injectedHandoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec),
    (error) => {
      assert.match(error.message, /Forbidden CJK or fullwidth characters in HANDOFF/)
      assert.match(error.message, /line\(s\)/)
      assertNoCjk(error.message, 'injected-CJK error')
      return true
    },
  )
  assert.deepEqual((await readdir(folder)).sort(), ['BRIEF.json', 'SOURCE.md'])
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)

  // finalize with the supplied English text and complete review.
  const finalized = await definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec)
  assert.equal(finalized.ok, true)
  assert.equal(finalized.action, 'finalize')
  assert.equal(finalized.status, 'ready')
  assert.equal(fromCwd(finalized.folder, cwd), folder)
  assert.deepEqual(finalized.files, ['HANDOFF.md', 'REVIEW.md', 'PROMPT.md', 'manifest.json'])
  assert.match(finalized.message, /^The English handoff bundle is ready at /)
  assertNoCjk(JSON.stringify(finalized), 'finalize result')
  assertNoKnownTrace(JSON.stringify(finalized), 'finalize result')

  const finalNames = (await readdir(folder)).sort()
  assert.deepEqual(finalNames, ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md', 'manifest.json'])
  assert.equal(await exists(join(folder, 'SOURCE.md')), false)
  assert.equal(await exists(join(folder, 'BRIEF.json')), false)
  assert.equal(await readFile(join(folder, 'HANDOFF.md'), 'utf8'), validHandoff)

  const reviewText = await readFile(join(folder, 'REVIEW.md'), 'utf8')
  assert.match(reviewText, /^# Fidelity review/)
  assert.match(reviewText, /All meanings preserved: yes/)
  assert.match(reviewText, /## Regional trace scrub/)
  assert.match(reviewText, /attestation, not proof/)
  for (const section of brief.sections) assert.ok(reviewText.includes(`[${section.id}]`), `REVIEW.md must name ${section.id}`)
  const scrubLabels = [
    'Personal names replaced',
    'Organizations replaced',
    'Places replaced',
    'Platforms and contacts replaced',
    'Currency, units, and locale tags replaced',
    'Political and cultural references replaced',
  ]
  for (const label of scrubLabels) assert.ok(reviewText.includes(`| ${label} | yes |`), `REVIEW.md should report ${label}`)
  assertNoKnownTrace(reviewText, 'REVIEW.md')

  const manifestText = await readFile(join(folder, 'manifest.json'), 'utf8')
  assert.ok(!/[^\x00-\x7F]/.test(manifestText), 'manifest.json must be ASCII-only')
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.version, 1)
  assert.equal(manifest.status, 'ready')
  assert.equal(manifest.session_id, SESSION_ID)
  assert.equal(manifest.folder, finalized.folder)
  assert.equal(manifest.source_sections, brief.sections.length)
  assert.equal(manifest.source_characters, source.length)
  assert.equal(manifest.source_sha256, brief.source_sha256)
  assert.equal(manifest.handoff_sha256, sha256(validHandoff))
  assert.deepEqual(manifest.review, { sections: 5, all_meaning_preserved: true })
  assert.deepEqual(manifest.artifacts, ['HANDOFF.md', 'REVIEW.md', 'PROMPT.md', 'manifest.json'])
  assert.deepEqual(manifest.files.map((file) => file.label), ['src/notes.md', 'file-2'])
  assert.equal(manifest.regional_trace_scrub.attested, true)
  for (const field of scrubFields) assert.equal(manifest.regional_trace_scrub[field], true)
  assert.equal(typeof manifest.regional_trace_scrub.notes_sha256, 'string')
  assert.equal(manifest.regional_trace_scrub.notes_sha256.length, 64)
  assert.deepEqual(manifest.regional_trace_scrub.mechanical_scan, { total: 0 })
  assertNoKnownTrace(manifestText, 'manifest.json')

  const promptDocument = await readFile(join(folder, 'PROMPT.md'), 'utf8')
  assert.match(promptDocument, /^# Prompt for Claude/)
  assert.match(promptDocument, /HANDOFF\.md/)
  assert.match(promptDocument, /REVIEW\.md/)
  assert.match(promptDocument, /manifest\.json/)
  assert.match(promptDocument, /Claude/)
  assert.match(promptDocument, /neutral aliases/)
  assert.match(promptDocument, /No mapping/i)
  assert.ok(promptDocument.length > 200)
  assert.ok(promptDocument.includes(finalized.folder))
  assert.ok(promptDocument.includes(finalized.prompt))
  assertNoCjk(promptDocument, 'PROMPT.md')
  assertNoKnownTrace(promptDocument, 'PROMPT.md')

  // Every emitted file name and file content is English-only and trace-free.
  const emitted = await listFiles(folder)
  assert.equal(emitted.length, 4)
  const scanLines = ['CJK/fullwidth and regional-trace scan of every emitted file and file name']
  for (const file of emitted) {
    assertNoCjk(file.rel, `emitted file name ${file.rel}`)
    assertNoKnownTrace(file.rel, `emitted file name ${file.rel}`)
    const text = await readFile(file.full, 'utf8')
    assertNoCjk(text, `emitted file ${file.rel}`)
    assertNoKnownTrace(text, `emitted file ${file.rel}`)
    scanLines.push(`${file.rel}: file name 0 CJK hits, 0 trace probes; content 0 CJK hits, 0 trace probes`)
  }
  scanLines.push('RESULT: PASS (4 files and 4 file names clean by codepoint scan and literal trace probes)')

  // status never mutates and reports the ready bundle.
  const before = await snapshot(folder)
  const statusResult = await definition.execute({ action: 'status' }, harness.exec)
  const after = await snapshot(folder)
  assert.deepEqual(after, before)
  assert.equal(statusResult.ok, true)
  assert.equal(statusResult.action, 'status')
  assert.equal(statusResult.status, 'ready')
  assert.equal(fromCwd(statusResult.folder, cwd), folder)
  assert.deepEqual(statusResult.files, ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md', 'manifest.json'])
  assertNoCjk(JSON.stringify(statusResult), 'status result')

  // Evidence for the Reviewer: final listing and codepoint scan.
  const listingLines = [
    'Final handoff folder listing (captured by tests/integration.mjs)',
    `working directory: ${toPosix(cwd)}`,
    `handoff folder: ${toPosix(folder)}`,
    `session id: ${SESSION_ID}`,
    `file count: ${emitted.length}`,
    '',
  ]
  for (const file of emitted) {
    const stats = await stat(file.full)
    const content = await readFile(file.full, 'utf8')
    listingLines.push(`${file.rel}\t${stats.size} bytes\tsha256 ${sha256(content)}`)
  }
  listingLines.push('')
  await writeFile(join(evidenceDir, 'final-listing.txt'), listingLines.join('\n'), 'utf8')
  await writeFile(join(evidenceDir, 'cjk-scan.txt'), `${scanLines.join('\n')}\n`, 'utf8')
})

test('negative finalize is refused before any final artifact and a good retry succeeds', async () => {
  const cwd = await makeCwd()
  await writeFile(join(cwd, 'plan.md'), '# 计划\n\n下一步是 `review` 并发布。\n', 'utf8')
  const harness = createHarness({
    cwd,
    answers: allSourceAnswers('plan.md', '注意发布前需要人工确认。'),
    messages: [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请把项目计划交给 Claude。' }] },
      { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '计划包含 `plan.md` 和发布步骤。' }] },
    ],
  })
  const definition = harness.definitions[0]
  const started = await definition.execute({ action: 'start' }, harness.exec)
  const folder = fromCwd(started.folder, cwd)
  const brief = JSON.parse(await readFile(join(folder, 'BRIEF.json'), 'utf8'))
  const validHandoff = buildEnglishHandoff(brief)
  const reviewRows = buildReviewRows(brief)
  const stagedNames = ['BRIEF.json', 'SOURCE.md']

  // start's own template rows are deliberately false and must be refused.
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: started.review_template, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec),
    /meaning_preserved/,
  )
  assert.deepEqual((await readdir(folder)).sort(), stagedNames)
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)

  // A dropped section is refused and nothing final is written.
  const droppedId = brief.sections[brief.sections.length - 1].id
  const droppedHandoff = validHandoff
    .split('\n')
    .filter((line) => !line.startsWith(`## [${droppedId}]`))
    .join('\n')
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: droppedHandoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec),
    /Missing section heading/,
  )
  assert.deepEqual((await readdir(folder)).sort(), stagedNames)
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)

  // Injected Chinese is refused and nothing final is written.
  const injectedHandoff = validHandoff.replace('## [S1]', '## [S1] 中文')
  await assert.rejects(
    definition.execute({
      action: 'finalize',
      handoff_markdown: injectedHandoff,
      review: reviewRows,
      scrub: cleanScrub(),
    }, harness.exec),
    /Forbidden CJK or fullwidth characters/,
  )
  assert.deepEqual((await readdir(folder)).sort(), stagedNames)
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)
  assert.equal(await exists(join(folder, 'HANDOFF.md')), false)

  // Every covered CJK/fullwidth class is refused before any artifact. The
  // controls include the blocks added after reviewer v-1 (U+1100, U+D7B0,
  // U+1B000, U+FE50), the blocks that hardcoded ranges missed (U+31350 Han
  // Extension H, U+2EBF0 Han Extension I, U+1AFF0 Kana Extended-B), and the
  // original Han/fullwidth controls (U+4E00, U+FF21).
  const cjkGateCases = [
    ['U+1100 Hangul Jamo', '\u1100'],
    ['U+D7B0 Hangul Jamo Extended-B', '\uD7B0'],
    ['U+1B000 Kana Supplement', '\u{1B000}'],
    ['U+FE50 CJK small form variants', '\uFE50'],
    ['U+31350 Han Extension H', '\u{31350}'],
    ['U+2EBF0 Han Extension I', '\u{2EBF0}'],
    ['U+1AFF0 Kana Extended-B', '\u{1AFF0}'],
    ['U+4E00 Han control', '\u{4E00}'],
    ['U+FF21 fullwidth control', '\u{FF21}'],
  ]
  for (const [label, character] of cjkGateCases) {
    const injected = validHandoff.replace('## [S1]', `## [S1] ${character}`)
    await assert.rejects(
      definition.execute({ action: 'finalize', handoff_markdown: injected, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec),
      /Forbidden CJK or fullwidth characters/,
      `finalize must reject ${label}`,
    )
    assert.deepEqual((await readdir(folder)).sort(), stagedNames, `no artifact may be written for ${label}`)
    assert.equal(await exists(join(folder, 'PROMPT.md')), false, `no PROMPT.md may be written for ${label}`)
    assert.equal(await exists(join(folder, 'HANDOFF.md')), false, `no HANDOFF.md may be written for ${label}`)
  }

  // An incomplete review is refused.
  const dishonestReview = reviewRows.map((row, index) => (index === 0 ? { ...row, meaning_preserved: false } : row))
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: dishonestReview, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec),
    /meaning_preserved/,
  )
  assert.deepEqual((await readdir(folder)).sort(), stagedNames)
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)

  // No handoff supplied and no HANDOFF.md on disk is refused.
  await assert.rejects(
    definition.execute({ action: 'finalize', review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec),
    /No English handoff was provided/,
  )
  assert.deepEqual((await readdir(folder)).sort(), stagedNames)

  // A HANDOFF.md written to disk is accepted as the handoff input.
  await writeFile(join(folder, 'HANDOFF.md'), validHandoff, 'utf8')
  const finalized = await definition.execute({ action: 'finalize', review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec)
  assert.equal(finalized.status, 'ready')
  assert.deepEqual((await readdir(folder)).sort(), ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md', 'manifest.json'])
  assert.equal(await readFile(join(folder, 'HANDOFF.md'), 'utf8'), validHandoff)

  // Finalizing an already-ready bundle is refused.
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec),
    /already finalized/,
  )
})

test('a skipped scope answer returns nothing_selected and status reports none', async () => {
  const cwd = await makeCwd()
  const harness = createHarness({
    cwd,
    answers: [[{ id: 'scope', selected: [], custom: '' }]],
    messages: [],
  })
  const definition = harness.definitions[0]
  const result = await definition.execute({ action: 'start' }, harness.exec)
  assert.equal(result.ok, false)
  assert.equal(result.action, 'start')
  assert.equal(result.status, 'nothing_selected')
  assert.equal(result.message, 'No content was selected, so no handoff folder was created.')
  assert.equal(await exists(join(cwd, 'forward-to-claude')), false)

  const statusResult = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(statusResult.ok, true)
  assert.equal(statusResult.action, 'status')
  assert.equal(statusResult.status, 'none')
  assert.deepEqual(statusResult.files, [])
  assert.equal(await exists(join(cwd, 'forward-to-claude')), false)
})

test('missing follow-ups, empty sources, oversized conversation, and a missing agent fail loudly', async () => {
  const cwd = await makeCwd()

  const filesHarness = createHarness({
    cwd,
    answers: [
      [{ id: 'scope', selected: [OPTION_FILES], custom: '' }],
      [{ id: 'files', selected: [], custom: '   ' }],
    ],
    messages: [],
  })
  await assert.rejects(
    filesHarness.definitions[0].execute({ action: 'start' }, filesHarness.exec),
    /project-files answer was empty/,
  )

  const noteHarness = createHarness({
    cwd,
    answers: [
      [{ id: 'scope', selected: [OPTION_NOTE], custom: '' }],
      [{ id: 'note', selected: [], custom: '' }],
    ],
    messages: [],
  })
  await assert.rejects(
    noteHarness.definitions[0].execute({ action: 'start' }, noteHarness.exec),
    /handoff-note answer was empty/,
  )

  const emptyConversationHarness = createHarness({
    cwd,
    answers: [[{ id: 'scope', selected: [OPTION_CONVERSATION], custom: '' }]],
    messages: [],
  })
  await assert.rejects(
    emptyConversationHarness.definitions[0].execute({ action: 'start' }, emptyConversationHarness.exec),
    /No content could be gathered/,
  )

  const hugeConversationHarness = createHarness({
    cwd,
    answers: [[{ id: 'scope', selected: [OPTION_CONVERSATION], custom: '' }]],
    messages: [{
      role: 'assistant',
      source: { kind: 'model' },
      content: [{ type: 'text', text: 'x'.repeat(240001) }],
    }],
  })
  await assert.rejects(
    hugeConversationHarness.definitions[0].execute({ action: 'start' }, hugeConversationHarness.exec),
    /240001 characters, which exceeds the 240000-character cap/,
  )

  const noAgentHarness = createHarness({ cwd, answers: [], messages: [] })
  const noAgentExec = { callId: 'call-2', name: 'forward_to_claude', arguments: {}, signal: new AbortController().signal }
  await assert.rejects(
    noAgentHarness.definitions[0].execute({ action: 'start' }, noAgentExec),
    /requires a calling agent/,
  )
  await assert.rejects(
    noAgentHarness.definitions[0].execute({ action: 'status' }, noAgentExec),
    /requires a calling agent/,
  )
  await assert.rejects(
    noAgentHarness.definitions[0].execute({ action: 'bogus' }, noAgentHarness.exec),
    /requires action "start", "finalize", or "status"/,
  )

  assert.equal(await exists(join(cwd, 'forward-to-claude')), false)
})

test('start refuses a forward-to-claude root that is a junction outside the working directory', async (t) => {
  const cwd = await makeCwd()
  const outside = await makeOutsideDir()
  const created = await createJunctionOrSkip(t, outside, join(cwd, 'forward-to-claude'))
  if (!created) return

  const harness = createHarness({ cwd, answers: noteOnlyAnswers('outside write probe'), messages: [] })
  await assert.rejects(
    harness.definitions[0].execute({ action: 'start' }, harness.exec),
    /forward-to-claude folder resolves outside the session working directory/,
  )
  assert.deepEqual(await readdir(outside), [], 'nothing may be written through the junction')
  assert.equal(await exists(join(outside, SESSION_ID)), false)
})

test('start refuses a session folder that is a junction outside the working directory', async (t) => {
  const cwd = await makeCwd()
  const root = join(cwd, 'forward-to-claude')
  await mkdir(root)
  const outside = await makeOutsideDir()
  const created = await createJunctionOrSkip(t, outside, join(root, SESSION_ID))
  if (!created) return

  const harness = createHarness({ cwd, answers: noteOnlyAnswers('session junction probe'), messages: [] })
  await assert.rejects(
    harness.definitions[0].execute({ action: 'start' }, harness.exec),
    /session handoff folder resolves outside the session working directory/,
  )
  assert.deepEqual(await readdir(outside), [], 'nothing may be written through the junction')
  assert.equal(await exists(join(outside, 'handoff-20260101-000000')), false)
})

test('start still writes inside the working directory on a normal path', async () => {
  const cwd = await makeCwd()
  const harness = createHarness({ cwd, answers: noteOnlyAnswers('normal path note'), messages: [] })
  const started = await harness.definitions[0].execute({ action: 'start' }, harness.exec)
  assert.equal(started.ok, true)
  const folder = fromCwd(started.folder, cwd)
  const rel = relative(cwd, folder)
  assert.ok(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), 'the handoff folder must stay inside cwd')
  assert.match(toPosix(rel), /^forward-to-claude\/session-test-001\/handoff-\d{8}-\d{6}$/)
  assert.equal(await exists(join(folder, 'SOURCE.md')), true)
  assert.equal(await exists(join(folder, 'BRIEF.json')), true)
})

test('a CJK working-directory name yields ASCII relative paths and an English-only bundle', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-交接-')))
  assert.ok(findCjk(cwd).length > 0, 'fixture working directory must contain a CJK character')

  const harness = createHarness({
    cwd,
    answers: [
      [{ id: 'scope', selected: [OPTION_CONVERSATION, OPTION_NOTE], custom: '' }],
      [{ id: 'note', selected: [], custom: NOTE_TEXT }],
    ],
    messages: FIXTURE_CONVERSATION,
  })
  const definition = harness.definitions[0]
  const started = await definition.execute({ action: 'start' }, harness.exec)
  assert.equal(isAbsolute(started.folder), false, 'a CJK absolute path must fall back to the ASCII relative path')
  assert.match(started.folder, /^forward-to-claude\/session-test-001\/handoff-\d{8}-\d{6}$/)
  assert.equal(isAbsolute(started.source_path), false)
  assertNoCjk(JSON.stringify(started), 'CJK-cwd start result')
  const folder = fromCwd(started.folder, cwd)
  const rel = relative(cwd, folder)
  assert.ok(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel))
  assert.equal(await exists(join(folder, 'SOURCE.md')), true)
  assert.equal(await exists(join(folder, 'BRIEF.json')), true)

  const brief = JSON.parse(await readFile(join(folder, 'BRIEF.json'), 'utf8'))
  const finalized = await definition.execute({
    action: 'finalize',
    handoff_markdown: buildEnglishHandoff(brief),
    review: buildReviewRows(brief),
    scrub: cleanScrub(),
    consistency: buildConsistency(brief),
  }, harness.exec)
  assert.equal(finalized.status, 'ready')
  assert.equal(isAbsolute(finalized.folder), false)
  assert.match(finalized.folder, /^forward-to-claude\/session-test-001\/handoff-/)
  assertNoCjk(JSON.stringify(finalized), 'CJK-cwd finalize result')
  assertNoCjk(finalized.prompt, 'CJK-cwd prompt')
  assert.ok(finalized.prompt.includes(finalized.folder))
  assert.ok(!finalized.prompt.includes(cwd), 'the prompt must not contain the CJK absolute working directory')
  assert.deepEqual((await readdir(folder)).sort(), ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md', 'manifest.json'])
  for (const file of await listFiles(folder)) {
    assertNoCjk(file.rel, `CJK-cwd emitted file name ${file.rel}`)
    assertNoCjk(await readFile(file.full, 'utf8'), `CJK-cwd emitted file ${file.rel}`)
  }
})

test('two sequential starts keep both folders and finalize publishes the newest', async () => {
  const cwd = await makeCwd()
  const harness = createHarness({
    cwd,
    answers: [...noteOnlyAnswers('first draft note'), ...noteOnlyAnswers('second draft note')],
    messages: [],
  })
  const definition = harness.definitions[0]

  const RealDate = globalThis.Date
  const fixedTime = RealDate.parse('2026-11-19T07:40:00.000Z')
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixedTime] : args))
    }

    static now() {
      return fixedTime
    }
  }
  let first
  let second
  try {
    globalThis.Date = FixedDate
    first = await definition.execute({ action: 'start' }, harness.exec)
    second = await definition.execute({ action: 'start' }, harness.exec)
  } finally {
    globalThis.Date = RealDate
  }

  const firstFolder = fromCwd(first.folder, cwd)
  const secondFolder = fromCwd(second.folder, cwd)
  assert.equal(basename(firstFolder), 'handoff-20261119-074000')
  assert.equal(basename(secondFolder), 'handoff-20261119-074000-1')
  assert.notEqual(firstFolder, secondFolder)
  assert.deepEqual((await readdir(firstFolder)).sort(), ['BRIEF.json', 'SOURCE.md'])
  assert.deepEqual((await readdir(secondFolder)).sort(), ['BRIEF.json', 'SOURCE.md'])

  const firstBefore = await snapshot(firstFolder)
  const secondBrief = JSON.parse(await readFile(join(secondFolder, 'BRIEF.json'), 'utf8'))
  const finalResult = await definition.execute({
    action: 'finalize',
    handoff_markdown: buildEnglishHandoff(secondBrief),
    review: buildReviewRows(secondBrief),
    scrub: cleanScrub(),
    consistency: buildConsistency(secondBrief),
  }, harness.exec)
  assert.equal(finalResult.status, 'ready')
  assert.equal(fromCwd(finalResult.folder, cwd), secondFolder)
  assert.deepEqual(await snapshot(firstFolder), firstBefore, 'the older staging folder must stay untouched')
  assert.deepEqual((await readdir(firstFolder)).sort(), ['BRIEF.json', 'SOURCE.md'])
  assert.deepEqual((await readdir(secondFolder)).sort(), ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md', 'manifest.json'])
})

test('regional-trace corpus is refused with neutral categories and line numbers and never echoed', async () => {
  const cwd = await makeCwd()
  const { definition, harness, folder, brief } = await startNoteBundle({ cwd, noteText: 'clean preparation note' })
  const validHandoff = buildEnglishHandoff(brief)
  const reviewRows = buildReviewRows(brief)
  const stagedNames = ['BRIEF.json', 'SOURCE.md']

  const corpus = [
    ['country_or_region', [
      'China', 'Chinese', 'PRC', 'P.R.C.', 'CCP', 'CPC', 'Communist Party',
      "People's Republic", 'Mainland China', 'Greater China', 'Sino-Foreign',
    ]],
    ['city_or_region', [
      'Beijing', 'Shanghai', 'Shenzhen', 'Guangzhou', 'Hangzhou', 'Chengdu', 'Wuhan',
      "Xi'an", 'Xian', 'Nanjing', 'Tianjin', 'Suzhou', 'Chongqing', 'Qingdao', 'Dalian',
      'Xiamen', 'Hong Kong', 'Macau', 'Macao', 'Taiwan', 'Taipei', 'Xinjiang', 'Tibet',
      'Inner Mongolia', 'Guangxi', 'Ningxia', 'Guangdong', 'Zhejiang', 'Sichuan', 'Hubei',
      'Hunan', 'Jiangsu', 'Shandong', 'Henan', 'Hebei', 'Fujian', 'Anhui', 'Jiangxi',
      'Shaanxi', 'Shanxi', 'Yunnan', 'Guizhou', 'Gansu', 'Qinghai', 'Hainan', 'Jilin',
      'Liaoning', 'Heilongjiang',
    ]],
    ['organization_or_platform', [
      'Alibaba', 'Alipay', 'Ant Group', 'Tencent', 'WeChat', 'Weixin', 'QQ', 'Baidu',
      'ByteDance', 'Douyin', 'TikTok', 'Xiaohongshu', 'JD.com', 'Jingdong', 'Pinduoduo',
      'Meituan', 'Dianping', 'Didi', 'Huawei', 'Xiaomi', 'Lenovo', 'BYD', 'NIO', 'XPeng',
      'ZTE', 'SMIC', 'CATL', 'Foxconn', 'TSMC', 'DJI', 'Temu', 'Shein', 'UnionPay',
      'Ping An', 'NetEase', 'Sina', 'Sohu', 'iQiyi', 'Youku', 'Bilibili', 'Zhihu', 'Weibo',
      'Kuaishou', 'Toutiao', 'Gitee', 'CSDN', 'Juejin', 'OSChina',
    ]],
    ['domain_or_contact', [
      '.cn', 'example.com.cn', 'test.hk', 'foo.tw', 'bar.mo', 'qq.com', '163.com', '126.com',
      'baidu.com', 'taobao.com', 'tmall.com', 'jd.com', 'weibo.com', 'zhihu.com',
      'bilibili.com', 'alipay.com', 'aliyun.com', 'tencent.com', 'huawei.com', 'xiaomi.com',
      'bytedance.com', 'douyin.com', 'temu.com', 'shein.com',
      '+86 13800138000', '0086 13800138000', '86-13800138000', '13800138000',
      '11010519491231002X', '91110000000000000X',
    ]],
    ['currency_or_unit', ['RMB', 'CNY', 'CN¥', 'Renminbi', 'Yuan', '¥100', '10 jin', '5 mu', '3 cun', '2 chi']],
    ['locale_or_language', [
      'zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'zh-Hant', 'Chinese (Simplified)',
      'Chinese (Traditional)', 'Mandarin', 'Cantonese', 'Pinyin', 'Hanyu', 'Putonghua',
      'GB2312', 'GBK', 'GB18030', 'Big5',
    ]],
    ['political_or_cultural', [
      'Politburo', 'CPPCC', "National People's Congress", 'State Council', 'National Day',
      'Lunar New Year', 'Spring Festival', 'Mid-Autumn', 'Dragon Boat', 'Double Eleven',
      "Singles' Day", 'Red Packet', 'hongbao', 'guanxi', 'hukou', 'danwei',
    ]],
    ['personal_name', ['Zhang Wei', 'zhang.wei', 'li_ming', 'zhangwei1992']],
  ]

  let checked = 0
  for (const [category, literals] of corpus) {
    for (const literal of literals) {
      const injected = validHandoff.replace('## [S1]', `## [S1] ${literal}`)
      let error
      try {
        await definition.execute({ action: 'finalize', handoff_markdown: injected, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec)
      } catch (caught) {
        error = caught
      }
      assert.ok(error, `finalize must reject the ${category} fixture ${literal}`)
      assert.ok(error.message.includes(category), `error for ${literal} must name ${category}`)
      assert.match(error.message, /line\(s\) \d/, `error for ${literal} must include line numbers`)
      assert.equal(error.message.includes(literal), false, `error must not echo ${literal}`)
      assert.equal(error.message.toLowerCase().includes(literal.toLowerCase()), false, `error must not echo ${literal} in another case`)
      assertNoCjk(error.message, `error for ${literal}`)
      assert.deepEqual((await readdir(folder)).sort(), stagedNames, `no final artifact may be written for ${literal}`)
      assert.equal(await exists(join(folder, 'PROMPT.md')), false)
      assert.equal(await exists(join(folder, 'HANDOFF.md')), false)
      checked += 1
    }
  }
  assert.ok(checked > 100, `the corpus must cover every required literal; checked ${checked}`)
})

test('the scrub checklist is required and complete before finalize publishes', async () => {
  const cwd = await makeCwd()
  const { definition, harness, folder, brief } = await startNoteBundle({ cwd, noteText: 'clean preparation note' })
  const validHandoff = buildEnglishHandoff(brief)
  const reviewRows = buildReviewRows(brief)
  const stagedNames = ['BRIEF.json', 'SOURCE.md']
  const scrubFields = [
    'personal_names_replaced',
    'organizations_replaced',
    'places_replaced',
    'platforms_contacts_replaced',
    'currency_units_locale_replaced',
    'political_cultural_references_replaced',
  ]

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: reviewRows }, harness.exec),
    /scrub is required for finalize/,
  )
  assert.deepEqual((await readdir(folder)).sort(), stagedNames)

  for (const field of scrubFields) {
    await assert.rejects(
      definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: reviewRows, scrub: cleanScrub({ [field]: false }) }, harness.exec),
      new RegExp(`scrub\\.${field} must be true`),
    )
    assert.deepEqual((await readdir(folder)).sort(), stagedNames)
    assert.equal(await exists(join(folder, 'PROMPT.md')), false)
    assert.equal(await exists(join(folder, 'HANDOFF.md')), false)
  }

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: reviewRows, scrub: cleanScrub({ notes: '   ' }) }, harness.exec),
    /scrub\.notes must be a non-empty/,
  )
  assert.deepEqual((await readdir(folder)).sort(), stagedNames)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: reviewRows, scrub: cleanScrub({ notes: '中文说明' }) }, harness.exec),
    /scrub\.notes contains forbidden CJK/,
  )
  assert.deepEqual((await readdir(folder)).sort(), stagedNames)

  const reviewWithTrace = reviewRows.map((row, index) => (index === 0
    ? { ...row, notes: 'The Beijing rollout was reviewed.' }
    : row))
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: reviewWithTrace, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec),
    (error) => {
      assert.match(error.message, /Review notes for section S1 contain a forbidden regional trace \(category city_or_region at line\(s\) \d+\)/)
      assert.equal(error.message.includes('Beijing'), false, 'review-note errors must not echo the matched term')
      return true
    },
  )
  assert.deepEqual((await readdir(folder)).sort(), stagedNames)
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: reviewRows, scrub: cleanScrub({ notes: 'The Beijing rollout plan was neutralized.' }) }, harness.exec),
    (error) => {
      assert.match(error.message, /scrub\.notes contains a forbidden regional trace \(category city_or_region at line\(s\) \d+\)/)
      assert.equal(error.message.includes('Beijing'), false, 'scrub-note errors must not echo the matched term')
      return true
    },
  )
  assert.deepEqual((await readdir(folder)).sort(), stagedNames)

  const ready = await definition.execute({ action: 'finalize', handoff_markdown: validHandoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief) }, harness.exec)
  assert.equal(ready.status, 'ready')
  assert.deepEqual((await readdir(folder)).sort(), ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md', 'manifest.json'])
  const reviewText = await readFile(join(folder, 'REVIEW.md'), 'utf8')
  assert.match(reviewText, /## Regional trace scrub/)
  assert.match(reviewText, /attestation, not proof/)
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
  assert.equal(manifest.regional_trace_scrub.attested, true)
  for (const field of scrubFields) assert.equal(manifest.regional_trace_scrub[field], true)
})

test('a traced code span is exempted from required spans and the neutral alias is accepted', async () => {
  const cwd = await makeCwd()
  const noteText = 'Keep `npm test` passing and the `chinaPrice` field stable.'
  const { definition, harness, folder, brief } = await startNoteBundle({ cwd, noteText })
  assert.deepEqual(brief.sections[0].code_spans, ['npm test'], 'a trace-bearing code span must be exempt from required spans')
  assert.equal(brief.traces.length, 1, 'the traced code span must still appear in the ledger')
  const aliases = { T1: 'Identifier A' }
  const consistency = buildConsistency(brief, { aliases })
  const validHandoff = buildEnglishHandoff(brief, { aliases })
  const reviewRows = buildReviewRows(brief)
  assert.ok(validHandoff.includes('npm test'))
  assert.ok(validHandoff.includes('Identifier A'))

  const tracedHandoff = `${validHandoff}\n\nThe old chinaPrice field was renamed.\n`
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: tracedHandoff, review: reviewRows, scrub: cleanScrub(), consistency }, harness.exec),
    (error) => {
      assert.match(error.message, /Forbidden regional trace \(category country_or_region\)/)
      assert.equal(error.message.includes('chinaPrice'), false, 'the error must not echo the traced code span')
      return true
    },
  )
  assert.deepEqual((await readdir(folder)).sort(), ['BRIEF.json', 'SOURCE.md'])
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)

  const neutralHandoff = `${validHandoff}\n\nThe old regionalPrice field was renamed.\n`
  const ready = await definition.execute({ action: 'finalize', handoff_markdown: neutralHandoff, review: reviewRows, scrub: cleanScrub(), consistency }, harness.exec)
  assert.equal(ready.status, 'ready')
  const finalHandoff = await readFile(join(folder, 'HANDOFF.md'), 'utf8')
  assert.ok(finalHandoff.includes('regionalPrice'))
  assert.ok(finalHandoff.includes('npm test'))
  assert.equal(finalHandoff.includes('chinaPrice'), false)
})

test('a traced session id becomes a deterministic neutral segment with no mapping stored', async () => {
  const rawSessionId = 'beijing-team-42'
  const firstCwd = await makeCwd()
  const secondCwd = await makeCwd()
  const first = await startNoteBundle({ cwd: firstCwd, noteText: 'clean note', sessionId: rawSessionId })
  const second = await startNoteBundle({ cwd: secondCwd, noteText: 'clean note', sessionId: rawSessionId })
  const firstSegment = basename(dirname(first.folder))
  const secondSegment = basename(dirname(second.folder))
  assert.match(firstSegment, /^session-[0-9a-f]{16}$/)
  assert.equal(firstSegment, secondSegment, 'the neutral session segment must be deterministic')
  assert.equal(first.brief.session_id, firstSegment)
  assertNoKnownTrace(JSON.stringify(first.started), 'traced-session start result')
  assertNoKnownTrace(await readFile(join(first.folder, 'BRIEF.json'), 'utf8'), 'traced-session BRIEF.json')

  const ready = await first.definition.execute({
    action: 'finalize',
    handoff_markdown: buildEnglishHandoff(first.brief),
    review: buildReviewRows(first.brief),
    scrub: cleanScrub(),
    consistency: buildConsistency(first.brief),
  }, first.harness.exec)
  assert.equal(ready.status, 'ready')
  const manifestText = await readFile(join(first.folder, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.session_id, firstSegment)
  assert.equal(manifestText.includes(rawSessionId), false, 'the raw session id must not be stored')
  assertNoKnownTrace(manifestText, 'traced-session manifest.json')
  assert.ok(ready.folder.includes(`/${firstSegment}/`))
})

test('a traced working directory reports trace-free relative paths in prompt, manifest, and message', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-beijing-project-')))
  assert.ok(cwd.toLowerCase().includes('beijing'))
  const { definition, harness, started, folder, brief } = await startNoteBundle({ cwd, noteText: 'clean note' })
  assert.equal(isAbsolute(started.folder), false, 'a traced absolute working directory must fall back to the relative path')
  assert.equal(isAbsolute(started.source_path), false)
  assert.match(started.folder, /^forward-to-claude\/session-test-001\/handoff-/)
  assertNoKnownTrace(JSON.stringify(started), 'traced-cwd start result')

  const ready = await definition.execute({
    action: 'finalize',
    handoff_markdown: buildEnglishHandoff(brief),
    review: buildReviewRows(brief),
    scrub: cleanScrub(),
    consistency: buildConsistency(brief),
  }, harness.exec)
  assert.equal(ready.status, 'ready')
  assert.equal(isAbsolute(ready.folder), false)
  assertNoKnownTrace(JSON.stringify(ready), 'traced-cwd finalize result')
  assertNoKnownTrace(ready.prompt, 'traced-cwd prompt')
  assert.equal(ready.prompt.includes('beijing'), false)

  const manifestText = await readFile(join(folder, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.folder, ready.folder)
  assert.equal(isAbsolute(manifest.folder), false)
  assertNoKnownTrace(manifestText, 'traced-cwd manifest.json')

  const promptDocument = await readFile(join(folder, 'PROMPT.md'), 'utf8')
  assert.equal(promptDocument.includes('beijing'), false)
  for (const file of await listFiles(folder)) {
    assertNoKnownTrace(file.rel, `traced-cwd emitted name ${file.rel}`)
    assertNoKnownTrace(await readFile(file.full, 'utf8'), `traced-cwd emitted file ${file.rel}`)
  }
})

test('a traced file label becomes file-N and stays trace-free', async () => {
  const cwd = await makeCwd()
  await writeFile(join(cwd, 'beijing-notes.md'), 'Clean notes about the rollout.\n', 'utf8')
  await writeFile(join(cwd, 'safe.md'), 'Safe project notes.\n', 'utf8')
  const harness = createHarness({
    cwd,
    answers: allSourceAnswers('beijing-notes.md\nsafe.md', 'clean note'),
    messages: [],
  })
  const definition = harness.definitions[0]
  const started = await definition.execute({ action: 'start' }, harness.exec)
  const folder = fromCwd(started.folder, cwd)
  const brief = JSON.parse(await readFile(join(folder, 'BRIEF.json'), 'utf8'))
  assert.deepEqual(brief.files.map((file) => file.label), ['file-1', 'safe.md'])
  assert.deepEqual(started.sections.filter((section) => section.kind === 'file').map((section) => section.label), ['file-1', 'safe.md'])
  assertNoKnownTrace(await readFile(join(folder, 'BRIEF.json'), 'utf8'), 'traced-label BRIEF.json')
  assertNoKnownTrace(JSON.stringify(started), 'traced-label start result')

  const ready = await definition.execute({
    action: 'finalize',
    handoff_markdown: buildEnglishHandoff(brief),
    review: buildReviewRows(brief),
    scrub: cleanScrub(),
    consistency: buildConsistency(brief),
  }, harness.exec)
  assert.equal(ready.status, 'ready')
  const finalHandoff = await readFile(join(folder, 'HANDOFF.md'), 'utf8')
  assert.ok(finalHandoff.includes('## [S1] file-1'))
  assert.ok(finalHandoff.includes('## [S2] safe.md'))
  assert.equal(finalHandoff.includes('beijing-notes.md'), false)
  assertNoKnownTrace(await readFile(join(folder, 'manifest.json'), 'utf8'), 'traced-label manifest.json')
})

test('start reports neutral regional-trace counts for source material and finalize stays clean', async () => {
  const cwd = await makeCwd()
  const noteText = 'Plan references Beijing, Alibaba, and RMB 500.'
  const { definition, harness, started, folder, brief } = await startNoteBundle({ cwd, noteText })
  assert.ok(started.regional_trace_summary.total >= 3)
  assert.ok(started.regional_trace_summary.categories.city_or_region >= 1)
  assert.ok(started.regional_trace_summary.categories.organization_or_platform >= 1)
  assert.ok(started.regional_trace_summary.categories.currency_or_unit >= 1)
  assertNoKnownTrace(JSON.stringify(started), 'source-trace start result')
  const briefText = await readFile(join(folder, 'BRIEF.json'), 'utf8')
  assertNoKnownTrace(briefText, 'source-trace BRIEF.json')
  const stored = JSON.parse(briefText).regional_traces
  assert.equal(stored.total, started.regional_trace_summary.total)
  assert.deepEqual(stored.categories, started.regional_trace_summary.categories)
  assert.equal(started.trace_ledger.length, 3)
  assert.deepEqual(started.trace_ledger.map((trace) => trace.id), ['T1', 'T2', 'T3'])
  assert.deepEqual(brief.traces, started.trace_ledger)
  assertNoKnownTrace(JSON.stringify(started.trace_ledger), 'source-trace ledger')
  assertNoKnownTrace(JSON.stringify(brief.traces), 'source-trace BRIEF ledger')

  const aliases = { T1: 'City A', T2: 'Vendor A', T3: 'Currency A' }
  const ready = await definition.execute({
    action: 'finalize',
    handoff_markdown: buildEnglishHandoff(brief, { aliases }),
    review: buildReviewRows(brief),
    scrub: cleanScrub(),
    consistency: buildConsistency(brief, { aliases }),
  }, harness.exec)
  assert.equal(ready.status, 'ready')
  const finalHandoff = await readFile(join(folder, 'HANDOFF.md'), 'utf8')
  for (const alias of Object.values(aliases)) assert.ok(finalHandoff.includes(alias))
  for (const file of await listFiles(folder)) {
    assertNoKnownTrace(file.rel, `source-trace emitted name ${file.rel}`)
    assertNoKnownTrace(await readFile(file.full, 'utf8'), `source-trace emitted file ${file.rel}`)
  }
})

test('start emits a trace-free cross-section ledger and a false consistency template', async () => {
  const { started, brief, folder } = await startTracedTwoSectionBundle()
  const expected = {
    id: 'T1',
    category: 'city_or_region',
    sections: ['S1', 'S2'],
    occurrences: { S1: 1, S2: 2 },
  }
  assert.deepEqual(brief.traces, [expected])
  assert.deepEqual(started.trace_ledger, [expected])
  assertNoKnownTrace(JSON.stringify(started.trace_ledger), 'trace ledger')
  assertNoKnownTrace(await readFile(join(folder, 'BRIEF.json'), 'utf8'), 'BRIEF trace ledger')
  assert.equal(started.consistency_template.audited, false)
  assert.deepEqual(started.consistency_template.sections_reviewed, [])
  assert.equal(started.consistency_template.alias_stability, false)
  assert.equal(started.consistency_template.file_references_consistent, false)
  assert.equal(started.consistency_template.no_unmapped_entities, false)
  assert.equal(started.consistency_template.notes, '')
  assert.deepEqual(started.consistency_template.rows, [{
    trace_id: 'T1',
    disposition: 'alias',
    alias: '',
    category: 'city_or_region',
    sections: ['S1', 'S2'],
  }])
})

test('alias drift, missing aliases, and undeclared alias-like tokens are refused fail-closed', async () => {
  const { definition, harness, folder, brief } = await startTracedTwoSectionBundle()
  const aliases = { T1: 'City A' }
  const handoff = buildEnglishHandoff(brief, { aliases })
  const consistency = buildConsistency(brief, { aliases })
  const reviewRows = buildReviewRows(brief)
  const s2Index = handoff.indexOf('## [S2]')
  assert.ok(s2Index > 0)

  const beforeS2 = handoff.slice(0, s2Index)
  const afterS2 = handoff.slice(s2Index)
  const drifted = `${beforeS2}${afterS2.replace('City A', 'City B')}`
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: drifted, review: reviewRows, scrub: cleanScrub(), consistency }, harness.exec),
    /alias does not appear in affected section S2|undeclared alias-like token/,
  )
  await assertStagedOnly(folder)

  const missingAlias = `${beforeS2}${afterS2.replace('City A', 'the item')}`
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: missingAlias, review: reviewRows, scrub: cleanScrub(), consistency }, harness.exec),
    /alias does not appear in affected section S2/,
  )
  await assertStagedOnly(folder)

  const undeclared = buildEnglishHandoff(brief, { aliases, sectionExtras: { S1: ['Person B owns delivery.'] } })
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: undeclared, review: reviewRows, scrub: cleanScrub(), consistency }, harness.exec),
    /undeclared alias-like token/,
  )
  await assertStagedOnly(folder)

  const ready = await definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency }, harness.exec)
  assert.equal(ready.status, 'ready')
})

test('section headings and file labels must stay exact', async () => {
  const cwd = await makeCwd()
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'notes.md'), 'Safe project notes.\n', 'utf8')
  const harness = createHarness({ cwd, answers: allSourceAnswers('src/notes.md', 'clean note'), messages: [] })
  const definition = harness.definitions[0]
  const started = await definition.execute({ action: 'start' }, harness.exec)
  const folder = fromCwd(started.folder, cwd)
  const brief = JSON.parse(await readFile(join(folder, 'BRIEF.json'), 'utf8'))
  const handoff = buildEnglishHandoff(brief)
  const consistency = buildConsistency(brief)
  const reviewRows = buildReviewRows(brief)

  const changedLabel = handoff.replace('## [S1] src/notes.md', '## [S1] renamed.md')
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: changedLabel, review: reviewRows, scrub: cleanScrub(), consistency }, harness.exec),
    /heading label must exactly match the source label/,
  )
  await assertStagedOnly(folder)

  const inventedFile = `${handoff}\n\nSee file-9 for details.\n`
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: inventedFile, review: reviewRows, scrub: cleanScrub(), consistency }, harness.exec),
    /unknown or renamed file label token/,
  )
  await assertStagedOnly(folder)

  const ready = await definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency }, harness.exec)
  assert.equal(ready.status, 'ready')
})

test('trace rows and sections_reviewed are enforced exactly', async () => {
  const { definition, harness, folder, brief } = await startTracedTwoSectionBundle()
  const aliases = { T1: 'City A' }
  const handoff = buildEnglishHandoff(brief, { aliases })
  const reviewRows = buildReviewRows(brief)
  const consistency = buildConsistency(brief, { aliases })
  const traceRow = consistency.rows[0]

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { aliases, overrides: { rows: [] } }) }, harness.exec),
    /Missing consistency row for trace T1/,
  )
  await assertStagedOnly(folder)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { aliases, overrides: { rows: [traceRow, traceRow] } }) }, harness.exec),
    /Trace T1 has 2 consistency rows/,
  )
  await assertStagedOnly(folder)

  const extra = { trace_id: 'T9', category: 'city_or_region', disposition: 'removed', sections: ['S1'] }
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { aliases, overrides: { rows: [traceRow, extra] } }) }, harness.exec),
    /not in this bundle's ledger/,
  )
  await assertStagedOnly(folder)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { aliases, overrides: { sections_reviewed: ['S1'] } }) }, harness.exec),
    /sections_reviewed is missing: S2/,
  )
  await assertStagedOnly(folder)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { aliases, overrides: { sections_reviewed: ['S1', 'S2', 'S9'] } }) }, harness.exec),
    /sections_reviewed contains an unknown section id/,
  )
  await assertStagedOnly(folder)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { aliases, overrides: { sections_reviewed: ['S1', 'S1', 'S2'] } }) }, harness.exec),
    /sections_reviewed lists section S1 2 times/,
  )
  await assertStagedOnly(folder)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { aliases, overrides: { rows: [{ ...traceRow, category: 'organization_or_platform' }] } }) }, harness.exec),
    /T1 category must be city_or_region/,
  )
  await assertStagedOnly(folder)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { aliases, overrides: { rows: [{ ...traceRow, sections: ['S1'] }] } }) }, harness.exec),
    /T1 sections must exactly match the ledger sections/,
  )
  await assertStagedOnly(folder)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { aliases: { T1: 'Zhang Wei' } }) }, harness.exec),
    /T1 needs a structured alias/,
  )
  await assertStagedOnly(folder)

  const ready = await definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency }, harness.exec)
  assert.equal(ready.status, 'ready')
})

test('removed trace rows publish only when the entity is absent and no alias is declared', async () => {
  const { definition, harness, folder, brief } = await startTracedTwoSectionBundle()
  const reviewRows = buildReviewRows(brief)
  const handoff = buildEnglishHandoff(brief)
  const removedRow = { trace_id: 'T1', category: 'city_or_region', disposition: 'removed', sections: ['S1', 'S2'] }

  await assert.rejects(
    definition.execute({
      action: 'finalize',
      handoff_markdown: handoff,
      review: reviewRows,
      scrub: cleanScrub(),
      consistency: buildConsistency(brief, { overrides: { rows: [{ ...removedRow, alias: 'City A' }] } }),
    }, harness.exec),
    /T1 uses disposition "removed" but still declares an alias/,
  )
  await assertStagedOnly(folder)

  const ready = await definition.execute({
    action: 'finalize',
    handoff_markdown: handoff,
    review: reviewRows,
    scrub: cleanScrub(),
    consistency: buildConsistency(brief, { overrides: { rows: [removedRow] } }),
  }, harness.exec)
  assert.equal(ready.status, 'ready')
  const reviewText = await readFile(join(folder, 'REVIEW.md'), 'utf8')
  assert.match(reviewText, /\| T1 \| city_or_region \| removed \| - \| S1, S2 \|/)
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
  assert.equal(manifest.consistency.removed, 1)
  assert.equal(manifest.consistency.aliased, 0)
})

test('model-added M rows are validated and accepted for scanner-missed entities', async () => {
  const cwd = await makeCwd()
  await writeFile(join(cwd, 'safe.md'), 'Safe project notes.\n', 'utf8')
  const harness = createHarness({ cwd, answers: allSourceAnswers('safe.md', 'clean note'), messages: [] })
  const definition = harness.definitions[0]
  const started = await definition.execute({ action: 'start' }, harness.exec)
  const folder = fromCwd(started.folder, cwd)
  const brief = JSON.parse(await readFile(join(folder, 'BRIEF.json'), 'utf8'))
  const reviewRows = buildReviewRows(brief)
  assert.deepEqual(brief.traces, [])
  const mRow = { trace_id: 'M1', category: 'model_identified', disposition: 'alias', alias: 'Vendor A', sections: ['S1'] }

  const malformed = buildEnglishHandoff(brief, { sectionExtras: { S1: ['Vendor A supports the integration.'] } })
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: malformed, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { rows: [{ ...mRow, alias: 'Zhang Wei' }] }) }, harness.exec),
    /M1 needs a structured alias/,
  )
  await assertStagedOnly(folder)

  const twoVendors = buildEnglishHandoff(brief, { sectionExtras: { S1: ['Vendor A supports the integration.', 'Vendor B reviews the work.'] } })
  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: twoVendors, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { rows: [mRow, { trace_id: 'M2', category: 'model_identified', disposition: 'alias', alias: 'Vendor B', sections: ['S2'] }] }) }, harness.exec),
    /M2 alias does not appear in listed section S2/,
  )
  await assertStagedOnly(folder)

  const validHandoff = buildEnglishHandoff(brief, { sectionExtras: { S1: ['Vendor A supports the integration.'] } })
  const ready = await definition.execute({
    action: 'finalize',
    handoff_markdown: validHandoff,
    review: reviewRows,
    scrub: cleanScrub(),
    consistency: buildConsistency(brief, { rows: [mRow] }),
  }, harness.exec)
  assert.equal(ready.status, 'ready')
  const reviewText = await readFile(join(folder, 'REVIEW.md'), 'utf8')
  assert.match(reviewText, /## Context consistency review/)
  assert.match(reviewText, /\| M1 \| model_identified \| alias \| Vendor A \| S1 \|/)
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
  assert.equal(manifest.consistency.model_entities, 1)
  assert.equal(manifest.consistency.traces, 0)
  assert.equal(manifest.consistency.aliased, 1)
})

test('consistency is required and all flags and notes are validated', async () => {
  const cwd = await makeCwd()
  const { definition, harness, folder, brief, started } = await startNoteBundle({ cwd, noteText: 'clean note' })
  assert.deepEqual(started.trace_ledger, [])
  assert.deepEqual(started.consistency_template.rows, [])
  const handoff = buildEnglishHandoff(brief)
  const reviewRows = buildReviewRows(brief)
  const base = buildConsistency(brief)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub() }, harness.exec),
    /consistency is required for finalize/,
  )
  await assertStagedOnly(folder)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { overrides: { audited: false } }) }, harness.exec),
    /consistency\.audited must be true/,
  )
  await assertStagedOnly(folder)

  for (const field of ['alias_stability', 'file_references_consistent', 'no_unmapped_entities']) {
    await assert.rejects(
      definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { overrides: { [field]: false } }) }, harness.exec),
      new RegExp(`consistency\\.${field} must be true`),
    )
    await assertStagedOnly(folder)
  }

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { overrides: { notes: '   ' } }) }, harness.exec),
    /consistency\.notes must be a non-empty/,
  )
  await assertStagedOnly(folder)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { overrides: { notes: '中文说明' } }) }, harness.exec),
    /consistency\.notes contains forbidden CJK/,
  )
  await assertStagedOnly(folder)

  await assert.rejects(
    definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: buildConsistency(brief, { overrides: { notes: 'The Beijing rollout was reviewed.' } }) }, harness.exec),
    (error) => {
      assert.match(error.message, /consistency\.notes contains a forbidden regional trace \(category city_or_region at line\(s\) \d+\)/)
      assert.equal(error.message.includes('Beijing'), false, 'consistency-note errors must not echo the matched term')
      return true
    },
  )
  await assertStagedOnly(folder)

  const ready = await definition.execute({ action: 'finalize', handoff_markdown: handoff, review: reviewRows, scrub: cleanScrub(), consistency: base }, harness.exec)
  assert.equal(ready.status, 'ready')
})

test('a complete T and M consistency table publishes and appears in REVIEW and manifest', async () => {
  const { definition, harness, folder, brief } = await startTracedTwoSectionBundle()
  const aliases = { T1: 'City A' }
  const modelRow = { trace_id: 'M1', category: 'model_identified', disposition: 'alias', alias: 'Vendor A', sections: ['S1'] }
  const handoff = buildEnglishHandoff(brief, { aliases, sectionExtras: { S1: ['Vendor A supports the integration.'] } })
  const consistency = buildConsistency(brief, { aliases, rows: [modelRow] })
  const ready = await definition.execute({
    action: 'finalize',
    handoff_markdown: handoff,
    review: buildReviewRows(brief),
    scrub: cleanScrub(),
    consistency,
  }, harness.exec)
  assert.equal(ready.status, 'ready')

  const finalHandoff = await readFile(join(folder, 'HANDOFF.md'), 'utf8')
  assert.ok(finalHandoff.includes('City A'))
  assert.ok(finalHandoff.includes('Vendor A'))
  const reviewText = await readFile(join(folder, 'REVIEW.md'), 'utf8')
  assert.match(reviewText, /## Context consistency review/)
  assert.match(reviewText, /\| T1 \| city_or_region \| alias \| City A \| S1, S2 \|/)
  assert.match(reviewText, /\| M1 \| model_identified \| alias \| Vendor A \| S1 \|/)
  assert.match(reviewText, /- Audited: yes/)
  assert.match(reviewText, /- Sections reviewed: 2 of 2/)
  const manifestText = await readFile(join(folder, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.consistency.audited, true)
  assert.equal(manifest.consistency.traces, 1)
  assert.equal(manifest.consistency.model_entities, 1)
  assert.equal(manifest.consistency.aliased, 2)
  assert.equal(manifest.consistency.removed, 0)
  assert.equal(manifest.consistency.sections_reviewed, 2)
  assert.equal(manifest.consistency.alias_stability, true)
  assert.equal(manifest.consistency.file_references_consistent, true)
  assert.equal(manifest.consistency.no_unmapped_entities, true)
  assert.equal(typeof manifest.consistency.notes_sha256, 'string')
  assert.equal(manifest.consistency.notes_sha256.length, 64)
  assertNoKnownTrace(reviewText, 'consistency REVIEW.md')
  assertNoKnownTrace(manifestText, 'consistency manifest.json')
})

test('two distinct trace rows may share one structured alias for the same entity', async () => {
  // A previous revision refused this fixture with
  // "T2 reuses an alias already declared by T1; aliases must be unique and stable."
  // Two mechanically distinct source terms (a country name and its adjective)
  // can denote one entity, so that rejection was the drift bug. This test is
  // the red -> green regression: both T rows declare Region A and it appears
  // in every affected section of both rows.
  const cwd = await makeCwd()
  const noteText = 'Country name and adjective: China and Chinese.'
  const { definition, harness, folder, brief } = await startNoteBundle({ cwd, noteText })
  assert.equal(brief.traces.length, 2, 'the fixture must produce two distinct ledger entries for one entity')
  assert.deepEqual(brief.traces.map((trace) => trace.id), ['T1', 'T2'])
  assert.deepEqual(brief.traces.map((trace) => trace.category), ['country_or_region', 'country_or_region'])
  const sharedAlias = 'Region A'
  const aliases = { T1: sharedAlias, T2: sharedAlias }
  const handoff = buildEnglishHandoff(brief, { aliases })
  const consistency = buildConsistency(brief, {
    aliases,
    overrides: {
      notes: 'Region A denotes one source entity in this handoff; sharing the alias between the two source terms is intentional.',
    },
  })
  const ready = await definition.execute({
    action: 'finalize',
    handoff_markdown: handoff,
    review: buildReviewRows(brief),
    scrub: cleanScrub(),
    consistency,
  }, harness.exec)
  assert.equal(ready.status, 'ready')
  assert.deepEqual((await readdir(folder)).sort(), ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md', 'manifest.json'])
  const finalHandoff = await readFile(join(folder, 'HANDOFF.md'), 'utf8')
  assert.ok(finalHandoff.includes(sharedAlias))
  assertNoKnownTrace(finalHandoff, 'shared-alias HANDOFF.md')
  const reviewText = await readFile(join(folder, 'REVIEW.md'), 'utf8')
  assert.match(reviewText, /## Context consistency review/)
  assert.match(reviewText, /\| T1 \| country_or_region \| alias \| Region A \| S1 \|/)
  assert.match(reviewText, /\| T2 \| country_or_region \| alias \| Region A \| S1 \|/)
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
  assert.equal(manifest.consistency.traces, 2)
  assert.equal(manifest.consistency.aliased, 2)
  assert.equal(manifest.consistency.removed, 0)
  assertNoKnownTrace(await readFile(join(folder, 'manifest.json'), 'utf8'), 'shared-alias manifest.json')
})

test('an unexpected draft in the staging folder is refused before any final artifact', async () => {
  const cwd = await makeCwd()
  const { harness, definition, folder, brief } = await startNoteBundle({ cwd })
  await writeFile(join(folder, 'draft-中文.md'), 'unexpected draft\n', 'utf8')
  await assert.rejects(
    definition.execute(finalizeArgs(brief), harness.exec),
    /unexpected entry/i,
  )
  assert.deepEqual((await readdir(folder)).sort(), ['BRIEF.json', 'SOURCE.md', 'draft-中文.md'])
  assert.equal(await exists(join(folder, 'HANDOFF.md')), false)
  assert.equal(await exists(join(folder, 'REVIEW.md')), false)
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)
  assert.equal(await exists(join(folder, 'manifest.json')), false)
  const status = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(status.status, 'awaiting_translation')
})

test('successful finalize publishes manifest.json last and status validates it', async () => {
  const seen = []
  const cwd = await makeCwd()
  const { harness, definition, folder, brief } = await startNoteBundle({
    cwd,
    forwardTestHooks: {
      beforeManifest: async ({ folder: current }) => {
        seen.push((await readdir(current)).sort())
      },
    },
  })
  const ready = await definition.execute(finalizeArgs(brief), harness.exec)
  assert.equal(ready.status, 'ready')
  assert.deepEqual(seen, [['HANDOFF.md', 'PROMPT.md', 'REVIEW.md']], 'staging must be gone and manifest absent before manifest is written')
  assert.deepEqual((await readdir(folder)).sort(), ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md', 'manifest.json'])
  const status = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(status.status, 'ready')
  assert.deepEqual(status.files, ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md', 'manifest.json'])
  await assert.rejects(
    definition.execute(finalizeArgs(brief), harness.exec),
    /already finalized/i,
  )
})

test('manifest removal makes status incomplete and finalize refuses the latest bundle', async () => {
  const { harness, definition, folder, brief } = await finalizeNoteBundle()
  await rm(join(folder, 'manifest.json'))
  const incomplete = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(incomplete.status, 'incomplete')
  await assert.rejects(
    definition.execute(finalizeArgs(brief), harness.exec),
    /latest handoff bundle is incomplete/i,
  )
  await writeFile(join(folder, 'manifest.json'), '{ this is not json\n', 'utf8')
  const invalid = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(invalid.status, 'invalid')
  await assert.rejects(
    definition.execute(finalizeArgs(brief), harness.exec),
    /latest handoff bundle has an invalid manifest/i,
  )
})

test('a pre-commit failure rolls back all final artifacts and restores staging', async () => {
  const cwd = await makeCwd()
  const { harness, definition, folder, brief } = await startNoteBundle({
    cwd,
    forwardTestHooks: {
      beforeManifest: async () => {
        throw new Error('injected publish failure')
      },
    },
  })
  const sourceBefore = await readFile(join(folder, 'SOURCE.md'), 'utf8')
  const briefBefore = await readFile(join(folder, 'BRIEF.json'), 'utf8')
  await assert.rejects(
    definition.execute(finalizeArgs(brief), harness.exec),
    /restored for retry/,
  )
  assert.deepEqual((await readdir(folder)).sort(), ['BRIEF.json', 'SOURCE.md'])
  assert.equal(await exists(join(folder, 'HANDOFF.md')), false)
  assert.equal(await exists(join(folder, 'REVIEW.md')), false)
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)
  assert.equal(await exists(join(folder, 'manifest.json')), false)
  assert.equal(await readFile(join(folder, 'SOURCE.md'), 'utf8'), sourceBefore)
  assert.equal(await readFile(join(folder, 'BRIEF.json'), 'utf8'), briefBefore)
  const status = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(status.status, 'awaiting_translation')
})

test('status stays incomplete until the final verification succeeds', async () => {
  const cwd = await makeCwd()
  const { harness, definition, folder, brief } = await startNoteBundle({
    cwd,
    forwardTestHooks: {
      beforeManifest: async ({ folder: current }) => {
        const status = await definition.execute({ action: 'status' }, harness.exec)
        assert.equal(status.status, 'incomplete')
        assert.equal(await exists(join(current, 'manifest.json')), false)
        await writeFile(join(current, 'late-中文.md'), 'late draft\n', 'utf8')
      },
    },
  })
  await assert.rejects(
    definition.execute(finalizeArgs(brief), harness.exec),
    (error) => /restored for retry/.test(error.message) && /unexpected entry/.test(error.cause?.message),
  )
  assert.equal(await exists(join(folder, 'SOURCE.md')), true)
  assert.equal(await exists(join(folder, 'BRIEF.json')), true)
  assert.equal(await exists(join(folder, 'HANDOFF.md')), false)
  assert.equal(await exists(join(folder, 'REVIEW.md')), false)
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)
  assert.equal(await exists(join(folder, 'manifest.json')), false)
  const status = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(status.status, 'awaiting_translation')
})

test('an interrupted publish preserves staging for finalize in a fresh process', async () => {
  const cwd = await makeCwd()
  const { harness, definition, folder, brief } = await startNoteBundle({ cwd, noteText: NOTE_TEXT })
  const staging = await snapshot(folder)
  const args = finalizeArgs(brief)
  const childScript = `
      import assert from 'node:assert/strict'
      import * as plugin from ${JSON.stringify(new URL('../index.js', import.meta.url).href)}
      const createHarness = ${createHarness.toString()}
      const { definitions, exec } = createHarness({
        cwd: ${JSON.stringify(cwd)},
        answers: [],
        messages: [],
        sessionId: ${JSON.stringify(SESSION_ID)},
        forwardTestHooks: { beforeManifest() { process.exit(86) } },
      })
      await definitions[0].execute(${JSON.stringify(args)}, exec)
    `
  // No pipes: the DSH Windows sandbox permits child processes with ignored
  // stdio but denies piped child stdio with EPERM. The exit code still proves
  // that the interrupted process left the on-disk recovery snapshot.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    stdio: 'ignore',
    timeout: 10000,
  })
  assert.ifError(child.error)
  assert.equal(child.status, 86, child.stderr)
  assert.deepEqual((await readdir(folder)).sort(), ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md'])
  assert.equal((await definition.execute({ action: 'status' }, harness.exec)).status, 'incomplete')
  const siblings = await readdir(dirname(folder))
  const recoveryName = siblings.find((name) => name.endsWith('.staging.json'))
  assert.ok(recoveryName)
  const saved = JSON.parse(await readFile(join(dirname(folder), recoveryName), 'utf8'))
  assert.deepEqual([
    { rel: 'BRIEF.json', sha256: sha256(saved.briefText) },
    { rel: 'SOURCE.md', sha256: sha256(saved.sourceText) },
  ], staging)

  assert.equal((await definition.execute(args, harness.exec)).status, 'ready')
  assert.deepEqual(await readdir(dirname(folder)), [basename(folder)])
  assert.deepEqual((await readdir(folder)).sort(), ['HANDOFF.md', 'PROMPT.md', 'REVIEW.md', 'manifest.json'])
})

test('status and finalize require both staging files', async () => {
  for (const missing of ['SOURCE.md', 'BRIEF.json']) {
    const cwd = await makeCwd()
    const { harness, definition, folder, brief } = await startNoteBundle({ cwd })
    await rm(join(folder, missing))
    const status = await definition.execute({ action: 'status' }, harness.exec)
    assert.equal(status.status, 'incomplete', missing)
    await assert.rejects(definition.execute(finalizeArgs(brief), harness.exec), /latest handoff bundle is incomplete/i)
    assert.deepEqual(await readdir(folder), [missing === 'SOURCE.md' ? 'BRIEF.json' : 'SOURCE.md'])
  }
})

test('a ready manifest with a missing artifact is incomplete and finalize refuses it', async () => {
  const { harness, definition, folder, brief } = await finalizeNoteBundle()
  await rm(join(folder, 'HANDOFF.md'))
  const status = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(status.status, 'incomplete')
  await assert.rejects(
    definition.execute(finalizeArgs(brief), harness.exec),
    /latest handoff bundle is incomplete/i,
  )
})

test('an empty latest bundle is incomplete and cannot be finalized', async () => {
  const cwd = await makeCwd()
  const sessionDir = join(cwd, 'forward-to-claude', SESSION_ID)
  await mkdir(sessionDir, { recursive: true })
  await mkdir(join(sessionDir, 'handoff-20261119-120000'))
  const harness = createHarness({ cwd, answers: [], messages: [] })
  const definition = harness.definitions[0]
  const status = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(status.status, 'incomplete')
  await assert.rejects(
    definition.execute({ action: 'finalize' }, harness.exec),
    /latest handoff bundle is incomplete/i,
  )
})

test('eleven same-second starts sort by numeric suffix and select -10', async () => {
  const cwd = await makeCwd()
  const fixed = new Date('2026-11-19T12:00:00Z').getTime()
  const answers = Array.from({ length: 11 }, () => noteOnlyAnswers('same-second note')).flat()
  const harness = createHarness({ cwd, answers, messages: [] })
  const definition = harness.definitions[0]
  await withFixedDate(() => fixed, async () => {
    for (let index = 0; index < 11; index += 1) {
      await definition.execute({ action: 'start' }, harness.exec)
    }
    const sessionDir = join(cwd, 'forward-to-claude', SESSION_ID)
    const names = (await readdir(sessionDir)).sort()
    assert.deepEqual(names, [
      'handoff-20261119-120000',
      ...Array.from({ length: 10 }, (_, index) => `handoff-20261119-120000-${index + 1}`),
    ].sort())
    const selected = await definition.execute({ action: 'status' }, harness.exec)
    assert.equal(basename(fromCwd(selected.folder, cwd)), 'handoff-20261119-120000-10')
    assert.equal(selected.status, 'awaiting_translation')
    const latestBrief = JSON.parse(await readFile(join(sessionDir, 'handoff-20261119-120000-10', 'BRIEF.json'), 'utf8'))
    const ready = await definition.execute(finalizeArgs(latestBrief), harness.exec)
    assert.equal(ready.status, 'ready')
    assert.equal(basename(fromCwd(ready.folder, cwd)), 'handoff-20261119-120000-10')
    const after = await definition.execute({ action: 'status' }, harness.exec)
    assert.equal(after.status, 'ready')
    assert.equal(basename(fromCwd(after.folder, cwd)), 'handoff-20261119-120000-10')
  })
})

test('timestamp ordering and the unsuffixed default-0 suffix are both respected', async () => {
  const cwd = await makeCwd()
  let now = new Date('2026-11-19T12:00:00Z').getTime()
  const harness = createHarness({
    cwd,
    answers: Array.from({ length: 3 }, () => noteOnlyAnswers('ordering note')).flat(),
    messages: [],
  })
  const definition = harness.definitions[0]
  await withFixedDate(() => now, async () => {
    await definition.execute({ action: 'start' }, harness.exec)
    await definition.execute({ action: 'start' }, harness.exec)
    const suffixed = await definition.execute({ action: 'status' }, harness.exec)
    assert.equal(basename(fromCwd(suffixed.folder, cwd)), 'handoff-20261119-120000-1')
    now = new Date('2026-11-19T12:00:01Z').getTime()
    await definition.execute({ action: 'start' }, harness.exec)
    const newer = await definition.execute({ action: 'status' }, harness.exec)
    assert.equal(basename(fromCwd(newer.folder, cwd)), 'handoff-20261119-120001')
  })
})

test('symlinked HANDOFF.md is refused before writes and its target is untouched', async (t) => {
  const cwd = await makeCwd()
  const outside = await makeOutsideDir()
  const target = join(outside, 'outside-handoff.md')
  await writeFile(target, 'outside draft content\n', 'utf8')
  const { harness, definition, folder, brief } = await startNoteBundle({ cwd })
  if (!await createFileSymlinkOrSkip(t, target, join(folder, 'HANDOFF.md'))) return
  await assert.rejects(
    definition.execute(finalizeArgs(brief), harness.exec),
    /symlink|non-regular/i,
  )
  assert.equal(await readFile(target, 'utf8'), 'outside draft content\n')
  assert.equal(await exists(join(folder, 'REVIEW.md')), false)
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)
  assert.equal(await exists(join(folder, 'manifest.json')), false)
})

test('symlinked BRIEF.json is refused and leaves staging intact', async (t) => {
  const cwd = await makeCwd()
  const outside = await makeOutsideDir()
  const target = join(outside, 'outside-brief.json')
  const { harness, definition, folder, brief } = await startNoteBundle({ cwd })
  const originalBrief = await readFile(join(folder, 'BRIEF.json'), 'utf8')
  await writeFile(target, originalBrief, 'utf8')
  await rm(join(folder, 'BRIEF.json'))
  if (!await createFileSymlinkOrSkip(t, target, join(folder, 'BRIEF.json'))) return
  await assert.rejects(
    definition.execute(finalizeArgs(brief), harness.exec),
    /symlink|non-regular/i,
  )
  assert.equal(await exists(join(folder, 'SOURCE.md')), true)
  assert.equal(await exists(join(folder, 'REVIEW.md')), false)
  assert.equal(await exists(join(folder, 'PROMPT.md')), false)
  assert.equal(await exists(join(folder, 'manifest.json')), false)
  assert.equal(await readFile(target, 'utf8'), originalBrief)
})

test('symlinked manifest.json makes status invalid and finalize refuses it', async (t) => {
  const cwd = await makeCwd()
  const outside = await makeOutsideDir()
  const { harness, definition, folder, brief } = await finalizeNoteBundle({ cwd })
  const target = join(outside, 'outside-manifest.json')
  await writeFile(target, await readFile(join(folder, 'manifest.json'), 'utf8'), 'utf8')
  await rm(join(folder, 'manifest.json'))
  if (!await createFileSymlinkOrSkip(t, target, join(folder, 'manifest.json'))) return
  const status = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(status.status, 'invalid')
  await assert.rejects(
    definition.execute(finalizeArgs(brief), harness.exec),
    /symlink|non-regular/i,
  )
  assert.equal(await exists(target), true)
})

test('finalize publishes on a strict Host context without test hooks', async () => {
  const cwd = await makeCwd()
  const { harness, definition, brief } = await startNoteBundle({ cwd })
  // createHarness omits forwardToClaudeTestHooks entirely and installs a
  // throwing getter, mirroring Cordis. The optional test hook must not make
  // production finalize fail when the property is absent.
  const ready = await definition.execute(finalizeArgs(brief), harness.exec)
  assert.equal(ready.status, 'ready')
  const status = await definition.execute({ action: 'status' }, harness.exec)
  assert.equal(status.status, 'ready')
})

test('start does not read an uninjected clock service', async () => {
  const cwd = await makeCwd()
  const harness = createHarness({
    cwd,
    answers: noteOnlyAnswers('clock regression'),
    messages: [],
  })
  // createHarness installs a throwing `clock` getter that mirrors Cordis.
  const started = await harness.definitions[0].execute({ action: 'start' }, harness.exec)
  assert.equal(typeof started.folder, 'string')
  assert.equal(started.status, 'awaiting_translation')
  const status = await harness.definitions[0].execute({ action: 'status' }, harness.exec)
  assert.equal(status.status, 'awaiting_translation')
})

test('package test script and Node engine range are portable', async () => {
  const packageJson = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/)
  assert.equal(packageJson.scripts.test, 'node --test tests/integration.mjs')
  assert.equal(packageJson.engines.node, '>=22.0.0')
  const workflow = await readFile(join(PACKAGE_DIR, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(workflow, /'22'/)
  assert.match(workflow, /'24'/)
  const changelog = await readFile(join(PACKAGE_DIR, 'CHANGELOG.md'), 'utf8')
  const escapedVersion = packageJson.version.replaceAll('.', '\\.')
  assert.match(changelog, new RegExp(`## \\[${escapedVersion}\\]`))
})
