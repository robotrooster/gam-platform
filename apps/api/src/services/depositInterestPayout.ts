/**
 * S642 (Nic): "Calculate interest, have it be paid out as credit where
 * applicable… Realistically, either way, it ends up in the landlord's pocket.
 * Because they just use it to pay rent."
 *
 * Interest has accrued monthly since S604 and was only ever PAID at move-out.
 * Eight states require it paid annually while the tenancy continues — AZ, IL,
 * MA, NJ, NM, OH, PA, RI — so a tenant three years into a lease in any of them
 * is owed money the platform calculated and never handed over.
 *
 * ONE RULE. Every state requires payment at termination; eight additionally
 * require it annually. Paying annually in a termination-only state is not a
 * violation — the tenant gets their money sooner and GAM holds the principal
 * either way. So this pays annually wherever anything is owed, rather than
 * modelling thirteen cadences and getting one wrong.
 *
 * AS A CREDIT, not cash: it lands on the tenant's balance and comes off their
 * next bill automatically. Cash would mean opening a payout rail to a tenant
 * GAM may have no account for, to hand them money they are about to hand back
 * as rent.
 */
import { getClient, query } from '../db'
import { logger } from '../lib/logger'

export interface PayoutResult {
  scanned: number
  paid: number
  skipped: number
  totalCredited: number
  errors: number
}

/** Below this the credit costs more to explain than it is worth. */
const MIN_CREDIT = 0.01

/**
 * Pay every deposit whose oldest unpaid accrual is at least a year old.
 *
 * Anniversary-driven rather than calendar-driven: the statutes that name a
 * cadence say "after each 12 month rental period" (IL) or "on the lease
 * anniversary" (PA), not January. Running on the tenancy's own clock also
 * spreads the work across the year instead of piling every tenant onto one day.
 *
 * @param asOf test seam; defaults to now
 */
export async function payAnnualDepositInterest(asOf?: Date): Promise<PayoutResult> {
  const out: PayoutResult = { scanned: 0, paid: 0, skipped: 0, totalCredited: 0, errors: 0 }
  const now = asOf ?? new Date()

  // One row per deposit that has a full year of unpaid accruals behind it.
  // Deposits already returned are excluded: their interest went out with the
  // deposit through depositReturn, and paying again would double-pay.
  const due = await query<{
    security_deposit_id: string
    lease_id: string
    tenant_id: string
    landlord_id: string
    owed: string
    months: string
    oldest: string
  }>(
    `SELECT a.security_deposit_id,
            a.lease_id,
            sd.tenant_id,
            l.landlord_id,
            SUM(a.interest_amount)::text AS owed,
            COUNT(*)::text               AS months,
            MIN(a.accrual_month)::text   AS oldest
       FROM security_deposit_interest_accruals a
       JOIN security_deposits sd ON sd.id = a.security_deposit_id
       JOIN leases l             ON l.id = a.lease_id
      WHERE a.paid_at IS NULL
        AND a.interest_amount > 0
        AND sd.disbursed_at IS NULL
      GROUP BY a.security_deposit_id, a.lease_id, sd.tenant_id, l.landlord_id
     HAVING MIN(a.accrual_month) <= ($1::date - INTERVAL '12 months')
        AND SUM(a.interest_amount) >= $2`,
    [now.toISOString().slice(0, 10), MIN_CREDIT])

  out.scanned = due.length

  for (const d of due) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Re-read the accrual ids INSIDE the transaction and lock them. Without
      // this, two overlapping runs would each see the same unpaid months and
      // each issue a credit for them — the one failure that costs real money
      // and leaves a ledger that looks correct.
      const rows = await client.query<{ id: string; interest_amount: string }>(
        `SELECT id, interest_amount::text
           FROM security_deposit_interest_accruals
          WHERE security_deposit_id = $1 AND paid_at IS NULL AND interest_amount > 0
          FOR UPDATE`,
        [d.security_deposit_id])

      const amount = Math.round(
        rows.rows.reduce((s, r) => s + parseFloat(r.interest_amount), 0) * 100) / 100

      if (amount < MIN_CREDIT) {
        await client.query('ROLLBACK')
        out.skipped++
        continue
      }

      const credit = await client.query<{ id: string }>(
        `INSERT INTO tenant_credits
           (landlord_id, tenant_id, lease_id, amount_original, amount_remaining,
            category, reason, status)
         VALUES ($1,$2,$3,$4,$4,'deposit_interest',$5,'active')
         RETURNING id`,
        [d.landlord_id, d.tenant_id, d.lease_id, amount,
         `Statutory interest on your security deposit — ${rows.rows.length} month(s) through ${d.oldest}`])

      await client.query(
        `UPDATE security_deposit_interest_accruals
            SET paid_at = NOW(), paid_credit_id = $2
          WHERE id = ANY($1::uuid[])`,
        [rows.rows.map(r => r.id), credit.rows[0].id])

      await client.query('COMMIT')
      out.paid++
      out.totalCredited = Math.round((out.totalCredited + amount) * 100) / 100
      logger.info({ security_deposit_id: d.security_deposit_id, amount, months: rows.rows.length },
        '[deposit-interest] credited statutory interest to the tenant')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      out.errors++
      // One tenant's failure must not stop the rest of the sweep. The accruals
      // stay unpaid and the next run picks them up.
      logger.error({ err: e, security_deposit_id: d.security_deposit_id },
        '[deposit-interest] could not credit — will retry next run')
    } finally {
      client.release()
    }
  }

  logger.info(out, '[deposit-interest] annual payout sweep')
  return out
}

