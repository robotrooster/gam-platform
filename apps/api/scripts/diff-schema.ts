// Schema diff harness - code vs live DB.
//
// Usage:
//   cd apps/api
//   npm run schema:diff               default; acked items suppressed; exits 1 only on unacked drift
//   npm run schema:diff -- --all      show all drift including acked; exits 1 on any drift
//   npm run schema:diff -- --verbose  also list DB cols no code touches
//
// Pairs with the migration runner (S56). Runner enforces edit-history
// immutability of applied migrations; this harness catches code-vs-schema
// drift - INSERT/UPDATE referencing columns or tables that don't exist.
//
// Acknowledged drift lives in apps/api/scripts/diff-schema.acks.
// Each ack must reference a closure session from the deferred-list memo.
//
// Run before any session that adds new write SQL.

import { db } from '../src/db'
import * as fs from 'fs'
import * as path from 'path'

const VERBOSE = process.argv.includes('--verbose')
const SHOW_ALL = process.argv.includes('--all')
const SRC_ROOT = path.resolve(__dirname, '..', 'src')
const ACKS_FILE = path.resolve(__dirname, 'diff-schema.acks')

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      if (entry.name === 'migrations') continue
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function shouldScan(file: string): boolean {
  const base = path.basename(file)
  if (!file.endsWith('.ts')) return false
  if (base.endsWith('.test.ts') || base.endsWith('.spec.ts')) return false
  if (/\.s\d+backup(\.ts)?$/.test(base)) return false
  return true
}

interface Acks {
  missingTables: Set<string>
  missingColumns: Set<string>
  wildcards: Set<string>
  antipatterns: Set<string>
}

function loadAcks(): Acks {
  const acks: Acks = {
    missingTables: new Set(),
    missingColumns: new Set(),
    wildcards: new Set(),
    antipatterns: new Set(),
  }
  if (!fs.existsSync(ACKS_FILE)) return acks
  const text = fs.readFileSync(ACKS_FILE, 'utf8')
  let lineNo = 0
  for (const raw of text.split('\n')) {
    lineNo++
    const stripped = raw.replace(/#.*$/, '').trim()
    if (!stripped) continue
    const m = stripped.match(/^([TCWA]):(.+)$/)
    if (!m) {
      console.warn(`[acks] line ${lineNo}: unparseable: ${raw}`)
      continue
    }
    const [, kind, body] = m
    const value = body.trim()
    if (kind === 'T') acks.missingTables.add(value)
    else if (kind === 'C') acks.missingColumns.add(value)
    else if (kind === 'W') acks.wildcards.add(value)
    else if (kind === 'A') acks.antipatterns.add(value)
  }
  return acks
}

interface Reference {
  table: string
  columns: string[]
  kind: 'INSERT' | 'UPDATE'
  file: string
  line: number
}

interface AntiPattern {
  file: string
  line: number
  snippet: string
}

const INSERT_RE = /INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^)]*)\))?/gs
const UPDATE_RE = /UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+SET\s+([\s\S]*?)(?:\s+WHERE\s|\s+RETURNING\s|`|;|$)/gi

// S233: SELECT scanner. Catches drift in read paths — a typo'd table
// name in a SELECT/JOIN passes the harness pre-S233 because it only
// scans INSERT/UPDATE writes. We pragmatically check FROM/JOIN target
// tables only — full per-column SELECT verification would need a real
// SQL parser (alias resolution, function calls, subqueries, CTEs) and
// would generate false positives that drown the signal. Table-name
// drift is the highest-value catch; bare column refs in SELECT clauses
// don't move the needle enough to justify the parser.
//
// We constrain to SQL contexts: a chunk of text is treated as SQL only
// when a SELECT/WITH keyword precedes the FROM/JOIN within the same
// string literal. INSERT_RE / UPDATE_RE work without this filter
// because those keywords are nearly never in prose; FROM/JOIN are.
const FROM_JOIN_RE = /(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g
const SQL_LITERAL_RE = /`([^`]*)`/g

function lineNumber(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let inSingle = false
  let buf = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inSingle) {
      if (ch === "'") inSingle = false
      buf += ch
      continue
    }
    if (ch === "'") { inSingle = true; buf += ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      out.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf)
  return out
}

function parseColumnList(raw: string): string[] {
  return splitTopLevelCommas(raw)
    .map(s => s.replace(/--.*$/gm, '').trim())
    .filter(Boolean)
    .filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s))
}

