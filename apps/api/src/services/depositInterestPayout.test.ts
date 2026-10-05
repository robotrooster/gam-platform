/**
 * S642 — Nic: "Calculate interest, have it be paid out as credit where
 * applicable… Realistically, either way, it ends up in the landlord's pocket.
 * Because they just use it to pay rent."
 *
 * Interest accrued monthly since S604 and was only ever paid at MOVE-OUT.
 * Eight states require annual payment while the tenancy continues.
 *
 * The failure that matters here is DOUBLE-PAYING: a miss is caught by the next
 * night's run, but a double-pay is money out the door behind a ledger that
 * looks correct.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'
import { todayIn } from '../lib/timezone'
import { payAnnualDepositInterest, outstandingDepositInterest, landlordHeldInterestAdvisory } from './depositInterestPayout'

beforeEach(async () => { await cleanupAllSchema() })

/** A deposit with `months` of unpaid accruals, the oldest `ageMonths` back. */
async function seedAccruals(opts: {
  months: number; perMonth: number; ageMonths: number; disbursed?: boolean
}) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { landlordId, userId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('dep-' || gen_random_uuid() || '@t.dev','x','tenant','Dee','Posit') RETURNING id`)
    const t = await c.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
    const sd = await c.query<{ id: string }>(
      `INSERT INTO security_deposits
         (tenant_id, lease_id, unit_id, total_amount, collected_amount,
          status, held_by, portability_status, custody_fee_active, disbursed_at)
       VALUES ($1,$2,$3,500,500,
               CASE WHEN $4 THEN 'disbursed' ELSE 'funded' END,
               'gam_escrow','none',FALSE,
               CASE WHEN $4 THEN NOW() ELSE NULL END) RETURNING id`,
      [t.rows[0].id, leaseId, unitId, !!opts.disbursed])
    for (let i = 0; i < opts.months; i++) {
      await c.query(
        `INSERT INTO security_deposit_interest_accruals
           (security_deposit_id, lease_id, accrual_month, state_code, effective_year,
            annual_rate_pct, principal_amount, days_held, days_in_month, interest_amount)
         VALUES ($1,$2, (date_trunc('month', CURRENT_DATE) - ($3 || ' months')::interval)::date,
                 'AZ', 2026, 5, 500, 30, 30, $4)`,
        [sd.rows[0].id, leaseId, opts.ageMonths - i, opts.perMonth])
    }
    await c.query('COMMIT')
    return { landlordId, tenantId: t.rows[0].id, depositId: sd.rows[0].id, leaseId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const creditsFor = async (tenantId: string) =>
  (await db.query<any>(
    `SELECT amount_original::float AS amt, category, reason FROM tenant_credits WHERE tenant_id=$1`,
    [tenantId])).rows

describe('S642 statutory deposit interest is actually handed over', () => {
  it('credits a full year of accrued interest to the tenant', async () => {
    const f = await seedAccruals({ months: 12, perMonth: 2.08, ageMonths: 12 })
    const r = await payAnnualDepositInterest()
    expect(r.paid).toBe(1)
    const credits = await creditsFor(f.tenantId)
    expect(credits).toHaveLength(1)
    expect(credits[0].amt).toBeCloseTo(24.96, 2)
    // Categorized, not dumped in "other" — this is a statutory obligation and
    // has to be findable as one.
    expect(credits[0].category).toBe('deposit_interest')
  })

  it('NEVER pays the same months twice', async () => {
    // The failure that costs real money. Two runs, one credit.
    const f = await seedAccruals({ months: 12, perMonth: 2.08, ageMonths: 12 })
    await payAnnualDepositInterest()
    const second = await payAnnualDepositInterest()
    expect(second.paid).toBe(0)
    expect(await creditsFor(f.tenantId)).toHaveLength(1)
  })

  it('marks the accruals paid and links them to the credit that paid them', async () => {
    const f = await seedAccruals({ months: 12, perMonth: 1, ageMonths: 12 })
    await payAnnualDepositInterest()
    const { rows } = await db.query<any>(
      `SELECT COUNT(*)::int AS n, COUNT(paid_credit_id)::int AS linked
         FROM security_deposit_interest_accruals
        WHERE security_deposit_id=$1 AND paid_at IS NOT NULL`, [f.depositId])
    expect(rows[0].n).toBe(12)
    expect(rows[0].linked).toBe(12)
  })

  it('waits for a full year — eleven months is not yet due', async () => {
    const f = await seedAccruals({ months: 11, perMonth: 2, ageMonths: 11 })
    const r = await payAnnualDepositInterest()
    expect(r.paid).toBe(0)
    expect(await creditsFor(f.tenantId)).toHaveLength(0)
  })

  it('leaves a returned deposit alone — its interest went out with the deposit', async () => {
    // Paying here would be the double-pay, one rail removed: depositReturn
    // already added interest_accrued to what the tenant got back.
    const f = await seedAccruals({ months: 12, perMonth: 2, ageMonths: 12, disbursed: true })
    const r = await payAnnualDepositInterest()
    expect(r.paid).toBe(0)
    expect(await creditsFor(f.tenantId)).toHaveLength(0)
  })

  it('pays nothing where nothing is owed', async () => {
    // A state that owes zero still accrues rows (S604) so GAM can see earnings.
    // Those must never become a credit.
    const f = await seedAccruals({ months: 14, perMonth: 0, ageMonths: 14 })
    const r = await payAnnualDepositInterest()
    expect(r.paid).toBe(0)
    expect(await creditsFor(f.tenantId)).toHaveLength(0)
  })

  it('reports who is owed, before anyone is paid', async () => {
    const f = await seedAccruals({ months: 12, perMonth: 2.5, ageMonths: 12 })
    const rows = await outstandingDepositInterest([f.landlordId])
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].owed)).toBeCloseTo(30, 2)
    expect(rows[0].months_unpaid).toBe(12)
    // And nothing is owed once it has been paid.
    await payAnnualDepositInterest()
    expect(await outstandingDepositInterest([f.landlordId])).toHaveLength(0)
  })
})

// ── S642: THE MONEY HAS TO BE VISIBLE TO BOTH SIDES ─────────────────────────
//
// Paying statutory interest as a credit creates a new way to be confusing: a
// tenant's balance drops and a landlord sees a credit appear, with nothing
// anywhere saying where it came from. Money moving on someone's ledger without
// explanation reads as a bug — to the tenant especially, who can least afford
// to guess.
describe('S642 a paid credit is explicable from both sides', () => {
  it('the tenant credit is categorized so it can be named, not lumped in "other"', async () => {
    const f = await seedAccruals({ months: 12, perMonth: 1.5, ageMonths: 12 })
    await payAnnualDepositInterest()
    const { rows } = await db.query<any>(
      `SELECT category, reason, amount_remaining::float AS remaining
         FROM tenant_credits WHERE tenant_id=$1`, [f.tenantId])
    expect(rows[0].category).toBe('deposit_interest')
    // The reason is what a resident reads when they ask what this is.
    expect(rows[0].reason).toMatch(/interest on your security deposit/i)
    // And it is spendable — it reduces what they owe, it is not a note.
    expect(rows[0].remaining).toBeCloseTo(18, 2)
  })

  it('the landlord can see what is still owed AND what has gone out', async () => {
    const f = await seedAccruals({ months: 12, perMonth: 2, ageMonths: 12 })
    expect(await outstandingDepositInterest([f.landlordId])).toHaveLength(1)
    await payAnnualDepositInterest()
    // Owed is now nil...
    expect(await outstandingDepositInterest([f.landlordId])).toHaveLength(0)
    // ...and the credit is on the books, attributable to this landlord.
    const { rows } = await db.query<any>(
      `SELECT COUNT(*)::int AS n FROM tenant_credits
        WHERE landlord_id=$1 AND category='deposit_interest'`, [f.landlordId])
    expect(rows[0].n).toBe(1)
  })

  it('one landlord cannot see another landlord’s obligation', async () => {
    const mine   = await seedAccruals({ months: 12, perMonth: 1, ageMonths: 12 })
    const theirs = await seedAccruals({ months: 12, perMonth: 9, ageMonths: 12 })
    const rows = await outstandingDepositInterest([mine.landlordId])
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].owed)).toBeCloseTo(12, 2)
    expect(rows.every((r: any) => r.landlord_id !== theirs.landlordId)).toBe(true)
  })
})

// ── S642: A DEPOSIT THE LANDLORD HOLDS ──────────────────────────────────────
//
// Nic: "We're only paying interest on the deposit when we hold it, right?
// Otherwise, it's just a flag for the landlord. Hey, your tenant is owed this
// much interest. Recommend adding a credit to their bill."
//
// Two things must both hold, and the second is the dangerous one: GAM must TELL
// the landlord, and GAM must never PAY on money it does not custody. An advisory
// that could reach the nightly sweep would have GAM crediting a tenant out of
// its own funds for a deposit sitting in someone else's bank account.
describe('S642 landlord-held deposits are flagged, never paid', () => {
  /**
   * The rates are seeded by MIGRATION and this harness builds the database from
   * a schema-only dump, so no reference data exists here — the advisory would
   * find no rule and return nothing for a reason that has nothing to do with
   * the code under test. Seed the two Arizona rules the cases below rely on.
   */
  async function seedAzRules() {
    // S654: the source looks the rule up by the property's year (Phoenix here);
    // UTC is already next year after 5 pm on Dec 31.
    const year = Number(todayIn(null).slice(0, 4))
    await db.query(`DELETE FROM state_deposit_interest_rates WHERE state_code='AZ'`)
    await db.query(
      `INSERT INTO state_deposit_interest_rates
         (state_code, effective_year, annual_rate_pct, statute_citation, notes,
          unit_types, act_key, rate_basis)
       VALUES ('AZ',$1,5,'A.R.S. § 33-1431(B)','mobile home park',
               ARRAY['mobile_home'],'mobile_home_park','fixed'),
              ('AZ',$1,0,'A.R.S. § 33-2121','RV long-term spaces owe nothing',
               ARRAY['rv_spot'],'rv_long_term','none')`,
      [year])
  }

  async function seedLandlordHeld(stateCode: string, unitType: string, principal: number) {
    await seedAzRules()
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const { landlordId, userId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId, state: stateCode })
      const unitId = await seedUnit(c, { propertyId, landlordId, unitType })
      const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name)
         VALUES ('lh-' || gen_random_uuid() || '@t.dev','x','tenant','Lan','Held') RETURNING id`)
      const t = await c.query<{ id: string }>(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
      await c.query(
        `INSERT INTO security_deposits
           (tenant_id, lease_id, unit_id, total_amount, collected_amount,
            status, held_by, portability_status, custody_fee_active, created_at)
         VALUES ($1,$2,$3,$4,$4,'funded','landlord','none',FALSE, NOW() - INTERVAL '365 days')`,
        [t.rows[0].id, leaseId, unitId, principal])
      await c.query('COMMIT')
      return { landlordId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('flags an Arizona mobile-home deposit the landlord holds, at the statutory 5%', async () => {
    const { landlordId } = await seedLandlordHeld('AZ', 'mobile_home', 1000)
    const rows = await landlordHeldInterestAdvisory([landlordId])
    expect(rows).toHaveLength(1)
    expect(rows[0].ratePct).toBe(5)
    // A year at 5% on $1,000.
    expect(rows[0].estimated).toBeCloseTo(50, 0)
  })

  it('NEVER pays it — the sweep does not touch money GAM does not hold', async () => {
    const { landlordId } = await seedLandlordHeld('AZ', 'mobile_home', 1000)
    const r = await payAnnualDepositInterest()
    expect(r.paid).toBe(0)
    const { rows } = await db.query<any>(
      `SELECT COUNT(*)::int AS n FROM tenant_credits WHERE landlord_id=$1`, [landlordId])
    expect(rows[0].n).toBe(0)
  })

  it('writes no accrual row, so it has no path into the payout sweep', async () => {
    // The whole reason the advisory is computed on READ. An accrual row IS a
    // payable; creating one here would make GAM liable for someone else's money.
    const { landlordId } = await seedLandlordHeld('AZ', 'mobile_home', 1000)
    await landlordHeldInterestAdvisory([landlordId])
    const { rows } = await db.query<any>(
      `SELECT COUNT(*)::int AS n FROM security_deposit_interest_accruals a
         JOIN leases l ON l.id = a.lease_id WHERE l.landlord_id = $1`, [landlordId])
    expect(rows[0].n).toBe(0)
  })

  it('stays quiet where the state owes nothing — an RV space in Arizona', async () => {
    // A.R.S. § 33-2121: RV long-term spaces owe no interest. Flagging one would
    // be telling a landlord to hand over money their state never asked for.
    const { landlordId } = await seedLandlordHeld('AZ', 'rv_spot', 1000)
    expect(await landlordHeldInterestAdvisory([landlordId])).toHaveLength(0)
  })

  it('one landlord cannot see another’s advisory', async () => {
    const mine   = await seedLandlordHeld('AZ', 'mobile_home', 1000)
    await seedLandlordHeld('AZ', 'mobile_home', 9000)
    const rows = await landlordHeldInterestAdvisory([mine.landlordId])
    expect(rows).toHaveLength(1)
    expect(rows[0].landlordId).toBe(mine.landlordId)
  })
})

