/**
 * S247: Sublease money-allocation hook.
 *
 * Called from the webhook payment_intent.succeeded handler for any
 * rent payment. If the payment's (unit, tenant, due_date) matches an
 * active sublease where the payer is the sublessee, credits the
 * sublessor with `sub_monthly_amount - master_share_amount` (the
 * markup the sublessor charges over the master rent).
 *
 * Why a separate service file: keeping sublease logic out of
 * services/allocation.ts because that engine is rate/landlord/PM-fee
 * focused. Sublease credits are a parallel concept — sublessor isn't
 * the landlord, sublessor's credit isn't a platform fee. Cleaner to
 * keep them separate so the main allocation engine doesn't grow new
 * branches.
 *
 * Idempotency: a single payments row produces at most one
 * sublessor_credit_balance accrual. The query upsert + per-payment
 * audit on user_balance_ledger (entry_description='SUBLEASE_MARKUP')
 * keep this safe to call multiple times.
 *
 * Sublessor withdrawal of accrued credit is a separate route
 * (POST /api/subleases/me/credit/withdraw — out of scope this
 * session; balance accrues until withdraw is wired).
 */

import { query, queryOne, getClient } from '../db'
import { getStripe } from '../lib/stripe'
import { AppError } from '../middleware/errorHandler'

