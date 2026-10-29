/**
 * 10/19 (Nic) — UNPAID SPACE RENT FOLLOWS THE SPACE ON A TENANT-OWNED HOME.
 *
 * Built from the live situation at Oak Park, with the figures it actually has:
 * MH 09, a tenant-owned mobile home. Rashawn Bump left, the trailer was sold
 * privately, and the new owner moves in on top of $880.00 of unpaid space rent,
 * $1,051.00 of utilities and $95.00 of late fees that were still climbing $5 a
 * day.
 *
 *   "The rent is owed by the trailer because it was the same trailer there. It
 *    doesn't matter how many people cycle in and out."
 *   "in terms of being real and equitable, it should be the space rent is the
 *    only thing tied to the trailer, right?"
 *   "Jacob, it was not possible for him to be late. So I would say on a carry
 *    forward balance like that, just in the nature of being reasonable, we drop
 *    the late fees." … "close out late fees entirely."
 *   "Yes, Rashan is still responsible for the money until it is paid. Even
 *    though it's acting as the lien, you got the right method there."
 *   "it's going to just record under his name only when the payment happens.
 *    So, and we're not recording a payment like that until it's fully settled."
 *   "Don't count it on his, you know, payment health history, his late fees."
 *
 * Nothing here names Rashawn or Jacob to the code; they are the shapes the
 * fixtures are built in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  previewSpaceRentCarryforward, closeOutWithCarryforward, carryforwardForLease,
  carryforwardForUnit, carryforwardsOwedBy, setArrangement, runCarryforwardArrangements,
  takeOffCarryforward,
} from './spaceRentCarryforward'
import { generateLateFeesForTimezone } from '../jobs/lateFees'
import { householdQuote, type HouseholdQuote, type QuoteRow } from './creditUse'
import { settleManualRentPayment } from './manualPaymentSettle'
import { incomeTotals, incomeEvents } from './incomeBasis'
import { healthByLease } from './householdMonths'
import { lockHousehold } from './moneyPredicates'
import { voidUnowedCharges } from './chargeVoids'
import { handlePaymentReversal } from './paymentReversal'
import { processBalanceCreditDetectors } from '../jobs/balanceCreditDetectors'
import { drain, activeLines, triples } from '../test/ledgerTenantFixtures'
import { registerTenantLedgerProjectors } from './ledgerProjectors/tenantMoney'
import { registeredLedgerSourceTypes, unregisterLedgerProjector } from './ledgerEngine'

const TZ = 'America/Phoenix'
beforeEach(async () => { await cleanupAllSchema() })
// The books tests below drain the ledger outbox; the projectors have to be
// registered for the drain to post anything, and nothing of this file's may be
// left registered for the next file.
afterEach(() => { for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t) })

interface Park {
  userId: string; landlordId: string; propertyId: string; unitId: string
  departingTenantId: string; departingLeaseId: string
  rentInvoiceSep: string; rentInvoiceOct: string
}

/** A day ago on the park's calendar. */
async function parkDay(daysAgo: number): Promise<string> {
  return (await db.query<{ d: string }>(
    `SELECT ((NOW() AT TIME ZONE $1)::date - $2::int)::text AS d`, [TZ, daysAgo])).rows[0].d
}

/**
 * MH 09 as it stands. `dwellingOwnership` is the one thing that decides whether
 * anything carries: 'tenant' is the live value on that space (and on 125 others
 * across the account), 'landlord' is a park-owned rental.
 *
 * Two bills, each with that month's rent and that month's utilities, plus daily
 * $5 late fees on the newer one — the live shape.
 */
