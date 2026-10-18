/**
 * S565: nexus monitor + screening-tax gate.
 *
 * Covers the load-bearing money/compliance logic:
 *   - screeningIntakeFee(state): tax collected ONLY when a state is both
 *     taxable AND registered (the two-layer gate). $0 otherwise.
 *   - getNexusDashboard: crossed / approaching / under / registered / no_threshold
 *     status logic, honoring count_rule (or / and / revenue_only).
 *   - recomputeNexusTally: aggregates GAM own-revenue by customer state.
 *   - setStateRegistration: flips the collection gate.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import {
  recomputeNexusTally,
  getNexusDashboard,
  setStateRegistration,
  setStateMeasureRule,
} from './nexusMonitor'
import { screeningIntakeFee } from '../routes/background'

const YEAR = 2026

async function clearCatalog() {
  await db.query('DELETE FROM nexus_revenue_tally')
  await db.query('DELETE FROM state_tax_registrations')
  await db.query('DELETE FROM state_screening_tax_rates')
  await db.query('DELETE FROM state_nexus_thresholds')
  await db.query('DELETE FROM state_nexus_measure_rules')
  await db.query('DELETE FROM platform_fee_accruals')
}

/** A landlord with one property in `state`. */
async function seedPropertyIn(state: string) {
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','landlord','T','L',TRUE) RETURNING id`,
    [`ll-${randomUUID()}@test.dev`]
  )).rows[0].id
  const landlordId = (await db.query<{ id: string }>(
    `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [userId]
  )).rows[0].id
  const propertyId = (await db.query<{ id: string }>(
    `INSERT INTO properties (landlord_id, name, street1, city, state, zip, owner_user_id, managed_by_user_id)
     VALUES ($1,'P','1 St','Town',$2,'75001',$3,$3) RETURNING id`,
    [landlordId, state, userId]
  )).rows[0].id
  return { userId, landlordId, propertyId }
}

/** One line on GAM's revenue book, dated inside YEAR by Phoenix's clock. */
async function bookRow(opts: {
  type: string
  amount: number
  referenceId?: string | null
  referenceType?: string | null
  propertyId?: string | null
  year?: number
}) {
  await db.query(
    `INSERT INTO platform_revenue_ledger
       (type, amount, balance_after, reference_id, reference_type, property_id, created_at)
     VALUES ($1,$2,$2,$3,$4,$5, make_timestamptz($6, 6, 15, 12, 0, 0, 'America/Phoenix'))`,
    [opts.type, opts.amount, opts.referenceId ?? null, opts.referenceType ?? null,
     opts.propertyId ?? null, opts.year ?? YEAR]
  )
}

/** A screening on an applicant who lives in `state`. */
async function seedBackgroundCheck(landlordId: string, userId: string, state: string) {
  return (await db.query<{ id: string }>(
    `INSERT INTO background_checks (landlord_id, user_id, state, status)
     VALUES ($1,$2,$3,'complete') RETURNING id`,
    [landlordId, userId, state]
  )).rows[0].id
}

/**
 * A screening with NO applicant address — the shape every screening on
 * production actually has, since intake asks only for a name.
 */
async function seedBackgroundCheckNoAddress(landlordId: string, userId: string, propertyId: string) {
  return (await db.query<{ id: string }>(
    `INSERT INTO background_checks (landlord_id, user_id, property_id, status)
     VALUES ($1,$2,$3,'complete') RETURNING id`,
    [landlordId, userId, propertyId]
  )).rows[0].id
}

async function tallyRow(state: string, year = YEAR) {
  return (await db.query<any>(
    `SELECT * FROM nexus_revenue_tally WHERE state_code=$1 AND period_year=$2`, [state, year]
  )).rows[0]
}

async function seedTaxRow(state: string, taxable: boolean, rate: number, basis = 'screening') {
  await db.query(
    `INSERT INTO state_screening_tax_rates (state_code, effective_year, taxable, rate_pct, basis, status)
     VALUES ($1,$2,$3,$4,$5,'research')`,
    [state, YEAR, taxable, rate, basis]
  )
}

async function seedThreshold(state: string, revenue: number | null, txn: number | null, rule: string) {
  await db.query(
    `INSERT INTO state_nexus_thresholds (state_code, effective_year, revenue_threshold_usd, txn_threshold, count_rule, status)
     VALUES ($1,$2,$3,$4,$5,'research')`,
    [state, YEAR, revenue, txn, rule]
  )
}

async function seedTally(state: string, year: number, revenue: number, txn = 1) {
  await db.query(
    `INSERT INTO nexus_revenue_tally (state_code, period_year, revenue_usd, txn_count)
     VALUES ($1,$2,$3,$4)`,
    [state, year, revenue, txn]
  )
}

beforeEach(async () => {
  await cleanupAllSchema()
  await clearCatalog()
})

describe('screening tax gate (screeningIntakeFee)', () => {
  it('collects $0 in a taxable state that is NOT registered', async () => {
    await seedTaxRow('TX', true, 6.25)
    const fee = await screeningIntakeFee('TX')
    expect(fee.tax).toBe(0)
  })

  it('collects tax in a taxable state once registered — base is the screening line only', async () => {
    await seedTaxRow('TX', true, 6.25)
    await setStateRegistration('TX', true)
    const fee = await screeningIntakeFee('TX')
    // screening $37.94 × 6.25% = 2.37125 → 2.37 (gamFee margin NOT in base)
    expect(fee.tax).toBe(2.37)
    expect(fee.total).toBeGreaterThan(fee.screening + fee.gamFee + fee.processing)
  })

  it('collects $0 in a registered but NON-taxable state', async () => {
    await seedTaxRow('UT', false, 0)
    await setStateRegistration('UT', true)
    const fee = await screeningIntakeFee('UT')
    expect(fee.tax).toBe(0)
  })

  it('collects $0 when no applicant state is given', async () => {
    await seedTaxRow('TX', true, 6.25)
    await setStateRegistration('TX', true)
    const fee = await screeningIntakeFee(null)
    expect(fee.tax).toBe(0)
  })

  it('honors basis=screening_plus_gamfee (taxes screening + margin)', async () => {
    await seedTaxRow('TX', true, 10, 'screening_plus_gamfee')
    await setStateRegistration('TX', true)
    const fee = await screeningIntakeFee('TX')
    // (37.94 + 5) × 10% = 4.294 → 4.29
    expect(fee.tax).toBe(4.29)
  })
})

describe('nexus dashboard status logic', () => {
  it('flags crossed / approaching / under and computes summary', async () => {
    await seedThreshold('TX', 500000, null, 'revenue_only')
    await seedThreshold('CA', 500000, null, 'revenue_only')
    await seedThreshold('AZ', 100000, null, 'revenue_only')
    await seedThreshold('NM', 100000, null, 'revenue_only')
    await seedTally('TX', YEAR, 600000)   // ≥ 500k → crossed
    await seedTally('CA', YEAR, 450000)   // 90% of 500k → approaching
    await seedTally('AZ', YEAR, 85000)    // 85% of 100k → approaching
    await seedTally('NM', YEAR, 40000)    // 40% → under

    const d = await getNexusDashboard(YEAR)
    const by = (s: string) => d.states.find((x) => x.stateCode === s)!
    expect(by('TX').status).toBe('crossed')
    expect(by('CA').status).toBe('approaching')
    expect(by('AZ').status).toBe('approaching')
    expect(by('NM').status).toBe('under')
    expect(d.summary.crossed).toBe(1)
    expect(d.summary.approaching).toBe(2)
  })

  it('registered wins over crossed (collection already live)', async () => {
    await seedThreshold('TX', 500000, null, 'revenue_only')
    await seedTally('TX', YEAR, 600000)
    await setStateRegistration('TX', true)
    const d = await getNexusDashboard(YEAR)
    expect(d.states.find((x) => x.stateCode === 'TX')!.status).toBe('registered')
    expect(d.summary.registered).toBe(1)
    expect(d.summary.crossed).toBe(0)
  })

  // S654: registered_date is a DATE; node-pg handed back a Date whose
  // slice(0, 10) read 'Wed Sep 30', not '2026-09-30'.
  it('registeredDate comes back as the stored calendar day', async () => {
    await seedThreshold('TX', 500000, null, 'revenue_only')
    await db.query(
      `INSERT INTO state_tax_registrations (state_code, registered, registered_date)
       VALUES ('TX', TRUE, DATE '2026-09-30')`)
    const d = await getNexusDashboard(YEAR)
    expect(d.states.find((x) => x.stateCode === 'TX')!.registeredDate).toBe('2026-09-30')
  })

  it('count_rule=and requires BOTH revenue and txn over threshold', async () => {
    await seedThreshold('NY', 500000, 100, 'and')
    await seedTally('NY', YEAR, 600000, 50)  // revenue over, txn under → NOT crossed
    const d = await getNexusDashboard(YEAR)
    expect(d.states.find((x) => x.stateCode === 'NY')!.status).not.toBe('crossed')
  })

  it('no_threshold for no-sales-tax states', async () => {
    await seedThreshold('OR', null, null, 'revenue_only')
    const d = await getNexusDashboard(YEAR)
    expect(d.states.find((x) => x.stateCode === 'OR')!.status).toBe('no_threshold')
  })

  it('uses max(current YTD, prior year) as the conservative measure', async () => {
    await seedThreshold('AZ', 100000, null, 'revenue_only')
    await seedTally('AZ', YEAR, 40000)       // current small
    await seedTally('AZ', YEAR - 1, 120000)  // prior year over threshold
    const d = await getNexusDashboard(YEAR)
    const az = d.states.find((x) => x.stateCode === 'AZ')!
    expect(az.measureUsd).toBe(120000)
    expect(az.status).toBe('crossed')
  })
})

// ── 10/17 (Nic): THE TALLY READS GAM'S REVENUE BOOK ──────────────────────
//
// "The sales tax nexus on the admin platform is not accurately reading... it
// would need to take into account any margins that GAM makes on card payments
// or ACH payments." The tally used to sum four subscription-shaped accrual
// tables and leave the processing margin out, so every state read low by the
// whole card and bank margin. These cover what each line item now picks up and
// where it is measured.
describe('recomputeNexusTally reads the revenue book', () => {
  it('puts the platform subscription in the subscription line, at the property state', async () => {
    const { propertyId } = await seedPropertyIn('TX')
    await bookRow({ type: 'platform_fee_subscription', amount: 250, propertyId,
      referenceId: randomUUID(), referenceType: 'platform_fee_accrual' })

    const res = await recomputeNexusTally(YEAR)
    expect(res.rows).toBeGreaterThanOrEqual(1)
    const row = await tallyRow('TX')
    expect(row).toBeTruthy()
    expect(parseFloat(row.subscription_usd)).toBe(250)
    expect(parseFloat(row.revenue_usd)).toBe(250)
    expect(row.txn_count).toBe(1)
  })

  it('counts the card/bank margin at the property state — the figure that was missing', async () => {
    const { propertyId } = await seedPropertyIn('TX')
    await bookRow({ type: 'platform_fee_subscription', amount: 250, propertyId,
      referenceId: randomUUID(), referenceType: 'platform_fee_accrual' })
    await bookRow({ type: 'banking_spread', amount: 15.87, propertyId,
      referenceId: randomUUID(), referenceType: 'payment' })
    await bookRow({ type: 'banking_spread', amount: 3.5, propertyId,
      referenceId: randomUUID(), referenceType: 'pos_transaction' })

    await recomputeNexusTally(YEAR)
    const row = await tallyRow('TX')
    expect(parseFloat(row.markup_usd)).toBe(19.37)
    expect(parseFloat(row.revenue_usd)).toBe(269.37)
    expect(row.txn_count).toBe(3)
  })

  it('measures a screening where the applicant lives, and counts it as ONE transaction', async () => {
    const { landlordId, userId } = await seedPropertyIn('TX')
    const bcId = await seedBackgroundCheck(landlordId, userId, 'NV')
    // One screening charge writes two book lines: GAM's screening margin and
    // the card markup on the same charge. That is one sale.
    await bookRow({ type: 'screening_margin', amount: 5, referenceId: bcId, referenceType: 'background_check' })
    await bookRow({ type: 'banking_spread', amount: 2.45, referenceId: bcId, referenceType: 'background_check' })

    await recomputeNexusTally(YEAR)
    const nv = await tallyRow('NV')
    expect(parseFloat(nv.screening_usd)).toBe(5)
    expect(parseFloat(nv.markup_usd)).toBe(2.45)
    expect(parseFloat(nv.revenue_usd)).toBe(7.45)
    expect(nv.txn_count).toBe(1)
    // Nothing leaked into the landlord's state.
    expect(await tallyRow('TX')).toBeUndefined()
  })

  it('puts FlexPay in the customer opt-in line and card-reader markup in other', async () => {
    const { propertyId } = await seedPropertyIn('AZ')
    await bookRow({ type: 'flexpay_subscription', amount: 25, propertyId,
      referenceId: randomUUID(), referenceType: 'flexpay_advance' })
    await bookRow({ type: 'device_markup', amount: 12.5, propertyId,
      referenceId: randomUUID(), referenceType: 'reader_order_installment' })

    await recomputeNexusTally(YEAR)
    const az = await tallyRow('AZ')
    expect(parseFloat(az.optin_usd)).toBe(25)
    expect(parseFloat(az.other_usd)).toBe(12.5)
    expect(parseFloat(az.revenue_usd)).toBe(37.5)
  })

  it('counts the business portal monthly fee in the subscription line, at the business state', async () => {
    const ownerId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','landlord','B','O',TRUE) RETURNING id`, [`biz-${randomUUID()}@test.dev`]
    )).rows[0].id
    const bizId = (await db.query<{ id: string }>(
      `INSERT INTO businesses (owner_user_id, name, business_type, email, state)
       VALUES ($1,'Hauler','trash_hauling',$2,'NM') RETURNING id`,
      [ownerId, `biz-${randomUUID()}@test.dev`]
    )).rows[0].id
    await db.query(
      `INSERT INTO business_platform_fee_accruals (business_id, month, amount, status)
       VALUES ($1, $2, 10.00, 'pending')`, [bizId, `${YEAR}-06`])
    // A waived fee is no receipt.
    await db.query(
      `INSERT INTO business_platform_fee_accruals (business_id, month, amount, status)
       VALUES ($1, $2, 10.00, 'waived')`, [bizId, `${YEAR}-07`])

    await recomputeNexusTally(YEAR)
    const nm = await tallyRow('NM')
    expect(parseFloat(nm.subscription_usd)).toBe(10)
    expect(nm.txn_count).toBe(1)
  })

  it('leaves money no single state owns out of the states, and reports it', async () => {
    const { propertyId } = await seedPropertyIn('TX')
    await bookRow({ type: 'banking_spread', amount: 20, propertyId,
      referenceId: randomUUID(), referenceType: 'payment' })
    // The monthly processing true-up corrects every state at once.
    await bookRow({ type: 'adjustment', amount: -6.5, referenceType: 'processing_margin_true_up' })

    await recomputeNexusTally(YEAR)
    expect(parseFloat((await tallyRow('TX')).markup_usd)).toBe(20)

    await seedThreshold('TX', 100000, null, 'revenue_only')
    const d = await getNexusDashboard(YEAR)
    expect(d.unattributed.currentYtd).toBe(-6.5)
    const markup = d.unattributed.lineItems.find((li) => li.key === 'markup')!
    expect(markup.currentYtd).toBe(-6.5)
  })

  it('measures a household payment at its lease property, and a fee pull at the landlord state', async () => {
    const { landlordId, userId, propertyId } = await seedPropertyIn('UT')
    const unitId = (await db.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount)
       VALUES ($1,$2,$3,900) RETURNING id`,
      [propertyId, landlordId, `U-${randomUUID().slice(0, 6)}`]
    )).rows[0].id
    const tenantUser = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','T','T',TRUE) RETURNING id`, [`tn-${randomUUID()}@test.dev`]
    )).rows[0].id
    const tenantId = (await db.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [tenantUser]
    )).rows[0].id
    const leaseId = (await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, start_date, rent_amount, lease_type)
       VALUES ($1,$2,'2026-01-01',900,'month_to_month') RETURNING id`, [unitId, landlordId]
    )).rows[0].id
    // A charge that paid no single rent row books its markup against the
    // household's receipt instead of a property.
    const remId = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status)
       VALUES ($1,$2,$3,900,900,'settled') RETURNING id`, [tenantId, leaseId, landlordId]
    )).rows[0].id
    await bookRow({ type: 'banking_spread', amount: 4.25, referenceId: remId, referenceType: 'tenant_remittance' })
    // GAM pulling its own fees from this landlord's bank.
    const pullId = (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, total_amount)
       VALUES ($1, 100, 106) RETURNING id`, [landlordId]
    )).rows[0].id
    await bookRow({ type: 'banking_spread', amount: 6, referenceId: pullId, referenceType: 'gam_bank_debit' })

    await recomputeNexusTally(YEAR)
    const ut = await tallyRow('UT')
    expect(parseFloat(ut.markup_usd)).toBe(10.25)
    expect(ut.txn_count).toBe(2)
    expect(parseFloat(ut.revenue_usd)).toBe(10.25)
  })

  // A nexus threshold measures what GAM took IN. GAM buying card readers is
  // money OUT, booked negative — counting it pulled Arizona's measure DOWN by
  // the price of the readers, the opposite of "count high".
  it('never lets card readers GAM bought pull a state down; the cost repaid and the markup still count', async () => {
    const { propertyId } = await seedPropertyIn('AZ')
    const orderId = randomUUID()
    await bookRow({ type: 'adjustment', amount: -331.73, propertyId,
      referenceId: orderId, referenceType: 'reader_purchase' })
    // Money IN from a customer in Arizona: the landlord repaying that cost,
    // and GAM's markup on the device.
    await bookRow({ type: 'adjustment', amount: 87.5, propertyId,
      referenceId: orderId, referenceType: 'reader_cost_repaid' })
    await bookRow({ type: 'device_markup', amount: 18.27, propertyId,
      referenceId: randomUUID(), referenceType: 'reader_order_installment' })

    await recomputeNexusTally(YEAR)
    const az = await tallyRow('AZ')
    expect(parseFloat(az.other_usd)).toBe(105.77)
    expect(parseFloat(az.revenue_usd)).toBe(105.77)

    // Held out of the state, not dropped: the page still reconciles to the book.
    await seedThreshold('AZ', 100000, null, 'revenue_only')
    const d = await getNexusDashboard(YEAR)
    expect(d.states.find((s) => s.stateCode === 'AZ')!.measureUsd).toBe(105.77)
    expect(d.nonReceipt.currentYtd).toBe(-331.73)
    expect(d.nonReceipt.items.find((i) => i.key === 'reader_purchase')!.currentYtd).toBe(-331.73)
    // And it never shows up as unplaced earnings either.
    expect(d.unattributed.currentYtd).toBe(0)
  })

  it('measures a screening at the property it was ordered for when no applicant address was collected', async () => {
    const { landlordId, userId, propertyId } = await seedPropertyIn('TX')
    const bcId = await seedBackgroundCheckNoAddress(landlordId, userId, propertyId)
    await bookRow({ type: 'screening_margin', amount: 5, referenceId: bcId, referenceType: 'background_check' })
    await bookRow({ type: 'banking_spread', amount: 0.49, referenceId: bcId, referenceType: 'background_check' })

    await recomputeNexusTally(YEAR)
    const tx = await tallyRow('TX')
    expect(parseFloat(tx.screening_usd)).toBe(5)
    expect(parseFloat(tx.markup_usd)).toBe(0.49)
    expect(tx.txn_count).toBe(1)
    // Nothing left over: the screening line no longer reads $0 in every state.
    await seedThreshold('TX', 100000, null, 'revenue_only')
    const d = await getNexusDashboard(YEAR)
    expect(d.unattributed.currentYtd).toBe(0)
  })

  it('counts the business portal fee once — and keeps its state — if it also reaches the book', async () => {
    const ownerId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','landlord','B','O',TRUE) RETURNING id`, [`biz-${randomUUID()}@test.dev`]
    )).rows[0].id
    const bizId = (await db.query<{ id: string }>(
      `INSERT INTO businesses (owner_user_id, name, business_type, email, state)
       VALUES ($1,'Hauler','trash_hauling',$2,'NM') RETURNING id`,
      [ownerId, `biz-${randomUUID()}@test.dev`]
    )).rows[0].id
    const accrualId = (await db.query<{ id: string }>(
      `INSERT INTO business_platform_fee_accruals (business_id, month, amount, status)
       VALUES ($1, $2, 10.00, 'pending') RETURNING id`, [bizId, `${YEAR}-06`]
    )).rows[0].id

    await recomputeNexusTally(YEAR)
    expect(parseFloat((await tallyRow('NM')).subscription_usd)).toBe(10)

    // The day the job that bills businesses starts posting the fee to GAM's
    // own book: still $10 in New Mexico, not $20, and not adrift with no state.
    await bookRow({ type: 'platform_fee_subscription', amount: 10,
      referenceId: accrualId, referenceType: 'business_platform_fee_accrual' })
    await recomputeNexusTally(YEAR)
    const nm = await tallyRow('NM')
    expect(parseFloat(nm.subscription_usd)).toBe(10)
    expect(nm.txn_count).toBe(1)
    const d = await getNexusDashboard(YEAR)
    expect(d.unattributed.currentYtd).toBe(0)
  })

  // The page reads this table directly, so a rebuild that is half-applied
  // reads every state at $0 — a crossed state showing "Under" on the one page
  // whose job is to say when to register.
  it('leaves the previous numbers standing when a rebuild fails part way', async () => {
    await seedTally('TX', YEAR, 500000, 7)
    const { propertyId } = await seedPropertyIn('ZZ')
    await bookRow({ type: 'banking_spread', amount: 42, propertyId,
      referenceId: randomUUID(), referenceType: 'payment' })

    await db.query(`ALTER TABLE nexus_revenue_tally ADD CONSTRAINT tmp_reject_zz CHECK (state_code <> 'ZZ')`)
    try {
      await expect(recomputeNexusTally(YEAR)).rejects.toThrow()
      const tx = await tallyRow('TX')
      expect(tx).toBeTruthy()
      expect(parseFloat(tx.revenue_usd)).toBe(500000)
      expect(tx.txn_count).toBe(7)
    } finally {
      await db.query(`ALTER TABLE nexus_revenue_tally DROP CONSTRAINT tmp_reject_zz`)
    }
  })

  it('a correction moves dollars but is never a new transaction', async () => {
    const { landlordId, userId } = await seedPropertyIn('TX')
    const bcId = await seedBackgroundCheck(landlordId, userId, 'NV')
    await bookRow({ type: 'screening_margin', amount: 5, referenceId: bcId, referenceType: 'background_check' })
    await bookRow({ type: 'adjustment', amount: -5, referenceId: bcId, referenceType: 'screening_margin_reversal' })

    await recomputeNexusTally(YEAR)
    const nv = await tallyRow('NV')
    expect(parseFloat(nv.screening_usd)).toBe(0)
    expect(nv.txn_count).toBe(1)
  })
})

