import { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { isFeatureEnabled } from './systemFeatures'
import { AppError } from '../middleware/errorHandler'
import { getStripe } from '../lib/stripe'
import { createRentPlatformCharge } from './stripeConnect'
import { computeTenantGamOutstandingTotal } from './supersedence'
import {
  FLEX_CHARGE_STATEMENT_FEE_PCT,
  FLEX_CHARGE_MAX_FINANCE_PCT,
  FLEX_CHARGE_MIN_PAYMENT_PCT,
  FLEX_CHARGE_MIN_PAYMENT_FLOOR,
  FLEX_CHARGE_LATE_FEE,
  FLEX_CHARGE_DEFAULT_CREDIT_LIMIT,
  type FlexChargeAccountStatus,
} from '@gam/shared'
import { logger } from '../lib/logger'

const LANDLORD_DISPUTE_THRESHOLD_COUNT = 3       // distinct customers
const LANDLORD_DISPUTE_THRESHOLD_DAYS = 90        // rolling window

// ============================================================
// FlexCharge — consolidated POS charge-account product (S252+).
//
// A POS merchant (landlord OR standalone POS operator) extends a
// FlexCharge tab to a known customer (tenant OR pos_customer) at
// one of their properties. Charges accumulate over the month →
// monthly statement → ACH auto-pull for the balance. GAM's 1.5% is a
// MERCHANT subscription (flat % of credit volume), deducted from the
// merchant's payout — never charged to the borrower. No interest (GAM
// is not the lender — the merchant is). No revolving balance. Auto-pay required.
//
// This service exposes:
//   - pos_customer CRUD (merchant-owned customer roster)
//   - flex_charge_account CRUD (the per-customer tab)
//   - postFlexChargeTransaction (called from POS payment flow when
//     payment_method='charge')
//   - generateMonthlyStatement (called by S253 cron)
//
// Out of scope this session: statement billing cron, dispute →
// disqualification engine, multi-dispute → user cutoff threshold,
// UI surfaces. Schema is ready; engines wire in S253; UI in S254.
// ============================================================

export async function isFlexChargeVisible(): Promise<boolean> {
  return isFeatureEnabled('flexcharge_rollout_visible')
}

// ── pos_customers ───────────────────────────────────────────────

export interface PosCustomerRow {
  id:                  string
  landlord_id:         string
  first_name:          string
  last_name:           string
  email:               string
  phone:               string | null
  stripe_customer_id:  string | null
  ach_verified:        boolean
  bank_last4:          string | null
  notes:               string | null
  created_at:          string
  archived_at:         string | null
}

export async function createPosCustomer(args: {
  landlordId: string
  firstName:  string
  lastName:   string
  email:      string
  phone?:     string | null
  notes?:     string | null
}): Promise<PosCustomerRow> {
  const email = args.email.trim().toLowerCase()
  if (!email.includes('@')) throw new AppError(400, 'Valid email required')

  try {
    const row = await queryOne<PosCustomerRow>(
      `INSERT INTO pos_customers
         (landlord_id, first_name, last_name, email, phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [args.landlordId, args.firstName.trim(), args.lastName.trim(), email, args.phone ?? null, args.notes ?? null],
    )
    return row!
  } catch (e: any) {
    if (e?.code === '23505') {
      throw new AppError(409, 'A customer with this email already exists for this landlord')
    }
    throw e
  }
}

// S633: takes EVERY entity the account owns, not one. A landlord who owns two
// companies has one customer roster from their side of the counter; scoping it
// to a single entity id hid half of it with no error and no empty-state — the
// list simply came back short. Callers pass landlordScopeIds(req.user).
export async function listPosCustomers(landlordIds: string[]): Promise<PosCustomerRow[]> {
  if (!landlordIds.length) return []
  return query<PosCustomerRow>(
    `SELECT * FROM pos_customers
      WHERE landlord_id = ANY($1::uuid[]) AND archived_at IS NULL
      ORDER BY last_name, first_name`,
    [landlordIds],
  )
}

// S633: landlordIds is the caller's whole scope, so archiving works on a
// customer at any company the account owns. The filter is still there — it is
// what stops one landlord archiving another's customer — it is just no longer
// narrowed to whichever entity the session happened to sit on.
export async function archivePosCustomer(args: { landlordIds: string[]; customerId: string }): Promise<void> {
  // Soft-archive — don't break historical pos_transactions /
  // flex_charge_accounts that reference this row.
  const row = await queryOne<{ id: string }>(
    `UPDATE pos_customers
        SET archived_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND landlord_id = ANY($2::uuid[]) AND archived_at IS NULL
      RETURNING id`,
    [args.customerId, args.landlordIds],
  )
  if (!row) throw new AppError(404, 'Customer not found or already archived')
}

// ── flex_charge_accounts ────────────────────────────────────────

export interface FlexChargeAccountRow {
  id:                  string
  tenant_id:           string | null
  pos_customer_id:     string | null
  property_id:         string
  landlord_id:         string
  credit_limit:        string
  current_balance:     string   // S583 revolving: running balance (carried, net of payments); source of truth for exposure
  status:              FlexChargeAccountStatus
  disqualified_until:  string | null
  disqualified_reason: string | null
  notes:               string | null
  created_at:          string
  updated_at:          string
}

export async function createFlexChargeAccount(args: {
  landlordId:      string
  propertyId:      string
  tenantId?:       string | null
  posCustomerId?:  string | null
  creditLimit?:    number     // optional override; falls back to property default
  notes?:          string | null
}): Promise<FlexChargeAccountRow> {
  // XOR validation
  const tenantId   = args.tenantId ?? null
  const posCustId  = args.posCustomerId ?? null
  if ((tenantId && posCustId) || (!tenantId && !posCustId)) {
    throw new AppError(400, 'Exactly one of tenantId or posCustomerId must be provided')
  }

  // Verify the property belongs to this landlord
  const prop = await queryOne<{ landlord_id: string; flex_charge_default_credit_limit: string; flexcharge_enabled: boolean }>(
    `SELECT landlord_id, flex_charge_default_credit_limit::text, flexcharge_enabled
       FROM properties WHERE id = $1`,
    [args.propertyId],
  )
  if (!prop) throw new AppError(404, 'Property not found')
  if (prop.landlord_id !== args.landlordId) {
    throw new AppError(403, 'Property does not belong to this landlord')
  }
  // S309: per-Location enablement gate. FlexCharge is opt-in per property.
  // The legal layer (Consumer ToS § 9.3 + Business ToS § 11 + FlexCharge
  // Business Account Agreement § 3) requires explicit per-Location
  // enablement before any Account Holder can be enrolled. Existing
  // accounts on this property continue to function — the gate applies
  // to new account creation only.
  if (!prop.flexcharge_enabled) {
    throw new AppError(403, 'FlexCharge is not enabled at this property. Enable it in the property settings before creating an account here.')
  }

  // Confirm the linked customer entity belongs to this landlord
  if (tenantId) {
    const t = await queryOne<{ id: string }>(
      `SELECT t.id
         FROM tenants t
         JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
         JOIN leases l        ON l.id = lt.lease_id AND l.status IN ('active', 'pending')
        WHERE t.id = $1 AND l.landlord_id = $2
        LIMIT 1`,
      [tenantId, args.landlordId],
    )
    if (!t) throw new AppError(403, 'Tenant not on an active lease with this landlord')

    // S261: FlexCharge eligibility gates on FlexDeposit-in-flight.
    // Per the locked product rule, a tenant cannot hold a FlexCharge
    // account while they have any active FlexDeposit installment plan
    // (status 'active' or 'accelerated'). This precludes the
    // FlexDeposit↔FlexCharge FIFO collision case and matches the
    // qualification gate order (bg → deposit → ACH → OTP → FlexCharge).
    const activePlan = await queryOne<{ id: string; plan_status: string }>(
      `SELECT id, flex_deposit_plan_status AS plan_status
         FROM security_deposits
        WHERE tenant_id = $1
          AND flex_deposit_enabled = TRUE
          AND flex_deposit_plan_status IN ('active', 'accelerated')
        LIMIT 1`,
      [tenantId],
    )
    if (activePlan) {
      throw new AppError(409,
        `Tenant has an active FlexDeposit installment plan ` +
        `(deposit ${activePlan.id}, status ${activePlan.plan_status}). ` +
        `FlexCharge enrollment is blocked until the deposit plan completes.`)
    }
  } else if (posCustId) {
    const c = await queryOne<{ id: string }>(
      `SELECT id FROM pos_customers
        WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL`,
      [posCustId, args.landlordId],
    )
    if (!c) throw new AppError(404, 'POS customer not found')
  }

  const limit = args.creditLimit != null
    ? Number(args.creditLimit)
    : Number(prop.flex_charge_default_credit_limit)
  if (!Number.isFinite(limit) || limit < 0) {
    throw new AppError(400, 'credit limit must be a non-negative number')
  }

  try {
    const row = await queryOne<FlexChargeAccountRow>(
      `INSERT INTO flex_charge_accounts
         (tenant_id, pos_customer_id, property_id, landlord_id, credit_limit, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tenantId, posCustId, args.propertyId, args.landlordId, limit.toFixed(2), args.notes ?? null],
    )
    return row!
  } catch (e: any) {
    if (e?.code === '23505') {
      throw new AppError(409, 'FlexCharge account already exists for this customer at this property')
    }
    throw e
  }
}

// S633: landlordIds, plural — the account's whole scope. A landlord with two
// companies has one book of FlexCharge accounts, and narrowing it to a single
// entity id returned a short list with no sign that anything was missing.
export async function listFlexChargeAccounts(args: {
  landlordIds: string[]
  propertyId?: string
  status?:    FlexChargeAccountStatus
}): Promise<Array<FlexChargeAccountRow & { customer_name: string | null; customer_email: string | null; balance: number }>> {
  if (!args.landlordIds.length) return []
  const where: string[] = ['a.landlord_id = ANY($1::uuid[])']
  const params: any[] = [args.landlordIds]
  if (args.propertyId) { params.push(args.propertyId); where.push(`a.property_id = $${params.length}`) }
  if (args.status)     { params.push(args.status);     where.push(`a.status = $${params.length}`) }

  return query<any>(
    `SELECT a.*,
            COALESCE(
              tu.first_name || ' ' || tu.last_name,
              pc.first_name || ' ' || pc.last_name
            ) AS customer_name,
            COALESCE(tu.email, pc.email) AS customer_email,
            -- S583 revolving: true current exposure = the running carried balance
            -- (already net of credited payments + accrued interest/fees) PLUS this
            -- cycle's open pending purchases not yet rolled into a statement. Billed
            -- transactions are NOT re-summed — they're already inside current_balance
            -- (the pre-revolving SUM(pending,billed) never dropped as customers paid).
            (a.current_balance + COALESCE((
              SELECT SUM(t.amount)
                FROM flex_charge_transactions t
               WHERE t.account_id = a.id
                 AND t.status = 'pending'
            ), 0))::float AS balance
       FROM flex_charge_accounts a
       LEFT JOIN tenants     t   ON t.id = a.tenant_id
       LEFT JOIN users       tu  ON tu.id = t.user_id
       LEFT JOIN pos_customers pc ON pc.id = a.pos_customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC`,
    params,
  )
}

// S633: scoped to every entity the account owns. The landlord_id filter is
// still the thing that stops one landlord editing another's account — it is
// just no longer narrowed to whichever entity the session sat on.
export async function updateFlexChargeAccount(args: {
  landlordIds:  string[]
  accountId:    string
  creditLimit?: number
  status?:      FlexChargeAccountStatus
  notes?:       string | null
}): Promise<FlexChargeAccountRow> {
  const sets: string[] = []
  const params: any[] = []
  if (args.creditLimit != null) {
    if (!Number.isFinite(args.creditLimit) || args.creditLimit < 0) {
      throw new AppError(400, 'credit_limit must be a non-negative number')
    }
    params.push(args.creditLimit.toFixed(2))
    sets.push(`credit_limit = $${params.length}`)
  }
  if (args.status) {
    if (args.status === 'disqualified') {
      throw new AppError(400, 'disqualified status is set only by the dispute engine, not by manual update')
    }
    params.push(args.status)
    sets.push(`status = $${params.length}`)
  }
  if (args.notes !== undefined) {
    params.push(args.notes)
    sets.push(`notes = $${params.length}`)
  }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update')

  params.push(args.accountId, args.landlordIds)
  const row = await queryOne<FlexChargeAccountRow>(
    `UPDATE flex_charge_accounts
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length - 1} AND landlord_id = ANY($${params.length}::uuid[])
      RETURNING *`,
    params,
  )
  if (!row) throw new AppError(404, 'Account not found')
  return row
}

export interface AccountStatementRow {
  id:                string
  cycle_month:       string
  previous_balance:  string
  new_purchases:     string
  finance_charge:    string   // interest this cycle
  late_fee:          string
  payments_credited: string
  service_fee:       string   // GAM's 1.5%/12 cut (off the merchant)
  new_balance:       string
  total_due:         string
  minimum_due:       string
  amount_paid:       string
  due_date:          string
  status:            'open' | 'billed' | 'paid' | 'failed' | 'voided'
  billed_at:         string | null
  settled_at:        string | null
  failed_reason:     string | null
  created_at:        string
}

export interface DisputedTransactionRow {
  id:             string
  amount:         string
  disputed_at:    string
  dispute_reason: string
  created_at:     string
}

/**
 * List statements + disputed transactions for a single FlexCharge
 * account. Landlord-scoped — refuses to return data for an account
 * that doesn't belong to the caller. Disputed transactions surface
 * separately because they don't roll into statements (dispute fires
 * before the next statement cycle; account flips to disqualified).
 */
export async function listAccountStatements(args: {
  landlordIds: string[]
  accountId:  string
}): Promise<{ statements: AccountStatementRow[]; disputes: DisputedTransactionRow[] }> {
  // S633: any entity the account owns, not one.
  const acct = await queryOne<{ id: string }>(
    'SELECT id FROM flex_charge_accounts WHERE id=$1 AND landlord_id = ANY($2::uuid[])',
    [args.accountId, args.landlordIds],
  )
  if (!acct) throw new AppError(404, 'Account not found')
  const statements = await query<AccountStatementRow>(
    `SELECT id, cycle_month::text, previous_balance::text, new_purchases::text,
            finance_charge::text, late_fee::text, payments_credited::text, service_fee::text,
            new_balance::text, total_due::text, minimum_due::text, amount_paid::text,
            due_date::text, status, billed_at, settled_at, failed_reason, created_at
       FROM flex_charge_statements
      WHERE account_id = $1
      ORDER BY cycle_month DESC, created_at DESC`,
    [args.accountId],
  )
  const disputes = await query<DisputedTransactionRow>(
    `SELECT id, amount::text, disputed_at, dispute_reason, created_at
       FROM flex_charge_transactions
      WHERE account_id = $1
        AND status = 'disputed'
      ORDER BY disputed_at DESC`,
    [args.accountId],
  )
  return { statements, disputes }
}

/**
 * Return the active FlexCharge account for a given (customer, property)
 * pair. Used by the POS payment flow when payment_method='charge' to
 * decide whether the customer can charge here.
 */
export async function getAccountForCharge(args: {
  propertyId: string
  tenantId?:  string | null
  posCustomerId?: string | null
}): Promise<FlexChargeAccountRow | null> {
  if ((args.tenantId && args.posCustomerId) || (!args.tenantId && !args.posCustomerId)) {
    return null
  }
  if (args.tenantId) {
    return queryOne<FlexChargeAccountRow>(
      `SELECT * FROM flex_charge_accounts
        WHERE property_id = $1 AND tenant_id = $2`,
      [args.propertyId, args.tenantId],
    )
  }
  return queryOne<FlexChargeAccountRow>(
    `SELECT * FROM flex_charge_accounts
      WHERE property_id = $1 AND pos_customer_id = $2`,
    [args.propertyId, args.posCustomerId],
  )
}

// ── Charge posting ──────────────────────────────────────────────

export interface PostFlexChargeArgs {
  accountId:         string
  posTransactionId:  string
  amount:            number
  notes?:            string | null
}

/**
 * Post a POS charge against a FlexCharge account. Called from the POS
 * payment-flow integration (S254) when payment_method='charge'. Gates:
 *   - account is active (not suspended / disqualified)
 *   - new balance does not exceed credit_limit
 *
 * Returns the inserted flex_charge_transactions row. The pos_transactions
 * row stays the audit/itemization source-of-truth; this row tracks
 * statement aggregation + payment state.
 */
export async function postFlexChargeTransaction(
  args: PostFlexChargeArgs,
  externalClient?: PoolClient,
): Promise<{ id: string; account_id: string; amount: string; status: string }> {
  if (!Number.isFinite(args.amount) || args.amount <= 0) {
    throw new AppError(400, 'amount must be a positive number')
  }

  // S341: accept caller-owned client so the POS transactions route can
  // wrap this call inside its larger BEGIN/COMMIT. Standalone path
  // (no externalClient) preserved for any future direct callers.
  const ownsClient = !externalClient
  const client: PoolClient = externalClient ?? await getClient()
  try {
    if (ownsClient) await client.query('BEGIN')

    const acct = await client.query<FlexChargeAccountRow & { pending_sum: string; landlord_disqualified_until: string | null }>(
      // S583 revolving: gate on the running carried balance (net of payments +
      // inclusive of accrued interest/fees) PLUS this cycle's open pending
      // purchases. The old SUM(pending,billed) basis over-counted a paid-down
      // customer (billed txns never leave 'billed' now → the sum never fell as
      // they paid) and under-counted interest, permanently blocking further
      // charges after a full pay-off. current_balance already contains billed
      // purchases, so only pending is added here.
      `SELECT a.*,
              COALESCE((
                SELECT SUM(t.amount)
                  FROM flex_charge_transactions t
                 WHERE t.account_id = a.id
                   AND t.status = 'pending'
              ), 0)::text AS pending_sum,
              l.flex_charge_disqualified_until::text AS landlord_disqualified_until
         FROM flex_charge_accounts a
         JOIN landlords l ON l.id = a.landlord_id
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [args.accountId],
    ).then(r => r.rows[0])
    if (!acct) throw new AppError(404, 'FlexCharge account not found')
    if (acct.status !== 'active') {
      throw new AppError(409, `Account is ${acct.status} — cannot post new charges`)
    }
    if (acct.landlord_disqualified_until && new Date(acct.landlord_disqualified_until).getTime() > Date.now()) {
      throw new AppError(409, 'The merchant is currently blocked from offering FlexCharge')
    }
    const currentBalance = fcRound2(Number(acct.current_balance) + Number(acct.pending_sum))
    const limit = Number(acct.credit_limit)
    if (currentBalance + args.amount > limit) {
      throw new AppError(409, `Charge would exceed credit limit ($${limit.toFixed(2)}); current balance $${currentBalance.toFixed(2)}`)
    }

    const ins = await client.query<{ id: string; account_id: string; amount: string; status: string }>(
      `INSERT INTO flex_charge_transactions
         (account_id, pos_transaction_id, amount, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, account_id, amount::text, status`,
      [args.accountId, args.posTransactionId, args.amount.toFixed(2), args.notes ?? null],
    )
    if (ownsClient) await client.query('COMMIT')
    return ins.rows[0]
  } catch (e) {
    if (ownsClient) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (ownsClient) client.release()
  }
}

/**
 * S340: post a refund reversal against a FlexCharge account. Called from
 * the POS refund route (routes/pos.ts) when payment_method='charge'.
 *
 * Architecture: INSERT a new flex_charge_transactions row with negative
 * amount. The original charge row stays as the historical record; the
 * reversal row is a separate audit-trail entry. The account balance is
 * computed as SUM(amount) across status IN ('pending','billed'), so a
 * negative pending row correctly reduces the open balance by the refund
 * amount. Works identically for full and partial refunds.
 *
 * No credit-limit check (a refund only reduces balance, never grows it).
 * No account-status gate — we permit reversals even on suspended accounts
 * (cashier might be cleaning up a botched ring-up that pre-dated suspension).
 *
 * Accepts an optional externalClient so the caller can wrap this call
 * inside their own BEGIN/COMMIT block (mirrors generateMoveInInvoice
 * and executeSubleaseAgreementCompletion patterns). Without one, opens
 * its own transaction.
 */
export interface PostFlexChargeRefundArgs {
  accountId:         string
  posTransactionId:  string
  amount:            number   // positive refund amount; we negate it inside
  notes?:            string | null
}

export async function postFlexChargeRefund(
  args: PostFlexChargeRefundArgs,
  externalClient?: PoolClient,
): Promise<{ id: string; account_id: string; amount: string; status: string }> {
  if (!Number.isFinite(args.amount) || args.amount <= 0) {
    throw new AppError(400, 'refund amount must be a positive number')
  }
  const reversalAmount = -args.amount

  const ownsClient = !externalClient
  const client: PoolClient = externalClient ?? await getClient()
  try {
    if (ownsClient) await client.query('BEGIN')
    const ins = await client.query<{ id: string; account_id: string; amount: string; status: string }>(
      `INSERT INTO flex_charge_transactions
         (account_id, pos_transaction_id, amount, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, account_id, amount::text, status`,
      [args.accountId, args.posTransactionId, reversalAmount.toFixed(2), args.notes ?? null],
    )
    if (ownsClient) await client.query('COMMIT')
    return ins.rows[0]
  } catch (e) {
    if (ownsClient) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (ownsClient) client.release()
  }
}

// ── Statement generation ────────────────────────────────────────

export interface GenerateStatementResult {
  statement_id:      string
  account_id:        string
  cycle_month:       string
  previous_balance:  number
  new_purchases:     number
  payments_credited: number
  finance_charge:    number   // S583 revolving: INTEREST this cycle (merchant APR/12 on the carried balance)
  late_fee:          number   // $10 if the previous minimum wasn't met
  service_fee:       number   // GAM's 1.5%/YEAR, monthly (off the merchant, never the borrower)
  new_balance:       number   // ending balance (== total_due)
  total_due:         number   // full balance to clear
  minimum_due:       number   // greater of $25 or 3% of new_balance
  due_date:          string
  tx_count:          number
}

const fcRound2 = (n: number) => Math.round(n * 100) / 100

/**
 * Generate the monthly statement for a single account. Aggregates all
 * `pending`-status flex_charge_transactions whose created_at falls in
 * the cycle month, totals them, applies the 1.5% service fee, creates
 * a flex_charge_statements row, flips the included transactions to
 * `billed` with their statement_id stamped.
 *
 * Idempotent: UNIQUE (account_id, cycle_month) prevents double-cuts.
 * Re-running for the same cycle on an account with no new pending tx
 * is a no-op (returns null).
 *
 * Due date convention: 15th of the following month. ACH auto-pull
 * happens via the S253 statement-billing cron.
 *
 * @param now Cycle anchor — uses now.year/month to compute the cycle
 *             window. Cron passes "first of last month" once a month.
 */
export async function generateMonthlyStatement(args: {
  accountId: string
  cycleMonth: string  // first-of-month date string YYYY-MM-01
}): Promise<GenerateStatementResult | null> {
  if (!await isFlexChargeVisible()) return null

  const client = await getClient()
  try {
    await client.query('BEGIN')

    // Account + the merchant's per-property APR (they are the lender).
    const acct = await client.query<{ id: string; status: string; apr: string }>(
      `SELECT a.id, a.status, p.flex_charge_finance_pct::text AS apr
         FROM flex_charge_accounts a
         JOIN properties p ON p.id = a.property_id
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [args.accountId],
    ).then(r => r.rows[0])
    if (!acct) throw new AppError(404, 'Account not found')
    // APR is an ANNUAL rate; the monthly periodic rate is APR/12 (how cards do it).
    const apr = Math.min(Math.max(Number(acct.apr) || 0, 0), FLEX_CHARGE_MAX_FINANCE_PCT)
    const monthlyRate = apr / 12

    const cycleStart = args.cycleMonth.slice(0, 10)

    // Prior statement → the carried balance, the payments credited against it
    // (amount_paid), and its minimum (for the late fee).
    const prev = await client.query<{ new_balance: string; minimum_due: string; amount_paid: string }>(
      `SELECT new_balance::text, minimum_due::text, amount_paid::text
         FROM flex_charge_statements
        WHERE account_id = $1 AND cycle_month < $2::date
        ORDER BY cycle_month DESC LIMIT 1`,
      [args.accountId, cycleStart],
    ).then(r => r.rows[0])
    const previousBalance  = prev ? Number(prev.new_balance) : 0
    const paymentsCredited = prev ? Number(prev.amount_paid) : 0
    // Unpaid part of the previous balance = what accrues interest. If the prior
    // statement was paid in full, this is 0 → no interest (the grace period,
    // automatic — no separate flag needed).
    const carriedBalance = Math.max(0, fcRound2(previousBalance - paymentsCredited))

    // New purchases this cycle (pending txns in the window).
    const txs = await client.query<{ id: string; amount: string }>(
      `SELECT id, amount::text
         FROM flex_charge_transactions
        WHERE account_id = $1
          AND status = 'pending'
          AND created_at >= $2::date
          AND created_at <  ($2::date + INTERVAL '1 month')`,
      [args.accountId, cycleStart],
    )
    const newPurchases = fcRound2(txs.rows.reduce((s, r) => s + Number(r.amount), 0))

    // Nothing owed and nothing bought → no statement this cycle.
    if (newPurchases === 0 && carriedBalance === 0) {
      await client.query('ROLLBACK')
      return null
    }

    const interest = fcRound2(carriedBalance * monthlyRate)
    // Late fee if the customer paid LESS than the previous minimum by now.
    const lateFee = prev && paymentsCredited + 0.005 < Number(prev.minimum_due) ? FLEX_CHARGE_LATE_FEE : 0
    const newBalance = fcRound2(previousBalance + newPurchases + interest + lateFee - paymentsCredited)
    const minimumDue = newBalance <= 0 ? 0
      : Math.min(newBalance, fcRound2(Math.max(FLEX_CHARGE_MIN_PAYMENT_FLOOR, newBalance * FLEX_CHARGE_MIN_PAYMENT_PCT)))
    // GAM's 1.5%/YEAR subscription, monthly, on the ending balance — off the merchant.
    const serviceFee = fcRound2(Math.max(0, newBalance) * (FLEX_CHARGE_STATEMENT_FEE_PCT / 12))

    // Due date = 15th of the next month.
    const cycleDate = new Date(cycleStart + 'T00:00:00Z')
    const dueDate = new Date(Date.UTC(cycleDate.getUTCFullYear(), cycleDate.getUTCMonth() + 1, 15))
      .toISOString().slice(0, 10)

    let stmtId: string
    try {
      const stmt = await client.query<{ id: string }>(
        `INSERT INTO flex_charge_statements
           (account_id, cycle_month, previous_balance, new_purchases, payments_credited,
            finance_charge, late_fee, service_fee, new_balance, total_due, minimum_due,
            balance, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [args.accountId, cycleStart, previousBalance.toFixed(2), newPurchases.toFixed(2), paymentsCredited.toFixed(2),
         interest.toFixed(2), lateFee.toFixed(2), serviceFee.toFixed(2), newBalance.toFixed(2), newBalance.toFixed(2),
         minimumDue.toFixed(2), newPurchases.toFixed(2), dueDate],
      )
      stmtId = stmt.rows[0].id
    } catch (e: any) {
      if (e?.code === '23505') {
        await client.query('ROLLBACK')
        throw new AppError(409, `Statement already exists for ${cycleStart} on account ${args.accountId}`)
      }
      throw e
    }

    // Flip this cycle's purchases to 'billed'.
    const txIds = txs.rows.map(r => r.id)
    if (txIds.length > 0) {
      await client.query(
        `UPDATE flex_charge_transactions
            SET status = 'billed', statement_id = $1, updated_at = NOW()
          WHERE id = ANY($2::uuid[])`,
        [stmtId, txIds],
      )
    }

    // Reset the running account balance to the statement's new balance.
    await client.query(
      `UPDATE flex_charge_accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2`,
      [newBalance.toFixed(2), args.accountId],
    )

    await client.query('COMMIT')
    return {
      statement_id:      stmtId,
      account_id:        args.accountId,
      cycle_month:       cycleStart,
      previous_balance:  previousBalance,
      new_purchases:     newPurchases,
      payments_credited: paymentsCredited,
      finance_charge:    interest,
      late_fee:          lateFee,
      service_fee:       serviceFee,
      new_balance:       newBalance,
      total_due:         newBalance,
      minimum_due:       minimumDue,
      due_date:          dueDate,
      tx_count:          txIds.length,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ── Customer-side view ─────────────────────────────────────────

/**
 * Tenant-side: list all FlexCharge accounts a tenant has + their
 * current balances + recent statements. Powers the tenant view.
 */
export async function getFlexChargeAccountsForTenant(tenantId: string) {
  // S583 revolving: `balance` is the running current_balance (source of truth);
  // the latest statement supplies the minimum + due date + how much is already
  // paid, for the pay-down UI. `apr` is the merchant's annual rate.
  const accounts = await query<any>(
    `SELECT a.id, a.property_id, a.credit_limit::text, a.status,
            a.disqualified_until::text, a.disqualified_reason,
            a.current_balance::text AS balance,
            p.name AS property_name,
            p.flex_charge_finance_pct::float AS apr,
            ls.minimum_due::text AS minimum_due,
            ls.new_balance::text AS statement_balance,
            ls.amount_paid::text AS amount_paid,
            ls.due_date::text    AS due_date,
            ls.status            AS statement_status
       FROM flex_charge_accounts a
       JOIN properties p ON p.id = a.property_id
       LEFT JOIN LATERAL (
         SELECT minimum_due, new_balance, amount_paid, due_date, status
           FROM flex_charge_statements s
          WHERE s.account_id = a.id
          ORDER BY s.cycle_month DESC LIMIT 1
       ) ls ON TRUE
      WHERE a.tenant_id = $1
      ORDER BY a.created_at DESC`,
    [tenantId],
  )
  if (accounts.length === 0) return []
  const ids = accounts.map(a => a.id)
  const txs = await query<any>(
    `SELECT t.id, t.account_id, t.amount::text, t.status, t.created_at,
            t.disputed_at, t.dispute_reason,
            pt.id AS pos_transaction_id
       FROM flex_charge_transactions t
       LEFT JOIN pos_transactions pt ON pt.id = t.pos_transaction_id
      WHERE t.account_id = ANY($1::uuid[])
        AND t.status IN ('pending', 'billed', 'disputed')
      ORDER BY t.created_at DESC`,
    [ids],
  )
  const byAcct = new Map<string, any[]>()
  for (const tx of txs) {
    if (!byAcct.has(tx.account_id)) byAcct.set(tx.account_id, [])
    byAcct.get(tx.account_id)!.push(tx)
  }
  return accounts.map(a => ({ ...a, transactions: byAcct.get(a.id) || [] }))
}

void FLEX_CHARGE_DEFAULT_CREDIT_LIMIT  // re-export anchor; consumed by routes default-display

// ── S254: Statement generation cron ─────────────────────────────

export interface StatementGenerationResult {
  cycle_month:        string
  accounts_scanned:   number
  statements_created: number
  skipped_no_pending: number
  errors:             number
}

/**
 * Monthly cron entry — runs on the 1st of each month, generates the
 * previous month's statement for every active FlexCharge account.
 * Idempotent via UNIQUE (account_id, cycle_month) inside
 * generateMonthlyStatement. Accounts with no pending transactions
 * skip cleanly (no statement row written).
 *
 * Cycle convention: when this runs on (say) Feb 1, it generates the
 * January cycle statement (cycle_month = 2026-01-01). Pending tx
 * with created_at between Jan 1 and Feb 1 aggregate together.
 */
export async function processFlexChargeStatementGeneration(now: Date = new Date()): Promise<StatementGenerationResult> {
  // Previous month's first-of-month UTC.
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const cycle = prevMonth.toISOString().slice(0, 10)

  const out: StatementGenerationResult = {
    cycle_month:        cycle,
    accounts_scanned:   0,
    statements_created: 0,
    skipped_no_pending: 0,
    errors:             0,
  }
  if (!await isFlexChargeVisible()) return out

  const accounts = await query<{ id: string }>(
    `SELECT id FROM flex_charge_accounts WHERE status IN ('active', 'suspended')`,
  )
  out.accounts_scanned = accounts.length

  for (const a of accounts) {
    try {
      const stmt = await generateMonthlyStatement({ accountId: a.id, cycleMonth: cycle })
      if (stmt) out.statements_created += 1
      else out.skipped_no_pending += 1
    } catch (e: any) {
      // UNIQUE violation = statement already exists for this cycle (re-run safety).
      // Treat as skip; real errors get logged.
      if (e?.statusCode === 409) {
        out.skipped_no_pending += 1
      } else {
        logger.error({ err: e, ctx: a.id }, '[flexcharge][stmt-gen]')
        out.errors += 1
      }
    }
  }
  return out
}

// ── S253: Statement billing engine ──────────────────────────────

export interface StatementBillingResult {
  scanned:      number
  billed:       number
  skipped:      number
  errors:       number
  failed:       number
}

/**
 * Monthly cron entry — walks `flex_charge_statements` where
 * status='open' AND due_date <= today AND no payment_id yet. For
 * each: resolve customer's Stripe customer + default payment method,
 * fire ACH PaymentIntent for total_due, stamp payment_id on the
 * statement, flip status to 'billed'. Reconciliation happens on
 * webhook payment_intent.succeeded → status='paid' + merchant
 * Transfer fires.
 *
 * The customer's ACH pull is the statement balance only — their
 * transactions (incl. any finance charge the MERCHANT set); GAM's 1.5%
 * is NOT added to the borrower. Gross lands on the platform balance; the
 * merchant-share Transfer (balance − GAM's 1.5%) fires post-success so
 * GAM doesn't pre-pay the merchant before the customer ACH clears, and
 * GAM retains the 1.5% as its merchant subscription.
 *
 * Errors land the row in 'failed' status (NSF flow handled in the
 * NACHA retry pipeline + handleFlexChargeStatementNsf webhook hook).
 */
export async function processFlexChargeStatementBilling(now: Date = new Date()): Promise<StatementBillingResult> {
  const out: StatementBillingResult = { scanned: 0, billed: 0, skipped: 0, errors: 0, failed: 0 }
  if (!await isFlexChargeVisible()) return out

  const today = now.toISOString().slice(0, 10)
  const rows = await query<{
    statement_id:        string
    account_id:          string
    cycle_month:         string
    minimum_due:         string
    amount_paid:         string
    landlord_id:         string
    property_id:         string
    tenant_id:           string | null
    pos_customer_id:     string | null
    customer_stripe_id:  string | null
    customer_label:      string
  }>(
    `SELECT s.id AS statement_id, s.account_id, s.cycle_month::text AS cycle_month,
            s.minimum_due::text AS minimum_due, s.amount_paid::text AS amount_paid,
            a.landlord_id, a.property_id, a.tenant_id, a.pos_customer_id,
            COALESCE(t.stripe_customer_id, pc.stripe_customer_id) AS customer_stripe_id,
            COALESCE(
              tu.first_name || ' ' || tu.last_name,
              pc.first_name || ' ' || pc.last_name
            ) AS customer_label
       FROM flex_charge_statements s
       JOIN flex_charge_accounts a ON a.id = s.account_id
       LEFT JOIN tenants     t  ON t.id  = a.tenant_id
       LEFT JOIN users       tu ON tu.id = t.user_id
       LEFT JOIN pos_customers pc ON pc.id = a.pos_customer_id
      WHERE s.status   = 'open'
        AND s.due_date <= $1::date
        AND s.payment_id IS NULL`,
    [today],
  )
  out.scanned = rows.length

  const stripe = getStripe()
  for (const r of rows) {
    try {
      if (!r.customer_stripe_id) {
        await markStatementFailed(r.statement_id, 'customer has no stripe_customer_id — ACH not set up')
        out.failed += 1
        continue
      }

      // Resolve customer's default payment method.
      let paymentMethodId: string | null = null
      try {
        const cust = await stripe.customers.retrieve(r.customer_stripe_id)
        if (cust && !(cust as any).deleted) {
          const c = cust as any
          paymentMethodId = c.invoice_settings?.default_payment_method ?? c.default_source ?? null
        }
      } catch {}
      if (!paymentMethodId) {
        await markStatementFailed(r.statement_id, 'no default payment method on customer')
        out.failed += 1
        continue
      }

      // S583 revolving: auto-pull the remaining MINIMUM (greater of $25 or 3%),
      // net of any early pay-downs. If the minimum is already covered, mark the
      // statement met and skip — no double-charge. The rest of the balance carries.
      const shortfall = fcRound2(Math.max(0, Number(r.minimum_due) - Number(r.amount_paid)))
      if (shortfall < 0.01) {
        await query(
          `UPDATE flex_charge_statements
              SET status = 'paid', settled_at = COALESCE(settled_at, NOW()), updated_at = NOW()
            WHERE id = $1`,
          [r.statement_id])
        out.skipped += 1
        continue
      }
      const baseAmount = shortfall
      // S261: supersedence boost. tenant_id is NULL for pos_customer
      // accounts — no boost (no leaseable-tenant context). This
      // statement is itself in the FIFO list (status='open' AND
      // due_date<=today), so subtract baseAmount to avoid
      // double-counting.
      const rawBoost = r.tenant_id
        ? await computeTenantGamOutstandingTotal(r.tenant_id)
        : 0
      const boost = Math.max(0, Math.round((rawBoost - baseAmount) * 100) / 100)
      const amount = Math.round((baseAmount + boost) * 100) / 100

      const intent = await createRentPlatformCharge({
        amount,
        stripeCustomerId:    r.customer_stripe_id,
        paymentMethodId,
        paymentMethodTypes:  ['us_bank_account'],
        entryDescription:    'SUBSCRIP',
        metadata: {
          gam_purpose:       'flexcharge_statement',
          gam_statement_id:  r.statement_id,
          gam_account_id:    r.account_id,
          gam_landlord_id:   r.landlord_id,
          gam_cycle_month:   r.cycle_month,
        },
      })

      // Insert the payments row to track the ACH pull. tenant_id may
      // be null for pos_customer accounts; lease_id is unused for
      // statement billing so passed as NULL via $3 in this query.
      const pay = await queryOne<{ id: string }>(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, amount, status, entry_description,
           due_date, stripe_payment_intent_id, notes,
           gam_supersedence_amount
         ) VALUES ($1, $2, NULL, NULL, 'fee', $3, 'pending', 'SUBSCRIP',
                   $4, $5, $6, $7)
         RETURNING id`,
        [
          r.landlord_id, r.tenant_id, amount.toFixed(2),
          today, intent.id,
          `FlexCharge statement pull ${r.cycle_month} for ${r.customer_label}`,
          boost.toFixed(2),
        ],
      )

      await query(
        `UPDATE flex_charge_statements
            SET status     = 'billed',
                billed_at  = NOW(),
                payment_id = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [pay!.id, r.statement_id],
      )
      out.billed += 1
    } catch (e: any) {
      logger.error({ err: e, ctx: r.statement_id }, '[flexcharge][stmt-bill]')
      await markStatementFailed(r.statement_id, String(e?.message ?? e))
      out.errors += 1
    }
  }
  return out
}

async function markStatementFailed(statementId: string, reason: string) {
  await query(
    `UPDATE flex_charge_statements
        SET status = 'failed', failed_reason = $1, updated_at = NOW()
      WHERE id = $2`,
    [reason.slice(0, 500), statementId],
  )
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'flexcharge_statement_failed',
      title:    `FlexCharge statement billing failed — ${statementId}`,
      body:     `Statement ${statementId} failed to bill: ${reason}. Retry via POST /api/admin/flexcharge/statements/${statementId}/retry-billing.`,
      context:  { statement_id: statementId, reason },
    })
  } catch (e) {
    logger.error({ err: e }, '[flexcharge][stmt-fail-alert]')
  }
}

/**
 * Admin retry hook — re-fires the statement billing for a row stuck
 * in 'failed' status. Resets the row to 'open' first so the standard
 * processFlexChargeStatementBilling picks it up.
 */
export async function retryFlexChargeStatement(statementId: string): Promise<{ billed: boolean; reason: string }> {
  const stmt = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM flex_charge_statements WHERE id = $1`,
    [statementId],
  )
  if (!stmt) throw new AppError(404, 'Statement not found')
  if (stmt.status !== 'failed') {
    throw new AppError(409, `Statement is ${stmt.status} — only failed statements can be retried`)
  }
  await query(
    `UPDATE flex_charge_statements
        SET status = 'open', failed_reason = NULL, updated_at = NOW()
      WHERE id = $1`,
    [statementId],
  )
  const result = await processFlexChargeStatementBilling()
  return { billed: result.billed > 0, reason: result.billed > 0 ? 'billed' : 'no candidates picked up' }
}

// ── S253: Webhook reconcilers ──────────────────────────────────

/**
 * Called from webhooks payment_intent.succeeded for a
 * FLEXCHARGE_STMT-tagged payment. S583 revolving: the auto-pull collected the
 * statement MINIMUM, so this credits that minimum to amount_paid, reduces the
 * running current_balance, and flips the statement to 'paid' (= its minimum was
 * collected, NOT that the balance is zero — purchases stay 'billed' and carry).
 * Then fires the merchant Transfer (the collected minimum minus GAM's 1.5%/12
 * subscription, which stays on platform as GAM revenue — never on the borrower).
 *
 * Merchant transfer goes to landlords.user_id → users.stripe_connect_account_id.
 * If the landlord's Connect isn't onboarded, the transfer fails and
 * the merchant share sits on platform balance — admin alert + manual
 * reconciliation via Connect onboarding completion.
 */
export async function reconcileSettledFlexChargeStatement(paymentId: string): Promise<void> {
  const p = await queryOne<{
    id: string; entry_description: string | null;
  }>(
    `SELECT id, entry_description FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!p || p.entry_description !== 'SUBSCRIP') return  // self-gate

  const stmt = await queryOne<{
    id: string; account_id: string; minimum_due: string; service_fee: string;
    landlord_user_id: string | null; landlord_id: string;
  }>(
    `SELECT s.id, s.account_id, s.minimum_due::text, s.service_fee::text,
            u.id AS landlord_user_id, l.id AS landlord_id
       FROM flex_charge_statements s
       JOIN flex_charge_accounts a ON a.id = s.account_id
       JOIN landlords l ON l.id = a.landlord_id
       JOIN users     u ON u.id = l.user_id
      WHERE s.payment_id = $1 AND s.status = 'billed'`,
    [paymentId],
  )
  if (!stmt) return

  // S583 revolving: the auto-pull collected the MINIMUM. Credit it to the
  // statement (amount_paid — drives next cycle's carried balance + late-fee
  // check) and reduce the running account balance; the rest carries. The
  // statement is 'paid' = its minimum was collected, NOT that the balance is zero.
  let takeGamFee = false
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE flex_charge_statements
          SET status      = 'paid',
              settled_at  = NOW(),
              amount_paid = amount_paid + $2,
              updated_at  = NOW()
        WHERE id = $1`,
      [stmt.id, stmt.minimum_due],
    )
    await client.query(
      `UPDATE flex_charge_accounts
          SET current_balance = GREATEST(0, current_balance - $2), updated_at = NOW()
        WHERE id = $1`,
      [stmt.account_id, stmt.minimum_due],
    )
    // Claim GAM's monthly cut exactly once per statement (whether the first
    // dollar came via this auto-pull or an earlier pay-down). Atomic → safe.
    const feeClaim = await client.query(
      `UPDATE flex_charge_statements SET gam_fee_settled = TRUE, updated_at = NOW()
        WHERE id = $1 AND gam_fee_settled = FALSE RETURNING id`,
      [stmt.id],
    )
    takeGamFee = feeClaim.rows.length > 0
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // Merchant Transfer outside tx — fire only on landlords with a
  // Connect account. Failure leaves the funds on GAM's platform
  // balance; admin notification surfaces it for manual unblock.
  try {
    const connect = await queryOne<{ stripe_connect_account_id: string | null }>(
      `SELECT stripe_connect_account_id FROM users WHERE id = $1`,
      [stmt.landlord_user_id!],
    )
    if (!connect?.stripe_connect_account_id) {
      const { createAdminNotification } = await import('./adminNotifications')
      await createAdminNotification({
        severity: 'warn',
        category: 'flexcharge_merchant_transfer_pending',
        title:    `FlexCharge merchant Transfer waiting — landlord ${stmt.landlord_id} has no Connect`,
        body:     `Statement ${stmt.id} settled, merchant share is on platform balance pending Connect onboarding.`,
        context:  { statement_id: stmt.id, landlord_id: stmt.landlord_id },
      })
      return
    }
    // S583 revolving: the merchant receives the collected MINIMUM minus GAM's
    // monthly 1.5%/12 subscription — but only if this payment claimed GAM's cut
    // (once per statement; a pay-down may have already taken it). GAM keeps
    // service_fee on the platform balance.
    const merchantPayout = takeGamFee
      ? Math.max(0, fcRound2(Number(stmt.minimum_due) - Number(stmt.service_fee)))
      : fcRound2(Number(stmt.minimum_due))
    const stripe = getStripe()
    await stripe.transfers.create(
      {
        amount:      Math.round(merchantPayout * 100),
        currency:    'usd',
        destination: connect.stripe_connect_account_id,
        description: `FlexCharge merchant payout — statement ${stmt.id}`,
        metadata: {
          gam_purpose:      'flexcharge_merchant_payout',
          gam_statement_id: stmt.id,
          gam_account_id:   stmt.account_id,
          gam_landlord_id:  stmt.landlord_id,
        },
      },
      { idempotencyKey: `flexcharge_payout_${stmt.id}` },
    )
  } catch (e) {
    logger.error({ err: e, ctx: stmt.id }, '[flexcharge][merchant-transfer]')
  }
}

/**
 * S583 revolving: charge a customer pay-DOWN against their FlexCharge balance
 * (more than the auto-pulled minimum, up to paying in full → interest-free grace
 * next cycle). Charges the customer's default method on the platform rail; the
 * balance credit + merchant transfer happen on settle (reconcileFlexChargePaydown).
 */
export async function payDownFlexCharge(args: {
  accountId: string
  tenantId:  string
  amount:    number
}): Promise<{ paymentId: string; amount: number; paymentIntentId: string }> {
  if (!await isFlexChargeVisible()) throw new AppError(403, 'FlexCharge is not available')
  const amount = fcRound2(args.amount)
  if (!(amount > 0)) throw new AppError(400, 'Enter an amount greater than zero')

  const acct = await queryOne<{
    id: string; current_balance: string; landlord_id: string;
    tenant_stripe: string | null; open_stmt: string | null;
  }>(
    `SELECT a.id, a.current_balance::text, a.landlord_id,
            t.stripe_customer_id AS tenant_stripe,
            (SELECT s.id FROM flex_charge_statements s
              WHERE s.account_id = a.id AND s.status IN ('open','billed','paid')
              ORDER BY s.cycle_month DESC LIMIT 1) AS open_stmt
       FROM flex_charge_accounts a
       JOIN tenants t ON t.id = a.tenant_id
      WHERE a.id = $1 AND a.tenant_id = $2`,
    [args.accountId, args.tenantId])
  if (!acct) throw new AppError(404, 'FlexCharge account not found')
  if (!acct.open_stmt) throw new AppError(409, 'No statement to pay down yet')
  if (!acct.tenant_stripe) throw new AppError(409, 'Add and verify a payment method first')
  const balance = Number(acct.current_balance)
  if (amount > balance + 0.005) throw new AppError(400, `That is more than your balance of $${balance.toFixed(2)}`)

  const stripe = getStripe()
  let paymentMethodId: string | null = null
  try {
    const cust = await stripe.customers.retrieve(acct.tenant_stripe)
    if (cust && !(cust as any).deleted) {
      const c = cust as any
      paymentMethodId = c.invoice_settings?.default_payment_method ?? c.default_source ?? null
    }
  } catch {}
  if (!paymentMethodId) throw new AppError(409, 'No default payment method on file')

  const intent = await createRentPlatformCharge({
    amount,
    stripeCustomerId:   acct.tenant_stripe,
    paymentMethodId,
    paymentMethodTypes: ['us_bank_account', 'card'],
    entryDescription:   'FCPAYDOWN',
    metadata: {
      gam_purpose:      'flexcharge_paydown',
      gam_account_id:   args.accountId,
      gam_statement_id: acct.open_stmt,
    },
  })
  const pay = await queryOne<{ id: string }>(
    `INSERT INTO payments
       (landlord_id, tenant_id, lease_id, unit_id, type, amount, status,
        entry_description, due_date, stripe_payment_intent_id, notes)
     VALUES ($1, $2, NULL, NULL, 'fee', $3, 'pending', 'FCPAYDOWN',
             CURRENT_DATE, $4, 'FlexCharge pay-down')
     RETURNING id`,
    [acct.landlord_id, args.tenantId, amount.toFixed(2), intent.id])
  return { paymentId: pay!.id, amount, paymentIntentId: intent.id }
}

/**
 * On settle of a FCPAYDOWN payment: credit the amount to the statement's
 * amount_paid, reduce the running balance, claim GAM's monthly cut if not yet
 * taken (once per statement), and transfer the rest to the merchant.
 */
export async function reconcileFlexChargePaydown(
  paymentId: string,
  metadata: Record<string, string>,
): Promise<void> {
  const statementId = metadata.gam_statement_id
  if (!statementId) return

  const pay = await queryOne<{ amount: string; entry_description: string | null }>(
    `SELECT amount::text, entry_description FROM payments WHERE id = $1`, [paymentId])
  if (!pay || pay.entry_description !== 'FCPAYDOWN') return
  const amount = fcRound2(Number(pay.amount))

  const stmt = await queryOne<{
    id: string; account_id: string; service_fee: string;
    landlord_user_id: string | null; landlord_id: string;
  }>(
    `SELECT s.id, s.account_id, s.service_fee::text,
            u.id AS landlord_user_id, l.id AS landlord_id
       FROM flex_charge_statements s
       JOIN flex_charge_accounts a ON a.id = s.account_id
       JOIN landlords l ON l.id = a.landlord_id
       JOIN users     u ON u.id = l.user_id
      WHERE s.id = $1`,
    [statementId])
  if (!stmt) return

  let takeGamFee = false
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE flex_charge_statements SET amount_paid = amount_paid + $2, updated_at = NOW() WHERE id = $1`,
      [stmt.id, amount])
    await client.query(
      `UPDATE flex_charge_accounts SET current_balance = GREATEST(0, current_balance - $2), updated_at = NOW() WHERE id = $1`,
      [stmt.account_id, amount])
    const feeClaim = await client.query(
      `UPDATE flex_charge_statements SET gam_fee_settled = TRUE, updated_at = NOW()
        WHERE id = $1 AND gam_fee_settled = FALSE RETURNING id`, [stmt.id])
    takeGamFee = feeClaim.rows.length > 0
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }

  try {
    const connect = await queryOne<{ stripe_connect_account_id: string | null }>(
      `SELECT stripe_connect_account_id FROM users WHERE id = $1`, [stmt.landlord_user_id!])
    if (!connect?.stripe_connect_account_id) {
      const { createAdminNotification } = await import('./adminNotifications')
      await createAdminNotification({
        severity: 'warn', category: 'flexcharge_merchant_transfer_pending',
        title: `FlexCharge pay-down waiting — landlord ${stmt.landlord_id} has no Connect`,
        body:  `Pay-down on statement ${stmt.id} settled; merchant share on platform balance pending Connect.`,
        context: { statement_id: stmt.id, landlord_id: stmt.landlord_id },
      })
      return
    }
    const merchantPayout = takeGamFee
      ? Math.max(0, fcRound2(amount - Number(stmt.service_fee)))
      : amount
    if (merchantPayout <= 0) return
    const stripe = getStripe()
    await stripe.transfers.create(
      {
        amount:      Math.round(merchantPayout * 100),
        currency:    'usd',
        destination: connect.stripe_connect_account_id,
        description: `FlexCharge pay-down payout — statement ${stmt.id}`,
        metadata: {
          gam_purpose:      'flexcharge_merchant_payout',
          gam_statement_id: stmt.id,
          gam_account_id:   stmt.account_id,
          gam_landlord_id:  stmt.landlord_id,
          gam_paydown:      'true',
        },
      },
      { idempotencyKey: `flexcharge_paydown_${paymentId}` },
    )
  } catch (e) {
    logger.error({ err: e, ctx: stmt.id }, '[flexcharge][paydown-transfer]')
  }
}

/**
 * Called from webhooks payment_intent.payment_failed for a
 * FLEXCHARGE_STMT payment. Standard NACHA retry pipeline handles
 * the first failure; the second failure (retry_count >= 1) lands
 * the statement in 'failed' status and suspends the customer's
 * FlexCharge account. GAM doesn't front the merchant — they're
 * notified the customer NSF'd and can pursue directly. Deferred-
 * debit framing per S253 design.
 */
export async function handleFlexChargeStatementNsf(paymentId: string): Promise<void> {
  const p = await queryOne<{
    id: string; entry_description: string | null; retry_count: number | null;
  }>(
    `SELECT id, entry_description, retry_count FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!p || p.entry_description !== 'SUBSCRIP') return
  if ((p.retry_count ?? 0) < 1) return  // first failure → defer to achRetry

  const stmt = await queryOne<{ id: string; account_id: string }>(
    `SELECT id, account_id FROM flex_charge_statements WHERE payment_id = $1`,
    [paymentId],
  )
  if (!stmt) return

  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE flex_charge_statements
          SET status = 'failed', failed_reason = 'tenant_nsf_second_failure',
              updated_at = NOW()
        WHERE id = $1`,
      [stmt.id],
    )
    await client.query(
      `UPDATE flex_charge_accounts
          SET status = 'suspended', updated_at = NOW()
        WHERE id = $1`,
      [stmt.account_id],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'flexcharge_statement_nsf',
      title:    `FlexCharge NSF — statement ${stmt.id}`,
      body:     `Customer ACH failed twice on FlexCharge statement ${stmt.id}; account suspended. Merchant has not been paid for this cycle's charges (deferred-debit posture — no GAM guarantee).`,
      context:  { statement_id: stmt.id, account_id: stmt.account_id },
    })
  } catch (e) { logger.error({ err: e }, '[flexcharge][nsf-alert]') }
}

// ── S253: Dispute engine + landlord cutoff ────────────────────

/**
 * Tenant or pos_customer disputes a specific FlexCharge transaction.
 * Marks the transaction 'disputed', the linked account 'disqualified'
 * (no cooldown — permanent per Nic). Then runs
 * checkAndDisqualifyLandlord against the merchant: 3 distinct
 * disputers in a rolling 90-day window flips the landlord's
 * flex_charge_disqualified_until field, blocking new charges
 * platform-wide.
 *
 * Caller must pass the disputer identity (tenantId or posCustomerId)
 * so the route layer can authz: only the affected customer can
 * dispute their own charges.
 */
export async function disputeFlexChargeTransaction(args: {
  transactionId: string
  disputerTenantId?: string | null
  disputerPosCustomerId?: string | null
  reason: string
}): Promise<{ accountId: string; landlordId: string; landlordDisqualified: boolean }> {
  if (!args.reason || args.reason.length < 3) {
    throw new AppError(400, 'Dispute reason required (min 3 chars)')
  }
  const tx = await queryOne<{
    id: string; account_id: string; status: string;
    tenant_id: string | null; pos_customer_id: string | null;
    landlord_id: string;
  }>(
    `SELECT t.id, t.account_id, t.status,
            a.tenant_id, a.pos_customer_id, a.landlord_id
       FROM flex_charge_transactions t
       JOIN flex_charge_accounts a ON a.id = t.account_id
      WHERE t.id = $1`,
    [args.transactionId],
  )
  if (!tx) throw new AppError(404, 'Transaction not found')

  // Authz — only the account's customer can dispute their own tx.
  if (args.disputerTenantId && tx.tenant_id !== args.disputerTenantId) {
    throw new AppError(403, 'Not your charge')
  }
  if (args.disputerPosCustomerId && tx.pos_customer_id !== args.disputerPosCustomerId) {
    throw new AppError(403, 'Not your charge')
  }
  if (!args.disputerTenantId && !args.disputerPosCustomerId) {
    throw new AppError(400, 'disputerTenantId or disputerPosCustomerId required')
  }

  if (tx.status === 'disputed') {
    throw new AppError(409, 'Already disputed')
  }
  if (tx.status === 'paid') {
    throw new AppError(409, 'Cannot dispute a paid charge — request a refund instead')
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE flex_charge_transactions
          SET status = 'disputed', disputed_at = NOW(),
              dispute_reason = $1, updated_at = NOW()
        WHERE id = $2`,
      [args.reason.slice(0, 500), tx.id],
    )
    await client.query(
      `UPDATE flex_charge_accounts
          SET status = 'disqualified',
              disqualified_reason = 'tenant_dispute',
              updated_at = NOW()
        WHERE id = $1`,
      [tx.account_id],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  const landlordDisqualified = await checkAndDisqualifyLandlord(tx.landlord_id)
  return {
    accountId: tx.account_id,
    landlordId: tx.landlord_id,
    landlordDisqualified,
  }
}

/**
 * Threshold check — counts distinct disputers (tenants + pos_customers)
 * who've filed FlexCharge disputes against this landlord in the
 * trailing 90 days. If >= 3, sets the landlord's flex_charge_disqualified_until
 * to NOW() + a long horizon (5 years — effectively permanent;
 * admin can NULL it out manually after review).
 *
 * Returns true iff the threshold was hit on this call.
 */
export async function checkAndDisqualifyLandlord(landlordId: string): Promise<boolean> {
  const row = await queryOne<{ disputer_count: number; already_disqualified: boolean }>(
    `WITH disputers AS (
       SELECT DISTINCT COALESCE(a.tenant_id::text, a.pos_customer_id::text) AS disputer_id
         FROM flex_charge_transactions t
         JOIN flex_charge_accounts a ON a.id = t.account_id
        WHERE a.landlord_id = $1
          AND t.status = 'disputed'
          AND t.disputed_at >= NOW() - INTERVAL '${LANDLORD_DISPUTE_THRESHOLD_DAYS} days'
     )
     SELECT (SELECT COUNT(*)::int FROM disputers) AS disputer_count,
            (SELECT flex_charge_disqualified_until IS NOT NULL
                AND flex_charge_disqualified_until > NOW()
               FROM landlords WHERE id = $1) AS already_disqualified`,
    [landlordId],
  )
  if (!row) return false
  if (row.disputer_count < LANDLORD_DISPUTE_THRESHOLD_COUNT) return false
  if (row.already_disqualified) return true  // already cut off; nothing new

  await query(
    `UPDATE landlords
        SET flex_charge_disqualified_until  = NOW() + INTERVAL '5 years',
            flex_charge_disqualified_reason = $1,
            updated_at                       = NOW()
      WHERE id = $2`,
    [`${row.disputer_count} distinct disputers in trailing ${LANDLORD_DISPUTE_THRESHOLD_DAYS} days`, landlordId],
  )

  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'flexcharge_landlord_disqualified',
      title:    `FlexCharge merchant cutoff — landlord ${landlordId}`,
      body:     `Landlord ${landlordId} hit the dispute threshold (${row.disputer_count} distinct disputers in trailing ${LANDLORD_DISPUTE_THRESHOLD_DAYS} days). New FlexCharge charges blocked. Open statements continue to bill. Admin review at /admin/landlords/${landlordId} to unblock.`,
      context:  { landlord_id: landlordId, disputer_count: row.disputer_count, threshold_days: LANDLORD_DISPUTE_THRESHOLD_DAYS },
    })
  } catch (e) {
    logger.error({ err: e }, '[flexcharge][landlord-disq-alert]')
  }
  return true
}
