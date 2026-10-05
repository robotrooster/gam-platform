/**
 * S655 money plan Step 7 — the bill run and the whole-bill rule.
 *
 * Nic (10/2): credit applies by itself only when it covers the WHOLE bill.
 * Todd Niemeyer's check paid October ahead: October's bill is paid from it at
 * the 7 AM run, nothing charged. MH 25's $10 against a $460 bill pays nothing:
 * the tenant chooses "Use all $10" or "Save it for later" when they pay.
 *
 * Also here: the bill run takes the household lock, and the three invoice
 * holds ask the bill engine's own "does the tenant owe this utility?" (10/3
 * sweep: they joined the lease's utility rows, so 79 of 80 leases never waited).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule, seedUtilityMeter,
} from '../test/dbHelpers'

// Receipts go out after the commit; this file checks THAT and WHAT is sent.
const sendPaymentReceipt = vi.hoisted(() => vi.fn(async (_o: any) => 'msg_test'))
vi.mock('../services/paymentReceipt', async (orig) => ({
  ...(await orig<typeof import('../services/paymentReceipt')>()),
  sendPaymentReceipt,
}))

// "The bill still goes out when the credit step throws": the credit step is
// made to break the transaction (a failed statement), not just throw.
const breakCreditStep = vi.hoisted(() => ({ on: false }))
vi.mock('../services/creditUse', async (orig) => {
  const actual = await orig<typeof import('../services/creditUse')>()
  return {
    ...actual,
    settleWholeBillIfCovered: async (client: PoolClient, opts: Parameters<typeof actual.settleWholeBillIfCovered>[1]) => {
      if (breakCreditStep.on) await client.query('SELECT 1 / 0')
      return actual.settleWholeBillIfCovered(client, opts)
    },
  }
})

import { generateInvoices, generateFinalUtilityInvoice } from './invoiceGeneration'
import { createPaidAhead, createIssuedCredit } from '../services/creditUse'
import { lockHousehold } from '../services/moneyPredicates'
import { allocateInvoiceNumber } from '../services/invoiceNumbers'

// Noon in Phoenix on May 5: the May 1 bill is the one due.
const NOW = new Date('2026-05-05T19:00:00Z')
const MAY_1 = '2026-05-01'

interface House { userId: string; landlordId: string; propertyId: string; unitId: string; tenantId: string; leaseId: string }

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

async function house(opts: { landlordId?: string; userId?: string; rent?: number } = {}): Promise<House> {
  return tx(async c => {
    const ll = opts.landlordId ? { landlordId: opts.landlordId, userId: opts.userId! } : await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: opts.rent ?? 460, startDate: '2026-04-01' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    return { userId: ll.userId, landlordId: ll.landlordId, propertyId, unitId, tenantId, leaseId }
  })
}

const paidAhead = (h: House, amount: number) =>
  tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount, fundedBy: 'landlord', receivedAt: '2026-04-18T12:00:00Z' }))
const issued = (h: House, amount: number) =>
  tx(c => createIssuedCredit(c, { landlordId: h.landlordId, tenantId: h.tenantId, leaseId: h.leaseId, amount, category: 'goodwill', reason: 'test', createdBy: h.userId }))

async function olderRow(h: House, o: { amount: number; type?: string; entry?: string; owner?: string; landlordId?: string;
  leaseId?: string | null; status?: string; intent?: string | null; nextRetryAt?: string | null; suspended?: boolean; invoiceId?: string | null }): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id, type, amount, status, due_date,
                           entry_description, revenue_owner, stripe_payment_intent_id, next_retry_at, work_trade_suspended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'2026-04-15',$9,$10,$11,$12, CASE WHEN $13 THEN now() END) RETURNING id`,
    [h.unitId, o.leaseId === undefined ? h.leaseId : o.leaseId, h.tenantId, o.landlordId ?? h.landlordId, o.invoiceId ?? null,
     o.type ?? 'utility', o.amount.toFixed(2), o.status ?? 'pending', o.entry ?? (o.type === 'fee' ? 'OTHERFEE' : 'UTILITY'),
     o.owner ?? 'landlord', o.intent ?? null, o.nextRetryAt ?? null, !!o.suspended])
  return r.rows[0].id
}

const mayRent = async (h: House) => (await db.query<{ id: string; status: string; amount: string; notes: string | null; platform_held: boolean }>(
  `SELECT p.id, p.status, p.amount::text AS amount, p.notes, p.platform_held
     FROM payments p JOIN invoices i ON i.id = p.invoice_id
    WHERE i.lease_id = $1 AND i.due_date = $2 AND p.type = 'rent'`, [h.leaseId, MAY_1])).rows[0]
const statusOf = async (id: string) => (await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status
const prepaidLeft = async (id: string) => Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM lease_prepaid_credits WHERE id = $1`, [id])).rows[0].r)
const issuedLeft = async (id: string) => Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [id])).rows[0].r)
const usesOn = async (paymentId: string) => (await db.query<{ source: string; status: string; amount: string }>(
  `SELECT source, status, amount::text AS amount FROM credit_uses WHERE payment_id = $1 ORDER BY held_at`, [paymentId])).rows

beforeEach(async () => {
  await cleanupAllSchema()
  sendPaymentReceipt.mockClear()
  sendPaymentReceipt.mockImplementation(async () => 'msg_test')
  breakCreditStep.on = false
})

describe('the bill run and the whole-bill rule', () => {
  it('bug 3: the bill run settles a whole eligible bill from credit (Todd) and nothing less (MH 25: $10 < $460)', async () => {
    const todd = await house()
    const mh25 = await house({ landlordId: todd.landlordId, userId: todd.userId })
    const toddCredit = await paidAhead(todd, 460)   // the second month of a two-month check
    const mh25Credit = await paidAhead(mh25, 10)

    await generateInvoices(NOW)

    // Todd: the bill is paid from the money he paid ahead, nothing charged.
    const t = await mayRent(todd)
    expect(t.status).toBe('settled')
    expect(t.notes).toMatch(/Paid with account credit/)
    // Landlord-held money: the landlord already has it, so no payout rides it.
    expect(t.platform_held).toBe(false)
    expect(await prepaidLeft(toddCredit)).toBe(0)
    expect(await usesOn(t.id)).toEqual([{ source: 'whole_bill', status: 'applied', amount: '460.00' }])

    // MH 25: $10 does not cover $460, so nothing is spent and the bill is whole.
    const m = await mayRent(mh25)
    expect(m.status).toBe('pending')
    expect(Number(m.amount)).toBe(460)
    expect(await prepaidLeft(mh25Credit)).toBe(10)
    expect(await usesOn(m.id)).toEqual([])
  })

  it('older open rows on the lease are part of the whole bill', async () => {
    // $470 covers May's rent but not rent + April's $30 water: nothing is spent.
    const a = await house()
    const aWater = await olderRow(a, { amount: 30 })
    const short = await issued(a, 470)
    // $490 covers both: both rows are paid, oldest first, nothing left over.
    const b = await house({ landlordId: a.landlordId, userId: a.userId })
    const bWater = await olderRow(b, { amount: 30 })
    const enough = await issued(b, 490)

    await generateInvoices(NOW)

    expect((await mayRent(a)).status).toBe('pending')
    expect(await statusOf(aWater)).toBe('pending')
    expect(await issuedLeft(short)).toBe(470)

    expect((await mayRent(b)).status).toBe('settled')
    expect(await statusOf(bWater)).toBe('settled')
    expect(await issuedLeft(enough)).toBe(0)
    expect(await usesOn(bWater)).toEqual([{ source: 'whole_bill', status: 'applied', amount: '30.00' }])
  })

  it('the bill run never touches a neighbor\'s utility, GAM rows or work-trade rows', async () => {
    // A GAM fee on the bill: the bill never settles itself, whatever the credit.
    const g = await house()
    const gamFee = await olderRow(g, { amount: 25, type: 'fee', owner: 'gam' })
    const gCredit = await paidAhead(g, 1000)
    await generateInvoices(NOW)
    expect((await mayRent(g)).status).toBe('pending')
    expect(await statusOf(gamFee)).toBe('pending')
    expect(await prepaidLeft(gCredit)).toBe(1000)

    // A neighbor landlord's utility on this household's bill (S616): same.
    const n = await house()
    const neighbor = await house()
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (lease_id, unit_id, tenant_id, landlord_id, invoice_number, due_date, subtotal_rent, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-N-1','2026-04-15',0,0,'pending') RETURNING id`,
      [n.leaseId, n.unitId, n.tenantId, n.landlordId])).rows[0].id
    const theirs = await olderRow(n, { amount: 40, landlordId: neighbor.landlordId, leaseId: null, invoiceId: inv })
    const nCredit = await paidAhead(n, 1000)
    await generateInvoices(NOW)
    expect((await mayRent(n)).status).toBe('pending')
    expect(await statusOf(theirs)).toBe('pending')
    expect(await prepaidLeft(nCredit)).toBe(1000)

    // A work-trade row is being paid by labor: not part of the bill, untouched.
    const w = await house()
    const worked = await olderRow(w, { amount: 460, type: 'rent', entry: 'RENT', suspended: true })
    const wCredit = await paidAhead(w, 460)
    await generateInvoices(NOW)
    expect((await mayRent(w)).status).toBe('settled')
    expect(await statusOf(worked)).toBe('pending')
    expect((await db.query<{ s: Date | null }>(`SELECT work_trade_suspended_at AS s FROM payments WHERE id = $1`, [worked])).rows[0].s).not.toBeNull()
    expect(await usesOn(worked)).toEqual([])
    expect(await prepaidLeft(wCredit)).toBe(0)
  })

  it('a lease with a scheduled ACH retry is skipped', async () => {
    const h = await house()
    // April's water bounced; the bank is tried again on the 7th.
    const bounced = await olderRow(h, { amount: 30, status: 'failed', intent: 'pi_retry_1', nextRetryAt: '2026-05-07T07:00:00Z' })
    const credit = await paidAhead(h, 2000)
    await generateInvoices(NOW)
    expect((await mayRent(h)).status).toBe('pending')
    expect(await statusOf(bounced)).toBe('failed')
    expect(await prepaidLeft(credit)).toBe(2000)
  })

  it('the bill still goes out when the credit step throws', async () => {
    const h = await house()
    const credit = await paidAhead(h, 460)
    breakCreditStep.on = true
    const r = await generateInvoices(NOW)
    expect(r.invoicesInserted).toBe(1)
    const rent = await mayRent(h)
    expect(rent.status).toBe('pending')
    expect(Number(rent.amount)).toBe(460)
    expect(await prepaidLeft(credit)).toBe(460)
    const alerts = await db.query<{ title: string; body: string }>(
      `SELECT title, body FROM admin_notifications WHERE category = 'invoice_credit_apply_failed'`)
    expect(alerts.rows).toHaveLength(1)
    expect(alerts.rows[0].body).toMatch(/bill went out in full/i)
    expect(sendPaymentReceipt).not.toHaveBeenCalled()
  })

  it('a bill paid by credit sends the \'paid with your account credit\' receipt', async () => {
    const h = await house()
    await paidAhead(h, 460)
    // Seen from another connection the moment the receipt goes: the settle is
    // already committed (a receipt never goes out for money that rolled back).
    const seen: string[] = []
    sendPaymentReceipt.mockImplementation(async (o: any) => {
      const r = await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = ANY($1::uuid[])`, [o.paymentIds])
      seen.push(...r.rows.map(x => x.status))
      return 'msg_test'
    })
    await generateInvoices(NOW)
    const rent = await mayRent(h)
    expect(sendPaymentReceipt).toHaveBeenCalledTimes(1)
    const arg = sendPaymentReceipt.mock.calls[0][0]
    expect(arg.paymentIds).toEqual([rent.id])
    expect(arg.method).toBe('your account credit')
    expect(seen).toEqual(['settled'])
  })

  it('a bill nobody\'s credit covers sends no receipt', async () => {
    const h = await house()
    await paidAhead(h, 10)
    await generateInvoices(NOW)
    expect(sendPaymentReceipt).not.toHaveBeenCalled()
  })
})

describe('the bill run takes the household lock', () => {
  it('takes the household lock before it touches anything, waits for another writer, then bills', async () => {
    const h = await house()
    const holder = await db.connect()
    let done = false
    try {
      await holder.query('BEGIN')
      await lockHousehold(holder, h.tenantId, h.landlordId)
      const run = generateInvoices(NOW).then(r => { done = true; return r })
      // The run is parked on the household's lock.
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        const w = await db.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
        waiting = Number(w.rows[0].n) > 0
        if (!waiting) await new Promise(r => setTimeout(r, 50))
      }
      expect(waiting).toBe(true)
      expect(done).toBe(false)
      // The run is parked BEFORE it touched anything: the other writer can
      // still cut an invoice number for this landlord (taken after the lock,
      // the run would be holding that number's row while it waited — and this
      // writer, holding the household, would wait on it: a deadlock).
      await allocateInvoiceNumber(holder, h.landlordId, 2026)
      // The other writer banks money paid ahead and lets go: the bill that
      // follows sees it and is paid from it.
      await createPaidAhead(holder, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 460, fundedBy: 'landlord', receivedAt: '2026-05-05T12:00:00Z' })
      await holder.query('COMMIT')
      const r = await run
      expect(r.invoicesInserted).toBe(1)
    } finally { holder.release() }
    expect((await mayRent(h)).status).toBe('settled')
  })
})

describe('the final utility bill at move-out takes the household lock', () => {
  it('waits for another writer holding the household, then bills what is still owed', async () => {
    const h = await house()
    await tx(async c => {
      const meterId = await seedUtilityMeter(c, { propertyId: h.propertyId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(
        `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
                                    charge_amount, tax_amount, utility_type, status)
         VALUES ($1,$2,$3,$4,$5,'2026-04-01',32.50,0,'water','unbilled')`,
        [meterId, h.unitId, h.tenantId, h.leaseId, h.landlordId])
    })
    const holder = await db.connect()
    let done = false
    try {
      await holder.query('BEGIN')
      await lockHousehold(holder, h.tenantId, h.landlordId)
      const billing = generateFinalUtilityInvoice(h.leaseId).then(r => { done = true; return r })
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        const w = await db.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
        waiting = Number(w.rows[0].n) > 0
        if (!waiting) await new Promise(r => setTimeout(r, 50))
      }
      expect(waiting).toBe(true)
      expect(done).toBe(false)
      // Parked before it cut an invoice number: the other writer can still cut one.
      await allocateInvoiceNumber(holder, h.landlordId, 2026)
      await holder.query('COMMIT')
      const r = await billing
      expect(r?.total).toBe(32.5)
    } finally { holder.release() }
    const rows = await db.query<{ amount: string; status: string }>(
      `SELECT amount::text AS amount, status FROM payments WHERE lease_id = $1 AND type = 'utility'`, [h.leaseId])
    expect(rows.rows).toEqual([{ amount: '32.50', status: 'pending' }])
  })
})

describe('invoice holds follow who owes the utility', () => {
  /** An electric submeter on the unit, unread in April's open reading run. */
  async function unreadSubmeter(h: House): Promise<void> {
    await tx(async c => {
      const meterId = await seedUtilityMeter(c, { propertyId: h.propertyId, utilityType: 'electric', billingMethod: 'submeter' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, h.unitId])
      await c.query(
        `INSERT INTO utility_reading_runs (property_id, landlord_id, billing_cycle_month, opened_on, status)
         VALUES ($1,$2,'2026-04-01','2026-04-26','open')`, [h.propertyId, h.landlordId])
    })
  }
  const invoices = async (h: House) => Number((await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM invoices WHERE lease_id = $1`, [h.leaseId])).rows[0].n)

  it('a lease that names no utilities waits for the unread meter (the meter bills the tenant)', async () => {
    const h = await house()
    await unreadSubmeter(h)
    await generateInvoices(NOW)
    expect(await invoices(h)).toBe(0)
  })

  it('a lease that says the landlord pays for that utility does not wait', async () => {
    const h = await house()
    await unreadSubmeter(h)
    await db.query(
      `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible) VALUES ($1,'electric',FALSE)`,
      [h.leaseId])
    await generateInvoices(NOW)
    expect(await invoices(h)).toBe(1)
  })

  it('a lease that says the tenant pays waits, as before', async () => {
    const h = await house()
    await unreadSubmeter(h)
    await db.query(
      `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible) VALUES ($1,'electric',TRUE)`,
      [h.leaseId])
    await generateInvoices(NOW)
    expect(await invoices(h)).toBe(0)
  })

  it('a flagged reading holds a lease that names no utilities', async () => {
    const h = await house()
    await tx(async c => {
      const meterId = await seedUtilityMeter(c, { propertyId: h.propertyId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, h.unitId])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, billing_cycle_month, reading_value, reading_date, reason, needs_review, created_by_user_id)
         VALUES ($1,'2026-04-01',100,'2026-04-28','monthly_cycle',TRUE,$2)`, [meterId, h.userId])
    })
    await generateInvoices(NOW)
    expect(await invoices(h)).toBe(0)
  })

  /** A flagged read on a water submeter, under the given reason. */
  async function flaggedRead(meterId: string, userId: string, reason: string): Promise<void> {
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, billing_cycle_month, reading_value, reading_date, reason, needs_review, created_by_user_id)
       VALUES ($1,'2026-04-01',100,'2026-04-28',$2,TRUE,$3)`, [meterId, reason, userId])
  }

  it('a billed-off-platform reading still flagged for review does not hold the bill', async () => {
    // Country Acres MH 21/22/24 (10/3): August water reads re-marked
    // 'billed_off_platform' kept needs_review. The run never counts them and
    // the bill engine never bills from them, so they hold nobody's rent.
    const h = await house()
    const meterId = await tx(async c => {
      const id = await seedUtilityMeter(c, { propertyId: h.propertyId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [id, h.unitId])
      return id
    })
    await flaggedRead(meterId, h.userId, 'billed_off_platform')
    await generateInvoices(NOW)
    expect(await invoices(h)).toBe(1)
  })

  it('a landlord who reviews utility bills holds a lease that names no utilities until approval', async () => {
    const h = await house()
    await tx(async c => {
      await c.query(`UPDATE landlords SET review_utility_bills = TRUE WHERE id = $1`, [h.landlordId])
      const meterId = await seedUtilityMeter(c, { propertyId: h.propertyId, utilityType: 'electric', billingMethod: 'submeter' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, h.unitId])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, billing_cycle_month, reading_value, reading_date, reason, created_by_user_id)
         VALUES ($1,'2026-04-01',100,'2026-04-28','monthly_cycle',$2)`, [meterId, h.userId])
      await c.query(
        `INSERT INTO utility_reading_runs (property_id, landlord_id, billing_cycle_month, opened_on, status)
         VALUES ($1,$2,'2026-04-01','2026-04-26','open')`, [h.propertyId, h.landlordId])
    })
    await generateInvoices(NOW)
    expect(await invoices(h)).toBe(0)
  })
})