function parseSetClause(raw: string): string[] {
  const cols: string[] = []
  for (const frag of splitTopLevelCommas(raw)) {
    const m = frag.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=/)
    if (m) cols.push(m[1])
  }
  return cols
}

// S233: PostgreSQL system catalogs we'll see in administrative queries —
// these aren't drift, they're real (just not in public schema). Skip them
// in the existence check.
const SYSTEM_TABLES = new Set([
  'information_schema', 'pg_catalog', 'pg_class', 'pg_namespace',
  'pg_indexes', 'pg_stat_activity', 'pg_locks', 'pg_settings',
])

// SQL keywords that the FROM_JOIN_RE alias capture might greedy-match
// when there's no real alias. Filter these out post-extract so we don't
// chase phantom-table drift on words like "WHERE" / "ON" / "AND".
const SQL_KEYWORDS_AFTER_FROM = new Set([
  'where', 'on', 'and', 'or', 'group', 'order', 'having', 'limit',
  'offset', 'left', 'right', 'inner', 'outer', 'full', 'cross',
  'lateral', 'join', 'natural', 'using', 'as', 'union', 'intersect',
  'except', 'returning', 'for', 'with', 'tablesample',
])

// S239: strip TS/JS comments (line `// ...` and block `/* ... */`) before
// regex matching. Pre-S239 the harness matched `INSERT INTO archive`
// inside a docstring comment in jobs/complianceArchive.ts and emitted
// it as an anti-pattern every run. Stripping comments produces accurate
// noise-free output; replacing comment text with spaces preserves line
// numbers so the lineNumber() helper still maps offsets correctly.
function stripComments(text: string): string {
  // Block comments
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  // Line comments (after block-comment strip so `// foo /* bar */` is handled).
  // Avoid touching protocol slashes inside strings — naive but safe: only
  // match `//` not preceded by `:` (rules out `https://`) AND not inside a
  // backtick / single-quote / double-quote string. Tracking string state
  // would balloon the function; the protocol guard catches the most common
  // false positive in this codebase.
  out = out.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (_m, lead) => lead + Array.from('//').join('').replace(/./g, ' ') + ' '.repeat(_m.length - lead.length - 2))
  return out
}

