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
const searchesABlob = (line: string): boolean =>
  /JSON\.stringify\s*\(/.test(line) || /\.text\s*\)\s*\.not\.to(Contain|Match)/.test(line)

/**
 * A comment is not an assertion. This file's own header quotes the banned line,
 * and so does noLeaks.ts — a guard that flags the explanation of what it bans
 * is a guard nobody can document.
 */
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line)

interface Gamble { file: string; line: number; needle: string; source: string }

function gamblesIn(file: string): Gamble[] {
  const found: Gamble[] = []
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (isComment(line) || !searchesABlob(line)) return
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
    const said = gambles.map(g =>
      `\n  ${g.file}:${g.line} looks for ${JSON.stringify(g.needle)} inside a stringified payload`
      + `\n      ${g.source}`
      + `\n      → a uuid is hex, so this passes or fails by luck. Use expectNoFigures(body, [${g.needle}])`
      + ` (apps/api/src/test/noLeaks.ts), which asks whether the figure came back as a value`
      + ` or inside a sentence — or assert on the field itself.`)
    expect(said.join('')).toBe('')
  })
})
