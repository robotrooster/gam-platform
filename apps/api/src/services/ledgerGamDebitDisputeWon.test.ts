/**
 * 10/13 (Nic) — GAM Books ledger: a dispute GAM WINS on its own fee pull.
 *
 *   Nic, 10/13 (afternoon): "Won GAM pull dispute: AUTOMATIC (back to
 *   collected; anything collected twice credited back)."
 *
 * The money side (services/landlordGamDebit applyWonGamDebitDispute) puts the
 * pull's fees back to collected, un-voids the pull's own $6, gives back on the
 * landlord's next payout whatever was collected again meanwhile (collected
 * twice), and voids the dispute's cost charge (giving back what was collected
 * on it). The books follow: the pull's 'cancellation' posting is taken back
 * (the pull's money stands), the $6 and the cost charge post through their own
 * charges, and each given-back payout line moves what was collected twice from
 * Due to GAM (2080) to Due from GAM (1050). Through a pull, its dispute, the
 * next pull that collects again and the win, Due to GAM equals what the
 * landlord owes, 1050 what GAM holds for them, 2015 what the bank still has to
 * clear, debits equal credits, and the nightly check finds no integrity
 * problem and no drift. Real tables, real capture triggers, the production
 * projectors and checks; Stripe is stubbed.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

const stripeCreate = vi.hoisted(() => vi.fn(async (): Promise<any> => ({ id: 'pi_unused', status: 'processing' })))
/** Stripe's own fee on a pull: $0.27 (its charge's balance transaction). */
const stripeRetrieve = vi.hoisted(() => vi.fn(async (id: string): Promise<any> => (
  { id, latest_charge: { id: `ch_${id}`, balance_transaction: { fee: 27 }, failure_balance_transaction: null } })))
const disputeRetrieve = vi.hoisted(() => vi.fn(async (id: string): Promise<any> => ({ id, balance_transactions: [] })))
vi.mock('stripe', () => {
  function FakeStripe(this: any) {
    this.paymentIntents = { create: stripeCreate, retrieve: stripeRetrieve, cancel: vi.fn(async (id: string) => ({ id })) }
    this.disputes = { retrieve: disputeRetrieve }
  }
  return { default: FakeStripe }
})
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ paymentIntents: { create: stripeCreate, retrieve: stripeRetrieve }, disputes: { retrieve: disputeRetrieve } }),
}))

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { ledgerCompany, postingsOf, linesOf, roleNet, companyToday, type LedgerCompany } from '../test/ledgerFixtures'
import { chargeLandlord, outstandingForLandlord } from './landlordGamAccount'
import {
  debitLandlordForCharges, settleGamDebit, handleGamDebitDispute, gamDebitWonGiveBackSourceId, gamChargeVoidedGiveBackSourceId,
} from './landlordGamDebit'
import { drainLedgerOutbox } from './ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from './ledgerProjectors'
import { checkOwner } from './ledgerCheck'
import { rebuildOwner } from './ledgerRebuild'
import { gamChargeGivenBack, GAM_CHARGE_GIVE_BACK_PREFIXES } from './ledgerProjectors/payoutHeldItem'

beforeEach(async () => {
  await cleanupAllSchema()
  registerProductionLedgerProjectors()
  stripeCreate.mockClear()
  stripeRetrieve.mockClear()
})
afterEach(() => unregisterProductionLedgerProjectors())

/** Oak Park: GAM's fees pulled from its bank (a $40 threshold); company-level costs left to the default (the Company column). */
async function oakPark(): Promise<LedgerCompany> {
  const co = await ledgerCompany()
  await db.query(
    `UPDATE landlords SET gam_debit_payment_method_id = 'pm_test_bank', stripe_fc_customer_id = 'cus_test' WHERE id = $1`, [co.landlordId])
  await db.query(`UPDATE properties SET gam_debit_threshold = 40 WHERE landlord_id = $1`, [co.landlordId])
  return co
}

/** A pull made the way the nightly sweep makes it, and its success as the webhook records it. */
async function pullAndSettle(co: LedgerCompany, pi: string): Promise<{ debitId: string; total: number }> {
  stripeCreate.mockResolvedValueOnce({ id: pi, status: 'processing' })
  const made = await debitLandlordForCharges(co.landlordId)
  expect(made.status).toBe('debited')
  await settleGamDebit(pi, true, undefined, made.debitId)
  return { debitId: made.debitId!, total: made.total! }
}

