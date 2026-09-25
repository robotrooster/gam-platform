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
import { logger } from '../lib/logger'
import { computeAmortization } from '@gam/shared'
import { z } from 'zod'

type Client = PoolClient

export interface CreateHomeSaleInput {
  /** S629: hold the terms unsigned — no schedule, nothing billed, until the agreement completes. */
  pendingSignature?: boolean
  unitId: string
  /**
   * S651 — OPTIONAL, and that is the point.
   *
   * This used to be required as "the billing anchor". Nic: "we can't do the
   * contract sales tied to a lease... I know a guy that owns over a hundred
   * homes throughout various parks without actually owning any parks. He's not
   * going to have a lease. The ownership of the trailer has nothing to do with
   * who's actually living in the trailer."
   *
   * He is right, and the coupling was wrong in both directions: a buyer may
   * own a home they do not live in, and a tenant may live in a home somebody
   * else is buying. One tenant can sell their home to another, who then
   * subleases it on. So a sale stands on its own, and a lease — when there is
   * one — is recorded for context, not required for the sale to exist.
   *
   * `home_sale_contracts.lease_id` and `payments.lease_id` were both already
   * nullable; only this type and the route insisted. A home-sale installment
   * bills as a standalone `home_payment`, which has its own settlement path and
   * is excluded from rent allocation, so it never needed a lease to bill.
   */
  leaseId?: string | null
  tenantId: string
  landlordId: string
  salePrice: number
  downPayment: number
  annualInterestRate: number  // percent, e.g. 7.5
  termMonths: number
  startMonth: string          // 'YYYY-MM-01'
  planType?: 'amortized' | 'flat'  // S594: how the deal is shaped (default amortized)
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
    `SELECT id, status FROM home_sale_contracts
      WHERE unit_id=$1 AND status IN ('active','pending_signature') LIMIT 1`, [input.unitId])
  if (existing.rows.length) {
    throw new AppError(409, existing.rows[0].status === 'pending_signature'
      ? 'This unit already has a purchase agreement out for signature. Cancel it before starting another.'
      : 'This unit already has an active home-sale contract.')
  }

  const { monthlyPayment, schedule } = computeAmortization(financed, input.annualInterestRate, input.termMonths)

  // S629: `pendingSignature` holds the agreed terms WITHOUT generating a
  // schedule, so nothing bills until the purchase agreement comes back signed.
  // Same rule the leases follow: the signed document is the authority, and
  // money only moves behind one.
  const status = input.pendingSignature ? 'pending_signature' : 'active'

  const contract = (await client.query<any>(
    `INSERT INTO home_sale_contracts
       (unit_id, lease_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
        annual_interest_rate, term_months, monthly_payment, start_month, installments_total, plan_type,
        status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [input.unitId, input.leaseId ?? null, input.tenantId, input.landlordId, input.salePrice.toFixed(2),
     input.downPayment.toFixed(2), financed.toFixed(2), input.annualInterestRate, input.termMonths,
     monthlyPayment.toFixed(2), input.startMonth, schedule.length, input.planType ?? 'amortized',
     status])).rows[0]

  // A contract awaiting signature has agreed terms and no schedule. The
  // schedule is written by activateHomeSaleContract when the document
  // completes — writing it now would mean a tenant who never signs still has
  // installments sitting in the billing tables.
  if (status === 'pending_signature') return contract

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
 * S629 — SIGNATURE IS WHAT STARTS THE BILLING.
 *
 * Called when a purchase agreement completes. Generates the amortization
 * schedule and flips the contract to active, so the months a tenant is billed
 * are the months of the contract they actually signed.
 *
 * Idempotent: the e-sign completion path is best-effort and post-commit, so it
 * can be retried, and a contract already active must not have a second
 * schedule written under it.
 */
export async function activateHomeSaleContract(documentId: string): Promise<{ activated: boolean }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const c = (await client.query<any>(
      `SELECT * FROM home_sale_contracts
        WHERE purchase_document_id = $1 AND status = 'pending_signature'
        FOR UPDATE`, [documentId])).rows[0]
    if (!c) { await client.query('ROLLBACK'); return { activated: false } }

    const financed = Number(c.financed_amount)
    const { schedule } = computeAmortization(financed, Number(c.annual_interest_rate), c.term_months)

    for (const row of schedule) {
      await client.query(
        `INSERT INTO home_sale_installments
           (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
         VALUES ($1,$2, ($3::date + ($4::int || ' months')::interval)::date, $5,$6,$7,$8)`,
        [c.id, row.installmentNumber, c.start_month, row.installmentNumber - 1,
         row.amount.toFixed(2), row.principalPortion.toFixed(2), row.interestPortion.toFixed(2),
         row.remainingBalance.toFixed(2)])
    }
    await client.query(
      `UPDATE home_sale_contracts SET status='active', updated_at=NOW() WHERE id=$1`, [c.id])
    await client.query('COMMIT')
    logger.info({ contractId: c.id, documentId, installments: schedule.length },
      'home sale: purchase agreement signed — billing schedule created')
    return { activated: true }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
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
        COUNT(*) FILTER (WHERE i.payment_id IS NOT NULL OR i.settled_off_platform_at IS NOT NULL) AS billed,
        COUNT(*) FILTER (WHERE p.status IN ('settled','paid_via_deposit') OR i.settled_off_platform_at IS NOT NULL) AS paid
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
  // S652 (Nic): the contract keeps its true terms — John Sheptock's started in
  // January 2021 — but GAM bills only from the property's first billing cycle.
  // Every installment before that was paid outside GAM and is stamped so, once;
  // it never bills and it counts as paid when the balance is worked out.
  await query(
    `UPDATE home_sale_installments i SET settled_off_platform_at = NOW()
       FROM home_sale_contracts c, units u, properties p
      WHERE i.contract_id = c.id AND u.id = c.unit_id AND p.id = u.property_id
        AND c.status = 'active' AND i.payment_id IS NULL AND i.settled_off_platform_at IS NULL
        AND p.first_billing_cycle IS NOT NULL
        AND i.billing_month < date_trunc('month', p.first_billing_cycle)::date`)
  const due = await query<any>(
    `SELECT i.id AS installment_id, i.installment_number, i.amount, i.billing_month::text AS billing_month,
            c.id AS contract_id, c.unit_id, c.lease_id, c.tenant_id, c.landlord_id, c.installments_total
       FROM home_sale_installments i
       JOIN home_sale_contracts c ON c.id = i.contract_id
      WHERE c.status = 'active'
        AND i.payment_id IS NULL
        AND i.settled_off_platform_at IS NULL
        AND i.billing_month <= $1::date
      ORDER BY c.id, i.installment_number ASC`,
    [asOfMonth])

  let billed = 0
  const touchedContracts = new Set<string>()
  for (const d of due) {
    // Bill each installment atomically: create the charge stamped with the
    // driving installment id, then stamp the installment — in one transaction.
    // The partial-unique index on payments.home_sale_installment_id makes a
    // concurrent/overlapping run (or a second cron-enabled instance) a no-op
    // via ON CONFLICT DO NOTHING, so an installment is billed at most once and
    // the tenant is never double-charged.
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const ins = await client.query<{ id: string }>(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, notes,
            home_sale_installment_id)
         VALUES ($1,$2,$3,$4,'home_payment',$5,'pending','HOMEPMT',$6,$7,$8)
         ON CONFLICT (home_sale_installment_id) WHERE home_sale_installment_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [d.unit_id, d.lease_id, d.tenant_id, d.landlord_id, Number(d.amount).toFixed(2), d.billing_month,
         `Home payment ${d.installment_number} of ${d.installments_total}`, d.installment_id])
      if (ins.rows.length) {
        await client.query(`UPDATE home_sale_installments SET payment_id=$1 WHERE id=$2 AND payment_id IS NULL`,
          [ins.rows[0].id, d.installment_id])
        billed++
        touchedContracts.add(d.contract_id)
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
  }
  for (const cid of touchedContracts) await reconcileHomeSaleContract(cid)
  return billed
}

/**
 * S652 — the terms of an installment sale, and the checks that must run before
 * one can exist. Shared, because there are now two doors into a home sale.
 *
 * POST /api/home-sales is one: a landlord papering a sale on its own. The other
 * is a lease packet with an installment-sale template ticked, which is what Nic
 * asked for — "one packet, two documents, two signatures" — and which must NOT
 * be a way around the rules the first door enforces.
 *
 * Every guard below exists because of a specific decision, and duplicating them
 * at the second door would mean the next change to one of them silently applies
 * to half the product.
 */
export const homeSaleTermsSchema = z.object({
  startMonth:         z.string().regex(/^\d{4}-\d{2}-01$/),
  planType:           z.enum(['amortized', 'flat']).default('amortized'),
  salePrice:          z.number().positive().optional(),
  downPayment:        z.number().min(0).default(0),
  annualInterestRate: z.number().min(0).max(60).default(0),
  termMonths:         z.number().int().positive().max(600).optional(),
  monthlyAmount:      z.number().positive().optional(),
  numberOfPayments:   z.number().int().positive().max(600).optional(),
  tenantId:           z.string().uuid().optional(),
}).transform((b) => {
  // A flat plan is 0% interest with each installment equal to the flat amount;
  // the sale price is that amount times the number of payments.
  if (b.planType === 'flat') {
    if (b.monthlyAmount == null || b.numberOfPayments == null) {
      throw new AppError(400, 'A flat plan needs a monthly amount and a number of payments.')
    }
    return {
      ...b,
      salePrice: Math.round(b.monthlyAmount * b.numberOfPayments * 100) / 100,
      downPayment: 0,
      annualInterestRate: 0,
      termMonths: b.numberOfPayments,
    }
  }
  if (b.salePrice == null || b.termMonths == null) {
    throw new AppError(400, 'An amortized plan needs a sale price and a term.')
  }
  return { ...b, salePrice: b.salePrice, termMonths: b.termMonths }
})

/**
 * Can this unit be sold on installments at all?
 *
 * S613 (Nic, DIRECTIVE): "Financed sales scope needs to be limited to
 * converting park owned homes to tenant owned homes. We don't want it to be
 * anything to do with RVs." An RV is towed away — there is nothing to convert,
 * and financing one would make GAM the lender on a vehicle that can leave.
 */
/**
 * Both callers pass a different thing: a PoolClient (whose .query returns
 * `{ rows }`) inside a transaction, and db's `query` (which returns the rows
 * themselves) outside one. Normalising here rather than making each caller
 * remember is the difference between a shared guard and a trap — TypeScript
 * cannot see the mismatch through `{ query: Function }`, so nothing would have
 * told anybody until it threw in production.
 */
async function rowsFrom(q: { query: Function }, sql: string, params: any[]): Promise<any[]> {
  const out = await q.query(sql, params)
  return Array.isArray(out) ? out : (out?.rows ?? [])
}

export async function assertUnitIsSaleable(
  client: { query: Function }, unitId: string,
): Promise<{ id: string; landlord_id: string; unit_number: string }> {
  const unit = (await rowsFrom(client,
    `SELECT u.id, u.landlord_id, u.dwelling_ownership, u.unit_type, u.unit_number
       FROM units u WHERE u.id = $1`, [unitId]))[0]
  if (!unit) throw new AppError(404, 'Unit not found')
  if (unit.dwelling_ownership !== 'landlord') {
    throw new AppError(409, 'This unit is already tenant-owned — there is no park-owned home to finance.')
  }
  if (unit.unit_type !== 'mobile_home') {
    throw new AppError(400,
      'A financed sale converts a park-owned HOME to tenant-owned. It is only offered on mobile homes.')
  }
  return unit
}

/**
 * Does this landlord have any standing with this buyer?
 *
 * tenantId becomes the billed obligor on every installment, so it can never be
 * an arbitrary id out of a request body (memory: gam-foreign-ref-write-scope).
 * What is required is a relationship of SOME kind — a lease of any status, an
 * open onboarding invite, or a utility agreement — not a tenancy, because a
 * buyer may own a home they do not live in.
 */
export async function assertBuyerIsKnown(
  client: { query: Function }, tenantId: string, landlordId: string,
): Promise<void> {
  const known = (await rowsFrom(client,
    `SELECT 1 WHERE
       EXISTS (SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
                WHERE lt.tenant_id = $1 AND l.landlord_id = $2)
       OR EXISTS (SELECT 1 FROM pending_tenant_intents pti
                   WHERE pti.tenant_id = $1 AND pti.landlord_id = $2
                     AND pti.cancelled_at IS NULL)
       OR EXISTS (SELECT 1 FROM utility_service_agreements sa
                   WHERE sa.tenant_id = $1 AND sa.landlord_id = $2)
     LIMIT 1`, [tenantId, landlordId]))[0]
  if (!known) {
    throw new AppError(400,
      'That buyer has no record with you — invite them first, then sell them the home.')
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// S652 (Nic): THE PAPER IS THE RECORD.
//
// "If I want my payment to be $19 for one hundred payments I need to type
// those in ... have the data tag be the correct label where the invoice will
// go out correctly no matter what I type in that box at signing time."
//
// The installment contract's boxes tagged with sale labels are TYPED by the
// landlord at signing. When the landlord signs, those values become the sale
// record — the thing that bills each month and stops after the last payment.
// Nothing derives from an invite or a sheet; a prefilled box is only a
// suggestion the landlord may type over.
// ─────────────────────────────────────────────────────────────────────────────

export type TypedSaleTerms = {
  monthlyAmount: number | null; numberOfPayments: number | null; salePrice: number | null
  downPayment: number; annualInterestRate: number; startMonth: string | null
}

const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december']
/** "10/01/2026", "10/2026", "2026-10", "2026-10-01", "October 2026", "Oct 2026" → "2026-10-01". */
export function monthFromTyped(v: unknown): string | null {
  if (v == null) return null
  const t = String(v).trim()
  if (!t) return null
  let m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?/.exec(t)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-01`
  m = /^(\d{1,2})[\/\-](?:(\d{1,2})[\/\-])?(\d{4})$/.exec(t)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-01`
  m = /^([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(t)
  if (m) {
    const i = MONTHS.findIndex(x => x.startsWith(m![1].toLowerCase().slice(0, 3)))
    if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, '0')}-01`
  }
  return null
}

/** Read the sale terms off a document's fields (by lease_column). */
export function saleTermsFromFields(fields: Array<{ lease_column: string | null; value: string | null }>): TypedSaleTerms {
  const get = (col: string) => fields.find(f => f.lease_column === col)?.value ?? null
  return {
    monthlyAmount:      num(get('sale_monthly_payment')),
    numberOfPayments:   (() => { const n = num(get('sale_term_months')); return n == null ? null : Math.round(n) })(),
    salePrice:          num(get('sale_price')),
    downPayment:        num(get('sale_down_payment')) ?? 0,
    annualInterestRate: num(get('sale_interest_rate')) ?? 0,
    startMonth:         monthFromTyped(get('sale_first_payment_month')),
  }
}

/** What the typed terms mean, or why they cannot bill — said in the landlord's words. */
export function resolveTypedSaleTerms(t: TypedSaleTerms): { planType: 'flat' | 'amortized'; salePrice: number; downPayment: number; annualInterestRate: number; termMonths: number; startMonth: string } {
  const n = t.numberOfPayments
  if (!n || n <= 0) throw new AppError(400, 'The installment contract needs the number of payments.')
  const start = t.startMonth ?? (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1, 1); return d.toISOString().slice(0, 10) })()
  // Same amount every month, no interest: the plain case — price is the sum.
  if (t.monthlyAmount && t.monthlyAmount > 0 && (!t.annualInterestRate || t.annualInterestRate === 0)
      && (t.salePrice == null || Math.abs(t.salePrice - t.downPayment - t.monthlyAmount * n) < 1)) {
    return { planType: 'flat', salePrice: Math.round((t.monthlyAmount * n + t.downPayment) * 100) / 100,
             downPayment: t.downPayment, annualInterestRate: 0, termMonths: n, startMonth: start }
  }
  if (t.salePrice == null || t.salePrice <= 0) {
    throw new AppError(400, 'The installment contract needs either a monthly payment with no interest, or a sale price with the rate and number of payments.')
  }
  return { planType: 'amortized', salePrice: t.salePrice, downPayment: t.downPayment,
           annualInterestRate: t.annualInterestRate, termMonths: n, startMonth: start }
}

