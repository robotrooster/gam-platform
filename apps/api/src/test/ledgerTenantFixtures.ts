/**
 * 10/12 (Nic) — GAM Books ledger, phase P4: fixtures for the tenant-money
 * projector tests (services/ledgerProjectors/tenant*.test.ts).
 *
 * Built on the P3 fixtures (test/ledgerFixtures: ledgerCompany, inTx,
 * postingsOf). Everything is written COMMITTED — the engine posts on its own
 * connections — and each test starts from cleanupAllSchema. Rows are written
 * the way the money code leaves them (status, stamps, links), never through a
 * route, so each test says exactly which facts a posting comes from.
 */
import { randomUUID } from 'crypto'
import type { BooksHomeSaleMethod, BooksWorkTradeMethod } from '@gam/shared'
import { db } from '../db'
import { cleanupAllSchema, seedTenant, seedLease, seedLeaseTenant, seedUnit } from './dbHelpers'
import { inTx, ledgerCompany, type LedgerCompany } from './ledgerFixtures'
import { drainLedgerOutbox } from '../services/ledgerEngine'

/**
 * cleanupAllSchema, plus the one money table it does not clear yet: a
 * paid-ahead choice names its lease (RESTRICT) and its credit uses name it, so
 * the uses go first (TRUNCATE: a use is kept forever and refuses a DELETE).
 */
export async function cleanupTenantLedger(): Promise<void> {
  const who = await db.query<{ d: string }>(`SELECT current_database() AS d`)
  if (!String(who.rows[0]?.d ?? '').endsWith('_test')) throw new Error('cleanupTenantLedger refuses a non-test database')
  await db.query(`TRUNCATE credit_uses`)
  // 10/12 (Nic, ledger review): a paid-ahead choice's refund parts name it.
  await db.query(`DELETE FROM stay_refund_parts`)
  await db.query(`DELETE FROM paid_ahead_choices`)
  await cleanupAllSchema()
}

export interface TenantCo extends LedgerCompany {
  tenantId: string
  leaseId: string
}

/** A company with books starting `booksStart`, one tenant on an active lease on its unit (property 1). */
export async function tenantCo(o: {
  booksStart?: string | null; homeSale?: BooksHomeSaleMethod | null; workTrade?: BooksWorkTradeMethod | null
} = {}): Promise<TenantCo> {
  const co = await ledgerCompany({ booksStart: o.booksStart === undefined ? '2026-01-01' : o.booksStart })
  const t = await inTx(async (c) => {
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId: co.unitId, landlordId: co.landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(
      `UPDATE landlords SET books_home_sale_method = $2, books_work_trade_method = $3 WHERE id = $1`,
      [co.landlordId, o.homeSale ?? null, o.workTrade ?? null])
    return { tenantId, leaseId }
  })
  // Set up before the test starts: the company's own marks are not the test's.
  await db.query(`DELETE FROM ledger_outbox WHERE owner_id = $1`, [co.landlordId])
  return { ...co, ...t }
}

/** A second lease for the same tenant on a new unit of `propertyId` (property 2 by default). */
export async function addLease(co: TenantCo, propertyId = co.propertyId2): Promise<{ unitId: string; leaseId: string }> {
  return inTx(async (c) => {
    const unitId = await seedUnit(c, { propertyId, landlordId: co.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: co.landlordId })
    await seedLeaseTenant(c, { leaseId, tenantId: co.tenantId })
    return { unitId, leaseId }
  })
}

/** A bill row (committed). Defaults: rent, pending, on the company's lease and unit. */
export async function bill(co: TenantCo, o: {
  amount: number; due: string; type?: string; entry?: string; status?: string; unitId?: string; leaseId?: string
  revenueOwner?: 'landlord' | 'gam' | 'held'; leaseFeeId?: string | null; manualMethod?: string | null
  settledAt?: string | null; flexpayAdvanceId?: string | null; workTradeSettlementId?: string | null
  workTradeCredit?: number; homeSaleInstallmentId?: string | null; depositCollectedBy?: string | null
  notes?: string | null; reversalId?: string | null; landlordId?: string; tenantId?: string
}): Promise<string> {
  const type = o.type ?? 'rent'
  const entry = o.entry ?? ({ rent: 'RENT', utility: 'UTILITY', late_fee: 'LATEFEE', deposit: 'DEPOSIT', fee: 'OTHERFEE',
    home_payment: 'HOMEPMT', carried_balance: 'BALANCE' } as Record<string, string>)[type] ?? 'RENT'
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           revenue_owner, lease_fee_id, manual_method, settled_at, flexpay_advance_id, work_trade_settlement_id,
                           work_trade_credit, home_sale_installment_id, deposit_collected_by, notes, reversal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
    [o.unitId ?? co.unitId, o.leaseId ?? co.leaseId, o.tenantId ?? co.tenantId, o.landlordId ?? co.landlordId, type, o.amount,
     o.status ?? 'pending', o.due, entry, o.revenueOwner ?? 'landlord', o.leaseFeeId ?? null, o.manualMethod ?? null,
     o.settledAt ?? null, o.flexpayAdvanceId ?? null, o.workTradeSettlementId ?? null, o.workTradeCredit ?? 0,
     o.homeSaleInstallmentId ?? null, o.depositCollectedBy ?? null, o.notes ?? null, o.reversalId ?? null])
  return r.rows[0].id
}

