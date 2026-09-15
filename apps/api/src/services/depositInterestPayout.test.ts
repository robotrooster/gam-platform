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
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
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
    // Categorised, not dumped in "other" — this is a statutory obligation and
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
  it('the tenant credit is categorised so it can be named, not lumped in "other"', async () => {
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
    const year = new Date().getUTCFullYear()
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
