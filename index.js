/**
 * Forward to Claude: a Host-only DeepSeek Harness bundle.
 *
 * The plugin exposes one global tool, `forward_to_claude`, that turns the
 * current session or project into an English-only handoff bundle for Claude.
 * The work is deliberately split in two steps because the plugin can move
 * bytes but only the calling agent can translate prose:
 *
 *   start    -> ask what to include, stage SOURCE.md + BRIEF.json, return
 *               translation instructions and a review template.
 *   finalize -> mechanically verify the English text (section coverage,
 *               inline code spans, review rows, zero CJK/fullwidth
 *               characters), then publish HANDOFF.md, REVIEW.md, PROMPT.md,
 *               and manifest.json and delete the staging files.
 *
 * The plugin imports only Node built-ins, performs no network I/O, and never
 * contacts Claude. It only writes inside the session working directory.
 *
 * @module dsh-forward-to-claude
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, lstat, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Plugin (Cordis row) name. */
export const name = 'forward-to-claude'

/** Host services this plugin requires before it can activate. */
export const inject = ['tools', 'userQuestions', 'workingDirectory', 'systemPrompt']

/** Model-facing tool name. The tool registry keys tools by this name. */
const TOOL_NAME = 'forward_to_claude'

/** Directory created under the session working directory. */
const HANDOFF_ROOT = 'forward-to-claude'

/** Source selection option labels, in the required order. */
const OPTION_CONVERSATION = 'Conversation so far (Recommended)'
const OPTION_FILES = 'Text files from this project'
const OPTION_NOTE = 'A handoff note I write now'

/** Hard limits for one handoff. */
const MAX_FILES = 20
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_FILE_BYTES = 4 * 1024 * 1024
const MAX_CONVERSATION_CHARS = 240000
const MESSAGES_PER_SECTION = 4

/** Stop listing validation problems after this many entries. */
const MAX_PROBLEMS = 20

/** Artifacts written by a successful finalize. */
const FINAL_ARTIFACTS = ['HANDOFF.md', 'REVIEW.md', 'PROMPT.md', 'manifest.json']
const STAGING_FILES = ['SOURCE.md', 'BRIEF.json']
const activeFinalizations = new Set()

/** Staging and final entries a handoff folder may contain. */
const BUNDLE_ENTRIES = new Set([...STAGING_FILES, ...FINAL_ARTIFACTS])

/** Handoff folder name: timestamp plus optional numeric duplicate suffix. */
const HANDOFF_NAME_PATTERN = /^handoff-(\d{8}-\d{6})(?:-(\d+))?$/

/**
 * One CJK/fullwidth scan used by every gate in this plugin.
 *
 * The script part is property-based (`Script=Han`, `Hiragana`, `Katakana`,
 * `Hangul`, `Bopomofo`), so every Han extension and kana block the runtime's
 * Unicode tables know is covered without enumerating blocks by hand - including
 * Han Extension H (U+31350-323AF), Han Extension I (U+2EBF0-2EE5F), and Kana
 * Extended-B (U+1AFF0-1AFFF). The explicit ranges cover assigned characters
 * that are not script-tagged: CJK radicals, ideographic description
 * characters, CJK punctuation, kana voicing marks and punctuation, CJK
 * strokes, enclosed CJK, CJK compatibility/vertical/small forms, and
 * fullwidth/halfwidth forms.
 *
 * Used as one `u`-flagged pattern (plus a `gu` copy for line-number scanning)
 * so no code path can forget a class.
 */
const CJK_PATTERN_SOURCE = '['
  + '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Bopomofo}'
  + '\\u2E80-\\u2EFF' // CJK Radicals Supplement
  + '\\u2F00-\\u2FDF' // Kangxi Radicals
  + '\\u2FF0-\\u2FFF' // Ideographic Description Characters
  + '\\u3000-\\u303F' // CJK Symbols and Punctuation
  + '\\u3099-\\u309C' // combining kana sound marks and kana voicing marks
  + '\\u30A0' // Katakana-Hiragana double hyphen
  + '\\u30FB-\\u30FC' // Katakana middle dot and prolonged sound mark
  + '\\u31C0-\\u31EF' // CJK Strokes
  + '\\u3200-\\u33FF' // Enclosed CJK Letters and Months, CJK Compatibility
  + '\\uFE10-\\uFE1F' // Vertical Forms
  + '\\uFE30-\\uFE4F' // CJK Compatibility Forms
  + '\\uFE50-\\uFE6F' // CJK Small Form Variants
  + '\\uFF00-\\uFFEF' // Halfwidth and Fullwidth Forms
  + '\\u{1F200}-\\u{1F2FF}' // Enclosed Ideographic Supplement
  + ']'

const CJK_GLOBAL = new RegExp(CJK_PATTERN_SOURCE, 'gu')
const CJK_TEST = new RegExp(CJK_PATTERN_SOURCE, 'u')

/* ------------------------------------------------------------------ */
/* Regional-trace policy                                              */
/* ------------------------------------------------------------------ */

/** Neutral category ids used in every report; matched terms are never echoed. */
const REGIONAL_TRACE_CATEGORIES = [
  'country_or_region',
  'city_or_region',
  'organization_or_platform',
  'domain_or_contact',
  'currency_or_unit',
  'locale_or_language',
  'political_or_cultural',
  'personal_name',
]

/** Required scrub-checklist fields, in report order. */
const SCRUB_FIELDS = [
  ['personal_names_replaced', 'Personal names replaced'],
  ['organizations_replaced', 'Organizations replaced'],
  ['places_replaced', 'Places replaced'],
  ['platforms_contacts_replaced', 'Platforms and contacts replaced'],
  ['currency_units_locale_replaced', 'Currency, units, and locale tags replaced'],
  ['political_cultural_references_replaced', 'Political and cultural references replaced'],
]

/** Placeholder note shown by start until the translating agent completes the scrub. */
const SCRUB_PLACEHOLDER_NOTE = 'Replace this placeholder: complete the regional-trace scrub, then set every field true.'

/**
 * Escape one literal for use inside a regular expression.
 * @param {string} value - Literal text.
 * @returns {string} Escaped text.
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build one boundary-aware, case-insensitive alternative for a term.
 * @param {string} term - Literal term.
 * @returns {string} Pattern source alternative.
 */
function termPattern(term) {
  return `(?<![A-Za-z0-9])${escapeRegExp(term).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`
}

/**
 * Build one case-insensitive term-group regex.
 * @param {string[]} terms - Literal terms.
 * @returns {RegExp} Group pattern.
 */
function termGroup(terms) {
  return new RegExp(`(?:${terms.map(termPattern).join('|')})`, 'i')
}

/** City and regional names covered mechanically. */
const REGIONAL_CITY_TERMS = [
  'Beijing', 'Shanghai', 'Shenzhen', 'Guangzhou', 'Hangzhou', 'Chengdu', 'Wuhan',
  "Xi'an", 'Xian', 'Nanjing', 'Tianjin', 'Suzhou', 'Chongqing', 'Qingdao', 'Dalian', 'Xiamen',
  'Hong Kong', 'Macau', 'Macao', 'Taiwan', 'Taipei',
  'Xinjiang', 'Tibet', 'Inner Mongolia', 'Guangxi', 'Ningxia',
  'Anhui', 'Fujian', 'Gansu', 'Guangdong', 'Guizhou', 'Hainan', 'Hebei', 'Heilongjiang',
  'Henan', 'Hubei', 'Hunan', 'Jiangsu', 'Jiangxi', 'Jilin', 'Liaoning', 'Qinghai',
  'Shaanxi', 'Shanxi', 'Shandong', 'Sichuan', 'Yunnan', 'Zhejiang',
]

/** Organizations and platforms covered mechanically, including Chinese-origin brands. */
const REGIONAL_ORGANIZATION_TERMS = [
  'Alibaba', 'Alipay', 'Ant Group', 'Tencent', 'WeChat', 'Weixin', 'QQ', 'Baidu',
  'ByteDance', 'Douyin', 'TikTok', 'Xiaohongshu', 'JD.com', 'Jingdong', 'Pinduoduo',
  'Meituan', 'Dianping', 'Didi', 'Huawei', 'Xiaomi', 'Lenovo', 'BYD', 'NIO', 'XPeng',
  'ZTE', 'SMIC', 'CATL', 'Foxconn', 'TSMC', 'DJI', 'Temu', 'Shein', 'UnionPay',
  'Ping An', 'NetEase', 'Sina', 'Sohu', 'iQiyi', 'Youku', 'Bilibili', 'Zhihu', 'Weibo',
  'Kuaishou', 'Toutiao', 'Gitee', 'CSDN', 'Juejin', 'OSChina',
]

/** Known platform domains covered mechanically. */
const REGIONAL_DOMAIN_TERMS = [
  'qq.com', '163.com', '126.com', 'baidu.com', 'taobao.com', 'tmall.com', 'jd.com',
  'weibo.com', 'zhihu.com', 'bilibili.com', 'alipay.com', 'aliyun.com', 'tencent.com',
  'huawei.com', 'xiaomi.com', 'bytedance.com', 'douyin.com', 'temu.com', 'shein.com',
]

/** Common pinyin surnames used only for the high-confidence personal-name patterns. */
const PINYIN_SURNAMES = [
  'zhang', 'wang', 'li', 'zhao', 'chen', 'liu', 'yang', 'huang', 'wu', 'zhou', 'xu',
  'sun', 'ma', 'zhu', 'hu', 'guo', 'he', 'gao', 'lin', 'luo', 'zheng', 'liang', 'xie',
  'song', 'tang', 'han', 'feng', 'deng', 'cao', 'peng', 'zeng', 'xiao', 'tian', 'dong',
  'pan', 'yuan', 'cai', 'jiang', 'yu', 'du', 'ye', 'cheng', 'wei', 'su', 'lu', 'ding',
  'ren', 'shen', 'yao', 'cui', 'zhong', 'tan', 'hou', 'jia', 'gu', 'qin', 'jin', 'qiu', 'fang',
]

/** Common pinyin given-name tokens; deliberately excludes ambiguous bare syllables (li, ma). */
const PINYIN_GIVEN_NAMES = [
  'wei', 'ming', 'hua', 'fang', 'jun', 'jie', 'lei', 'yong', 'qiang', 'min', 'jing',
  'tao', 'hui', 'ping', 'gang', 'bin', 'hao', 'xin', 'yi', 'lan', 'mei', 'ling', 'hong',
  'xia', 'bo', 'chen', 'nan', 'qing', 'zhen', 'guo', 'xiu', 'ying', 'jian', 'kang', 'shan',
  'wen', 'xiang', 'xue', 'ya', 'zhi', 'zhong', 'chun', 'dong', 'feng', 'fu', 'guang', 'he',
  'jia', 'jin', 'kai', 'liang', 'lin', 'long', 'lu', 'meng', 'miao', 'mu', 'pan', 'pei',
  'qi', 'qian', 'qiao', 'qin', 'qiu', 'rong', 'rui', 'sheng', 'shi', 'shu', 'si', 'tai',
  'tan', 'tang', 'tian', 'tong', 'wan', 'wang', 'wu', 'xi', 'xian', 'xiao', 'xie', 'xing',
  'xiong', 'xu', 'xuan', 'yan', 'yang', 'yao', 'ye', 'yin', 'you', 'yu', 'yuan', 'yue',
  'yun', 'zeng', 'zheng', 'zhou', 'zhu', 'zong',
]

/**
 * Build the single regional-trace rules table. Every pattern is boundary-aware
 * except the deliberately conservative `china` identifier prefix, which is
 * matched only at an identifier start so camelCase names such as
 * `chinaPrice` are still caught while words like `machina` are not.
 * @returns {Array<{ category: string, patterns: RegExp[] }>} Rules in category order.
 */
function buildRegionalTraceRules() {
  const surnameAlternation = PINYIN_SURNAMES.join('|')
  const givenAlternation = PINYIN_GIVEN_NAMES.join('|')
  return [
    {
      category: 'country_or_region',
      patterns: [
        /(?<![A-Za-z])china/i,
        /(?<![A-Za-z])chinese\b/i,
        /\bPRC\b/i,
        /\bP\.\s?R\.\s?C\.?/i,
        /\bCCP\b/i,
        /\bCPC\b/i,
        /\bCommunist\s+Party\b/i,
        /\bPeople['’]s\s+Republic\b/i,
        /\bMainland\s+China\b/i,
        /\bGreater\s+China\b/i,
        /\bTaiwanese\b/i,
        /\bSino[-\s]/i,
      ],
    },
    { category: 'city_or_region', patterns: [termGroup(REGIONAL_CITY_TERMS)] },
    { category: 'organization_or_platform', patterns: [termGroup(REGIONAL_ORGANIZATION_TERMS)] },
    {
      category: 'domain_or_contact',
      patterns: [
        termGroup(REGIONAL_DOMAIN_TERMS),
        /(?<![A-Za-z0-9.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:cn|hk|tw|mo)(?![A-Za-z0-9])/i,
        /(?<![A-Za-z0-9.-])\.(?:cn|hk|tw|mo)(?![A-Za-z0-9])/i,
        /\+86(?![0-9])/,
        /\b0086(?![0-9])/,
        /\b86-\d{2,}/,
        /\b1[3-9]\d{9}\b/,
        /\b\d{15}\b/,
        /\b\d{17}[\dXx]\b/,
        /\b9[123][0-9A-HJ-NPQRTUWXY]{16}\b/,
      ],
    },
    {
      category: 'currency_or_unit',
      patterns: [
        /\bRMB\b/i,
        /\bCNY\b/i,
        /CN¥/i,
        /\bRenminbi\b/i,
        /\bYuan\b/i,
        /¥/,
        /￥/,
        /\b\d+(?:\.\d+)?\s*(?:jin|mu|cun|chi)\b/i,
      ],
    },
    {
      category: 'locale_or_language',
      patterns: [
        /(?<![A-Za-z0-9])zh(?:[-_](?:CN|TW|HK|Hans|Hant))?(?![A-Za-z0-9])/i,
        /\bChinese\s*\((?:Simplified|Traditional)\)/i,
        /\bMandarin\b/i,
        /\bCantonese\b/i,
        /\bPinyin\b/i,
        /\bHanyu\b/i,
        /\bPutonghua\b/i,
        /\bGB2312\b/i,
        /\bGBK\b/i,
        /\bGB18030\b/i,
        /\bBig5\b/i,
      ],
    },
    {
      category: 'political_or_cultural',
      patterns: [
        /\bCCP\b/i,
        /\bCPC\b/i,
        /\bPolitburo\b/i,
        /\bCPPCC\b/i,
        /\bNational\s+People['’]s\s+Congress\b/i,
        /\bState\s+Council\b/i,
        /\bNational\s+Day\b/i,
        /\bLunar\s+New\s+Year\b/i,
        /\bSpring\s+Festival\b/i,
        /\bMid-?Autumn\b/i,
        /\bDragon\s+Boat\b/i,
        /\bDouble\s+Eleven\b/i,
        /\bSingles['’]?\s*Day\b/i,
        /\bRed\s+Packet\b/i,
        /\bhongbao\b/i,
        /\bguanxi\b/i,
        /\bhukou\b/i,
        /\bdanwei\b/i,
      ],
    },
    {
      category: 'personal_name',
      patterns: [
        new RegExp(`\\b(?:${PINYIN_SURNAMES.map((term) => term[0].toUpperCase() + term.slice(1)).join('|')})\\s+[A-Z][a-z]{1,15}\\b`),
        new RegExp(`(?<![A-Za-z0-9])(?:${surnameAlternation})[._-](?:${givenAlternation})(?![A-Za-z0-9])`, 'i'),
        new RegExp(`(?<![A-Za-z0-9])(?:${givenAlternation})[._-](?:${surnameAlternation})(?![A-Za-z0-9])`, 'i'),
        new RegExp(`(?<![A-Za-z0-9])(?:${surnameAlternation})(?:${givenAlternation})\\d{2,4}(?![A-Za-z0-9])`, 'i'),
      ],
    },
  ]
}

const REGIONAL_TRACE_RULES = buildRegionalTraceRules()

/**
 * Scan text for regional traces and return neutral categories with line
 * numbers only. Matched terms are never returned, logged, or echoed.
 * @param {string} text - Text to scan.
 * @returns {Record<string, number[]>} Category id to sorted 1-based line numbers.
 */
function scanRegionalTraces(text) {
  if (typeof text !== 'string' || text === '') return {}
  const result = {}
  for (const rule of REGIONAL_TRACE_RULES) {
    const indexes = []
    for (const pattern of rule.patterns) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
      for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
        if (typeof match.index === 'number') indexes.push(match.index)
      }
    }
    if (indexes.length === 0) continue
    indexes.sort((left, right) => left - right)
    const lines = []
    let line = 1
    let consumed = 0
    for (const index of indexes) {
      for (let cursor = consumed; cursor < index; cursor += 1) {
        if (text.charCodeAt(cursor) === 10) line += 1
      }
      consumed = index
      if (lines[lines.length - 1] !== line) lines.push(line)
    }
    result[rule.category] = lines
  }
  return result
}

/**
 * Whether text contains any regional trace.
 * @param {string} text - Text to test.
 * @returns {boolean} True when at least one rule matches.
 */
function hasRegionalTrace(text) {
  if (typeof text !== 'string' || text === '') return false
  for (const rule of REGIONAL_TRACE_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) return true
    }
  }
  return false
}

