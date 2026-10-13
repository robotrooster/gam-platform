/**
 * 10/12 (Nic) — payment health, ONE definition: one stamp per HOUSEHOLD per
 * BILL MONTH, never per line; late fees never decide it; $0 lines are ignored.
 *
 *   GREEN paid on time · YELLOW partial (stays yellow past grace) · ORANGE paid
 *   in full but late · RED nothing paid past grace · GRAY due (not yet late).
 *   A month work trade covers in full is green. The 6th is late for rent due
 *   the 1st with 5 grace days. The onboarding month is good news only.
 *
 * Gerald Logue (Mountain View RV 48) is the case that started it: 25% on the
 * Tenants list, 6% on his profile, 0% on his own screen. Under the one
 * definition he is 1 of 2 months, 50%.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import {
  householdMonths, householdMonthsBoth, householdLines, paymentHealth, judgeMonth, healthByHousehold, householdsOf, addMonths, monthsBetween,
  type HouseholdMonth,
} from './householdMonths'
import { judgeBills } from './creditBillMarks'

const AS_OF = '2026-10-12'
const TZ = 'America/Phoenix'

beforeEach(cleanupAllSchema)

interface World { landlordId: string; userId: string; propertyId: string; unitId: string; leaseId: string; tenantId: string }

async function world(o: { existingTenancy?: boolean; leaseGrace?: number | null } = {}): Promise<World> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = $2, late_fee_grace_days = 5 WHERE id = $1`, [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: 589 })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 495, startDate: '2026-09-01' })
    await c.query(`UPDATE leases SET is_existing_tenancy = $2, late_fee_grace_days = $3 WHERE id = $1`,
      [leaseId, o.existingTenancy === true, o.leaseGrace ?? null])
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query('COMMIT')
    return { landlordId: ll.landlordId, userId: ll.userId, propertyId, unitId, leaseId, tenantId }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

interface Line {
  type: 'rent' | 'utility' | 'fee' | 'late_fee' | 'home_payment'
  amount: number
  /** 'pending' (default), 'settled', 'processing' */
  status?: string
  /** Phoenix local 'YYYY-MM-DD HH:MM' the money came in. */
  paidAt?: string
  method?: 'cash' | 'card'
  notes?: string
  wtSuspended?: boolean
  remainder?: boolean
  tenantId?: string
  leaseId?: string | null
  /** The line's own due date (a daily late fee's day); default the bill's. */
  due?: string
}

const ENTRY: Record<Line['type'], string> = { rent: 'RENT', utility: 'UTILITY', fee: 'OTHERFEE', late_fee: 'LATEFEE', home_payment: 'HOMEPMT' }

/** One bill: an invoice due `due`, written at `writtenAt` (Phoenix local), with its lines. Returns the row ids. */
async function bill(w: World, due: string, writtenAt: string, lines: Line[], o: { wtCredit?: number } = {}): Promise<string[]> {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status,
                           created_at, work_trade_credit_amount)
     VALUES ($1,$2,$3,$4,$5,$6,0,'pending',($7::timestamp AT TIME ZONE $8),$9) RETURNING id`,
    [w.landlordId, w.tenantId, w.leaseId, w.unitId, `INV-${randomUUID().slice(0, 8)}`, due, writtenAt, TZ, o.wtCredit ?? 0])).rows[0].id
  const ids: string[] = []
  for (const l of lines) {
    const settled = l.status === 'settled'
    const id = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, notes, created_at, settled_at, manual_method, work_trade_suspended_at, is_remainder,
                             stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,($12::timestamp AT TIME ZONE $13),
               CASE WHEN $14::text IS NULL THEN NULL ELSE ($14::timestamp AT TIME ZONE $13) END,
               $15, CASE WHEN $16 THEN NOW() END, $17, $18) RETURNING id`,
      [inv, w.unitId, l.leaseId === undefined ? w.leaseId : l.leaseId, l.tenantId ?? w.tenantId, w.landlordId,
       l.type, l.amount, l.status === 'voided' ? 'pending' : (l.status ?? 'pending'), l.due ?? due, ENTRY[l.type], l.notes ?? null, writtenAt, TZ,
       settled ? l.paidAt ?? null : null,
       settled && l.method === 'cash' ? 'cash' : null, l.wtSuspended === true, l.remainder === true,
       l.status === 'processing' ? `pi_${randomUUID().slice(0, 8)}` : null])).rows[0].id
    if (l.status === 'voided') {
      await db.query(`UPDATE payments SET status = 'voided', voided_at = NOW(), void_reason = 'test' WHERE id = $1`, [id])
    }
    if (settled && l.method === 'card') {
      const rem = (await db.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                         payment_method, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
         VALUES ($1,$2,$3,$4,$4,0,'settled','card',0,$5,($6::timestamp AT TIME ZONE $7),($6::timestamp AT TIME ZONE $7)) RETURNING id`,
        [w.tenantId, w.leaseId, w.landlordId, l.amount, `pi_${randomUUID().slice(0, 8)}`, l.paidAt, TZ])).rows[0].id
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`, [rem, id, l.amount])
    }
    ids.push(id)
  }
  return ids
}

