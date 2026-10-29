/**
 * 10/18 (Nic) — WHEN THE DESK MAY ASK A GUEST FOR THEIR DEPOSIT.
 *
 *   "yeah, let's add a button so that we can collect deposits from people that
 *    haven't done it for their stays."
 *
 * One rule, read on both sides: the schedule offers the button by it and the
 * server refuses by it, so the screen can never offer something the server will
 * turn down. These are the four answers and the words that go with them.
 */
import { describe, it, expect } from 'vitest'
import { stayDepositAsk, STAY_DEPOSIT_ASK_REFUSAL, type BookingStatus } from './index'

const stay = (o: Partial<Parameters<typeof stayDepositAsk>[0]> = {}) => stayDepositAsk({
  status: 'tentative', guestEmail: 'dale@t.dev', ...o,
})

describe('whether a reservation can be asked for its deposit', () => {
  it('asks on a stay still holding its site with nobody\'s money on it', () => {
    // A soft hold, and one taken straight onto the board without a link — both
    // are reservations a paying guest can take until a deposit lands.
    expect(stay({ status: 'tentative' })).toBe('ask')
    expect(stay({ status: 'confirmed' })).toBe('ask')
  })

  it('refuses once there is money on it, whichever way it came', () => {
    expect(stay({ depositPaidAt: '2026-10-18T00:00:00Z' })).toBe('already_paid')
    expect(stay({ balancePaidAt: '2026-10-18T00:00:00Z' })).toBe('already_paid')
    expect(stay({ posTransactionId: 't1' })).toBe('already_paid')
    // Paid beats everything else, including a missing email.
    expect(stay({ guestEmail: null, depositPaidAt: '2026-10-18T00:00:00Z' })).toBe('already_paid')
  })

  it('refuses with nowhere to send it', () => {
    expect(stay({ guestEmail: null })).toBe('no_email')
    expect(stay({ guestEmail: '' })).toBe('no_email')
    expect(stay({ guestEmail: '   ' })).toBe('no_email')
    expect(stay({ guestEmail: undefined })).toBe('no_email')
  })

  it('stops asking once the stay is no longer holding its site', () => {
    for (const status of ['checked_in', 'checked_out', 'cancelled', 'no_show'] as BookingStatus[]) {
      expect(stayDepositAsk({ status, guestEmail: 'dale@t.dev' }), status).toBe('no_longer_holding')
    }
  })

  it('says why in words the desk can act on, and that nothing was sent', () => {
    for (const words of Object.values(STAY_DEPOSIT_ASK_REFUSAL)) {
      expect(words).toMatch(/Nothing was sent\.$/)
      expect(words).not.toMatch(/_/)          // no raw enum ever reaches a screen
    }
    expect(STAY_DEPOSIT_ASK_REFUSAL.no_email).toMatch(/Add the guest's email on the reservation, or take the deposit at the register/)
  })
})