/**
 * Summarize regional traces across several texts as category counts only.
 * @param {string[]} texts - Texts to scan.
 * @returns {{ total: number, categories: Record<string, number> }} Trace summary.
 */
function summarizeRegionalTraces(texts) {
  const categories = {}
  for (const text of texts) {
    const traces = scanRegionalTraces(text)
    for (const [category, lines] of Object.entries(traces)) {
      categories[category] = (categories[category] ?? 0) + lines.length
    }
  }
  const total = Object.values(categories).reduce((sum, count) => sum + count, 0)
  return { total, categories }
}

/**
 * Render trace-gate problems with neutral categories and line numbers only.
 * @param {string} label - Artifact label that never contains a trace.
 * @param {string} text - Text to scan.
 * @returns {string[]} Problem strings.
 */
function regionalTraceProblems(label, text) {
  const traces = scanRegionalTraces(text)
  const problems = []
  for (const [category, lines] of Object.entries(traces)) {
    problems.push(`Forbidden regional trace (category ${category}) in ${label} at line(s) ${summarizeNumbers(lines)} (${lines.length} line(s)). Replace it with a neutral alias.`)
  }
  return problems
}

/**
 * Build the required scrub placeholder returned by start.
 * @returns {object} Scrub checklist with every attestation false.
 */
function scrubTemplate() {
  const template = {}
  for (const [field] of SCRUB_FIELDS) template[field] = false
  template.notes = SCRUB_PLACEHOLDER_NOTE
  return template
}

/**
 * Build the parameter schema for the finalize scrub checklist.
 * @returns {object} JSON Schema object.
 */
function scrubParameterSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    description:
      'Required by action "finalize": attest that every regional-trace category was scrubbed and replaced with neutral aliases. Missing, false, empty-notes, or trace-bearing notes are refused.',
    properties: {
      ...Object.fromEntries(SCRUB_FIELDS.map(([field, label]) => [field, {
        type: 'boolean',
        description: `Set true only after ${label.toLowerCase()} were replaced with neutral aliases or removed.`,
      }])),
      notes: {
        type: 'string',
        description: 'Short English note describing what was neutralized. Must be non-empty and contain no CJK/fullwidth characters or regional traces; do not repeat removed details.',
      },
    },
    required: [...SCRUB_FIELDS.map(([field]) => field), 'notes'],
  }
}

/**
 * Build the output-schema properties for one scrub checklist object.
 * @returns {object} JSON Schema object.
 */
function scrubOutputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      ...Object.fromEntries(SCRUB_FIELDS.map(([field]) => [field, { type: 'boolean' }])),
      notes: { type: 'string' },
    },
    required: [...SCRUB_FIELDS.map(([field]) => field), 'notes'],
  }
}

/* ------------------------------------------------------------------ */
/* Context consistency audit                                          */
/* ------------------------------------------------------------------ */

/** Structured alias prefixes accepted by the shared alias grammar. */
const ALIAS_PREFIXES = [
  'Person', 'Team member', 'Vendor', 'Platform', 'Organization', 'Company',
  'City', 'Region', 'Country', 'Currency', 'Locale', 'Language', 'Holiday',
  'Authority', 'Identifier', 'Account', 'Contact', 'Domain', 'Project',
  'Product', 'File',
]

const ALIAS_SOURCE = `(?:${ALIAS_PREFIXES.map((prefix) => escapeRegExp(prefix).replace(/\s+/g, '\\s+')).join('|')})\\s+[A-Z][A-Z0-9-]*`
const FILE_LABEL_SOURCE = 'file-\\d+(?:~\\d+)?'
const ALIAS_TOKEN_SOURCE = `(?<![A-Za-z0-9-])(?:${ALIAS_SOURCE})(?![A-Za-z0-9-])`
const FILE_TOKEN_SOURCE = `(?<![A-Za-z0-9-])(?:${FILE_LABEL_SOURCE})(?![A-Za-z0-9-])`

/** Placeholder consistency note returned by start. */
const CONSISTENCY_PLACEHOLDER_NOTE = 'Replace this placeholder: run the separate whole-document consistency audit after translation and scrub.'

/**
 * Normalize one matched trace term for canonical grouping. The normalized
 * value is used only inside start; it is never stored or returned.
 * @param {string} term - Raw matched term.
 * @returns {string} Canonical grouping key.
 */
function normalizeTraceTerm(term) {
  return term.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Extract regional-trace matches with terms for ledger construction. This is
 * the only function that returns matched terms; its result is used only inside
 * start and is never stored in BRIEF.json, returned to the caller, or echoed.
 * Longest non-overlapping matches win so a phrase and its substring cannot
 * become two ledger entries for the same source occurrence.
 * @param {string} text - Section body.
 * @returns {Array<{ term: string, category: string, index: number, end: number }>} Matches.
 */
function scanRegionalTraceTerms(text) {
  if (typeof text !== 'string' || text === '') return []
  const candidates = []
  for (const rule of REGIONAL_TRACE_RULES) {
    for (const pattern of rule.patterns) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
      for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
        if (typeof match.index !== 'number' || match[0] === '') continue
        candidates.push({
          term: match[0],
          category: rule.category,
          index: match.index,
          end: match.index + match[0].length,
          length: match[0].length,
        })
      }
    }
  }
  candidates.sort((left, right) => (left.index - right.index) || (right.length - left.length))
  const accepted = []
  for (const candidate of candidates) {
    if (accepted.some((existing) => candidate.index < existing.end && existing.index < candidate.end)) continue
    accepted.push(candidate)
  }
  return accepted
}

/**
 * Build the trace-free T ledger from source sections.
 * @param {object[]} sections - Sections in order.
 * @returns {Array<{ id: string, category: string, sections: string[], occurrences: Record<string, number> }>} Ledger.
 */
function buildTraceLedger(sections) {
  const groups = new Map()
  const ledger = []
  for (const section of sections) {
    for (const match of scanRegionalTraceTerms(section.body)) {
      const key = normalizeTraceTerm(match.term)
      if (key === '') continue
      let entry = groups.get(key)
      if (entry === undefined) {
        entry = { id: `T${ledger.length + 1}`, category: match.category, sections: [], occurrences: {} }
        groups.set(key, entry)
        ledger.push(entry)
      }
      if (!entry.sections.includes(section.id)) entry.sections.push(section.id)
      entry.occurrences[section.id] = (entry.occurrences[section.id] ?? 0) + 1
    }
  }
  return ledger
}

/**
 * Build the start placeholder for the whole-document consistency audit.
 * @param {object[]} traces - Trace-free ledger entries.
 * @returns {object} Consistency template.
 */
function consistencyTemplate(traces) {
  return {
    audited: false,
    sections_reviewed: [],
    alias_stability: false,
    file_references_consistent: false,
    no_unmapped_entities: false,
    notes: '',
    rows: traces.map((trace) => ({
      trace_id: trace.id,
      disposition: 'alias',
      alias: '',
      category: trace.category,
      sections: [...trace.sections],
    })),
  }
}

/**
 * Build one consistency row JSON Schema node.
 * @returns {object} JSON Schema object.
 */
function consistencyRowSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      trace_id: { type: 'string', description: 'T# ledger id, or M# for a model-found entity the scanner missed.' },
      category: { type: 'string', description: 'The ledger category for T rows, or model_identified for M rows.' },
      disposition: { type: 'string', enum: ['alias', 'removed'], description: 'alias when a structured alias is used in every affected section; removed when the entity was dropped entirely.' },
      alias: { type: 'string', description: 'Structured alias from the shared grammar, required for disposition alias; omit or leave empty for removed. Multiple rows may share this alias only when they denote the same entity.' },
      sections: { type: 'array', items: { type: 'string' }, description: 'Exact source section ids affected by this trace or model-found entity.' },
    },
    required: ['trace_id', 'category', 'disposition', 'sections'],
  }
}

/**
 * Build the parameter schema for the required finalize consistency audit.
 * @returns {object} JSON Schema object.
 */
function consistencyParameterSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    description:
      'Required by action "finalize": the model-authored whole-document consistency audit. One row per trace-ledger id, plus M rows for entities the mechanical scanner missed. Every structured alias must be identical in every affected section; source section labels and file labels must match exactly. Multiple T/M rows may share one structured alias only when they denote the same entity, and consistency notes must attest that; the plugin cannot mechanically distinguish one entity described by two source terms from two distinct entities assigned one alias.',
    properties: {
      audited: { type: 'boolean', description: 'True only after a separate full read-through of HANDOFF.md.' },
      sections_reviewed: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every source section id exactly once, in the order reviewed.',
      },
      alias_stability: { type: 'boolean', description: 'True only when every alias is identical everywhere it is used.' },
      file_references_consistent: { type: 'boolean', description: 'True only when every section heading and file reference uses the exact source label.' },
      no_unmapped_entities: { type: 'boolean', description: 'True only when every neutralized entity appears in rows, including scanner-missed ones as M rows.' },
      notes: { type: 'string', description: 'Non-empty English note; no CJK/fullwidth characters and no regional traces. If any alias is shared by multiple rows, state that the shared alias denotes one entity.' },
      rows: {
        type: 'array',
        description: 'One row per T id plus optional M rows for scanner-missed entities.',
        items: consistencyRowSchema(),
      },
    },
    required: ['audited', 'sections_reviewed', 'alias_stability', 'file_references_consistent', 'no_unmapped_entities', 'notes', 'rows'],
  }
}

/**
 * Build the output-schema node for the consistency template returned by start.
 * @returns {object} JSON Schema object.
 */
function consistencyOutputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      audited: { type: 'boolean' },
      sections_reviewed: { type: 'array', items: { type: 'string' } },
      alias_stability: { type: 'boolean' },
      file_references_consistent: { type: 'boolean' },
      no_unmapped_entities: { type: 'boolean' },
      notes: { type: 'string' },
      rows: { type: 'array', items: consistencyRowSchema() },
    },
    required: ['audited', 'sections_reviewed', 'alias_stability', 'file_references_consistent', 'no_unmapped_entities', 'notes', 'rows'],
  }
}

/** System-prompt section advertising the workflow. */
const SYSTEM_PROMPT_TEXT = [
  'Use forward_to_claude only when the user wants to hand off or continue this session or project in Claude.',
  'Call it with action "start" to let the user choose sources and to create the staging folder, translate every section of SOURCE.md into natural technical English, replace identifying regional details with neutral aliases, then perform a separate whole-document consistency audit: review every section again, complete one trace-ledger row per T id, add M rows for scanner-missed entities, keep every structured alias and source section/file label identical across sections, and call finalize with the complete text, one review row per section, the completed scrub checklist, and the consistency audit.',
  'Finalize refuses missing or false scrub attestations, known high-confidence regional traces, and consistency gaps such as alias drift, missing T rows, undeclared aliases, or changed section/file labels; it allows multiple T/M rows to share one structured alias only when they denote the same entity, and it reports only neutral category ids and line numbers and never repeats matched terms.',
  'Never contact Claude and never send any data over a network.',
].join(' ')

/**
 * Register the tool and its system-prompt section.
 * @param {object} ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposeTool = ctx.tools.register(toolDefinition(ctx))
    const disposePrompt = ctx.systemPrompt.section({
      name: 'tool:forward-to-claude',
      order: 2750,
      interpolate: false,
      text: (assembly) => {
        // The registry keys tools by tool name; the row id is probed as a
        // fallback so the section stays gated if the row is renamed.
        const scope = assembly?.scope
        const visible = ctx.tools.get(TOOL_NAME, scope) ?? ctx.tools.get(name, scope)
        return visible === undefined ? '' : SYSTEM_PROMPT_TEXT
      },
    })
    return () => {
      disposePrompt()
      disposeTool()
    }
  })
}

/**
 * Build the plain-object tool definition (no `defineTool` import, so the
 * bundle has no dependency resolution risk).
 * @param {object} ctx - Host plugin context.
 * @returns {object} A registry-ready tool definition.
 */