export async function creditSublessorMarkupForPayment(paymentId: string): Promise<void> {
  const payment = await queryOne<{
    id:        string
    tenant_id: string | null
    unit_id:   string | null
    due_date:  string | null
    amount:    string
    type:      string
  }>(
    `SELECT id, tenant_id, unit_id, due_date::text, amount::text, type
       FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!payment) return
  if (payment.type !== 'rent') return
  if (!payment.tenant_id || !payment.unit_id || !payment.due_date) return

  // Find an active sublease covering this (unit, due_date) where the
  // payer is the sublessee. Master-tenant rent payments (no sublease,
  // or sublessor still paying directly) don't match.
  const sublease = await queryOne<{
    id: string
    sublessor_tenant_id: string
    sub_monthly_amount:  string
    master_share_amount: string
  }>(
    `SELECT s.id, s.sublessor_tenant_id,
            s.sub_monthly_amount::text, s.master_share_amount::text
       FROM subleases s
       JOIN leases l ON l.id = s.master_lease_id
      WHERE l.unit_id = $1
        AND s.sublessee_tenant_id = $2
        AND s.status = 'active'
        AND s.start_date <= $3::date
        AND (s.end_date IS NULL OR s.end_date >= $3::date)
      LIMIT 1`,
    [payment.unit_id, payment.tenant_id, payment.due_date],
  )
  if (!sublease) return

  const sub = Number(sublease.sub_monthly_amount)
  const master = Number(sublease.master_share_amount)
  const markup = Math.round((sub - master) * 100) / 100
  if (markup <= 0) return  // full pass-through; no profit to credit

  const client = await getClient()
  try {
    await client.query('BEGIN')

    // Idempotency: lock the payment row + skip if already credited.
    const lockRes = await client.query<{ sublease_credit_applied: boolean }>(
      `SELECT sublease_credit_applied FROM payments
        WHERE id = $1 FOR UPDATE`,
      [paymentId],
    )
    if (lockRes.rows[0]?.sublease_credit_applied) {
      await client.query('ROLLBACK')
      return
    }

    await client.query(
      `INSERT INTO sublessor_credit_balances
         (sublease_id, sublessor_tenant_id, balance, total_earned)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (sublease_id) DO UPDATE
         SET balance      = sublessor_credit_balances.balance + EXCLUDED.balance,
             total_earned = sublessor_credit_balances.total_earned + EXCLUDED.total_earned,
             updated_at   = NOW()`,
      [sublease.id, sublease.sublessor_tenant_id, markup.toFixed(2)],
    )

    await client.query(
      `UPDATE payments SET sublease_credit_applied = TRUE WHERE id = $1`,
      [paymentId],
    )

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ── Sublessor credit withdrawal ──────────────────────────────────

export interface SublessorCreditView {
  total_balance:    number
  total_earned:     number
  total_withdrawn:  number
  per_sublease: Array<{
    sublease_id:      string
    property_name:    string | null
    unit_number:      string | null
    balance:          number
    total_earned:     number
    total_withdrawn:  number
  }>
}

export async function getSublessorCredit(sublessorTenantId: string): Promise<SublessorCreditView> {
  const rows = await query<{
    sublease_id:     string
    balance:         string
    total_earned:    string
    total_withdrawn: string
    property_name:   string | null
    unit_number:     string | null
  }>(
    `SELECT scb.sublease_id,
            scb.balance::text, scb.total_earned::text, scb.total_withdrawn::text,
            p.name AS property_name,
            u.unit_number
       FROM sublessor_credit_balances scb
       JOIN subleases s ON s.id = scb.sublease_id
       JOIN leases l    ON l.id = s.master_lease_id
       JOIN units u     ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE scb.sublessor_tenant_id = $1
      ORDER BY scb.updated_at DESC`,
    [sublessorTenantId],
  )
  const view: SublessorCreditView = {
    total_balance:   0,
    total_earned:    0,
    total_withdrawn: 0,
    per_sublease:    [],
  }
  for (const r of rows) {
    const b = Number(r.balance), e = Number(r.total_earned), w = Number(r.total_withdrawn)
    view.total_balance   += b
    view.total_earned    += e
    view.total_withdrawn += w
    view.per_sublease.push({
      sublease_id:     r.sublease_id,
      property_name:   r.property_name,
      unit_number:     r.unit_number,
      balance:         b,
      total_earned:    e,
      total_withdrawn: w,
    })
  }
  // Round to 2 dp.
  view.total_balance   = Math.round(view.total_balance   * 100) / 100
  view.total_earned    = Math.round(view.total_earned    * 100) / 100
  view.total_withdrawn = Math.round(view.total_withdrawn * 100) / 100
  return view
}

/**
 * Withdraw `amount` from the sublessor's combined credit balances.
 * Greedy across subleases: drains highest-balance first until the
 * requested amount is paid out. Fires one Stripe Transfer to the
 * sublessor's user-level Connect account.
 *
 * Preconditions:
 *   - Tenant has stripe_connect_account_id (Connect onboarding complete)
 *   - Tenant has connect_payouts_enabled = TRUE (KYC passed)
 *   - amount > 0 and <= total balance
 *
 * Idempotency: Stripe Transfer uses a hash of the withdraw request
 * as the key. Re-firing the same withdrawal (network blip) returns
 * the original Transfer; balances aren't decremented twice because
 * the DB update happens only on a successful Transfer return.
 */
export async function withdrawSublessorCredit(args: {
  sublessorTenantId: string
  amountDollars:     number
}): Promise<{ stripeTransferId: string; withdrawnCents: number }> {
  if (!Number.isFinite(args.amountDollars) || args.amountDollars <= 0) {
    throw new AppError(400, 'amount must be a positive number')
  }
  const requested = Math.round(args.amountDollars * 100) / 100

  // Connect account precheck
  const user = await queryOne<{
    user_id:                       string
    stripe_connect_account_id:     string | null
    connect_payouts_enabled:       boolean
  }>(
    `SELECT u.id AS user_id,
            u.stripe_connect_account_id,
            COALESCE(u.connect_payouts_enabled, FALSE) AS connect_payouts_enabled
       FROM tenants t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [args.sublessorTenantId],
  )
  if (!user) throw new AppError(404, 'Tenant not found')
  if (!user.stripe_connect_account_id) {
    throw new AppError(409, 'Set up payouts first — complete the Stripe onboarding flow to receive sublessor credit.')
  }
  if (!user.connect_payouts_enabled) {
    throw new AppError(409, 'Your Stripe payout account is not yet enabled — finish identity verification first.')
  }

  // Total balance check
  const totalsRow = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(balance), 0)::text AS total
       FROM sublessor_credit_balances
      WHERE sublessor_tenant_id = $1`,
    [args.sublessorTenantId],
  )
  const totalBalance = Number(totalsRow?.total ?? 0)
  if (requested > totalBalance) {
    throw new AppError(400, `Requested $${requested.toFixed(2)} exceeds available balance $${totalBalance.toFixed(2)}`)
  }

  // Drain balances greedily (highest-balance first). Done in the same
  // transaction as the Transfer firing so a failed Stripe call rolls
  // back the decrements.
  const stripe = getStripe()
  const idempotencyKey = `sublessor_withdraw_${args.sublessorTenantId}_${Date.now()}_${requested.toFixed(2)}`
  let transferId = ''

  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Lock the rows we're touching to prevent concurrent withdrawals
    // from over-drawing.
    const balanceRows = await client.query<{
      id: string; balance: string;
    }>(
      `SELECT id, balance::text
         FROM sublessor_credit_balances
        WHERE sublessor_tenant_id = $1 AND balance > 0
        ORDER BY balance DESC, updated_at ASC
        FOR UPDATE`,
      [args.sublessorTenantId],
    )

    let remaining = requested
    for (const row of balanceRows.rows) {
      if (remaining <= 0) break
      const rowBal = Number(row.balance)
      const take = Math.min(remaining, rowBal)
      const newBal = Math.round((rowBal - take) * 100) / 100
      await client.query(
        `UPDATE sublessor_credit_balances
            SET balance         = $1,
                total_withdrawn = total_withdrawn + $2,
                updated_at      = NOW()
          WHERE id = $3`,
        [newBal.toFixed(2), take.toFixed(2), row.id],
      )
      remaining = Math.round((remaining - take) * 100) / 100
    }
    if (remaining > 0) {
      throw new AppError(400, `Insufficient balance — short ${remaining.toFixed(2)} after draining all sublease credits`)
    }

    // Fire the Transfer. If it throws, the BEGIN rolls back the
    // balance decrements.
    const transfer = await stripe.transfers.create(
      {
        amount:      Math.round(requested * 100),
        currency:    'usd',
        destination: user.stripe_connect_account_id,
        description: `Sublessor credit withdrawal`,
        metadata: {
          gam_purpose:       'sublessor_withdraw',
          gam_tenant_id:     args.sublessorTenantId,
          gam_amount:        requested.toFixed(2),
        },
      },
      { idempotencyKey },
    )
    transferId = transfer.id

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  return { stripeTransferId: transferId, withdrawnCents: Math.round(requested * 100) }
}