const months = (w: World, from = '2026-08', through = '2026-10') =>
  householdMonths({ landlordIds: [w.landlordId], from, through, asOf: AS_OF })
const monthOf = (ms: HouseholdMonth[], m: string) => ms.find(x => x.month === m)!

describe('judgeMonth (the stamp rule)', () => {
  const base = { chargedBaseC: 50000, workTradeBaseC: 0, owedBaseC: 0, baseInC: 50000, openPastGrace: false,
    daysPastGraceOpen: 0, daysPastGracePaid: 0, onboarding: false, lateFeeOnBill: false }
  it('paid in full within grace is green and counted on time', () => {
    expect(judgeMonth(base)).toMatchObject({ stamp: 'paid_on_time', counted: true, onTime: true })
  })
  it('paid in full after grace is orange with its days', () => {
    expect(judgeMonth({ ...base, daysPastGracePaid: 3 })).toMatchObject({ stamp: 'paid_late', days: 3, counted: true, onTime: false })
  })
  it('some money in and something owed is yellow — past grace it counts, inside grace it does not yet', () => {
    expect(judgeMonth({ ...base, owedBaseC: 30000, baseInC: 20000, openPastGrace: true, daysPastGraceOpen: 4 }))
      .toMatchObject({ stamp: 'partial', days: 4, counted: true })
    expect(judgeMonth({ ...base, owedBaseC: 30000, baseInC: 20000 })).toMatchObject({ stamp: 'partial', counted: false })
  })
  it('nothing in: red past grace, gray before', () => {
    expect(judgeMonth({ ...base, owedBaseC: 50000, baseInC: 0, openPastGrace: true, daysPastGraceOpen: 7 }))
      .toMatchObject({ stamp: 'outstanding', days: 7, counted: true })
    expect(judgeMonth({ ...base, owedBaseC: 50000, baseInC: 0 })).toMatchObject({ stamp: 'due', counted: false })
  })
  it('a month of only late fees has no stamp', () => {
    expect(judgeMonth({ ...base, chargedBaseC: 0 })).toMatchObject({ stamp: null, counted: false })
  })
  it('onboarding month: on time counts; late is left out unless a late fee was charged on the bill', () => {
    expect(judgeMonth({ ...base, onboarding: true })).toMatchObject({ counted: true, onTime: true })
    expect(judgeMonth({ ...base, onboarding: true, daysPastGracePaid: 9 })).toMatchObject({ stamp: 'paid_late', counted: false })
    expect(judgeMonth({ ...base, onboarding: true, daysPastGracePaid: 9, lateFeeOnBill: true })).toMatchObject({ counted: true })
  })
  it('work trade covering every base charge is green', () => {
    expect(judgeMonth({ ...base, workTradeBaseC: 50000, baseInC: 0 })).toMatchObject({ stamp: 'paid_on_time', workTradeOnly: true, onTime: true })
  })
})