// ── 10/17 (Nic): "if that state's not counting some of those, where are we
// really at? I'd rather count high and register with those states early."
describe('per-state measurement rule', () => {
  it('seeds to count everything, and the combined total still drives crossing', async () => {
    const { propertyId } = await seedPropertyIn('TX')
    await seedThreshold('TX', 100, null, 'revenue_only')
    await bookRow({ type: 'platform_fee_subscription', amount: 60, propertyId,
      referenceId: randomUUID(), referenceType: 'platform_fee_accrual' })
    await bookRow({ type: 'banking_spread', amount: 50, propertyId,
      referenceId: randomUUID(), referenceType: 'payment' })
    await recomputeNexusTally(YEAR)

    const d = await getNexusDashboard(YEAR)
    const tx = d.states.find((s) => s.stateCode === 'TX')!
    expect(tx.measureUsd).toBe(110)
    expect(tx.countedMeasureUsd).toBe(110)
    expect(tx.measureRule.countsEverything).toBe(true)
    expect(tx.status).toBe('crossed')
    expect(tx.breakdownReady).toBe(true)
  })

  it('a state that excludes the markup shows the smaller subtotal — but still reads crossed', async () => {
    const { propertyId } = await seedPropertyIn('TX')
    await seedThreshold('TX', 100, null, 'revenue_only')
    await bookRow({ type: 'platform_fee_subscription', amount: 60, propertyId,
      referenceId: randomUUID(), referenceType: 'platform_fee_accrual' })
    await bookRow({ type: 'banking_spread', amount: 50, propertyId,
      referenceId: randomUUID(), referenceType: 'payment' })
    await recomputeNexusTally(YEAR)
    await setStateMeasureRule('TX', { markup: false }, { year: YEAR })

    const d = await getNexusDashboard(YEAR)
    const tx = d.states.find((s) => s.stateCode === 'TX')!
    expect(tx.measureUsd).toBe(110)
    expect(tx.countedMeasureUsd).toBe(60)
    expect(tx.countedPctOfThreshold).toBeCloseTo(0.6, 5)
    expect(tx.measureRule.countsMarkup).toBe(false)
    expect(tx.measureRule.countsScreening).toBe(true)
    expect(tx.measureRule.countsEverything).toBe(false)
    // Count high: the combined total is what registers a state.
    expect(tx.status).toBe('crossed')
    expect(tx.lineItems.find((li) => li.key === 'markup')!.counted).toBe(false)
  })

  // The page reads a state's rule at the newest catalog year that has STARTED,
  // so the tick box has to save at the same year. Saving at the wall-clock year
  // meant that from the first January past the catalog's newest year, every
  // save landed on a row the page never reads — toast says saved, box snaps
  // back, no error anywhere.
  it('saves a rule at the catalog year the page reads, not the wall-clock year', async () => {
    await db.query(
      `INSERT INTO state_nexus_thresholds (state_code, effective_year, revenue_threshold_usd, txn_threshold, count_rule, status)
       VALUES ('TX',$1,100000,NULL,'revenue_only','research')`, [YEAR - 1])
    // No year passed — exactly how the admin route calls it.
    await setStateMeasureRule('TX', { markup: false })

    const rows = (await db.query<any>(
      `SELECT effective_year, counts_markup FROM state_nexus_measure_rules WHERE state_code='TX'`
    )).rows
    expect(rows.length).toBe(1)
    expect(rows[0].effective_year).toBe(YEAR - 1)
    // And the page actually sees it.
    const d = await getNexusDashboard(YEAR)
    expect(d.states.find((s) => s.stateCode === 'TX')!.measureRule.countsMarkup).toBe(false)
  })

  it('only the line items named in the change move', async () => {
    await setStateMeasureRule('TX', { markup: false, optin: false }, { year: YEAR })
    await setStateMeasureRule('TX', { markup: true }, { year: YEAR })
    const r = (await db.query<any>(
      `SELECT * FROM state_nexus_measure_rules WHERE state_code='TX' AND effective_year=$1`, [YEAR]
    )).rows[0]
    expect(r.counts_markup).toBe(true)
    expect(r.counts_optin).toBe(false)
    expect(r.counts_screening).toBe(true)
  })
})

