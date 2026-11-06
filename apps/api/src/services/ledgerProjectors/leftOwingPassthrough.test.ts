/**
 * 10/27 (Nic) — A DEBT COLLECTED FOR ANOTHER OPERATOR, ON BOTH SETS OF BOOKS.
 *
 *   "they can pay you and we'll collect the money from you. But if you click on
 *    this and they don't pay, we're collecting that debt from you. You're going
 *    to be paying that debt on that tenant's behalf."
 *
 * The installment is billed on the COLLECTING landlord's invoice, because that
 * is the invoice the resident gets. So it passes through their books and is
 * never their money. The one thing these tests exist to hold: no income and no
 * equity moves on either side. The rent was earned and reported in its own
 * months, by the landlord who was left without it — the same reasoning GAM
 * Books already applies to a carried balance (A8b).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import { inTx, ledgerCompany } from '../../test/ledgerFixtures'
import {
  tenantCo, bill, drain, bal, activeLines, triples, cleanupTenantLedger, type TenantCo,
} from '../../test/ledgerTenantFixtures'
import { registeredLedgerSourceTypes, unregisterLedgerProjector } from '../ledgerEngine'
import { registerTenantLedgerProjectors } from './tenantMoney'
import { registerP5 } from '../../test/ledgerP5Fixtures'
import { recordHeldItem } from '../heldPayouts'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerTenantLedgerProjectors()
  registerP5()
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})

/** The operator who was left owing, and the arrangement a later one collects under. */
async function arrangement(co: TenantCo, total: number) {
  // A company with books of its own, or nothing posts for them: a landlord
  // keeps no ledger until books_start_date is set.
  const owed = await ledgerCompany()
  const userId = (await db.query<{ user_id: string }>(
    `SELECT user_id FROM tenants WHERE id = $1`, [co.tenantId])).rows[0].user_id
  const owing = (await db.query<{ id: string }>(
    `INSERT INTO tenant_left_owing
       (landlord_id, property_id, user_id, amount, source_kind, source_key, left_on)
     VALUES ($1,$2,$3,$4,'lease',$5,CURRENT_DATE - 60) RETURNING id`,
    [owed.landlordId, owed.propertyId, userId, total, randomUUID()])).rows[0].id
  const col = (await db.query<{ id: string }>(
    `INSERT INTO left_owing_collections
       (owing_id, owed_landlord_id, collecting_landlord_id, tenant_id,
        total_amount, installment_amount, acknowledged_words)
     VALUES ($1,$2,$3,$4,$5,$6,'collected on behalf') RETURNING id`,
    [owing, owed.landlordId, co.landlordId, co.tenantId, total, 100])).rows[0].id
  return { owed, owing, collectionId: col }
}

describe('A8c: the bill is a receivable and a liability, never income', () => {
  it('credits the operator it is owed to, not this landlord\'s opening equity', async () => {
    const co = await tenantCo()
    const a = await arrangement(co, 1200)
    const id = await bill(co, {
      type: 'carried_balance', amount: 100, due: '2026-09-01', leftOwingCollectionId: a.collectionId })
    await drain()

    expect(triples(await activeLines('payment', id))).toEqual([
      ['ar_tenants', 10000, 0],
      ['collected_for_another_operator', 0, 10000],
    ])
    // The thing that would otherwise have happened: A8 treats a carried
    // balance as money from before GAM and credits equity.
    expect(await bal(co.landlordId, 'opening_balance_equity')).toBe(0)
  })

  it('an ordinary carried balance is untouched by it', async () => {
    // A landlord's OWN old balance still posts to equity (A8). The new branch
    // is keyed on the arrangement, so it cannot catch one of these.
    const co = await tenantCo()
    const id = await bill(co, { type: 'carried_balance', amount: 250, due: '2026-09-01' })
    await drain()
    expect(triples(await activeLines('payment', id))).toEqual([
      ['ar_tenants', 25000, 0],
      ['opening_balance_equity', 0, 25000],
    ])
  })
})

describe('the payout settles it between the two companies', () => {
  it('takes the liability off the collecting landlord and the receivable off the one owed', async () => {
    const co = await tenantCo()
    const a = await arrangement(co, 1200)
    const billed = await bill(co, {
      type: 'carried_balance', amount: 100, due: '2026-09-01', leftOwingCollectionId: a.collectionId })
    await drain()

    const key = randomUUID()
    await recordHeldItem({ landlordId: co.landlordId, sourceType: 'left_owing_netted', sourceId: key,
      amount: -100, property: { propertyId: co.propertyId } })
    await recordHeldItem({ landlordId: a.owed.landlordId, sourceType: 'left_owing_paid', sourceId: key,
      amount: 100, property: { propertyId: a.owed.propertyId } })
    await drain()

    const netted = (await db.query<{ id: string }>(
      `SELECT id FROM held_payout_items WHERE source_type = 'left_owing_netted' AND source_id = $1`, [key])).rows[0].id
    const paid = (await db.query<{ id: string }>(
      `SELECT id FROM held_payout_items WHERE source_type = 'left_owing_paid' AND source_id = $1`, [key])).rows[0].id

    expect(triples(await activeLines('held_item', netted))).toEqual([
      ['collected_for_another_operator', 10000, 0],
      ['due_from_gam', 0, 10000],
    ])
    expect(triples(await activeLines('held_item', paid))).toEqual([
      ['due_from_gam', 10000, 0],
      ['ar_tenants', 0, 10000],
    ])

    // THE WHOLE POINT, both sides:
    // the collecting landlord held it and passed it on — nothing of theirs moved.
    expect(await bal(co.landlordId, 'collected_for_another_operator')).toBe(0)
    expect(await bal(co.landlordId, 'opening_balance_equity')).toBe(0)
    expect(await bal(co.landlordId, 'space_rent')).toBe(0)
    // the landlord owed: their receivable from the resident who left comes
    // down, and GAM holds the money for them until the batch transfers it.
    expect(await bal(a.owed.landlordId, 'due_from_gam')).toBe(10000)
    expect(await bal(a.owed.landlordId, 'ar_tenants')).toBe(-10000)
    // which is the other half of the same movement: GAM owes the collecting
    // landlord 100 LESS, because it came off their payout.
    expect(await bal(co.landlordId, 'due_from_gam')).toBe(-10000)
    expect(await bal(a.owed.landlordId, 'space_rent')).toBe(0)
    // and the resident still owes the bill until they pay it.
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(10000)
    expect(billed).toBeTruthy()
  })
})
