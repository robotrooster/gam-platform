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
 *
 * 10/31 — IT HAD TWO HOLES, AND A REAL MONEY BUG WAS SITTING IN ONE OF THEM.
 *
 * 1. It only looked for an EXPLICIT self-alias, `x::text AS x`. A cast with no
 *    alias at all keeps the column's name just the same: `SELECT balance::text`
 *    names the output column `balance`. That is how
 *    services/subleaseAllocation drew credit balances down in LEXICAL order —
 *    '900.00' ahead of '1000.00', because '9' sorts after '1' — while its
 *    `ORDER BY balance DESC` said largest-first. A qualified source is the same
 *    trap: `t.balance::text` also comes back named `balance`.
 *
 * 2. It skipped test files. A test that orders by a text-cast amount passes
 *    today because its two fixture amounts happen to sort the same both ways,
 *    and breaks the day somebody changes a fixture to $40 and $100 — the
 *    uuid-collision landmine wearing a different hat. Tests are scanned now.
 *
 * Still deliberately NOT caught, so this comment does not over-claim: a
 * `timestamptz` cast to text and ordered on sorts by the clock reading before
 * the offset, so the one hour a year the offset changes it can inverts. Column
 * TYPE is not knowable from the source text, and treating every `_at` as
 * suspect would flag a dozen plain dates that are all correct.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, it, expect } from 'vitest'

const SRC = join(__dirname, '..')

/**
 * ONLY A CAST TO TEXT IS THE TRAP, and this is the other thing the first
 * version got wrong once it started reading test files.
 *
 * `amount::float AS amount` with `ORDER BY amount` sorts the OUTPUT column too
 * — and that column is a float, so it sorts numerically and is exactly right.
 * Same for ::numeric and ::int. Dozens of those exist and all of them are
 * correct. What loses the ordering is text.
 */
const TEXT_TYPE = String.raw`(?:text|varchar|char)`

/** `<something>::text AS <name>` — a cast that keeps the column's own name. */
const SHADOWED = new RegExp(String.raw`(\w+)\s*::\s*${TEXT_TYPE}\b\s+AS\s+\1\b`, 'gi')

/**
 * A cast with NO alias, which keeps the column's name all the same.
 *
 * `SELECT balance::text` and `SELECT t.balance::text` both come back as an
 * output column called `balance`, so both shadow the real one. The negative
 * lookahead is what keeps a properly renamed cast out of this —
 * `balance::text AS bal` is the fix, not an offence.
 */
const UNALIASED_CAST = new RegExp(
  String.raw`(?:\b\w+\.)?\b(\w+)\s*::\s*${TEXT_TYPE}\b(?!\s+AS\b)`, 'gi')
// The \b after the type name is load-bearing: without it the type pattern
// backtracks to `tex`, the lookahead then sees `t AS bal` rather than ` AS bal`,
// and a properly renamed cast is reported as an offence.

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
  /(^|_)(date|at|on|month|day|time|from|through|until|period|year|week)(_|$)/i.test(column)

function everySource(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) everySource(full, out)
    // This file's own header quotes the offending SQL inside backticks, which
    // reads exactly like a statement. It is documentation, not a query.
    else if (name.endsWith('.ts') && name !== 'orderByNamesTheColumn.test.ts') out.push(full)
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
      // Both patterns can match the same cast, and one file can cast the same
      // column in several statements, so a site is reported once: by the column
      // and the statement it sits in.
      const seen = new Set<string>()
      const matches = [...text.matchAll(SHADOWED), ...text.matchAll(UNALIASED_CAST)]
      for (const m of matches) {
        const column = m[1]
        // `ORDER BY 1` is POSITIONAL and always means the first output column,
        // which is what it says. `SELECT 1::int` is not a column at all.
        if (/^\d+$/.test(column)) continue
        if (SORTS_THE_SAME_AS_TEXT(column)) continue
        const stmt = statementAround(text, m.index ?? 0)
        // `ORDER BY <column>` with nothing qualifying it.
        // `ORDER BY amount::numeric DESC` says what it means and is correct, so
        // the bare form must not match a name that casts for itself.
        const bare = new RegExp(`ORDER\\s+BY\\s+${column}\\b(?!\\s*::)`, 'i')
        const qualified = new RegExp(`ORDER\\s+BY\\s+\\w+\\.${column}\\b`, 'i')
        if (bare.test(stmt) && !qualified.test(stmt)) {
          const key = `${column}@${stmt.length}@${stmt.slice(0, 60)}`
          if (seen.has(key)) continue
          seen.add(key)
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