describe('nexus dashboard coverage', () => {
  it('shows a state GAM earns in even when its threshold has not been researched', async () => {
    const { propertyId } = await seedPropertyIn('PR')
    await seedThreshold('TX', 100000, null, 'revenue_only')
    await bookRow({ type: 'banking_spread', amount: 40, propertyId,
      referenceId: randomUUID(), referenceType: 'payment' })
    await recomputeNexusTally(YEAR)

    const d = await getNexusDashboard(YEAR)
    const pr = d.states.find((s) => s.stateCode === 'PR')!
    expect(pr.status).toBe('unresearched')
    expect(pr.measureUsd).toBe(40)
    expect(d.summary.unresearched).toBe(1)
  })

  it('uses the newest catalog year that has started, so January does not blank the page', async () => {
    await seedThreshold('TX', 100000, null, 'revenue_only')  // effective_year = YEAR
    await seedTally('TX', YEAR + 1, 120000)
    const d = await getNexusDashboard(YEAR + 1)
    const tx = d.states.find((s) => s.stateCode === 'TX')!
    expect(tx.thresholdUsd).toBe(100000)
    expect(tx.status).toBe('crossed')
  })

  it('a tally row written before the breakdown existed still shows its total', async () => {
    await seedThreshold('TX', 100000, null, 'revenue_only')
    await seedTally('TX', YEAR, 600000, 4)   // revenue_usd only; line items all 0
    const d = await getNexusDashboard(YEAR)
    const tx = d.states.find((s) => s.stateCode === 'TX')!
    expect(tx.breakdownReady).toBe(false)
    expect(tx.measureUsd).toBe(600000)
    expect(tx.countedMeasureUsd).toBe(600000)
    expect(tx.status).toBe('crossed')
  })
})

describe('setStateRegistration', () => {
  it('flips registration on then off', async () => {
    await setStateRegistration('TX', true)
    let r = (await db.query<{ registered: boolean; registered_date: string | null }>(
      `SELECT registered, registered_date FROM state_tax_registrations WHERE state_code='TX'`
    )).rows[0]
    expect(r.registered).toBe(true)
    expect(r.registered_date).toBeTruthy()

    await setStateRegistration('TX', false)
    r = (await db.query<{ registered: boolean; registered_date: string | null }>(
      `SELECT registered, registered_date FROM state_tax_registrations WHERE state_code='TX'`
    )).rows[0]
    expect(r.registered).toBe(false)
    expect(r.registered_date).toBeNull()
  })
})