/**
 * What a landlord/admin screen needs: who is owed, how much, how overdue.
 * Read-only — the sweep is the only thing that pays.
 */
export async function outstandingDepositInterest(landlordIds?: string[] | null) {
  return query<any>(
    `SELECT l.landlord_id,
            p.name  AS property_name,
            u.unit_number,
            TRIM(CONCAT_WS(' ', tu.first_name, tu.last_name)) AS tenant_name,
            a.state_code,
            SUM(a.interest_amount)::float AS owed,
            COUNT(*)::int                 AS months_unpaid,
            MIN(a.accrual_month)::text    AS oldest_unpaid
       FROM security_deposit_interest_accruals a
       JOIN security_deposits sd ON sd.id = a.security_deposit_id
       JOIN leases l  ON l.id = a.lease_id
       JOIN units u   ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN tenants t ON t.id = sd.tenant_id
       JOIN users tu  ON tu.id = t.user_id
      WHERE a.paid_at IS NULL
        AND a.interest_amount > 0
        AND sd.disbursed_at IS NULL
        AND ($1::uuid[] IS NULL OR l.landlord_id = ANY($1::uuid[]))
      GROUP BY l.landlord_id, p.name, u.unit_number, tenant_name, a.state_code
      ORDER BY owed DESC`,
    [landlordIds ?? null])
}

// ── S642: DEPOSITS THE LANDLORD HOLDS ───────────────────────────────────────
//
// Nic: "We're only paying interest on the deposit when we hold it, right?
// Otherwise, it's just a flag for the landlord. Hey, your tenant is owed this
// much interest. Recommend adding a credit to their bill."
//
// Right on both counts. Accrual is scoped to held_by = 'gam_escrow' — GAM does
// not pay out of its own pocket on money it never touched. But until now the
// landlord got NOTHING either: no accrual, no flag, no warning that their
// state owes their tenant money. Twenty-one states are custody-BLOCKED, so the
// landlord necessarily holds the deposit there — including Illinois, whose
// penalty for willful non-payment is the deposit amount again plus costs and
// attorney fees.
//
// ADVISORY, AND COMPUTED ON READ — never written as an accrual row. An accrual
// row is a payable: the nightly sweep would find it and GAM would credit the
// tenant out of its own funds for a deposit sitting in the landlord's bank.
// That is the one mistake this whole area cannot afford, so the estimate has no
// path to becoming a payment.
//
// It is an ESTIMATE and says so. GAM cannot know what the landlord has already
// paid the tenant directly, so this is interest accrued since the deposit was
// funded, not a balance due. The landlord judges it against their own records.
export interface LandlordHeldAdvisory {
  landlordId:    string
  propertyName:  string
  unitNumber:    string
  tenantName:    string
  tenantId:      string
  leaseId:       string
  stateCode:     string
  principal:     number
  ratePct:       number
  rateBasis:     string | null
  citation:      string | null
  daysHeld:      number
  estimated:     number
}

