/**
 * 10/22 — A SCOPE ROW BELONGS TO THE COMPANY THAT GRANTED IT, AND NOTHING MAY
 * READ ONE AS IF IT BELONGED TO THE PERSON.
 *
 * Three reads took the first row they found:
 *
 *   SELECT property_ids, all_properties FROM <scope table> WHERE user_id = $1 LIMIT 1
 *
 * The tables are keyed (user_id, landlord_id) and always were, so somebody
 * working for two owners had two rows and got whichever came back first: one
 * owner's properties answered, the other's were invisible to every list and
 * refused by every action — and a row that said all_properties answered for a
 * company that had granted nothing.
 *
 * Folding the management portal into the landlord portal is exactly what makes
 * people hold two grants (PM_FOLD_PLAN.md), so this guard holds the line: a
 * scope table is read either through the middleware that knows about companies,
 * or with the company named in the query itself.
 *
 * Same shape as the action-gap and determinism guards — a rule that holds
 * itself, rather than something everybody has to remember.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, it, expect } from 'vitest'

const SRC = join(__dirname, '..')
const SCOPE_TABLES = ['property_manager_scopes', 'onsite_manager_scopes', 'maintenance_worker_scopes']

/**
 * The reads that are allowed to take a person's rows without naming a company,
 * and why. Each one is a place that MEANS "every grant this person holds".
 */
const COMPANY_AWARE = new Map(Object.entries({
  'middleware/auth.ts':
    'the company-aware reads themselves: assertPropertyInScope finds the row of the company that owns the '
    + 'property being acted on, and getScopedPropertyIds unions every grant.',
  'routes/auth.ts':
    'builds the pass from EVERY grant (union), which is admission only — whether a permission was granted '
    + 'where it is being used is answered by assertPropertyInScope on the request.',
}))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.ts') && !name.includes('.test.')) out.push(full)
  }
  return out
}

/** The SQL statement a table name sits in, roughly: to the next semicolon or backtick. */
function statementAround(text: string, at: number): string {
  const start = Math.max(0, text.lastIndexOf('`', at) + 1)
  const endTick = text.indexOf('`', at)
  return text.slice(start, endTick === -1 ? at + 400 : endTick)
}

describe('a scope row is read with its company, or by the code that knows about companies', () => {
  it('nothing reads a worker scope table by user alone', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file)
      if (COMPANY_AWARE.has(rel)) continue
      const text = readFileSync(file, 'utf8')
      for (const table of SCOPE_TABLES) {
        let at = text.indexOf(table)
        while (at !== -1) {
          const stmt = statementAround(text, at)
          // A read that filters by the person and never names a company.
          const byUser = /\buser_id\s*=\s*\$\d/.test(stmt)
          const namesCompany = /landlord_id/.test(stmt)
          if (byUser && !namesCompany) {
            const line = text.slice(0, at).split('\n').length
            offenders.push(
              `\n  ${rel}:${line} reads ${table} by user_id with no company named`
              + `\n      → a person can hold a grant from several companies. Name the company in the query`
              + ` (the property names it), or go through middleware/auth.`)
          }
          at = text.indexOf(table, at + 1)
        }
      }
    }
    expect(offenders.join('')).toBe('')
  })

  it('and the places that may are named, with their reason', () => {
    // The allowlist is the documentation: if one of these stops being
    // company-aware, its entry is the thing that has to change with it.
    for (const [file, why] of COMPANY_AWARE) {
      expect(why.length, file).toBeGreaterThan(40)
      expect(() => statSync(join(SRC, file))).not.toThrow()
    }
  })
})