describe('householdMonths — Gerald Logue (Mountain View RV 48)', () => {
  it('September (written 9/16, paid 9/17) is on time; October is outstanding; the $0 electric is ignored; 1 of 2 = 50%', async () => {
    const w = await world({ existingTenancy: true })
    // September: due 9/1, written 9/16, paid online 9/17 at 10:13.
    await bill(w, '2026-09-01', '2026-09-16 09:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'card', paidAt: '2026-09-17 10:13' }])
    // October: rent, the $0 August electric, the $22.47 estimate, and 12 daily $5 late fees.
    await bill(w, '2026-10-01', '2026-09-30 05:00', [
      { type: 'rent', amount: 495 },
      { type: 'utility', amount: 0, notes: 'Electric meter 49083 → 49083 · 0 kWh' },
      { type: 'utility', amount: 22.47 },
      ...Array.from({ length: 12 }, (_, i) => ({ type: 'late_fee' as const, amount: 5, due: `2026-10-${String(i + 1).padStart(2, '0')}` })),
    ])
    const ms = await months(w)
    expect(ms.map(m => m.month)).toEqual(['2026-09', '2026-10'])
    expect(monthOf(ms, '2026-09')).toMatchObject({
      household_id: w.tenantId, stamp: 'paid_on_time', counted: true, on_time: true, onboarding: true,
      charged: 495, paid: 495, owed: 0, days_past_grace: 0, first_paid_on: '2026-09-17', paid_in_full_on: '2026-09-17',
    })
    expect(monthOf(ms, '2026-10')).toMatchObject({
      stamp: 'outstanding', counted: true, on_time: false,
      charged: 577.47, charged_late_fees: 60, charged_base: 517.47, paid: 0, owed: 577.47, owed_base: 517.47,
      // the 6th is the first late day: 10/12 is 7 days past grace
      first_late_day: '2026-10-06', days_past_grace: 7,
    })
    const h = paymentHealth(ms, '2026-10')
    expect(h).toMatchObject({ percent: 50, on_time: 1, counted: 2, outstanding: 1, label: '50%, 1 of 2 months' })
    // The $0 line is not a line anywhere.
    const lines = await householdLines({ landlordIds: [w.landlordId], from: '2026-09', through: '2026-10', asOf: AS_OF })
    expect(lines.filter(l => l.charged === 0)).toEqual([])
    expect(lines.find(l => l.type === 'rent' && l.month === '2026-09')).toMatchObject({ label: 'Rent', paid_on: '2026-09-17', how_paid: 'Card · online' })
    expect(lines.filter(l => l.is_late_fee)).toHaveLength(12)
  })
})

describe('householdMonths — the first late day and days past grace', () => {
  it('paid on the 5th is on time; paid on the 6th is 1 day past grace', async () => {
    const w = await world()
    await bill(w, '2026-08-01', '2026-07-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-08-05 16:00' }])
    await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-06 09:00' }])
    const ms = await months(w)
    expect(monthOf(ms, '2026-08')).toMatchObject({ stamp: 'paid_on_time', days_past_grace: 0 })
    expect(monthOf(ms, '2026-09')).toMatchObject({ stamp: 'paid_late', days_past_grace: 1, paid_in_full_on: '2026-09-06' })
  })

  it('the lease grace wins over the property; nothing paid inside it is gray Due and not counted', async () => {
    const w = await world({ leaseGrace: 15 })
    await bill(w, '2026-10-01', '2026-09-30 05:00', [{ type: 'rent', amount: 495 }])
    const [oct] = await months(w, '2026-10', '2026-10')
    expect(oct).toMatchObject({ stamp: 'due', counted: false, grace_days: 15, first_late_day: '2026-10-16', days_past_grace: 0 })
  })

  it('late fees never decide the month: rent paid on time with a late fee still owed is green, the fee is owed', async () => {
    const w = await world()
    await bill(w, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' },
      { type: 'late_fee', amount: 25, due: '2026-09-06' },
    ])
    const [sep] = await months(w, '2026-09', '2026-09')
    expect(sep).toMatchObject({ stamp: 'paid_on_time', charged: 520, charged_late_fees: 25, owed: 25, owed_base: 0, late_fee_on_bill: true })
  })
})

