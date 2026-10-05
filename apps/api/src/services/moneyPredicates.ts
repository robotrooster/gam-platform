// S655 money plan §1.5 (Step 1): what a charge IS for every money path, each
// rule written once.
//
// Before this, "what is owed" was a different WHERE clause in the portal charge,
// the desk, the bank-deposit match, the balance query and both agents, and they
// disagreed at the edges (a row whose retry was in flight, a home payment, a
// neighbor's utility, a GAM fee). Every path now builds its query from these
// fragments, and the database trigger on credit_uses (M4) enforces the
// credit-eligibility rule the same way, so code and schema cannot drift (the
// parity is tested in moneyPredicates.test.ts).
//
// Each *Sql(a) returns a parenthesized boolean SQL fragment over the payments
// row aliased `a`. Each is*Row(row) is the same rule over a row already read,
// for code that plans in memory (the credit planner, the desk preview).
//
// lockHousehold is the one lock every writer takes before it reads or touches a
// household's charges or credits (§3: "household, then leases sorted, then rows
// by id"), so a tenant, a co-tenant, the desk, a webhook and the bill run can
// never interleave on the same money.

import type { PoolClient } from 'pg'
import { ALLOCATION_TYPE_ORDER } from '@gam/shared'

// ─── SQL-fragment hygiene ─────────────────────────────────────────────────────

