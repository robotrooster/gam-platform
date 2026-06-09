import { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { isFeatureEnabled } from './systemFeatures'
import { AppError } from '../middleware/errorHandler'
import { getStripe } from '../lib/stripe'
import { createRentPlatformCharge } from './stripeConnect'
import { computeTenantGamOutstandingTotal } from './supersedence'
import {
  FLEX_CHARGE_STATEMENT_FEE_PCT,
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
// monthly statement → ACH auto-pull for the balance + a 1.5% service
// fee. No interest. No revolving balance. Auto-pay required.
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

export async function listPosCustomers(landlordId: string): Promise<PosCustomerRow[]> {
  return query<PosCustomerRow>(
    `SELECT * FROM pos_customers
      WHERE landlord_id = $1 AND archived_at IS NULL
      ORDER BY last_name, first_name`,
    [landlordId],
  )
}

export async function archivePosCustomer(args: { landlordId: string; customerId: string }): Promise<void> {
  // Soft-archive — don't break historical pos_transactions /
  // flex_charge_accounts that reference this row.
  const row = await queryOne<{ id: string }>(
    `UPDATE pos_customers
        SET archived_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL
      RETURNING id`,
    [args.customerId, args.landlordId],
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

export async function listFlexChargeAccounts(args: {
  landlordId: string
  propertyId?: string
  status?:    FlexChargeAccountStatus
}): Promise<Array<FlexChargeAccountRow & { customer_name: string | null; customer_email: string | null; balance: number }>> {
  const where: string[] = ['a.landlord_id = $1']
  const params: any[] = [args.landlordId]
  if (args.propertyId) { params.push(args.propertyId); where.push(`a.property_id = $${params.length}`) }
  if (args.status)     { params.push(args.status);     where.push(`a.status = $${params.length}`) }

  return query<any>(
    `SELECT a.*,
            COALESCE(
              tu.first_name || ' ' || tu.last_name,
              pc.first_name || ' ' || pc.last_name
            ) AS customer_name,
            COALESCE(tu.email, pc.email) AS customer_email,
            COALESCE((
              SELECT SUM(t.amount)
                FROM flex_charge_transactions t
               WHERE t.account_id = a.id
                 AND t.status IN ('pending', 'billed')
            ), 0)::float AS balance
       FROM flex_charge_accounts a
       LEFT JOIN tenants     t   ON t.id = a.tenant_id
       LEFT JOIN users       tu  ON tu.id = t.user_id
       LEFT JOIN pos_customers pc ON pc.id = a.pos_customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC`,
    params,
  )
}

export async function updateFlexChargeAccount(args: {
  landlordId:   string
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

  params.push(args.accountId, args.landlordId)
  const row = await queryOne<FlexChargeAccountRow>(
    `UPDATE flex_charge_accounts
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length - 1} AND landlord_id = $${params.length}
      RETURNING *`,
    params,
  )
  if (!row) throw new AppError(404, 'Account not found')
  return row
}

export interface AccountStatementRow {
  id:             string
  cycle_month:    string
  balance:        string
  service_fee:    string
  total_due:      string
  due_date:       string
  status:         'open' | 'billed' | 'paid' | 'failed' | 'voided'
  billed_at:      string | null
  settled_at:     string | null
  failed_reason:  string | null
  created_at:     string
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
  landlordId: string
  accountId:  string
}): Promise<{ statements: AccountStatementRow[]; disputes: DisputedTransactionRow[] }> {
  const acct = await queryOne<{ id: string }>(
    'SELECT id FROM flex_charge_accounts WHERE id=$1 AND landlord_id=$2',
    [args.accountId, args.landlordId],
  )
  if (!acct) throw new AppError(404, 'Account not found')
  const statements = await query<AccountStatementRow>(
    `SELECT id, cycle_month::text, balance::text, service_fee::text,
            total_due::text, due_date::text, status,
            billed_at, settled_at, failed_reason, created_at
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

    const acct = await client.query<FlexChargeAccountRow & { balance: string; landlord_disqualified_until: string | null }>(
      `SELECT a.*,
              COALESCE((
                SELECT SUM(t.amount)
                  FROM flex_charge_transactions t
                 WHERE t.account_id = a.id
                   AND t.status IN ('pending', 'billed')
              ), 0)::text AS balance,
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
    const currentBalance = Number(acct.balance)
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
  statement_id:  string
  account_id:    string
  cycle_month:   string
  balance:       number
  service_fee:   number
  total_due:     number
  due_date:      string
  tx_count:      number
}

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

    const acct = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM flex_charge_accounts WHERE id = $1 FOR UPDATE`,
      [args.accountId],
    ).then(r => r.rows[0])
    if (!acct) throw new AppError(404, 'Account not found')

    // Find all pending transactions in this cycle window.
    const cycleStart = args.cycleMonth.slice(0, 10)
    const txs = await client.query<{ id: string; amount: string }>(
      `SELECT id, amount::text
         FROM flex_charge_transactions
        WHERE account_id = $1
          AND status = 'pending'
          AND created_at >= $2::date
          AND created_at <  ($2::date + INTERVAL '1 month')`,
      [args.accountId, cycleStart],
    )

    if (txs.rows.length === 0) {
      await client.query('ROLLBACK')
      return null
    }

    const balance = txs.rows.reduce((s, r) => s + Number(r.amount), 0)
    const serviceFee = Math.round(balance * FLEX_CHARGE_STATEMENT_FEE_PCT * 100) / 100
    const totalDue = Math.round((balance + serviceFee) * 100) / 100

    // Due date = 15th of the next month
    const cycleDate = new Date(cycleStart + 'T00:00:00Z')
    const dueDate = new Date(Date.UTC(cycleDate.getUTCFullYear(), cycleDate.getUTCMonth() + 1, 15))
      .toISOString().slice(0, 10)

    // Insert statement. UNIQUE catches the double-run case.
    let stmtId: string
    try {
      const stmt = await client.query<{ id: string }>(
        `INSERT INTO flex_charge_statements
           (account_id, cycle_month, balance, service_fee, total_due, due_date)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [args.accountId, cycleStart, balance.toFixed(2), serviceFee.toFixed(2), totalDue.toFixed(2), dueDate],
      )
      stmtId = stmt.rows[0].id
    } catch (e: any) {
      if (e?.code === '23505') {
        await client.query('ROLLBACK')
        throw new AppError(409, `Statement already exists for ${cycleStart} on account ${args.accountId}`)
      }
      throw e
    }

    // Flip the included transactions to 'billed' with statement_id stamped.
    const txIds = txs.rows.map(r => r.id)
    await client.query(
      `UPDATE flex_charge_transactions
          SET status       = 'billed',
              statement_id = $1,
              updated_at   = NOW()
        WHERE id = ANY($2::uuid[])`,
      [stmtId, txIds],
    )

    await client.query('COMMIT')
    return {
      statement_id: stmtId,
      account_id:   args.accountId,
      cycle_month:  cycleStart,
      balance,
      service_fee:  serviceFee,
      total_due:    totalDue,
      due_date:     dueDate,
      tx_count:     txIds.length,
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
  const accounts = await query<any>(
    `SELECT a.id, a.property_id, a.credit_limit::text, a.status,
            a.disqualified_until::text, a.disqualified_reason,
            p.name AS property_name,
            COALESCE((
              SELECT SUM(t.amount)
                FROM flex_charge_transactions t
               WHERE t.account_id = a.id
                 AND t.status IN ('pending', 'billed')
            ), 0)::text AS balance
       FROM flex_charge_accounts a
       JOIN properties p ON p.id = a.property_id
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
 * Gross lands on platform balance (GAM collects merchant's deferred
 * receivable + the 1.5% service fee in one pull). The
 * merchant-share Transfer fires post-success so GAM doesn't pre-pay
 * the merchant before customer ACH clears.
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
    total_due:           string
    landlord_id:         string
    property_id:         string
    tenant_id:           string | null
    pos_customer_id:     string | null
    customer_stripe_id:  string | null
    customer_label:      string
  }>(
    `SELECT s.id AS statement_id, s.account_id, s.cycle_month::text AS cycle_month,
            s.total_due::text  AS total_due,
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

      const baseAmount = Number(r.total_due)
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
 * FLEXCHARGE_STMT-tagged payment. Flips the linked statement +
 * its included transactions to 'paid', then fires the merchant
 * Transfer (balance amount only; the 1.5% fee stays on platform
 * as GAM revenue).
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
    id: string; account_id: string; balance: string; service_fee: string;
    landlord_user_id: string | null; landlord_id: string;
  }>(
    `SELECT s.id, s.account_id, s.balance::text, s.service_fee::text,
            u.id AS landlord_user_id, l.id AS landlord_id
       FROM flex_charge_statements s
       JOIN flex_charge_accounts a ON a.id = s.account_id
       JOIN landlords l ON l.id = a.landlord_id
       JOIN users     u ON u.id = l.user_id
      WHERE s.payment_id = $1 AND s.status = 'billed'`,
    [paymentId],
  )
  if (!stmt) return

  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE flex_charge_statements
          SET status     = 'paid',
              settled_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [stmt.id],
    )
    await client.query(
      `UPDATE flex_charge_transactions
          SET status     = 'paid',
              updated_at = NOW()
        WHERE statement_id = $1 AND status = 'billed'`,
      [stmt.id],
    )
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
    const balance = Number(stmt.balance)
    const stripe = getStripe()
    await stripe.transfers.create(
      {
        amount:      Math.round(balance * 100),
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