describe('householdMonths — partial payments', () => {
  it('part paid, rest still owed past grace: yellow, counted, Owed is the difference; paid off later: orange', async () => {
    const w = await world()
    const [, rest] = await bill(w, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 200, status: 'settled', method: 'cash', paidAt: '2026-09-03 10:00' },
      { type: 'rent', amount: 295, remainder: true, notes: 'What is left of this bill after a part payment' },
    ])
    let [sep] = await months(w, '2026-09', '2026-09')
    expect(sep).toMatchObject({ stamp: 'partial', counted: true, charged: 495, paid: 200, owed: 295, first_paid_on: '2026-09-03', paid_in_full_on: null })
    // The rest is paid on 9/10: paid in full, 5 days past grace (the 5th is the last grace day).
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = ('2026-09-10 12:00'::timestamp AT TIME ZONE $2) WHERE id = $1`, [rest, TZ])
    ;[sep] = await months(w, '2026-09', '2026-09')
    expect(sep).toMatchObject({ stamp: 'paid_late', days_past_grace: 5, paid: 495, owed: 0, first_paid_on: '2026-09-03', paid_in_full_on: '2026-09-10' })
  })
})

describe('householdMonths — work trade', () => {
  it('a month work trade covers in full is green and counted on time; it is its own bucket, never paid or owed', async () => {
    const w = await world()
    await bill(w, '2026-10-01', '2026-09-30 05:00', [{ type: 'rent', amount: 495, wtSuspended: true }])
    const [oct] = await months(w, '2026-10', '2026-10')
    expect(oct).toMatchObject({ stamp: 'paid_on_time', counted: true, on_time: true, work_trade_only: true,
      charged: 495, work_trade: 495, paid: 0, owed: 0 })
  })

  it('a closed work-trade month (settled at $0, value on the invoice) still reads covered', async () => {
    const w = await world()
    await bill(w, '2026-09-01', '2026-08-30 05:00',
      [{ type: 'rent', amount: 0, status: 'settled', paidAt: '2026-10-01 01:00', notes: 'Covered by work-trade credit' }],
      { wtCredit: 495 })
    const [sep] = await months(w, '2026-09', '2026-09')
    expect(sep).toMatchObject({ stamp: 'paid_on_time', work_trade_only: true, charged: 495, work_trade: 495, owed: 0 })
  })

  // 10/12: the month close lowers a held line to what the hours did not cover
  // and lifts the hold about the 1st of the next month — that is when it
  // becomes a bill anyone can pay, so lateness counts from then, never from
  // before its due date ("Lateness start = due date, or the day GAM wrote the
  // bill when later").
  it('a lapse the month close bills counts from its release, not the due date', async () => {
    const w = await world()
    const [line] = await bill(w, '2026-10-01', '2026-09-30 05:00',
      [{ type: 'rent', amount: 460, wtSuspended: true, notes: 'Work trade — suspended while the hours are worked; settled at month close' }],
      { wtCredit: 335 })
    // The close, 11/1 at 1 am: $125 uncovered, the hold lifted (the change journal keeps when).
    await db.query(`UPDATE payments SET amount = 125, work_trade_suspended_at = NULL WHERE id = $1`, [line])
    await db.query(
      `UPDATE audit_row_changes SET changed_at = ('2026-11-01 01:00'::timestamp AT TIME ZONE $2)
        WHERE table_name = 'payments' AND row_id = $1`, [line, TZ])
    // The day it was billed it is not late at all.
    let [oct] = await householdMonths({ landlordIds: [w.landlordId], from: '2026-10', through: '2026-10', asOf: '2026-11-01' })
    expect(oct).toMatchObject({ stamp: 'due', days_past_grace: 0, owed: 125, work_trade: 335, charged: 460, first_late_day: '2026-11-06' })
    // Paid the next day: on time — not "paid late, 27 days".
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = ('2026-11-02 10:00'::timestamp AT TIME ZONE $2) WHERE id = $1`, [line, TZ])
    ;[oct] = await householdMonths({ landlordIds: [w.landlordId], from: '2026-10', through: '2026-10', asOf: '2026-11-05' })
    expect(oct).toMatchObject({ stamp: 'paid_on_time', days_past_grace: 0, paid: 125, owed: 0, work_trade: 335 })
  })

  it('a charge work trade does not cover is judged normally (Curtis Clabough\'s water)', async () => {
    const w = await world()
    await bill(w, '2026-10-01', '2026-09-30 05:00', [
      { type: 'rent', amount: 495, wtSuspended: true },
      { type: 'utility', amount: 110.55 },
    ])
    const [oct] = await months(w, '2026-10', '2026-10')
    expect(oct).toMatchObject({ stamp: 'outstanding', work_trade: 495, owed: 110.55, charged: 605.55, work_trade_only: false })
  })
})