/**
 * A settled receipt paying the listed rows (committed): the receipt, its
 * applications, each row settled (a desk method stamps manual_method), and
 * any surplus banked as paid-ahead money (landlord-held at the desk, GAM-held
 * through Stripe), as the settle paths write them.
 */
export async function receipt(co: TenantCo, o: {
  method: 'card' | 'ach' | 'cash' | 'check' | 'money_order' | 'bank_deposit'; settledAt: string
  apps: Array<{ paymentId: string; amount: number }>; surplus?: number; surplusLeaseId?: string
  landlordId?: string; leaseId?: string; settleRows?: boolean
}): Promise<{ remittanceId: string; creditId: string | null }> {
  return inTx(async (c) => {
    const applied = o.apps.reduce((s, a) => s + a.amount, 0)
    const surplus = o.surplus ?? 0
    const online = o.method === 'card' || o.method === 'ach'
    const rem = await c.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, settled_at, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'settled', $7, $8, $9) RETURNING id`,
      [co.tenantId, o.leaseId ?? co.leaseId, o.landlordId ?? co.landlordId, (applied + surplus).toFixed(2), applied.toFixed(2),
       surplus.toFixed(2), o.method, o.settledAt, online ? `pi_${randomUUID()}` : null])
    const remittanceId = rem.rows[0].id
    for (const a of o.apps) {
      await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)`,
        [remittanceId, a.paymentId, a.amount.toFixed(2)])
      if (o.settleRows !== false) {
        await c.query(
          `UPDATE payments SET status = 'settled', settled_at = $2, manual_method = $3 WHERE id = $1`,
          [a.paymentId, o.settledAt, online ? null : o.method])
      }
    }
    let creditId: string | null = null
    if (surplus > 0) {
      creditId = (await c.query<{ id: string }>(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, source_remittance_id,
                                            funded_by, received_at, note)
         VALUES ($1, $2, $3, $3, $4, $5, $6, 'Paid ahead') RETURNING id`,
        [o.surplusLeaseId ?? o.leaseId ?? co.leaseId, co.tenantId, surplus.toFixed(2), remittanceId,
         online ? 'gam' : 'landlord', o.settledAt])).rows[0].id
    }
    return { remittanceId, creditId }
  })
}

/** A paid-ahead credit (committed). */
export async function paidAhead(co: TenantCo, o: {
  amount: number; fundedBy: 'landlord' | 'gam' | 'reclassified'; receivedAt: string; leaseId?: string
  sourcePaymentId?: string | null; note?: string | null
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at,
                                        source_payment_id, note)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7) RETURNING id`,
    [o.leaseId ?? co.leaseId, co.tenantId, o.amount.toFixed(2), o.fundedBy, o.receivedAt, o.sourcePaymentId ?? null,
     o.note ?? null])
  return r.rows[0].id
}

/** A landlord-issued (or deposit-interest) credit (committed). */
export async function issuedCredit(co: TenantCo, o: { amount: number; category: string; leaseId?: string | null }): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, status)
     VALUES ($1, $2, $3, $4, $4, $5, 'active') RETURNING id`,
    [co.landlordId, co.tenantId, o.leaseId === undefined ? co.leaseId : o.leaseId, o.amount.toFixed(2), o.category])
  return r.rows[0].id
}

/** A credit spent on a bill (applied), the bill settled when the credit covers it. */
export async function spend(co: TenantCo, o: {
  paymentId: string; amount: number; appliedAt: string; prepaidCreditId?: string; tenantCreditId?: string
  leaseId?: string; settle?: boolean; source?: string
}): Promise<string> {
  return inTx(async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO credit_uses (prepaid_credit_id, tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1, $2, $3, $4, $5, date_trunc('month', $6::date)::date, $7, 'applied', $6) RETURNING id`,
      [o.prepaidCreditId ?? null, o.tenantCreditId ?? null, o.paymentId, o.leaseId ?? co.leaseId, o.amount.toFixed(2),
       o.appliedAt, o.source ?? 'desk'])
    if (o.settle !== false) {
      // Settled once credit covers the whole row (the whole-bill rule).
      await c.query(
        `UPDATE payments SET status = 'settled', settled_at = $2
          WHERE id = $1 AND status IN ('pending', 'failed')
            AND amount <= COALESCE((SELECT sum(amount) FROM credit_uses WHERE payment_id = $1 AND status = 'applied'), 0)`,
        [o.paymentId, o.appliedAt])
    }
    return r.rows[0].id
  })
}

