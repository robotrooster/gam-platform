/**
 * 10/22 (Nic) — NO TEST IN GAM IS ALLOWED TO BE A GAMBLE.
 *
 *   "We're not having anything be any sort of gamble. Something needs to
 *    operate the same way every time... there needs to be a set of rules that
 *    something is derived from, and it needs to handle it accurately every
 *    single time."
 *
 * One shape of assertion cannot keep that promise, and it cost a deploy on
 * 10/22:
 *
 *   expect(JSON.stringify(seen)).not.toContain('14')
 *
 * Every id GAM generates is a uuid, a uuid is hexadecimal, and so a digit-only
 * needle searched through a stringified payload lands inside an id by luck —
 * about one run in six for two characters, one in a hundred and fifty for
 * three. Green locally, red on the gate, with nothing wrong with the code.
 *
 * So the shape is banned, by this test, across every suite in the repo. What to
 * do instead is test/noLeaks.ts: `expectNoFigures(body, [700])` asks whether a
 * figure came back as a value or inside a sentence — the real question — and
 * gives the same answer every run.
 *
 * A needle with a letter, a space or a symbol in it is NOT banned: "RV 05",
 * "pedestal", "May 1", "Secretname" cannot occur inside a uuid, and a plain
 * substring search is the stronger check for those (a name buried in the middle
 * of an email body is exactly what wants catching).
 *
 * This is the same kind of guard as emailLinksAreReal (no localhost in a real
 * email) and pos-parity (two files that must stay identical): a rule that holds
 * itself, instead of a thing everybody has to remember.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, it, expect } from 'vitest'

/** The repo root, from apps/api/src/test. */
const ROOT = join(__dirname, '..', '..', '..', '..')

function everyTestFile(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === 'coverage') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) everyTestFile(full, out)
    else if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) out.push(full)
  }
  return out
}