describe('householdMonths — one household, every dollar once', () => {
  it('a co-tenant\'s own charge belongs to the household; credit applied counts once', async () => {
    const w = await world()
    const co = await (async () => { const c = await db.connect(); try { return await seedTenant(c) } finally { c.release() } })()
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'co_tenant')`, [w.leaseId, co])
    const [rent, fee] = await bill(w, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 495 },
      { type: 'fee', amount: 50, tenantId: co, leaseId: null, status: 'settled', method: 'cash', paidAt: '2026-09-02 08:00' },
    ])
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status, created_by)
       VALUES ($1,$2,$3,495,495,'goodwill','test','active',$4) RETURNING id`, [w.landlordId, w.tenantId, w.leaseId, w.userId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,495,'2026-09-01','desk','applied',('2026-09-01 08:00'::timestamp AT TIME ZONE $4))`,
      [credit, rent, w.leaseId, TZ])
    // The credit paid the whole charge: settled the moment it was applied.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = ('2026-09-01 08:00'::timestamp AT TIME ZONE $2) WHERE id = $1`, [rent, TZ])
    const ms = await months(w, '2026-09', '2026-09')
    expect(ms).toHaveLength(1)
    expect(ms[0]).toMatchObject({ household_id: w.tenantId, stamp: 'paid_on_time', charged: 545, credit: 495, paid: 50, owed: 0 })
    expect(fee).toBeTruthy()
    const hh = await householdsOf([co, w.tenantId], [w.landlordId])
    expect(hh.get(co)).toBe(w.tenantId)
    expect(hh.get(w.tenantId)).toBe(w.tenantId)
  })

  it('health for many households in one query', async () => {
    const a = await world()
    await bill(a, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' }])
    await bill(a, '2026-10-01', '2026-09-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-10-09 10:00' }])
    const h = await healthByHousehold({ landlordIds: [a.landlordId], householdIds: [a.tenantId], through: '2026-10', asOf: AS_OF })
    expect(h.get(a.tenantId)).toMatchObject({ percent: 50, on_time: 1, counted: 2, paid_late: 1, from: '2026-09', through: '2026-10' })
  })

  // 10/12 (Nic): "Payment health and a tenant's history are ALL-TIME (since the
  // household joined GAM), not 12 months."
  it('health is all time: a month from over a year ago still counts', async () => {
    const a = await world()
    await bill(a, '2025-06-01', '2025-05-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2025-06-20 10:00' }])
    await bill(a, '2026-10-01', '2026-09-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-10-02 10:00' }])
    const h = (await healthByHousehold({ landlordIds: [a.landlordId], householdIds: [a.tenantId], through: '2026-10', asOf: AS_OF })).get(a.tenantId)
    expect(h).toMatchObject({ percent: 50, on_time: 1, counted: 2, paid_late: 1, from: '2025-06', through: '2026-10', label: '50%, 1 of 2 months' })
    // A month after the one judged to is not in it.
    const ms = await householdMonths({ landlordIds: [a.landlordId], from: '2000-01', through: '2026-10', asOf: AS_OF })
    expect(paymentHealth(ms, '2025-12')).toMatchObject({ counted: 1, on_time: 0, from: '2025-06', through: '2025-12' })
    // Nothing billed yet: nothing to judge, and the range is the month itself.
    expect(paymentHealth([], '2026-10')).toMatchObject({ percent: null, counted: 0, from: '2026-10', through: '2026-10', label: 'No months to judge yet' })
  })

  it('voided lines and a different company\'s charges are not counted', async () => {
    const w = await world()
    await bill(w, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' },
      { type: 'utility', amount: 40, status: 'voided' },
    ])
    const [sep] = await months(w, '2026-09', '2026-09')
    expect(sep).toMatchObject({ charged: 495, owed: 0, stamp: 'paid_on_time' })
    const other = await world()
    expect(await householdMonths({ landlordIds: [other.landlordId], from: '2026-09', through: '2026-09', asOf: AS_OF })).toEqual([])
  })
})

