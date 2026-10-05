/**
 * 10/3: what a register sale owes the landlord. A reader card sale that landed
 * on GAM's account is owed to the landlord, less GAM's card fee. Cash and
 * store-account sales never are (the money is in the landlord's drawer or on
 * their books already).
 *
 * 10/4 (early check-out plan, BUG-A): a card ON FILE is charged on GAM's
 * account too, so its sale is owed to the landlord the same way — it used to
 * return 0, and the landlord was never paid for it.
 */
import { describe, it, expect } from 'vitest'
import { cardPayoutOwed } from './posSale'

describe('what a register sale owes the landlord', () => {
  it('a reader card sale is owed to the landlord, less GAM\'s card fee', () => {
    expect(cardPayoutOwed({ paymentMethod: 'card', total: 52.17, surcharge: 2.17, stripePaymentIntentId: 'pi_card' } as any)).toBe(50)
  })

  it('a card-on-file sale is owed to the landlord the same way (BUG-A)', () => {
    expect(cardPayoutOwed({ paymentMethod: 'card_on_file', total: 52.17, surcharge: 2.17, stripePaymentIntentId: 'pi_cof' } as any)).toBe(50)
    expect(cardPayoutOwed({ paymentMethod: 'card_on_file', total: 52.17, surcharge: 0, stripePaymentIntentId: 'pi_cof', payoutOwed: 50.3 } as any)).toBe(50.3)
    expect(cardPayoutOwed({ paymentMethod: 'card_on_file', total: 20, surcharge: 0, stripePaymentIntentId: null } as any)).toBe(0)
  })

  it('cash, store-account, and a card sale with no PaymentIntent are never owed', () => {
    expect(cardPayoutOwed({ paymentMethod: 'cash', total: 20, surcharge: 0, stripePaymentIntentId: null } as any)).toBe(0)
    expect(cardPayoutOwed({ paymentMethod: 'charge', total: 20, surcharge: 0, stripePaymentIntentId: null } as any)).toBe(0)
    expect(cardPayoutOwed({ paymentMethod: 'card', total: 20, surcharge: 1, stripePaymentIntentId: null } as any)).toBe(0)
  })

  it('a payout amount set by the caller wins over total less surcharge', () => {
    expect(cardPayoutOwed({ paymentMethod: 'card', total: 52.17, surcharge: 2.17, stripePaymentIntentId: 'pi_x', payoutOwed: 49.5 } as any)).toBe(49.5)
  })
})