/**
 * On the landlord's signature of an installment contract: the typed terms
 * become the sale record (pending the tenant's signature, which activates
 * billing), and the derived boxes — amount financed, final payment amount and
 * month — are stamped so the printed paper agrees with the record.
 */
export async function applySaleTermsFromDocument(documentId: string): Promise<{ contractId: string }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const doc = (await client.query<any>(
      `SELECT d.id, d.unit_id, d.landlord_id FROM lease_documents d WHERE d.id = $1 FOR UPDATE`, [documentId])).rows[0]
    if (!doc?.unit_id) throw new AppError(400, 'This installment contract is not attached to a unit.')
    const fields = (await client.query<any>(
      `SELECT id, lease_column, value FROM lease_document_fields WHERE document_id = $1 AND lease_column LIKE 'sale_%'`, [documentId])).rows
    const terms = resolveTypedSaleTerms(saleTermsFromFields(fields))
    const buyer = (await client.query<any>(
      `SELECT t.id FROM lease_document_signers s JOIN tenants t ON t.user_id = s.user_id
        WHERE s.document_id = $1 AND s.role IN ('primary','purchaser') ORDER BY s.order_index LIMIT 1`, [documentId])).rows[0]
    if (!buyer) throw new AppError(400, 'The installment contract has no buyer on it.')

    // A pending record already on this unit gives way to the paper.
    const existing = (await client.query<any>(
      `SELECT id, purchase_document_id, sale_price, down_payment, annual_interest_rate, term_months, start_month, plan_type
         FROM home_sale_contracts WHERE unit_id = $1 AND status = 'pending_signature' FOR UPDATE`, [doc.unit_id])).rows[0]
    let contract: any = null
    if (existing && existing.purchase_document_id === documentId
        && Number(existing.sale_price) === terms.salePrice && Number(existing.down_payment) === terms.downPayment
        && Number(existing.annual_interest_rate) === terms.annualInterestRate && Number(existing.term_months) === terms.termMonths
        && String(existing.start_month).slice(0, 10) === terms.startMonth) {
      contract = (await client.query<any>(`SELECT * FROM home_sale_contracts WHERE id = $1`, [existing.id])).rows[0]
    } else {
      if (existing) {
        await client.query(`UPDATE home_sale_contracts SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [existing.id])
      }
      contract = await createHomeSaleContract(client, {
        unitId: doc.unit_id, leaseId: null, tenantId: buyer.id, landlordId: doc.landlord_id,
        salePrice: terms.salePrice, downPayment: terms.downPayment, annualInterestRate: terms.annualInterestRate,
        termMonths: terms.termMonths, startMonth: terms.startMonth, planType: terms.planType, pendingSignature: true,
      })
      await client.query(`UPDATE home_sale_contracts SET purchase_document_id = $2, updated_at = NOW() WHERE id = $1`, [contract.id, documentId])
    }

    // The derived boxes, printed from the record.
    const financed = Number(contract.financed_amount)
    const { schedule } = computeAmortization(financed, terms.annualInterestRate, terms.termMonths)
    const last = schedule[schedule.length - 1]
    const lastMonth = (() => { const d = new Date(terms.startMonth + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + terms.termMonths - 1); return d })()
    const derived: Record<string, string> = {
      sale_financed_amount:      financed.toFixed(2),
      sale_final_payment_amount: Number(last?.amount ?? contract.monthly_payment).toFixed(2),
      sale_final_payment_month:  `${lastMonth.getUTCMonth() + 1}/1/${lastMonth.getUTCFullYear()}`,
    }
    for (const [col, val] of Object.entries(derived)) {
      await client.query(`UPDATE lease_document_fields SET value = $3 WHERE document_id = $1 AND lease_column = $2`, [documentId, col, val])
    }
    await client.query('COMMIT')
    return { contractId: contract.id }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
}