// 10/12 review: the Rent Roll reads the charges once and adds the property
// months up into the household's months (its health) — the fold must give
// exactly what reading them per household gives.
describe('householdMonthsBoth — one read, both groupings', () => {
  it('a household at two properties: the folded months equal the per-household read, the property months the per-property read', async () => {
    const w = await world()
    const c = await db.connect()
    let w2: World
    try {
      const propertyId = await seedProperty(c, { landlordId: w.landlordId, ownerUserId: w.userId, managedByUserId: w.userId })
      await c.query(`UPDATE properties SET timezone = $2, late_fee_grace_days = 10 WHERE id = $1`, [propertyId, TZ])
      const unitId = await seedUnit(c, { propertyId, landlordId: w.landlordId, rentAmount: 300 })
      const leaseId = await seedLease(c, { unitId, landlordId: w.landlordId, rentAmount: 300, startDate: '2026-09-01' })
      await seedLeaseTenant(c, { leaseId, tenantId: w.tenantId, role: 'primary' })
      w2 = { ...w, propertyId, unitId, leaseId }
    } finally { c.release() }
    // September: on time at the first place, paid late at the second, a late fee owed there.
    await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' }])
    await bill(w2, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 300, status: 'settled', method: 'card', paidAt: '2026-09-20 10:00' },
      { type: 'late_fee', amount: 25 },
    ])
    // October: part paid at one place, nothing yet at the other.
    await bill(w, '2026-10-01', '2026-09-30 05:00', [
      { type: 'rent', amount: 200, status: 'settled', method: 'cash', paidAt: '2026-10-03 10:00' },
      { type: 'rent', amount: 295, remainder: true, notes: 'What is left of this bill after a part payment' },
    ])
    await bill(w2, '2026-10-01', '2026-09-30 05:00', [{ type: 'rent', amount: 300 }, { type: 'utility', amount: 42.17 }])

    const scope = { landlordIds: [w.landlordId], from: '2000-01', through: '2026-10', asOf: AS_OF }
    const both = await householdMonthsBoth(scope)
    expect(both.byHousehold).toEqual(await householdMonths(scope))
    expect(both.byProperty).toEqual(await householdMonths({ ...scope, byProperty: true }))
    expect(both.byProperty).toHaveLength(4)
    expect(both.byHousehold.map(m => [m.month, m.stamp, m.charged, m.owed])).toEqual([
      ['2026-09', 'paid_late', 820, 25],
      ['2026-10', 'partial', 837.17, 637.17],
    ])
  })
})