function toolDefinition(ctx) {
  return {
    name: TOOL_NAME,
    description:
      'Create an English-only handoff bundle from this DeepSeek Harness session or project so a person can paste it into Claude. '
      + 'Workflow: (1) call with action "start": the user is asked which sources to include (the conversation so far, UTF-8 text files under the current working directory, and a handoff note), '
      + 'the tool creates <cwd>/forward-to-claude/<session-id>/handoff-<timestamp>/, writes a staging file SOURCE.md that may contain Chinese, and returns translation instructions, a section summary, a trace-free T ledger, a review template, a required regional-trace scrub template, and a required consistency template. '
      + '(2) Translate every section of SOURCE.md fully and faithfully into natural technical English, replace every identifying regional detail (country/region, city/region, organization/platform, domain/contact, currency/unit, locale/language, political/cultural, and personal-name categories) with a neutral alias, keep [S#] headings with exact source labels and every safe code identifier/command/path/number, then call with action "finalize" with one review row per section, a completed scrub checklist, and a completed consistency audit: '
      + 'the tool mechanically verifies section coverage, exact section/file labels, inline code spans, review completeness, scrub completeness, ledger coverage and alias consistency, the absence of every CJK/fullwidth character, and the absence of known high-confidence regional traces; it reports neutral category ids and line numbers only, never repeating matched terms. '
      + 'Finalize refuses missing, false, empty-notes, or trace-bearing scrub/consistency attestations, alias drift, missing/extra ledger rows, undeclared alias-like tokens, or changed labels; on success it writes and verifies HANDOFF.md, REVIEW.md, and PROMPT.md, deletes the staging files, then writes manifest.json last as the ready marker and returns a ready-to-paste prompt. '
      + '(3) After translation and scrub, perform a separate whole-document consistency audit of HANDOFF.md: complete one row per T id from the ledger returned by start, add M1.. rows for any entity the scanner missed, and use only the shared structured alias grammar (Person A, Team member A, Vendor A, Platform A, City A, Region A, Currency A, File A, and similar) with exact source section labels and file labels; multiple T/M rows may share one structured alias only when they denote the same entity, and the notes must attest that. Finalize rejects alias drift, missing or extra T rows, undeclared alias-like tokens, and changed section/file labels. '
      + '(4) Use action "status" to inspect the latest bundle for this session without changing it. '
      + 'Use this tool only when the user wants to hand off or continue this session or project in Claude. It never contacts Claude and never sends data over a network.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'finalize', 'status'],
          description:
            '"start" creates the handoff folder and asks the user what to include; use it first, when the user wants to hand off or continue this session or project in Claude. '
            + '"finalize" verifies and publishes the English handoff; use it after you have translated SOURCE.md into English, filled one review row per section, completed the regional-trace scrub checklist, and completed the whole-document consistency audit. '
            + '"status" reports the latest handoff bundle for this session without changing anything.',
        },
        handoff_markdown: {
          type: 'string',
          description:
            'The complete English handoff text. Supply it with action "finalize" when you have not already written HANDOFF.md inside the handoff folder; when it is omitted, finalize reads HANDOFF.md instead. '
            + 'Keep every [S#] heading and every inline code span from the source. Ignored by actions "start" and "status".',
        },
        review: {
          type: 'array',
          description:
            'One review row per source section, required by action "finalize". Supply the rows only after comparing each English section against its source. Ignored by actions "start" and "status".',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: {
                type: 'string',
                description: 'Section id exactly as shown in SOURCE.md and BRIEF.json (S1, S2, ...).',
              },
              meaning_preserved: {
                type: 'boolean',
                description: 'True only when you verified that the English section preserves the full meaning of its source section.',
              },
              notes: {
                type: 'string',
                description: 'Short English notes describing what was preserved or what changed. Must be non-empty and free of CJK or fullwidth characters.',
              },
            },
            required: ['id', 'meaning_preserved', 'notes'],
          },
        },
        scrub: {
          ...scrubParameterSchema(),
          description:
            'Required by action "finalize": the regional-trace scrub attestation. Set every boolean true only after replacing the corresponding identifying details with neutral aliases, and give a short English note that contains no regional traces. Missing, false, empty-notes, or trace-bearing attestations are refused. Ignored by actions "start" and "status".',
        },
        consistency: {
          ...consistencyParameterSchema(),
          description:
            'Required by action "finalize": the model-authored whole-document consistency audit. One row per T id from the start ledger plus M rows for scanner-missed entities; structured aliases must be identical in every affected section, section labels and file labels must match exactly, and every alias-like token must be declared. Multiple T/M rows may share one structured alias only when they denote the same entity, and the notes must attest that the shared alias denotes one entity. Missing, false, incomplete, or drifting audits are refused. Ignored by actions "start" and "status".',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: 'Whether the action produced a usable result.' },
          action: { type: 'string', enum: ['start', 'finalize', 'status'], description: 'Action that produced this result.' },
          status: {
            type: 'string',
            description: 'awaiting_translation, ready, incomplete, invalid, none, or nothing_selected, depending on the action.',
          },
          folder: { type: 'string', description: 'Handoff folder path. Absolute when it is ASCII-only.' },
          source_path: { type: 'string', description: 'Path of the staging SOURCE.md written by start.' },
          prompt: { type: 'string', description: 'Ready-to-paste English prompt for Claude, returned by finalize.' },
          message: { type: 'string', description: 'Short English summary for the user.' },
          source_chars: { type: 'integer', description: 'Characters in the staging SOURCE.md.' },
          notes: { type: 'array', items: { type: 'string' }, description: 'Selected sources that contributed nothing, and other non-fatal observations.' },
          sections: {
            type: 'array',
            description: 'One summary row per source section.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                kind: { type: 'string' },
                label: { type: 'string' },
                characters: { type: 'integer' },
              },
              required: ['id', 'kind', 'label'],
            },
          },
          instructions: { type: 'array', items: { type: 'string' }, description: 'Translation, scrub, and consistency instructions returned by start.' },
          review_template: {
            type: 'array',
            description: 'Review rows the caller must fill in and pass to finalize.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                meaning_preserved: { type: 'boolean' },
                notes: { type: 'string' },
              },
              required: ['id', 'meaning_preserved', 'notes'],
            },
          },
          scrub_template: {
            ...scrubOutputSchema(),
            description: 'Deliberately false regional-trace scrub placeholders returned by start; complete them before finalize.',
          },
          trace_ledger: {
            type: 'array',
            description: 'Trace-free T ledger returned by start: ids, neutral categories, source sections, and per-section occurrence counts. No matched terms or mapping back are included.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                category: { type: 'string' },
                sections: { type: 'array', items: { type: 'string' } },
                occurrences: { type: 'object', additionalProperties: true },
              },
              required: ['id', 'category', 'sections', 'occurrences'],
            },
          },
          consistency_template: {
            ...consistencyOutputSchema(),
            description: 'Deliberately false whole-document consistency audit placeholders returned by start; complete them after a separate read-through of HANDOFF.md.',
          },
          regional_trace_summary: {
            type: 'object',
            additionalProperties: true,
            description: 'Neutral category ids and counts for traces found in the staged source; matched terms are never returned.',
          },
          files: { type: 'array', items: { type: 'string' }, description: 'File names present in the handoff folder, returned by finalize and status.' },
        },
        required: ['ok', 'action', 'status'],
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const action = args?.action
      if (action === 'start') return runStart(ctx, exec)
      if (action === 'finalize') return runFinalize(ctx, exec, args)
      if (action === 'status') return runStatus(ctx, exec)
      throw new Error('forward_to_claude requires action "start", "finalize", or "status"; call it again with a supported action.')
    },
  }
}

/* ------------------------------------------------------------------ */
/* start                                                              */
/* ------------------------------------------------------------------ */

/**
 * Ask what to forward, stage it, and return translation instructions.
 * @param {object} ctx - Host plugin context.
 * @param {object} exec - Tool execution context.
 * @returns {Promise<object>} Canonical tool result.
 */
async function runStart(ctx, exec) {
  requireAgent(exec)
  const cwd = await ensureCwd(ctx, exec)
  const agent = exec.agent
  const sessionId = sessionSegment(agent)
  const realCwd = await resolveRealPath(cwd, 'the session working directory')

  const scopeAnswers = await askQuestions(ctx, exec, [scopeQuestion()])
  const scopeAnswer = scopeAnswers.find((answer) => answer?.id === 'scope')
  const selected = Array.isArray(scopeAnswer?.selected)
    ? scopeAnswer.selected.filter((label) => typeof label === 'string')
    : []
  const customScope = typeof scopeAnswer?.custom === 'string' ? scopeAnswer.custom.trim() : ''
  if (selected.length === 0) {
    if (customScope === '') {
      return {
        ok: false,
        action: 'start',
        status: 'nothing_selected',
        message: 'No content was selected, so no handoff folder was created.',
      }
    }
    throw new Error('The scope answer selected no source. Call forward_to_claude with action "start" again and select one or more of the three listed sources.')
  }

  const wanted = new Set()
  for (const label of selected) {
    if (label === OPTION_CONVERSATION) wanted.add('conversation')
    else if (label === OPTION_FILES) wanted.add('files')
    else if (label === OPTION_NOTE) wanted.add('note')
    else throw new Error('The scope answer included an option that is not one of the offered sources. Call forward_to_claude with action "start" again and select from the three listed sources.')
  }

  const filesText = wanted.has('files') ? await askForFileList(ctx, exec) : ''
  const noteText = wanted.has('note') ? await askForNote(ctx, exec) : ''

  const sections = []
  const notes = []
  const fileRecords = []

  if (wanted.has('conversation')) {
    const conversation = collectConversation(agent)
    if (conversation.length === 0) {
      notes.push('Conversation so far was selected, but this session has no user or assistant text messages to forward.')
    } else {
      const chunkCount = Math.ceil(conversation.length / MESSAGES_PER_SECTION)
      for (let offset = 0; offset < conversation.length; offset += MESSAGES_PER_SECTION) {
        const chunk = conversation.slice(offset, offset + MESSAGES_PER_SECTION)
        const body = chunk
          .map((message) => `**${message.role === 'user' ? 'User' : 'Assistant'}:**\n\n${message.text}`)
          .join('\n\n')
        sections.push({
          kind: 'conversation',
          label: `Conversation part ${sections.filter((section) => section.kind === 'conversation').length + 1} of ${chunkCount}`,
          body: normalizeNewlines(body).replace(/\n+$/, ''),
        })
      }
    }
  }

  if (wanted.has('files')) {
    const entries = parseFileList(filesText)
    if (entries.length === 0) {
      throw new Error('The project-files answer did not include any file paths. Provide one UTF-8 text file path per line, relative to the current working directory, or start again without selecting "Text files from this project".')
    }
    if (entries.length > MAX_FILES) {
      throw new Error(`The project-files answer listed ${entries.length} files; at most ${MAX_FILES} files can be forwarded in one handoff. Select fewer files and start again.`)
    }
    const files = await readProjectFiles({ entries, cwd, realCwd })
    for (const file of files) {
      fileRecords.push({ label: file.label, bytes: file.bytes, sha256: file.sha256 })
      sections.push({ kind: 'file', label: file.label, body: normalizeNewlines(file.body) })
    }
  }

  if (wanted.has('note')) {
    sections.push({ kind: 'note', label: 'Handoff note', body: normalizeNewlines(noteText).replace(/\n+$/, '') })
  }

  if (sections.length === 0) {
    throw new Error('No content could be gathered from the selected sources, so no handoff folder was created. Start again and select the conversation, a project file, or a handoff note that contains text.')
  }

  sections.forEach((section, index) => {
    section.id = `S${index + 1}`
    section.code_spans = extractCodeSpans(section.body)
  })

  const regionalTraceSummary = summarizeRegionalTraces(sections.map((section) => section.body))
  const traceLedger = buildTraceLedger(sections)
  const sourceText = renderSource(sections)
  const brief = buildBrief({ sessionId, sections, sourceText, files: fileRecords, regionalTraceSummary, traces: traceLedger })
  const folder = await createHandoffFolder(cwd, realCwd, sessionId, clockNow(ctx))
  const sourcePath = join(folder, 'SOURCE.md')
  await writeAtomic(sourcePath, sourceText)
  await writeJsonAtomic(join(folder, 'BRIEF.json'), brief, 'BRIEF.json')

  const folderDisplay = displayPath(folder, cwd)
  const sourceDisplay = displayPath(sourcePath, cwd)
  const reviewTemplate = sections.map((section) => ({
    id: section.id,
    meaning_preserved: false,
    notes: `Replace this placeholder: confirm every sentence of section ${section.id} is preserved before setting true.`,
  }))
  const scrubs = scrubTemplate()
  const consistency = consistencyTemplate(traceLedger)

  const message = `Created a handoff folder with ${sections.length} section(s) and ${sourceText.length} source characters. The staging file is waiting for an English translation; call action "finalize" with the English handoff, one review row per section, a completed regional-trace scrub checklist, and a completed whole-document consistency audit.`
    + (notes.length > 0 ? ` Notes: ${notes.join(' ')}` : '')

  return {
    ok: true,
    action: 'start',
    status: 'awaiting_translation',
    folder: folderDisplay,
    source_path: sourceDisplay,
    source_chars: sourceText.length,
    message,
    sections: sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      label: section.label,
      characters: section.body.length,
    })),
    ...(notes.length > 0 ? { notes } : {}),
    regional_trace_summary: regionalTraceSummary,
    trace_ledger: traceLedger,
    instructions: [
      `Read the staging file at ${sourceDisplay}.`,
      'Translate every section fully and faithfully into natural technical English; do not summarize, merge, or omit any section.',
      'Keep every [S#] heading exactly as written, including its id and its exact source section label (ASCII file names and file-N labels included).',
      'Preserve safe code identifiers, commands, file paths, and numbers exactly as they appear, including every inline code span listed in BRIEF.json that does not contain a regional trace.',
      'Write only English in the final handoff: no Han, Hiragana, Katakana, Hangul, CJK punctuation, or fullwidth characters anywhere.',
      'Before finalizing, replace every identifying regional detail in the country/region, city/region, organization/platform, domain/contact, currency/unit, locale/language, political/cultural, and personal-name categories with a neutral alias such as Person A, Team member A, Vendor A, Platform A, City A, Region A, Currency A, the target locale, the authorities, or a public holiday.',
      'Use only that structured alias grammar in the handoff; natural names, bare names, and unsupported personal-name forms are outside the grammar and are rejected in the consistency rows. Never include a mapping back to the original identifying details.',
      'If a code identifier, path, URL, or command contains such a regional trace, do not reproduce it: replace it with a neutral alias and do not list it among the preserved code spans. Preserve all technical meaning, numbers, logic, and constraints.',
      'Set every scrub field to true only after completing that replacement, and put a short English note in scrub.notes that does not repeat removed details.',
      'After translation and scrub, do a separate full read-through of HANDOFF.md. Complete the consistency audit: one row per T id from the trace_ledger, with its exact category and source sections; use disposition alias with one structured alias that appears identically in every affected section, or disposition removed with no alias.',
      'Add M1, M2, ... rows for any entity you neutralized that the mechanical scanner missed. Use category model_identified, a structured alias, and the exact source sections where the alias appears.',
      'Multiple T/M rows may share one structured alias only when they denote the same entity (for example a full name and a short name for one entity). In that case, state in consistency.notes that the shared alias denotes one entity. The plugin cannot mechanically distinguish one entity described by two source terms from two distinct entities that were assigned one alias.',
      'Set audited, alias_stability, file_references_consistent, and no_unmapped_entities to true only after the read-through; list every source section id exactly once in sections_reviewed; and write trace-free, CJK-free consistency notes.',
      'Review each section against its source and confirm that its meaning is preserved.',
      'Write the translated text to HANDOFF.md in the same folder, or pass the complete text as handoff_markdown.',
      'The review_template, scrub_template, and consistency_template returned by start contain deliberately false/empty placeholders. finalize rejects every unfinished row or unflagged audit.',
      'Call forward_to_claude with action "finalize" and provide the review rows, the scrub checklist, and the consistency audit in one call.',
      'If anything about the source is unclear, ask the user instead of guessing.',
    ],
    review_template: reviewTemplate,
    scrub_template: scrubs,
    consistency_template: consistency,
  }
}

