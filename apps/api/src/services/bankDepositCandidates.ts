// S624 — assembling the shortlist for one inbound bank deposit.
//
// The ranking itself is pure and lives in services/bankDepositMatch.ts. This is
// the query around it: what is still owed to this landlord, and which tenants
// have claimed a deposit that could be this one.
//
// SCOPE IS THE SAFETY PROPERTY HERE. Only charges belonging to the SAME LANDLORD
// as the bank connection are ever considered. A tenant may rent from two
// landlords, and a deposit into landlord A's account must never be offered
// against a charge owed to landlord B — that is somebody else's rent, and
// settling it would take money out of one landlord's ledger to satisfy another.

import { query } from '../db'
import {
  matchDeposit, isPreselectable, memoSaysTransfer,
  type OpenCharge, type TenantDeclaredDeposit, type DepositMatch,
} from './bankDepositMatch'
import { declarationReachesSql } from './bankDepositMatch'
import { bankPayableRowSql, allocationOrderSql } from './moneyPredicates'
import { loadReportAssignment, type ReportAssignment } from './declaredDepositAssign'
import { bankLineDateTime, minutesLabel, type ReportConflictKind } from '@gam/shared'

// Step 9 review (fix pass 2): a FlexDeposit payment is GAM's custody
// collection and never bank-payable. The rule now lives in moneyPredicates
// (bankPayableRowSql applies it); re-exported for the confirm.
export { notFlexDepositRowSql, FLEX_DEPOSIT_NOT_BANK_PAYABLE } from './moneyPredicates'

/**
 * One tenant who could have made a deposit, as the owner's bank review shows it.
 * `preselect`: the screen may open with this one already picked
 * (bankDepositMatch.isPreselectable) — never on a TRANSFER memo (decisions
 * #48.1, #52): an amount-only match there needs the owner's deliberate pick.
 */
export interface DepositCandidate extends DepositMatch {
  preselect: boolean
  /**
   * 10/6 (Nic): the bill's property takes rent its tenants deposit at the bank
   * (properties.tenants_deposit_at_bank). When false the candidate is still
   * offered to a person on the review screen, but GAM never matches it by
   * itself (services/bankFeed decideDeposit; bankDepositConfirm refuses an
   * automatic confirm there too).
   */
  depositsTaken: boolean
}

export interface DepositWithCandidates {
  transactionId: string
  amount: number
  postedDate: string
  description: string | null
  /**
   * The memo says the money moved between accounts ("ONLINE TRANSFER FROM CHK
   * 1234") — most often the owner's own money (decisions #48.1). Nothing is
   * picked for them; the screen says why.
   */
  transferMemo: boolean
  candidates: DepositCandidate[]
  /**
   * 10/6 (Nic): deposits the office already logged by hand ("Bank deposit" on
   * Record payment / Post a payment) that this bank line could be — the
   * landlord ties the line to the one it is, and the bank's date then decides
   * its late fees and payment mark (services/recordedDepositMatch). Those
   * whose reference number is on the line first.
   */
  recordedDeposits: import('./recordedDepositMatch').RecordedDepositCandidate[]
  /**
   * 10/6 (Nic): the time the bank wrote on this line ("4:39 PM"), when it
   * wrote one — shown beside the hour each tenant picked.
   */
  bankTime: string | null
  /**
   * 10/6 (Nic): tenants' reports GAM will not pick between for this deposit
   * (services/declaredDepositAssign): why, in plain words, and each report
   * with its date, hour, reference and photo. The landlord picks. Null: none.
   */
  reportConflict: ReportConflictCard | null
}

/** One report on the landlord's conflict card. */
export interface ConflictReport {
  id: string
  leaseId: string
  tenantName: string
  unitNumber: string | null
  amount: number
  declaredDate: string
  hour: number | null
  afterHours: boolean
  method: 'cash' | 'check' | 'money_order'
  reference: string | null
  receiptPhotoUrl: string | null
}

export interface ReportConflictCard {
  kind: ReportConflictKind
  text: string
  reports: ConflictReport[]
}

/**
 * Open charges for one landlord, with the tenant's name for memo matching.
 *
 * S655 (money plan §3): the BANK-PAYABLE rows (moneyPredicates.bankPayableRowSql)
 * — the same set the desk and a posted payment may settle. Rent, utilities,
 * fees, late fees, home payments, and the old carried balance (it sorts last);
 * never GAM's own charges (paid online), never a line work trade covers, never
 * GAM's FlexPay collection, never a line whose money is already on its way.
 * MH 21 at Country Acres owed rent $450, water $165 and a $200 home payment —
 * exactly the $815 deposit; without the home payment the deposit tied to
 * nothing. Late fees are included: a tenant catching up may well deposit rent
 * plus last month's late fee in one go.
 *
 * The amount is what is still owed in money: the charge less any credit
 * already spent on it (v_payment_money.money_part). A FlexDeposit payment
 * (GAM's custody collection) is never one (bankPayableRowSql leaves it out).
 */