// 10/13 (Nic): "when someone is renting 2 spots with 2 leases it is 2
// households" — the Rent Roll's rows and payment health count each lease.
describe('householdMonths byLease — a household is a lease', () => {
  it('two leases of one person: two households by lease, one by person; a lease-less charge joins the person\'s lease', async () => {
    const w = await world()
    const c = await db.connect()
    let w2: World
    try {
      const unitId = await seedUnit(c, { propertyId: w.propertyId, landlordId: w.landlordId, rentAmount: 300 })
      // The newer of the two leases (world()'s starts 2026-09-01).
      const leaseId = await seedLease(c, { unitId, landlordId: w.landlordId, rentAmount: 300, startDate: '2026-09-15' })
      await seedLeaseTenant(c, { leaseId, tenantId: w.tenantId, role: 'primary' })
      w2 = { ...w, unitId, leaseId }
    } finally { c.release() }
    await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' }])
    await bill(w2, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 300, status: 'settled', method: 'cash', paidAt: '2026-09-12 10:00' }])
    // A counter charge on no lease and no bill: the person's newest active lease takes it.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,'fee',20,'pending','2026-09-01','OTHERFEE','2026-08-30')`, [w2.unitId, w.tenantId, w.landlordId])
    const scope = { landlordIds: [w.landlordId], from: '2026-09', through: '2026-09', asOf: AS_OF }
    const perLease = await householdMonths({ ...scope, byLease: true })
    expect(perLease.map(m => [m.lease_id, m.household_id, m.charged, m.stamp]).sort()).toEqual([
      [w.leaseId, w.tenantId, 495, 'paid_on_time'],
      // its rent paid late and the counter fee still owed: part paid
      [w2.leaseId, w.tenantId, 320, 'partial'],
    ].sort())
    const perPerson = await householdMonths(scope)
    expect(perPerson.map(m => [m.lease_id, m.charged, m.stamp])).toEqual([[null, 815, 'partial']])
    // One lease alone, and its lines.
    const one = await householdMonths({ ...scope, leaseIds: [w.leaseId] })
    expect(one.map(m => [m.charged, m.stamp])).toEqual([[495, 'paid_on_time']])
    const lines = await householdLines({ ...scope, leaseIds: [w2.leaseId] })
    expect(lines.map(l => [l.lease_id, l.type, l.charged]).sort()).toEqual([[w2.leaseId, 'fee', 20], [w2.leaseId, 'rent', 300]].sort())
  })

  // "2 spots with 2 leases it is 2 households": a charge on no lease on one of
  // the two spots is that spot's lease, never the newer lease's.
  it('a lease-less charge on the older lease\'s space is the older lease\'s', async () => {
    const w = await world()
    const c = await db.connect()
    let w2: World
    try {
      const unitId = await seedUnit(c, { propertyId: w.propertyId, landlordId: w.landlordId, rentAmount: 300 })
      const leaseId = await seedLease(c, { unitId, landlordId: w.landlordId, rentAmount: 300, startDate: '2026-09-15' })
      await seedLeaseTenant(c, { leaseId, tenantId: w.tenantId, role: 'primary' })
      w2 = { ...w, unitId, leaseId }
    } finally { c.release() }
    await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' }])
    await bill(w2, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 300, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' }])
    // A counter charge on world()'s space — the OLDER lease's — on no lease and no bill.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,'fee',20,'pending','2026-09-01','OTHERFEE','2026-08-30')`, [w.unitId, w.tenantId, w.landlordId])
    const perLease = await householdMonths({ landlordIds: [w.landlordId], from: '2026-09', through: '2026-09', asOf: AS_OF, byLease: true })
    expect(perLease.map(m => [m.lease_id, m.charged, m.stamp]).sort()).toEqual([
      [w.leaseId, 515, 'partial'],
      [w2.leaseId, 300, 'paid_on_time'],
    ].sort())
    const lines = await householdLines({ landlordIds: [w.landlordId], from: '2026-09', through: '2026-09', asOf: AS_OF, leaseIds: [w.leaseId] })
    expect(lines.map(l => [l.type, l.charged]).sort()).toEqual([['fee', 20], ['rent', 495]])
  })

  it('a neighbor company\'s line on the lease\'s bill is the same household, never a second one', async () => {
    const w = await world()
    const other = (await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id, business_name, billing_starts_at) VALUES ($1, 'Bravo LLC', DATE '2000-01-01') RETURNING id`, [w.userId])).rows[0].id
    const [rent] = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' }])
    const inv = (await db.query<{ invoice_id: string }>(`SELECT invoice_id FROM payments WHERE id = $1`, [rent])).rows[0].invoice_id
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,'utility',40,'pending','2026-09-01','UTILITY','2026-08-30')`, [inv, w.unitId, w.tenantId, other])
    const ms = await householdMonths({ landlordIds: [w.landlordId, other], from: '2026-09', through: '2026-09', asOf: AS_OF, byLease: true })
    expect(ms.map(m => [m.lease_id, m.charged, m.owed, m.stamp])).toEqual([[w.leaseId, 535, 40, 'partial']])
  })
})