async function oakParkMh09(opts: {
  dwellingOwnership?: 'tenant' | 'landlord'
  rent?: number
  /** Utilities on the older bill (the $997 August water read, billed late, plus trash). */
  olderUtilities?: number[]
  newerUtilities?: number[]
  /** How many daily $5 fees have already been charged. */
  lateFeeDays?: number
  withResident?: boolean
} = {}): Promise<Park> {
  const rent = opts.rent ?? 440
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    // late_fee_enabled is the property's live master switch and stays; the
    // FIGURES on properties (grace days, the $15 flat nobody set) are dropped
    // by 20261020130000, which sorts BEFORE this feature's migration and so is
    // applied first by `npm run migrate`. Writing one here made all ten of
    // these tests pass only against a schema that stops existing the moment Nic
    // migrates. The late-fee terms that matter are on the LEASE below, which is
    // where the engine reads them from anyway (jobs/lateFees).
    await c.query(
      `UPDATE properties SET timezone = $2, name = 'Oak Park', late_fee_enabled = TRUE WHERE id = $1`,
      [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: rent, unitType: 'mobile_home' })
    await c.query(
      `UPDATE units SET unit_number = 'MH 09', dwelling_ownership = $2 WHERE id = $1`,
      [unitId, opts.dwellingOwnership ?? 'tenant'])

    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: rent, startDate: await parkDay(48) })
    // No end date, like the live row: he is gone and nobody closed it.
    await c.query(
      `UPDATE leases SET end_date = NULL, late_fee_enabled = TRUE, late_fee_grace_days = 0,
              late_fee_initial_type = 'flat', late_fee_initial_amount = 5,
              late_fee_accrual_type = 'flat', late_fee_accrual_amount = 5,
              late_fee_accrual_period = 'daily'
        WHERE id = $1`, [leaseId])
    if (opts.withResident !== false) await seedLeaseTenant(c, { leaseId, tenantId })

    const bill = async (dueDaysAgo: number, utilities: number[]) => {
      const due = await parkDay(dueDaysAgo)
      const total = rent + utilities.reduce((s, u) => s + u, 0)
      const invoiceId = (await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                               subtotal_rent, subtotal_utilities, total_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,'pending') RETURNING id`,
        [landlordId, tenantId, leaseId, unitId, `INV-${Math.random().toString(36).slice(2, 10)}`,
         due, rent, utilities.reduce((s, u) => s + u, 0), total])).rows[0].id
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                               entry_description, due_date, invoice_id)
         VALUES ($1,$2,$3,$4,'rent',$5,'pending','RENT',$6::date,$7)`,
        [landlordId, unitId, leaseId, tenantId, rent, due, invoiceId])
      for (const u of utilities) {
        await c.query(
          `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                                 entry_description, due_date, invoice_id)
           VALUES ($1,$2,$3,$4,'utility',$5,'pending','UTILITY',$6::date,$7)`,
          [landlordId, unitId, leaseId, tenantId, u, due, invoiceId])
      }
      return { invoiceId, due }
    }
    const sep = await bill(48, opts.olderUtilities ?? [997, 25])
    const oct = await bill(18, opts.newerUtilities ?? [25, 4])

    for (let i = 0; i < (opts.lateFeeDays ?? 19); i++) {
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                               entry_description, due_date, invoice_id)
         VALUES ($1,$2,$3,$4,'late_fee',5,'pending','LATEFEE',$5::date,$6)`,
        [landlordId, unitId, leaseId, tenantId, await parkDay(18 - i), oct.invoiceId])
    }
    await c.query('COMMIT')
    return {
      userId, landlordId, propertyId, unitId,
      departingTenantId: tenantId, departingLeaseId: leaseId,
      rentInvoiceSep: sep.invoiceId, rentInvoiceOct: oct.invoiceId,
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** Run a close-out the way the route does: one transaction. */
async function closeOut(p: Park) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await closeOutWithCarryforward(c, { leaseId: p.departingLeaseId, byUserId: p.userId })
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** The next resident: a new lease drafted on the same space, then a resident on it. */
async function nextResident(p: Park): Promise<{ leaseId: string; tenantId: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, {
      unitId: p.unitId, landlordId: p.landlordId, rentAmount: 440, startDate: await parkDay(0),
    })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query('COMMIT')
    return { leaseId, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const openRows = async (leaseOrTenant: { leaseId?: string; tenantId?: string }) =>
  (await db.query<{ id: string; type: string; amount: number; status: string; invoice_id: string | null }>(
    `SELECT id, type, amount::float AS amount, status, invoice_id FROM payments
      WHERE ($1::uuid IS NULL OR lease_id = $1) AND ($2::uuid IS NULL OR tenant_id = $2)
        AND status IN ('pending', 'failed')
      ORDER BY type, due_date`,
    [leaseOrTenant.leaseId ?? null, leaseOrTenant.tenantId ?? null])).rows

const total = (rows: { amount: number }[]) => Math.round(rows.reduce((t, r) => t + r.amount, 0) * 100) / 100

/** Every row of a household quote, whichever lease (or none) it sits on. */
const quoteRows = (q: HouseholdQuote): QuoteRow[] => [...q.leases.flatMap(l => l.rows), ...q.noLeaseRows]

/** What one household's quote says it owes, in dollars, by row. */
async function quoteOf(tenantId: string, landlordId: string) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    await lockHousehold(c, tenantId, landlordId)
    const q = await householdQuote(c, { tenantId, landlordId })
    await c.query('ROLLBACK')
    return q
  } finally { c.release() }
}

// ── 1. Only the space rent moves ─────────────────────────────────────────────

describe('closing a departing resident out on a tenant-owned space', () => {
  it('moves ONLY the space rent, waives the late fees, and leaves the utilities on the old tenant', async () => {
    const p = await oakParkMh09()

    // The preview is the screen the landlord decides from: the live figures.
    const pv = await previewSpaceRentCarryforward(p.departingLeaseId)
    expect(pv.eligible).toBe(true)
    expect(pv.dwellingOwnership).toBe('tenant')
    expect(pv.carriesTotal).toBe(880)       // 2 × $440, Sept 1 and Oct 1
    expect(pv.staysTotal).toBe(1051)        // $997 water + $25 + $25 + $4
    expect(pv.waivesTotal).toBe(95)         // 19 daily $5 fees
    expect(pv.carries.every(l => l.label === 'Space rent')).toBe(true)
    expect(pv.spaceName).toBe('MH 09')
    // Nothing about the home is needed: MH 09 has no mobile_homes row at all.
    expect(pv.recordedHomeOwnerName).toBeNull()

    const r = await closeOut(p)
    expect(r.carriedAmount).toBe(880)
    expect(r.lateFeesWaived).toBe(95)
    expect(r.stayedWithDepartingTenant).toBe(1051)

    // The claim sits on the SPACE.
    const cf = (await carryforwardForUnit(p.unitId))!
    expect(cf.amount).toBe(880)
    expect(cf.lateFeesWaived).toBe(95)
    expect(cf.status).toBe('open')
    expect(cf.stillOwed).toBe(880)

    // What the departing resident is left holding: the utilities, and the one
    // carried balance he still owes. No rent rows, no late fees.
    const his = await openRows({ tenantId: p.departingTenantId })
    expect(his.filter(x => x.type === 'rent')).toHaveLength(0)
    expect(his.filter(x => x.type === 'late_fee')).toHaveLength(0)
    expect(total(his.filter(x => x.type === 'utility'))).toBe(1051)
    const carried = his.filter(x => x.type === 'carried_balance')
    expect(carried).toHaveLength(1)
    expect(carried[0].amount).toBe(880)
    // No invoice — that is what puts it out of the late-fee engine's reach.
    expect(carried[0].invoice_id).toBeNull()

    // The rent charges are voided, with the reason on them, not deleted.
    const voided = (await db.query<{ n: number; reason: string }>(
      `SELECT COUNT(*)::int AS n, MIN(void_reason) AS reason FROM payments
        WHERE lease_id = $1 AND type = 'rent' AND status = 'voided'`, [p.departingLeaseId])).rows[0]
    expect(voided.n).toBe(2)
    expect(voided.reason).toMatch(/Carried to the space/)

    // And the journal kept what each one said before.
    const journal = (await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_row_changes
        WHERE table_name = 'payments' AND old_row->>'type' = 'rent'
          AND old_row->>'lease_id' = $1 AND old_row->>'status' = 'pending'`, [p.departingLeaseId])).rows[0]
    expect(journal.n).toBeGreaterThanOrEqual(2)

    // His lease is closed. It was active with no end date, still counting the
    // space as occupied.
    const lease = (await db.query<{ status: string; end_date: string | null }>(
      `SELECT status, end_date::text AS end_date FROM leases WHERE id = $1`, [p.departingLeaseId])).rows[0]
    expect(lease.status).toBe('terminated')
    expect(lease.end_date).toBe(await parkDay(0))
  })

  it('refuses a second close-out on the same space rather than double-entering the debt', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    await expect(closeOut(p)).rejects.toThrow(/already carries/i)
  })

  it('ends the lease the way every other ending does: he is off it, the space is free, and the credit ledger hears it', async () => {
    const p = await oakParkMh09()
    await closeOut(p)

    // Not a status alone. terminated_at is what the credit ledger's
    // tenancy-ended detector keys on, lease_tenants is what every "is this
    // person a resident" join reads, and units.status is the space.
    const lease = (await db.query<{ status: string; ended: boolean; reason: string | null }>(
      `SELECT status, terminated_at IS NOT NULL AS ended, termination_reason AS reason
         FROM leases WHERE id = $1`, [p.departingLeaseId])).rows[0]
    expect(lease).toMatchObject({ status: 'terminated', ended: true })
    expect(lease.reason).toMatch(/carried to the space/i)

    const onIt = (await db.query<{ status: string; reason: string | null }>(
      `SELECT status, removed_reason AS reason FROM lease_tenants WHERE lease_id = $1`, [p.departingLeaseId])).rows
    expect(onIt).toEqual([{ status: 'removed', reason: 'lease_ended' }])

    expect((await db.query<{ status: string }>(
      `SELECT status FROM units WHERE id = $1`, [p.unitId])).rows[0].status).toBe('vacant')

    // He walks away owing $1,051 of utilities, and that is exactly the event
    // the credit ledger exists to record. Before the cascade was written this
    // was the one termination in GAM that emitted nothing.
    const r = await processBalanceCreditDetectors()
    expect(r.errors).toBe(0)
    const event = (await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM credit_events e JOIN credit_subjects s ON s.id = e.subject_id
        WHERE s.subject_type = 'tenant' AND s.subject_ref_id = $1
          AND e.event_type = 'tenancy_ended_with_balance'
          AND e.event_data->>'lease_id' = $2`, [p.departingTenantId, p.departingLeaseId])).rows[0]
    expect(event.n).toBe(1)
  })

  it('does not vacate a space somebody else is already on', async () => {
    const p = await oakParkMh09()
    await nextResident(p)                    // already drafted on the same space
    await closeOut(p)
    expect((await db.query<{ status: string }>(
      `SELECT status FROM units WHERE id = $1`, [p.unitId])).rows[0].status).not.toBe('vacant')
  })
})

// ── 4b. AN RV SPOT CARRIES NOTHING FORWARD ──────────────────────────────────
//
// 10/19 (Nic): "I also want that only be applicable to mobile home spots as the
// space rent accrues tied to the trailer. So that should never happen to an RV
// because somebody leaves with their RV and somebody else comes in with their
// own RV."
//
// This is the case the first build got wrong and that the review missed, because
// no test covered it: the gate asked only whether the home was tenant-owned, and
// an RV spot IS tenant-owned — the guest owns the RV. 94 live RV spots (73 at
// Mountain View alone) would have carried a departing guest's unpaid rent onto
// the next guest, who arrived towing their own rig. The claim only makes sense
// while the same home stays on the same spot.

describe('an RV spot', () => {
  it('carries nothing forward even though the guest owns the RV', async () => {
    const p = await oakParkMh09({})
    // Same space, same tenant-owned home, only the unit type differs.
    await db.query(`UPDATE units SET unit_type = 'rv_spot', unit_number = 'RV 10' WHERE id = $1`, [p.unitId])

    const pv = await previewSpaceRentCarryforward(p.departingLeaseId)
    expect(pv.eligible).toBe(false)
    expect(pv.reason).toMatch(/only a mobile home space/i)
    await expect(closeOut(p)).rejects.toThrow(/only a mobile home space/i)

    // The departing guest keeps every cent of it — nothing moved to the space.
    const his = await openRows({ tenantId: p.departingTenantId })
    expect(his.filter(r => r.type === 'rent').reduce((a, r) => a + Number(r.amount), 0)).toBeCloseTo(880, 2)
    expect(his.some(r => r.type === 'carried_balance')).toBe(false)
  })

  it('refuses a tenant-owned space of every other type too', async () => {
    for (const t of ['apartment', 'single_family', 'campsite', 'storage'] as const) {
      const p = await oakParkMh09({})
      await db.query(`UPDATE units SET unit_type = $2 WHERE id = $1`, [p.unitId, t])
      const pv = await previewSpaceRentCarryforward(p.departingLeaseId)
      expect(pv.eligible, t).toBe(false)
      expect(pv.reason, t).toMatch(/only a mobile home space/i)
    }
  })
})

// ── 5. A landlord-owned space carries nothing forward ────────────────────────

describe('a park-owned rental', () => {
  it('carries nothing forward — there is no next owner to inherit it', async () => {
    const p = await oakParkMh09({ dwellingOwnership: 'landlord' })
    const pv = await previewSpaceRentCarryforward(p.departingLeaseId)
    expect(pv.eligible).toBe(false)
    expect(pv.reason).toMatch(/park owns the home/i)
    await expect(closeOut(p)).rejects.toThrow(/park owns the home/i)

    // Untouched: the rent is still the departing resident's own debt.
    const his = await openRows({ tenantId: p.departingTenantId })
    expect(total(his.filter(x => x.type === 'rent'))).toBe(880)
    expect(await carryforwardForUnit(p.unitId)).toBeNull()
  })

  /**
   * The likeliest ending of this exact situation: the park takes the abandoned
   * home for the back rent, so the space stops being tenant-owned, and then
   * rents it out as a park-owned rental to somebody with no connection to any
   * of it. The gate has to hold on the way OUT as well as on the way in.
   */
  it('a brand-new renter of a home the park has taken over inherits nothing', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    // The park takes the home for the back rent.
    await db.query(`UPDATE units SET dwelling_ownership = 'landlord' WHERE id = $1`, [p.unitId])

    const renter = await nextResident(p)
    expect(await carryforwardForLease(renter.leaseId)).toBeNull()
    expect((await quoteOf(renter.tenantId, p.landlordId)).totals.carried).toBe(0)
    expect(await openRows({ leaseId: renter.leaseId })).toEqual([])

    // The claim did not move and did not disappear: it is still open, still
    // nobody's but the man who left it, and still on his own lease.
    const cf = (await carryforwardForUnit(p.unitId))!
    expect(cf.status).toBe('open')
    expect(cf.assumedLeaseId).toBeNull()
    expect(cf.assumedByName).toBeNull()
    const charge = (await db.query<{ lease_id: string; tenant_id: string }>(
      `SELECT lease_id, tenant_id FROM payments
        WHERE space_carryforward_id IS NOT NULL AND type = 'carried_balance' AND status = 'pending'`)).rows
    expect(charge).toHaveLength(1)
    expect(charge[0].lease_id).toBe(p.departingLeaseId)
    expect(charge[0].tenant_id).toBe(p.departingTenantId)
    expect((await carryforwardsOwedBy(p.departingTenantId))[0].stillOwed).toBe(880)

    // Not a permanent block either: sell the home to somebody and the space is
    // tenant-owned again, so the next buyer's lease does take it on.
    await db.query(`UPDATE units SET dwelling_ownership = 'tenant' WHERE id = $1`, [p.unitId])
    const buyer = await nextResident(p)
    expect((await carryforwardForLease(buyer.leaseId))!.assumedLeaseId).toBe(buyer.leaseId)
  })

  it('a lease at another landlord on the same space takes nothing on', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    // A property that changes hands is transferred, never deleted; the debt is
    // owed to the landlord who was owed it, not to whoever owns the park next.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { landlordId: otherLandlord } = await seedLandlord(c)
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, {
        unitId: p.unitId, landlordId: otherLandlord, rentAmount: 440, startDate: await parkDay(0),
      })
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query('COMMIT')
      expect(await carryforwardForLease(leaseId)).toBeNull()
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    expect((await carryforwardForUnit(p.unitId))!.assumedLeaseId).toBeNull()
  })
})

// ── 2. What the new resident sees ────────────────────────────────────────────

describe('the resident who takes the space on', () => {
  it('sees it as its own line, outside their rent, outside their payment health, and it never goes late', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    const next = await nextResident(p)

    // It followed the space onto the lease that was drafted, and who OWES it
    // never changed.
    const charge = (await db.query<{
      id: string; type: string; amount: number; lease_id: string; tenant_id: string
      invoice_id: string | null; entry_description: string; notes: string
    }>(
      `SELECT id, type, amount::float AS amount, lease_id, tenant_id, invoice_id, entry_description, notes
         FROM payments WHERE space_carryforward_id IS NOT NULL AND type = 'carried_balance'`)).rows
    expect(charge).toHaveLength(1)
    expect(charge[0].lease_id).toBe(next.leaseId)                   // the space's lease carries it
    // The desk asks the resident who took the space on — "He is going to be
    // responsible for paying the bill that Rashawn left behind."
    expect(charge[0].tenant_id).toBe(next.tenantId)
    expect(charge[0].type).toBe('carried_balance')                  // never folded into rent
    expect(charge[0].invoice_id).toBeNull()
    expect(charge[0].notes).toMatch(/previous owner of the home/i)

    const cf = (await carryforwardForLease(next.leaseId))!
    expect(cf.role).toBe('assumed')
    expect(cf.assumedLeaseId).toBe(next.leaseId)
    expect(cf.assumedByName).not.toBeNull()
    // Whose debt it is never moves.
    expect(cf.owedByTenantId).toBe(p.departingTenantId)
    expect((await carryforwardsOwedBy(p.departingTenantId))[0].stillOwed).toBe(880)
    expect(cf.chargeLabel).toMatch(/previous owner of the home/i)

    // It is on HIS bill, as its own optional line — never part of what the
    // lease requires, so it can never crowd his rent out or start a clock.
    const q = await quoteOf(next.tenantId, p.landlordId)
    const row = quoteRows(q).find(r => r.type === 'carried_balance')!
    expect(row).toBeTruthy()
    expect(row.carried).toBe(true)
    expect(row.required).toBe(false)
    expect(q.totals.required).toBe(0)
    expect(q.totals.carried).toBe(880)

    // However long it sits, the late-fee engine never reaches it: it is on no
    // invoice. Two nights of the engine, and a month of them.
    await generateLateFeesForTimezone(TZ)
    await db.query(`UPDATE payments SET due_date = due_date - 60 WHERE id = $1`, [charge[0].id])
    await generateLateFeesForTimezone(TZ)
    const feesOnIt = (await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE type = 'late_fee' AND lease_id = $1`, [next.leaseId])).rows[0]
    expect(feesOnIt.n).toBe(0)

    // And nothing re-billed his bill with it: he has no bill at all yet.
    const onNewLease = await openRows({ leaseId: next.leaseId })
    expect(onNewLease.map(r => r.type)).toEqual(['carried_balance'])

    // His payment health does not see it. Nic: "Don't count it on his, you
    // know, payment health history, his late fees ... that's carried forward as
    // Rashawn's."
    const health = await healthByLease({ landlordIds: [p.landlordId], leaseIds: [next.leaseId] })
    const h = health.get(next.leaseId)
    expect(h?.percent ?? null).toBeNull()   // nothing of his has been judged
    expect(h?.outstanding ?? 0).toBe(0)
    expect(h?.counted ?? 0).toBe(0)
  })
})

