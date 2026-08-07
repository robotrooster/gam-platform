// Resident-to-resident home sale (S594, Nic). A resident who OWNS their home/RV
// (an active home_ownerships owner) sells it to another resident on payments.
//
// GAM processes NO money here — the payments happen off-platform, strictly
// between the two residents. GAM only keeps the RECORD: the agreed installment
// schedule (informational), a copy of the signed contract on file, and — once
// the landlord marks the last installment paid — the home-ownership flip to the
// buyer. This is intentionally SEPARATE from the landlord→tenant sale
// (services/homeSale.ts), which GAM does bill; the money distinction is Nic's
// "absolute" rule, enforced here by there being no payments/Stripe path at all.
import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { computeAmortization } from '@gam/shared'
import { setHomeOwner } from './homeOwnership'

type Client = PoolClient

export interface CreateResidentHomeSaleInput {
  unitId: string
  propertyId: string
  landlordId: string
  sellerUserId: string
  buyerUserId: string
  planType: 'amortized' | 'flat'
  salePrice: number
  downPayment: number
  annualInterestRate: number  // percent
  termMonths: number
  startMonth: string          // 'YYYY-MM-01'
  notes?: string | null
  createdByUserId?: string | null
}

/** Create a resident sale + its informational installment schedule. */
export async function createResidentHomeSale(client: Client, input: CreateResidentHomeSaleInput) {
  if (input.sellerUserId === input.buyerUserId) throw new AppError(400, 'Buyer and seller must be different people.')
  const financed = Math.round((input.salePrice - input.downPayment) * 100) / 100
  if (financed < 0) throw new AppError(400, 'Down payment cannot exceed the sale price.')
  if (input.termMonths <= 0 || input.termMonths > 600) throw new AppError(400, 'Term must be between 1 and 600 months.')

  const existing = await client.query(
    `SELECT id FROM resident_home_sales WHERE unit_id=$1 AND status='active' LIMIT 1`, [input.unitId])
  if (existing.rows.length) throw new AppError(409, 'This unit already has an active resident home sale.')

  const { monthlyPayment, schedule } = computeAmortization(financed, input.annualInterestRate, input.termMonths)

  const sale = (await client.query<any>(
    `INSERT INTO resident_home_sales
       (unit_id, property_id, landlord_id, seller_user_id, buyer_user_id, plan_type,
        sale_price, down_payment, annual_interest_rate, term_months, monthly_payment,
        start_month, installments_total, notes, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [input.unitId, input.propertyId, input.landlordId, input.sellerUserId, input.buyerUserId, input.planType,
     input.salePrice.toFixed(2), input.downPayment.toFixed(2), input.annualInterestRate, input.termMonths,
     monthlyPayment.toFixed(2), input.startMonth, schedule.length, input.notes ?? null,
     input.createdByUserId ?? null])).rows[0]

  for (const row of schedule) {
    await client.query(
      `INSERT INTO resident_home_sale_installments
         (sale_id, installment_number, due_month, amount, principal_portion, interest_portion, remaining_balance)
       VALUES ($1,$2, ($3::date + ($4::int || ' months')::interval)::date, $5,$6,$7,$8)`,
      [sale.id, row.installmentNumber, input.startMonth, row.installmentNumber - 1,
       row.amount.toFixed(2), row.principalPortion.toFixed(2), row.interestPortion.toFixed(2),
       row.remainingBalance.toFixed(2)])
  }
  return sale
}

/**
 * Mark (or unmark) a resident-sale installment as paid off-platform. Recounts
 * paid installments. When every installment is paid, the sale is marked
 * paid_off and the home-ownership record flips to the buyer (acquired_via
 * 'sale'). Unmarking after payoff reopens the sale + is a no-op on ownership
 * (the buyer stays the recorded owner until an explicit re-assignment).
 */
export async function setResidentInstallmentPaid(
  saleId: string, installmentNumber: number, byUserId: string, paid: boolean,
): Promise<{ installmentsPaid: number; installmentsTotal: number; status: string }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Serialize concurrent mark-paid on the same sale.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`resident_home_sale:${saleId}`])
    const sale = (await client.query<any>(
      `SELECT id, unit_id, buyer_user_id, status, installments_total FROM resident_home_sales WHERE id=$1`, [saleId])).rows[0]
    if (!sale) throw new AppError(404, 'Resident sale not found')
    if (sale.status === 'cancelled') throw new AppError(409, 'This sale is cancelled.')

    const upd = await client.query(
      `UPDATE resident_home_sale_installments
          SET paid=$3, paid_at = CASE WHEN $3 THEN now() ELSE NULL END,
              paid_recorded_by_user_id = CASE WHEN $3 THEN $4::uuid ELSE NULL END
        WHERE sale_id=$1 AND installment_number=$2 RETURNING id`,
      [saleId, installmentNumber, paid, byUserId])
    if (upd.rows.length === 0) throw new AppError(404, 'Installment not found')

    const cnt = (await client.query<{ n: string }>(
      `SELECT COUNT(*) FILTER (WHERE paid) AS n FROM resident_home_sale_installments WHERE sale_id=$1`, [saleId])).rows[0]
    const paidCount = parseInt(cnt?.n ?? '0', 10)

    let status = sale.status
    if (paidCount >= sale.installments_total) {
      // Fully paid → mark paid_off + transfer the home to the buyer.
      await client.query(
        `UPDATE resident_home_sales SET installments_paid=$2, status='paid_off', paid_off_at=now(), updated_at=now()
          WHERE id=$1 AND status='active'`, [saleId, paidCount])
      await setHomeOwner(client as any, { unitId: sale.unit_id, ownerUserId: sale.buyer_user_id, acquiredVia: 'sale' })
      status = 'paid_off'
    } else {
      // Not fully paid → keep active (reopen if a previously-paid one was unmarked).
      await client.query(
        `UPDATE resident_home_sales
            SET installments_paid=$2,
                status = CASE WHEN status='paid_off' THEN 'active' ELSE status END,
                paid_off_at = CASE WHEN status='paid_off' THEN NULL ELSE paid_off_at END,
                updated_at=now()
          WHERE id=$1`, [saleId, paidCount])
      status = (await client.query<{ status: string }>(`SELECT status FROM resident_home_sales WHERE id=$1`, [saleId])).rows[0].status
    }
    await client.query('COMMIT')
    return { installmentsPaid: paidCount, installmentsTotal: sale.installments_total, status }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

/** Cancel a resident sale (soft — schedule stays as the historical record). */
export async function cancelResidentHomeSale(saleId: string): Promise<void> {
  const row = await queryOne<{ id: string }>(
    `UPDATE resident_home_sales SET status='cancelled', cancelled_at=now(), updated_at=now()
      WHERE id=$1 AND status='active' RETURNING id`, [saleId])
  if (!row) throw new AppError(409, 'Sale not found or not active.')
}
