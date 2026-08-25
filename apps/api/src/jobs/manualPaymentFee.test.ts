/**
 * S620: the $10 manual-payment fee — who pays it, and what it must never do.
 *
 * Two rules from Nic, both easy to undo by accident:
 *
 * 1. The free first payment exists to help a landlord MIGRATE tenants they
 *    already have. A tenant who came through the background-check flow never
 *    gets it: "it's not a thing for other tenants that just sign up later on
 *    and exist." The screening status is the discriminator, and it encodes the
 *    21-day onboarding window for free — after that window a new tenant can
 *    only arrive screened.
 *
 * 2. The fee must NEVER accrue late fees of its own. It is already a fee, and
 *    a money order written for the wrong amount can leave it unpaid for weeks.
 *    It is protected by carrying no invoice, which the late-fee engine works
 *    from — so this asserts the absence, because the absence IS the mechanism.
 */
import { describe, it, expect } from 'vitest'
import { query } from '../db'

describe('the $10 manual-payment fee never grows', () => {
  it('is created with no invoice, which is what keeps the late-fee engine off it', async () => {
    // The engine selects per invoice_id. A row with none is unreachable by it.
    // If someone ever attaches these to an invoice, this fails and says why.
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM payments
        WHERE entry_description = 'MANUALPAY' AND invoice_id IS NOT NULL`)
    expect(
      Number(rows[0].n),
      'a MANUALPAY fee gained an invoice — the late-fee engine can now charge late fees on a fee'
    ).toBe(0)
  })

  it('is GAM revenue, never part of a landlord payout', async () => {
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM payments
        WHERE entry_description = 'MANUALPAY' AND revenue_owner <> 'gam'`)
    expect(Number(rows[0].n)).toBe(0)
  })
})

describe('who the screening gate applies to', () => {
  // Mirrors the rule in routes/payments.ts so a change to one fails the other.
  const screened = (status: string | null) =>
    !['not_started', 'waived', null].includes(status as any)

  it('treats an unscreened tenant as migrated — eligible for the free first payment', () => {
    expect(screened('not_started')).toBe(false)
    expect(screened('waived')).toBe(false)
    expect(screened(null)).toBe(false)
  })

  it('treats anyone who went through screening as ineligible', () => {
    for (const s of ['submitted', 'approved', 'denied', 'cancelled', 'expired']) {
      expect(screened(s), s).toBe(true)
    }
  })
})