/**
 * Build the multi-select scope question.
 * @returns {object} Ask-user question.
 */
function scopeQuestion() {
  return {
    id: 'scope',
    header: 'Forward to Claude',
    question: 'What should Claude receive? Select one or more sources.',
    multiSelect: true,
    options: [
      { label: OPTION_CONVERSATION, description: 'All human and assistant text messages in this session.' },
      { label: OPTION_FILES, description: 'UTF-8 text files under the current working directory.' },
      { label: OPTION_NOTE, description: 'A note typed in the answer box; it will be translated too.' },
    ],
  }
}

/**
 * Ask for the project file list and return the free-text answer.
 * @param {object} ctx - Host plugin context.
 * @param {object} exec - Tool execution context.
 * @returns {Promise<string>} Non-empty answer text.
 */
async function askForFileList(ctx, exec) {
  const answers = await askQuestions(ctx, exec, [{
    id: 'files',
    header: 'Project files',
    question: 'List the UTF-8 text files to forward, one per line. Use paths relative to the current working directory; absolute paths inside the working directory are also allowed.',
    multiSelect: false,
  }])
  const answer = answers.find((entry) => entry?.id === 'files')
  const text = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
  if (text === '') {
    throw new Error('The project-files answer was empty. Provide one UTF-8 text file path per line, or start again without selecting "Text files from this project".')
  }
  return text
}

/**
 * Ask for the handoff note and return the free-text answer.
 * @param {object} ctx - Host plugin context.
 * @param {object} exec - Tool execution context.
 * @returns {Promise<string>} Non-empty note text.
 */
async function askForNote(ctx, exec) {
  const answers = await askQuestions(ctx, exec, [{
    id: 'note',
    header: 'Handoff note',
    question: 'Type the handoff note to forward. It will be translated into English.',
    multiSelect: false,
  }])
  const answer = answers.find((entry) => entry?.id === 'note')
  const text = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
  if (text === '') {
    throw new Error('The handoff-note answer was empty. Type the note you want translated, or start again without selecting "A handoff note I write now".')
  }
  return text
}

/**
 * Call the user-question service and validate the answer envelope.
 * @param {object} ctx - Host plugin context.
 * @param {object} exec - Tool execution context.
 * @param {object[]} questions - Questions to ask.
 * @returns {Promise<object[]>} Answer rows.
 */
async function askQuestions(ctx, exec, questions) {
  const result = await ctx.userQuestions.ask({
    questions,
    agent: exec.agent,
    signal: exec.signal,
  })
  if (!Array.isArray(result?.answers)) {
    throw new Error('The question service returned no answers, so no handoff folder was created. Try again.')
  }
  return result.answers
}

/**
 * Read the session transcript and keep user text and assistant text.
 * @param {object} agent - Calling agent.
 * @returns {Array<{ role: 'user'|'assistant', text: string }>} Conversation entries in order.
 */
function collectConversation(agent) {
  const session = agent?.session
  if (session === null || typeof session !== 'object' || typeof session.deriveMessages !== 'function') {
    throw new Error('This session cannot expose its conversation messages, so the conversation source is unavailable. Start again and select project files or a handoff note instead.')
  }
  let messages
  try {
    messages = session.deriveMessages()
  } catch (error) {
    throw new Error('Reading this session transcript failed, so the conversation source is unavailable. Start again and select project files or a handoff note instead.', { cause: error })
  }
  if (!Array.isArray(messages)) {
    throw new Error('This session returned no readable transcript, so the conversation source is unavailable. Start again and select project files or a handoff note instead.')
  }
  const entries = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'assistant' && message.role !== 'user') continue
    if (message.role === 'user' && message.source?.kind !== 'user') continue
    if (!Array.isArray(message.content)) continue
    const text = message.content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text.trim())
      .filter((value) => value !== '')
      .join('\n\n')
    if (text !== '') entries.push({ role: message.role, text })
  }
  const total = entries.reduce((sum, entry) => sum + entry.text.length, 0)
  if (total > MAX_CONVERSATION_CHARS) {
    throw new Error(`The selected conversation contains ${total} characters, which exceeds the ${MAX_CONVERSATION_CHARS}-character cap. Select "Text files from this project" or "A handoff note I write now" to forward a smaller excerpt instead.`)
  }
  return entries
}

/**
 * Split a newline-separated answer into unique, non-empty file entries.
 * @param {string} text - Free-text answer.
 * @returns {string[]} File entries in the order the user listed them.
 */
function parseFileList(text) {
  const seen = new Set()
  const entries = []
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    entries.push(value)
  }
  return entries
}

/**
 * Resolve, validate, and read the selected project files.
 * @param {{ entries: string[], cwd: string, realCwd: string }} options - Inputs.
 * @returns {Promise<Array<{ label: string, bytes: number, sha256: string, body: string }>>} Files in order.
 */
async function readProjectFiles({ entries, cwd, realCwd }) {
  const resolvedEntries = []
  let totalBytes = 0
  for (let index = 0; index < entries.length; index += 1) {
    const input = entries[index]
    const resolved = isAbsolute(input) ? resolve(input) : resolve(cwd, input)
    let real
    try {
      real = await realpath(resolved)
    } catch {
      throw new Error(`File ${describeEntry(input, index)} does not exist or cannot be resolved under the current working directory.`)
    }
    if (!isInside(realCwd, real)) {
      throw new Error(`File ${describeEntry(input, index)} is outside the current working directory. Only files under the session working directory can be forwarded.`)
    }
    const stats = await stat(real)
    if (stats.isDirectory()) {
      throw new Error(`File ${describeEntry(input, index)} is a directory. List individual text files instead.`)
    }
    if (!stats.isFile()) {
      throw new Error(`File ${describeEntry(input, index)} is not a regular file. Only regular UTF-8 text files can be forwarded.`)
    }
    totalBytes += stats.size
    resolvedEntries.push({ real, stats, label: describeEntry(input, index) })
  }
  if (totalBytes > MAX_TOTAL_FILE_BYTES) {
    throw new Error(`The selected files total ${totalBytes} bytes, which exceeds the ${MAX_TOTAL_FILE_BYTES}-byte total cap. Select fewer or smaller files and start again.`)
  }
  const files = []
  const usedLabels = new Set()
  let readBytes = 0
  for (const entry of resolvedEntries) {
    if (entry.stats.size > MAX_FILE_BYTES) {
      throw new Error(`File ${entry.label} is ${entry.stats.size} bytes, which exceeds the ${MAX_FILE_BYTES}-byte per-file cap. Select a smaller file and start again.`)
    }
    const buffer = await readFile(entry.real)
    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error(`File ${entry.label} changed while it was being read and now exceeds the ${MAX_FILE_BYTES}-byte per-file cap. Select a smaller file and start again.`)
    }
    readBytes += buffer.length
    if (readBytes > MAX_TOTAL_FILE_BYTES) {
      throw new Error(`The selected files total more than ${MAX_TOTAL_FILE_BYTES} bytes. Select fewer or smaller files and start again.`)
    }
    if (buffer.includes(0)) {
      throw new Error(`File ${entry.label} contains a NUL byte, so it is not a UTF-8 text file.`)
    }
    const text = buffer.toString('utf8')
    if (text.includes('\uFFFD')) {
      throw new Error(`File ${entry.label} is not valid UTF-8 text. Only valid UTF-8 text files can be forwarded.`)
    }
    let label = toPosix(relative(realCwd, entry.real))
    if (!isAsciiText(label) || hasRegionalTrace(label)) label = `file-${files.length + 1}`
    let unique = label
    let suffix = 2
    while (usedLabels.has(unique)) {
      unique = `${label}~${suffix}`
      suffix += 1
    }
    usedLabels.add(unique)
    files.push({
      label: unique,
      bytes: buffer.length,
      sha256: hashBuffer(buffer),
      body: normalizeNewlines(text),
    })
  }
  return files
}

/**
 * Human-readable identity for one file entry that never echoes CJK text or a
 * regional trace. Values that would echo a matched term are described by index.
 * @param {string} input - The entry as the user wrote it.
 * @param {number} index - Zero-based entry index.
 * @returns {string} ASCII-safe, trace-free description.
 */
function describeEntry(input, index) {
  return isAsciiText(input) && input.length <= 120 && !hasRegionalTrace(input)
    ? `"${input}"`
    : `entry ${index + 1}`
}

/* ------------------------------------------------------------------ */
/* finalize                                                           */
/* ------------------------------------------------------------------ */

/**
 * Verify the English handoff and publish the final bundle.
 * @param {object} ctx - Host plugin context.
 * @param {object} exec - Tool execution context.
 * @param {object} args - Tool arguments.
 * @returns {Promise<object>} Canonical tool result.
 */
async function runFinalize(ctx, exec, args) {
  requireAgent(exec)
  const cwd = await ensureCwd(ctx, exec)
  const sessionId = sessionSegment(exec.agent)
  const latest = await findLatestBundle(cwd, sessionId)
  if (latest === undefined) {
    throw new Error('No forward-to-claude handoff bundle exists for this session. Call forward_to_claude with action "start" first.')
  }
  const realCwd = await resolveRealPath(cwd, 'the session working directory')
  const realFolder = await resolveRealPath(latest.folder, 'the latest handoff folder')
  if (!isInside(realCwd, realFolder)) {
    throw new Error('The latest handoff folder resolves outside the session working directory, so it was not opened.')
  }
  if (activeFinalizations.has(realFolder)) {
    throw new Error('The latest handoff bundle is already being finalized. Retry when the current call finishes.')
  }
  activeFinalizations.add(realFolder)
  try {
    return await finalizeBundle(ctx, args, { cwd, realCwd, folder: latest.folder, realFolder, sessionId })
  } finally {
    activeFinalizations.delete(realFolder)
  }
}