/** A linked bank account of the company (committed). */
export async function bankConnection(co: TenantCo): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, institution_name, account_last4) VALUES ($1, 'Test Bank', '4321') RETURNING id`,
    [co.landlordId])
  return r.rows[0].id
}

/** Drains every waiting key the registered projectors post (ignoring back-off), until nothing is left. */
export async function drain(): Promise<{ posted: number; failed: number }> {
  let posted = 0
  let failed = 0
  for (let i = 0; i < 10; i++) {
    const s = await drainLedgerOutbox({ ignoreBackoff: true })
    posted += s.posted
    failed += s.failed
    if (s.keys === 0) break
  }
  return { posted, failed }
}

/** Σ(debit − credit) in cents on a posting role for a company (every line: reversals included). */
export async function bal(landlordId: string, role: string, f: { propertyId?: string | null; tenantId?: string; leaseId?: string } = {}): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT COALESCE(round(sum(debit - credit) * 100), 0)::bigint::text AS n FROM ledger_posting_lines
      WHERE landlord_id = $1 AND account_role = $2
        AND ($3::boolean IS FALSE OR property_id IS NOT DISTINCT FROM $4::uuid)
        AND ($5::uuid IS NULL OR tenant_id = $5) AND ($6::uuid IS NULL OR lease_id = $6)`,
    [landlordId, role, f.propertyId !== undefined, f.propertyId ?? null, f.tenantId ?? null, f.leaseId ?? null])
  return Number(r.rows[0].n)
}

/** Money received (Σ credit − debit on 'in' lines, cents) between two accounting days, optionally one category. */
export async function received(landlordId: string, from: string, to: string, category?: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT COALESCE(round(sum(credit - debit) * 100), 0)::bigint::text AS n FROM ledger_posting_lines
      WHERE landlord_id = $1 AND cash_effect = 'in' AND accounting_date BETWEEN $2::date AND $3::date
        AND ($4::text IS NULL OR report_category = $4)`, [landlordId, from, to, category ?? null])
  return Number(r.rows[0].n)
}

export interface ActiveLine {
  kind: string; day: string; role: string | null; dr: number; cr: number; propertyId: string | null
  category: string | null; cash: string | null; paymentId: string | null; tenantId: string | null; leaseId: string | null
  system: boolean
}

/** The lines of a source's ACTIVE postings, every kind (cents). */
export async function activeLines(sourceType: string, sourceId: string, landlordId?: string): Promise<ActiveLine[]> {
  const r = await db.query<any>(
    `SELECT p.posting_kind AS kind, p.intended_date::text AS day, l.account_role AS role,
            round(l.debit * 100)::bigint::text AS dr, round(l.credit * 100)::bigint::text AS cr, l.property_id,
            l.report_category, l.cash_effect, l.payment_id, l.tenant_id, l.lease_id, l.system_line
       FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
      WHERE p.source_type = $1 AND p.source_id = $2 AND p.role = 'post' AND p.superseded_at IS NULL
        AND ($3::uuid IS NULL OR p.landlord_id = $3)
      ORDER BY p.posting_kind, l.line_no`, [sourceType, sourceId, landlordId ?? null])
  return r.rows.map((x: any) => ({
    kind: x.kind, day: x.day, role: x.role, dr: Number(x.dr), cr: Number(x.cr), propertyId: x.property_id,
    category: x.report_category, cash: x.cash_effect, paymentId: x.payment_id, tenantId: x.tenant_id, leaseId: x.lease_id,
    system: x.system_line,
  }))
}

/** Compact [role, dr, cr] triples of non-system lines, for readable assertions. */
export function triples(lines: ActiveLine[], kind?: string): Array<[string | null, number, number]> {
  return lines.filter(l => !l.system && (!kind || l.kind === kind)).map(l => [l.role, l.dr, l.cr])
}

/** The engine's error record for a source, if it failed or is waiting. */
export async function sourceError(sourceType: string, sourceId: string): Promise<{ reason_code: string; last_error: string } | null> {
  const r = await db.query<{ reason_code: string; last_error: string }>(
    `SELECT reason_code, last_error FROM ledger_source_errors WHERE source_type = $1 AND source_id = $2`, [sourceType, sourceId])
  return r.rows[0] ?? null
}
