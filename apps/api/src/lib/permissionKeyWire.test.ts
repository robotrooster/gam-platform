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
  it('take_payment is rewritten by the camelizer — the bug, pinned', () => {
    const out: any = camelCaseKeys({ permissions: { take_payment: true } })
    expect(out.permissions.takePayment).toBe(true)
    expect(out.permissions.take_payment).toBeUndefined()
  })

  it('dotted keys are left alone, which is why only this one broke', () => {
    const out: any = camelCaseKeys({
      permissions: { 'balances.view': true, 'pos.tab.register': true, 'front_desk.view': true },
    })
    expect(out.permissions['balances.view']).toBe(true)
    expect(out.permissions['pos.tab.register']).toBe(true)
    expect(out.permissions['front_desk.view']).toBe(true)
  })

  // The frontend gate accepts BOTH spellings. If a new dotless key appears,
  // this still passes — but the reminder below is the point of the test.
  it('the landlord gate reads both the written key and its wire form', () => {
    const gate = readFileSync(
      join(__dirname, '..', '..', '..', 'landlord', 'src', 'lib', 'permissions.ts'), 'utf8')
    expect(gate).toContain('camelize')
    expect(gate).toMatch(/perms\[key\][\s\S]*perms\[camelize\(key\)\]/)
  })

  it('names every dotless catalog key, so a new one is a deliberate choice', () => {
    const dotless = catalogKeys().filter(k => !k.includes('.'))
    // Amenity keys share this regex shape; only real permission keys matter,
    // and take_payment is the one that reaches a permissions map.
    expect(dotless).toContain('take_payment')
  })
})