async function finalizeBundle(ctx, args, { cwd, realCwd, folder, realFolder, sessionId }) {
  const recoveryPath = stagingSnapshotPath(realFolder)
  const recoveryDirectory = dirname(recoveryPath)
  const recoveryName = basename(recoveryPath)

  // Preflight before any write: an unexpected entry, symlink, or non-regular
  // known file must leave the staging files untouched.
  await preflightHandoffFolder(folder, realFolder, realCwd)
  const initialState = await inspectBundleState(folder, realFolder, realCwd)
  const recoveryInfo = await bundleFileInfo(recoveryDirectory, recoveryDirectory, realCwd, recoveryName)
  if (initialState.status === 'ready') {
    if (recoveryInfo.regular) await rm(recoveryPath, { force: true })
    throw new Error('The latest handoff bundle is already finalized (status ready). Use action "status" to inspect it, or action "start" to create a new bundle.')
  }
  if (initialState.status === 'incomplete' && !recoveryInfo.exists) {
    throw new Error('The latest handoff bundle is incomplete, so finalize refused to treat it as ready. Create a new bundle with action "start" or repair the latest folder.')
  }
  if (initialState.status === 'invalid') {
    throw new Error('The latest handoff bundle has an invalid manifest or unsafe bundle file, so finalize refused to treat it as ready. Create a new bundle with action "start" or repair the latest folder.')
  }

  let sourceText
  let briefText
  let existingHandoff
  if (recoveryInfo.exists) {
    try {
      const snapshot = JSON.parse(await readBundleFile(recoveryDirectory, recoveryDirectory, realCwd, recoveryName))
      if (typeof snapshot?.sourceText !== 'string' || typeof snapshot.briefText !== 'string'
        || (snapshot.existingHandoff !== null && typeof snapshot.existingHandoff !== 'string')) {
        throw new Error('Invalid recovery snapshot fields.')
      }
      sourceText = snapshot.sourceText
      briefText = snapshot.briefText
      existingHandoff = snapshot.existingHandoff
    } catch (error) {
      throw new Error('The interrupted handoff staging snapshot could not be read. Inspect it before retrying.', { cause: error })
    }
  } else {
    sourceText = await readBundleFile(folder, realFolder, realCwd, 'SOURCE.md')
    briefText = await readBundleFile(folder, realFolder, realCwd, 'BRIEF.json')
    const handoffInfo = await bundleFileInfo(folder, realFolder, realCwd, 'HANDOFF.md')
    existingHandoff = handoffInfo.exists ? await readBundleFile(folder, realFolder, realCwd, 'HANDOFF.md') : null
  }
  const brief = parseBriefText(briefText)

  const supplied = typeof args?.handoff_markdown === 'string' ? args.handoff_markdown : ''
  let handoff = existingHandoff
  if (supplied.trim() !== '') {
    handoff = supplied
  } else {
    if (existingHandoff === null) {
      throw new Error('No English handoff was provided. Pass the complete text as handoff_markdown, or write it to HANDOFF.md inside the handoff folder first.')
    }
    handoff = existingHandoff
    if (handoff.trim() === '') {
      throw new Error('HANDOFF.md is empty. Write the complete English handoff text and call action "finalize" again.')
    }
  }

  const review = args?.review
  const scrub = args?.scrub
  const consistency = args?.consistency
  validateHandoff({ brief, handoff, review, scrub, consistency })

  const folderRef = folderReference(folder, cwd)
  const reviewText = renderReview({ brief, handoff, review, scrub, consistency })
  const manifest = buildManifest({ brief, sessionId, handoff, folderRef, scrub, consistency })
  const prompt = renderPrompt(folderRef)
  const promptDocument = renderPromptDocument(prompt)
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`

  // Fail closed: validate every in-memory artifact string and planned name
  // before any final artifact is written.
  const writtenArtifacts = [
    ['HANDOFF.md', handoff],
    ['REVIEW.md', reviewText],
    ['PROMPT.md', promptDocument],
    ['manifest.json', manifestText],
  ]
  for (const [artifactName, artifactText] of writtenArtifacts) {
    assertArtifactTraceFree(artifactName, artifactText)
  }
  if (/[^\x00-\x7F]/.test(manifestText)) {
    throw new Error('The English handoff did not pass the final artifact gate. manifest.json would contain non-ASCII metadata characters.')
  }
  if (!isAsciiText(folderRef.path) || hasRegionalTrace(folderRef.path)) {
    throw new Error('The English handoff did not pass the final artifact gate. The reported folder path contains a forbidden character or regional trace.')
  }
  for (const artifactName of FINAL_ARTIFACTS) {
    if (!isAsciiText(artifactName) || hasRegionalTrace(artifactName)) {
      throw new Error('The English handoff did not pass the final artifact gate. A planned artifact name contains a forbidden character or regional trace.')
    }
  }

  // Keep the original staging outside the shareable bundle through the commit.
  // If this process exits, the next finalize can load the same snapshot.
  if (!recoveryInfo.exists) {
    await writeAtomic(recoveryPath, JSON.stringify({ sourceText, briefText, existingHandoff }), { mode: 0o600 })
  }
  const writeOptions = { temporaryDirectory: recoveryDirectory }
  const pendingArtifacts = writtenArtifacts.slice(0, -1)
  const pendingNames = new Set(pendingArtifacts.map(([artifactName]) => artifactName))
  try {
    for (const [artifactName, content] of pendingArtifacts) {
      if (artifactName === 'HANDOFF.md' && supplied.trim() === '' && !recoveryInfo.exists) continue
      await writeAtomic(join(folder, artifactName), content, writeOptions)
    }
    for (const stagingName of STAGING_FILES) {
      await rm(join(folder, stagingName), { force: true })
    }
    await ctx?.forwardToClaudeTestHooks?.beforeManifest?.({ folder })
    await preflightHandoffFolder(folder, realFolder, realCwd, pendingNames)
    for (const [artifactName, expected] of pendingArtifacts) {
      const actual = await readBundleFile(folder, realFolder, realCwd, artifactName)
      if (actual !== expected) throw new Error(`The written ${artifactName} did not match the verified content.`)
    }
    // The manifest becomes visible only after the bundle and the pending
    // manifest have been verified. Its atomic rename commits the publication.
    await writeAtomic(join(folder, 'manifest.json'), manifestText, { ...writeOptions, verify: true })
  } catch (error) {
    try {
      await writeAtomic(join(folder, 'SOURCE.md'), sourceText, { ...writeOptions, mode: 0o600 })
      await writeAtomic(join(folder, 'BRIEF.json'), briefText, { ...writeOptions, mode: 0o600 })
      if (existingHandoff === null) await rm(join(folder, 'HANDOFF.md'), { force: true })
      else await writeAtomic(join(folder, 'HANDOFF.md'), existingHandoff, writeOptions)
      await rm(join(folder, 'REVIEW.md'), { force: true })
      await rm(join(folder, 'PROMPT.md'), { force: true })
      await rm(recoveryPath, { force: true })
    } catch (rollbackError) {
      throw new Error('Publication failed and rollback could not finish. Retry finalize to use the saved staging snapshot.', {
        cause: new AggregateError([error, rollbackError]),
      })
    }
    throw new Error('The handoff could not be published safely. SOURCE.md and BRIEF.json were restored for retry.', { cause: error })
  }

  let message = `The English handoff bundle is ready at ${folderRef.path}.`
  try {
    await rm(recoveryPath, { force: true })
  } catch {
    message += ' The private staging snapshot remains. Call finalize again to retry its cleanup.'
  }
  return {
    ok: true,
    action: 'finalize',
    status: 'ready',
    folder: folderRef.path,
    files: [...FINAL_ARTIFACTS],
    message,
    prompt,
  }
}

/**
 * Assert one planned artifact is trace-free and CJK-free before it is written
 * or accepted after writing. Reports neutral categories and line numbers only.
 * @param {string} artifactName - Fixed safe artifact name.
 * @param {string} artifactText - Artifact content.
 */
function assertArtifactTraceFree(artifactName, artifactText) {
  const problems = []
  const cjkLines = scanCjkLines(artifactText)
  if (cjkLines.length > 0) {
    problems.push(`Forbidden CJK or fullwidth characters in ${artifactName} at line(s) ${summarizeNumbers(cjkLines)} (${cjkLines.length} character(s)).`)
  }
  problems.push(...regionalTraceProblems(artifactName, artifactText))
  if (problems.length > 0) {
    throw new Error(`The English handoff did not pass the final artifact gate. ${problems.join(' ')}`)
  }
}

/**
 * Validate and shape-check parsed BRIEF.json text.
 * @param {string} text - UTF-8 brief text.
 * @returns {object} Parsed brief.
 */
function parseBriefText(text) {
  let brief
  try {
    brief = JSON.parse(text)
  } catch (error) {
    throw new Error('BRIEF.json is not valid JSON. The staging folder may be damaged; call action "start" to create a new bundle.', { cause: error })
  }
  if (brief === null || typeof brief !== 'object' || Array.isArray(brief)) {
    throw new Error('BRIEF.json is not a JSON object. The staging folder may be damaged; call action "start" to create a new bundle.')
  }
  if (!Array.isArray(brief.sections) || brief.sections.length === 0) {
    throw new Error('BRIEF.json lists no source sections. The staging folder may be damaged; call action "start" to create a new bundle.')
  }
  for (const section of brief.sections) {
    if (section === null || typeof section !== 'object') {
      throw new Error('BRIEF.json contains an invalid section entry. The staging folder may be damaged; call action "start" to create a new bundle.')
    }
    if (typeof section.id !== 'string' || !/^S\d+$/.test(section.id)) {
      throw new Error('BRIEF.json contains an invalid section id. The staging folder may be damaged; call action "start" to create a new bundle.')
    }
    if (typeof section.label !== 'string' || !isAsciiText(section.label)) {
      throw new Error(`BRIEF.json contains an invalid label for section ${section.id}. The staging folder may be damaged; call action "start" to create a new bundle.`)
    }
    if (hasRegionalTrace(section.label)) {
      throw new Error(`BRIEF.json contains a section label with a forbidden regional trace. The staging folder may be damaged; call action "start" to create a new bundle.`)
    }
    if (!Array.isArray(section.code_spans) || section.code_spans.some((span) => typeof span !== 'string' || !isAsciiText(span))) {
      throw new Error(`BRIEF.json contains invalid code spans for section ${section.id}. The staging folder may be damaged; call action "start" to create a new bundle.`)
    }
  }
  if (typeof brief.source_chars !== 'number' || !Number.isFinite(brief.source_chars)) {
    throw new Error('BRIEF.json is missing its source character count. The staging folder may be damaged; call action "start" to create a new bundle.')
  }
  if (typeof brief.source_sha256 !== 'string' || brief.source_sha256 === '') {
    throw new Error('BRIEF.json is missing its source checksum. The staging folder may be damaged; call action "start" to create a new bundle.')
  }
  if (!Array.isArray(brief.files)) {
    throw new Error('BRIEF.json is missing its file list. The staging folder may be damaged; call action "start" to create a new bundle.')
  }
  if (brief.regional_traces !== undefined) {
    const summary = brief.regional_traces
    if (summary === null || typeof summary !== 'object' || Array.isArray(summary)
      || typeof summary.total !== 'number' || summary.categories === null
      || typeof summary.categories !== 'object' || Array.isArray(summary.categories)) {
      throw new Error('BRIEF.json contains an invalid regional-trace summary. The staging folder may be damaged; call action "start" to create a new bundle.')
    }
  }
  if (brief.traces !== undefined) {
    if (!Array.isArray(brief.traces)) {
      throw new Error('BRIEF.json contains an invalid trace ledger. The staging folder may be damaged; call action "start" to create a new bundle.')
    }
    const sectionIds = new Set(brief.sections.map((section) => section.id))
    for (const trace of brief.traces) {
      const validShape = trace !== null && typeof trace === 'object' && !Array.isArray(trace)
        && typeof trace.id === 'string' && /^T\d+$/.test(trace.id)
        && typeof trace.category === 'string' && REGIONAL_TRACE_CATEGORIES.includes(trace.category)
        && Array.isArray(trace.sections) && trace.sections.length > 0
        && trace.sections.every((id) => typeof id === 'string' && sectionIds.has(id))
        && trace.occurrences !== null && typeof trace.occurrences === 'object' && !Array.isArray(trace.occurrences)
        && Object.entries(trace.occurrences).every(([id, count]) => sectionIds.has(id) && Number.isInteger(count) && count > 0)
      if (!validShape) {
        throw new Error('BRIEF.json contains an invalid trace-ledger entry. The staging folder may be damaged; call action "start" to create a new bundle.')
      }
    }
  }
  return brief
}

/**
 * Whether a value is one structured alias from the shared grammar.
 * @param {string} value - Candidate alias.
 * @returns {boolean} True when it matches the grammar and is trace-free.
 */
function isStructuredAlias(value) {
  if (typeof value !== 'string' || value === '') return false
  if (hasCjk(value) || hasRegionalTrace(value)) return false
  return new RegExp(`^(?:${ALIAS_SOURCE})$`, 'u').test(value)
}

/**
 * Whether a value is a bundle file label token (`file-N` or `file-N~K`).
 * @param {string} value - Candidate token.
 * @returns {boolean} True when it matches the file-label form.
 */
function isFileLabelToken(value) {
  return typeof value === 'string' && new RegExp(`^${FILE_LABEL_SOURCE}$`, 'u').test(value)
}

/**
 * Collect every alias-like token from text, without returning trace terms.
 * @param {string} text - Text to scan.
 * @returns {string[]} Unique alias tokens.
 */
function collectAliasTokens(text) {
  const tokens = new Set()
  for (const match of text.matchAll(new RegExp(ALIAS_TOKEN_SOURCE, 'gu'))) tokens.add(match[0])
  return [...tokens]
}

/**
 * Collect every file-label token from text.
 * @param {string} text - Text to scan.
 * @returns {string[]} Unique file-label tokens.
 */
function collectFileTokens(text) {
  const tokens = new Set()
  for (const match of text.matchAll(new RegExp(FILE_TOKEN_SOURCE, 'gu'))) tokens.add(match[0])
  return [...tokens]
}

/**
 * Parse HANDOFF.md into `[S#]` sections, keeping each exact heading label.
 * @param {string} handoff - Handoff text.
 * @returns {Array<{ id: string, label: string, line: number, body: string }>} Sections in order.
 */
function parseHandoffSections(handoff) {
  const lines = handoff.split('\n')
  const sections = []
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^#{1,6}\s*\[(S\d+)\]\s*(.*?)\s*$/.exec(lines[index])
    if (match !== null) {
      if (current !== null) sections.push(current)
      current = { id: match[1], label: match[2], line: index + 1, bodyLines: [] }
      continue
    }
    if (current !== null) current.bodyLines.push(lines[index])
  }
  if (current !== null) sections.push(current)
  return sections.map((section) => ({
    id: section.id,
    label: section.label,
    line: section.line,
    body: section.bodyLines.join('\n'),
  }))
}

/**
 * Validate the model-authored whole-document consistency audit. Problems never
 * echo trace terms or natural aliases; only safe ids and neutral categories are
 * reported.
 * @param {{ brief: object, handoff: string, parsedSections: object[], consistency: unknown, problems: string[] }} input - Audit inputs.
 */
function validateConsistency({ brief, handoff, parsedSections, consistency, problems }) {
  const expectedIds = brief.sections.map((section) => section.id)
  const sectionBodies = new Map(parsedSections.map((section) => [section.id, section.body]))
  const ledger = Array.isArray(brief.traces) ? brief.traces : []
  const ledgerById = new Map(ledger.map((trace) => [trace.id, trace]))

  // File-label consistency is independent of whether the consistency object is
  // present: every file token must be known and every known label must appear.
  const knownFileLabels = Array.isArray(brief.files) ? brief.files.map((file) => file.label) : []
  for (const token of collectFileTokens(handoff)) {
    if (!knownFileLabels.includes(token)) {
      problems.push('An unknown or renamed file label token appears in HANDOFF. Use only the file labels recorded for this bundle.')
    }
  }
  for (const label of knownFileLabels) {
    if (!handoff.includes(label)) {
      problems.push(`The bundle file label ${label} does not appear in HANDOFF. Keep every source file label exactly.`)
    }
  }

  if (consistency === null || typeof consistency !== 'object' || Array.isArray(consistency)) {
    problems.push('consistency is required for finalize: supply the completed whole-document audit with one row per T id, optional M rows, and all flags true.')
    return
  }

  if (consistency.audited !== true) problems.push('consistency.audited must be true after the separate full read-through of HANDOFF.')
  for (const field of ['alias_stability', 'file_references_consistent', 'no_unmapped_entities']) {
    if (consistency[field] !== true) problems.push(`consistency.${field} must be true after the whole-document audit.`)
  }

  // Sections reviewed: exactly every source section id once.
  const reviewed = consistency.sections_reviewed
  const seenReviewed = new Map()
  if (!Array.isArray(reviewed)) {
    problems.push('consistency.sections_reviewed must list every source section id exactly once.')
  } else {
    for (const id of reviewed) {
      if (typeof id !== 'string') {
        problems.push('consistency.sections_reviewed may contain only source section ids.')
        continue
      }
      if (!expectedIds.includes(id)) {
        problems.push(`consistency.sections_reviewed contains an unknown section id ${safeDisplayId(id)}.`)
      }
      seenReviewed.set(id, (seenReviewed.get(id) ?? 0) + 1)
    }
    for (const [id, count] of seenReviewed) {
      if (count > 1) problems.push(`consistency.sections_reviewed lists section ${safeDisplayId(id)} ${count} times; exactly one is required.`)
    }
    const missingReviewed = expectedIds.filter((id) => !seenReviewed.has(id))
    if (missingReviewed.length > 0) problems.push(`consistency.sections_reviewed is missing: ${missingReviewed.join(', ')}.`)
    if (reviewed.length !== expectedIds.length && missingReviewed.length === 0) {
      problems.push('consistency.sections_reviewed must contain exactly every source section id, with no extras.')
    }
  }

  // Notes: non-empty, CJK-free, trace-free.
  if (typeof consistency.notes !== 'string' || consistency.notes.trim() === '') {
    problems.push('consistency.notes must be a non-empty English note describing the whole-document audit.')
  } else {
    if (hasCjk(consistency.notes)) problems.push('consistency.notes contains forbidden CJK or fullwidth characters.')
    const noteTraces = scanRegionalTraces(consistency.notes)
    const noteCategories = Object.keys(noteTraces)
    if (noteCategories.length > 0) {
      const noteLines = noteCategories.map((category) => `category ${category} at line(s) ${summarizeNumbers(noteTraces[category])}`).join('; ')
      problems.push(`consistency.notes contains a forbidden regional trace (${noteLines}). Do not repeat removed identifying details in the notes.`)
    }
  }

  // Multiple T/M rows may share one structured alias when they denote one
  // entity (for example a full name and a short name). The plugin cannot
  // decide entity identity mechanically; the consistency notes attest it.
  const declaredAliases = new Set()
  const tRows = new Map()
  const mRows = new Map()

  if (!Array.isArray(consistency.rows)) {
    problems.push('consistency.rows must be an array with one row per trace id, plus optional M rows.')
    return
  }

  consistency.rows.forEach((row, index) => {
    const rowName = `Consistency row ${index + 1}`
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      problems.push(`${rowName} must be an object.`)
      return
    }
    if (typeof row.trace_id !== 'string' || row.trace_id === '') {
      problems.push(`${rowName} is missing a trace_id.`)
      return
    }
    const traceId = row.trace_id
    const isTraceRow = /^T\d+$/.test(traceId)
    const isModelRow = /^M\d+$/.test(traceId)
    if (!isTraceRow && !isModelRow) {
      problems.push(`${rowName} has an invalid trace_id; use T# for ledger traces and M# for model-found entities.`)
      return
    }
    if (typeof row.category !== 'string' || typeof row.disposition !== 'string' || !Array.isArray(row.sections)) {
      problems.push(`${rowName} must include category, disposition, and a sections array.`)
      return
    }
    if (row.disposition !== 'alias' && row.disposition !== 'removed') {
      problems.push(`${rowName} disposition must be "alias" or "removed".`)
      return
    }
    const sections = row.sections
    const validSectionIds = sections.every((id) => typeof id === 'string' && expectedIds.includes(id))
    if (!validSectionIds || new Set(sections).size !== sections.length) {
      problems.push(`${rowName} sections must be unique valid source section ids.`)
      return
    }

    if (isTraceRow) {
      const ledgerTrace = ledgerById.get(traceId)
      if (ledgerTrace === undefined) {
        problems.push(`${rowName} names trace ${traceId}, which is not in this bundle's ledger.`)
        tRows.set(traceId, [...(tRows.get(traceId) ?? []), row])
        return
      }
      tRows.set(traceId, [...(tRows.get(traceId) ?? []), row])
      if (row.category !== ledgerTrace.category) {
        problems.push(`${traceId} category must be ${ledgerTrace.category}.`)
      }
      const expectedSections = [...ledgerTrace.sections].sort()
      const actualSections = [...sections].sort()
      if (expectedSections.length !== actualSections.length || expectedSections.some((id, position) => id !== actualSections[position])) {
        problems.push(`${traceId} sections must exactly match the ledger sections: ${ledgerTrace.sections.join(', ')}.`)
      }
      if (row.disposition === 'removed') {
        if (typeof row.alias === 'string' && row.alias !== '') {
          problems.push(`${traceId} uses disposition "removed" but still declares an alias; removed rows must not use an alias.`)
        }
        // The global trace gate already requires zero traces anywhere in
        // HANDOFF, so a removed entity is necessarily absent from the text.
      } else {
        if (!isStructuredAlias(row.alias)) {
          problems.push(`${traceId} needs a structured alias from the shared grammar (for example Person A or City A).`)
        } else {
          declaredAliases.add(row.alias)
          for (const sectionId of ledgerTrace.sections) {
            const body = sectionBodies.get(sectionId) ?? ''
            if (!body.includes(row.alias)) {
              problems.push(`${traceId} alias does not appear in affected section ${sectionId}; use the same structured alias in every affected section.`)
            }
          }
        }
      }
    } else {
      mRows.set(traceId, [...(mRows.get(traceId) ?? []), row])
      if (row.category !== 'model_identified') problems.push(`${traceId} category must be model_identified.`)
      if (row.disposition !== 'alias') problems.push(`${traceId} model-added entities must use disposition "alias".`)
      if (sections.length === 0) problems.push(`${traceId} must list at least one source section.`)
      if (!isStructuredAlias(row.alias)) {
        problems.push(`${traceId} needs a structured alias from the shared grammar.`)
      } else {
        declaredAliases.add(row.alias)
        for (const sectionId of sections) {
          const body = sectionBodies.get(sectionId) ?? ''
          if (!body.includes(row.alias)) {
            problems.push(`${traceId} alias does not appear in listed section ${sectionId}; add the section or use the alias there.`)
          }
        }
      }
    }
  })

  // Every T id exactly once; no extra T rows.
  for (const trace of ledger) {
    const rows = tRows.get(trace.id) ?? []
    if (rows.length === 0) problems.push(`Missing consistency row for trace ${trace.id}.`)
    else if (rows.length > 1) problems.push(`Trace ${trace.id} has ${rows.length} consistency rows; exactly one is required.`)
  }
  for (const traceId of tRows.keys()) {
    if (!ledgerById.has(traceId)) problems.push(`Consistency row names unknown trace ${traceId}.`)
  }
  for (const [modelId, rows] of mRows) {
    if (rows.length > 1) problems.push(`Model entity ${modelId} has ${rows.length} consistency rows; ids must be unique.`)
  }

  // Every alias-like token in HANDOFF must be declared as an alias row.
  for (const token of collectAliasTokens(handoff)) {
    if (!declaredAliases.has(token)) {
      problems.push('HANDOFF contains an undeclared alias-like token. Declare it as an alias row or remove the alias form.')
    }
  }
  // Every declared alias must occur somewhere and (checked above) in each
  // affected section.
  for (const alias of declaredAliases) {
    if (!handoff.includes(alias)) problems.push('A declared alias does not occur anywhere in HANDOFF.')
  }
}

