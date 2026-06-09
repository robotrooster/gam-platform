/**
 * Lease lifecycle integration tests — session 1 of 2.
 *
 * Covers:
 *   - moveInBundle.generateMoveInInvoice — full vs prorated rent,
 *     move_in fees, deposit fee, idempotency
 *   - invoiceGeneration.generateInvoices — monthly cron generation,
 *     catch-up backfill, idempotency, monthly fees attached
 *   - lateFees.generateLateFeesForTimezone — initial fee on grace
 *     expiry, cap-edge clamp, no double-fire
 *
 * Session 2 carries forward: utility line-items on monthly invoices,
 * sublease branch, late-fee accrual ticks across multiple days, cron
 * registration via timezoneCronManager. The fake-clock pattern lives
 * in `nowUtc` (generateInvoices accepts it directly) and in seeding
 * `due_date` to a calculable past offset for late-fee tests.
 */

import { DateTime } from 'luxon'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { generateMoveInInvoice, moveInRentAmount } from './moveInBundle'
import { generateInvoices, dueDatesInRange } from './invoiceGeneration'
import { generateLateFeesForTimezone } from './lateFees'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant,
  seedProperty, seedUnit,
  seedLease, seedLeaseTenant, seedLeaseFee,
  seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

// ── Stack builder ───────────────────────────────────────────────────────────

interface LeaseStack {
  ownerUserId: string
  landlordId: string
  tenantId: string
  propertyId: string
  unitId: string
  leaseId: string
}

async function buildLeaseStack(opts: {
  rentAmount?: number
  rentDueDay?: number
  startDate?: string
  endDate?: string | null
  status?: 'pending' | 'active' | 'expired' | 'terminated'
  lateFeeGraceDays?: number
  lateFeeInitialAmount?: number
  lateFeeInitialType?: 'flat' | 'percent_of_rent'
  lateFeeEnabled?: boolean
  lateFeeCapAmount?: number | null
  lateFeeCapType?: 'flat' | 'percent_of_rent' | null
} = {}): Promise<LeaseStack> {
  const client = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId, managedByUserId: ownerUserId,
    })
    const unitId = await seedUnit(client, {
      propertyId, landlordId, rentAmount: opts.rentAmount ?? 1000,
    })
    const leaseId = await seedLease(client, {
      unitId, landlordId,
      rentAmount: opts.rentAmount ?? 1000,
      status: opts.status ?? 'active',
      startDate: opts.startDate ?? '2026-01-01',
    })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })

    // Apply optional lease overrides for late-fee + due-day testing.
    if (opts.rentDueDay !== undefined ||
        opts.endDate !== undefined ||
        opts.lateFeeGraceDays !== undefined ||
        opts.lateFeeInitialAmount !== undefined ||
        opts.lateFeeInitialType !== undefined ||
        opts.lateFeeEnabled !== undefined ||
        opts.lateFeeCapAmount !== undefined ||
        opts.lateFeeCapType !== undefined) {
      await client.query(
        `UPDATE leases
            SET rent_due_day             = COALESCE($2, rent_due_day),
                end_date                 = $3,
                late_fee_grace_days      = COALESCE($4, late_fee_grace_days),
                late_fee_initial_amount  = COALESCE($5, late_fee_initial_amount),
                late_fee_initial_type    = COALESCE($6, late_fee_initial_type),
                late_fee_enabled         = COALESCE($7, late_fee_enabled),
                late_fee_cap_amount      = $8,
                late_fee_cap_type        = $9
          WHERE id = $1`,
        [
          leaseId,
          opts.rentDueDay ?? null,
          opts.endDate === undefined ? null : opts.endDate,
          opts.lateFeeGraceDays ?? null,
          opts.lateFeeInitialAmount ?? null,
          opts.lateFeeInitialType ?? null,
          opts.lateFeeEnabled ?? null,
          opts.lateFeeCapAmount ?? null,
          opts.lateFeeCapType ?? null,
        ]
      )
    }
    return { ownerUserId, landlordId, tenantId, propertyId, unitId, leaseId }
  } finally {
    client.release()
  }
}

