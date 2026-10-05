/**
 * get_my_payment_methods — S655 (money plan Step 5, item L: keep the old bank).
 *
 * A tenant can now hold several banks. The tool reports EVERY one, and whether
 * each can be charged is read off that bank: a bank still waiting on its
 * microdeposits is not chargeable while the verified bank beside it still is.
 * Before, every bank borrowed the tenant-level ach_verified flag, and a bank
 * mid-verification (not attached to the Stripe customer yet) was missing.
 *
 * Same source as the portal (services/tenantBankMethods), on a real database
 * with Stripe faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { stripeFake, world } = vi.hoisted(() => {
  const world = {
    banks: [] as { id: string; last4: string }[],
    cards: [] as { id: string; last4: string }[],
    waiting: [] as { siId: string; pmId: string; last4: string; checking?: boolean }[],
    defaultId: null as string | null,
    failLists: false,
  }
  const stripeFake = {
    paymentMethods: {
      list: async (args: any) => {
        if (world.failLists) throw new Error('stripe down')
        return args.type === 'us_bank_account'
          ? { data: world.banks.map((b) => ({ id: b.id, type: 'us_bank_account',
              us_bank_account: { bank_name: 'Test Bank', last4: b.last4, routing_number: '110000000' } })) }
          : { data: world.cards.map((c) => ({ id: c.id, type: 'card',
              card: { brand: 'visa', last4: c.last4, exp_month: 12, exp_year: 2030, country: 'US' } })) }
      },
    },
    setupIntents: {
      list: async () => ({
        data: world.waiting.map((w) => ({
          id: w.siId, status: w.checking ? 'processing' : 'requires_action', created: 1759000000,
          next_action: w.checking ? null : { type: 'verify_with_microdeposits' },
          payment_method: { id: w.pmId, type: 'us_bank_account', us_bank_account: { bank_name: 'New Bank', last4: w.last4 } },
        })),
      }),
    },
    customers: {
      retrieve: async (id: string) => ({ id, invoice_settings: { default_payment_method: world.defaultId } }),
    },
  }
  return { stripeFake, world }
})
vi.mock('../../../lib/stripe', () => ({ getStripe: () => stripeFake }))

import { db } from '../../../db'
import { cleanupAllSchema, seedTenant } from '../../../test/dbHelpers'
import { getMyPaymentMethods } from './getMyPaymentMethods'

beforeEach(async () => {
  await cleanupAllSchema()
  world.banks = []; world.cards = []; world.waiting = []; world.defaultId = null; world.failLists = false
})

async function tenant(opts: { customer?: boolean; suspended?: boolean } = {}) {
  const c = await db.connect()
  try {
    const tenantId = await seedTenant(c)
    await c.query(
      `UPDATE tenants SET stripe_customer_id = $2, ach_verified = TRUE,
              ach_suspended_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END
        WHERE id = $1`,
      [tenantId, opts.customer === false ? null : 'cus_tool', opts.suspended === true])
    return { userId: '', role: 'tenant' as const, profileId: tenantId }
  } finally { c.release() }
}

describe('get_my_payment_methods', () => {
  it('reports every bank, each with its own state, and the card', async () => {
    const actor = await tenant()
    world.banks = [{ id: 'pm_old', last4: '1111' }]
    world.waiting = [{ siId: 'seti_new', pmId: 'pm_new', last4: '2222' }]
    world.cards = [{ id: 'pm_card', last4: '4242' }]
    world.defaultId = 'pm_old'
    const r: any = await getMyPaymentMethods.execute({}, actor as any)
    expect(r.ok).toBe(true)
    expect(r.hasPaymentMethod).toBe(true)
    expect(r.methods).toEqual([
      { id: 'pm_old', type: 'ach', bankName: 'Test Bank', last4: '1111', chargeable: true, verificationPending: false, isDefault: true },
      { id: 'pm_new', type: 'ach', bankName: 'New Bank', last4: '2222', chargeable: false, verificationPending: true, isDefault: false },
      { id: 'pm_card', type: 'card', brand: 'visa', last4: '4242', chargeable: true, verificationPending: false, isDefault: false },
    ])
    // Never a full account number or routing number.
    expect(JSON.stringify(r)).not.toMatch(/110000000|routing/)
  })

  it('a new bank verifying beside a verified one: the note says the old one still works', async () => {
    const actor = await tenant()
    world.banks = [{ id: 'pm_old', last4: '1111' }]
    world.waiting = [{ siId: 'seti_new', pmId: 'pm_new', last4: '2222' }]
    const r: any = await getMyPaymentMethods.execute({}, actor as any)
    expect(r.note).toMatch(/A new bank is still verifying/)
    expect(r.note).toMatch(/other, verified bank still works/)
  })

  it('a bank verifying with no other bank: pay by card meanwhile', async () => {
    const actor = await tenant()
    world.waiting = [{ siId: 'seti_new', pmId: 'pm_new', last4: '2222' }]
    const r: any = await getMyPaymentMethods.execute({}, actor as any)
    expect(r.methods).toHaveLength(1)
    expect(r.methods[0]).toMatchObject({ chargeable: false, verificationPending: true })
    expect(r.note).toMatch(/pay by card in the meantime/)
  })

  it('with bank payments suspended no bank is offered as chargeable', async () => {
    const actor = await tenant({ suspended: true })
    world.banks = [{ id: 'pm_old', last4: '1111' }]
    world.cards = [{ id: 'pm_card', last4: '4242' }]
    const r: any = await getMyPaymentMethods.execute({}, actor as any)
    expect(r.methods.find((m: any) => m.id === 'pm_old').chargeable).toBe(false)
    expect(r.methods.find((m: any) => m.id === 'pm_card').chargeable).toBe(true)
    expect(r.note).toMatch(/Bank payments are switched off/)
  })

  it('no payment setup yet: no methods, and says where to add one', async () => {
    const actor = await tenant({ customer: false })
    const r: any = await getMyPaymentMethods.execute({}, actor as any)
    expect(r).toMatchObject({ ok: true, hasPaymentMethod: false, methods: [] })
    expect(r.note).toMatch(/Payments section/)
  })

  it('a Stripe failure is reported honestly, never as "no methods"', async () => {
    const actor = await tenant()
    world.failLists = true
    const r: any = await getMyPaymentMethods.execute({}, actor as any)
    expect(r).toMatchObject({ ok: false, error: 'could_not_check' })
  })

  // Fix round 1: a bank whose deposits Stripe is checking (its setup is
  // processing) was missing from the list. It is listed as not chargeable, and
  // the note does not tell the tenant to do a step they already did.
  it('a bank Stripe is checking is listed, and the note says there is nothing left for the tenant to do', async () => {
    const actor = await tenant()
    world.banks = [{ id: 'pm_old', last4: '1111' }]
    world.waiting = [{ siId: 'seti_chk', pmId: 'pm_chk', last4: '5555', checking: true }]
    const r: any = await getMyPaymentMethods.execute({}, actor as any)
    expect(r.methods.find((m: any) => m.id === 'pm_chk'))
      .toMatchObject({ type: 'ach', last4: '5555', chargeable: false, verificationPending: true })
    expect(r.note).toMatch(/Stripe is checking it now — there is nothing more for them to do/)
    expect(r.note).toMatch(/other, verified bank still works meanwhile/)
    expect(r.note).not.toMatch(/must finish the verification/)
  })
})
