/**
 * 11/1 — THE PAY-AHEAD MUST NOT ASK FOR MONEY ALREADY ASKED FOR.
 *
 * MH 28: Heather Miller's installment 1 was billed on her move-in invoice and
 * her ACH for it was clearing. The pay-ahead counted it as unfunded anyway,
 * because an installment stays 'pending' until its own pull settles — so her
 * lease page read "Deposit remaining to fund — $450.00" and offered to debit
 * the whole $450, which would have taken that $112.50 from her twice.
 *
 * The route behind the button takes an empty body, so a double tap, a retried
 * request or a second tab reached it more than once and each pass created its
 * own live ACH debit. On 10/29 the button fired on a single tap with no
 * confirmation step at all — her $450 row (voided the next morning) is that
 * press.
 *
 * Both guards sit before any Stripe call, so these tests need no Stripe.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { payAheadFlexDeposit } from './flexDeposit'

// A test run refuses a live Stripe key (S639), and these guards sit in front of
// the charge, so the bank side is stubbed: every pull that gets past them is
// recorded here with the amount it was asked for. What the pull ASKS FOR is the
// assertion — a guard that merely changes an error message would still take the
// money.
const pulls = vi.hoisted(() => ({ amounts: [] as number[], keys: [] as string[] }))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  getStripe: () => ({
    customers: { retrieve: async () => ({ invoice_settings: { default_payment_method: 'pm_test' } }) },
  }),
}))
vi.mock('./stripeConnect', async (orig) => ({
  ...(await orig<typeof import('./stripeConnect')>()),
  createRentPlatformCharge: async (a: any) => {
    pulls.amounts.push(Number(a.amount))
    pulls.keys.push(String(a.idempotencyKey ?? ''))
    return { id: `pi_test_${randomUUID().slice(0, 8)}` }
  },
}))

beforeEach(async () => {
  await cleanupAllSchema()
  pulls.amounts = []
  pulls.keys = []
})

/** A resident on an active four-split plan: $450 deposit, 4 x $112.50. */
async function onAnActivePlan() {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 450 })
    const tenantId = await seedTenant(client, { email: `payahead-${randomUUID()}@test.dev` })
    // A Stripe customer, so a missing one is never what makes a test pass.
    await client.query(`UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1`,
      [tenantId, `cus_test_${randomUUID().slice(0, 8)}`])

    const lease = await client.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, status, lease_type, start_date, rent_amount,
                           rent_due_day, signed_by_tenant, signed_by_landlord)
       VALUES ($1, $2, 'active', 'month_to_month', CURRENT_DATE, 450, 1, TRUE, TRUE)
       RETURNING id`, [unitId, landlordId])
    const leaseId = lease.rows[0].id
    await seedLeaseTenant(client, { leaseId, tenantId })

    const dep = await client.query<{ id: string }>(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, status, held_by,
          flex_deposit_enabled, flex_deposit_plan_status)
       VALUES ($1, $2, $3, 450.00, 'pending', 'gam_escrow', TRUE, 'active')
       RETURNING id`, [unitId, leaseId, tenantId])
    const depositId = dep.rows[0].id

    const instIds: string[] = []
    for (let n = 1; n <= 4; n++) {
      const r = await client.query<{ id: string }>(
        `INSERT INTO flex_deposit_installments
           (security_deposit_id, tenant_id, installment_number, installment_count,
            amount, due_date, status)
         VALUES ($1, $2, $3, 4, 112.50, (CURRENT_DATE + ($3 - 1) * INTERVAL '1 month')::date, 'pending')
         RETURNING id`, [depositId, tenantId, n])
      instIds.push(r.rows[0].id)
    }

    await client.query('COMMIT')
    return { landlordId, unitId, tenantId, leaseId, depositId, instIds }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/** Installment 1, billed on the move-in invoice, in the given state. */
async function billInstallmentOne(f: any, status: 'pending' | 'processing' | 'settled') {
  const pay = await db.query<{ id: string }>(
    `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id,
                           type, amount, status, entry_description, due_date,
                           flex_deposit_security_deposit_id)
     VALUES ($1,$2,$3,$4,'deposit',112.50,$5,'DEPOSIT',CURRENT_DATE,$6)
     RETURNING id`,
    [f.landlordId, f.tenantId, f.unitId, f.leaseId, status, f.depositId])
  await db.query(
    `UPDATE flex_deposit_installments SET payment_id = $1
      WHERE id = $2`, [pay.rows[0].id, f.instIds[0]])
  return pay.rows[0].id
}