// ── S655 (money plan Step 7): INTEREST IS GAM-FUNDED CREDIT ────────────────
//
// Only deposits GAM holds in escrow accrue, so the interest is GAM's money,
// paid to the tenant as account credit. Like every credit it pays a bill by
// itself only when it covers the whole bill (Nic, 10/2). Unlike a credit the
// landlord gives, the rent it pays IS the landlord's income the day it is used,
// and GAM pays the landlord their share with the weekly batch — no fee.
describe('S655 deposit interest is GAM-funded credit', () => {
  async function household(opts: { interestPerMonth: number; rent: number }) {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const { landlordId, userId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId, status: 'active', rentAmount: opts.rent })
      const tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      const sd = await c.query<{ id: string }>(
        `INSERT INTO security_deposits
           (tenant_id, lease_id, unit_id, total_amount, collected_amount,
            status, held_by, portability_status, custody_fee_active)
         VALUES ($1,$2,$3,500,500,'funded','gam_escrow','none',FALSE) RETURNING id`,
        [tenantId, leaseId, unitId])
      for (let i = 0; i < 12; i++) {
        await c.query(
          `INSERT INTO security_deposit_interest_accruals
             (security_deposit_id, lease_id, accrual_month, state_code, effective_year,
              annual_rate_pct, principal_amount, days_held, days_in_month, interest_amount)
           VALUES ($1,$2, (date_trunc('month', CURRENT_DATE) - ($3 || ' months')::interval)::date,
                   'AZ', 2026, 5, 500, 30, 30, $4)`,
          [sd.rows[0].id, leaseId, 12 - i, opts.interestPerMonth])
      }
      const rent = await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'rent',$5,'pending',CURRENT_DATE - 2,'RENT') RETURNING id`,
        [unitId, leaseId, tenantId, landlordId, opts.rent.toFixed(2)])
      await c.query('COMMIT')
      return { landlordId, tenantId, leaseId, rentId: rent.rows[0].id }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('interest is GAM-funded credit: a whole bill it covers is paid, counted as the landlord\'s money, and paid out with no fee', async () => {
    // $40 a month for a year = $480 of interest against a $460 bill.
    const f = await household({ interestPerMonth: 40, rent: 460 })
    const r = await payAnnualDepositInterest()
    expect(r.paid).toBe(1)

    const row = (await db.query<{ status: string; platform_held: boolean; notes: string | null }>(
      `SELECT status, platform_held, notes FROM payments WHERE id = $1`, [f.rentId])).rows[0]
    expect(row.status).toBe('settled')
    expect(row.notes).toMatch(/Paid with account credit/)
    // GAM holds this money for the landlord: the weekly batch pays it.
    expect(row.platform_held).toBe(true)
    const vm = (await db.query<{ issued: number; interest: number; held: number; money: number }>(
      `SELECT issued_credit_amount::float AS issued, deposit_interest_credit::float AS interest,
              gam_held_part::float AS held, money_part::float AS money
         FROM v_payment_money WHERE payment_id = $1`, [f.rentId])).rows[0]
    // Not a credit the landlord gave (that is never income): GAM-funded.
    expect(vm).toEqual({ issued: 0, interest: 460, held: 460, money: 0 })
    const share = await db.query<{ a: string }>(
      `SELECT amount::text AS a FROM user_balance_ledger
        WHERE reference_id = $1 AND reference_type = 'payment' AND type = 'allocation_owner_share'`, [f.rentId])
    expect(Number(share.rows[0].a)).toBe(460)
    // No second processing fee on money that never went through a bank or card.
    const spread = await db.query(
      `SELECT 1 FROM platform_revenue_ledger WHERE reference_id = $1 AND type = 'banking_spread'`, [f.rentId])
    expect(spread.rows).toHaveLength(0)

    const credit = (await db.query<{ remaining: string; category: string }>(
      `SELECT amount_remaining::text AS remaining, category FROM tenant_credits WHERE tenant_id = $1`, [f.tenantId])).rows[0]
    expect(credit.category).toBe('deposit_interest')
    expect(Number(credit.remaining)).toBe(20)
  })

  it('interest smaller than the bill pays nothing by itself and waits for the tenant', async () => {
    const f = await household({ interestPerMonth: 2, rent: 460 })   // $24 against $460
    await payAnnualDepositInterest()
    expect((await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [f.rentId])).rows[0].status).toBe('pending')
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rows).toHaveLength(0)
    const credit = (await db.query<{ remaining: string }>(
      `SELECT amount_remaining::text AS remaining FROM tenant_credits WHERE tenant_id = $1`, [f.tenantId])).rows[0]
    expect(Number(credit.remaining)).toBe(24)
  })

  // Fix round 1: a renewal moves the deposit record onto the new lease, but the
  // months before it accrued under the lease that has since ended. Tied to
  // that lease, the interest could pay only its (finished) bills and would sit
  // on the account forever. It is credited on the lease the deposit is on now.
  it('interest accrued before a renewal pays the renewal\'s bill', async () => {
    const c = await getClient()
    let f: { tenantId: string; oldLeaseId: string; newLeaseId: string; rentId: string }
    try {
      await c.query('BEGIN')
      const { landlordId, userId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const oldLeaseId = await seedLease(c, { unitId, landlordId, status: 'expired', rentAmount: 460, startDate: '2025-01-01' })
      await seedLeaseTenant(c, { leaseId: oldLeaseId, tenantId, role: 'primary' })
      const newLeaseId = await seedLease(c, { unitId, landlordId, status: 'active', rentAmount: 460, startDate: '2026-01-01' })
      await c.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [newLeaseId, oldLeaseId])
      await seedLeaseTenant(c, { leaseId: newLeaseId, tenantId, role: 'primary' })
      // The renewal moved the deposit record onto the new lease.
      const sd = await c.query<{ id: string }>(
        `INSERT INTO security_deposits
           (tenant_id, lease_id, unit_id, total_amount, collected_amount,
            status, held_by, portability_status, custody_fee_active)
         VALUES ($1,$2,$3,500,500,'funded','gam_escrow','none',FALSE) RETURNING id`,
        [tenantId, newLeaseId, unitId])
      // A year of interest: the older months under the lease that ended, the
      // rest under the renewal — $480 in all against a $460 bill.
      for (let i = 0; i < 12; i++) {
        await c.query(
          `INSERT INTO security_deposit_interest_accruals
             (security_deposit_id, lease_id, accrual_month, state_code, effective_year,
              annual_rate_pct, principal_amount, days_held, days_in_month, interest_amount)
           VALUES ($1,$2, (date_trunc('month', CURRENT_DATE) - ($3 || ' months')::interval)::date,
                   'AZ', 2026, 5, 500, 30, 30, 40)`,
          [sd.rows[0].id, i < 8 ? oldLeaseId : newLeaseId, 12 - i])
      }
      const rent = await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'rent',460,'pending',CURRENT_DATE - 2,'RENT') RETURNING id`,
        [unitId, newLeaseId, tenantId, landlordId])
      await c.query('COMMIT')
      f = { tenantId, oldLeaseId, newLeaseId, rentId: rent.rows[0].id }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const r = await payAnnualDepositInterest()
    expect(r.paid).toBe(1)
    // One credit for the whole year, on the lease the household is on.
    const credits = (await db.query<{ lease_id: string; original: string; remaining: string }>(
      `SELECT lease_id, amount_original::text AS original, amount_remaining::text AS remaining
         FROM tenant_credits WHERE tenant_id = $1`, [f.tenantId])).rows
    expect(credits).toEqual([{ lease_id: f.newLeaseId, original: '480.00', remaining: '20.00' }])
    // And it paid the renewal's bill.
    expect((await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [f.rentId])).rows[0].status)
      .toBe('settled')
  })
})
