/**
 * S640 (Nic) — the onboarding waiver has to hold even when nothing stamped it.
 *
 *   "We're showing six delinquent units in cure window, late fees accruing.
 *    That's a false flag on the tenants currently, because onboarding tenants
 *    are exempt from late fees."
 *
 * The S639 rule is that an existing resident's FIRST bill on the platform is
 * never late: the delay was our onboarding, not theirs. It was enforced by a
 * flag stamped at invoice generation — which covers invoices the generator
 * makes and nothing else. Two of the five delinquent leases at Oak Park and
 * Mountain View carried is_existing_tenancy with a first invoice and no stamp,
 * because their invoices predate the rule. Nothing would have re-checked before
 * fining them.
 *
 * So the engine asserts the condition itself, against the facts.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { generateLateFeesForTimezone } from './lateFees'

const TZ = 'America/Phoenix'
beforeEach(async () => { await cleanupAllSchema() })

/** A resident 10 days past due, $5/day, no stamp on the invoice. */
async function seedOverdue(opts: {
  existingTenancy: boolean
  stamped?: boolean
  priorInvoice?: boolean
  /** S648: the property's answer. undefined = not answered. */
  waiver?: boolean
}) {
  const rent = 460
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone=$2, late_fee_enabled=TRUE, onboarding_late_fee_waiver=$3 WHERE id=$1`,
      [propertyId, TZ, opts.waiver ?? null])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: rent })
    await c.query(
      `UPDATE leases SET late_fee_enabled=TRUE, late_fee_grace_days=3,
         late_fee_initial_amount=0, late_fee_initial_type='flat',
         late_fee_accrual_amount=5, late_fee_accrual_type='flat',
         late_fee_accrual_period='daily', late_fee_accrual_from='due_date',
         is_existing_tenancy=$2 WHERE id=$1`,
      [leaseId, opts.existingTenancy])

    const mkInvoice = async (daysAgo: number, stamped: boolean) => {
      const inv = await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date,
                               subtotal_rent, total_amount, status, late_fee_exempt)
         VALUES ($1,$2,$3,$4,(NOW() AT TIME ZONE $5)::date - $6::int, $7,$7,'pending',$8)
         RETURNING id`,
        [ll.landlordId, leaseId, unitId, `INV-${Math.random().toString(36).slice(2, 10)}`,
         TZ, daysAgo, rent, stamped])
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status,
                               entry_description, due_date, invoice_id)
         VALUES ($1,$2,$3,'rent',$4,'pending','RENT',(NOW() AT TIME ZONE $5)::date - $6::int, $7)`,
        [ll.landlordId, unitId, leaseId, rent, TZ, daysAgo, inv.rows[0].id])
      return inv.rows[0].id
    }
    // An earlier cycle, when the test wants this NOT to be the first bill.
    if (opts.priorInvoice) await mkInvoice(40, false)
    const invoiceId = await mkInvoice(10, opts.stamped ?? false)
    await c.query('COMMIT')
    return { invoiceId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const feesOn = async (invoiceId: string) => {
  const r = await db.query<{ n: string; total: string }>(
    `SELECT COUNT(*)::text AS n, COALESCE(SUM(amount),0)::text AS total
       FROM payments WHERE invoice_id=$1 AND type='late_fee'`, [invoiceId])
  return { count: Number(r.rows[0].n), total: Number(r.rows[0].total) }
}

describe('S640 onboarding waiver survives an unstamped invoice', () => {
  it('charges nothing on an existing resident’s first bill, stamp or no stamp', async () => {
    const { invoiceId } = await seedOverdue({ existingTenancy: true, stamped: false, waiver: true })
    await generateLateFeesForTimezone(TZ)
    expect(await feesOn(invoiceId)).toEqual({ count: 0, total: 0 })
  })

  // S648 (Nic): the waiver is the landlord's choice. "The tenants need to be
  // billed late fees if the landlord doesn't agree to waive them."
  it('charges an existing resident’s first bill when the landlord said no', async () => {
    const { invoiceId } = await seedOverdue({ existingTenancy: true, stamped: false, waiver: false })
    await generateLateFeesForTimezone(TZ)
    expect((await feesOn(invoiceId)).total).toBeGreaterThan(0)
  })

  it('charges an existing resident’s first bill when the landlord never answered', async () => {
    const { invoiceId } = await seedOverdue({ existingTenancy: true, stamped: false })
    await generateLateFeesForTimezone(TZ)
    expect((await feesOn(invoiceId)).total).toBeGreaterThan(0)
  })

  // The waiver is the FIRST cycle only. By the second they have had a full
  // month on the platform and their lease's own terms apply.
  it('charges normally on the same resident’s SECOND bill', async () => {
    const { invoiceId } = await seedOverdue({ existingTenancy: true, stamped: false, priorInvoice: true, waiver: true })
    await generateLateFeesForTimezone(TZ)
    expect((await feesOn(invoiceId)).total).toBeGreaterThan(0)
  })

  // A genuinely new applicant who signed and did not pay is not an onboarding
  // resident, and this must not have quietly waived them too.
  it('charges a NEW tenant’s first bill exactly as before', async () => {
    const { invoiceId } = await seedOverdue({ existingTenancy: false, stamped: false, waiver: true })
    await generateLateFeesForTimezone(TZ)
    expect((await feesOn(invoiceId)).total).toBeGreaterThan(0)
  })

  it('still honours an explicit exemption stamp on anyone', async () => {
    const { invoiceId } = await seedOverdue({ existingTenancy: false, stamped: true })
    await generateLateFeesForTimezone(TZ)
    expect(await feesOn(invoiceId)).toEqual({ count: 0, total: 0 })
  })
})
