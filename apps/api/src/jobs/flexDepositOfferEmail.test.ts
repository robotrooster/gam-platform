/**
 * ── 10/29 (Nic): "it needs to be there until the deposit is handled one way
 *    or another" ───────────────────────────────────────────────────────────
 *
 * The portal prompt is the standing one. This is the email that reaches the
 * resident who does not log in — the resident at MH 28 would otherwise have
 * paid a $450 deposit in full on the 1st without ever learning that $179.50
 * was possible.
 *
 * What is asserted here is the thing a reminder gets wrong: it goes ONCE. A
 * cadence without a ceiling is how signing reminders once sent 74 emails to
 * one person (jobs/bankVerificationNudge), and the guard lives on the DEPOSIT
 * rather than in email_send_log, whose rows complianceArchive moves out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: `m_${Math.random().toString(36).slice(2)}` }, error: null }) as any),
}))
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSendMock } } }))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant,
  seedLeaseTenant, seedDepositCustodyRule,
} from '../test/dbHelpers'
import { sendFlexDepositOfferEmails } from './flexDepositOfferEmail'

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockClear()
  await seedDepositCustodyRule(db)
  await db.query(
    `INSERT INTO system_features (key, enabled, description)
     VALUES ('flexdeposit_rollout_visible', TRUE, '10/29 offer-email test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
})

/** A resident who owes a deposit and passes every FlexDeposit check. */
async function owesADeposit(o: { amount?: number; collected?: number } = {}) {
  const c = await db.connect()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    await c.query(
      `UPDATE landlords SET created_at = NOW() - INTERVAL '60 days',
                            connect_payouts_enabled = TRUE WHERE id = $1`, [landlordId])
    const tenantId = await seedTenant(c)
    const tu = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    const bg = await c.query<{ id: string }>(
      `INSERT INTO background_checks (landlord_id, user_id, tenant_id, status, risk_level)
       VALUES ($1,$2,$3,'approved','low') RETURNING id`,
      [landlordId, tu.rows[0].user_id, tenantId])
    await c.query(
      `UPDATE tenants SET ach_verified = TRUE, background_check_status = 'approved',
                          background_check_id = $2, created_at = NOW() - INTERVAL '400 days'
        WHERE id = $1`, [tenantId, bg.rows[0].id])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000, status: 'pending' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    // Landlord money moving, which the landlord gate reads.
    await c.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             entry_description, due_date, revenue_owner, settled_at)
       VALUES ($1,$2,$3,$4,'rent',1000,'settled','RENT',CURRENT_DATE,'landlord',NOW())`,
      [unitId, leaseId, tenantId, landlordId])
    const dep = await c.query<{ id: string }>(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount,
                                      collected_amount, status, held_by)
       VALUES ($1,$2,$3,$4,$5,$6,'gam_escrow') RETURNING id`,
      [unitId, leaseId, tenantId, (o.amount ?? 500).toFixed(2), (o.collected ?? 0).toFixed(2),
       (o.collected ?? 0) > 0 ? 'partial' : 'pending'])
    return { tenantId, landlordId, leaseId, unitId, depositId: dep.rows[0].id }
  } finally { c.release() }
}

describe('the one-time "you can split your deposit" email', () => {
  it('reaches a resident who owes a deposit, with their own figures in it', async () => {
    await owesADeposit({ amount: 500 })
    const r = await sendFlexDepositOfferEmails()

    expect(r.sent).toBe(1)
    expect(r.failed).toBe(0)
    // Asserted off the send log rather than the transport: what matters is
    // that the resident's OWN arithmetic went out, not which wire carried it.
    const log = await db.query<{ subject: string; metadata: any }>(
      `SELECT subject, metadata FROM email_send_log WHERE category = 'flexdeposit_offer'`)
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0].subject).toContain('$500.00')
    // The whole deposit, and the least they could pay instead — never a
    // "you may qualify" message with no numbers in it.
    expect(Number(log.rows[0].metadata.depositAmount)).toBe(500)
    expect(Number(log.rows[0].metadata.lowestFirstPull)).toBeGreaterThan(0)
    expect(Number(log.rows[0].metadata.lowestFirstPull)).toBeLessThan(500)
  })

  it('goes exactly once, however many times the job runs', async () => {
    const { depositId } = await owesADeposit()
    expect((await sendFlexDepositOfferEmails()).sent).toBe(1)
    expect((await sendFlexDepositOfferEmails()).sent).toBe(0)
    expect((await sendFlexDepositOfferEmails()).sent).toBe(0)

    const stamped = await db.query<{ at: string | null }>(
      `SELECT flexdeposit_offer_emailed_at::text AS at FROM security_deposits WHERE id = $1`,
      [depositId])
    expect(stamped.rows[0].at).not.toBeNull()
  })

  /**
   * The guard is on the deposit, not in email_send_log, precisely so that the
   * monthly archive cannot make a sent email look unsent.
   */
  it('still does not resend after the email log is archived away', async () => {
    await owesADeposit()
    expect((await sendFlexDepositOfferEmails()).sent).toBe(1)
    await db.query(`DELETE FROM email_send_log WHERE category = 'flexdeposit_offer'`)
    expect((await sendFlexDepositOfferEmails()).sent).toBe(0)
  })

  it('says nothing to a resident whose deposit is already funded', async () => {
    await owesADeposit({ amount: 500, collected: 500 })
    expect((await sendFlexDepositOfferEmails()).sent).toBe(0)
  })

  it('says nothing once a plan is running', async () => {
    const { depositId } = await owesADeposit()
    await db.query(
      `UPDATE security_deposits SET flex_deposit_enabled = TRUE,
              flex_deposit_plan_status = 'active' WHERE id = $1`, [depositId])
    expect((await sendFlexDepositOfferEmails()).sent).toBe(0)
  })

  it('says nothing while the product is switched off', async () => {
    await owesADeposit()
    await db.query(`UPDATE system_features SET enabled = FALSE WHERE key = 'flexdeposit_rollout_visible'`)
    expect((await sendFlexDepositOfferEmails()).sent).toBe(0)
  })
})