export async function landlordHeldInterestAdvisory(
  landlordIds?: string[] | null,
): Promise<LandlordHeldAdvisory[]> {
  const rows = await query<any>(
    `SELECT sd.id, sd.collected_amount::float AS principal, sd.tenant_id, sd.lease_id,
            l.landlord_id, p.state AS state_code, p.name AS property_name,
            u.unit_number, u.unit_type, u.rent_amount::float AS monthly_rent,
            TRIM(CONCAT_WS(' ', tu.first_name, tu.last_name)) AS tenant_name,
            -- Same definition of "funded" the accrual engine uses, so the
            -- advisory and the real thing cannot disagree about when the clock
            -- started: the first settled DEPOSIT payment on the lease, falling
            -- back to when the row was created.
            GREATEST(0, EXTRACT(DAY FROM (NOW() - COALESCE(
              (SELECT MIN(pmt.due_date::timestamp)
                 FROM payments pmt
                WHERE pmt.entry_description = 'DEPOSIT'
                  AND pmt.lease_id = sd.lease_id
                  AND pmt.status = 'settled'),
              sd.created_at)))::int) AS days_held
       FROM security_deposits sd
       JOIN leases l     ON l.id = sd.lease_id
       JOIN units u      ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN tenants t    ON t.id = sd.tenant_id
       JOIN users tu     ON tu.id = t.user_id
      WHERE sd.held_by <> 'gam_escrow'
        AND sd.status IN ('funded','partial','claimed')
        AND sd.collected_amount > 0
        AND sd.disbursed_at IS NULL
        AND ($1::uuid[] IS NULL OR l.landlord_id = ANY($1::uuid[]))`,
    // NOT swallowed. An error here would render as "no interest owed", which
    // is precisely the wrong thing to tell a landlord who is accruing an
    // obligation. Let it surface.
    [landlordIds ?? null])

  const out: LandlordHeldAdvisory[] = []
  const year = new Date().getUTCFullYear()
  for (const r of rows) {
    try {
      const { resolveRateForLandlord, principalSubjectToInterest } = await import('./depositInterest')
      const rate = await resolveRateForLandlord(r.landlord_id, r.state_code, year, r.unit_type)
      // No rule, or a rule that owes nothing — nothing to tell them about.
      if (!rate || Number(rate.annual_rate_pct) <= 0) continue
      const base = principalSubjectToInterest(rate, r.principal, r.monthly_rent ?? null)
      if (base <= 0) continue
      const estimated = Math.round(
        base * (Number(rate.annual_rate_pct) / 100) * (r.days_held / 365) * 100) / 100
      if (estimated < 0.01) continue
      out.push({
        landlordId:   r.landlord_id,
        propertyName: r.property_name,
        unitNumber:   r.unit_number,
        tenantName:   r.tenant_name,
        tenantId:     r.tenant_id,
        leaseId:      r.lease_id,
        stateCode:    r.state_code,
        principal:    r.principal,
        ratePct:      Number(rate.annual_rate_pct),
        rateBasis:    rate.rate_basis ?? null,
        citation:     (rate as any).statute_citation ?? null,
        daysHeld:     r.days_held,
        estimated,
      })
    } catch (e) {
      logger.error({ err: e, deposit: r.id }, '[deposit-interest] advisory failed for one deposit')
    }
  }
  return out.sort((a, b) => b.estimated - a.estimated)
}
