/**
 * 10/23 — AN ORDER BY THAT LOOKS NUMERIC AND IS NOT.
 *
 * Postgres resolves an ORDER BY *name* against the query's OUTPUT columns
 * before the table's. So this, which reads like "newest first":
 *
 *   SELECT id::text AS id, ... FROM books_period_closes ORDER BY id DESC
 *
 * sorts the id as TEXT. Text puts '9' above '10', and '100' between them.
 *
 * It cost two deploy-gate runs on 10/23 and it was a real bug on real books: a
 * company whose close was row 9 and whose reopen was row 10 got the CLOSE back
 * as its latest row, for good — the integrity check compared a deliberately
 * reopened month against the stale snapshot and reported "a closed month's
 * balances changed" to the landlord, permanently. It passed in isolation and
 * failed under the full suite, because which side of a digit boundary the two
 * ids land on depends on how many rows the other tests wrote first.
 *
 * The fix is to qualify the ORDER BY with the table (`ORDER BY c.id DESC`), so
 * the name no longer matches an output column and the real column sorts. One of
 * the three sites in that file had always been written that way and was never
 * wrong, which is the whole proof.
 *
 * This guard holds the line: a query that renames a column to its own name
 * through a cast may not then ORDER BY that bare name. Same family as the
 * uuid-collision and determinism guards — no gamble, one answer, every time.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, it, expect } from 'vitest'

const SRC = join(__dirname, '..')

/** `<something>::<type> AS <name>` — a cast that keeps the column's own name. */
const SHADOWED = /(\w+)\s*::\s*\w+\s+AS\s+\1\b/gi

/**
 * A DATE CAST TO TEXT IS NOT THE TRAP. `due_date::text AS due_date` with
 * `ORDER BY due_date` sorts ISO dates as text, and ISO text order IS
 * chronological order — 2026-08-10 before 2026-09-01, both ways. There are a
 * dozen of those and they are all correct.
 *
 * The trap is a NUMBER cast to text, where the two orders genuinely differ:
 * '9' above '10', '100' between them. An id, a sequence, a count, an amount.
 */
const SORTS_THE_SAME_AS_TEXT = (column: string): boolean =>
  /(^|_)(date|at|month|day|time|from|through|until|period|year|week)(_|$)/i.test(column)

function everySource(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) everySource(full, out)
    else if (name.endsWith('.ts') && !name.includes('.test.')) out.push(full)
  }
  return out
}

/** The SQL template a match sits in — backtick to backtick. */
function statementAround(text: string, at: number): string {
  const start = text.lastIndexOf('`', at)
  const end = text.indexOf('`', at)
  return text.slice(start === -1 ? 0 : start, end === -1 ? at + 600 : end)
}

describe('an ORDER BY names the column, not an output column that shadows it', () => {
  it('no query casts a column to its own name and then orders by that bare name', () => {
    const offenders: string[] = []
    for (const file of everySource(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(SHADOWED)) {
        const column = m[1]
        if (SORTS_THE_SAME_AS_TEXT(column)) continue
        const stmt = statementAround(text, m.index ?? 0)
        // `ORDER BY <column>` with nothing qualifying it.
        const bare = new RegExp(`ORDER\\s+BY\\s+${column}\\b`, 'i')
        const qualified = new RegExp(`ORDER\\s+BY\\s+\\w+\\.${column}\\b`, 'i')
        if (bare.test(stmt) && !qualified.test(stmt)) {
          const line = text.slice(0, m.index ?? 0).split('\n').length
          offenders.push(
            `\n  ${relative(SRC, file)}:${line} selects \`${column}::… AS ${column}\` and then`
            + ` \`ORDER BY ${column}\``
            + `\n      → Postgres sorts the OUTPUT column, so a number sorts as text ('9' above '10').`
            + ` Qualify it: ORDER BY <alias>.${column}`)
        }
      }
    }
    expect(offenders.join('')).toBe('')
  })

  it('the scan reads the source at all', () => {
    expect(everySource(SRC).length).toBeGreaterThan(300)
  })
})