// 10/13 (Nic): "Hand-logged payment entered AFTER the late fee posted counts
// late from the day it was logged (Nic's 10/6 rule) — the Rent Roll follows
// it, same as credit history."
describe('householdMonths — logged by hand after the late fee (10/6), the credit history\'s rule', () => {
  it('counts from the day GAM recorded it, exactly as the credit history judges the bill; without the fee, the typed day', async () => {
    const w = await world()
    const today = (await db.query<{ d: string }>(`SELECT (NOW() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d
    const due = (await db.query<{ d: string }>(`SELECT ($1::date - 20)::text AS d`, [today])).rows[0].d
    const [rent] = await bill(w, due, `${due} 05:00`, [{ type: 'rent', amount: 495 }])
    const inv = (await db.query<{ invoice_id: string }>(`SELECT invoice_id FROM payments WHERE id = $1`, [rent])).rows[0].invoice_id
    const fee = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,$5,'late_fee',25,'pending',$6::date + 5,'LATEFEE', NOW() - interval '15 days') RETURNING id`,
      [inv, w.unitId, w.leaseId, w.tenantId, w.landlordId, due])).rows[0].id
    // The desk logs the cash today, typed as paid on the due day.
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = ($2::timestamp AT TIME ZONE $3) WHERE id = $1`,
      [rent, `${due} 10:00`, TZ])
    const month = due.slice(0, 7)
    const judge = async () => {
      const [m] = await householdMonths({ landlordIds: [w.landlordId], from: month, through: month })
      const [b] = await judgeBills(db, [inv])
      return { m, b }
    }
    const late = await judge()
    expect(late.m).toMatchObject({ stamp: 'paid_late', paid_in_full_on: today })
    expect(late.b).toMatchObject({ stamp: 'paid_late', paidInFullOn: today, loggedAfterLateFee: true })
    expect(late.m.days_past_grace).toBe(late.b.days)
    const [line] = (await householdLines({ landlordIds: [w.landlordId], from: month, through: month })).filter(l => l.type === 'rent')
    expect(line).toMatchObject({ paid_on: today, logged_after_late_fee: true })
    // The landlord deletes the fee: the typed day stands, on both.
    await db.query(`UPDATE payments SET status = 'voided', voided_at = NOW(), void_reason = 'deleted' WHERE id = $1`, [fee])
    const clean = await judge()
    expect(clean.m).toMatchObject({ stamp: 'paid_on_time', paid_in_full_on: due })
    expect(clean.b).toMatchObject({ stamp: 'paid_on_time', paidInFullOn: due, loggedAfterLateFee: false })
  })

  it('a bank line matched to it decides the day instead', async () => {
    const w = await world()
    const [rent] = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495 }])
    const inv = (await db.query<{ invoice_id: string }>(`SELECT invoice_id FROM payments WHERE id = $1`, [rent])).rows[0].invoice_id
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,$5,'late_fee',25,'pending','2026-09-06','LATEFEE',('2026-09-06 00:05'::timestamp AT TIME ZONE $6))`,
      [inv, w.unitId, w.leaseId, w.tenantId, w.landlordId, TZ])
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = ('2026-09-03 10:00'::timestamp AT TIME ZONE $2) WHERE id = $1`, [rent, TZ])
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`, [w.landlordId])).rows[0].id
    const txn = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1,$2,$3,'2026-09-03',495,'BRANCH DEPOSIT','matched') RETURNING id`, [conn, w.landlordId, randomUUID()])).rows[0].id
    await db.query(`INSERT INTO bank_deposit_allocations (bank_transaction_id, payment_id, landlord_id, amount, effective_paid_date)
                    VALUES ($1,$2,$3,495,'2026-09-03')`, [txn, rent, w.landlordId])
    const [sep] = await householdMonths({ landlordIds: [w.landlordId], from: '2026-09', through: '2026-09', asOf: AS_OF })
    expect(sep).toMatchObject({ stamp: 'paid_on_time', paid_in_full_on: '2026-09-03' })
    const [b] = await judgeBills(db, [inv], { asOf: AS_OF })
    expect(b).toMatchObject({ stamp: 'paid_on_time', paidInFullOn: '2026-09-03', loggedAfterLateFee: false })
  })
})

describe('month helpers', () => {
  it('adds months across a year', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(monthsBetween('2026-10', '2027-01')).toEqual(['2026-10', '2026-11', '2026-12', '2027-01'])
  })
})