// ── 3 + 4. One settlement ────────────────────────────────────────────────────

/** Hand money over at the desk against the household's balance. */
async function pay(opts: { tenantId: string; landlordId: string; amount: number }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    await lockHousehold(c, opts.tenantId, opts.landlordId)
    const row = (await c.query<any>(
      `SELECT p.id, p.landlord_id, p.tenant_id, p.unit_id, p.lease_id, p.due_date::text AS due_date
         FROM payments p
        WHERE p.space_carryforward_id IS NOT NULL AND p.type = 'carried_balance'
          AND p.status = 'pending'
        ORDER BY p.due_date, p.created_at LIMIT 1 FOR UPDATE`)).rows[0]
    const r = await settleManualRentPayment(c, {
      payment: row, method: 'cash', settledAt: null, settleHousehold: true,
      amountTendered: opts.amount, takenBy: null, sendReceipt: false,
      // S637: cash over the bill is never guessed at. "Keep it — no change on
      // hand" is what sends it to the old balance first, which is where every
      // dollar of this is meant to go.
      surplusHandling: 'credit',
    })
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** The carried-balance charge rows of the one claim, newest status first. */
const carriedRows = async () =>
  (await db.query<{ id: string; amount: number; status: string; is_remainder: boolean }>(
    `SELECT id, amount::float AS amount, status, is_remainder FROM payments
      WHERE space_carryforward_id IS NOT NULL AND type = 'carried_balance'
      ORDER BY created_at, id`)).rows

describe('one settlement, and it can only be collected once', () => {
  it('a part payment does NOT mark the old tenant settled; the final one does, and his record carries it unpaid until that day', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    const next = await nextResident(p)

    // $100 against an $880 balance — Nic's own example of why a part payment
    // must not close it out.
    await pay({ tenantId: next.tenantId, landlordId: p.landlordId, amount: 100 })

    let cf = (await carryforwardForUnit(p.unitId))!
    expect(cf.status).toBe('open')          // NOT settled
    expect(cf.settledAmount).toBe(100)
    expect(cf.stillOwed).toBe(780)
    expect(cf.settledOn).toBeNull()

    // The old tenant's record still carries it, unpaid, dated from the oldest
    // rent he left behind — the "almost 2 years late" figure.
    let his = (await carryforwardsOwedBy(p.departingTenantId))[0]
    expect(his.status).toBe('open')
    expect(his.stillOwed).toBe(780)
    expect(his.settledOn).toBeNull()
    expect(his.oldestDueDate).toBe(await parkDay(48))
    expect(his.daysOutstanding).toBe(48)

    // Three more part payments, then the last dollar.
    await pay({ tenantId: next.tenantId, landlordId: p.landlordId, amount: 200 })
    cf = (await carryforwardForUnit(p.unitId))!
    expect(cf.status).toBe('open')
    expect(cf.stillOwed).toBe(580)

    await pay({ tenantId: next.tenantId, landlordId: p.landlordId, amount: 580 })
    cf = (await carryforwardForUnit(p.unitId))!
    expect(cf.status).toBe('settled')
    expect(cf.settledAmount).toBe(880)
    expect(cf.stillOwed).toBe(0)
    expect(cf.settledOn).toBe(await parkDay(0))

    // His record says so, on the day it happened and not before: the debt he
    // left in September, cleared today, carried unpaid for every day between.
    his = (await carryforwardsOwedBy(p.departingTenantId))[0]
    expect(his.status).toBe('settled')
    expect(his.settledOn).toBe(await parkDay(0))
    expect(his.stillOwed).toBe(0)
    expect(his.daysOutstanding).toBe(48)

    // And the new resident's payment health never saw any of it.
    const health = await healthByLease({ landlordIds: [p.landlordId], leaseIds: [next.leaseId] })
    expect(health.get(next.leaseId)?.counted ?? 0).toBe(0)
    expect(health.get(next.leaseId)?.percent ?? null).toBeNull()
  })

  it('the new resident paying it clears it off the old tenant too', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    const next = await nextResident(p)

    // Only ONE row holds the money, and it is the one on his bill.
    const all = (await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE space_carryforward_id IS NOT NULL AND type = 'carried_balance'
          AND status NOT IN ('voided')`)).rows[0]
    expect(all.n).toBe(1)
    expect((await quoteOf(next.tenantId, p.landlordId)).totals.carried).toBe(880)

    await pay({ tenantId: next.tenantId, landlordId: p.landlordId, amount: 880 })

    // Gone from his bill, AND cleared on the old tenant's record the same
    // moment: one settlement, two views of it.
    const after = await quoteOf(next.tenantId, p.landlordId)
    expect(after.totals.carried).toBe(0)
    expect(quoteRows(after).filter(r => r.type === 'carried_balance' && r.payable)).toHaveLength(0)
    const his = (await carryforwardsOwedBy(p.departingTenantId))[0]
    expect(his.status).toBe('settled')
    expect(his.settledAmount).toBe(880)

    // Exactly $880 was collected against the claim — never $1,760.
    const collected = (await db.query<{ t: number }>(
      `SELECT COALESCE(SUM(amount), 0)::float AS t FROM payments
        WHERE space_carryforward_id IS NOT NULL AND type = 'carried_balance'
          AND status IN ('settled', 'paid_via_deposit')`)).rows[0]
    expect(collected.t).toBe(880)

    // Nothing of it is left payable anywhere on the platform.
    const payableLeft = (await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE space_carryforward_id IS NOT NULL AND type = 'carried_balance'
          AND status IN ('pending', 'failed')`)).rows[0]
    expect(payableLeft.n).toBe(0)

    // And the database itself refuses a second charge for the same claim, so
    // there is no path — a retried click, a second screen — that re-bills it.
    const cf = (await carryforwardForUnit(p.unitId))!
    await expect(db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                             entry_description, due_date, space_carryforward_id)
       VALUES ($1,$2,$3,$4,'carried_balance',880,'pending','BALANCE',CURRENT_DATE,$5)`,
      [p.landlordId, p.unitId, next.leaseId, next.tenantId, cf.id],
    )).rejects.toThrow()
  })

  it('the departing resident paying it clears it off the space too — and the old balance is taken last', async () => {
    const p = await oakParkMh09()
    await closeOut(p)

    // Before anyone takes the space it is his to pay, and the desk takes his
    // own bill first: $1,051 of utilities, THEN the $880 old balance.
    const q = await quoteOf(p.departingTenantId, p.landlordId)
    expect(q.totals.required).toBe(1051)
    expect(q.totals.carried).toBe(880)

    await pay({ tenantId: p.departingTenantId, landlordId: p.landlordId, amount: 1931 })

    const his = (await carryforwardsOwedBy(p.departingTenantId))[0]
    expect(his.status).toBe('settled')
    expect(his.settledAmount).toBe(880)
    expect((await quoteOf(p.departingTenantId, p.landlordId)).totals.carried).toBe(0)

    // The space is clean for whoever comes next: a lease drafted now takes
    // nothing on.
    const next = await nextResident(p)
    expect(await carryforwardForLease(next.leaseId)).toBeNull()
    expect((await quoteOf(next.tenantId, p.landlordId)).totals.carried).toBe(0)
    const collected = (await db.query<{ t: number }>(
      `SELECT COALESCE(SUM(amount), 0)::float AS t FROM payments
        WHERE space_carryforward_id IS NOT NULL AND type = 'carried_balance'
          AND status IN ('settled', 'paid_via_deposit')`)).rows[0]
    expect(collected.t).toBe(880)
  })
})

// ── 6. When the bank takes the payment back ──────────────────────────────────

describe('a payment of the carried balance that is taken back', () => {
  /** Stripe's webhook, the way every other reversal test drives it. */
  const bankTakesItBack = (paymentId: string, amount: number) => handlePaymentReversal({
    paymentId, reversalType: 'ach_return', reversedAmount: amount, reversalFee: 0,
    stripeEventId: `evt_space_carryforward_${paymentId}`, rawEvent: {},
  })

  it('reopens the balance instead of leaving a paid-off record over money the bank has back', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    const next = await nextResident(p)
    await pay({ tenantId: next.tenantId, landlordId: p.landlordId, amount: 880 })
    expect((await carryforwardForUnit(p.unitId))!.status).toBe('settled')

    const settledRow = (await carriedRows()).find(r => r.status === 'settled')!
    expect((await bankTakesItBack(settledRow.id, 880)).handled).toBe(true)

    // The row the money left is marked returned and a fresh one is owed again —
    // and the second row is NOT the claim's original charge, so it does not
    // collide with it (the whole reversal used to roll back on that index, with
    // the bank's $880 already gone and the record still reading paid off).
    const rows = await carriedRows()
    expect(rows.find(r => r.id === settledRow.id)!.status).toBe('returned')
    const reopened = rows.filter(r => r.id !== settledRow.id)
    expect(reopened).toHaveLength(1)
    expect(reopened[0]).toMatchObject({ amount: 880, status: 'pending', is_remainder: true })

    const cf = (await carryforwardForUnit(p.unitId))!
    expect(cf.status).toBe('open')
    expect(cf.settledAmount).toBe(0)
    expect(cf.stillOwed).toBe(880)
    expect(cf.settledOn).toBeNull()
    // And the departing resident's permanent record says so too.
    const his = (await carryforwardsOwedBy(p.departingTenantId))[0]
    expect(his.status).toBe('open')
    expect(his.settledOn).toBeNull()
    expect(his.stillOwed).toBe(880)
    // It is on somebody's bill again, once.
    expect((await quoteOf(next.tenantId, p.landlordId)).totals.carried).toBe(880)
  })

  it('a bounced PART payment reopens its own slice beside the rest, and the claim stays open', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    const next = await nextResident(p)
    await pay({ tenantId: next.tenantId, landlordId: p.landlordId, amount: 100 })

    const slice = (await carriedRows()).find(r => r.status === 'settled')!
    expect(slice.amount).toBe(100)
    expect((await bankTakesItBack(slice.id, 100)).handled).toBe(true)

    const cf = (await carryforwardForUnit(p.unitId))!
    expect(cf.status).toBe('open')
    expect(cf.settledAmount).toBe(0)
    expect(cf.stillOwed).toBe(880)
    // $780 of rest + $100 owed again = the whole balance, on one claim.
    const owed = (await carriedRows()).filter(r => r.status === 'pending')
    expect(total(owed)).toBe(880)
    expect((await quoteOf(next.tenantId, p.landlordId)).totals.carried).toBe(880)
  })
})

// ── 7. A balance the landlord takes off ──────────────────────────────────────

describe('taking a carried balance off', () => {
  /** Write a charge off the way the landlord's own void does. */
  async function writeOff(paymentId: string, tenantId: string, landlordId: string) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await lockHousehold(c, tenantId, landlordId)
      const r = await voidUnowedCharges((t, params) => c.query(t, params), [paymentId], 'Written off by the landlord')
      await c.query('COMMIT')
      return r
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('a part payment and a write-off is TAKEN OFF, never paid off', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    const next = await nextResident(p)
    await pay({ tenantId: next.tenantId, landlordId: p.landlordId, amount: 100 })

    const rest = (await carriedRows()).find(r => r.status === 'pending')!
    expect(rest.amount).toBe(780)
    expect((await writeOff(rest.id, next.tenantId, p.landlordId)).voided).toHaveLength(1)

    const cf = (await carryforwardForUnit(p.unitId))!
    expect(cf.status).toBe('voided')        // "Taken off" — NOT 'settled'
    expect(cf.settledOn).toBeNull()         // nothing settled on any day
    expect(cf.settledAmount).toBe(100)      // what was really paid is kept
    expect(cf.stillOwed).toBe(0)            // and nobody is asked for the rest

    // His permanent record does not say the $880 cleared.
    const his = (await carryforwardsOwedBy(p.departingTenantId))[0]
    expect(his.status).toBe('voided')
    expect(his.settledOn).toBeNull()

    // And an arrangement is refused in the right words.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await expect(setArrangement(c, {
        carryforwardId: cf.id, amount: 50, dayOfMonth: 1, byUserId: p.userId,
      })).rejects.toThrow(/taken off/i)
      await c.query('ROLLBACK')
    } finally { c.release() }
  })

  it('a close-out run on the wrong resident can be undone, and the space can be closed out again', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    const cf = (await carryforwardForUnit(p.unitId))!

    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await takeOffCarryforward(c, {
        carryforwardId: cf.id, byUserId: p.userId, reason: 'Closed out the wrong space',
      })
      await c.query('COMMIT')
      expect(r).toMatchObject({ takenOff: 880, keptPaid: 0, chargesVoided: 1 })
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }

    const after = (await carryforwardForUnit(p.unitId))!
    expect(after.status).toBe('voided')
    expect(after.stillOwed).toBe(0)
    // Who wrote money off, and the day on the park's calendar.
    expect(after.takenOffOn).toBe(await parkDay(0))
    expect((await db.query<{ by: string | null }>(
      `SELECT taken_off_by AS by FROM space_rent_carryforwards WHERE id = $1`, [cf.id])).rows[0].by).toBe(p.userId)
    // Kept, not erased: the charge row says why, and the claim says who it was.
    const row = (await carriedRows())[0]
    expect(row.status).toBe('voided')
    expect((await db.query<{ reason: string }>(
      `SELECT void_reason AS reason FROM payments WHERE id = $1`, [row.id])).rows[0].reason)
      .toMatch(/taken off/i)
    expect(after.owedByTenantId).toBe(p.departingTenantId)
    expect((await quoteOf(p.departingTenantId, p.landlordId)).totals.carried).toBe(0)

    // The space is free to close out again — the one-open-claim index does not
    // block it any more, which is what the refusal told the landlord to do.
    const next = await nextResident(p)
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                             entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',440,'pending','RENT',CURRENT_DATE)`,
      [p.landlordId, p.unitId, next.leaseId, next.tenantId])
    const pv = await previewSpaceRentCarryforward(next.leaseId)
    expect(pv.existingCarryforwardId).toBeNull()
    expect(pv.eligible).toBe(true)
    expect(pv.carriesTotal).toBe(440)
  })

  const takeOff = async (carryforwardId: string, userId: string) => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await takeOffCarryforward(c, { carryforwardId, byUserId: userId })
      await c.query('COMMIT')
      return r
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('refuses a balance that is already paid off, one already taken off, and one with a payment still clearing', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    const next = await nextResident(p)
    const cf = (await carryforwardForUnit(p.unitId))!

    // An ACH on its way is not money the landlord can write off yet.
    await db.query(
      `UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_space_cf_clearing'
        WHERE space_carryforward_id = $1 AND type = 'carried_balance'`, [cf.id])
    await expect(takeOff(cf.id, p.userId)).rejects.toThrow(/still clearing/i)
    await db.query(
      `UPDATE payments SET status = 'pending', stripe_payment_intent_id = NULL
        WHERE space_carryforward_id = $1 AND type = 'carried_balance'`, [cf.id])

    // Taken off once, and not twice.
    await takeOff(cf.id, p.userId)
    await expect(takeOff(cf.id, p.userId)).rejects.toThrow(/already been taken off/i)

    // A balance that was paid is not a balance to write off.
    const q = await oakParkMh09()
    await closeOut(q)
    const buyer = await nextResident(q)
    const qcf = (await carryforwardForUnit(q.unitId))!
    await pay({ tenantId: buyer.tenantId, landlordId: q.landlordId, amount: 880 })
    await expect(takeOff(qcf.id, q.userId)).rejects.toThrow(/paid off/i)
  })
})