async function openChargesFor(landlordId: string): Promise<Array<OpenCharge & { depositsTaken: boolean }>> {
  const rows = await query<any>(
    `SELECT p.id, p.lease_id, p.tenant_id, p.type, p.entry_description,
            vm.money_part::float AS amount,
            to_char(p.due_date,'YYYY-MM-DD') AS due_date,
            to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            u.unit_number,
            TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,''))
              AS tenant_name,
            COALESCE(pr.tenants_deposit_at_bank, FALSE) AS deposits_taken
       FROM payments p
       JOIN v_payment_money vm ON vm.payment_id = p.id
       JOIN units u ON u.id = p.unit_id
       JOIN properties pr ON pr.id = u.property_id
       JOIN tenants t ON t.id = p.tenant_id
       JOIN users usr ON usr.id = t.user_id
      WHERE p.landlord_id = $1
        AND p.lease_id IS NOT NULL
        AND ${bankPayableRowSql('p')}
        AND vm.money_part > 0
        -- A unit in eviction hold cannot take a payment at all, so offering one
        -- would only produce a confirm that is refused downstream.
        AND u.payment_block IS NOT TRUE
      ORDER BY ${allocationOrderSql('p')}`,
    [landlordId])
  return rows.map((r: any) => ({
    id: r.id, leaseId: r.lease_id, tenantId: r.tenant_id,
    tenantName: r.tenant_name || 'Tenant', unitNumber: r.unit_number,
    amount: Number(r.amount), dueDate: r.due_date, type: r.type,
    entryDescription: r.entry_description ?? null, createdAt: r.created_at ?? null,
    depositsTaken: r.deposits_taken === true,
  }))
}

/** Claims still waiting on a bank row, within reach of this posting date. */
async function declarationsFor(
  landlordId: string, postedDate: string,
): Promise<Array<TenantDeclaredDeposit & { depositsTaken: boolean; tenantName: string; unitNumber: string | null }>> {
  const rows = await query<any>(
    `SELECT d.id, d.lease_id, d.tenant_id, d.amount::float AS amount,
            to_char(d.declared_date,'YYYY-MM-DD') AS declared_date, d.method,
            d.reference, d.receipt_photo_url, d.declared_hour, d.declared_after_hours,
            COALESCE(pr.tenants_deposit_at_bank, FALSE) AS deposits_taken,
            u.unit_number,
            TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')) AS tenant_name
       FROM tenant_declared_deposits d
       LEFT JOIN leases l ON l.id = d.lease_id
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       LEFT JOIN tenants t ON t.id = d.tenant_id
       LEFT JOIN users usr ON usr.id = t.user_id
      WHERE d.landlord_id = $1 AND d.status = 'pending'
        AND ${declarationReachesSql('d.declared_date', '$2::date')}`,
    [landlordId, postedDate])
  return rows.map((r: any) => ({
    id: r.id, leaseId: r.lease_id, tenantId: r.tenant_id,
    amount: Number(r.amount), declaredDate: r.declared_date, method: r.method,
    reference: r.reference ?? null, receiptPhotoUrl: r.receipt_photo_url ?? null,
    hour: r.declared_hour == null ? null : Number(r.declared_hour),
    afterHours: r.declared_after_hours === true,
    depositsTaken: r.deposits_taken === true,
    tenantName: r.tenant_name || 'Tenant', unitNumber: r.unit_number ?? null,
  }))
}

/**
 * The owner's "Not a rent payment" mark, a key inside
 * bank_transactions.auto_settle_undo (routes/bankFeed not-rent): the deposit is
 * never offered against tenants again, and — because the column is not empty —
 * GAM's automatic steps never act on it (services/bankFeed RECONCILABLE_SQL).
 */
export const NOT_RENT_MARK = 'notRent'

/** A match resting on the amount alone: nothing names the tenant and they reported nothing. */
const isAmountOnly = (m: DepositMatch) =>
  m.confidence === 'amount_unique' || m.confidence === 'amount_ambiguous' || m.confidence === 'carried_paydown'

/**
 * Rank who could have paid one deposit.
 *
 * 10/6 (Nic): a tenant's report is offered only on the line the one matcher
 * pairs it with (services/declaredDepositAssign) — never on every line of its
 * amount. A report it will not pick between is offered as a choice for the
 * landlord, with the reason (reportConflict). Pass `assignment` when ranking
 * several lines of one company, so the company is read once.
 */
