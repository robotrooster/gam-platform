/**
 * S655 review (round 3) — the processing fee on a card or bank charge whose
 * landlord rows were ALL paid in full by credit GAM does not hold.
 *
 * "Use all $X": a credit the landlord gave (or paid-ahead money the landlord
 * already has) covers every landlord line, and the card or bank pays only a GAM
 * fee. Every landlord row then has gam_held_part 0 and books no owner share, so
 * the charge's fee and GAM's spread were booked zero times — and a
 * landlord-paid bank fee was never taken (GAM absorbing Stripe's cost).
 *
 * Its own file: allocation.test.ts has another writer this round.
 */
import { describe, it, expect } from 'vitest'
import { executeRentAllocation } from './allocation'
import {
  withRollback, seedLandlord, seedTenant, seedProperty, seedUnit, seedAllocationRule,
} from '../test/dbHelpers'

interface Fx { landlordId: string; propertyId: string; unitId: string; tenantId: string; leaseId: string }

async function fx(client: any, o: { feePayer: 'tenant' | 'landlord'; noRule?: boolean }): Promise<Fx> {
  const { userId: ownerUserId, landlordId } = await seedLandlord(client)
  const tenantId = await seedTenant(client)
  const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
  if (!o.noRule) await seedAllocationRule(client, { propertyId, achFeePayer: o.feePayer, cardFeePayer: o.feePayer })
  const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 460 })
  const leaseId = (await client.query(
    `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
     VALUES ($1, $2, 460, 'month_to_month', 'active', '2026-01-01') RETURNING id`, [unitId, landlordId])).rows[0].id
  await client.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
  return { landlordId, propertyId, unitId, tenantId, leaseId }
}

/** The test rates, set inside the rolled-back test: card 3.25% + $0.30 (cost 2.9% + $0.30); bank the flat $6 (cost 0.5%, cap $3). */
async function rates(client: any) {
  await client.query(`UPDATE platform_processing_rates SET effective_until = now() WHERE effective_until IS NULL`)
  await client.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent, customer_facing_cap,
        stripe_cost_flat, stripe_cost_percent, stripe_cost_cap)
     VALUES ('card', 0.30, 3.25, NULL, 0.30, 2.9, NULL),
            ('ach', 6.00, 0, 6.00, 0, 0.5, 3.00)`)
}

async function row(client: any, f: Fx, a: { type: string; amount: number; entry: string; owner?: 'landlord' | 'gam' }): Promise<string> {
  return (await client.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', '2026-10-01', $7, $8) RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, a.type, a.amount, a.entry, a.owner ?? 'landlord'])).rows[0].id
}

async function goodwill(client: any, f: Fx, paymentId: string, amount: number) {
  const tc = (await client.query(
    `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
     VALUES ($1, $2, $3, $4, $4, 'goodwill') RETURNING id`, [f.landlordId, f.tenantId, f.leaseId, amount])).rows[0].id
  await client.query(
    `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
     VALUES ($1, $2, $3, $4, '2026-10-01', 'portal', 'applied', now())`, [tc, paymentId, f.leaseId, amount])
}

async function landlordHeldPaidAhead(client: any, f: Fx, paymentId: string, amount: number) {
  const c = (await client.query(
    `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
     VALUES ($1, $2, $3, $3, 'landlord', now()) RETURNING id`, [f.leaseId, f.tenantId, amount])).rows[0].id
  await client.query(
    `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
     VALUES ($1, $2, $3, $4, '2026-10-01', 'portal', 'applied', now())`, [c, paymentId, f.leaseId, amount])
}

/** The card or bank charge settles every row on it (the webhook's stamp) and its remittance is the money. */
async function settleCharge(client: any, f: Fx, ids: string[], money: number, method: 'ach' | 'card', pi: string) {
  await client.query(
    `UPDATE payments SET status = 'settled', settled_at = now(), stripe_payment_intent_id = $2, stripe_charge_id = 'ch_' || $2
      WHERE id = ANY($1::uuid[])`, [ids, pi])
  await client.query(
    `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
     VALUES ($1, $2, $3, $4, $4, 0, 'settled', $5, $6)`, [f.tenantId, f.landlordId, f.leaseId, money, method, pi])
}

async function book(client: any, ids: string[]) {
  const spreads = (await client.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS spread, COALESCE(SUM(customer_fee_charged), 0)::float AS fee
       FROM platform_revenue_ledger WHERE reference_id = ANY($1::uuid[]) AND type = 'banking_spread'`, [ids])).rows[0]
  const owner = (await client.query(
    `SELECT COUNT(*)::int AS n FROM user_balance_ledger WHERE reference_id = ANY($1::uuid[])`, [ids])).rows[0].n as number
  return { spreads: spreads as { n: number; spread: number; fee: number }, ownerRows: owner }
}