function validateHandoff({ brief, handoff, review, scrub, consistency }) {
  const problems = []
  const sections = brief.sections
  const expectedIds = sections.map((section) => section.id)
  const expectedById = new Map(sections.map((section) => [section.id, section]))

  const parsedSections = parseHandoffSections(handoff)
  const headingCounts = new Map()
  for (const parsed of parsedSections) {
    const expected = expectedById.get(parsed.id)
    if (expected === undefined) {
      problems.push(`HANDOFF contains a heading for unknown section ${safeDisplayId(parsed.id)}.`)
      continue
    }
    headingCounts.set(parsed.id, (headingCounts.get(parsed.id) ?? 0) + 1)
    if (parsed.label !== expected.label) {
      problems.push(`Section ${parsed.id} heading label must exactly match the source label "${expected.label}".`)
    }
  }
  for (const [id, count] of headingCounts) {
    if (count > 1) problems.push(`Section ${id} has ${count} headings; exactly one is required.`)
  }
  const missingSections = expectedIds.filter((id) => !headingCounts.has(id))
  if (missingSections.length > 0) {
    problems.push(`Missing section heading(s): ${missingSections.join(', ')}. Keep one Markdown heading like "## [S1] Label" for every source section.`)
  }

  const missingSpans = []
  for (const section of sections) {
    for (const span of section.code_spans) {
      // A source code span that carries a trace is exempt: it must be replaced
      // instead of reproduced.
      if (hasRegionalTrace(span)) continue
      if (!handoff.includes(span) && !missingSpans.includes(span)) missingSpans.push(span)
    }
  }
  if (missingSpans.length > 0) {
    const rendered = missingSpans
      .map((span) => (hasRegionalTrace(span) ? 'a protected code span' : `\`${span}\``))
      .join(', ')
    problems.push(`Missing inline code span(s): ${rendered}. Preserve every safe code identifier, command, path, and number verbatim; replace any trace-bearing span instead.`)
  }

  const cjkTextLines = scanCjkLines(handoff)
  if (cjkTextLines.length > 0) {
    problems.push(`Forbidden CJK or fullwidth characters in HANDOFF at line(s) ${summarizeNumbers(cjkTextLines)} (${cjkTextLines.length} character(s)). Translate all of them into English.`)
  }
  problems.push(...regionalTraceProblems('HANDOFF', handoff))

  if (!Array.isArray(review)) {
    problems.push('review must be an array with exactly one row per source section, and it was missing or not an array.')
  } else {
    if (review.length !== sections.length) {
      problems.push(`review must contain exactly ${sections.length} row(s), one per source section; received ${review.length}.`)
    }
    const seen = new Map()
    review.forEach((row, index) => {
      const rowName = `Review row ${index + 1}`
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        problems.push(`${rowName} must be an object with id, meaning_preserved, and notes.`)
        return
      }
      if (typeof row.id !== 'string' || row.id === '') {
        problems.push(`${rowName} is missing a string id.`)
        return
      }
      const id = row.id
      const safeId = safeDisplayId(id)
      seen.set(id, (seen.get(id) ?? 0) + 1)
      if (!expectedIds.includes(id)) {
        problems.push(`${rowName} names a section that is not in this bundle. Use the S# ids from SOURCE.md.`)
      }
      if (row.meaning_preserved !== true) {
        problems.push(`Section ${safeId} must set meaning_preserved to true after you verify its translation.`)
      }
      if (typeof row.notes !== 'string' || row.notes.trim() === '') {
        problems.push(`Section ${safeId} needs non-empty notes describing what was preserved.`)
      } else if (hasCjk(row.notes)) {
        problems.push(`Review notes for section ${safeId} contain forbidden CJK or fullwidth characters.`)
      } else {
        const noteTraces = scanRegionalTraces(row.notes)
        const noteTraceCategories = Object.keys(noteTraces)
        if (noteTraceCategories.length > 0) {
          const noteTraceLines = noteTraceCategories.map((category) => `category ${category} at line(s) ${summarizeNumbers(noteTraces[category])}`).join('; ')
          problems.push(`Review notes for section ${safeId} contain a forbidden regional trace (${noteTraceLines}). Remove the identifying detail from the notes.`)
        }
      }
    })
    for (const [id, count] of seen) {
      if (count > 1) problems.push(`Section ${safeDisplayId(id)} has ${count} review rows; exactly one is required.`)
    }
    const missingRows = expectedIds.filter((id) => !seen.has(id))
    if (missingRows.length > 0) {
      problems.push(`Missing review row(s) for: ${missingRows.join(', ')}.`)
    }
  }

  validateScrubChecklist(scrub, problems)
  validateConsistency({ brief, handoff, parsedSections, consistency, problems })

  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_PROBLEMS)
    const hidden = problems.length - shown.length
    const lines = [
      `The English handoff did not pass the fidelity, scrub, or consistency gate. ${problems.length} problem(s) found:`,
      ...shown.map((problem) => `- ${problem}`),
    ]
    if (hidden > 0) lines.push(`- (and ${hidden} more problem(s) not shown)`)
    throw new Error(lines.join('\n'))
  }
}

/**
 * Validate the required scrub checklist. Missing, false, empty-notes, CJK, or
 * trace-bearing notes are reported without echoing any matched term.
 * @param {unknown} scrub - Caller-supplied checklist.
 * @param {string[]} problems - Problem accumulator.
 */
function validateScrubChecklist(scrub, problems) {
  if (scrub === null || typeof scrub !== 'object' || Array.isArray(scrub)) {
    problems.push('scrub is required for finalize: supply all six attestations as true and a non-empty English notes string.')
    return
  }
  for (const [field] of SCRUB_FIELDS) {
    if (scrub[field] !== true) {
      problems.push(`scrub.${field} must be true: attest that this category was scrubbed before finalize.`)
    }
  }
  if (typeof scrub.notes !== 'string' || scrub.notes.trim() === '') {
    problems.push('scrub.notes must be a non-empty English note describing the regional-trace scrub.')
    return
  }
  if (hasCjk(scrub.notes)) {
    problems.push('scrub.notes contains forbidden CJK or fullwidth characters.')
  }
  const noteTraces = scanRegionalTraces(scrub.notes)
  const noteTraceCategories = Object.keys(noteTraces)
  if (noteTraceCategories.length > 0) {
    const noteTraceLines = noteTraceCategories.map((category) => `category ${category} at line(s) ${summarizeNumbers(noteTraces[category])}`).join('; ')
    problems.push(`scrub.notes contains a forbidden regional trace (${noteTraceLines}). Do not repeat removed identifying details in the notes.`)
  }
}

/* ------------------------------------------------------------------ */
/* status                                                             */
/* ------------------------------------------------------------------ */

/**
 * Report the latest bundle for this session without changing it.
 * @param {object} ctx - Host plugin context.
 * @param {object} exec - Tool execution context.
 * @returns {Promise<object>} Canonical tool result.
 */
async function runStatus(ctx, exec) {
  requireAgent(exec)
  const cwd = await ensureCwd(ctx, exec)
  const sessionId = sessionSegment(exec.agent)
  const latest = await findLatestBundle(cwd, sessionId)
  if (latest === undefined) {
    return {
      ok: true,
      action: 'status',
      status: 'none',
      files: [],
      message: 'No handoff bundle exists for this session yet. Use action "start" to create one.',
    }
  }
  const realCwd = await resolveRealPath(cwd, 'the session working directory')
  const realFolder = await resolveRealPath(latest.folder, 'the latest handoff folder')
  if (!isInside(realCwd, realFolder)) {
    throw new Error('The latest handoff folder resolves outside the session working directory, so it was not read.')
  }
  const entries = await readdir(latest.folder, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry, index) => (hasCjk(entry.name) || hasRegionalTrace(entry.name) || !isAsciiText(entry.name) ? `file-${index + 1}` : entry.name))
    .sort()
  const folder = folderReference(latest.folder, cwd).path
  const state = await inspectBundleState(latest.folder, realFolder, realCwd)
  const recoveryPath = stagingSnapshotPath(realFolder)
  const recovery = state.status === 'ready' || state.status === 'incomplete'
    ? await bundleFileInfo(dirname(recoveryPath), dirname(recoveryPath), realCwd, basename(recoveryPath))
    : undefined
  if (state.status === 'ready') {
    return {
      ok: true,
      action: 'status',
      status: 'ready',
      folder,
      files,
      message: 'The latest handoff bundle is ready: manifest.json is valid and HANDOFF.md, REVIEW.md, PROMPT.md, and manifest.json are all present as regular files.'
        + (recovery?.exists ? ' A private staging snapshot remains beside the bundle. Call finalize again to retry cleanup.' : ''),
    }
  }
  if (state.status === 'awaiting_translation') {
    return {
      ok: true,
      action: 'status',
      status: 'awaiting_translation',
      folder,
      files,
      message: 'The latest handoff bundle is still waiting for an English translation. SOURCE.md and BRIEF.json are present.',
    }
  }
  if (state.status === 'invalid') {
    return {
      ok: true,
      action: 'status',
      status: 'invalid',
      folder,
      files,
      message: 'The latest handoff bundle has a malformed or invalid manifest, or an unsafe bundle file. It is not ready.',
    }
  }
  return {
    ok: true,
    action: 'status',
    status: 'incomplete',
    folder,
    files,
    message: recovery?.regular && !activeFinalizations.has(realFolder)
      ? 'The latest handoff bundle was interrupted before publication. Call finalize again to resume from the saved staging snapshot.'
      : 'The latest handoff bundle is incomplete: a ready manifest or the expected staging files are missing.',
  }
}

/* ------------------------------------------------------------------ */
/* Bundle discovery and paths                                         */
/* ------------------------------------------------------------------ */

function stagingSnapshotPath(realFolder) {
  return join(dirname(realFolder), `.${basename(realFolder)}.staging.json`)
}

/**
 * Parse a handoff folder name into its timestamp and numeric suffix.
 * The unsuffixed form sorts as suffix 0.
 * @param {string} name - Directory name.
 * @returns {{ stamp: string, suffix: number } | undefined} Parsed name.
 */
function parseHandoffName(name) {
  const match = HANDOFF_NAME_PATTERN.exec(name)
  if (match === null) return undefined
  return { stamp: match[1], suffix: match[2] === undefined ? 0 : Number(match[2]) }
}

/**
 * List handoff folders for one session, newest first by timestamp and then by
 * numeric duplicate suffix (so -10 is newer than -9).
 * @param {string} cwd - Session working directory.
 * @param {string} sessionId - Sanitized session id.
 * @returns {Promise<{ folder: string, name: string, stamp: string, suffix: number } | undefined>} Latest bundle.
 */
