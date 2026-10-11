/**
 * S655 (money plan, Step 11) — every agent that says what someone owes reads
 * the same rule as the Outstanding page (services/openBalances.openBalanceSql).
 *
 * get_my_payment_status summed pending, processing, failed AND returned: a
 * payment still clearing was quoted as owed, a bounce counted twice (the
 * 'returned' original and the row the reversal reopened), and GAM's FlexPay
 * pull showed up as the tenant's bill. query_portfolio's "who owes the most"
 * counted rows the page does not. These pin them to one number.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// A real card dispute runs paymentReversal.handlePaymentReversal, as the live
// charge.dispute.created webhook does. Its side trips (the late-fee back-fill,
// the landlord's alert, the recovery decision) are not what these tests read.
vi.mock('../../../jobs/lateFees', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateLateFeesForInvoice: vi.fn(async () => ({ invoicesScanned: 0, rowsWritten: 0, capsHit: 0, errors: [] })),
}))
vi.mock('../../responsibleParty', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), getPropertyResponsibleParty: vi.fn(async () => null),
}))
vi.mock('../../reversalRecovery', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), decideReversalRecovery: vi.fn(async () => null),
}))

import { db, getClient } from '../../../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../../../test/dbHelpers'
import { listOpenTenantBalances } from '../../openBalances'
import { getMyPayments } from './getMyPayments'
import { queryPortfolio } from './queryPortfolio'
import { lookupTenantPaymentStatus } from './lookupTenantPaymentStatus'
import { getMyBalanceBreakdown } from './getMyBalanceBreakdown'
import { handlePaymentReversal } from '../../paymentReversal'
import { planLeaseCharge } from '../../rentCharge'
import { createIssuedCredit } from '../../creditUse'

beforeEach(cleanupAllSchema)

async function seed() {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    await client.query(`UPDATE users SET first_name = 'Tess', last_name = 'Tooling' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 460 })
    await client.query(`UPDATE units SET unit_number = 'RV 77' WHERE id = $1`, [unitId])
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 460 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const row = async (type: string, amount: number, status: string, due: string, extra: Record<string, unknown> = {}) => {
      const all: Record<string, unknown> = {
        unit_id: unitId, lease_id: leaseId, tenant_id: tenantId, landlord_id: landlordId, type, amount, status,
        due_date: due, entry_description: type === 'rent' ? 'RENT' : type === 'utility' ? 'UTILITY' : 'OTHERFEE',
        ...extra,
      }
      const cols = Object.keys(all)
      const vals = Object.values(all)
      return (await client.query<{ id: string }>(
        `INSERT INTO payments (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals)).rows[0].id
    }
    // October rent: owed.
    await row('rent', 460, 'pending', '2026-10-01')
    // September electric: a bank payment still clearing.
    await row('utility', 40, 'processing', '2026-09-20', { stripe_payment_intent_id: 'pi_bt_flight' })
    // August rent: paid, then the bank sent it back; the reversal reopened it.
    const aug = await row('rent', 300, 'returned', '2026-08-01', { return_code: 'R01' })
    const rv = await client.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
       VALUES ($1,$2,$3,$4,'ach_return',300,'evt_bt_aug','{}') RETURNING id`, [aug, landlordId, tenantId, leaseId])
    await row('rent', 300, 'pending', '2026-08-01', { reversal_id: rv.rows[0].id })
    // A work-trade-covered line: paid in hours, never owed.
    await row('utility', 25, 'pending', '2026-10-01', { work_trade_suspended_at: new Date() })
    // GAM's FlexPay pull: GAM's, never part of a tenant balance.
    await row('fee', 25, 'pending', '2026-10-06', { revenue_owner: 'gam', entry_description: 'FLEXPAY' })
    // A small credit the landlord gave: beside the balance, never taken off it.
    await client.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status)
       VALUES ($1,$2,NULL,10,10,'goodwill','test','active')`, [landlordId, tenantId])
    return {
      userId, landlordId, tenantId, leaseId,
      tenantActor: { userId: 'tenant-user', role: 'tenant' as const, profileId: tenantId, landlordIds: [] },
      landlordActor: { userId, role: 'landlord' as const, profileId: '', landlordIds: [landlordId] } as any,
    }
  } finally { client.release() }
}

describe('the agents read the Outstanding page\'s own number', () => {
  it('get_my_payment_status never counts a returned row, a work-trade row or a FlexPay pull', async () => {
    const s = await seed()
    const out: any = await getMyPayments.execute({}, s.tenantActor)
    // October rent $460 + the reopened August $300. Not the 'returned' original,
    // not the clearing $40, not work trade, not the FlexPay pull.
    expect(out.outstandingBalance).toBe(760)
    expect(out.outstandingItemCount).toBe(2)
    expect(out.inFlight).toBe(40)
    expect(out.creditAvailable).toBe(10)
    // The FlexPay payment is the tenant's own (their arrangement with GAM), so it
    // stays in THEIR recent history as it always was ("did my FlexPay payment go
    // through?") — marked, so it is never read out as a bill — and it is never
    // part of what they owe.
    const flex = out.recentPayments.filter((p: any) => p.amount === 25 && p.type === 'fee')
    expect(flex).toEqual([expect.objectContaining({ forFlexPay: true })])
    expect(out.recentPayments.filter((p: any) => p.forFlexPay)).toHaveLength(1)
  })

  it('queryPortfolio balance equals Outstanding', async () => {
    const s = await seed()
    const [page] = await listOpenTenantBalances({ landlordIds: [s.landlordId] })
    const out: any = await queryPortfolio.execute({ subject: 'tenants', measure: 'balance_owed' }, s.landlordActor)
    expect(out.results).toHaveLength(1)
    expect(out.results[0]).toMatchObject({ name: 'Tess Tooling', value: Number(page.balance) })
    expect(Number(page.balance)).toBe(760)
  })

  it('lookup_tenant_payment_status: the page\'s balance, the bounce named as returned, in flight and credit apart', async () => {
    const s = await seed()
    const out: any = await lookupTenantPaymentStatus.execute({ tenant: 'Tess Tooling' }, s.landlordActor)
    expect(out.ok).toBe(true)
    expect(out.outstandingBalance).toBe(760)
    expect(out.ofWhichReturned).toBe(300)
    expect(out.returnedItemCount).toBe(1)
    expect(out.inFlight).toBe(40)
    expect(out.creditAvailable).toBe(10)
  })

  it('a settled row a real dispute reopens is owed once, through the reopened row, in every tool; the landlord\'s lookup names it returned', async () => {
    const s = await seed()
    // September rent, paid by card and settled; then the card is disputed in full.
    const sept = (await db.query<{ id: string; lease_id: string; unit_id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, settled_at)
       SELECT unit_id, lease_id, tenant_id, landlord_id, 'rent', 460, 'settled', '2026-09-01', 'RENT', 'pi_bt_sept', NOW()
         FROM payments WHERE tenant_id = $1 AND type = 'rent' AND status = 'pending' AND reversal_id IS NULL
        LIMIT 1 RETURNING id, lease_id, unit_id`, [s.tenantId])).rows[0]
    const rev = await handlePaymentReversal({ paymentId: sept.id, reversalType: 'card_dispute', reversalFee: 0, stripeEventId: 'evt_bt_sept', rawEvent: {} })
    expect(rev.handled).toBe(true)
    const reopened = rev.rows.find(r => r.paymentId === sept.id)!.newPaymentId!
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [sept.id])).rows[0].status).toBe('returned')

    // Owed once: the reopened $460, never the 'returned' original as well.
    const [page] = await listOpenTenantBalances({ landlordIds: [s.landlordId] })
    expect(Number(page.balance)).toBe(760 + 460)
    const mine: any = await getMyPayments.execute({}, s.tenantActor)
    expect(mine.outstandingBalance).toBe(760 + 460)
    const breakdown: any = await getMyBalanceBreakdown.execute({}, s.tenantActor)
    expect(breakdown.totalOwed).toBe(760 + 460)
    const ids = breakdown.openChargesOldestFirst.map((c: any) => c.id)
    expect(ids).toContain(reopened)
    expect(ids).not.toContain(sept.id)
    expect(breakdown.openChargesOldestFirst.find((c: any) => c.id === reopened)).toMatchObject({ amount: 460, label: 'Rent' })

    // The landlord's lookup: the same balance, and the reopened row is what came back.
    const out: any = await lookupTenantPaymentStatus.execute({ tenant: 'Tess Tooling' }, s.landlordActor)
    expect(out.outstandingBalance).toBe(760 + 460)
    expect(out.ofWhichReturned).toBe(300 + 460)
    expect(out.returnedItemCount).toBe(2)
  })

  it('a credit is never taken off what the agent says is owed', async () => {
    const s = await seed()
    // A bigger credit, the way the product makes one (a credit's balance moves only
    // through credit_uses once C0 is on): the $10 is withdrawn and a whole $700
    // credit is issued.
    const client = await getClient()
    try {
      await client.query(`UPDATE tenant_credits SET status = 'void' WHERE tenant_id = $1`, [s.tenantId])
      await createIssuedCredit(client, { landlordId: s.landlordId, tenantId: s.tenantId, leaseId: s.leaseId, amount: 700, category: 'goodwill' })
    } finally { client.release() }
    const out: any = await getMyPayments.execute({}, s.tenantActor)
    expect(out.outstandingBalance).toBe(760)
    // $700 on file, but credit never pays a row reopened after a bounce: it can
    // pay October's $460 only. Usable is what it would pay, never more.
    expect(out.creditAvailable).toBe(460)
  })
})

// CLAUDE.md: FlexPay must NEVER surface in the landlord portal — and the
// landlord's agent is the landlord portal too.
describe('the landlord agent never names GAM\'s FlexPay pull', () => {
  it('lookup_tenant_payment_status leaves the FlexPay pull out of recent payments', async () => {
    const s = await seed()
    // The most recent row the tenant has is the FlexPay pull (due 10/6).
    const out: any = await lookupTenantPaymentStatus.execute({ tenant: 'Tess Tooling' }, s.landlordActor)
    expect(out.ok).toBe(true)
    expect(out.recentPayments.some((p: any) => p.type === 'fee' && p.amount === 25)).toBe(false)
    expect(JSON.stringify(out)).not.toMatch(/flexpay/i)
  })

  it('money in flight counts only money: credit a clearing payment set aside is not in it', async () => {
    const s = await seed()
    const row = (await db.query<{ id: string; lease_id: string }>(
      `SELECT id, lease_id FROM payments WHERE stripe_payment_intent_id = 'pi_bt_flight'`)).rows[0]
    const credit = (await db.query<{ id: string }>(`SELECT id FROM tenant_credits WHERE tenant_id = $1`, [s.tenantId])).rows[0].id
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,30,30,'processing','ach','pi_bt_flight') RETURNING id`, [s.tenantId, row.lease_id, s.landlordId])).rows[0].id
    // The trigger refuses a use on a processing row unless the remittance carries its intent: it does.
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,10,'2026-09-01','portal','held')`, [credit, row.id, rem, row.lease_id])
    const out: any = await lookupTenantPaymentStatus.execute({ tenant: 'Tess Tooling' }, s.landlordActor)
    expect(out.inFlight).toBe(30)
    const mine: any = await getMyPayments.execute({}, s.tenantActor)
    expect(mine.inFlight).toBe(30)
  })
})

// S652: one person + one company = one household balance. Lease charges carry
// the primary resident's tenant_id, so a co-tenant's agent read by
// payments.tenant_id alone said "you owe nothing, $100 credit available" and
// then Pay Now quoted the lease's $460 bill.
describe('a co-tenant hears the household\'s bill', () => {
  async function coTenancy() {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const primary = await seedTenant(client)
      const co = await seedTenant(client)
      const left = await seedTenant(client)
      const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 460 })
      const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 460 })
      await seedLeaseTenant(client, { leaseId, tenantId: primary, role: 'primary' })
      await seedLeaseTenant(client, { leaseId, tenantId: co, role: 'co_tenant' })
      // Someone who was on the lease and has left it: the lease's bills are no longer theirs.
      const leftRow = await seedLeaseTenant(client, { leaseId, tenantId: left, role: 'co_tenant' })
      await client.query(`UPDATE lease_tenants SET status = 'removed', removed_at = NOW() WHERE id = $1`, [leftRow])
      const inv = (await client.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
         VALUES ($1,$2,$3,$4,'INV-CO-1','2026-10-01',460,'pending') RETURNING id`, [landlordId, primary, leaseId, unitId])).rows[0].id
      // October rent, billed (as every lease charge is) to the primary resident.
      const rent = (await client.query<{ id: string }>(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,$5,'rent',460,'pending','2026-10-01','RENT') RETURNING id`,
        [inv, unitId, leaseId, primary, landlordId])).rows[0].id
      // The primary resident's own FlexPay payment to GAM: theirs alone, never the household's bill.
      await client.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
         VALUES ($1,$2,$3,$4,'fee',25,'pending','2026-10-06','FLEXPAY','gam')`, [unitId, leaseId, primary, landlordId])
      // $100 the co-tenant paid ahead on the lease.
      await client.query(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
         VALUES ($1,$2,100,100,'landlord',NOW())`, [leaseId, co])
      const actor = (profileId: string) => ({ userId: 'tenant-user', role: 'tenant' as const, profileId, landlordIds: [] })
      const landlordActor = { userId, role: 'landlord' as const, profileId: '', landlordIds: [landlordId] } as any
      const name = async (tenantId: string, first: string, last: string) => (await client.query<{ email: string }>(
        `UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1) RETURNING email`,
        [tenantId, first, last])).rows[0].email
      const emails = {
        primary: await name(primary, 'Paula', 'Primary'),
        co: await name(co, 'Cody', 'Cotenant'),
        left: await name(left, 'Lena', 'Leftover'),
      }
      return { landlordId, unitId, leaseId, primary, co, left, rent, actor, landlordActor, emails }
    } finally { client.release() }
  }

  it('a co-tenant asking the agent what they owe hears the household\'s bill, the same figure Pay Now quotes', async () => {
    const s = await coTenancy()
    const client = await getClient()
    let payNow: Awaited<ReturnType<typeof planLeaseCharge>>
    try {
      payNow = await planLeaseCharge(client, { tenantId: s.co, scope: { kind: 'lease', leaseId: s.leaseId } })
    } finally { client.release() }
    expect(payNow.requiredTotal).toBe(460)
    expect(payNow.usableCredit).toBe(100)

    const co: any = await getMyPayments.execute({}, s.actor(s.co))
    expect(co.outstandingBalance).toBe(payNow.requiredTotal)
    expect(co.outstandingItemCount).toBe(1)
    expect(co.creditAvailable).toBe(payNow.usableCredit)
    // "Did the rent go through?" — the household's rent is in their history.
    expect(co.recentPayments).toEqual([expect.objectContaining({ type: 'rent', amount: 460, status: 'pending' })])
    // The primary resident's FlexPay payment is theirs alone: never listed for the co-tenant.
    expect(co.recentPayments.some((p: any) => p.forFlexPay)).toBe(false)

    // The primary resident hears the same bill, and their own FlexPay payment, marked.
    const primary: any = await getMyPayments.execute({}, s.actor(s.primary))
    expect(primary.outstandingBalance).toBe(460)
    expect(primary.recentPayments.filter((p: any) => p.forFlexPay)).toHaveLength(1)

    // Someone who has left the lease no longer owes its bills.
    const left: any = await getMyPayments.execute({}, s.actor(s.left))
    expect(left.outstandingBalance).toBe(0)
    expect(left.recentPayments).toEqual([])
  })

  it('a co-tenant\'s breakdown lists the lease\'s open charges', async () => {
    const s = await coTenancy()
    // September rent, billed to the primary resident, paid by the co-tenant at the desk.
    const sept = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, settled_at)
       VALUES ($1,$2,$3,$4,'rent',460,'settled','2026-09-01','RENT',NOW()) RETURNING id`,
      [s.unitId, s.leaseId, s.primary, s.landlordId])).rows[0].id
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, settled_at)
       VALUES ($1,$2,$3,460,460,0,'settled','cash',NOW()) RETURNING id`, [s.co, s.leaseId, s.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,460)`, [rem, sept])

    const out: any = await getMyBalanceBreakdown.execute({}, s.actor(s.co))
    expect(out.totalOwed).toBe(460)
    expect(out.openChargeCount).toBe(1)
    expect(out.openChargesOldestFirst).toEqual([expect.objectContaining({ id: s.rent, amount: 460, label: 'Rent' })])
    expect(out.creditAvailable).toBe(100)
    // Their own receipt, with the charge it paid (billed to the primary resident).
    expect(out.recentPayments).toEqual([expect.objectContaining({ id: rem, amount: 460 })])
    expect(out.recentPayments[0].appliedTo).toEqual([expect.objectContaining({ amount_applied: 460, type: 'rent' })])

    // The primary resident's breakdown is the same bill.
    const primary: any = await getMyBalanceBreakdown.execute({}, s.actor(s.primary))
    expect(primary.totalOwed).toBe(460)
    // Someone who has left the lease: nothing of it.
    const left: any = await getMyBalanceBreakdown.execute({}, s.actor(s.left))
    expect(left.totalOwed).toBe(0)
    expect(left.openChargesOldestFirst).toEqual([])
  })

  it('a landlord asking about a co-tenant hears the household\'s bill, the figure on the Outstanding row', async () => {
    const s = await coTenancy()
    // The Outstanding page lists the shared lease's bill once, on the row of the
    // person it is billed to (the primary resident).
    const page = await listOpenTenantBalances({ landlordIds: [s.landlordId] })
    expect(page).toHaveLength(1)
    expect(page[0].tenant_id).toBe(s.primary)
    expect(Number(page[0].balance)).toBe(460)

    const co: any = await lookupTenantPaymentStatus.execute({ tenant: s.emails.co }, s.landlordActor)
    expect(co.ok).toBe(true)
    expect(co.outstandingBalance).toBe(Number(page[0].balance))
    expect(co.outstandingItemCount).toBe(1)
    expect(co.creditAvailable).toBe(100)
    // Whose name the bill is in, and who shares it, so the two answers are never added up.
    expect(co.household.billedInNameOf).toEqual(['Paula Primary'])
    expect(co.household.sharedWith).toEqual([expect.objectContaining({ name: 'Paula Primary', role: 'Primary Tenant' })])
    expect(co.household.note).toMatch(/ONE bill/)
    // The household's rent is in the recent history; the primary's FlexPay pull never is.
    expect(co.recentPayments).toEqual([expect.objectContaining({ type: 'rent', amount: 460, status: 'pending' })])
    expect(JSON.stringify(co)).not.toMatch(/flexpay/i)

    const primary: any = await lookupTenantPaymentStatus.execute({ tenant: s.emails.primary }, s.landlordActor)
    expect(primary.outstandingBalance).toBe(co.outstandingBalance)
    expect(primary.creditAvailable).toBe(100)
    expect(primary.household.billedInNameOf).toEqual([])
    expect(primary.household.sharedWith).toEqual([expect.objectContaining({ name: 'Cody Cotenant', role: 'Co-Tenant' })])
    expect(JSON.stringify(primary)).not.toMatch(/flexpay/i)

    // Someone who has left the lease owes none of its bills.
    const left: any = await lookupTenantPaymentStatus.execute({ tenant: s.emails.left }, s.landlordActor)
    expect(left.ok).toBe(true)
    expect(left.outstandingBalance).toBe(0)
    expect(left.outstandingItemCount).toBe(0)
    expect(left.recentPayments).toEqual([])
    expect(left.household).toBeUndefined()
  })

  it('a lookup by an email with a long digit run finds the tenant and does not throw', async () => {
    const s = await coTenancy()
    // Like tenant-<uuid>@test.dev: far more digits than a bigint holds. Set
    // explicitly, because a random uuid's digit count varies run to run.
    const email = 'tenant-20261004-1234567890-1234567890@test.dev'
    expect(email.replace(/[^0-9]/g, '').length).toBeGreaterThan(18)
    await db.query(`UPDATE users SET email = $2 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [s.co, email])
    const out: any = await lookupTenantPaymentStatus.execute({ tenant: email }, s.landlordActor)
    expect(out.ok).toBe(true)
    expect(out.matchedOn).toBe('exact')
    expect(out.tenant.email).toBe(email)
    // A long number that is not an email is compared as a unit number, and
    // still never overflows: no match, not an error.
    const none: any = await lookupTenantPaymentStatus.execute({ tenant: '12345678901234567890123' }, s.landlordActor)
    expect(none.ok).toBe(false)
    expect(none.error).toMatch(/No tenant on your leases matches/)
  })

  it('an email with a digit in it names a person, never every unit with that number', async () => {
    const s = await coTenancy()
    await db.query(`UPDATE units SET unit_number = 'RV 7' WHERE id = $1`, [s.unitId])
    const email = `cody7@cotenant-mail.test`
    await db.query(`UPDATE users SET email = $2 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [s.co, email])
    const out: any = await lookupTenantPaymentStatus.execute({ tenant: email }, s.landlordActor)
    expect(out.ok).toBe(true)
    expect(out.needsDisambiguation).toBeUndefined()
    expect(out.tenant.email).toBe(email)
    // Asking by the unit's number still finds everyone who has lived in the space.
    const byUnit: any = await lookupTenantPaymentStatus.execute({ tenant: '7' }, s.landlordActor)
    expect(byUnit.needsDisambiguation).toBe(true)
    expect(byUnit.matches.map((m: any) => m.unit)).toEqual(['RV 7', 'RV 7', 'RV 7'])
  })
})