const IDENT = /^[a-z_][a-z0-9_]*$/i
// A placeholder ($2, $2::uuid) or a column reference (l.id, lease_id).
const REF = /^(\$\d+(::uuid)?|[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?)$/i

/** Only a bare identifier is ever interpolated as an alias. */
function alias(a: string): string {
  if (!IDENT.test(a)) throw new Error(`moneyPredicates: "${a}" is not a table alias`)
  return a
}
function ref(r: string): string {
  if (!REF.test(r)) throw new Error(`moneyPredicates: "${r}" is not a placeholder or column`)
  return r
}

// ─── The rules ────────────────────────────────────────────────────────────────

/** Charge types credit may pay (M4 trigger). */
export const CREDIT_ELIGIBLE_TYPES = ['rent', 'utility', 'late_fee', 'fee'] as const
/** Entries credit never pays: GAM's FlexPay pull, a home/trailer payment (M4 trigger). */
export const CREDIT_INELIGIBLE_ENTRIES = ['FLEXPAY', 'HOMEPMT'] as const
/** Who may take money at the desk, by bank deposit or by a posted payment. */
export const BANK_PAYABLE_OWNERS = ['landlord', 'held'] as const

/**
 * Nothing is moving on it and money is owed on it now, so a payer may settle it:
 *   pending with no intent, or failed (a failed row with a retry scheduled is
 *   payable; claiming it supersedes that retry — creditUse.supersedeScheduledRetry);
 *   not work-trade suspended (labor is paying it); not GAM's FlexPay pull (never
 *   part of a tenant balance); more than $0.
 * A row whose retry is in flight is 'processing', so it is not payable.
 */
export function payableRowSql(a = 'p'): string {
  const x = alias(a)
  return `(${x}.status IN ('pending','failed')
      AND (${x}.status = 'failed' OR ${x}.stripe_payment_intent_id IS NULL)
      AND ${x}.work_trade_suspended_at IS NULL
      AND ${x}.entry_description IS DISTINCT FROM 'FLEXPAY'
      AND ${x}.amount > 0)`
}

/**
 * The portal and autopay pay-in-full set for ONE lease: every payable row of
 * the lease, plus every payable row on the lease's invoices (a neighbor
 * landlord's utility on a converged invoice, S616; GAM's own fees), but never a
 * carried-forward balance (S622: paid last, optional, may be partial).
 * `leaseRef` is a placeholder ('$2') or a column ('l.id').
 */
export function requiredRowSql(a: string, leaseRef: string): string {
  const x = alias(a)
  const lease = ref(leaseRef)
  return `(${payableRowSql(x)}
      AND (${x}.lease_id = ${lease}
           OR ${x}.invoice_id IN (SELECT inv_req.id FROM invoices inv_req WHERE inv_req.lease_id = ${lease}))
      AND ${x}.type <> 'carried_balance')`
}

/**
 * A payment toward a FlexDeposit deposit — an installment pull, a pay-ahead —
 * is GAM's custody collection, paid online to GAM. Its row is a plain
 * 'deposit' row with no lease fee and revenue_owner 'landlord', so without
 * this rule the desk, a bank deposit or the agent's cash tool would take it,
 * and a landlord could take cash for GAM's custody money: leaseFeesSync skips
 * FlexDeposit records, so GAM's record would never count it and move-out would
 * never return it. True when the row (alias `a`) is NOT one.
 * (Moved here from bankDepositCandidates, Step 9 review fix pass 2.)
 */
export function notFlexDepositRowSql(a = 'p'): string {
  const x = alias(a)
  return `NOT (${x}.type = 'deposit' AND ${x}.lease_fee_id IS NULL
          AND EXISTS (SELECT 1 FROM security_deposits fdx
                       WHERE fdx.lease_id = ${x}.lease_id AND fdx.flex_deposit_enabled IS TRUE))`
}

/**
 * The flex_deposit fact for isBankPayableRow, as a SELECT expression over the
 * payments row aliased `a`: TRUE when the row is a FlexDeposit payment.
 */
export function flexDepositFactSql(a = 'p'): string {
  return `(NOT ${notFlexDepositRowSql(a)})`
}

/** Said when a FlexDeposit payment is picked for the desk or a bank deposit. */
export const FLEX_DEPOSIT_NOT_BANK_PAYABLE =
  'One of those charges is a FlexDeposit installment — it is paid online to GAM, so a bank deposit can’t pay it. Leave it out.'

/**
 * What the desk, a bank deposit and a posted payment may settle: payable rows
 * whose money is the landlord's (or held for the tenant: a prepaid move-in box
 * paid at the desk becomes landlord-held paid-ahead money). Includes home
 * payments and carried balances (carried sorts last). GAM's own charges are
 * left for an online payment, and so is a FlexDeposit payment (GAM's custody
 * collection, notFlexDepositRowSql). A move-out refund row is negative, so the
 * $0 floor in payableRowSql already keeps it out.
 */
export function bankPayableRowSql(a = 'p'): string {
  const x = alias(a)
  return `(${payableRowSql(x)}
      AND ${x}.revenue_owner IN ('landlord','held')
      AND ${notFlexDepositRowSql(x)})`
}

/**
 * What the landlord's desk (record-manual, the desk window) may settle: every
 * payable row except a FlexDeposit payment, which only GAM collects. The
 * desk's own owner rules sit on top of this.
 */
export function deskPayableRowSql(a = 'p'): string {
  const x = alias(a)
  return `(${payableRowSql(x)}
      AND ${notFlexDepositRowSql(x)})`
}

/**
 * A security-deposit charge or a move-out row (refund or shortfall): DEPOSIT
 * with no lease fee behind it. A non-refundable pet, key, cleaning or utility
 * "deposit" fee carries its lease_fee_id and is an ordinary fee.
 */
export function depositOrMoveOutRowSql(a = 'p'): string {
  const x = alias(a)
  return `(${x}.entry_description = 'DEPOSIT' AND ${x}.lease_fee_id IS NULL)`
}

/**
 * Payable, and a charge credit may pay. Exactly the M4 trigger's rule
 * (credit_uses_apply), which also requires the use to be on the row's own lease:
 *   the landlord's money; rent, utility, late fee or fee; not FlexPay or a home
 *   payment; not a deposit or move-out row; not reopened after a dispute; on a
 *   unit and a lease. (A row a dispute reopened takes only the credit that
 *   dispute gave back — creditEligibleRowForCreditSql, decisions #48.7.)
 */
export function creditEligibleRowSql(a = 'p'): string {
  const x = alias(a)
  return `(${creditEligibleBaseSql(x)}
      AND ${x}.reversal_id IS NULL)`
}

/** The credit rule without its reopened-row term (shared by the two below). */
function creditEligibleBaseSql(x: string): string {
  return `(${payableRowSql(x)}
      AND ${x}.revenue_owner = 'landlord'
      AND ${x}.type IN ('rent','utility','late_fee','fee')
      AND ${x}.entry_description NOT IN ('FLEXPAY','HOMEPMT')
      AND NOT ${depositOrMoveOutRowSql(x)}
      AND ${x}.unit_id IS NOT NULL
      AND ${x}.lease_id IS NOT NULL)`
}

/**
 * decisions #48.7: the paid-ahead credits a dispute GAVE BACK on the row it
 * reopened (alias `a`, reversal_id set) — each credit whose spend on the
 * disputed original that dispute undid (credit_uses 'reversed'). As a SQL
 * uuid[] expression; empty for any other row. Read it as the
 * dispute_credit_ids fact for isCreditEligibleRowForCredit.
 */
export function disputeGaveBackCreditIdsSql(a = 'p'): string {
  const x = alias(a)
  return `ARRAY(SELECT DISTINCT dg_u.prepaid_credit_id FROM payment_reversals dg_r
                  JOIN credit_uses dg_u ON dg_u.payment_id = dg_r.payment_id
                 WHERE dg_r.id = ${x}.reversal_id AND dg_u.status = 'reversed'
                   AND dg_u.prepaid_credit_id IS NOT NULL)`
}

/**
 * Credit may pay the row (alias `a`) when the credit paying is the paid-ahead
 * credit `prepaidCreditRef` (a placeholder '$2' or a column 'c.id', NULL for
 * any other kind of credit). The general rule (creditEligibleRowSql), plus
 * decisions #48.7: a bill a dispute reopened may be paid with the credit that
 * same dispute gave back — and only that credit. Exactly the credit_uses_apply
 * trigger's eligibility for one (row, credit) pair; the trigger also caps that
 * credit's uses on the reopened row at what the dispute gave back of it.
 * creditEligibleRowSql stays "no" for a reopened row: it is asked without
 * knowing which credit will pay.
 */
export function creditEligibleRowForCreditSql(a: string, prepaidCreditRef: string): string {
  const x = alias(a)
  const credit = ref(prepaidCreditRef)
  return `(${creditEligibleBaseSql(x)}
      AND (${x}.reversal_id IS NULL
           OR COALESCE(${credit}::uuid = ANY(${disputeGaveBackCreditIdsSql(x)}), FALSE)))`
}

/**
 * The ORDER BY list (without the words ORDER BY) for the one allocation order,
 * the SQL twin of compareForAllocation in packages/shared/src/paymentAllocation.ts:
 * bucket (ordinary, propane, carried), due date, type (rent, utility, late fee,
 * fee, home payment, other), creation time, id. Creation time is compared to the
 * millisecond, as JavaScript reads it, so both sides order the same rows alike.
 */
export function allocationOrderSql(a = 'p'): string {
  const x = alias(a)
  const typeCase = ALLOCATION_TYPE_ORDER.map((t, i) => `WHEN '${t}' THEN ${i}`).join(' ')
  return `CASE WHEN ${x}.type = 'carried_balance' THEN 2
               WHEN upper(COALESCE(${x}.entry_description, '')) = 'PROPANE' THEN 1
               ELSE 0 END,
          ${x}.due_date,
          CASE ${x}.type ${typeCase} ELSE ${ALLOCATION_TYPE_ORDER.length} END,
          date_trunc('milliseconds', ${x}.created_at),
          ${x}.id`
}

// ─── The same rules over a row already read ──────────────────────────────────

/**
 * The payments columns these rules read. Every one is REQUIRED, typed exactly
 * as pg returns it (NULL-able columns are `T | null`; the rest are NOT NULL in
 * the table), so a typed query that leaves one out of its SELECT list fails
 * tsc instead of quietly answering "yes". Untyped (`any`) rows get the same
 * check at run time: a rule refuses, loudly, a row missing a column it reads
 * (an absent revenue_owner once read as the landlord's, which made a GAM fee
 * bank-payable and credit-eligible).
 */
export interface MoneyRowFacts {
  status: string
  amount: number | string
  stripe_payment_intent_id: string | null
  work_trade_suspended_at: string | Date | null
  entry_description: string
  revenue_owner: string
  type: string
  lease_fee_id: string | null
  reversal_id: string | null
  unit_id: string | null
  lease_id: string | null
  /**
   * The row is a FlexDeposit payment (GAM's custody collection) —
   * flexDepositFactSql(). Read it wherever a deposit row can reach
   * isBankPayableRow. Optional so readers that never see deposit rows need not
   * carry it; absent, isBankPayableRow cannot tell, and the SQL twin
   * (bankPayableRowSql) is the rule.
   */
  flex_deposit?: boolean | null
  /**
   * For a row a dispute reopened: the paid-ahead credits that dispute gave back
   * on it (disputeGaveBackCreditIdsSql). Required by
   * isCreditEligibleRowForCredit on a row with reversal_id.
   */
  dispute_credit_ids?: string[] | null
}

const PAYABLE_COLUMNS = ['status', 'amount', 'stripe_payment_intent_id', 'work_trade_suspended_at', 'entry_description'] as const
const BANK_PAYABLE_COLUMNS = [...PAYABLE_COLUMNS, 'revenue_owner'] as const
const DEPOSIT_ROW_COLUMNS = ['entry_description', 'lease_fee_id'] as const
const CREDIT_ELIGIBLE_COLUMNS = [
  ...PAYABLE_COLUMNS, 'revenue_owner', 'type', 'lease_fee_id', 'reversal_id', 'unit_id', 'lease_id',
] as const

/** Throws when the row was read without a column the rule needs. */
function requireColumns(r: MoneyRowFacts, columns: readonly (keyof MoneyRowFacts)[], rule: string): void {
  for (const col of columns) {
    if ((r as unknown as Record<string, unknown>)[col] === undefined) {
      throw new Error(`moneyPredicates.${rule}: the row has no ${col}; add payments.${col} to the SELECT list`)
    }
  }
}

export function isPayableRow(r: MoneyRowFacts): boolean {
  requireColumns(r, PAYABLE_COLUMNS, 'isPayableRow')
  return (r.status === 'pending' || r.status === 'failed')
    && (r.status === 'failed' || r.stripe_payment_intent_id === null)
    && r.work_trade_suspended_at === null
    && r.entry_description !== 'FLEXPAY'
    && Number(r.amount) > 0
}

export function isBankPayableRow(r: MoneyRowFacts): boolean {
  requireColumns(r, BANK_PAYABLE_COLUMNS, 'isBankPayableRow')
  return isPayableRow(r) && (BANK_PAYABLE_OWNERS as readonly string[]).includes(r.revenue_owner)
    && r.flex_deposit !== true
}

export function isDepositOrMoveOutRow(r: MoneyRowFacts): boolean {
  requireColumns(r, DEPOSIT_ROW_COLUMNS, 'isDepositOrMoveOutRow')
  return r.entry_description === 'DEPOSIT' && r.lease_fee_id === null
}

export function isCreditEligibleRow(r: MoneyRowFacts): boolean {
  requireColumns(r, CREDIT_ELIGIBLE_COLUMNS, 'isCreditEligibleRow')
  return isCreditEligibleBase(r) && r.reversal_id === null
}

function isCreditEligibleBase(r: MoneyRowFacts): boolean {
  return isPayableRow(r)
    && r.revenue_owner === 'landlord'
    && (CREDIT_ELIGIBLE_TYPES as readonly string[]).includes(r.type)
    && !(CREDIT_INELIGIBLE_ENTRIES as readonly string[]).includes(r.entry_description)
    && !isDepositOrMoveOutRow(r)
    && r.unit_id !== null
    && r.lease_id !== null
}

/**
 * creditEligibleRowForCreditSql over a row already read: may the paid-ahead
 * credit `prepaidCreditId` (null for any other kind of credit) pay it? A row a
 * dispute reopened must carry dispute_credit_ids, or this refuses, loudly.
 */
export function isCreditEligibleRowForCredit(r: MoneyRowFacts, prepaidCreditId: string | null): boolean {
  requireColumns(r, CREDIT_ELIGIBLE_COLUMNS, 'isCreditEligibleRowForCredit')
  if (!isCreditEligibleBase(r)) return false
  if (r.reversal_id === null) return true
  if (r.dispute_credit_ids === undefined) {
    throw new Error('moneyPredicates.isCreditEligibleRowForCredit: the reopened row has no dispute_credit_ids; '
      + 'add disputeGaveBackCreditIdsSql() AS dispute_credit_ids to the SELECT list')
  }
  return prepaidCreditId !== null && (r.dispute_credit_ids ?? []).includes(prepaidCreditId)
}

// ─── The household lock ───────────────────────────────────────────────────────

/** Advisory-lock key of one household: a person with one company. */
export function householdLockKey(tenantId: string, landlordId: string): string {
  return `household:${tenantId}:${landlordId}`
}
/** Advisory-lock key of one lease, shared by every co-tenant on it. */
export function leaseLockKey(leaseId: string): string {
  return `lease:${leaseId}`
}

/**
 * Serialize every writer of one household's money (§1.5). Takes, in this fixed
 * order and for the rest of the caller's transaction:
 *   1. household:<tenant>:<landlord>
 *   2. lease:<id> for each of that household's leases with this landlord,
 *      sorted, so co-tenants paying the same lease wait for each other
 * Callers then lock the charge rows they touch by id (lockPaymentRowsById).
 *
 * Must run inside a transaction (BEGIN): an advisory xact lock taken in
 * autocommit is released the moment its statement ends, so this refuses.
 * Take ONE household per transaction; the lease keys are always taken in id
 * order, so two households sharing a lease can never deadlock on each other.
 *
 * Returns the household's lease ids, sorted.
 */
export async function lockHousehold(client: PoolClient, tenantId: string, landlordId: string): Promise<string[]> {
  const key = householdLockKey(tenantId, landlordId)
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key])
  // Still held one statement later only inside a transaction. (Comparing
  // transaction and statement start times does not work: node-pg's extended
  // protocol starts the statement clock after the implicit transaction's.)
  // A bigint advisory key shows in pg_locks as classid = high 32 bits,
  // objid = low 32 bits, objsubid = 1.
  const next = await client.query<{ held: boolean; lease_ids: string[] }>(
    `SELECT EXISTS (
              SELECT 1 FROM pg_locks
               WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND objsubid = 1
                 AND classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
                 AND objid   = (hashtextextended($1, 0) & 4294967295)::oid) AS held,
            ARRAY(SELECT l.id::text
                    FROM leases l
                   WHERE l.landlord_id = $3
                     AND (EXISTS (SELECT 1 FROM lease_tenants lt WHERE lt.lease_id = l.id AND lt.tenant_id = $2)
                          OR EXISTS (SELECT 1 FROM payments p WHERE p.lease_id = l.id AND p.tenant_id = $2))
                   ORDER BY l.id) AS lease_ids`,
    [key, tenantId, landlordId])
  if (!next.rows[0]?.held) {
    throw new Error('lockHousehold must run inside a transaction (BEGIN first): an advisory lock outside one is released at once')
  }
  const ids = next.rows[0].lease_ids ?? []
  for (const id of ids) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [leaseLockKey(id)])
  }
  return ids
}

/**
 * Lock charge rows in id order (the last step of the lock order) and return the
 * ids that exist. Call after lockHousehold.
 */
export async function lockPaymentRowsById(client: PoolClient, paymentIds: readonly string[]): Promise<string[]> {
  if (paymentIds.length === 0) return []
  const res = await client.query<{ id: string }>(
    `SELECT id FROM payments WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[...new Set(paymentIds)]])
  return res.rows.map(r => r.id)
}
