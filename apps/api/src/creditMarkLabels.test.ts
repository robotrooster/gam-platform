/**
 * 10/12 (Nic): "the payment history should be a health percentage. one mark
 * per invoice." A payment mark in the credit ledger is the whole BILL's now —
 * rent, utilities and fees on one invoice — so every screen that names one
 * says so per bill. The admin Disputes page still read "Rent paid on time"
 * after the landlord's screening page and the tenant's credit page had moved
 * to per-bill words. The three label maps are separate files (each app keeps
 * its own); this reads them as text and keeps the payment marks in step.
 * The event types themselves are unchanged.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const APPS = path.join(__dirname, '..', '..')

/** `key: 'label'` pairs of one object literal, by its declaration name. */
function labelMap(file: string, name: string): Record<string, string> {
  const src = readFileSync(path.join(APPS, file), 'utf8')
  const start = src.search(new RegExp(`const ${name}\\s*:\\s*Record<string,\\s*string>\\s*=\\s*\\{`))
  expect(start, `${file} has no ${name}`).toBeGreaterThan(-1)
  const body = src.slice(start, src.indexOf('\n}', start))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/^\s*([a-z_]+):\s*'([^']*)'/gm)) out[m[1]] = m[2]
  return out
}

const PAYMENT_MARKS = [
  'payment_received_on_time', 'payment_received_late_grace', 'payment_received_late_minor',
  'payment_received_late_major', 'payment_received_late_severe', 'payment_partial',
  'payment_failed_nsf', 'payment_skipped',
] as const

describe('credit mark labels read per bill on every screen (10/12)', () => {
  const admin = labelMap('admin/src/main.tsx', 'DISPUTE_EVENT_LABEL')
  const landlord = labelMap('landlord/src/pages/TenantScreeningPage.tsx', 'EVENT_LABEL')
  const tenant = labelMap('tenant/src/main.tsx', 'EVENT_LABEL')

  it('the admin Disputes page, the landlord screening page and the tenant credit page say the same thing', () => {
    for (const k of PAYMENT_MARKS) {
      expect(admin[k], `admin ${k}`).toBe(landlord[k])
      expect(tenant[k], `tenant ${k}`).toBe(landlord[k])
    }
  })

  it('a payment mark is the bill\'s, never "rent"', () => {
    expect(landlord.payment_received_on_time).toBe('Bill paid on time')
    for (const [where, map] of [['admin', admin], ['landlord', landlord], ['tenant', tenant]] as const) {
      for (const k of PAYMENT_MARKS) expect(map[k], `${where} ${k}`).not.toMatch(/\brent\b/i)
    }
  })
})