describe('a card or bank charge that paid only a GAM fee because credit GAM does not hold paid the landlord lines', () => {
  it('a charge whose landlord rows were all paid by credit GAM does not hold still books its fee once', async () => {
    await withRollback(async (client) => {
      await rates(client)
      const f = await fx(client, { feePayer: 'tenant' })
      // The reviewer's case: $460 rent paid whole by a goodwill credit, and the
      // card pays only GAM's $25 fee (a $25 remittance).
      const rent = await row(client, f, { type: 'rent', amount: 460, entry: 'RENT' })
      const gamFee = await row(client, f, { type: 'fee', amount: 25, entry: 'RETURNFEE', owner: 'gam' })
      await goodwill(client, f, rent, 460)
      await settleCharge(client, f, [rent, gamFee], 25, 'card', 'pi_goodwill_card')

      await executeRentAllocation(client, rent, 'card')

      const b = await book(client, [rent, gamFee])
      // 3.25% + $0.30 on the $25 the card moved = $1.11, booked once; Stripe's
      // 2.9% + $0.30 on the $26.11 it processed = $1.06; GAM keeps $0.05.
      expect(b.spreads).toEqual({ n: 1, fee: 1.11, spread: 0.05 })
      // Nothing GAM holds belongs to the landlord on this charge: no owner share,
      // and the tenant paid the card fee, so nothing is netted from the landlord.
      expect(b.ownerRows).toBe(0)
      const held = await client.query(`SELECT 1 FROM held_payout_items WHERE landlord_id = $1`, [f.landlordId])
      expect(held.rowCount).toBe(0)

      // Re-running allocation books nothing more.
      await executeRentAllocation(client, rent, 'card')
      expect((await book(client, [rent, gamFee])).spreads.n).toBe(1)
    })
  })

  it('a landlord who covers the bank fee pays it from the next payout as its own line, once per charge', async () => {
    await withRollback(async (client) => {
      await rates(client)
      const f = await fx(client, { feePayer: 'landlord' })
      // Rent paid by a goodwill credit, water by paid-ahead money the landlord
      // took at the desk; the bank pays only GAM's $25 fee.
      const rent = await row(client, f, { type: 'rent', amount: 460, entry: 'RENT' })
      const water = await row(client, f, { type: 'utility', amount: 40, entry: 'UTILITY' })
      const gamFee = await row(client, f, { type: 'fee', amount: 25, entry: 'RETURNFEE', owner: 'gam' })
      await goodwill(client, f, rent, 460)
      await landlordHeldPaidAhead(client, f, water, 40)
      await settleCharge(client, f, [rent, water, gamFee], 25, 'ach', 'pi_goodwill_ach')

      // The webhook allocates every landlord row the charge settled.
      await executeRentAllocation(client, rent, 'ach')
      await executeRentAllocation(client, water, 'ach')

      const b = await book(client, [rent, water, gamFee])
      // The flat $6, booked once (not once per landlord row); Stripe's 0.5% of
      // the $25 it moved is $0.13.
      expect(b.spreads).toEqual({ n: 1, fee: 6, spread: 5.87 })
      expect(b.ownerRows).toBe(0)
      const held = await client.query(
        `SELECT source_type, source_id, amount::float AS amount, description, payout_intent_id
           FROM held_payout_items WHERE landlord_id = $1`, [f.landlordId])
      expect(held.rows).toHaveLength(1)
      expect(held.rows[0]).toMatchObject({
        source_type: 'platform_fee', source_id: 'processing_fee:pi_goodwill_ach', amount: -6, payout_intent_id: null,
      })
      expect(held.rows[0].description).toMatch(/^Bank payment fee you cover for your tenant/)

      // A second pass over both rows (a re-run) takes nothing twice.
      await executeRentAllocation(client, water, 'ach')
      await executeRentAllocation(client, rent, 'ach')
      expect((await book(client, [rent, water, gamFee])).spreads.n).toBe(1)
      expect((await client.query(`SELECT 1 FROM held_payout_items WHERE landlord_id = $1`, [f.landlordId])).rowCount).toBe(1)
    })
  })

  it('a property missing its payout setup is told to an admin and the tenant’s settle stands', async () => {
    await withRollback(async (client) => {
      await rates(client)
      const f = await fx(client, { feePayer: 'tenant', noRule: true })
      const rent = await row(client, f, { type: 'rent', amount: 460, entry: 'RENT' })
      const gamFee = await row(client, f, { type: 'fee', amount: 25, entry: 'RETURNFEE', owner: 'gam' })
      await goodwill(client, f, rent, 460)
      await settleCharge(client, f, [rent, gamFee], 25, 'card', 'pi_goodwill_norule')

      // Never a throw: a strict rent allocation that threw would roll the
      // tenant's settle back and Stripe would retry it forever.
      await expect(executeRentAllocation(client, rent, 'card')).resolves.toBeUndefined()
      expect((await book(client, [rent, gamFee])).spreads.n).toBe(0)
      const alert = await client.query(
        `SELECT title FROM admin_notifications WHERE category = 'allocation_fee_not_booked' AND context->>'payment_id' = $1`, [rent])
      expect(alert.rowCount).toBe(1)
      expect(alert.rows[0].title).toMatch(/pi_goodwill_norule/)
    })
  })

  it('a charge with a landlord row GAM holds money on books the fee there, never on the credit-paid row', async () => {
    await withRollback(async (client) => {
      await rates(client)
      const f = await fx(client, { feePayer: 'landlord' })
      const rent = await row(client, f, { type: 'rent', amount: 460, entry: 'RENT' })
      const water = await row(client, f, { type: 'utility', amount: 40, entry: 'UTILITY' })
      await goodwill(client, f, rent, 460)            // rent: credit the landlord gave
      await settleCharge(client, f, [rent, water], 40, 'ach', 'pi_mixed')   // the bank paid the water
      await executeRentAllocation(client, rent, 'ach')
      await executeRentAllocation(client, water, 'ach')
      const b = await book(client, [rent, water])
      expect(b.spreads).toEqual({ n: 1, fee: 6, spread: 5.8 })
      // The water's owner share carries the landlord-paid $6; no held item.
      const owner = await client.query(
        `SELECT reference_id, amount::float AS a FROM user_balance_ledger WHERE reference_id = ANY($1::uuid[]) AND type = 'allocation_owner_share'`,
        [[rent, water]])
      expect(owner.rows).toEqual([{ reference_id: water, a: 34 }])
      expect((await client.query(`SELECT 1 FROM held_payout_items WHERE landlord_id = $1`, [f.landlordId])).rowCount).toBe(0)
    })
  })
})
