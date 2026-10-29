/**
 * 10/12 (Nic) — GAM Books ledger, phase P5: the register posts itself
 * (gam-ledger-design-2026-10-12 §6 F1, F2, F3, F5; Nic's 10/12 answers L8, G10).
 * Real tables, real capture triggers, the real engine (it commits on its own
 * connections, so every test starts from a clean database).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../../db'
import { cleanupAllSchema } from '../../test/dbHelpers'
import { ledgerCompany } from '../../test/ledgerFixtures'
import { registerP5, unregisterAll, sale, booking, active, balance, received, waiting } from '../../test/ledgerP5Fixtures'
import { drainLedgerOutbox } from '../ledgerEngine'
import { LEDGER_REGISTER_STOCK_METHODS, DEFAULT_LEDGER_REGISTER_STOCK_METHOD } from '@gam/shared'

beforeEach(async () => {
  await cleanupAllSchema()
  registerP5()
})
afterEach(() => unregisterAll())

const TPT = (amount: number) => [{ name: 'Transaction privilege tax', rate: 0.066, amount }]
const brief = (ls: Awaited<ReturnType<typeof active>>) => ls.map(l => [l.role, l.dr, l.cr, l.cash, l.cat])

describe('register sales (F1, F2)', () => {
  it('a cash sale: the drawer, goods and each named tax on its own; GAM\'s background check is owed to GAM', async () => {
    const co = await ledgerCompany()
    const id = await sale(co, { subtotal: 66, tax: 4.36, taxBreakdown: TPT(4.36), screening: 30, at: '2026-09-15 18:00:00+00' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const ls = await active('pos_sale', id)
    expect(ls.every(l => l.day === '2026-09-15' && l.property === co.propertyId)).toBe(true)
    expect(brief(ls)).toEqual([
      ['register_sales', 0, 36, 'in', 'register_sales'],
      ['sales_tax_payable', 0, 4.36, 'in', 'tax_collected'],
      ['undeposited_funds', 70.36, 0, null, null],
      ['due_to_gam', 0, 30, null, null],
    ])
    expect(await received(co.landlordId, '2026-09-01', '2026-09-30')).toBe(40.36)
    // The named tax has its own sub-account under Sales tax payable.
    const sub = await db.query<{ name: string }>(
      `SELECT a.name FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
        WHERE l.landlord_id = $1 AND l.account_role = 'sales_tax_payable'`, [co.landlordId])
    expect(sub.rows[0].name).toContain('Transaction privilege tax')
  })

  it('a card sale with the fee paid on top: Due from GAM is the held line, no card fee is the landlord\'s', async () => {
    const co = await ledgerCompany()
    // production's pay link: 13.20 + 0.87 tax + 1.04 fee on top = 15.11; GAM holds 14.07
    const id = await sale(co, { method: 'card', subtotal: 13.2, tax: 0.87, surcharge: 1.04, platformFee: 1.04, held: 14.07 })
    await drainLedgerOutbox()
    expect(brief(await active('pos_sale', id))).toEqual([
      ['register_sales', 0, 13.2, 'in', 'register_sales'],
      ['sales_tax_payable', 0, 0.87, 'in', 'tax_collected'],
      ['due_from_gam', 14.07, 0, null, null],
    ])
  })

  // 10/12 (Nic, ledger integrate): the reports' own category rule (incomeBasis) —
  // money through a pay link counts under "Stays and pay links"; the account is
  // still Register sales.
  it('goods paid through a pay link count under "Stays and pay links", on the Register sales account', async () => {
    const co = await ledgerCompany()
    const id = await sale(co, { method: 'card', subtotal: 13.2, tax: 0.87, surcharge: 1.04, platformFee: 1.04, held: 14.07, payLink: true })
    await drainLedgerOutbox()
    expect(brief(await active('pos_sale', id))).toEqual([
      ['register_sales', 0, 13.2, 'in', 'stays_and_pay_links'],
      ['sales_tax_payable', 0, 0.87, 'in', 'tax_collected'],
      ['due_from_gam', 14.07, 0, null, null],
    ])
  })

  it('a card sale whose fee the landlord covers: the fee GAM kept is the landlord\'s processing fee; a card check is GAM\'s on neither side', async () => {
    const co = await ledgerCompany()
    // 100 subtotal incl. a 30 background check; fee 4.05 absorbed; GAM holds 100 − 4.05 − 30
    const id = await sale(co, { method: 'card', subtotal: 100, platformFee: 4.05, held: 65.95, screening: 30 })
    await drainLedgerOutbox()
    expect(brief(await active('pos_sale', id))).toEqual([
      ['register_sales', 0, 70, 'in', 'register_sales'],
      ['due_from_gam', 65.95, 0, null, null],
      ['processing_fees', 4.05, 0, null, null],
    ])
  })

  it('a stay paid at the register is held as a guest deposit with its lodging tax apart (Nic L10)', async () => {
    const co = await ledgerCompany()
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2026-10-08' })
    const id = await sale(co, {
      subtotal: 200 + 10, tax: 22.4 + 0.66,
      taxBreakdown: [{ name: 'Lodging tax', rate: 0.112, amount: 22.4 }, ...TPT(0.66)],
      stay: { bookingId: b, toward: 222.4 }, at: '2026-10-01 18:00:00+00',
      items: [{ name: 'Site 4', qty: 1, price: 200 }, { name: 'Firewood', qty: 1, price: 10 }],
    })
    await drainLedgerOutbox()
    expect(brief(await active('pos_sale', id))).toEqual([
      ['register_sales', 0, 10, 'in', 'register_sales'],
      ['guest_deposits', 0, 200, 'in', 'stays_and_pay_links'],
      ['lodging_tax_payable', 0, 22.4, 'in', 'tax_collected'],
      ['sales_tax_payable', 0, 0.66, 'in', 'tax_collected'],
      ['undeposited_funds', 233.06, 0, null, null],
    ])
  })

  it('a void takes the sale back; nothing stays posted', async () => {
    const co = await ledgerCompany()
    const id = await sale(co, { subtotal: 20 })
    await drainLedgerOutbox()
    await db.query(`UPDATE pos_transactions SET status = 'voided', voided_at = now(), void_reason = 'x' WHERE id = $1`, [id])
    expect(await drainLedgerOutbox()).toMatchObject({ reversed: 1, posted: 0 })
    expect(await active('pos_sale', id)).toEqual([])
    expect(await balance(co.landlordId, 'undeposited_funds')).toBe(0)
  })

  it('Nic L8: cost per item sold moves what the items cost to Cost of goods sold — only when the company counts stock that way, from the day it chose', async () => {
    const co = await ledgerCompany()
    const items = [{ name: 'Propane', qty: 2.5, price: 4, cost: 2.13 }, { name: 'Ice', qty: 1, price: 3, cost: 1 }]
    const before = await sale(co, { subtotal: 13, items, at: '2026-09-10 18:00:00+00' })
    await db.query(`UPDATE landlords SET books_register_stock = 'cost_per_item_sold', books_register_stock_from = '2026-09-20' WHERE id = $1`, [co.landlordId])
    const after = await sale(co, { subtotal: 13, items, at: '2026-09-25 18:00:00+00' })
    await drainLedgerOutbox()
    expect((await active('pos_sale', before)).map(l => l.role)).not.toContain('cost_of_goods_sold')
    const ls = await active('pos_sale', after)
    // 2.5 × 2.13 = 5.325 → 5.33; + 1.00
    expect(brief(ls.filter(l => l.role === 'cost_of_goods_sold' || l.role === 'inventory'))).toEqual([
      ['cost_of_goods_sold', 6.33, 0, null, null], ['inventory', 0, 6.33, null, null],
    ])
  })

  // 10/12 (Nic, ledger review): every change of mind is kept with its day, so
  // a second change never re-dates sales booked under the first.
  it('Nic L8, changed twice: each sale keeps the choice in force on its own day, and a rebuild comes out the same', async () => {
    const co = await ledgerCompany()
    const items = [{ name: 'Ice', qty: 2, price: 3, cost: 1.25 }]
    await db.query(
      `INSERT INTO books_register_stock_changes (landlord_id, method, effective_from) VALUES
         ($1, 'expense_when_bought', NULL), ($1, 'cost_per_item_sold', '2026-09-10'), ($1, 'expense_when_bought', '2026-09-20')`,
      [co.landlordId])
    await db.query(`UPDATE landlords SET books_register_stock = 'expense_when_bought', books_register_stock_from = '2026-09-20' WHERE id = $1`, [co.landlordId])
    const first = await sale(co, { subtotal: 6, items, at: '2026-09-05 18:00:00+00' })
    const middle = await sale(co, { subtotal: 6, items, at: '2026-09-15 18:00:00+00' })
    const last = await sale(co, { subtotal: 6, items, at: '2026-09-25 18:00:00+00' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const cogs = async (id: string) => (await active('pos_sale', id)).filter(l => l.role === 'cost_of_goods_sold').map(l => l.dr)
    expect(await cogs(first)).toEqual([])
    expect(await cogs(middle)).toEqual([2.5])
    expect(await cogs(last)).toEqual([])
    // The same answer on every re-read (what a rebuild or the nightly check does).
    const { rebuildOwner } = await import('../ledgerRebuild')
    const rb = await rebuildOwner({ landlordId: co.landlordId }, { mode: 'dry_run' })
    expect(rb.counts.drift).toBe(0)
    // The history is append-only.
    await expect(db.query(`DELETE FROM books_register_stock_changes WHERE landlord_id = $1`, [co.landlordId])).rejects.toThrow(/append-only/)
    const r = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'books_register_stock_changes_method_check'`)
    expect([...r.rows[0].def.matchAll(/'([^']*)'/g)].map(m => m[1])).toEqual([...LEDGER_REGISTER_STOCK_METHODS])
  })

  it('the register-stock choice\'s CHECK and default are the shared ones (Nic L8)', async () => {
    const r = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'landlords_books_register_stock_check'`)
    expect([...r.rows[0].def.matchAll(/'([^']*)'/g)].map(m => m[1])).toEqual([...LEDGER_REGISTER_STOCK_METHODS])
    const d = await db.query<{ d: string }>(
      `SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'landlords' AND column_name = 'books_register_stock'`)
    expect(d.rows[0].d).toContain(`'${DEFAULT_LEDGER_REGISTER_STOCK_METHOD}'`)
  })

  it('a store charge-account sale waits (design F7: charge accounts are not enabled)', async () => {
    const co = await ledgerCompany()
    const id = await sale(co, { method: 'charge', subtotal: 20 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 1 })
    expect((await waiting('pos_sale', id))?.reason_code).toBe('projector_error')
    expect(await active('pos_sale', id)).toEqual([])
  })
})

describe('register refunds (F3, Nic G10)', () => {
  async function refund(co: { landlordId: string }, saleId: string, r: {
    amount: number; method: 'cash' | 'check' | 'charge'; tax: number | null; feeBack?: number; at?: string; partId?: string | null
  }): Promise<string> {
    const x = await db.query<{ id: string }>(
      `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, tax_refunded, card_fee_refunded, stay_refund_part_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now())) RETURNING id`,
      [saleId, co.landlordId, r.amount, r.method, r.tax, r.feeBack ?? 0, r.partId ?? null, r.at ?? null])
    return x.rows[0].id
  }

  it('a card sale refunded in cash: the goods come off as a return, the tax goes back, and the card fee given back is the landlord\'s "Card fees refunded"', async () => {
    const co = await ledgerCompany()
    const s = await sale(co, { method: 'card', subtotal: 100, tax: 6.6, taxBreakdown: TPT(6.6), surcharge: 4.29, platformFee: 4.29, held: 106.6 })
    await drainLedgerOutbox()
    const r = await refund(co, s, { amount: 110.89, method: 'cash', tax: 6.6, feeBack: 4.29, at: '2026-09-20 18:00:00+00' })
    await drainLedgerOutbox()
    const ls = await active('pos_refund', r)
    expect(ls.every(l => l.day === '2026-09-20')).toBe(true)
    expect(brief(ls)).toEqual([
      ['sales_returns', 100, 0, 'in', 'refunds'],
      ['sales_tax_payable', 6.6, 0, 'in', 'tax_collected'],
      ['card_fees_refunded', 4.29, 0, null, null],
      ['undeposited_funds', 0, 110.89, null, null],
    ])
    // Received that day is minus the money back, never the card fee (it was never the landlord's income).
    expect(await received(co.landlordId, '2026-09-20', '2026-09-20')).toBe(-106.6)
    const name = await db.query<{ code: string; name: string }>(
      `SELECT a.code, a.name FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
        WHERE l.landlord_id = $1 AND l.account_role = 'card_fees_refunded'`, [co.landlordId])
    expect(name.rows[0]).toEqual({ code: '5117', name: 'Card fees refunded' })
  })

  it('a refund by check is an outstanding check until the bank line clears it; a stay\'s share comes off stay income that day', async () => {
    const co = await ledgerCompany()
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2026-10-06' })
    const s = await sale(co, { subtotal: 110, stay: { bookingId: b, toward: 100 }, items: [{ name: 'Site', qty: 1, price: 100 }, { name: 'Wood', qty: 1, price: 10 }] })
    const r = await refund(co, s, { amount: 55, method: 'check', tax: 0 })
    await drainLedgerOutbox()
    expect(brief(await active('pos_refund', r))).toEqual([
      ['sales_returns', 5, 0, 'in', 'refunds'],
      ['stay_income', 50, 0, 'in', 'refunds'],
      ['outstanding_checks', 0, 55, null, null],
    ])
  })

  it('a charge-account refund waits (design F7); a refund that does not say its tax waits for the fact', async () => {
    const co = await ledgerCompany()
    const s = await sale(co, { subtotal: 50 })
    const noTax = await refund(co, s, { amount: 5, method: 'cash', tax: null })
    const onAccount = await refund(co, s, { amount: 5, method: 'charge', tax: 0 })
    await drainLedgerOutbox()
    expect((await waiting('pos_refund', noTax))?.reason_code).toBe('missing_fact')
    expect((await waiting('pos_refund', onAccount))?.reason_code).toBe('projector_error')
    expect(await active('pos_refund', noTax)).toEqual([])
  })
})

describe('a payment GAM set aside (F5)', () => {
  it('posts nothing while held; refunded, Stripe\'s kept fee is the landlord\'s processing fee on the refund day', async () => {
    const co = await ledgerCompany()
    const id = (await db.query<{ id: string }>(
      `INSERT INTO pos_held_payments (landlord_id, property_id, stripe_payment_intent_id, reason, amount)
       VALUES ($1, $2, 'pi_held_1', 'paid_twice', 40) RETURNING id`, [co.landlordId, co.propertyId])).rows[0].id
    await drainLedgerOutbox()
    expect(await active('pos_held', id)).toEqual([])
    await db.query(`UPDATE pos_held_payments SET stripe_fee_kept = 1.71, status = 'refunded', refunded_at = '2026-09-22 20:00:00+00' WHERE id = $1`, [id])
    await drainLedgerOutbox()
    const ls = await active('pos_held', id)
    expect(ls[0].day).toBe('2026-09-22')
    expect(brief(ls)).toEqual([['processing_fees', 1.71, 0, null, null], ['due_from_gam', 0, 1.71, null, null]])
  })
})