async function findLatestBundle(cwd, sessionId) {
  const sessionDir = join(cwd, HANDOFF_ROOT, sessionId)
  let entries
  try {
    entries = await readdir(sessionDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error('The forward-to-claude folder could not be listed. Check the working directory and try again.', { cause: error })
  }
  const bundles = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const parsed = parseHandoffName(entry.name)
    if (parsed === undefined) continue
    bundles.push({ folder: join(sessionDir, entry.name), name: entry.name, ...parsed })
  }
  bundles.sort((left, right) => {
    if (left.stamp !== right.stamp) return left.stamp < right.stamp ? 1 : -1
    return right.suffix - left.suffix
  })
  return bundles[0]
}

/**
 * Inspect one named bundle file without following symlinks. The returned real
 * path is proved inside both the bundle folder and the session working
 * directory before a caller reads it.
 * @param {string} folder - Handoff folder path.
 * @param {string} realFolder - Real handoff folder path.
 * @param {string} realCwd - Real session working directory.
 * @param {string} fileName - Fixed bundle file name.
 * @returns {Promise<{ exists: boolean, regular?: boolean, symlink?: boolean, real?: string }>} File facts.
 */
async function bundleFileInfo(folder, realFolder, realCwd, fileName) {
  const target = join(folder, fileName)
  let stats
  try {
    stats = await lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    return { exists: true, regular: false }
  }
  if (stats.isSymbolicLink()) return { exists: true, regular: false, symlink: true }
  if (!stats.isFile()) return { exists: true, regular: false }
  let realTarget
  try {
    realTarget = await realpath(target)
  } catch {
    return { exists: true, regular: false }
  }
  if (!isInside(realFolder, realTarget) || !isInside(realCwd, realTarget)) {
    return { exists: true, regular: false }
  }
  return { exists: true, regular: true, real: realTarget }
}

/**
 * Read one named bundle file through the boundary-checked reader.
 * Symlinks, non-regular files, and realpath escapes are refused.
 * @param {string} folder - Handoff folder path.
 * @param {string} realFolder - Real handoff folder path.
 * @param {string} realCwd - Real session working directory.
 * @param {string} fileName - Fixed bundle file name.
 * @returns {Promise<string>} UTF-8 content.
 */
async function readBundleFile(folder, realFolder, realCwd, fileName) {
  const info = await bundleFileInfo(folder, realFolder, realCwd, fileName)
  if (!info.exists) {
    const error = new Error(`${fileName} is missing from the handoff folder.`)
    error.code = 'ENOENT'
    throw error
  }
  if (!info.regular) {
    throw new Error(`${fileName} is a symlink, non-regular file, or resolves outside the handoff folder, so it was not read.`)
  }
  try {
    return await readFile(info.real, 'utf8')
  } catch (error) {
    throw new Error(`${fileName} could not be read from the handoff folder. Check permissions and try again.`, { cause: error })
  }
}

/**
 * Check a handoff folder for unexpected entries and unsafe known files.
 * @param {string} folder - Handoff folder path.
 * @param {string} realFolder - Real handoff folder path.
 * @param {string} realCwd - Real session working directory.
 * @param {Set<string>} allowedEntries - Files allowed at the current stage.
 */
async function preflightHandoffFolder(folder, realFolder, realCwd, allowedEntries = BUNDLE_ENTRIES) {
  let entries
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    throw new Error('The handoff folder could not be listed. Check the folder and try again.', { cause: error })
  }
  for (const entry of entries) {
    if (!allowedEntries.has(entry.name)) {
      throw new Error('The handoff folder contains an unexpected entry. Remove it and call action "finalize" again.')
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`The handoff folder contains a symlink or non-regular entry where ${entry.name} is expected. Repair it and call action "finalize" again.`)
    }
    const info = await bundleFileInfo(folder, realFolder, realCwd, entry.name)
    if (!info.exists || info.regular !== true) {
      throw new Error(`The handoff folder's ${entry.name} is not a safe regular file. Repair it and try again.`)
    }
  }
}

/**
 * Inspect a bundle's publish state from its manifest and artifact files.
 * Ready requires a parsed manifest with status "ready" and all four final
 * artifacts present as regular files.
 * @param {string} folder - Handoff folder path.
 * @param {string} realFolder - Real handoff folder path.
 * @param {string} realCwd - Real session working directory.
 * @returns {Promise<{ status: 'ready'|'awaiting_translation'|'incomplete'|'invalid', reason?: string }>} State.
 */
async function inspectBundleState(folder, realFolder, realCwd) {
  const manifestInfo = await bundleFileInfo(folder, realFolder, realCwd, 'manifest.json')
  if (manifestInfo.exists) {
    if (manifestInfo.regular !== true) return { status: 'invalid', reason: 'manifest_not_regular' }
    let text
    try {
      text = await readBundleFile(folder, realFolder, realCwd, 'manifest.json')
    } catch {
      return { status: 'invalid', reason: 'manifest_unreadable' }
    }
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch {
      return { status: 'invalid', reason: 'manifest_not_json' }
    }
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.status !== 'ready'
      || !Array.isArray(manifest.artifacts)
      || !FINAL_ARTIFACTS.every((artifactName) => manifest.artifacts.includes(artifactName))) {
      return { status: 'invalid', reason: 'manifest_invalid' }
    }
    for (const artifactName of FINAL_ARTIFACTS) {
      const info = await bundleFileInfo(folder, realFolder, realCwd, artifactName)
      if (!info.exists) return { status: 'incomplete', reason: 'missing_artifact' }
      if (info.regular !== true) return { status: 'invalid', reason: 'artifact_not_regular' }
    }
    return { status: 'ready' }
  }

  const staging = await Promise.all(STAGING_FILES.map((name) => bundleFileInfo(folder, realFolder, realCwd, name)))
  if (staging.some((info) => info.exists && info.regular !== true)) {
    return { status: 'invalid', reason: 'staging_not_regular' }
  }
  if (staging.every((info) => info.regular === true)) return { status: 'awaiting_translation' }
  return { status: 'incomplete', reason: 'no_staging_or_manifest' }
}

/**
 * Current time for handoff folder naming, with an optional test clock.
 * @param {object} ctx - Host plugin context.
 * @returns {Date} Current or test time.
 */
function clockNow(ctx) {
  const candidate = ctx?.clock?.now
  if (typeof candidate === 'function') {
    const value = candidate()
    if (value instanceof Date && Number.isFinite(value.getTime())) return value
  }
  if (candidate instanceof Date && Number.isFinite(candidate.getTime())) return candidate
  return new Date()
}

/**
 * Create the unique handoff folder for this run.
 *
 * Write containment is checked before any handoff data is written: the
 * existing `forward-to-claude` root and the session folder are realpath-checked
 * against the session working directory, the new handoff folder is created
 * with a non-recursive mkdir on a fresh unique name, and that new folder is
 * realpath-checked again. A junction or symlink that redirects any of them
 * outside the working directory is rejected with nothing written outside it.
 *
 * @param {string} cwd - Session working directory.
 * @param {string} realCwd - Real path of the working directory.
 * @param {string} sessionId - Sanitized session id.
 * @param {Date} now - Timestamp used for the folder name.
 * @returns {Promise<string>} Absolute folder path inside the working directory.
 */
async function createHandoffFolder(cwd, realCwd, sessionId, now = new Date()) {
  const root = join(cwd, HANDOFF_ROOT)
  try {
    await mkdir(root)
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw new Error('Could not create the forward-to-claude folder inside the session working directory. Check permissions and try again.', { cause: error })
    }
  }
  const rootStats = await statOrThrow(root, 'the forward-to-claude folder')
  if (!rootStats.isDirectory()) {
    throw new Error('The forward-to-claude path exists but is not a directory, so no handoff folder was created. Move or remove it and try again.')
  }
  const realRoot = await resolveRealPath(root, 'the forward-to-claude folder')
  if (!isInside(realCwd, realRoot)) {
    throw new Error('The forward-to-claude folder resolves outside the session working directory, so nothing was created. Remove or replace that link and try again.')
  }

  const sessionDir = join(root, sessionId)
  try {
    await mkdir(sessionDir)
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw new Error('Could not create the session handoff folder inside the forward-to-claude directory. Check permissions and try again.', { cause: error })
    }
  }
  const sessionStats = await statOrThrow(sessionDir, 'the session handoff folder')
  if (!sessionStats.isDirectory()) {
    throw new Error('The session handoff path exists but is not a directory, so no handoff folder was created. Move or remove it and try again.')
  }
  const realSession = await resolveRealPath(sessionDir, 'the session handoff folder')
  if (!isInside(realCwd, realSession) || !isInside(realRoot, realSession)) {
    throw new Error('The session handoff folder resolves outside the session working directory, so nothing was created. Remove or replace that link and try again.')
  }

  const stamp = formatUtcStamp(now)
  let attempt = 0
  for (;;) {
    const candidate = join(sessionDir, attempt === 0 ? `handoff-${stamp}` : `handoff-${stamp}-${attempt}`)
    try {
      await mkdir(candidate)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        attempt += 1
        if (attempt > 999) {
          throw new Error('Could not create a unique handoff folder name. Clean up old forward-to-claude folders and try again.')
        }
        continue
      }
      throw new Error('Could not create the handoff folder inside the session working directory. Check permissions and try again.', { cause: error })
    }
    const realFolder = await resolveRealPath(candidate, 'the new handoff folder')
    if (!isInside(realCwd, realFolder) || !isInside(realRoot, realFolder) || !isInside(realSession, realFolder)) {
      throw new Error('The new handoff folder resolves outside the session working directory, so no files were written to it.')
    }
    return candidate
  }
}

/**
 * Build the ASCII-only BRIEF.json metadata object.
 * @param {{ sessionId: string, sections: object[], sourceText: string, files: object[], regionalTraceSummary: object, traces: object[] }} input - Staged material.
 * @returns {object} Brief metadata.
 */
function buildBrief({ sessionId, sections, sourceText, files, regionalTraceSummary, traces }) {
  return {
    version: 1,
    status: 'awaiting_translation',
    created_at: new Date().toISOString(),
    session_id: sessionId,
    source_file: 'SOURCE.md',
    source_chars: sourceText.length,
    source_sha256: hashString(sourceText),
    sections: sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      label: section.label,
      code_spans: section.code_spans,
    })),
    files: files.map((file) => ({ label: file.label, bytes: file.bytes, sha256: file.sha256 })),
    regional_traces: {
      total: regionalTraceSummary.total,
      categories: regionalTraceSummary.categories,
    },
    traces: traces.map((trace) => ({
      id: trace.id,
      category: trace.category,
      sections: [...trace.sections],
      occurrences: { ...trace.occurrences },
    })),
  }
}

/* ------------------------------------------------------------------ */
/* Markdown rendering                                                 */
/* ------------------------------------------------------------------ */

/**
 * Render the staging SOURCE.md the translating agent must translate.
 * @param {object[]} sections - Sections in order, each with id, kind, label, body.
 * @returns {string} Markdown source.
 */
function renderSource(sections) {
  const lines = [
    '# Forward to Claude handoff source',
    '',
    'This staging file was created by the forward_to_claude tool. It may contain Chinese text and is deleted after a successful finalize.',
    '',
    `Sections: ${sections.length}`,
    `Characters: ${sections.reduce((sum, section) => sum + section.body.length, 0)}`,
    '',
    'Translate every section below into natural technical English. Keep each [S#] heading, preserve code identifiers, commands, paths, and numbers, and do not summarize or omit anything.',
    '',
  ]
  for (const section of sections) {
    lines.push(`## [${section.id}] ${section.label}`, '')
    if (section.kind === 'file') {
      const fence = '`'.repeat(fenceLength(section.body))
      lines.push(`${fence}text`)
      lines.push(section.body.replace(/\n+$/, ''))
      lines.push(fence, '')
    } else {
      lines.push(section.body, '')
    }
  }
  return lines.join('\n')
}

/**
 * Render REVIEW.md from the validated review rows, scrub checklist, and
 * consistency audit.
 * @param {{ brief: object, handoff: string, review: object[], scrub: object, consistency: object }} input - Validated inputs.
 * @returns {string} Markdown review.
 */
function renderReview({ brief, handoff, review, scrub, consistency }) {
  const labels = new Map(brief.sections.map((section) => [section.id, section.label]))
  const rows = review.map((row) => `| [${row.id}] ${escapeTableCell(labels.get(row.id) ?? '')} | yes | ${escapeTableCell(row.notes)} |`)
  const scrubRows = SCRUB_FIELDS.map(([field, label]) => `| ${label} | ${scrub[field] === true ? 'yes' : 'no'} |`)
  const consistencyRows = consistency.rows.map((row) => {
    const disposition = row.disposition === 'alias' ? 'alias' : 'removed'
    const alias = typeof row.alias === 'string' && row.alias !== '' ? escapeTableCell(row.alias) : '-'
    return `| ${row.trace_id} | ${escapeTableCell(row.category)} | ${disposition} | ${alias} | ${escapeTableCell(row.sections.join(', '))} |`
  })
  return [
    '# Fidelity review',
    '',
    'The translating agent reviewed every source section against its English handoff text.',
    '',
    `- Source sections: ${brief.sections.length}`,
    `- Source characters: ${brief.source_chars}`,
    `- Handoff characters: ${handoff.length}`,
    '- All meanings preserved: yes',
    '',
    '| Section | Meaning preserved | Notes |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '## Regional trace scrub',
    '',
    'The translating agent attested that identifying regional details were replaced with neutral aliases before finalize:',
    '',
    '| Check | Attested |',
    '| --- | --- |',
    ...scrubRows,
    '',
    `**Scrub notes:** ${escapeTableCell(scrub.notes)}`,
    '',
    'Pattern checks cover known high-confidence forms of country/region identifiers, city/region names, organizations and platforms, domains and contact numbers, currency and units, locale/language tags, political or cultural references, and personal-name patterns. The checklist above is the translating agent\'s attestation, not proof that every possible regional trace was removed; semantic scrubbing cannot be verified mechanically.',
    '',
    '## Context consistency review',
    '',
    'The translating agent performed a separate whole-document read-through after translation and scrub, and attested that aliases, section labels, and file references stay identical across sections:',
    '',
    `- Audited: ${consistency.audited === true ? 'yes' : 'no'}`,
    `- Sections reviewed: ${consistency.sections_reviewed.length} of ${brief.sections.length}`,
    `- Alias stability: ${consistency.alias_stability === true ? 'yes' : 'no'}`,
    `- File references consistent: ${consistency.file_references_consistent === true ? 'yes' : 'no'}`,
    `- No unmapped entities: ${consistency.no_unmapped_entities === true ? 'yes' : 'no'}`,
    '',
    `**Consistency notes:** ${escapeTableCell(consistency.notes)}`,
    '',
    '| Trace | Category | Disposition | Alias | Sections |',
    '| --- | --- | --- | --- | --- |',
    ...consistencyRows,
    '',
    'The plugin mechanically checks ledger coverage, structured alias grammar, alias presence in every affected section, declared alias-like tokens, exact source section labels, and known file labels. Multiple T/M rows may share one structured alias only when they denote the same entity and the consistency notes attest that; the plugin cannot mechanically distinguish one entity described by two source terms from two distinct entities assigned one alias. Semantic identity and completeness of the model-authored ledger remain the translating agent\'s attestation, not proof; natural names outside the structured alias grammar are not caught mechanically.',
    '',
    'Coverage of every section heading, presence of every safe inline code span, one completed review row per section, a complete scrub attestation, a complete trace-ledger consistency audit, the absence of CJK or fullwidth characters, and an empty mechanical regional-trace scan are also enforced by the forward_to_claude plugin. Mechanical checks cannot prove semantic fidelity or entity identity; that part rests on the section-by-section review and whole-document consistency attestation recorded above.',
    '',
  ].join('\n')
}