/** `.not.toContain('…')` — the needle it is looking for. */
const NOT_CONTAIN = /\.not\.toContain\(\s*(['"`])(.*?)\1\s*\)/g
/** `.not.toMatch(/a|b|c/)` — each alternative is its own needle. */
const NOT_MATCH = /\.not\.toMatch\(\s*\/([^/\n]+)\/[gimsuy]*\s*\)/g

/** Could these characters turn up inside a uuid? Hexadecimal, so: digits can. */
const canHideInAnId = (needle: string): boolean => /^[0-9a-f]+$/i.test(needle)

/**
 * Is this assertion searching TEXT for a substring, rather than asking about a
 * value? Those are the ones a random id can poison: a stringified payload, or a
 * raw response body.
 */
const searchesABlob = (line: string, blobVars: Set<string>): boolean => {
  if (/JSON\.stringify\s*\(/.test(line)) return true
  if (/\.text\s*\)\s*\.not\.to(Contain|Match)/.test(line)) return true
  // 11/01 — THE PER-LINE HOLE, AND IT LET A REAL GAMBLE THROUGH.
  //
  // This test used to decide line by line, so hoisting the stringify into a
  // local walked straight past it:
  //
  //     const text = JSON.stringify(r.body)
  //     expect(text).not.toContain('900')     // ← invisible to the guard
  //
  // That is exactly what happened on 10/31 in a brand-new file, on the
  // contractor marketplace's most important privacy rule (one contractor must
  // never see another's bid). The board payload carries uuids, so that
  // assertion passed or failed by luck — the thing this file exists to stop.
  // Variables assigned from a stringify are now tracked across the file and
  // searching one of them counts.
  for (const v of blobVars) {
    if (new RegExp(`\\b${v}\\b\\s*\\)?\\s*\\.not\\.to(Contain|Match)`).test(line)) return true
    if (new RegExp(`expect\\(\\s*${v}\\s*\\)`).test(line)) return true
  }
  return false
}

/**
 * Locals assigned from a BARE `new Date()` — the wall clock, with no argument.
 *
 * 11/01: the rule below catches `new Date().toISOString().slice(0,10)` written
 * as one expression, but the same bug hides behind a local and a step:
 *
 *     const d = new Date(); d.setDate(d.getDate() - 1)
 *     return d.toISOString().slice(0, 10)       // ← still the UTC calendar
 *
 * That one had quietly made "yesterday" equal to GAM's today, because UTC is
 * already tomorrow after 5pm Phoenix. A local assigned from `new Date(arg)` is
 * NOT tracked: building from a date string at noon is the safe, deliberate
 * pattern this file must not punish.
 */
function wallClockVarsIn(lines: string[]): Set<string> {
  const vars = new Set<string>()
  for (const line of lines) {
    if (isComment(line)) continue
    for (const m of line.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new Date\(\s*\)/g)) {
      vars.add(m[1])
    }
  }
  return vars
}

/** Locals assigned from a stringified payload, which are blobs by any other name. */
function blobVarsIn(lines: string[]): Set<string> {
  const vars = new Set<string>()
  for (const line of lines) {
    if (isComment(line)) continue
    const m = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*JSON\.stringify\s*\(/)
    if (m) vars.add(m[1])
  }
  return vars
}

/**
 * 11/01 — A UTC CALENDAR DAY IN A TEST IS A SEVEN-HOUR GAMBLE.
 *
 * `new Date().toISOString().slice(0, 10)` is TODAY IN UTC. The database's
 * CURRENT_DATE, and every report and bill in GAM, run on the home calendar
 * (America/Phoenix), which UTC is ahead of from 5pm until midnight. So a
 * fixture built this way puts tomorrow's date on a bill for seven hours of
 * every day, and the test that reads it back fails only in that window.
 *
 * This bit FOUR times on 31 October alone — the pay-ahead suggestion, the
 * card-reader installment schedule, and the report summary that ties to its own
 * P&L — and it is a documented recurring landmine before that. Two of the four
 * were real production bugs, not just test noise.
 *
 * Only a BARE `new Date()` is flagged. An offset date (`Date.now() + N`) is a
 * relative day whose exact value no assertion usually turns on, and flagging
 * those would make this noisy enough to be allowlisted, which is how a guard
 * rots. The fix is always `todayIn(null)` from apps/api/src/lib/timezone.ts, or
 * `SELECT CURRENT_DATE` in a fixture.
 */
const UTC_TODAY = /new Date\(\)\s*\.toISOString\(\)\s*\.(?:slice\(0, ?10\)|substring\(0, ?10\)|split\('T'\)\[0\])/

/**
 * A comment is not an assertion. This file's own header quotes the banned line,
 * and so does noLeaks.ts — a guard that flags the explanation of what it bans
 * is a guard nobody can document.
 */
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line)

interface Gamble { file: string; line: number; needle: string; source: string }

function gamblesIn(file: string): Gamble[] {
  const found: Gamble[] = []
  const lines = readFileSync(file, 'utf8').split('\n')
  const blobVars = blobVarsIn(lines)
  const clockVars = wallClockVarsIn(lines)
  const utcDayFromAClockVar = (line: string): boolean => {
    for (const v of clockVars) {
      if (new RegExp(`\\b${v}\\b\\s*\\.toISOString\\(\\)\\s*\\.(?:slice\\(0, ?10\\)|substring\\(0, ?10\\)|split\\('T'\\)\\[0\\])`).test(line)) return true
    }
    return false
  }
  lines.forEach((line, i) => {
    if (!isComment(line) && (UTC_TODAY.test(line) || utcDayFromAClockVar(line))) {
      found.push({ file: relative(ROOT, file), line: i + 1, needle: '__utc_today__',
                   source: line.trim().slice(0, 120) })
    }
    if (isComment(line) || !searchesABlob(line, blobVars)) return
    const needles: string[] = []
    for (const m of line.matchAll(NOT_CONTAIN)) needles.push(m[2])
    for (const m of line.matchAll(NOT_MATCH)) needles.push(...m[1].split('|'))
    for (const n of needles) {
      if (n && canHideInAnId(n)) {
        found.push({ file: relative(ROOT, file), line: i + 1, needle: n, source: line.trim().slice(0, 120) })
      }
    }
  })
  return found
}

describe('no test decides anything by luck', () => {
  it('nowhere in the repo does an absence check search a payload for bare digits', () => {
    const files = everyTestFile(join(ROOT, 'apps')).concat(everyTestFile(join(ROOT, 'packages')))
    // Sanity: the walk found the suite, not an empty directory.
    expect(files.length).toBeGreaterThan(500)

    const gambles = files.flatMap(gamblesIn)
    const said = gambles.map(g => g.needle === '__utc_today__'
      ? `\n  ${g.file}:${g.line} builds a calendar day from the UTC clock`
        + `\n      ${g.source}`
        + `\n      → that is TOMORROW from 5pm Phoenix until midnight, while the database's`
        + ` CURRENT_DATE and every bill, due date and report are on the home calendar.`
        + ` Use todayIn(null) (apps/api/src/lib/timezone.ts), or SELECT CURRENT_DATE in a fixture.`
      : `\n  ${g.file}:${g.line} looks for ${JSON.stringify(g.needle)} inside a stringified payload`
        + `\n      ${g.source}`
        + `\n      → a uuid is hex, so this passes or fails by luck. Use expectNoFigures(body, [${g.needle}])`
        + ` (apps/api/src/test/noLeaks.ts), which asks whether the figure came back as a value`
        + ` or inside a sentence — or assert on the field itself.`)
    expect(said.join('')).toBe('')
  })
})
