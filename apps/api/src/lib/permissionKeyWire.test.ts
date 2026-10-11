/**
 * S641 — a permission key is DATA inside a camelized response.
 *
 * Nic: "she's missing the record payments buttons from everybody's invoices…
 * she cannot record a payment still."
 *
 * The cause: `take_payment` is the only permission key in the catalog with no
 * dot in it, so it is the only one the response camelizer rewrites. It reaches
 * the browser as `takePayment`, `can('take_payment')` was false for somebody
 * who genuinely held it, and gating the Record payment button on that key made
 * the button disappear for the one person who needed it.
 *
 * This guard is about the SHAPE, so the next dotless key is caught before
 * somebody gates a button on it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { camelCaseKeys } from './caseConversion'

function catalogKeys(): string[] {
  const src = readFileSync(join(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'src', 'index.ts'), 'utf8')
  const start = src.indexOf('PERMISSION_CATALOG')
  const region = start >= 0 ? src.slice(start) : src
  return [...new Set([...region.matchAll(/\{\s*key:\s*'([a-z0-9_.]+)'/g)].map(m => m[1]))]
}

describe('permission keys survive the wire', () => {
  // FIXED at the source: the camelizer keeps any key in the permission catalog
  // exactly as written, rather than only keys that happen to contain a dot.
  it('take_payment reaches the browser under its own name', () => {
    const out: any = camelCaseKeys({ permissions: { take_payment: true } })
    expect(out.permissions.take_payment).toBe(true)
    expect(out.permissions.takePayment).toBeUndefined()
  })

  it('every catalog key survives verbatim, dotted or not', () => {
    const keys = catalogKeys()
    const perms = Object.fromEntries(keys.map(k => [k, true]))
    const out: any = camelCaseKeys({ permissions: perms })
    const mangled = keys.filter(k => out.permissions[k] !== true)
    expect(mangled, `these permission keys were rewritten on the wire:\n  ${mangled.join('\n  ')}`).toEqual([])
  })

  // Belt as well as braces. The server no longer mangles the key, and the
  // landlord gate also accepts the camelized spelling — so a stale bundle, an
  // older token, or the next converter change cannot take the button away
  // again. Two independent fixes for one outage that cost a front desk an
  // afternoon.
  it('the landlord gate accepts the written key AND its camel form', () => {
    const gate = readFileSync(
      join(__dirname, '..', '..', '..', 'landlord', 'src', 'lib', 'permissions.ts'), 'utf8')
    expect(gate).toContain('camelize')
    expect(gate).toMatch(/perms\[key\][\s\S]*perms\[camelize\(key\)\]/)
  })

  it('ordinary response fields are still camelized — the carve-out is narrow', () => {
    const out: any = camelCaseKeys({ unit_number: 'RV 12', due_date: '2026-09-01' })
    expect(out.unitNumber).toBe('RV 12')
    expect(out.dueDate).toBe('2026-09-01')
  })
})