export async function candidatesForDeposit(
  txn: {
    id: string; landlord_id: string; amount: number; posted_date: string; description: string | null
    normalized_merchant?: string | null
  },
  o: { assignment?: ReportAssignment } = {},
): Promise<DepositWithCandidates> {
  const { recordedDepositsFitting } = await import('./recordedDepositMatch')
  const { db } = await import('../db')
  const [charges, allDeclarations, recordedDeposits, assignment] = await Promise.all([
    openChargesFor(txn.landlord_id),
    declarationsFor(txn.landlord_id, txn.posted_date),
    recordedDepositsFitting(db, txn),
    o.assignment ? Promise.resolve(o.assignment) : loadReportAssignment(db, txn.landlord_id, {
      alsoLine: { id: txn.id, amount: Number(txn.amount), postedDate: txn.posted_date, description: txn.description },
    }),
  ])
  const verdict = assignment.lines.get(txn.id) ?? null
  const forThisLine = new Set<string>(
    verdict?.kind === 'assigned' ? [verdict.reportId]
      : verdict?.kind === 'conflict' ? verdict.conflict.reportIds : [])
  const declarations = allDeclarations.filter(d => forThisLine.has(d.id))
  const conflict = verdict?.kind === 'conflict' ? verdict.conflict : null
  const reportConflict: ReportConflictCard | null = conflict ? {
    kind: conflict.kind,
    text: conflict.text,
    reports: conflict.reportIds
      .map(id => allDeclarations.find(d => d.id === id))
      .filter((d): d is NonNullable<typeof d> => !!d)
      .map(d => ({
        id: d.id, leaseId: d.leaseId, tenantName: d.tenantName, unitNumber: d.unitNumber,
        amount: d.amount, declaredDate: d.declaredDate, hour: d.hour ?? null, afterHours: d.afterHours === true,
        method: d.method, reference: d.reference ?? null, receiptPhotoUrl: d.receiptPhotoUrl ?? null,
      })),
  } : null
  const lineMinutes = bankLineDateTime(txn.description, txn.posted_date).minutes
  const transferMemo = memoSaysTransfer(txn.description) || memoSaysTransfer(txn.normalized_merchant)
  // 10/6: leases at a property that does not take bank deposits from tenants.
  const offLeases = new Set<string>([
    ...charges.filter(c => !c.depositsTaken).map(c => c.leaseId),
    ...declarations.filter(d => !d.depositsTaken).map(d => d.leaseId),
  ].filter((x): x is string => !!x))
  const matches = matchDeposit(
    { amount: txn.amount, postedDate: txn.posted_date, description: txn.description },
    charges,
    { declarations, conflict: conflict?.text ?? null })
  return {
    transactionId: txn.id,
    amount: txn.amount,
    postedDate: txn.posted_date,
    description: txn.description,
    transferMemo,
    // decisions #52: an AMOUNT-ONLY match on a transfer memo is never picked
    // for the owner. A tenant's own report confirmed by the bank, or a memo
    // that names the tenant, is more than the amount (#48.1: "a tenant's own
    // report of the same amount still confirms it").
    candidates: matches.map(m => ({
      ...m,
      preselect: isPreselectable(m) && !(transferMemo && isAmountOnly(m)),
      depositsTaken: !offLeases.has(m.leaseId),
    })),
    recordedDeposits,
    bankTime: lineMinutes == null ? null : minutesLabel(lineMinutes),
    reportConflict,
  }
}

/**
 * S630 (Nic): "it should first try to match Stripe deposits... if a deposit went
 * into the landlord's bank account on a certain day, that means that money came
 * from probably Stripe or a card payment, which means that there is a link to
 * who supplied those monies."
 *
 * The shortlist above is built from what is still UNPAID, which is why an
 * unplaceable $1,300 came back as "doesn't match any pending rent charges" — of
 * course it doesn't. Money that has already landed in the bank came from
 * payments that already SETTLED and were paid out, and those carry a Stripe
 * reference and a payer.
 *
 * So this looks the other way: settled rent around the same date, who paid it,
 * and whether any single one is the deposit exactly. It answers "who sent me
 * this" rather than "what could I apply it to".
 */
export interface SettledPayer {
  tenantName: string; unitNumber: string | null
  amount: number; settledAt: string | null
  viaStripe: boolean
}

