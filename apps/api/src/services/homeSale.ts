// Financed home/RV sale (S568, Nic). A landlord sells a park-owned home to a
// tenant who pays it off over N years at a set interest rate — SEPARATE from
// space rent. The amortized installment is billed each cycle as a
// type='home_payment' row (routes to the landlord like rent, rides the invoice),
// auto-stops at term, and on payoff the unit flips landlord-owned → tenant-owned.
//
// Money flow: home_payment settles through the same platform-holds batch as rent
// (platform_held), so no new rail. It is intentionally NOT type='rent' (that
// would collide with the rent idempotency unique + trigger rent late-fee/eviction
// logic that must not apply to a purchase installment).
import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { computeAmortization } from '@gam/shared'

type Client = PoolClient

export interface CreateHomeSaleInput {
  unitId: string
  leaseId: string          // the tenant's space-rent lease — the billing anchor
  tenantId: string
  landlordId: string
  salePrice: number
  downPayment: number
  annualInterestRate: number  // percent, e.g. 7.5
  termMonths: number
  startMonth: string          // 'YYYY-MM-01'
}

/**
 * Create a financing contract + its precomputed amortization schedule.
 * Enforces one ACTIVE contract per unit (partial unique index also guards).
 */
export async function createHomeSaleContract(client: Client, input: CreateHomeSaleInput) {
  const financed = Math.round((input.salePrice - input.downPayment) * 100) / 100
  if (financed < 0) throw new AppError(400, 'Down payment cannot exceed the sale price.')
  if (input.termMonths <= 0 || input.termMonths > 600) throw new AppError(400, 'Term must be between 1 and 600 months.')

  const existing = await client.query(
    `SELECT id FROM home_sale_contracts WHERE unit_id=$1 AND status='active' LIMIT 1`, [input.unitId])
  if (existing.rows.length) throw new AppError(409, 'This unit already has an active home-sale contract.')

  const { monthlyPayment, schedule } = computeAmortization(financed, input.annualInterestRate, input.termMonths)

  const contract = (await client.query<any>(
    `INSERT INTO home_sale_contracts
       (unit_id, lease_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
        annual_interest_rate, term_months, monthly_payment, start_month, installments_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [input.unitId, input.leaseId, input.tenantId, input.landlordId, input.salePrice.toFixed(2),
     input.downPayment.toFixed(2), financed.toFixed(2), input.annualInterestRate, input.termMonths,
     monthlyPayment.toFixed(2), input.startMonth, schedule.length])).rows[0]

  // Precompute the billing month per installment (start_month + (n-1) months).
  for (const row of schedule) {
    await client.query(
      `INSERT INTO home_sale_installments
         (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
       VALUES ($1,$2, ($3::date + ($4::int || ' months')::interval)::date, $5,$6,$7,$8)`,
      [contract.id, row.installmentNumber, input.startMonth, row.installmentNumber - 1,
       row.amount.toFixed(2), row.principalPortion.toFixed(2), row.interestPortion.toFixed(2),
       row.remainingBalance.toFixed(2)])
  }
  return contract
}

/**
 * Reconcile a contract against reality: recount billed (payment_id set) + paid
 * (linked payment settled) installments. When every installment is settled, mark
 * the contract paid_off and flip the unit to tenant-owned (the buyer now owns the
 * home). Idempotent — safe to run repeatedly (daily cron + post-settle).
 */
export async function reconcileHomeSaleContract(contractId: string): Promise<void> {
  const c = await queryOne<any>(`SELECT id, unit_id, status, installments_total FROM home_sale_contracts WHERE id=$1`, [contractId])
  if (!c || c.status !== 'active') return

  const counts = await queryOne<{ billed: string; paid: string }>(
    `SELECT
        COUNT(*) FILTER (WHERE i.payment_id IS NOT NULL) AS billed,
        COUNT(*) FILTER (WHERE p.status IN ('settled','paid_via_deposit')) AS paid
       FROM home_sale_installments i
       LEFT JOIN payments p ON p.id = i.payment_id
      WHERE i.contract_id = $1`, [contractId])
  const billed = parseInt(counts?.billed ?? '0', 10)
  const paid = parseInt(counts?.paid ?? '0', 10)

  await query(`UPDATE home_sale_contracts SET installments_billed=$2, installments_paid=$3, updated_at=NOW() WHERE id=$1`,
    [contractId, billed, paid])

  if (paid >= c.installments_total) {
    await query(`UPDATE home_sale_contracts SET status='paid_off', paid_off_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='active'`, [contractId])
    // Buyer now owns the home — flip dwelling ownership AND record the buyer as
    // the home owner (the sale document trail lives on the contract).
    await query(`UPDATE units SET dwelling_ownership='tenant', updated_at=NOW() WHERE id=$1`, [c.unit_id])
    const buyer = await queryOne<{ user_id: string }>(
      `SELECT t.user_id FROM home_sale_contracts hsc JOIN tenants t ON t.id = hsc.tenant_id WHERE hsc.id=$1`, [contractId])
    if (buyer?.user_id) {
      const { setHomeOwner } = await import('./homeOwnership')
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await setHomeOwner(client as any, { unitId: c.unit_id, ownerUserId: buyer.user_id, acquiredVia: 'financed_payoff' })
        await client.query('COMMIT')
      } catch (e) { await client.query('ROLLBACK').catch(() => {}) } finally { client.release() }
    }
  }
}

/** Reconcile every active contract (daily cron). */
export async function reconcileAllHomeSaleContracts(): Promise<void> {
  const active = await query<{ id: string }>(`SELECT id FROM home_sale_contracts WHERE status='active'`)
  for (const c of active) await reconcileHomeSaleContract(c.id)
}

/**
 * Bill every home-sale installment whose billing month has arrived and that
 * hasn't been billed yet — one standalone type='home_payment' charge per
 * installment (separate line from space rent, routes to the landlord/seller).
 * Idempotent: installment.payment_id is stamped once, so re-runs skip billed
 * rows. Auto-stops naturally when a contract has no more unbilled installments.
 * `asOfMonth` = 'YYYY-MM-01' (bill everything due on/before this cycle).
 * Returns the number of installments billed.
 */
export async function billDueHomeSaleInstallments(asOfMonth: string): Promise<number> {
  const due = await query<any>(
    `SELECT i.id AS installment_id, i.installment_number, i.amount, i.billing_month::text AS billing_month,
            c.id AS contract_id, c.unit_id, c.lease_id, c.tenant_id, c.landlord_id, c.installments_total
       FROM home_sale_installments i
       JOIN home_sale_contracts c ON c.id = i.contract_id
      WHERE c.status = 'active'
        AND i.payment_id IS NULL
        AND i.billing_month <= $1::date
      ORDER BY c.id, i.installment_number ASC`,
    [asOfMonth])

  let billed = 0
  const touchedContracts = new Set<string>()
  for (const d of due) {
    // Create the charge, then stamp the installment. If the stamp races, the
    // unbilled filter on the next run prevents a duplicate.
    const pay = await queryOne<{ id: string }>(
      `INSERT INTO payments
         (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, notes)
       VALUES ($1,$2,$3,$4,'home_payment',$5,'pending','HOMEPMT',$6,$7)
       RETURNING id`,
      [d.unit_id, d.lease_id, d.tenant_id, d.landlord_id, Number(d.amount).toFixed(2), d.billing_month,
       `Home payment ${d.installment_number} of ${d.installments_total}`])
    await query(`UPDATE home_sale_installments SET payment_id=$1 WHERE id=$2 AND payment_id IS NULL`, [pay!.id, d.installment_id])
    billed++
    touchedContracts.add(d.contract_id)
  }
  for (const cid of touchedContracts) await reconcileHomeSaleContract(cid)
  return billed
}
