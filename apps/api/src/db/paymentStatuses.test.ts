/**
 * Single source of truth for payments.status (CLAUDE.md: enums and CHECKs
 * never drift). packages/shared PAYMENT_STATUSES lists exactly the values the
 * database's payments_status_check allows — including 'voided' (decisions
 * #48.5, migration 20261004530000_payments_voided_status) — and every one of
 * them has plain words on a screen (PAYMENT_STATUS_LABEL).
 */
import { describe, it, expect } from 'vitest'
import { PAYMENT_STATUSES, PAYMENT_STATUS_LABEL } from '@gam/shared'
import { db } from './index'

describe('payments.status: the shared list and the database agree', () => {
  it('PAYMENT_STATUSES is exactly what payments_status_check allows, voided included', async () => {
    const def = (await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'payments_status_check' AND conrelid = 'payments'::regclass`)).rows[0]?.def ?? ''
    const allowed = [...def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort()
    expect(allowed).toEqual([...PAYMENT_STATUSES].sort())
    expect(allowed).toContain('voided')
  })

  it('every payment status has its own plain words, and a voided charge reads "Voided"', () => {
    for (const st of PAYMENT_STATUSES) {
      expect(PAYMENT_STATUS_LABEL[st]).toMatch(/^[A-Z][a-z ]+$/)
    }
    expect(PAYMENT_STATUS_LABEL.voided).toBe('Voided')
    expect(Object.keys(PAYMENT_STATUS_LABEL).sort()).toEqual([...PAYMENT_STATUSES].sort())
  })
})