function extractRefs(file: string, text: string): { refs: Reference[], anti: AntiPattern[], selectTables: { table: string; line: number }[] } {
  const refs: Reference[] = []
  const anti: AntiPattern[] = []
  const selectTables: { table: string; line: number }[] = []

  // S239: scan against a comment-stripped copy. Comments inside template
  // literals (rare) might still slip through but the codebase's SQL-in-
  // backticks pattern doesn't include `//` or `/*` inside the SQL itself.
  text = stripComments(text)

  INSERT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INSERT_RE.exec(text)) !== null) {
    const table = m[1]
    const colsRaw = m[2]
    const line = lineNumber(text, m.index)
    if (!colsRaw) {
      anti.push({ file, line, snippet: `INSERT INTO ${table} (no column list)` })
      continue
    }
    // S239: dynamic column lists (template-literal interpolation like
    // `INSERT INTO leases (${writableCols.join(',')}, ...)`) can't be
    // statically validated. The INSERT_RE column capture stops at the
    // first `)` it sees, which inside `${...join(', ')}` is the inner
    // `)` of the .join() call — so colsRaw can contain just `${...`
    // truncated before its closing brace. Detect the opening `${` alone
    // as the dynamic signal. Skip both the anti-pattern flag AND the
    // column-existence check — neither is meaningful at static time.
    if (/\$\{/.test(colsRaw)) {
      continue
    }
    const cols = parseColumnList(colsRaw)
    if (cols.length === 0) {
      anti.push({ file, line, snippet: `INSERT INTO ${table} (empty/unparseable column list)` })
      continue
    }
    refs.push({ table, columns: cols, kind: 'INSERT', file, line })
  }

  UPDATE_RE.lastIndex = 0
  while ((m = UPDATE_RE.exec(text)) !== null) {
    const table = m[1]
    const setRaw = m[2]
    const line = lineNumber(text, m.index)
    const cols = parseSetClause(setRaw)
    if (cols.length === 0) continue
    refs.push({ table, columns: cols, kind: 'UPDATE', file, line })
  }

  // S233: SELECT FROM/JOIN scan for table existence only. Two-pass:
  //   1. Find every backticked template literal (SQL_LITERAL_RE).
  //   2. For each literal, only scan FROM/JOIN if a SELECT or WITH
  //      keyword appears earlier in the same literal — that filter
  //      eliminates English prose ("data from the user") from matching.
  // INSERT INTO and UPDATE both also include FROM/JOIN clauses (UPDATE
  // ... FROM other, INSERT ... SELECT ... FROM ...); the table they
  // introduce gets captured here too but de-dupe by (table, file, line)
  // downstream prevents double-flagging.
  //
  // Guards against false positives:
  //   - CTE aliases: `WITH x AS (` / `, x AS (` introduces x as a
  //     temporary table; later `FROM x` in the same literal isn't drift.
  //   - Function calls: `FROM funcname(` is a set-returning function
  //     (generate_series, jsonb_array_elements, unnest, …), not a table.
  //   - FROM inside expression parens: `EXTRACT(HOUR FROM created_at)`
  //     and `SUBSTRING(s FROM start)` use FROM as a syntactic delimiter
  //     inside function calls. Detect by paren depth > 0.
  SQL_LITERAL_RE.lastIndex = 0
  let lit: RegExpExecArray | null
  while ((lit = SQL_LITERAL_RE.exec(text)) !== null) {
    const body = lit[1]
    if (!/\b(SELECT|WITH)\b/i.test(body)) continue
    const literalStart = lit.index + 1

    // Pre-pass: collect CTE / subquery aliases. The pattern is
    // `<word> AS (` — captures both top-level WITH aliases and any
    // `(subquery) AS name` later in the SQL. Conservative: any name
    // appearing in `<name> AS (` gets allowlisted.
    const aliasNames = new Set<string>()
    const ALIAS_RE = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(/gi
    let am: RegExpExecArray | null
    while ((am = ALIAS_RE.exec(body)) !== null) {
      aliasNames.add(am[1])
    }

    FROM_JOIN_RE.lastIndex = 0
    let fm: RegExpExecArray | null
    while ((fm = FROM_JOIN_RE.exec(body)) !== null) {
      const table = fm[1]
      if (!table || SYSTEM_TABLES.has(table)) continue
      if (SQL_KEYWORDS_AFTER_FROM.has(table.toLowerCase())) continue
      if (aliasNames.has(table)) continue

      const beforeFrom = body.slice(0, fm.index)
      if (!/\b(SELECT|WITH|UNION|INTERSECT|EXCEPT|UPDATE|DELETE)\b/i.test(beforeFrom)) continue

      // Function call: next non-whitespace char after the table name is
      // an open paren. `FROM generate_series(...)`, `FROM unnest(...)`.
      const afterTable = body.slice(fm.index + fm[0].length)
      if (/^\s*\(/.test(afterTable)) continue

      // Inside a function-call paren-list: `EXTRACT(HOUR FROM x)`,
      // `SUBSTRING(s FROM 1)`. Net paren depth at the FROM position is
      // > 0, meaning we're inside an expression. Real SELECT/JOIN FROM
      // sits at depth 0 (top-level) or 1 only when wrapped in a
      // single-statement subquery. Tests showed depth-based check is
      // slightly aggressive — instead, look at the keyword that
      // immediately precedes the paren scope this FROM is inside.
      // If the most recent unmatched `(` is preceded by a function-
      // like identifier, this FROM is inside that function's args.
      let depth = 0
      let openParenPos = -1
      for (let i = fm.index - 1; i >= 0; i--) {
        const c = body[i]
        if (c === ')') depth++
        else if (c === '(') {
          if (depth === 0) { openParenPos = i; break }
          depth--
        }
      }
      if (openParenPos >= 0) {
        // Look at the identifier immediately preceding the open paren.
        const before = body.slice(0, openParenPos).trimEnd()
        const fnMatch = before.match(/([a-zA-Z_][a-zA-Z0-9_]*)$/)
        if (fnMatch) {
          const fnName = fnMatch[1].toUpperCase()
          // Function-style use of FROM (postgres expression syntax)
          if (['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY', 'POSITION', 'CAST'].includes(fnName)) {
            continue
          }
        }
      }

      selectTables.push({ table, line: lineNumber(text, literalStart + fm.index) })
    }
  }

  return { refs, anti, selectTables }
}

async function fetchDbSchema(): Promise<Map<string, Set<string>>> {
  const result = await db.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`
  )
  const map = new Map<string, Set<string>>()
  for (const row of result.rows) {
    if (!map.has(row.table_name)) map.set(row.table_name, new Set())
    map.get(row.table_name)!.add(row.column_name)
  }
  return map
}

async function main() {
  const acks = loadAcks()

  const allRefs: Reference[] = []
  const allAnti: AntiPattern[] = []
  const allSelectTables: { table: string; file: string; line: number }[] = []

  let filesScanned = 0
  for (const file of walk(SRC_ROOT)) {
    if (!shouldScan(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    const { refs, anti, selectTables } = extractRefs(file, text)
    allRefs.push(...refs)
    allAnti.push(...anti)
    for (const st of selectTables) allSelectTables.push({ ...st, file })
    filesScanned++
  }

  const codeTables = new Map<string, Map<string, Reference[]>>()
  for (const ref of allRefs) {
    if (!codeTables.has(ref.table)) codeTables.set(ref.table, new Map())
    const colMap = codeTables.get(ref.table)!
    for (const col of ref.columns) {
      if (!colMap.has(col)) colMap.set(col, [])
      colMap.get(col)!.push(ref)
    }
  }

  const dbSchema = await fetchDbSchema()

  const missingColumns: { table: string; column: string; refs: Reference[] }[] = []
  const missingTables: { table: string; refs: Reference[] }[] = []
  const unusedColumns: { table: string; column: string }[] = []

  for (const [table, colMap] of codeTables) {
    if (!dbSchema.has(table)) {
      const allTableRefs: Reference[] = []
      for (const refs of colMap.values()) allTableRefs.push(...refs)
      const seen = new Set<string>()
      const dedup: Reference[] = []
      for (const r of allTableRefs) {
        const key = `${r.file}:${r.line}`
        if (!seen.has(key)) { seen.add(key); dedup.push(r) }
      }
      missingTables.push({ table, refs: dedup.slice(0, 5) })
      continue
    }
    const dbCols = dbSchema.get(table)!
    for (const [col, refs] of colMap) {
      if (!dbCols.has(col)) {
        const seen = new Set<string>()
        const dedup: Reference[] = []
        for (const r of refs) {
          const key = `${r.file}:${r.line}`
          if (!seen.has(key)) { seen.add(key); dedup.push(r) }
        }
        missingColumns.push({ table, column: col, refs: dedup.slice(0, 5) })
      }
    }
  }

  for (const [table, dbCols] of dbSchema) {
    const codeColMap = codeTables.get(table)
    if (!codeColMap) continue
    for (const col of dbCols) {
      if (!codeColMap.has(col)) {
        unusedColumns.push({ table, column: col })
      }
    }
  }

  // S233: SELECT-side missing-table check. De-dupe on (table, file, line)
  // and skip tables already flagged via INSERT/UPDATE missingTables (the
  // INSERT/UPDATE error message already pinpoints the table — we don't
  // need to repeat it from the SELECT side). selectMissingTables is what
  // the harness reports as additional drift on read paths only.
  const insertUpdateMissingTableNames = new Set(missingTables.map(mt => mt.table))
  const seenSelectMissing = new Set<string>()
  const selectMissingTables: { table: string; refs: { file: string; line: number }[] }[] = []
  const selectByTable = new Map<string, { file: string; line: number }[]>()
  for (const st of allSelectTables) {
    if (dbSchema.has(st.table)) continue
    if (insertUpdateMissingTableNames.has(st.table)) continue
    const k = `${st.table}|${st.file}:${st.line}`
    if (seenSelectMissing.has(k)) continue
    seenSelectMissing.add(k)
    if (!selectByTable.has(st.table)) selectByTable.set(st.table, [])
    selectByTable.get(st.table)!.push({ file: st.file, line: st.line })
  }
  for (const [table, refs] of selectByTable) {
    selectMissingTables.push({ table, refs: refs.slice(0, 5) })
  }

  let suppressedTables = 0
  let suppressedColumns = 0
  let suppressedAnti = 0
  let suppressedSelectTables = 0

  // S233: track which acks actually fire vs. sit unused. An ack that
  // never matches a real drift item is an "orphan" — likely the code
  // it covers got refactored away and the ack should be removed. We
  // mark each ack as fired if any drift item matched it during filter.
  const firedTables = new Set<string>()
  const firedColumns = new Set<string>()
  const firedWildcards = new Set<string>()
  const firedAnti = new Set<string>()

  const visibleMissingTables = SHOW_ALL ? missingTables : missingTables.filter(mt => {
    if (acks.missingTables.has(mt.table)) {
      suppressedTables++
      firedTables.add(mt.table)
      return false
    }
    return true
  })

  const visibleSelectMissingTables = SHOW_ALL ? selectMissingTables : selectMissingTables.filter(mt => {
    if (acks.missingTables.has(mt.table)) {
      suppressedSelectTables++
      firedTables.add(mt.table)
      return false
    }
    return true
  })

  const visibleMissingColumns = SHOW_ALL ? missingColumns : missingColumns.filter(mc => {
    if (acks.wildcards.has(mc.table)) {
      suppressedColumns++
      firedWildcards.add(mc.table)
      return false
    }
    if (acks.missingColumns.has(`${mc.table}.${mc.column}`)) {
      suppressedColumns++
      firedColumns.add(`${mc.table}.${mc.column}`)
      return false
    }
    return true
  })

  const visibleAnti = SHOW_ALL ? allAnti : allAnti.filter(a => {
    const rel = path.relative(process.cwd(), a.file)
    const key = `${rel}:${a.line}`
    if (acks.antipatterns.has(key)) {
      suppressedAnti++
      firedAnti.add(key)
      return false
    }
    return true
  })

  // Orphan detection: an ack listed in the file that no drift item
  // actually matched this run. Likely stale (the code was refactored
  // and the drift no longer exists, or the ack was always wrong).
  // We don't fail the build on these — just warn so they get cleaned up.
  const orphanTables    = [...acks.missingTables].filter(t => !firedTables.has(t))
  const orphanColumns   = [...acks.missingColumns].filter(c => !firedColumns.has(c))
  const orphanWildcards = [...acks.wildcards].filter(w => !firedWildcards.has(w))
  const orphanAnti      = [...acks.antipatterns].filter(a => !firedAnti.has(a))

  const W = '-'.repeat(72)
  console.log('Schema diff harness')
  console.log(W)
  console.log(`Files scanned:                ${filesScanned}`)
  console.log(`Tables referenced in code:    ${codeTables.size}`)
  console.log(`Tables in DB (public schema): ${dbSchema.size}`)
  console.log(`INSERT/UPDATE refs found:     ${allRefs.length}`)
  console.log('')

  let exitCode = 0

  if (visibleMissingColumns.length > 0) {
    exitCode = 1
    console.log('CRITICAL - code references column not in DB:')
    console.log(W)
    const byTable = new Map<string, typeof visibleMissingColumns>()
    for (const mc of visibleMissingColumns) {
      if (!byTable.has(mc.table)) byTable.set(mc.table, [])
      byTable.get(mc.table)!.push(mc)
    }
    const sortedTables = [...byTable.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [table, list] of sortedTables) {
      console.log(`  ${table}`)
      list.sort((a, b) => a.column.localeCompare(b.column))
      for (const mc of list) {
        const sites = mc.refs
          .map(r => `${path.relative(process.cwd(), r.file)}:${r.line}`)
          .join(', ')
        console.log(`    ${mc.column.padEnd(36)} ${mc.refs[0].kind} @ ${sites}`)
      }
    }
    console.log('')
  }

  if (visibleMissingTables.length > 0) {
    exitCode = 1
    console.log('CRITICAL - code references table not in DB (INSERT/UPDATE):')
    console.log(W)
    visibleMissingTables.sort((a, b) => a.table.localeCompare(b.table))
    for (const mt of visibleMissingTables) {
      const sites = mt.refs
        .map(r => `${path.relative(process.cwd(), r.file)}:${r.line}`)
        .join(', ')
      console.log(`  ${mt.table.padEnd(40)} ${sites}`)
    }
    console.log('')
  }

  if (visibleSelectMissingTables.length > 0) {
    exitCode = 1
    console.log('CRITICAL - code references table not in DB (SELECT FROM/JOIN):')
    console.log(W)
    visibleSelectMissingTables.sort((a, b) => a.table.localeCompare(b.table))
    for (const mt of visibleSelectMissingTables) {
      const sites = mt.refs
        .map(r => `${path.relative(process.cwd(), r.file)}:${r.line}`)
        .join(', ')
      console.log(`  ${mt.table.padEnd(40)} ${sites}`)
    }
    console.log('')
  }

  if (visibleAnti.length > 0) {
    console.log('Anti-patterns (INSERT without explicit column list):')
    console.log(W)
    for (const a of visibleAnti) {
      console.log(`  ${path.relative(process.cwd(), a.file)}:${a.line}  ${a.snippet}`)
    }
    console.log('')
  }

  if (VERBOSE && unusedColumns.length > 0) {
    console.log('Informational - DB columns no code INSERT/UPDATE touches:')
    console.log(W)
    const byTable = new Map<string, string[]>()
    for (const uc of unusedColumns) {
      if (!byTable.has(uc.table)) byTable.set(uc.table, [])
      byTable.get(uc.table)!.push(uc.column)
    }
    const sortedTables = [...byTable.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [table, cols] of sortedTables) {
      console.log(`  ${table}: ${cols.sort().join(', ')}`)
    }
    console.log('')
  }

  console.log(W)
  if (
    visibleMissingColumns.length === 0 &&
    visibleMissingTables.length === 0 &&
    visibleSelectMissingTables.length === 0
  ) {
    console.log('No drift detected.')
  } else {
    const tablesAffected = new Set(visibleMissingColumns.map(m => m.table)).size
    console.log(
      `Drift detected: ${visibleMissingTables.length + visibleSelectMissingTables.length} missing tables ` +
      `(${visibleMissingTables.length} write, ${visibleSelectMissingTables.length} read), ` +
      `${visibleMissingColumns.length} missing columns across ${tablesAffected} tables.`
    )
  }

  // S233: distinguish drift-items-suppressed (acks-applied) from
  // ack-file-listed (declared in the file). Orphans are listed-but-
  // not-applied — likely stale, should be removed. Fired counts are
  // the actual suppression activity for this run.
  const totalSuppressed = suppressedTables + suppressedColumns + suppressedAnti + suppressedSelectTables
  const totalAckLines =
    acks.missingTables.size + acks.missingColumns.size +
    acks.wildcards.size + acks.antipatterns.size
  if ((totalSuppressed > 0 || totalAckLines > 0) && !SHOW_ALL) {
    console.log(
      `Acks applied this run: ${suppressedTables + suppressedSelectTables} tables, ` +
      `${suppressedColumns} columns, ${suppressedAnti} anti-patterns ` +
      `(of ${totalAckLines} ack lines in file). Run with --all to see them.`
    )
  }

  const totalOrphans = orphanTables.length + orphanColumns.length + orphanWildcards.length + orphanAnti.length
  if (totalOrphans > 0) {
    console.log('')
    console.log(`Orphan acks (declared in file but didn't suppress anything this run):`)
    for (const t of orphanTables)    console.log(`  T:${t}`)
    for (const c of orphanColumns)   console.log(`  C:${c}`)
    for (const w of orphanWildcards) console.log(`  W:${w}`)
    for (const a of orphanAnti)      console.log(`  A:${a}`)
    console.log('Probably stale — remove unless still a known limitation.')
  }

  console.log(`Exit code: ${exitCode}`)

  await db.end()
  process.exit(exitCode)
}

main().catch(err => {
  console.error('Harness failed:', err)
  process.exit(2)
})