// ── 8. Where the money lands in the books ────────────────────────────────────

describe('the books', () => {
  /** Oak Park with its books on from before any of this was billed. */
  async function withBooks(p: Park): Promise<void> {
    await db.query(`UPDATE landlords SET books_start_date = $2::date WHERE id = $1`,
      [p.landlordId, await parkDay(120)])
    registerTenantLedgerProjectors()
    await drain()
  }
  /**
   * One P&L line of the Books ledger, by the calendar month it is reported in
   * — the figure a bookkeeper closing a month reads. Months rather than a
   * total, because the whole question here is whether money moves between
   * them. (Read off the park's own months, not hardcoded, so the test says the
   * same thing whatever day it runs on.)
   */
  async function byMonth(p: Park, line: 'rent' | 'lateFees' | 'balances'): Promise<Record<string, number>> {
    const events = await incomeEvents({
      landlordIds: [p.landlordId], start: await parkDay(200), end: await parkDay(0),
      basis: 'billed', source: 'ledger',
    })
    const out: Record<string, number> = {}
    for (const e of events) {
      if (!e.inTotal || e.line !== line) continue
      const k = e.day.slice(0, 7)
      out[k] = Math.round(((out[k] ?? 0) + e.amount) * 100) / 100
    }
    return out
  }

  it('leaves each month\'s space rent in its own month: the carried balance moves a debt, it does not earn anything', async () => {
    const p = await oakParkMh09()
    await withBooks(p)

    // What the park really earned, month by month ($440 in each, 30 days apart).
    const rentBefore = await byMonth(p, 'rent')
    expect(Object.values(rentBefore).reduce((s, v) => s + v, 0)).toBe(880)

    const r = await closeOut(p)
    await drain()

    // Every month's rent is exactly where it was. The close-out voided both
    // rent rows and billed ONE $880 charge due-dated the OLDEST of them, so
    // booking that charge as income would have erased the newer month and
    // backdated its rent into a month the park has already reported — and six
    // months of run-up would all have landed in month one.
    expect(await byMonth(p, 'rent')).toEqual(rentBefore)
    // The waived late fees are gone, which is the one thing here that IS a
    // correction: they were dropped, not collected and not moved.
    expect(await byMonth(p, 'lateFees')).toEqual({})
    // And the carried balance is on no income line at all.
    expect(await byMonth(p, 'balances')).toEqual({})

    // The carried charge itself: a receivable that changed hands. Off the
    // resident who left it, onto whoever the desk asks now, and no income line
    // anywhere in it.
    const lines = await activeLines('payment', r.chargeId)
    expect(triples(lines)).toEqual([['ar_tenants', 88000, 0], ['ar_tenants', 0, 88000]])
    expect(lines.every(l => l.kind === 'charge')).toBe(true)
    expect(lines.filter(l => l.dr > 0).every(l => l.tenantId === p.departingTenantId)).toBe(true)

    // The two rent rows it was carried from keep their own charges, in their
    // own months, voided or not.
    const voidedRent = (await db.query<{ id: string; due: string }>(
      `SELECT id, due_date::text AS due FROM payments
        WHERE lease_id = $1 AND type = 'rent' AND status = 'voided' ORDER BY due_date`,
      [p.departingLeaseId])).rows
    expect(voidedRent).toHaveLength(2)
    for (const row of voidedRent) {
      const l = await activeLines('payment', row.id)
      expect(triples(l)).toEqual([['ar_tenants', 44000, 0], ['space_rent', 0, 44000]])
      expect(l.every(x => x.day === row.due)).toBe(true)
    }
  })

  it('a part payment splits the charge and the books still move exactly one $880 of receivable', async () => {
    const p = await oakParkMh09()
    await withBooks(p)
    await closeOut(p)
    const next = await nextResident(p)
    await pay({ tenantId: next.tenantId, landlordId: p.landlordId, amount: 100 })
    await drain()

    // Two rows now (the $100 slice and the $780 rest), each posting its own
    // part, which is the family-A rule for any split row — and together $880,
    // never $1,760.
    const rows = await carriedRows()
    expect(rows).toHaveLength(2)
    let moved = 0
    for (const row of rows) {
      const l = await activeLines('payment', row.id)
      expect(l.filter(x => x.role !== 'ar_tenants')).toEqual([])
      moved += l.filter(x => x.dr > 0).reduce((s, x) => s + x.dr, 0)
    }
    expect(moved).toBe(88000)
    // Nothing of it reached an income line in any month.
    expect(await byMonth(p, 'balances')).toEqual({})
  })

  it('money paid against it is a balance collected, not rent earned now — and both reports say so', async () => {
    const p = await oakParkMh09()
    await withBooks(p)
    await closeOut(p)
    const next = await nextResident(p)
    await pay({ tenantId: next.tenantId, landlordId: p.landlordId, amount: 880 })
    await drain()

    const window = { landlordIds: [p.landlordId], start: await parkDay(120), end: await parkDay(0) }
    for (const source of ['ledger', 'records'] as const) {
      const t = await incomeTotals({ ...window, basis: 'received', source })
      expect(t.lines.balances, source).toBe(880)
      expect(t.lines.rent, source).toBe(0)       // not earned twice, and not earned now
      expect(t.lines.lateFees, source).toBe(0)   // the fees were dropped, not collected
    }
  })
})

