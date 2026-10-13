/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P4, FAMILY A: TENANT BILLS
 * (gam-ledger-design-2026-10-12 §6 A1-A9, A7b)
 *
 *   Nic 10/12: "charges recorded when billed AND payments when received (both
 *   always)."
 *
 * Every bill row posts its own charge on its due date, at ITS OWN amount plus
 * any work-trade hours applied to it (payments.work_trade_credit — the month
 * close lowers the amount and keeps the hours there): a part payment that
 * split a row restates the original and the new row posts its own part, so the
 * two always add up with no link between them. Key `payment:<id>`, kind
 * 'charge'.
 *
 *   A1  rent, fees, fines, propane, stay rent …   Dr receivables / Cr income
 *       (by what the row is: 4010 rent, 4030 application, 4040 pet, 4060
 *       storage, 4080 other fees, 4071-4079 utilities)
 *   A2  a utility line with its meter bills        the payment's amount is the
 *       truth (5 Oak Park lines differ from their bills, design §2); the tax
 *       is Σ bill tax capped at the amount (2045); the rest is split across
 *       the bills by their charge (all to the first bill's utility when the
 *       charges add to $0)
 *   A3  a late fee                                  4020
 *   A4  a refundable deposit billed                 Cr 2020 security deposits
 *       payable (Nic 10/12: a deposit is a liability, income only when kept)
 *   A5  a non-refundable "deposit" fee              income, like any fee
 *   A6  the prepaid move-in box                     NOTHING (Nic L13: paid-ahead
 *       money GAM holds is not on the landlord's balance sheet; paid at the desk
 *       it books on the receipt, tenantReceipts)
 *   A7  a home payment billed                       principal / interest as the
 *       contract's installment says (Nic L11, the owner's choice): the whole
 *       sale at signing → Cr 1310 note principal + 4310 interest; income as
 *       paid → Cr 4300 principal + 4310 interest. Waits while not chosen.
 *   A7b an installment paid outside GAM (its own source 'home_installment',
 *       dated its billing month): Dr 1099 "paid outside GAM, to confirm" /
 *       Cr the same principal and interest lines, counted as received
 *   A8  an opening carried balance                  Cr 3900 opening balance
 *       equity (an old balance, never this company's income in GAM's books)
 *   A9  a work-trade shortfall billed with no bill  Cr 4010 space rent (the
 *       work was not done, so it is rent owed — under either work-trade choice)
 *
 * Never a charge here: a voided row (its charge reverses — a correction), a
 * row whose amount is $0, GAM's rows and the FlexPay pull, FlexDeposit
 * installment rows, the move-out refund row, a row a dispute reopened (its
 * charge is the reversal's, tenantReversals E1) and the move-out balance row
 * (the move-out's, tenantDeposits D3).
 */
import type { PoolClient } from 'pg'
import type { DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import { LedgerSourceError } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import {
  type PaymentFacts, type CompanyBooks, Lines, rowDims, incomeRoleFor, utilityRoleFor, splitCents, cSql, centsOf,
  requireHomeSaleMethod, loadCompanyBooks, isUuid,
} from './tenantShared'

/** Bumped when a family-A rule changes (metadata only; the fingerprint decides). */
export const TENANT_CHARGES_RULE_VERSION = 1

/** Why a row has no charge posting of its own (null: it has one). */
export function chargeSkipReason(f: PaymentFacts): string | null {
  if (f.voided) return 'voided'
  if (f.exclusion) return f.exclusion
  if (f.reversalId) return 'reopened_by_reversal'
  if (f.isMoveOutGap) return 'move_out_balance'
  if (f.grossCents === 0) return 'zero'
  return null
}

/** The home-sale installment a home payment row bills (its own, or — for a row a part payment split off — its sibling's). */
async function installmentOf(client: PoolClient, f: PaymentFacts): Promise<{ amount: number; principal: number; interest: number } | null> {
  const r = await client.query<{ a: string; p: string; i: string }>(
    `SELECT ${cSql('i.amount')} AS a, ${cSql('i.principal_portion')} AS p, ${cSql('i.interest_portion')} AS i
       FROM home_sale_installments i
      WHERE i.id = COALESCE($1::uuid,
              (SELECT s.home_sale_installment_id FROM payments s
                WHERE s.home_sale_installment_id IS NOT NULL AND s.id <> $2::uuid
                  AND s.entry_description = 'HOMEPMT' AND s.tenant_id IS NOT DISTINCT FROM $3::uuid
                  AND s.invoice_id IS NOT DISTINCT FROM $4::uuid AND s.due_date = $5::date
                ORDER BY s.created_at, s.id LIMIT 1))`,
    [f.homeSaleInstallmentId, f.id, f.tenantId, f.invoiceId, f.dueDate])
  const row = r.rows[0]
  return row ? { amount: centsOf(row.a), principal: centsOf(row.p), interest: centsOf(row.i) } : null
}

/** Principal and interest of `gross` cents billed on an installment (in proportion when the row is not the whole installment). */
export function homePaymentSplit(gross: number, inst: { amount: number; principal: number; interest: number }): { principal: number; interest: number } {
  if (gross === inst.amount) return { principal: inst.principal, interest: inst.interest }
  const interest = inst.amount === 0 ? 0 : Math.round((gross * inst.interest) / inst.amount)
  return { principal: gross - interest, interest }
}

/**
 * The charge posting of one bill row (kind 'charge', dated its due date), or
 * null when the row has none. `co` is the row's company's books.
 */
export async function projectCharge(client: PoolClient, f: PaymentFacts, co: CompanyBooks): Promise<DesiredPosting | null> {
  if (chargeSkipReason(f)) return null
  const gross = f.grossCents
  const d = rowDims(f)
  const L = new Lines()
  let memo = 'Billed'

  if (f.workTradeSettlementId) {
    // A9 — hours not worked, billed with no bill to carry them: rent owed.
    L.dr('ar_tenants', gross, { ...d, reportCategory: 'space_rent' })
    L.cr('space_rent', gross, { ...d, reportCategory: 'space_rent' })
    memo = 'Work-trade hours not completed, billed as rent'
  } else if (f.type === 'carried_balance') {
    // A8 — a balance from before GAM: owed to the company, never income here.
    L.dr('ar_tenants', gross, { ...d, reportCategory: 'balances_collected' })
    L.cr('opening_balance_equity', gross, { ...d, reportCategory: 'opening', memo: 'Balance carried over from before GAM' })
    memo = 'Balance carried over'
  } else if (f.type === 'deposit') {
    // A4 — a refundable deposit: owed back to the tenant, never income.
    L.dr('ar_tenants', gross, { ...d, reportCategory: 'deposits' })
    L.cr('security_deposits_payable', gross, { ...d, reportCategory: 'deposits' })
    memo = 'Deposit billed'
  } else if (f.category === 'home_payments') {
    // A7 — the contract's principal and interest; the owner's method decides
    // whether the principal pays down the note or is income.
    const method = requireHomeSaleMethod(co)
    const inst = await installmentOf(client, f)
    if (!inst) {
      throw new LedgerSourceError('missing_fact', `Home payment ${f.id} names no installment, so its principal and interest are unknown.`)
    }
    const { principal, interest } = homePaymentSplit(gross, inst)
    L.dr('ar_tenants', gross, { ...d, reportCategory: 'home_payments' })
    L.cr(method === 'whole_sale_at_signing' ? 'home_notes_receivable' : 'home_sales', principal,
      { ...d, reportCategory: 'home_payments', memo: 'Principal' })
    L.cr('home_note_interest', interest, { ...d, reportCategory: 'home_payments', memo: 'Interest' })
    memo = 'Home payment billed'
  } else if (f.type === 'utility') {
    // A2 — the payment's amount is the truth; the bills say what and the tax.
    const bills = (await client.query<{ t: string; c: string; x: string }>(
      `SELECT utility_type AS t, ${cSql('charge_amount')} AS c, ${cSql('tax_amount')} AS x
         FROM utility_bills WHERE payment_id = $1 ORDER BY created_at, id`, [f.id])).rows
    L.dr('ar_tenants', gross, { ...d, reportCategory: f.category })
    if (bills.length === 0) {
      L.cr(incomeRoleFor(f), gross, { ...d, reportCategory: f.category })
    } else {
      const taxTotal = bills.reduce((s, b) => s + centsOf(b.x), 0)
      const tax = gross > 0 ? Math.max(0, Math.min(taxTotal, gross)) : 0
      L.cr('utility_tax_payable', tax, { ...d, reportCategory: 'tax_collected' })
      const parts = splitCents(gross - tax, bills.map(b => centsOf(b.c)))
      bills.forEach((b, i) => {
        L.cr(utilityRoleFor(b.t), parts[i], { ...d, reportCategory: (b.t as PaymentFacts['category']) })
      })
    }
    memo = 'Utility billed'
  } else {
    // A1 / A3 / A5 — income by what the row is.
    L.dr('ar_tenants', gross, { ...d, reportCategory: f.category })
    L.cr(incomeRoleFor(f), gross, { ...d, reportCategory: f.category })
    memo = f.category === 'late_fees' ? 'Late fee billed' : 'Billed'
  }
  if (L.empty) return null
  return { owner: { landlordId: f.landlordId }, postingKind: 'charge', intendedDate: f.dueDate, memo, lines: L.lines }
}

// ─── A7b: a home-sale installment paid outside GAM ──────────────────────────

/**
 * Design A7b: an installment stamped "paid outside GAM" (before the
 * property's first GAM bill) on or after the books start. The landlord was
 * paid directly, so it books to suspense ("paid outside GAM, to confirm") and
 * is counted as received; the principal and interest book as A7 would. One
 * stamped before the books start is part of the opening note (tenantOpening J1).
 */
export const homeInstallmentProjector: LedgerProjector = {
  sourceType: 'home_installment',
  ruleVersion: TENANT_CHARGES_RULE_VERSION,
  async project(client, sourceId) {
    if (!isUuid(sourceId)) return []
    const r = (await client.query<any>(
      `SELECT i.billing_month::text AS day, i.payment_id, i.settled_off_platform_at IS NOT NULL AS off,
              ${cSql('i.amount')} AS a, ${cSql('i.principal_portion')} AS p, ${cSql('i.interest_portion')} AS i,
              c.landlord_id, c.unit_id, c.tenant_id, c.lease_id,
              (SELECT u.property_id FROM units u WHERE u.id = c.unit_id) AS property_id
         FROM home_sale_installments i JOIN home_sale_contracts c ON c.id = i.contract_id
        WHERE i.id = $1`, [sourceId])).rows[0]
    if (!r || !r.off || r.payment_id) return []
    const co = await loadCompanyBooks(client, r.landlord_id)
    const method = requireHomeSaleMethod(co)
    const d = { propertyId: r.property_id, unitId: r.unit_id, leaseId: r.lease_id, tenantId: r.tenant_id }
    const L = new Lines()
    L.dr('suspense', centsOf(r.a), { ...d, memo: 'Home payment paid outside GAM, to confirm' })
    L.cr(method === 'whole_sale_at_signing' ? 'home_notes_receivable' : 'home_sales', centsOf(r.p),
      { ...d, reportCategory: 'home_payments', cashEffect: 'in', memo: 'Principal' })
    L.cr('home_note_interest', centsOf(r.i), { ...d, reportCategory: 'home_payments', cashEffect: 'in', memo: 'Interest' })
    if (L.empty) return []
    return [{ owner: { landlordId: r.landlord_id }, intendedDate: r.day, memo: 'Home payment paid outside GAM', lines: L.lines }]
  },
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT i.id::text AS id, i.billing_month::text AS day
         FROM home_sale_installments i JOIN home_sale_contracts c ON c.id = i.contract_id
        WHERE c.landlord_id = $1 AND i.settled_off_platform_at IS NOT NULL AND i.payment_id IS NULL
          AND ($2::date IS NULL OR i.billing_month >= $2::date)`, [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}