/**
 * Build manifest.json for the ready bundle.
 * @param {{ brief: object, sessionId: string, handoff: string, folderRef: { path: string, absolute: boolean }, scrub: object, consistency: object }} input - Validated inputs.
 * @returns {object} Manifest.
 */
function buildManifest({ brief, sessionId, handoff, folderRef, scrub, consistency }) {
  const checklist = {}
  for (const [field] of SCRUB_FIELDS) checklist[field] = scrub[field] === true
  const consistencyRows = Array.isArray(consistency.rows) ? consistency.rows : []
  const traces = Array.isArray(brief.traces) ? brief.traces : []
  const consistencySummary = {
    audited: true,
    sections_reviewed: consistency.sections_reviewed.length,
    alias_stability: consistency.alias_stability === true,
    file_references_consistent: consistency.file_references_consistent === true,
    no_unmapped_entities: consistency.no_unmapped_entities === true,
    traces: traces.length,
    model_entities: consistencyRows.filter((row) => /^M\d+$/.test(row.trace_id)).length,
    aliased: consistencyRows.filter((row) => row.disposition === 'alias').length,
    removed: consistencyRows.filter((row) => row.disposition === 'removed').length,
    notes_sha256: hashString(consistency.notes),
  }
  return {
    version: 1,
    status: 'ready',
    created_at: new Date().toISOString(),
    session_id: typeof brief.session_id === 'string' ? brief.session_id : sessionId,
    folder: folderRef.path,
    source_sections: brief.sections.length,
    source_characters: brief.source_chars,
    source_sha256: brief.source_sha256,
    handoff_sha256: hashString(handoff),
    review: {
      sections: brief.sections.length,
      all_meaning_preserved: true,
    },
    regional_trace_scrub: {
      attested: true,
      ...checklist,
      notes_sha256: hashString(scrub.notes),
      mechanical_scan: { total: 0 },
    },
    consistency: consistencySummary,
    files: brief.files,
    artifacts: [...FINAL_ARTIFACTS],
  }
}

/**
 * Resolve where the bundle lives for a trace-free artifact. Falls back to a
 * trace-free relative path when the absolute path contains CJK characters or a
 * regional trace outside the fixed OS home-directory prefix.
 * @param {string} folder - Absolute handoff folder.
 * @param {string} cwd - Session working directory.
 * @returns {{ path: string, absolute: boolean }} Path reference.
 */
function folderReference(folder, cwd) {
  const absolute = toPosix(folder)
  if (!hasCjk(absolute) && !hasRegionalTrace(absolute)) return { path: absolute, absolute: true }
  const relativePath = toPosix(relative(cwd, folder))
  if (relativePath === '' || hasCjk(relativePath) || hasRegionalTrace(relativePath)) {
    throw new Error('The handoff folder path contains a forbidden character or regional trace and no trace-free relative path can be reported. Move the project to a neutral path and start a new handoff.')
  }
  return { path: relativePath, absolute: false }
}

/**
 * Display one path for a tool result, using the same fallback rule.
 * @param {string} target - Absolute path inside cwd.
 * @param {string} cwd - Session working directory.
 * @returns {string} Trace-free path.
 */
function displayPath(target, cwd) {
  const absolute = toPosix(target)
  if (!hasCjk(absolute) && !hasRegionalTrace(absolute)) return absolute
  return folderReference(target, cwd).path
}

/**
 * Render the ready-to-paste Claude prompt.
 * @param {{ path: string, absolute: boolean }} folderRef - Folder reference.
 * @returns {string} Prompt text.
 */
function renderPrompt(folderRef) {
  const intro = folderRef.absolute
    ? 'That session left a complete handoff bundle at this absolute path:'
    : 'That session left a complete handoff bundle at this path, relative to the project root:'
  const at = (file) => `${folderRef.path}/${file}`
  return [
    'Hello Claude,',
    '',
    'I am continuing a project that was previously handled in another AI session.',
    intro,
    '',
    folderRef.path,
    '',
    'Please read all three of these files before you answer or change anything:',
    '',
    `1. HANDOFF.md at ${at('HANDOFF.md')}: the full project context, the decisions already made, and the current state of the work, translated into English.`,
    `2. REVIEW.md at ${at('REVIEW.md')}: a section-by-section fidelity review describing how the original material was translated.`,
    `3. manifest.json at ${at('manifest.json')}: checksums and a machine-readable inventory of the bundle.`,
    '',
    'Identifying regional details in the bundle were replaced with neutral aliases (for example Person A, Team member A, Vendor A, Platform A, City A, Region A, Currency A, the target locale, the authorities, and a public holiday) and each alias is used identically across every affected section. No mapping from those aliases back to the original details is included.',
    '',
    'Reconstruct the context, the decisions, and the current state of the work from HANDOFF.md. Do not assume that you have access to the original conversation or to any files outside this bundle. If something is missing, ambiguous, or contradictory, say so and ask instead of guessing. Ask me before making any irreversible change.',
  ].join('\n')
}

/**
 * Wrap the prompt in a copyable fenced block.
 * @param {string} prompt - Prompt text.
 * @returns {string} PROMPT.md content.
 */
function renderPromptDocument(prompt) {
  const fence = '`'.repeat(fenceLength(prompt))
  return [
    '# Prompt for Claude',
    '',
    'Copy the block below and paste it into Claude to continue this work.',
    '',
    fence,
    prompt.replace(/\n+$/, ''),
    fence,
    '',
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* Verification                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Text and filesystem helpers                                        */
/* ------------------------------------------------------------------ */

/**
 * Scan text for CJK/fullwidth characters and return only line numbers.
 * Line numbers are 1-based and never echo the offending character.
 * @param {string} text - Text to scan.
 * @returns {number[]} One line number per offending character.
 */
function scanCjkLines(text) {
  const lines = []
  let line = 1
  let consumed = 0
  CJK_GLOBAL.lastIndex = 0
  for (let match = CJK_GLOBAL.exec(text); match !== null; match = CJK_GLOBAL.exec(text)) {
    for (let index = consumed; index < match.index; index += 1) {
      if (text.charCodeAt(index) === 10) line += 1
    }
    consumed = match.index
    lines.push(line)
  }
  CJK_GLOBAL.lastIndex = 0
  return lines
}

/**
 * Whether text contains any CJK/fullwidth character.
 * @param {string} text - Text to test.
 * @returns {boolean} True when a forbidden character exists.
 */
function hasCjk(text) {
  return typeof text === 'string' && CJK_TEST.test(text)
}

/**
 * Compress many line numbers into one short, deduplicated English phrase.
 * @param {number[]} numbers - Line numbers.
 * @returns {string} Human-readable list.
 */
function summarizeNumbers(numbers) {
  const unique = [...new Set(numbers)].sort((left, right) => left - right)
  const shown = unique.slice(0, MAX_PROBLEMS)
  const suffix = unique.length > shown.length ? `, ... (${unique.length} lines total)` : ''
  return `${shown.join(', ')}${suffix}`
}

/**
 * Keep a section id safe for an English-only, trace-free error message.
 * @param {string} id - Candidate id.
 * @returns {string} The id when safe, otherwise a generic description.
 */
function safeDisplayId(id) {
  return isAsciiText(id) && id.length <= 32 && !hasRegionalTrace(id) ? id : 'with a redacted id'
}

/**
 * Printable ASCII check for labels, paths in errors, and metadata.
 * @param {string} value - Text to test.
 * @returns {boolean} True for printable ASCII only.
 */
function isAsciiText(value) {
  return typeof value === 'string' && !/[^\x20-\x7E]/.test(value)
}

/**
 * Extract unique inline single-backtick spans that are safe to re-check.
 * Spans carrying a regional trace are exempt: they must be replaced by a
 * neutral alias instead of reproduced.
 * @param {string} body - Section body.
 * @returns {string[]} Safe ASCII code-span contents, 2 to 160 characters.
 */
function extractCodeSpans(body) {
  const spans = []
  const seen = new Set()
  const pattern = /(?<!`)`([^`\n]+?)`(?!`)/g
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const span = match[1]
    if (span.length < 2 || span.length > 160) continue
    if (!isAsciiText(span) || span.trim() === '') continue
    if (hasRegionalTrace(span)) continue
    if (seen.has(span)) continue
    seen.add(span)
    spans.push(span)
  }
  return spans
}

/**
 * Choose a fence long enough that the body cannot terminate it.
 * @param {string} body - Text to fence.
 * @returns {number} Backtick count.
 */
function fenceLength(body) {
  let longest = 0
  for (const match of body.matchAll(/`+/g)) {
    if (match[0].length > longest) longest = match[0].length
  }
  return Math.max(3, longest + 1)
}

/**
 * Normalize Windows and old-Mac line endings to LF.
 * @param {string} text - Text to normalize.
 * @returns {string} LF-only text.
 */
function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n')
}

/**
 * Escape one value for a Markdown table cell.
 * @param {string} value - Cell value.
 * @returns {string} Escaped, single-line value.
 */
function escapeTableCell(value) {
  return String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

/**
 * Convert a Windows path to forward slashes.
 * @param {string} value - Path.
 * @returns {string} Forward-slash path.
 */
function toPosix(value) {
  return String(value).split(sep).join('/')
}

/**
 * Sanitize one folder-name segment.
 * @param {string} value - Raw segment.
 * @returns {string} `[A-Za-z0-9._-]` only.
 */
function sanitizeSegment(value) {
  const cleaned = String(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'session'
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(cleaned)) return `session-${cleaned}`
  return cleaned
}

/**
 * Derive the session folder segment. A session id that carries a regional
 * trace becomes a deterministic `session-<sha256-prefix>` segment; the raw id
 * is never stored, so no mapping is persisted. Clean ids are unchanged.
 * @param {object} agent - Calling agent.
 * @returns {string} Trace-free session segment.
 */
function sessionSegment(agent) {
  const rawId = sessionIdOf(agent)
  const cleaned = sanitizeSegment(rawId)
  if (!hasRegionalTrace(cleaned)) return cleaned
  return `session-${hashString(rawId).slice(0, 16)}`
}

/**
 * Require the calling agent.
 * @param {object} exec - Tool execution context.
 * @returns {object} The calling agent.
 */
function requireAgent(exec) {
  const agent = exec?.agent
  if (agent === null || typeof agent !== 'object') {
    throw new Error('forward_to_claude requires a calling agent. Invoke it from an agent session rather than a standalone service call.')
  }
  return agent
}

/**
 * Read the calling session id.
 * @param {object} agent - Calling agent.
 * @returns {string} Session id.
 */
function sessionIdOf(agent) {
  const id = agent?.session?.id
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('This session does not expose a usable session id, so forward_to_claude cannot name its handoff folder.')
  }
  return id
}

/**
 * Resolve the session working directory.
 * @param {object} ctx - Host plugin context.
 * @param {object} exec - Tool execution context.
 * @returns {Promise<string>} Absolute working directory.
 */
async function ensureCwd(ctx, exec) {
  requireAgent(exec)
  let cwd
  try {
    cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  } catch (error) {
    throw new Error('Could not resolve the session working directory, so no handoff folder can be created.', { cause: error })
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('Could not resolve the session working directory, so no handoff folder can be created.')
  }
  return resolve(cwd)
}

/**
 * Realpath with an English-only failure message.
 * @param {string} target - Path to resolve.
 * @param {string} description - English noun phrase for the message.
 * @returns {Promise<string>} Real path.
 */
async function resolveRealPath(target, description) {
  try {
    return await realpath(target)
  } catch (error) {
    throw new Error(`Could not resolve ${description}. Check that it exists and try again.`, { cause: error })
  }
}

/**
 * Whether a real path is inside the real working directory.
 * @param {string} realCwd - Real working directory.
 * @param {string} realTarget - Real candidate path.
 * @returns {boolean} True when contained.
 */
function isInside(realCwd, realTarget) {
  const caseFold = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value
  const base = caseFold(realCwd)
  const target = caseFold(realTarget)
  const rel = relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Format a UTC timestamp as YYYYMMDD-HHmmss.
 * @param {Date} date - Timestamp.
 * @returns {string} Compact UTC stamp.
 */
function formatUtcStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

/**
 * SHA-256 of a UTF-8 string.
 * @param {string} text - Text.
 * @returns {string} Hex digest.
 */
function hashString(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * SHA-256 of a buffer.
 * @param {Buffer} buffer - Bytes.
 * @returns {string} Hex digest.
 */
function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Stat a path with an English-only failure message.
 * @param {string} target - Path to inspect.
 * @param {string} description - English noun phrase for the message.
 * @returns {Promise<import('node:fs').Stats>} Filesystem stats.
 */
async function statOrThrow(target, description) {
  try {
    return await stat(target)
  } catch (error) {
    throw new Error(`Could not inspect ${description}. Check the working directory and try again.`, { cause: error })
  }
}

/**
 * Check whether a regular file exists.
 * @param {string} target - Path.
 * @returns {Promise<boolean>} True for an existing regular file.
 */
async function fileExists(target) {
  try {
    const stats = await stat(target)
    return stats.isFile()
  } catch {
    return false
  }
}

/**
 * Write a file atomically: a unique temp file in the destination directory,
 * then rename over the target. The temp file is removed on failure.
 * @param {string} target - Destination path.
 * @param {string} content - UTF-8 content.
 * @param {{ temporaryDirectory?: string, mode?: number, verify?: boolean }} options - Atomic write options.
 */
async function writeAtomic(target, content, { temporaryDirectory = dirname(target), mode, verify = false } = {}) {
  const temp = join(temporaryDirectory, `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx', mode })
    if (verify && (await readFile(temp, 'utf8')) !== content) {
      throw new Error(`The pending ${basename(target)} did not match the verified content.`)
    }
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw new Error(`Could not write ${basename(target)} in the handoff folder. Check free disk space and permissions, then try again.`, { cause: error })
  }
}

/**
 * Write ASCII-only JSON metadata atomically with a trailing newline.
 * @param {string} target - Destination path.
 * @param {object} value - JSON value.
 * @param {string} label - English file label for errors.
 */
async function writeJsonAtomic(target, value, label) {
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (/[^\x00-\x7F]/.test(content)) {
    throw new Error(`${label} would contain a non-ASCII character, so it was not written. The handoff metadata must stay ASCII-only.`)
  }
  await writeAtomic(target, content)
}