// ── Move-in invoice ─────────────────────────────────────────────────────────

describe('moveInRentAmount — pure math', () => {
  it('returns full rent when start_date.day === 1', () => {
    expect(moveInRentAmount(1000, '2026-01-01')).toBe(1000)
  })

  it('prorates when start_date.day > 1 (Jan 15 of 31-day month → 17/31)', () => {
    // (31 - 15 + 1) / 31 * 1000 = 17/31 * 1000 ≈ 548.39
    const got = moveInRentAmount(1000, '2026-01-15')
    expect(got).toBeCloseTo(17 / 31 * 1000, 1)
  })

  it('Feb 28 in a non-leap year → 1/28 of rent', () => {
    // (28 - 28 + 1)/28 * 1000 = 1/28 * 1000 ≈ 35.71
    const got = moveInRentAmount(1000, '2026-02-28')
    expect(got).toBeCloseTo(1000 / 28, 1)
  })
})

describe('generateMoveInInvoice', () => {
  it('full rent when start_date is the 1st: invoice + payment rows created', async () => {
    const stack = await buildLeaseStack({ rentAmount: 1000, startDate: '2026-01-01' })
    const res = await generateMoveInInvoice({
      lease_id: stack.leaseId,
      unit_id: stack.unitId,
      tenant_id: stack.tenantId,
      landlord_id: stack.landlordId,
      rent_amount: 1000,
      start_date: '2026-01-01',
    })
    expect(res.invoiceCreated).toBe(true)
    expect(res.rentAmount).toBe(1000)
    expect(res.moveInFeesInserted).toBe(0)
    expect(res.depositInserted).toBe(false)

    const invoice = await db.query<{
      due_date: string; subtotal_rent: string; subtotal_fees: string;
      subtotal_deposits: string; total_amount: string
    }>(
      `SELECT due_date::text, subtotal_rent::text, subtotal_fees::text,
              subtotal_deposits::text, total_amount::text
         FROM invoices WHERE id=$1`,
      [res.invoiceId]
    )
    expect(invoice.rows[0]).toMatchObject({
      due_date: '2026-01-01',
      subtotal_rent: '1000.00',
      subtotal_fees: '0.00',
      subtotal_deposits: '0.00',
      total_amount: '1000.00',
    })

    const pay = await db.query<{ type: string; amount: string; status: string }>(
      `SELECT type, amount::text AS amount, status FROM payments
        WHERE invoice_id=$1`,
      [res.invoiceId]
    )
    expect(pay.rows).toHaveLength(1)
    expect(pay.rows[0]).toMatchObject({ type: 'rent', amount: '1000.00', status: 'pending' })
  })

  it('prorates rent + attaches move-in fees', async () => {
    const stack = await buildLeaseStack({ rentAmount: 1000, startDate: '2026-01-15' })
    const client = await getClient()
    try {
      await seedLeaseFee(client, {
        leaseId: stack.leaseId, feeType: 'application_fee',
        amount: 50, dueTiming: 'move_in',
      })
      await seedLeaseFee(client, {
        leaseId: stack.leaseId, feeType: 'pet_fee',
        amount: 100, dueTiming: 'move_in',
      })
    } finally {
      client.release()
    }
    const res = await generateMoveInInvoice({
      lease_id: stack.leaseId,
      unit_id: stack.unitId,
      tenant_id: stack.tenantId,
      landlord_id: stack.landlordId,
      rent_amount: 1000,
      start_date: '2026-01-15',
    })
    expect(res.moveInFeesInserted).toBe(2)
    expect(res.depositInserted).toBe(false)

    const inv = await db.query<{
      subtotal_rent: string; subtotal_fees: string; total_amount: string
    }>(
      `SELECT subtotal_rent::text, subtotal_fees::text, total_amount::text
         FROM invoices WHERE id=$1`,
      [res.invoiceId]
    )
    // prorated rent ≈ 548.39 + 150 fees = 698.39
    expect(Number(inv.rows[0].subtotal_fees)).toBe(150)
    expect(Number(inv.rows[0].subtotal_rent)).toBeCloseTo(548.39, 1)
    expect(Number(inv.rows[0].total_amount)).toBeCloseTo(698.39, 1)

    const feePayments = await db.query<{ type: string; amount: string }>(
      `SELECT type, amount::text AS amount FROM payments
        WHERE invoice_id=$1 AND type='fee' ORDER BY amount::numeric DESC`,
      [res.invoiceId]
    )
    expect(feePayments.rows.map((r) => Number(r.amount))).toEqual([100, 50])
  })

  it('security_deposit fee creates a separate type=deposit payment row', async () => {
    const stack = await buildLeaseStack({ rentAmount: 1000, startDate: '2026-01-01' })
    const client = await getClient()
    try {
      await seedLeaseFee(client, {
        leaseId: stack.leaseId, feeType: 'security_deposit',
        amount: 1500, dueTiming: 'move_in',
      })
    } finally {
      client.release()
    }
    const res = await generateMoveInInvoice({
      lease_id: stack.leaseId,
      unit_id: stack.unitId,
      tenant_id: stack.tenantId,
      landlord_id: stack.landlordId,
      rent_amount: 1000,
      start_date: '2026-01-01',
    })
    expect(res.depositInserted).toBe(true)
    expect(res.moveInFeesInserted).toBe(0)  // security_deposit excluded from fee count

    const inv = await db.query<{
      subtotal_rent: string; subtotal_deposits: string; total_amount: string
    }>(
      `SELECT subtotal_rent::text, subtotal_deposits::text, total_amount::text
         FROM invoices WHERE id=$1`,
      [res.invoiceId]
    )
    expect(inv.rows[0]).toMatchObject({
      subtotal_rent: '1000.00',
      subtotal_deposits: '1500.00',
      total_amount: '2500.00',
    })

    const depPay = await db.query<{ type: string; amount: string; entry_description: string }>(
      `SELECT type, amount::text AS amount, entry_description FROM payments
        WHERE invoice_id=$1 AND type='deposit'`,
      [res.invoiceId]
    )
    expect(depPay.rows[0]).toMatchObject({
      type: 'deposit', amount: '1500.00', entry_description: 'DEPOSIT',
    })
  })

  it('idempotent: re-firing on the same lease + start_date is a no-op', async () => {
    const stack = await buildLeaseStack({ rentAmount: 1000, startDate: '2026-01-01' })
    const inputs = {
      lease_id: stack.leaseId,
      unit_id: stack.unitId,
      tenant_id: stack.tenantId,
      landlord_id: stack.landlordId,
      rent_amount: 1000,
      start_date: '2026-01-01',
    }
    const r1 = await generateMoveInInvoice(inputs)
    expect(r1.invoiceCreated).toBe(true)
    const r2 = await generateMoveInInvoice(inputs)
    expect(r2.invoiceCreated).toBe(false)
    expect(r2.invoiceId).toBeNull()

    const count = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM invoices WHERE lease_id=$1`,
      [stack.leaseId]
    )
    expect(count.rows[0].n).toBe('1')
  })
})

// ── Monthly invoice generation ──────────────────────────────────────────────

describe('dueDatesInRange — pure math', () => {
  it('emits one date per month at rent_due_day, capped to month length', () => {
    const dts = dueDatesInRange(
      DateTime.fromISO('2026-01-15', { zone: 'UTC' }),
      DateTime.fromISO('2026-04-20', { zone: 'UTC' }),
      1,
    )
    // Jan 1 is before window; Feb 1, Mar 1, Apr 1 land inside
    expect(dts).toEqual(['2026-02-01', '2026-03-01', '2026-04-01'])
  })

  it('rent_due_day=31 caps to Feb 28 (non-leap)', () => {
    const dts = dueDatesInRange(
      DateTime.fromISO('2026-02-01', { zone: 'UTC' }),
      DateTime.fromISO('2026-03-31', { zone: 'UTC' }),
      31,
    )
    expect(dts).toEqual(['2026-02-28', '2026-03-31'])
  })
})

describe('generateInvoices (monthly cron)', () => {
  it('happy: generates one invoice per due_date within the catch-up window', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, rentDueDay: 1, startDate: '2026-04-01',
    })
    // Pretend "now" is May 5, 2026 — should backfill Apr 1 + May 1.
    // (moveInBundle is NOT called in the cron path; the cron filter
    //  excludes due_date === lease.start_date, so only May 1 lands.)
    const nowUtc = new Date('2026-05-05T12:00:00Z')
    const res = await generateInvoices(nowUtc)
    expect(res.invoicesInserted).toBe(1)
    expect(res.rentsInserted).toBe(1)

    const inv = await db.query<{ due_date: string; subtotal_rent: string }>(
      `SELECT due_date::text, subtotal_rent::text FROM invoices WHERE lease_id=$1
        ORDER BY due_date`,
      [stack.leaseId]
    )
    expect(inv.rows).toHaveLength(1)
    expect(inv.rows[0]).toMatchObject({ due_date: '2026-05-01', subtotal_rent: '1000.00' })
  })

  it('catch-up: missed cycles in the prior 30 days backfill', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, rentDueDay: 1, startDate: '2026-01-01',
    })
    // "Now" = Apr 15 — window is Mar 16 - Apr 15. Catches Apr 1.
    // (Mar 1 is outside the 30-day catch-up; Jan/Feb starts are skipped.)
    const nowUtc = new Date('2026-04-15T12:00:00Z')
    const res = await generateInvoices(nowUtc)
    expect(res.invoicesInserted).toBe(1)
    const inv = await db.query<{ due_date: string }>(
      `SELECT due_date::text FROM invoices WHERE lease_id=$1`,
      [stack.leaseId]
    )
    expect(inv.rows[0].due_date).toBe('2026-04-01')
  })

  it('idempotent: re-running the same window does not double-insert', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, rentDueDay: 1, startDate: '2026-04-01',
    })
    const nowUtc = new Date('2026-05-05T12:00:00Z')
    const r1 = await generateInvoices(nowUtc)
    expect(r1.invoicesInserted).toBe(1)
    const r2 = await generateInvoices(nowUtc)
    expect(r2.invoicesInserted).toBe(0)

    const count = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM invoices WHERE lease_id=$1`,
      [stack.leaseId]
    )
    expect(count.rows[0].n).toBe('1')
  })

  it('attaches monthly_ongoing fees as payment rows', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, rentDueDay: 1, startDate: '2026-04-01',
    })
    const client = await getClient()
    try {
      await seedLeaseFee(client, {
        leaseId: stack.leaseId, feeType: 'parking_rent',
        amount: 50, dueTiming: 'monthly_ongoing',
      })
    } finally {
      client.release()
    }
    const nowUtc = new Date('2026-05-05T12:00:00Z')
    const res = await generateInvoices(nowUtc)
    expect(res.feesInserted).toBe(1)

    const invs = await db.query<{ id: string; subtotal_fees: string; total_amount: string }>(
      `SELECT id, subtotal_fees::text, total_amount::text FROM invoices WHERE lease_id=$1`,
      [stack.leaseId]
    )
    expect(invs.rows[0]).toMatchObject({
      subtotal_fees: '50.00',
      total_amount: '1050.00',
    })

    const fee = await db.query<{ type: string; amount: string }>(
      `SELECT type, amount::text AS amount FROM payments
        WHERE invoice_id=$1 AND type='fee'`,
      [invs.rows[0].id]
    )
    expect(fee.rows[0]).toMatchObject({ type: 'fee', amount: '50.00' })
  })

  it('skips inactive leases', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, rentDueDay: 1,
      startDate: '2026-04-01', status: 'terminated',
    })
    const res = await generateInvoices(new Date('2026-05-05T12:00:00Z'))
    expect(res.invoicesInserted).toBe(0)
    const inv = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM invoices WHERE lease_id=$1`,
      [stack.leaseId]
    )
    expect(inv.rows[0].n).toBe('0')
  })

  it('respects lease.end_date — no invoices past it', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, rentDueDay: 1,
      startDate: '2026-01-01', endDate: '2026-03-15',
    })
    // Now = Apr 15. Catch-up window Mar 16–Apr 15. lease ends Mar 15.
    // windowEnd clamps to Mar 15; no due_date in [Mar 16, Mar 15] — empty range.
    const res = await generateInvoices(new Date('2026-04-15T12:00:00Z'))
    expect(res.invoicesInserted).toBe(0)
  })

  it('S178 utility branch: unbilled utility_bills attach as line items + flip to billed', async () => {
    // generateInvoices pulls any utility_bills with payment_id IS NULL and
    // billing_cycle_month ≤ the invoice's due-date cycle. Each one becomes
    // a payments.type='utility' child row linked to the invoice, and the
    // bill flips status='billed' + stamps payment_id. Same lease, no
    // separate flow.
    const stack = await buildLeaseStack({
      rentAmount: 1000, rentDueDay: 1, startDate: '2026-04-01',
    })
    const client = await getClient()
    let billId: string
    try {
      const meterId = await seedUtilityMeter(client, {
        propertyId: stack.propertyId,
      })
      billId = await seedUtilityBill(client, {
        meterId, unitId: stack.unitId, tenantId: stack.tenantId,
        leaseId: stack.leaseId, landlordId: stack.landlordId,
        chargeAmount: 75, billingCycleMonth: '2026-05-01',
        status: 'unbilled', paymentId: null,
      })
    } finally {
      client.release()
    }

    const res = await generateInvoices(new Date('2026-05-05T12:00:00Z'))
    expect(res.invoicesInserted).toBe(1)
    expect(res.utilitiesInserted).toBe(1)

    const inv = await db.query<{
      id: string
      subtotal_rent: string
      subtotal_utilities: string
      total_amount: string
    }>(
      `SELECT id, subtotal_rent::text, subtotal_utilities::text,
              total_amount::text FROM invoices WHERE lease_id=$1`,
      [stack.leaseId]
    )
    expect(inv.rows[0]).toMatchObject({
      subtotal_rent:      '1000.00',
      subtotal_utilities: '75.00',
      total_amount:       '1075.00',
    })

    const utilPay = await db.query<{ type: string; amount: string; entry_description: string }>(
      `SELECT type, amount::text AS amount, entry_description
         FROM payments WHERE invoice_id=$1 AND type='utility'`,
      [inv.rows[0].id]
    )
    expect(utilPay.rows[0]).toMatchObject({
      type: 'utility',
      amount: '75.00',
      entry_description: 'UTILITY',
    })

    // utility_bill flipped to billed + linked to its payment row.
    const billAfter = await db.query<{ status: string; payment_id: string | null }>(
      `SELECT status, payment_id FROM utility_bills WHERE id=$1`,
      [billId!]
    )
    expect(billAfter.rows[0].status).toBe('billed')
    expect(billAfter.rows[0].payment_id).not.toBeNull()

    // Re-running is a no-op for the utility line (payment_id IS NULL filter
    // excludes the now-attached bill; ON CONFLICT short-circuits the invoice).
    const r2 = await generateInvoices(new Date('2026-05-05T12:00:00Z'))
    expect(r2.invoicesInserted).toBe(0)
    expect(r2.utilitiesInserted).toBe(0)
  })

  it('S247 sublease branch: invoice routes to sublessee + uses sub_monthly_amount', async () => {
    // When a sublease covers the (lease, due_date) cycle, the invoice's
    // tenant_id swaps to the sublessee and subtotal_rent uses
    // sub_monthly_amount (not master lease rent). The master tenant is
    // out of the invoice picture; the sublessor's share accrues via
    // sublease allocation when the sublessee pays.
    const stack = await buildLeaseStack({
      rentAmount: 1000, rentDueDay: 1, startDate: '2026-04-01',
    })
    const client = await getClient()
    let sublesseeTenantId: string
    try {
      // Master tenant (stack.tenantId) becomes the sublessor; we need a
      // distinct sublessee tenant for the subleases.sublessee_tenant_id
      // CHECK (distinct_parties).
      sublesseeTenantId = await seedTenant(client)
      await client.query(
        `INSERT INTO subleases
           (master_lease_id, sublessor_tenant_id, sublessee_tenant_id,
            status, start_date, sub_monthly_amount, master_share_amount)
         VALUES ($1, $2, $3, 'active', '2026-04-15', 1200, 200)`,
        [stack.leaseId, stack.tenantId, sublesseeTenantId]
      )
    } finally {
      client.release()
    }

    const res = await generateInvoices(new Date('2026-05-05T12:00:00Z'))
    expect(res.invoicesInserted).toBe(1)

    const inv = await db.query<{
      tenant_id: string
      subtotal_rent: string
      total_amount: string
    }>(
      `SELECT tenant_id, subtotal_rent::text, total_amount::text
         FROM invoices WHERE lease_id=$1`,
      [stack.leaseId]
    )
    expect(inv.rows[0].tenant_id).toBe(sublesseeTenantId!)
    expect(inv.rows[0].subtotal_rent).toBe('1200.00')
    expect(inv.rows[0].total_amount).toBe('1200.00')

    // Rent payment child row also routes to the sublessee.
    const rentPay = await db.query<{ tenant_id: string; amount: string }>(
      `SELECT tenant_id, amount::text AS amount FROM payments
        WHERE lease_id=$1 AND type='rent'`,
      [stack.leaseId]
    )
    expect(rentPay.rows[0].tenant_id).toBe(sublesseeTenantId!)
    expect(rentPay.rows[0].amount).toBe('1200.00')
  })
})

// ── Late fees ───────────────────────────────────────────────────────────────

/**
 * Seed an invoice + rent payment for late-fee testing. due_date in the
 * past so the engine's `NOW() AT TIME ZONE p.timezone > due_date + grace`
 * condition fires immediately. Invoice status='pending'.
 */
async function seedPastDueInvoice(args: {
  stack: LeaseStack
  daysPastDue: number  // days before "today"
  rentAmount?: number
}): Promise<{ invoiceId: string }> {
  const dueDate = DateTime.utc().minus({ days: args.daysPastDue }).toISODate()!
  const client = await getClient()
  try {
    const inv = await client.query<{ id: string }>(
      `INSERT INTO invoices
         (landlord_id, tenant_id, lease_id, unit_id, invoice_number,
          due_date, subtotal_rent, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'pending')
       RETURNING id`,
      [
        args.stack.landlordId, args.stack.tenantId, args.stack.leaseId,
        args.stack.unitId,
        `TEST-${Math.random().toString(36).slice(2, 8)}`,
        dueDate, (args.rentAmount ?? 1000).toFixed(2),
      ]
    )
    const invoiceId = inv.rows[0].id
    await client.query(
      `INSERT INTO payments
         (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
          type, amount, status, due_date, entry_description)
       VALUES ($1, $2, $3, $4, $5, 'rent', $6, 'pending', $7, 'RENT')`,
      [invoiceId, args.stack.unitId, args.stack.leaseId,
       args.stack.tenantId, args.stack.landlordId,
       (args.rentAmount ?? 1000).toFixed(2), dueDate],
    )
    return { invoiceId }
  } finally {
    client.release()
  }
}

describe('generateLateFeesForTimezone', () => {
  it('writes initial late_fee row when grace + 1 day past due_date', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, lateFeeGraceDays: 5,
      lateFeeInitialAmount: 50, lateFeeInitialType: 'flat',
    })
    await seedPastDueInvoice({ stack, daysPastDue: 10 })  // > 5 day grace
    const res = await generateLateFeesForTimezone('America/Phoenix')
    expect(res.invoicesScanned).toBe(1)
    expect(res.rowsWritten).toBe(1)
    expect(res.errors).toHaveLength(0)

    const lf = await db.query<{ type: string; amount: string; status: string }>(
      `SELECT type, amount::text AS amount, status FROM payments
        WHERE lease_id=$1 AND type='late_fee'`,
      [stack.leaseId]
    )
    expect(lf.rows).toHaveLength(1)
    expect(lf.rows[0]).toMatchObject({
      type: 'late_fee', amount: '50.00', status: 'pending',
    })
  })

  it('cap edge: writes partial row equal to remaining cap, then stops', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, lateFeeGraceDays: 5,
      lateFeeInitialAmount: 75, lateFeeInitialType: 'flat',
      lateFeeCapAmount: 50, lateFeeCapType: 'flat',
    })
    await seedPastDueInvoice({ stack, daysPastDue: 10 })
    const res = await generateLateFeesForTimezone('America/Phoenix')
    expect(res.rowsWritten).toBe(1)
    expect(res.capsHit).toBe(1)
    // 75 raw initial → clamps to 50 (the cap). Total stays at 50.
    const lf = await db.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM payments
        WHERE lease_id=$1 AND type='late_fee'`,
      [stack.leaseId]
    )
    expect(lf.rows[0].amount).toBe('50.00')
  })

  it('idempotent: re-running on the same invoice does not double-fire', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, lateFeeGraceDays: 5,
      lateFeeInitialAmount: 50, lateFeeInitialType: 'flat',
    })
    await seedPastDueInvoice({ stack, daysPastDue: 10 })
    const r1 = await generateLateFeesForTimezone('America/Phoenix')
    expect(r1.rowsWritten).toBe(1)
    const r2 = await generateLateFeesForTimezone('America/Phoenix')
    expect(r2.rowsWritten).toBe(0)
    const count = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments
        WHERE lease_id=$1 AND type='late_fee'`,
      [stack.leaseId]
    )
    expect(count.rows[0].n).toBe('1')
  })

  it('skips invoices within grace window', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, lateFeeGraceDays: 5,
      lateFeeInitialAmount: 50, lateFeeInitialType: 'flat',
    })
    await seedPastDueInvoice({ stack, daysPastDue: 3 })  // inside grace
    const res = await generateLateFeesForTimezone('America/Phoenix')
    expect(res.invoicesScanned).toBe(0)
    expect(res.rowsWritten).toBe(0)
  })

  it('skips leases with late_fee_enabled=false', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, lateFeeGraceDays: 5,
      lateFeeInitialAmount: 50, lateFeeInitialType: 'flat',
      lateFeeEnabled: false,
    })
    await seedPastDueInvoice({ stack, daysPastDue: 10 })
    const res = await generateLateFeesForTimezone('America/Phoenix')
    expect(res.invoicesScanned).toBe(0)
  })

  it('percent_of_rent: late_fee amount = rent × percent', async () => {
    const stack = await buildLeaseStack({
      rentAmount: 1000, lateFeeGraceDays: 5,
      lateFeeInitialAmount: 5, lateFeeInitialType: 'percent_of_rent',
    })
    await seedPastDueInvoice({ stack, daysPastDue: 10, rentAmount: 1000 })
    const res = await generateLateFeesForTimezone('America/Phoenix')
    expect(res.rowsWritten).toBe(1)
    const lf = await db.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM payments
        WHERE lease_id=$1 AND type='late_fee'`,
      [stack.leaseId]
    )
    // 1000 × 5% = 50
    expect(lf.rows[0].amount).toBe('50.00')
  })
})