export async function settledPayersAround(
  landlordId: string, postedDate: string, amount: number, windowDays = 6,
): Promise<{ exact: SettledPayer[]; nearby: SettledPayer[] }> {
  const rows = await query<any>(
    `SELECT p.amount::float AS amount,
            to_char(p.settled_at,'YYYY-MM-DD') AS settled_at,
            (p.stripe_payment_intent_id IS NOT NULL OR p.stripe_charge_id IS NOT NULL) AS via_stripe,
            u.unit_number,
            TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')) AS tenant_name
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       JOIN tenants t ON t.id = p.tenant_id
       JOIN users usr ON usr.id = t.user_id
      WHERE p.landlord_id = $1
        AND p.status = 'settled'
        AND p.settled_at IS NOT NULL
        AND p.settled_at >= ($2::date - ($3 || ' days')::interval)
        AND p.settled_at <= ($2::date + ($3 || ' days')::interval)
      ORDER BY p.settled_at DESC`,
    [landlordId, postedDate, windowDays])
  const all: SettledPayer[] = rows.map((r: any) => ({
    tenantName: r.tenant_name || 'Tenant', unitNumber: r.unit_number ?? null,
    amount: Number(r.amount), settledAt: r.settled_at ?? null, viaStripe: !!r.via_stripe,
  }))
  const cents = (n: number) => Math.round(n * 100)
  return {
    exact: all.filter((p) => cents(p.amount) === cents(amount)),
    nearby: all.filter((p) => cents(p.amount) !== cents(amount)).slice(0, 12),
  }
}

/**
 * Every unmatched inbound deposit for a landlord, each with its shortlist.
 *
 * Bounded: a landlord returning after months away has a long feed, and building
 * a shortlist per row is real work. The cap is on the QUERY, not silently on the
 * result — the caller reports how many were left.
 */
/**
 * A deposit the owner set aside as "Not a rent payment" that still waits on
 * the Bank feed (needs_review) — what the owner's bank review lists, each with
 * its Undo, for as long as it waits. Read from the bank row's own mark, so the
 * note and its Undo survive a reload, a company switch, leaving the page, and
 * a deposit the landlord assistant set aside (no screen ever held a note for
 * that one).
 */
export interface SetAsideDeposit {
  transactionId: string; amount: number; postedDate: string
  description: string | null; setAt: string | null
}

/** How many set-aside deposits the review lists (newest set aside first); the rest are counted. */
export const SET_ASIDE_SHOWN = 20

export async function unmatchedDepositsWithCandidates(
  landlordId: string, limit = 50,
): Promise<{ deposits: DepositWithCandidates[]; remaining: number; setAside: SetAsideDeposit[]; setAsideRemaining: number }> {
  const rows = await query<any>(
    `SELECT id, landlord_id, amount::float AS amount,
            to_char(posted_date,'YYYY-MM-DD') AS posted_date, description, normalized_merchant,
            COUNT(*) OVER ()::int AS total
       FROM bank_transactions
      WHERE landlord_id = $1 AND status = 'needs_review' AND amount > 0
        -- The owner said "Not a rent payment" (routes/bankFeed not-rent): it
        -- waits on the Bank feed to be filed, never offered against tenants again.
        AND NOT (COALESCE(auto_settle_undo, '{}'::jsonb) ? '${NOT_RENT_MARK}')
      ORDER BY posted_date DESC
      LIMIT $2`, [landlordId, limit])
  const total = rows[0]?.total ?? 0
  // 10/6: the company's reports and lines paired once for the whole list.
  const { db } = await import('../db')
  const assignment = await loadReportAssignment(db, landlordId)
  const deposits = await Promise.all(rows.map((r: any) => candidatesForDeposit(r, { assignment })))
  const aside = await query<any>(
    `SELECT id, amount::float AS amount, to_char(posted_date,'YYYY-MM-DD') AS posted_date, description,
            auto_settle_undo -> '${NOT_RENT_MARK}' ->> 'at' AS set_at,
            COUNT(*) OVER ()::int AS total
       FROM bank_transactions
      WHERE landlord_id = $1 AND status = 'needs_review' AND amount > 0
        AND COALESCE(auto_settle_undo, '{}'::jsonb) ? '${NOT_RENT_MARK}'
      ORDER BY (auto_settle_undo -> '${NOT_RENT_MARK}' ->> 'at') DESC NULLS LAST, posted_date DESC, id
      LIMIT $2`, [landlordId, SET_ASIDE_SHOWN])
  const setAside: SetAsideDeposit[] = aside.map((r: any) => ({
    transactionId: r.id, amount: Number(r.amount), postedDate: r.posted_date,
    description: r.description ?? null, setAt: r.set_at ?? null,
  }))
  return {
    deposits, remaining: Math.max(0, total - rows.length),
    setAside, setAsideRemaining: Math.max(0, (aside[0]?.total ?? 0) - aside.length),
  }
}
