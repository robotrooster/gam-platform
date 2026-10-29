/**
 * 10/22 (Nic) — A TEST IS NEVER A GAMBLE.
 *
 *   "We're not having anything be any sort of gamble. Something needs to
 *    operate the same way every time, no matter how. There needs to be a set of
 *    rules that something is derived from, and it needs to handle it accurately
 *    every single time."
 *
 * He said it about a privacy test that went red on a deploy and green an hour
 * earlier. It read like this:
 *
 *   expect(JSON.stringify(seen)).not.toContain('14')
 *
 * The rule it was testing — the first door says "August of 2024" and never the
 * 14th — was never in doubt. The ASSERTION was a coin flip: the row carries a
 * random id, a uuid is hexadecimal, and a two-character digit string lands
 * inside one about one run in six. It failed on …-49b521f3a147.
 *
 * Stringifying a payload and searching it for a bare number asks the wrong
 * question. "Does this text contain the characters 1-4 anywhere" is not "did we
 * tell this landlord the 14th", and the gap between the two is filled by random
 * ids nobody is reading.
 *
 * SO THE QUESTION IS ASKED OF VALUES, BY ONE RULE, IN ONE PLACE. A figure has
 * leaked when it comes back as:
 *   • a NUMBER equal to it, anywhere in the payload (JSON money is a number);
 *   • a STRING equal to it, anywhere ("700", "700.00", "$700.00");
 *   • a WHOLE WORD inside readable prose — a string with a space in it, which
 *     is a sentence somebody reads ("you still owe $700 for August").
 *
 * And it has NOT leaked when those characters merely occur inside a generated
 * token — a uuid, a Stripe id, a test email. Those have no spaces, so the prose
 * rule never looks at them, and they are never equal to a figure. There is no
 * probability left in the answer: the same payload gives the same verdict every
 * run, on any machine, forever.
 *
 * This is deliberately STRONGER than the substring check it replaces, not
 * weaker: `/700/` over a blob misses `70` + `0` split across fields and hits
 * `1700`, while this catches a sentence that says 700 and ignores a uuid that
 * happens to spell it.
 *
 * A needle with a letter, a space or a symbol in it (a name, a park, "May 1",
 * "pedestal") has no uuid to collide with, so those keep the plain substring
 * check — a name buried in the middle of an email body is exactly what wants
 * catching there. testsAreDeterministic.test.ts holds that line: a digit-only
 * needle searched through a stringified payload fails the suite.
 */
import { expect } from 'vitest'

/** 8-4-4-4-12 hex, the shape every generated id in GAM has. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const UUID_WHOLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A figure to look for: given as a number or as the string it would print as. */
export type Figure = string | number

/** Where a figure turned up, in words a person can act on. */
export interface Leak {
  figure: string
  /** 'a.b.2.amount' — the path to the value that gave it away. */
  at: string
  /** What that value actually was. */
  value: string
}

/**
 * The figure as a number, when it IS one. A needle with a leading zero —
 * "0199", a bank's last four — is an identifier, not an amount: reading it as
 * 199 would call a $199 charge somewhere else in the payload a leak.
 */
const asNumber = (f: Figure): number | null => {
  const raw = String(f).replace(/[$,]/g, '')
  if (/^0\d/.test(raw)) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * A GENERATED TOKEN, which nobody reads and which therefore cannot leak
 * anything. Three shapes cover every one GAM makes:
 *   • a uuid — every id in the database;
 *   • an address — anything with an @ in it, which is how test emails are made
 *     unique (`razo-${Math.random().toString(36)}@example.com`);
 *   • a run of eight or more letters-and-digits together — a Stripe id
 *     (`cs_test_k3h1100xq`), a mock message id, an import key.
 * Everything else is something a person reads: a sentence, a date, a town, a
 * label. Those get looked at.
 */
const isGeneratedToken = (s: string): boolean => {
  if (UUID_WHOLE.test(s)) return true
  if (s.includes('@')) return true
  return (s.match(/[a-z0-9]{8,}/gi) ?? []).some(run => /[a-z]/i.test(run) && /[0-9]/.test(run))
}

/**
 * The figure standing on its own — `700` matches "owe $700 now", "700.00" and
 * "2024-08-14"'s own parts, but never `1700`, `7001` or the `12` inside an
 * invoice number like `INV-ab12cd`. A figure that is wedged against another
 * letter or digit is not a figure anybody can read off the screen.
 */
const wholeWord = (figure: string): RegExp =>
  new RegExp(`(?<![0-9A-Za-z.])${figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`)

/**
 * Every place one of `figures` shows up in `payload`, by the rule above.
 * Returns an empty array when none of them did.
 */
export function figureLeaks(payload: unknown, figures: readonly Figure[]): Leak[] {
  const found: Leak[] = []
  const walk = (v: unknown, at: string): void => {
    if (v == null) return
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}${at ? '.' : ''}${i}`)); return }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        walk(x, `${at}${at ? '.' : ''}${k}`)
      }
      return
    }
    for (const f of figures) {
      const needle = String(f)
      let hit = false
      if (typeof v === 'number') {
        const n = asNumber(f)
        hit = n != null && v === n
      } else {
        const s = String(v)
        // Equal outright, or said out loud inside a sentence. A generated token
        // is neither, which is the whole point.
        hit = s === needle
          || (asNumber(f) != null && asNumber(s.replace(/[$,]/g, '')) === asNumber(f))
          || (!isGeneratedToken(s) && wholeWord(needle).test(s))
      }
      if (hit) found.push({ figure: needle, at: at || '(root)', value: String(v) })
    }
  }
  walk(payload, '')
  return found
}

/**
 * Fails, naming the field, when any of `figures` comes back in `payload`.
 * This is the one to reach for — it says what leaked and where.
 */
export function expectNoFigures(payload: unknown, figures: readonly Figure[]): void {
  const leaks = figureLeaks(payload, figures)
  // One string rather than an array, so the failure PRINTS the field instead of
  // "expected [ Array(1) ] to deeply equal []".
  const said = leaks.map(l => `${l.figure} at ${l.at} ("${l.value}")`).join('; ')
  expect(said || 'nothing leaked').toBe('nothing leaked')
}

/**
 * The same guarantee for a body that is not JSON — a CSV, an HTML page, an
 * email. Every generated id is taken out first, so a substring search cannot
 * land inside one, and then the figure is looked for as a whole word.
 */
export function expectNoFiguresInText(text: string, figures: readonly Figure[]): void {
  const clean = String(text).replace(UUID, '«id»')
  const said = figures.filter(f => wholeWord(String(f)).test(clean)).map(String).join('; ')
  expect(said || 'nothing leaked').toBe('nothing leaked')
}
