/**
 * What a screening costs, pinned to the cent.
 *
 * 10/21 (Nic): nothing in the suite guarded the actual dollar figure. The price
 * had been built on a $2.95 ID scan that Checkr actually charges $3.95 for, and
 * on an add-on no order had ever asked for — and every test that touched the
 * price asked `screeningIntakeFee` for it, so the whole suite would have
 * followed the price silently wherever it drifted.
 *
 * This file is the one place that does NOT ask. The numbers are written out,
 * because they are what an applicant is charged on a card and what a landlord
 * is billed out of a payout, and a change to either should have to be made here
 * on purpose.
 *
 * The composition (Checkr's published Tenant pricing + PROCESSING_FEES):
 *   Checkr Tenant "Essential"            34.99   what Checkr invoices
 *   + Identity Intelligence add-on        3.95   the live ID scan / liveness
 *   = GAM's cost                         38.94
 *   + GAM's flat margin                   5.00
 *   = the check itself                   43.94   SAME on both routes
 *   + card processing (3.5% + 55c)        2.09   applicants only
 *   = what an applicant pays             46.03
 *
 * The landlord-billed route stops at 43.94: it is netted out of their next
 * payout, so no card is ever presented and there is no processing fee to add.
 * The check does not cost more because an applicant pays for it — the card
 * does.
 */
import { describe, it, expect } from 'vitest'
import { screeningIntakeFee } from './background'
import { PROCESSING_FEES } from '@gam/shared'

describe('what a screening costs', () => {
  it('is Checkr $38.94 + GAM $5 = $43.94, the same whoever pays', async () => {
    const f = await screeningIntakeFee(null)
    expect(f.screening).toBe(38.94)
    expect(f.gamFee).toBe(5)
    expect(Math.round((f.screening + f.gamFee) * 100) / 100).toBe(43.94)
  })

  it('adds the card fee only on top of that, for an applicant paying by card', async () => {
    const f = await screeningIntakeFee(null)
    expect(f.processing).toBe(2.09)
    expect(f.total).toBe(46.03)
    // The fee is on the subtotal, not baked into it — GAM eats no processing.
    const onSubtotal = Math.round((43.94 * PROCESSING_FEES.CARD_PCT + PROCESSING_FEES.CARD_FLAT) * 100) / 100
    expect(f.processing).toBe(onSubtotal)
  })

  it('collects no screening tax anywhere, because GAM is registered nowhere', async () => {
    // Two-layer gate: a state must be taxable AND registered. Until GAM
    // registers somewhere, every state is $0 and the total never moves.
    for (const state of ['AZ', 'IL', 'UT', 'NC', 'CA', 'TX']) {
      const f = await screeningIntakeFee(state)
      expect(f.tax).toBe(0)
      expect(f.total).toBe(46.03)
    }
  })
})