// ── 8. Payment arrangements ──────────────────────────────────────────────────

describe('a payment arrangement on a carried balance', () => {
  it('asks for its amount on the cycle, and a missed one charges no late fee', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    const next = await nextResident(p)
    const cf = (await carryforwardForLease(next.leaseId))!

    const today = await parkDay(0)
    const dayOfMonth = Number(today.slice(8, 10))
    // A day past 28 cannot be an arrangement day (nor can it be, in a month
    // with 28 days) — start the arrangement on the 1st and run the job for that
    // day instead.
    const day = dayOfMonth <= 28 ? dayOfMonth : 1

    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await setArrangement(c, { carryforwardId: cf.id, amount: 100, dayOfMonth: day, byUserId: p.userId, startOn: today })
      await c.query('COMMIT')
    } finally { c.release() }

    const runOn = async (asOf: string) => {
      const cc = await db.connect()
      try {
        await cc.query('BEGIN')
        const r = await runCarryforwardArrangements(cc, asOf)
        await cc.query('COMMIT')
        return r
      } catch (e) { await cc.query('ROLLBACK'); throw e } finally { cc.release() }
    }

    const month1 = `${today.slice(0, 8)}${String(day).padStart(2, '0')}`
    const first = await runOn(month1)
    expect(first.asked).toBe(1)
    // Running it again on the same cycle asks for nothing more.
    expect((await runOn(month1)).asked).toBe(0)

    let view = (await carryforwardForLease(next.leaseId))!
    expect(view.arrangement).toEqual({ amount: 100, dayOfMonth: day, startedOn: today })
    expect(view.installments).toHaveLength(1)
    expect(view.installments[0]).toMatchObject({ dueDate: month1, amount: 100, status: 'asked' })

    // Next cycle, with nothing paid: the first ask is MISSED, and nothing is
    // charged for it. Nic dropped late fees on a carried balance outright.
    const month2 = (await db.query<{ d: string }>(
      `SELECT ($1::date + INTERVAL '1 month')::date::text AS d`, [month1])).rows[0].d
    const second = await runOn(month2)
    expect(second.asked).toBe(1)
    expect(second.missed).toBe(1)
    expect(second.lateFeesCharged).toBe(0)

    const anyFee = (await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE type = 'late_fee' AND status <> 'voided' AND lease_id = $1`, [next.leaseId])).rows[0]
    expect(anyFee.n).toBe(0)
    // And the balance did not grow: the arrangement writes no charge of its own.
    const charges = (await db.query<{ n: number; t: number }>(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS t FROM payments
        WHERE space_carryforward_id IS NOT NULL AND type = 'carried_balance' AND status = 'pending'`)).rows[0]
    expect(charges.n).toBe(1)
    expect(charges.t).toBe(880)

    view = (await carryforwardForLease(next.leaseId))!
    expect(view.installments.map(i => i.status).sort()).toEqual(['asked', 'missed'])
    expect(view.stillOwed).toBe(880)
  })

  it('refuses a monthly amount larger than what is still owed, and can be turned off', async () => {
    const p = await oakParkMh09()
    await closeOut(p)
    const cf = (await carryforwardForUnit(p.unitId))!
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await expect(setArrangement(c, {
        carryforwardId: cf.id, amount: 2000, dayOfMonth: 1, byUserId: p.userId,
      })).rejects.toThrow(/still owed/i)
      await c.query('ROLLBACK')

      await c.query('BEGIN')
      await setArrangement(c, { carryforwardId: cf.id, amount: 50, dayOfMonth: 1, byUserId: p.userId })
      await setArrangement(c, { carryforwardId: cf.id, amount: null, dayOfMonth: null, byUserId: p.userId })
      await c.query('COMMIT')
    } finally { c.release() }
    expect((await carryforwardForUnit(p.unitId))!.arrangement).toBeNull()
  })
})