const tag = (co: LedgerCompany, p: string | null) => (p === co.propertyId ? 'p1' : p === co.propertyId2 ? 'p2' : p)
/** The active postings of a source, by kind: each line as [role, property, debit, credit]. */
async function posted(co: LedgerCompany, sourceType: string, sourceId: string) {
  const out: { kind: string; lines: (string | number | null)[][] }[] = []
  for (const p of (await postingsOf(sourceType, sourceId)).filter(x => x.role === 'post' && !x.superseded_at)) {
    out.push({ kind: p.posting_kind, lines: (await linesOf(p.id)).map(l => [l.account_role, tag(co, l.property_id), Number(l.debit), Number(l.credit)]) })
  }
  return out.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
}

/** The nightly check finds nothing wrong; a dry-run rebuild finds no drift; debits equal credits. */
async function clean(co: LedgerCompany): Promise<void> {
  const check = await checkOwner(co.owner)
  expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
  expect(check.repaired).toBe(0)
  expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
  const b = (await db.query<{ dr: string; cr: string }>(
    `SELECT COALESCE(sum(debit), 0)::text AS dr, COALESCE(sum(credit), 0)::text AS cr FROM ledger_posting_lines WHERE landlord_id = $1`,
    [co.landlordId])).rows[0]
  expect(b.dr).toBe(b.cr)
}

const dispute = (pi: string, id: string, status: string) => ({
  paymentIntentId: pi, stripeDisputeId: id, disputeStatus: status, eventStatus: status,
  disputedCents: 5400, feeCents: 1500, feeStated: true, feeReturnedCents: status === 'won' ? 1500 : undefined,
})