describe('what the pay-ahead treats as still unfunded', () => {
  it('asks the bank for the whole deposit when nothing has been asked for yet', async () => {
    const f = await onAnActivePlan()
    const r = await payAheadFlexDeposit({ tenantId: f.tenantId })
    expect(r.ok).toBe(true)
    expect(pulls.amounts).toEqual([450])
  })

  it('never asks the bank for an installment whose money is CLEARING — MH 28 exactly', async () => {
    const f = await onAnActivePlan()
    await billInstallmentOne(f, 'processing')
    const r = await payAheadFlexDeposit({ tenantId: f.tenantId })
    expect(r.ok).toBe(true)
    // $450 less the $112.50 in flight. The old code pulled $450 and took that
    // $112.50 a second time.
    expect(pulls.amounts).toEqual([337.5])
    expect(r.balance_remaining).toBe(337.5)
  })

  it('never asks for an installment already billed and waiting to be paid', async () => {
    const f = await onAnActivePlan()
    await billInstallmentOne(f, 'pending')
    const r = await payAheadFlexDeposit({ tenantId: f.tenantId })
    expect(r.ok).toBe(true)
    expect(pulls.amounts).toEqual([337.5])
  })

  it('never asks for one already settled', async () => {
    const f = await onAnActivePlan()
    await billInstallmentOne(f, 'settled')
    await payAheadFlexDeposit({ tenantId: f.tenantId })
    expect(pulls.amounts).toEqual([337.5])
  })

  it('refuses outright once every installment has been asked for', async () => {
    const f = await onAnActivePlan()
    for (let i = 0; i < 4; i++) {
      const pay = await db.query<{ id: string }>(
        `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id,
                               type, amount, status, entry_description, due_date,
                               flex_deposit_security_deposit_id)
         VALUES ($1,$2,$3,$4,'deposit',112.50,'processing','DEPOSIT',CURRENT_DATE,$5)
         RETURNING id`,
        [f.landlordId, f.tenantId, f.unitId, f.leaseId, f.depositId])
      await db.query(`UPDATE flex_deposit_installments SET payment_id = $1 WHERE id = $2`,
        [pay.rows[0].id, f.instIds[i]])
    }
    const r = await payAheadFlexDeposit({ tenantId: f.tenantId })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('Deposit is already fully funded')
  })
})

describe('asking twice', () => {
  it('refuses while a pay-ahead of its own is still clearing', async () => {
    const f = await onAnActivePlan()
    await db.query(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id,
                             type, amount, status, entry_description, due_date,
                             notes, flex_deposit_security_deposit_id)
       VALUES ($1,$2,$3,$4,'deposit',450.00,'processing','DEPOSIT',CURRENT_DATE,
               $5,$6)`,
      [f.landlordId, f.tenantId, f.unitId, f.leaseId,
       `FlexDeposit voluntary pay-ahead (deposit ${f.depositId})`, f.depositId])
    const r = await payAheadFlexDeposit({ tenantId: f.tenantId })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('A pay-ahead payment is already clearing')
    // The point of the guard: the bank was never asked.
    expect(pulls.amounts).toEqual([])
  })

  it('carries an idempotency key, so a lost reply cannot pull twice', async () => {
    const f = await onAnActivePlan()
    await payAheadFlexDeposit({ tenantId: f.tenantId })
    expect(pulls.keys[0]).toBe(`flexdeposit_payahead_${f.depositId}_450.00`)
  })

  it('a VOIDED earlier pay-ahead does not block a new one', async () => {
    const f = await onAnActivePlan()
    await db.query(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id,
                             type, amount, status, entry_description, due_date,
                             notes, flex_deposit_security_deposit_id,
                             voided_at, void_reason)
       VALUES ($1,$2,$3,$4,'deposit',450.00,'voided','DEPOSIT',CURRENT_DATE,
               $5,$6, NOW(), 'test')`,
      [f.landlordId, f.tenantId, f.unitId, f.leaseId,
       `FlexDeposit voluntary pay-ahead (deposit ${f.depositId})`, f.depositId])
    const r = await payAheadFlexDeposit({ tenantId: f.tenantId })
    expect(r.reason).not.toBe('A pay-ahead payment is already clearing')
  })
})
