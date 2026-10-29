/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P4, FAMILY B: TENANT MONEY IN
 * (gam-ledger-design-2026-10-12 §6 B1-B10)
 *
 *   Nic 10/12: "charges recorded when billed AND payments when received (both
 *   always)"; "money GAM collected but not yet paid out = held by GAM until
 *   the payout lands"; "paid-ahead money GAM holds is NOT on the landlord's
 *   balance sheet until it pays a bill" (L13).
 *
 * A RECEIPT (tenant_remittances, key `remittance:<id>`) posts on the day it
 * settled, ONE posting per company (one receipt can pay two companies' rows),
 * one line per bill row it paid at the amount applied, each counted as money
 * received under the row's category:
 *
 *   B1  card or bank payment through GAM   Dr 1050 Due from GAM (money GAM
 *       collected, held until the payout lands); a deposit row: Dr 1070
 *       Deposits GAM holds (deposit_collected_by 'gam'), or the bank for an
 *       old destination charge ('landlord')
 *   B3  cash, check, money order at the desk   Dr 1040 Undeposited funds
 *       bank_deposit (the tenant put it in the landlord's bank)   Dr 1045
 *       Deposits in transit, until the bank line is matched (bank_match)
 *   B4  money posted ahead of a bill        the receipt's surplus, kept as
 *       paid-ahead money the LANDLORD holds: Cr 2050 Tenant prepayments
 *       (counted as received when it arrives). Paid-ahead money GAM holds (a
 *       card or bank surplus) books nothing now (Nic L13; it books when it
 *       pays a bill, tenantCredits C1).
 *   B5/B6 a bank line matched to a bank_deposit receipt (`bank_match:<line>`,
 *       the bank's posted day): Dr the bank account / Cr 1045. One rule for a
 *       deposit the bank feed found (B5) and one the office logged by hand and
 *       the bank later showed (B6).
 *   a prepaid move-in box (revenue_owner 'held') paid at the desk: Cr 2050 —
 *       the landlord holds it as paid-ahead money; paid online it is GAM's to
 *       hold and books nothing (L13).
 * Undone receipts (undone_at) and failed ones post nothing — an undo is a
 * correction. A receipt never posts a row of GAM's, the FlexPay pull or a
 * FlexDeposit installment (design §6 K).
 *
 * THE BILL ROW ITSELF (key `payment:<id>`) posts how it was settled when no
 * receipt did:
 *   B7  prior arrangement (rent paid before GAM, kind 'prior_arrangement'):
 *       Dr 1099 "paid before GAM, to confirm" / Cr receivables, received.
 *       (Nic L20: Oak Park's DoorLoop deposits stay unmatched for now, so the
 *       design's B7m bank match is not built; see the lane report.)
 *   B10 a bill GAM covered (flexpay_advance_id, no receipt; kind 'gam_cover'):
 *       Dr 1050 / Cr receivables, received, memo "Paid on time" (never the
 *       product's name).
 *
 *   B8  a deposit slip matched to a bank line (`deposit_slip:<id>`): the bag
 *       of desk receipts and register cash reached the bank — Dr the bank /
 *       Cr 1040, split by each item's property; "other money" on the slip
 *       moves the same way (its income is filed as other income, P6).
 *   B9  a register day's drawer over or short (`pos_eod:<id>`): 5195 Cash over
 *       and short against 1040.
 */
import type { PoolClient } from 'pg'
import type { LedgerAccountRole } from '@gam/shared'
import type { DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import {
  type PaymentFacts, Lines, rowDims, loadPaymentFacts, cSql, centsOf, localDaySql, propertyTzSql, leasePropertySql,
  companyTzSql, isUuid,
} from './tenantShared'

export const TENANT_RECEIPTS_RULE_VERSION = 1

/** How a receipt's money arrived, and the account it lands in (design B1, B3). */
export function receiptCashRole(method: string | null): LedgerAccountRole | null {
  switch (method) {
    case 'card': case 'ach': return 'due_from_gam'
    case 'cash': case 'check': case 'money_order': return 'undeposited_funds'
    case 'bank_deposit': return 'deposits_in_transit'
    default: return null
  }
}

const ONLINE = new Set(['card', 'ach'])

/** One company's part of a receipt, as lines (before the posting is made). */
interface CompanyPart { lines: Lines; debits: Map<string, { role: LedgerAccountRole; cents: number; propertyId: string | null; leaseId: string | null }> }

/**
 * The postings of one receipt (B1, B3, B4, B5). Also used by the bank match
 * and deposit slips, which move what a receipt put in 1040 / 1045.
 */
export async function projectRemittance(client: PoolClient, remittanceId: string): Promise<DesiredPosting[]> {
  if (!isUuid(remittanceId)) return []
  const r = (await client.query<{
    landlord_id: string; status: string; payment_method: string | null; undone: boolean; day: string | null
  }>(
    `SELECT r.landlord_id, r.status, r.payment_method, r.undone_at IS NOT NULL AS undone,
            ${localDaySql('r.settled_at', 'z.tz')} AS day
       FROM tenant_remittances r
       CROSS JOIN LATERAL (SELECT ${propertyTzSql(leasePropertySql('r.lease_id'), 'r.landlord_id')} AS tz) z
      WHERE r.id = $1`, [remittanceId])).rows[0]
  if (!r || r.status !== 'settled' || r.undone || !r.day) return []
  const cashRole = receiptCashRole(r.payment_method)
  if (!cashRole) return []
  const online = ONLINE.has(r.payment_method!)

  const apps = (await client.query<{ payment_id: string; c: string }>(
    `SELECT ra.payment_id, ${cSql('ra.amount_applied')} AS c
       FROM remittance_applications ra JOIN payments p ON p.id = ra.payment_id
      WHERE ra.remittance_id = $1 ORDER BY p.due_date, p.created_at, ra.payment_id`, [remittanceId])).rows
  const facts = await loadPaymentFacts(client, apps.map(a => a.payment_id))
  // Paid-ahead money this receipt banked that the LANDLORD holds (Nic L13:
  // GAM-held money books nothing until it pays a bill).
  const credits = (await client.query<{
    id: string; landlord_id: string; lease_id: string; tenant_id: string; property_id: string | null; c: string
  }>(
    `SELECT pc.id, l.landlord_id, COALESCE(pc.received_lease_id, pc.lease_id) AS lease_id, pc.tenant_id,
            ${leasePropertySql('COALESCE(pc.received_lease_id, pc.lease_id)')} AS property_id,
            ${cSql('pc.amount_original')} AS c
       FROM lease_prepaid_credits pc
       JOIN leases l ON l.id = COALESCE(pc.received_lease_id, pc.lease_id)
      WHERE pc.source_remittance_id = $1 AND pc.voided_at IS NULL AND pc.funded_by = 'landlord'
      ORDER BY pc.created_at, pc.id`, [remittanceId])).rows

  const parts = new Map<string, CompanyPart>()
  const partOf = (landlordId: string): CompanyPart => {
    let p = parts.get(landlordId)
    if (!p) { p = { lines: new Lines(), debits: new Map() }; parts.set(landlordId, p) }
    return p
  }
  const debit = (p: CompanyPart, role: LedgerAccountRole, cents: number, propertyId: string | null, leaseId: string | null) => {
    const k = `${role}|${propertyId ?? ''}|${role === 'deposits_gam_holds' ? leaseId ?? '' : ''}`
    const e = p.debits.get(k) ?? { role, cents: 0, propertyId, leaseId: role === 'deposits_gam_holds' ? leaseId : null }
    e.cents += cents
    p.debits.set(k, e)
  }

  for (const a of apps) {
    const f = facts.get(a.payment_id)
    const cents = centsOf(a.c)
    if (!f || cents === 0) continue
    if (f.exclusion === 'gam' || f.exclusion === 'flex_deposit' || f.exclusion === 'move_out_refund') continue
    const p = partOf(f.landlordId)
    const d = rowDims(f)
    if (f.exclusion === 'held_box') {
      // A prepaid move-in box: paid online it is GAM's to hold (L13); paid at
      // the desk the landlord holds it as the tenant's paid-ahead money.
      if (online) continue
      p.lines.cr('tenant_prepayments', cents, { ...d, reportCategory: 'paid_ahead', cashEffect: 'in', memo: 'Paid ahead (move-in)' })
      debit(p, cashRole, cents, f.propertyId, f.leaseId)
      continue
    }
    if (f.type === 'deposit') {
      const holds: LedgerAccountRole = online
        ? (f.depositCollectedBy === 'landlord' ? 'bank_checking' : 'deposits_gam_holds')
        : cashRole
      p.lines.cr('ar_tenants', cents, { ...d, reportCategory: 'deposits', cashEffect: 'in' })
      debit(p, holds, cents, f.propertyId, f.leaseId)
      continue
    }
    p.lines.cr('ar_tenants', cents, { ...d, reportCategory: f.category, cashEffect: 'in' })
    debit(p, cashRole, cents, f.propertyId, f.leaseId)
  }
  if (!online) {
    for (const c of credits) {
      const cents = centsOf(c.c)
      if (cents === 0) continue
      const p = partOf(c.landlord_id)
      p.lines.cr('tenant_prepayments', cents, {
        propertyId: c.property_id, leaseId: c.lease_id, tenantId: c.tenant_id,
        reportCategory: 'paid_ahead', cashEffect: 'in', memo: 'Paid ahead',
      })
      debit(p, cashRole, cents, c.property_id, c.lease_id)
    }
  }

  const memo = online ? 'Payment received through GAM'
    : r.payment_method === 'bank_deposit' ? 'Bank deposit received' : 'Payment received at the desk'
  const out: DesiredPosting[] = []
  for (const [landlordId, p] of [...parts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const e of p.debits.values()) {
      p.lines.dr(e.role, e.cents, { propertyId: e.propertyId, leaseId: e.leaseId })
    }
    if (!p.lines.empty) out.push({ owner: { landlordId }, intendedDate: r.day, memo, lines: p.lines.lines })
  }
  return out
}

export const remittanceProjector: LedgerProjector = {
  sourceType: 'remittance',
  ruleVersion: TENANT_RECEIPTS_RULE_VERSION,
  project: (client, sourceId) => projectRemittance(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    // Receipts of the company, and receipts of another company that paid one
    // of this company's rows.
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT r.id::text AS id, ${localDaySql('r.settled_at', companyTzSql('r.landlord_id'))} AS day
         FROM tenant_remittances r
        WHERE (r.landlord_id = $1
               OR EXISTS (SELECT 1 FROM remittance_applications ra JOIN payments p ON p.id = ra.payment_id
                           WHERE ra.remittance_id = r.id AND p.landlord_id = $1))
          AND ($2::date IS NULL OR r.settled_at IS NULL OR r.settled_at >= ($2::date - 1))`,
      [owner.landlordId, opts.since ?? null])
    return r.rows.map(x => ({ id: x.id, day: x.day }))
  },
}

// ─── B7 / B10: a bill row settled with no receipt ───────────────────────────

/**
 * The settlement postings of a bill row that no receipt paid: a prior
 * arrangement (B7) or a bill GAM covered (B10). Each counts as money received
 * on the day the row settled.
 */
export function projectRowSettlement(f: PaymentFacts): DesiredPosting[] {
  if (f.voided || f.exclusion || f.status !== 'settled' || !f.settledDay) return []
  const money = f.moneyCents
  if (money === 0) return []
  const d = rowDims(f)
  if (f.manualMethod === 'prior_arrangement') {
    const L = new Lines()
    L.dr('suspense', money, { ...d, memo: 'Paid before GAM, to confirm' })
    L.cr('ar_tenants', money, { ...d, reportCategory: f.category, cashEffect: 'in' })
    return [{ owner: { landlordId: f.landlordId }, postingKind: 'prior_arrangement', intendedDate: f.settledDay,
      memo: 'Paid before GAM', lines: L.lines }]
  }
  if (f.flexpayAdvanceId && !f.hasSettledApplication && f.revenueOwner === 'landlord' && !f.manualMethod) {
    const L = new Lines()
    L.dr('due_from_gam', money, { ...d, memo: 'Paid on time' })
    L.cr('ar_tenants', money, { ...d, reportCategory: f.category, cashEffect: 'in' })
    return [{ owner: { landlordId: f.landlordId }, postingKind: 'gam_cover', intendedDate: f.settledDay,
      memo: 'Paid on time', lines: L.lines }]
  }
  return []
}

// ─── B5 / B6: a bank line matched to a bank-deposit receipt ─────────────────

/**
 * The bank line a receipt was matched to (bank_transactions.auto_settle_undo
 * names the receipt for both a deposit the feed settled and one the office
 * logged by hand): what the receipt put in deposits in transit (or the
 * drawer) is now in that bank account, on the bank's posted day.
 */
export async function projectBankMatchTenant(client: PoolClient, bankTransactionId: string): Promise<DesiredPosting[]> {
  if (!isUuid(bankTransactionId)) return []
  const t = (await client.query<{
    landlord_id: string; bank_connection_id: string; posted_date: string; status: string; receipt_id: string | null
    returned_receipt_id: string | null; amount_c: string
  }>(
    `SELECT bt.landlord_id, bt.bank_connection_id, bt.posted_date::text AS posted_date, bt.status,
            bt.auto_settle_undo->>'receiptId' AS receipt_id,
            CASE WHEN bt.auto_settle_undo->>'kind' = 'returned_check' THEN bt.auto_settle_undo->>'returnedReceiptId' END
              AS returned_receipt_id,
            ${cSql('bt.amount')} AS amount_c
       FROM bank_transactions bt WHERE bt.id = $1`, [bankTransactionId])).rows[0]
  if (t && t.status === 'matched' && t.returned_receipt_id && isUuid(t.returned_receipt_id)) {
    return projectReturnedCheck(client, { ...t, returned_receipt_id: t.returned_receipt_id })
  }
  if (!t || t.status !== 'matched' || !t.receipt_id || !isUuid(t.receipt_id)) return []
  const receipt = await projectRemittance(client, t.receipt_id)
  const own = receipt.find(p => p.owner.landlordId === t.landlord_id)
  if (!own) return []
  const L = new Lines()
  for (const l of own.lines) {
    if ((l.role === 'deposits_in_transit' || l.role === 'undeposited_funds') && (l.debitCents ?? 0) > 0) {
      L.dr('bank_checking', l.debitCents!, { propertyId: l.propertyId, sub: { kind: 'bank_connection', value: t.bank_connection_id } })
      L.cr(l.role, l.debitCents!, { propertyId: l.propertyId })
    }
  }
  if (L.empty) return []
  return [{ owner: { landlordId: t.landlord_id }, intendedDate: t.posted_date, memo: 'Deposit reached the bank', lines: L.lines }]
}

/** What a receipt paid, by the property of each line (company level for a line on no unit). */
async function receiptPropertySplit(client: PoolClient, remittanceId: string): Promise<Array<{ propertyId: string | null; cents: number }>> {
  return (await client.query<{ property_id: string | null; c: string }>(
    `SELECT u.property_id, ${cSql('SUM(ra.amount_applied)')} AS c
       FROM remittance_applications ra
       JOIN payments p ON p.id = ra.payment_id
       LEFT JOIN units u ON u.id = p.unit_id
      WHERE ra.remittance_id = $1
      GROUP BY u.property_id ORDER BY u.property_id NULLS LAST`, [remittanceId])).rows
    .map(r => ({ propertyId: r.property_id, cents: centsOf(r.c) }))
}

/**
 * 10/14 (Nic, answer 15): a check the bank returned out of a deposit slip,
 * taken back (services/returnedCheck). The slip already moved that check from
 * the drawer into the bank (B8: Dr bank / Cr Undeposited funds); its receipt
 * is taken back — as the whole-deposit bounce and the deposit Undo take a
 * receipt back, so the books and the money records (incomeBasis) agree — and
 * the ledger engine posts that as a correction (on the day it was made or
 * restated, per the company's choice; never inside a closed month). The
 * bank's returned-item line puts the check back: Dr Undeposited funds / Cr
 * the bank, on the bank's day, property by property as the check paid
 * (ledgerTenantChecks undepositedFundsCheck counts it). Counted once.
 */
async function projectReturnedCheck(client: PoolClient, t: {
  landlord_id: string; bank_connection_id: string; posted_date: string; returned_receipt_id: string; amount_c: string
}): Promise<DesiredPosting[]> {
  const cents = -centsOf(t.amount_c)
  if (cents <= 0) return []
  const parts = await receiptPropertySplit(client, t.returned_receipt_id)
  const L = new Lines()
  const bank = { sub: { kind: 'bank_connection' as const, value: t.bank_connection_id } }
  if (parts.length && parts.reduce((x, p) => x + p.cents, 0) === cents) {
    for (const p of parts) {
      L.dr('undeposited_funds', p.cents, { propertyId: p.propertyId })
      L.cr('bank_checking', p.cents, { propertyId: p.propertyId, ...bank })
    }
  } else {
    const propertyId = parts[0]?.propertyId ?? null
    L.dr('undeposited_funds', cents, { propertyId })
    L.cr('bank_checking', cents, { propertyId, ...bank })
  }
  return [{ owner: { landlordId: t.landlord_id }, intendedDate: t.posted_date, memo: 'Check returned by the bank', lines: L.lines }]
}

export const bankMatchTenantProjector: LedgerProjector = {
  sourceType: 'bank_match',
  ruleVersion: TENANT_RECEIPTS_RULE_VERSION,
  project: (client, sourceId) => projectBankMatchTenant(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT bt.id::text AS id, bt.posted_date::text AS day FROM bank_transactions bt
        WHERE bt.landlord_id = $1 AND bt.status = 'matched'
          AND (bt.auto_settle_undo ? 'receiptId' OR bt.auto_settle_undo->>'kind' = 'returned_check')
          AND ($2::date IS NULL OR bt.posted_date >= $2::date)`, [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

// ─── B8: a deposit slip matched to a bank line ──────────────────────────────

export async function projectDepositSlip(client: PoolClient, slipId: string): Promise<DesiredPosting[]> {
  if (!isUuid(slipId)) return []
  const s = (await client.query<{
    landlord_id: string; property_id: string | null; status: string; voided: boolean; other_c: string
    bank_connection_id: string | null; day: string | null; bt_landlord: string | null
  }>(
    `SELECT s.landlord_id, s.property_id, s.status, s.voided_at IS NOT NULL AS voided, ${cSql('s.other_amount')} AS other_c,
            bt.bank_connection_id, COALESCE(bt.posted_date, s.deposit_date)::text AS day, bt.landlord_id AS bt_landlord
       FROM bank_deposit_slips s LEFT JOIN bank_transactions bt ON bt.id = s.bank_transaction_id
      WHERE s.id = $1`, [slipId])).rows[0]
  if (!s || s.status !== 'matched' || s.voided || !s.bank_connection_id || !s.day) return []
  const items = (await client.query<{ remittance_id: string | null; pos_property: string | null; c: string }>(
    `SELECT i.remittance_id, t.property_id AS pos_property, ${cSql('i.amount')} AS c
       FROM bank_deposit_slip_items i LEFT JOIN pos_transactions t ON t.id = i.pos_transaction_id
      WHERE i.slip_id = $1 AND i.voided_at IS NULL ORDER BY i.created_at, i.id`, [slipId])).rows
  const byProperty = new Map<string, number>()
  const add = (prop: string | null, cents: number) => byProperty.set(prop ?? '', (byProperty.get(prop ?? '') ?? 0) + cents)
  for (const it of items) {
    const cents = centsOf(it.c)
    if (!it.remittance_id) { add(it.pos_property ?? s.property_id, cents); continue }
    // A receipt's cash sits in the drawer by the properties its lines paid.
    const own = (await projectRemittance(client, it.remittance_id)).find(p => p.owner.landlordId === s.landlord_id)
    const drawer = (own?.lines ?? []).filter(l => l.role === 'undeposited_funds' && (l.debitCents ?? 0) > 0)
    const total = drawer.reduce((x, l) => x + (l.debitCents ?? 0), 0)
    if (total === cents && drawer.length) { for (const l of drawer) add(l.propertyId ?? null, l.debitCents!); continue }
    // 10/14 (Nic, answer 15): a check the bank returned out of this slip is
    // taken back (its receipt posts nothing now); it still went into the bank
    // by the properties its lines paid, which is where the bank's returned-item
    // line puts it back (projectReturnedCheck) — the same split both ways.
    const paid = drawer.length ? [] : await receiptPropertySplit(client, it.remittance_id)
    if (paid.length && paid.reduce((x, p) => x + p.cents, 0) === cents) for (const p of paid) add(p.propertyId, p.cents)
    else add(drawer[0]?.propertyId ?? s.property_id, cents)
  }
  add(s.property_id, centsOf(s.other_c))
  const L = new Lines()
  for (const [k, cents] of [...byProperty.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const propertyId = k === '' ? null : k
    L.dr('bank_checking', cents, { propertyId, sub: { kind: 'bank_connection', value: s.bank_connection_id } })
    L.cr('undeposited_funds', cents, { propertyId })
  }
  if (L.empty) return []
  return [{ owner: { landlordId: s.landlord_id }, intendedDate: s.day, memo: 'Deposit slip reached the bank', lines: L.lines }]
}

export const depositSlipProjector: LedgerProjector = {
  sourceType: 'deposit_slip',
  ruleVersion: TENANT_RECEIPTS_RULE_VERSION,
  project: (client, sourceId) => projectDepositSlip(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT s.id::text AS id, COALESCE(bt.posted_date, s.deposit_date)::text AS day
         FROM bank_deposit_slips s LEFT JOIN bank_transactions bt ON bt.id = s.bank_transaction_id
        WHERE s.landlord_id = $1 AND ($2::date IS NULL OR COALESCE(bt.posted_date, s.deposit_date) >= $2::date)`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

// ─── B9: the register drawer over or short ──────────────────────────────────

export const posEodProjector: LedgerProjector = {
  sourceType: 'pos_eod',
  ruleVersion: TENANT_RECEIPTS_RULE_VERSION,
  async project(client, sourceId) {
    if (!isUuid(sourceId)) return []
    const e = (await client.query<{ landlord_id: string; property_id: string; day: string; status: string; v: string | null }>(
      `SELECT landlord_id, property_id, business_day::text AS day, status,
              CASE WHEN cash_drawer_variance IS NULL THEN NULL ELSE ${cSql('cash_drawer_variance')} END AS v
         FROM pos_eod_settlements WHERE id = $1`, [sourceId])).rows[0]
    // A reopened day is being counted again: nothing until it closes.
    if (!e || e.status === 'reopened' || e.v === null) return []
    const v = centsOf(e.v)
    if (v === 0) return []
    const L = new Lines()
    // Over (actual > expected): more cash in the drawer. Short: less.
    L.dr('undeposited_funds', v, { propertyId: e.property_id, memo: v > 0 ? 'Drawer over' : 'Drawer short' })
    L.cr('cash_over_short', v, { propertyId: e.property_id })
    return [{ owner: { landlordId: e.landlord_id }, intendedDate: e.day, memo: 'Register drawer count', lines: L.lines }]
  },
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT id::text AS id, business_day::text AS day FROM pos_eod_settlements
        WHERE landlord_id = $1 AND ($2::date IS NULL OR business_day >= $2::date)`, [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}