describe('a dispute GAM wins on its own fee pull', () => {
  it('the cancellation is taken back and the pull stands; the $6 posts again; the dispute\'s cost comes off — tied at every step', async () => {
    const co = await oakPark()
    await chargeLandlord(null, { landlordId: co.landlordId, propertyId: co.propertyId, kind: 'subscription', amount: 48,
      sourceType: 'test_platform_fee', sourceId: randomUUID() })
    const sep = await pullAndSettle(co, 'pi_won_simple')
    expect(sep.total).toBe(54)
    await drainLedgerOutbox()
    await clean(co)

    expect(await handleGamDebitDispute(dispute('pi_won_simple', 'du_won_simple', 'needs_response')))
      .toMatchObject({ handled: true, action: 'reopened', reopened: 48, costBilled: 15.27 })
    await drainLedgerOutbox()
    expect((await posted(co, 'gam_debit', sep.debitId)).map(p => p.kind)).toEqual(['cancellation', 'main'])
    expect(await roleNet(co.landlordId, 'due_to_gam')).toBe(63.27)
    await clean(co)

    // Stripe decides it for GAM: back to collected, nothing collected twice.
    expect(await handleGamDebitDispute(dispute('pi_won_simple', 'du_won_simple', 'won')))
      .toMatchObject({ handled: true, action: 'won', restored: 54, givenBack: 0 })
    expect(await outstandingForLandlord(co.landlordId)).toBe(0)
    await drainLedgerOutbox()
    // The pull's own posting stands; its cancellation is taken back (one reversal of it).
    expect((await posted(co, 'gam_debit', sep.debitId)).map(p => p.kind)).toEqual(['main'])
    expect((await postingsOf('gam_debit', sep.debitId)).filter(p => p.role === 'reversal').map(p => p.posting_kind)).toEqual(['cancellation'])
    // Nothing owed to GAM; the $54 the pull took is the bank's to clear again; the dispute cost nothing.
    expect(await roleNet(co.landlordId, 'due_to_gam')).toBe(0)
    expect(await roleNet(co.landlordId, 'outstanding_checks')).toBe(54)
    expect(await roleNet(co.landlordId, 'chargeback_fees')).toBe(0)
    expect(await roleNet(co.landlordId, 'bank_fees')).toBe(-6)   // the pull's own $6 stands (an expense: a debit)
    await clean(co)
  })

  it('anything collected twice meanwhile is given back on the next payout: Due to GAM to Due from GAM, the books tied', async () => {
    const co = await oakPark()
    const sub = await chargeLandlord(null, { landlordId: co.landlordId, propertyId: co.propertyId, kind: 'subscription', amount: 48,
      sourceType: 'test_platform_fee', sourceId: randomUUID() })
    const sep = await pullAndSettle(co, 'pi_won_twice')
    await drainLedgerOutbox()
    await handleGamDebitDispute(dispute('pi_won_twice', 'du_won_twice', 'needs_response'))
    await drainLedgerOutbox()
    // The next pull collects the reopened $48, the dispute's $15.27 and its own $6.
    const oct = await pullAndSettle(co, 'pi_won_twice_oct')
    expect(oct.total).toBe(69.27)
    await drainLedgerOutbox()
    expect(await roleNet(co.landlordId, 'due_to_gam')).toBe(0)
    await clean(co)

    // GAM wins: the $48 was collected twice; the dispute's cost was collected and is taken back.
    expect(await handleGamDebitDispute(dispute('pi_won_twice', 'du_won_twice', 'won')))
      .toMatchObject({ handled: true, action: 'won', givenBack: 63.27 })
    await drainLedgerOutbox()
    const costCharge = (await db.query<{ id: string }>(
      `SELECT id FROM landlord_gam_charges WHERE landlord_id = $1 AND source_type = 'gam_bank_debit_disputed'`, [co.landlordId])).rows[0].id
    const lines = (await db.query<{ id: string; source_id: string; amount: string }>(
      `SELECT id, source_id, amount::text FROM held_payout_items WHERE landlord_id = $1 AND source_type = 'refund' ORDER BY amount`,
      [co.landlordId])).rows
    expect(lines.map(l => [l.source_id, l.amount])).toEqual([
      [gamChargeVoidedGiveBackSourceId(costCharge), '15.27'],
      [gamDebitWonGiveBackSourceId(sep.debitId, sub!), '48.00'],
    ])
    // Each given-back line: Dr Due from GAM / Cr Due to GAM, at the charge's property.
    expect(await posted(co, 'held_item', lines[1].id)).toEqual([{ kind: 'main', lines: [['due_from_gam', 'p1', 48, 0], ['due_to_gam', 'p1', 0, 48]] }])
    expect(await posted(co, 'held_item', lines[0].id)).toEqual([{ kind: 'main', lines: [['due_from_gam', null, 15.27, 0], ['due_to_gam', null, 0, 15.27]] }])
    // Nothing owed to GAM; GAM holds $63.27 for the landlord until the next payout; both pulls' money stands.
    expect(await roleNet(co.landlordId, 'due_to_gam')).toBe(0)
    expect(await roleNet(co.landlordId, 'due_from_gam')).toBe(-63.27)   // GAM owes it (an asset: a debit)
    expect(await roleNet(co.landlordId, 'outstanding_checks')).toBe(123.27)
    expect(await roleNet(co.landlordId, 'chargeback_fees')).toBe(0)
    await clean(co)
    // A rebuild from scratch posts the same books.
    expect((await rebuildOwner(co.owner, { mode: 'from_scratch' })).counts.failed).toBe(0)
    await clean(co)
  })

  it('a card reader piece given back was a Supplies expense, never owed: the line takes the expense back', async () => {
    const co = await oakPark()
    const piece = (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type) VALUES ($1, $2, 'device_installment', 87.5, 'test')
       RETURNING id`, [co.landlordId, co.propertyId])).rows[0].id
    const line = (await db.query<{ id: string }>(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, property_id) VALUES ($1, 'refund', $2, 87.5, $3) RETURNING id`,
      [co.landlordId, gamDebitWonGiveBackSourceId(randomUUID(), piece), co.propertyId])).rows[0].id
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await posted(co, 'held_item', line)).toEqual([{ kind: 'main', lines: [['due_from_gam', 'p1', 87.5, 0], ['supplies', 'p1', 0, 87.5]] }])
    // Any other refund line is its own source's to post.
    const other = (await db.query<{ id: string }>(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, property_id) VALUES ($1, 'refund', $2, 20, $3) RETURNING id`,
      [co.landlordId, `refund_part:${randomUUID()}`, co.propertyId])).rows[0].id
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await posted(co, 'held_item', other)).toEqual([])
  })

  it('the given-back lines the money side writes are the ones the books read', () => {
    const a = randomUUID()
    const b = randomUUID()
    expect(gamChargeGivenBack('refund', gamDebitWonGiveBackSourceId(a, b))).toBe(b)
    expect(gamChargeGivenBack('refund', gamChargeVoidedGiveBackSourceId(b))).toBe(b)
    expect(GAM_CHARGE_GIVE_BACK_PREFIXES.every(p => gamDebitWonGiveBackSourceId(a, b).startsWith(p) || gamChargeVoidedGiveBackSourceId(b).startsWith(p))).toBe(true)
    // An early check-out's refund line, or any other: its own source posts it.
    expect(gamChargeGivenBack('refund', `refund_part:${b}`)).toBeNull()
    expect(gamChargeGivenBack('dispute', gamChargeVoidedGiveBackSourceId(b))).toBeNull()
  })
})

describe('the books follow the win on the day it is recorded', () => {
  it('companies that show fixes on the day made see the take-back today; the pull keeps its own day', async () => {
    const co = await oakPark()
    await db.query(`UPDATE landlords SET books_open_month_fixes = 'day_made' WHERE id = $1`, [co.landlordId])
    await chargeLandlord(null, { landlordId: co.landlordId, propertyId: co.propertyId, kind: 'subscription', amount: 48,
      sourceType: 'test_platform_fee', sourceId: randomUUID() })
    const sep = await pullAndSettle(co, 'pi_won_dayof')
    await drainLedgerOutbox()
    await handleGamDebitDispute(dispute('pi_won_dayof', 'du_won_dayof', 'needs_response'))
    await drainLedgerOutbox()
    // The dispute was a week before the win.
    await db.query(`UPDATE landlord_gam_debits SET disputed_at = disputed_at - interval '7 days', settled_at = settled_at - interval '20 days'
                     WHERE id = $1`, [sep.debitId])
    expect(await rebuildOwner(co.owner, { mode: 'apply' })).toMatchObject({ status: 'done' })
    const before = (await postingsOf('gam_debit', sep.debitId)).filter(p => p.role === 'post' && !p.superseded_at)
    const cancel = before.find(p => p.posting_kind === 'cancellation')!
    const today = await companyToday()
    expect(cancel.accounting_date < today).toBe(true)
    await handleGamDebitDispute(dispute('pi_won_dayof', 'du_won_dayof', 'won'))
    await drainLedgerOutbox()
    const back = (await postingsOf('gam_debit', sep.debitId)).filter(p => p.role === 'reversal' && p.reverses_posting_id === cancel.id)
    expect(back.map(p => [p.intended_date, p.accounting_date])).toEqual([[cancel.intended_date, today]])
    expect((await posted(co, 'gam_debit', sep.debitId)).map(p => p.kind)).toEqual(['main'])
    await clean(co)
  })
})

describe('the books ship whole without the money side', () => {
  // 10/13 review: the books read landlord_gam_debits.dispute_won_at (the pull's
  // posting, the Due to GAM and Outstanding checks and debits checks). The
  // column is 20261015180000's; the books' own migration adds it as well, so
  // the books can go out even if the money side is held back.
  it('its migration adds dispute_won_at when the money side\'s has not run, and runs again to no effect', async () => {
    const file = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', name), 'utf8')
    const sql = file('20261015190200_ledger_capture_gam_debit_dispute_won.sql')
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      // Production as it stands (its newest is 20261015140100), without the money side's 20261015180000.
      await c.query(file('20261015140100_ledger_capture_gam_debit_disputed.sql'))
      await c.query('ALTER TABLE landlord_gam_debits DROP COLUMN dispute_won_at')
      const type = async () => (await c.query<{ t: string | null }>(
        `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
          WHERE attrelid = 'landlord_gam_debits'::regclass AND attname = 'dispute_won_at' AND NOT attisdropped`)).rows[0]?.t ?? null
      expect(await type()).toBeNull()
      await c.query(sql)
      expect(await type()).toBe('timestamp with time zone')
      await c.query(sql)
      expect(await type()).toBe('timestamp with time zone')
      await c.query('SELECT ledger_check_capture()')
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }
  })
})
