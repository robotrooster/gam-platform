/**
 * S195: lease_fees sync helpers for the leases.security_deposit
 * deprecation. Phase 1 — every writer of leases.security_deposit also
 * upserts a corresponding lease_fees row with fee_type='security_deposit',
 * due_timing='move_in'. Phase 2 (next session) switches readers to
 * lease_fees and drops the column.
 *
 * Pattern is delete-then-insert because lease_fees lacks a UNIQUE
 * constraint on (lease_id, fee_type, due_timing) — multiple move_in
 * rows of different fee_types are intentional, and ON CONFLICT
 * doesn't have a target. The DELETE-INSERT round-trip is acceptable
 * for lease creation / patch flows (low volume; not hot path).
 *
 * S515: this helper is ALSO the canonical creation point for the
 * `security_deposits` row. Before S515 that table was read by FlexDeposit
 * custody, deposit portability, OTP deposits, interest accrual, and
 * deposit-return — but written nowhere in production (only tests). Now
 * every lease that gets a deposit amount also gets a `security_deposits`
 * row (status='pending', held_by PLANNED from the lease's source and the S604
 * custody gate) so the whole subsystem actually functions. See
 * syncSecurityDepositRow. 10/4 (decisions #46.3): the planned holder is only a
 * plan — when the deposit is paid, reconcileSettledDepositPayment sets it from
 * HOW it was collected (through GAM → GAM; in person or into the landlord's
 * bank → the landlord).
 */

import type { PoolClient } from 'pg'
import { db, query, queryOne } from '../db'

/**
 * Upsert the security_deposit lease_fees row for a lease. When amount
 * is 0 or null, removes any existing row (landlord set deposit to
 * none).
 *
 * Caller can pass a transaction client; if omitted, runs outside any
 * transaction (best-effort).
 */
export async function syncSecurityDepositLeaseFee(
  leaseId: string,
  amount: number,
  client?: PoolClient,
): Promise<void> {
  const exec = async (sql: string, params: any[]): Promise<void> => {
    if (client) {
      await client.query(sql, params)
    } else {
      await query(sql, params)
    }
  }

  // Always remove any existing security_deposit move_in row first —
  // simpler than trying to UPDATE in place, and there's no UNIQUE
  // constraint to upsert against.
  await exec(
    `DELETE FROM lease_fees
      WHERE lease_id = $1
        AND fee_type = 'security_deposit'
        AND due_timing = 'move_in'`,
    [leaseId],
  )

  if (!amount || amount <= 0) {
    // Amount cleared → also drop the security_deposits row if it's still
    // untouched (no FlexDeposit plan, nothing collected).
    await syncSecurityDepositRow(leaseId, 0, client)
    return
  }

  // S360 fix: lease_fees.is_refundable is NOT NULL. Pre-S360 the INSERT
  // omitted it, crashing every CSV-tenant commit that had a
  // security_deposit > 0 with "null value in column 'is_refundable'
  // violates not-null constraint" — the entire commit transaction
  // rolled back, so any tenant import with a deposit failed end-to-end.
  // Security deposits are refundable by definition; hardcode TRUE.
  await exec(
    `INSERT INTO lease_fees (lease_id, fee_type, due_timing, amount, description, is_refundable)
     VALUES ($1, 'security_deposit', 'move_in', $2, 'Security deposit', TRUE)`,
    [leaseId, amount],
  )

  // S515: maintain the parallel security_deposits row (FlexDeposit /
  // portability / interest / deposit-return all read it).
  await syncSecurityDepositRow(leaseId, amount, client)
}

/**
 * S515: create / maintain the `security_deposits` row for a lease from
 * the live deposit amount. This is the production creation path the table
 * never had (pre-S515 only tests inserted rows).
 *
 * held_by here is the PLAN (see the CASE below: lease source + the S604
 * custody gate; a property's deposit_handling_mode 'gam_escrow' only means the
 * landlord turned an imported tenancy's deposits over to GAM — FlexVault). The
 * row starts status='pending'; every settle of a deposit payment bumps
 * collected_amount + status AND sets held_by from how the money was actually
 * collected (reconcileSettledDepositPayment, decisions #46.3), and FlexDeposit
 * enrollment overlays its own columns.
 *
 * Idempotency landmine: this is an UPSERT, NOT delete-then-insert (unlike
 * the lease_fees side). Re-syncing a deposit amount must never wipe an
 * existing row's FlexDeposit plan, portability state, collected funds, or
 * accrued interest. So a row that is already FlexDeposit-enrolled or has
 * collected funds is left untouched (amount changes mid-plan are a
 * separate, deliberate flow — not a silent fee-edit side effect).
 */
export async function syncSecurityDepositRow(
  leaseId: string,
  amount: number,
  client?: PoolClient,
): Promise<void> {
  const exec = async (sql: string, params: any[]): Promise<void> => {
    if (client) { await client.query(sql, params) } else { await query(sql, params) }
  }
  const one = async <T extends Record<string, any>>(sql: string, params: any[]): Promise<T | null> => {
    if (client) return (await client.query<T>(sql, params)).rows[0] ?? null
    return queryOne<T>(sql, params)
  }

  const existing = await one<{
    id: string; flex_deposit_enabled: boolean; collected_amount: string; status: string
  }>(
    `SELECT id, flex_deposit_enabled, collected_amount::text, status
       FROM security_deposits
      WHERE lease_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [leaseId],
  )
  const touched = !!existing && (existing.flex_deposit_enabled || Number(existing.collected_amount) > 0)

  if (!amount || amount <= 0) {
    // Remove only an untouched row; never delete a funded / enrolled deposit.
    if (existing && !touched) {
      await exec(`DELETE FROM security_deposits WHERE id = $1`, [existing.id])
    }
    return
  }

  // Resolve unit + primary tenant + property holding mode.
  const ctx = await one<{ unit_id: string; tenant_id: string | null; held_by: string }>(
    `SELECT l.unit_id,
            (SELECT vlat.tenant_id
               FROM v_lease_active_tenants vlat
              WHERE vlat.lease_id = l.id AND vlat.role = 'primary'
              LIMIT 1) AS tenant_id,
            -- S602 deposit-trust model (Nic): a NEW-tenant lease (native to GAM —
            -- esigned/booking_draft/application_draft) ALWAYS has its deposit held
            -- by GAM in escrow; the tenant pays it through the platform and GAM
            -- keeps it in the segregated trust pool. Only an IMPORTED lease (the
            -- tenant existed before the landlord onboarded) stays in the landlord's
            -- custody — unless the landlord has turned that deposit over to GAM
            -- (property deposit_handling_mode='gam_escrow' = FlexVault). There is no
            -- per-property "who holds new deposits" toggle: new = GAM, always.
            --
            -- S604 CUSTODY GATE (overrides everything above): GAM may only take
            -- custody where the state's law permits the vehicle GAM actually
            -- uses. 21 states require deposits to sit in a bank/escrow/trust
            -- account at a (sometimes in-state) institution, which a brokerage
            -- Treasury position is not. Taking custody there would put tenant
            -- money somewhere unlawful — in Oklahoma, criminally so.
            --
            -- FAIL-CLOSED: a state with no row in state_deposit_custody_rules
            -- resolves to 'landlord'. Silence means "nobody has checked", never
            -- "go ahead". Flipping a state to supported later automatically
            -- lets new deposits flow to GAM with no code change.
            --
            -- Fix pass 1 (final fix): ONE gate — the same predicate as
            -- gamMayHoldDeposits below and depositCustody.canCustodyDeposits:
            -- supported AND the state allows the vehicle GAM uses (Treasury
            -- bills). Before this the plan read 'supported' alone, so a state
            -- supported without allows_treasury_bills was planned (and, paid
            -- through GAM, recorded) as GAM's where the gate says no.
            CASE
              WHEN NOT (COALESCE(cr.custody_status, 'needs_research') = 'supported'
                        AND COALESCE(cr.allows_treasury_bills, FALSE))
                THEN 'landlord'
              WHEN l.lease_source = 'imported'
                THEN CASE WHEN p.deposit_handling_mode = 'gam_escrow'
                          THEN 'gam_escrow' ELSE 'landlord' END
              ELSE 'gam_escrow'
            END AS held_by
       FROM leases l
       JOIN units u      ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN state_deposit_custody_rules cr ON cr.state_code = p.state
      WHERE l.id = $1`,
    [leaseId],
  )
  if (!ctx) return  // lease/unit/property missing — nothing to anchor to

  if (existing) {
    // Don't clobber an enrolled / funded deposit; only adjust the amount
    // and holding mode while the row is still untouched.
    if (touched) return
    await exec(
      `UPDATE security_deposits
          SET total_amount = $2, held_by = $3, unit_id = $4,
              tenant_id = COALESCE($5, tenant_id), updated_at = NOW()
        WHERE id = $1`,
      [existing.id, amount, ctx.held_by, ctx.unit_id, ctx.tenant_id],
    )
    return
  }

  // No row yet. Need a primary tenant to satisfy the NOT NULL tenant_id;
  // if none is attached yet, skip — a later sync (or move-in) creates it.
  if (!ctx.tenant_id) return
  await exec(
    `INSERT INTO security_deposits
       (unit_id, lease_id, tenant_id, total_amount, status, held_by)
     VALUES ($1, $2, $3, $4, 'pending', $5)`,
    [ctx.unit_id, leaseId, ctx.tenant_id, amount, ctx.held_by],
  )
}

/**
 * 10/4 (decisions #46.3, Nic, FINAL): who holds a deposit is decided by HOW IT
 * WAS COLLECTED, never by a property setting.
 *   'gam'      — paid electronically through GAM: a card or bank payment that
 *                settled on GAM's balance (platform_held — every card, bank,
 *                reader and autopay charge GAM makes for a lease bill is made
 *                that way, rentCharge) with no hand-payment method. GAM holds
 *                it until move-out, where the S604 custody gate lets it
 *                (otherwise the landlord, as before).
 *   'landlord' — paid in person (cash, a check or a money order at the desk or
 *                register, an agent-recorded cash payment, a posted receipt) or
 *                matched from a deposit into the landlord's own bank: the
 *                payment carries its hand-payment method. The landlord holds it,
 *                whatever was planned at billing. Also a card or bank payment
 *                whose money went straight to the landlord (a Stripe intent,
 *                not on GAM's balance — the old destination charges), and a
 *                deposit payment GAM released to them at move-out
 *                (depositReturn clears platform_held on it).
 *   null       — none of these facts is on the row (a hand-made test row): the
 *                planned holder stands.
 * ONE definition (SQL), for every reader that has to say who holds a deposit
 * payment: the record's holder here (reconcileSettledDepositPayment), the
 * move-out's refund split (depositReturn.settledDepositPayments) and the
 * renewal unwind (unwindIssuedLease.returnDepositCountedOnce). Step 9 review
 * (fix pass 2): before this the move-out read "GAM holds it" off platform_held
 * and the record read it off the Stripe intent — a Stripe-paid deposit not on
 * GAM's balance was recorded as GAM's (interest accrued, counted in trust)
 * while the move-out named the landlord as the one who refunds it.
 * `a` is the payments alias.
 */
export function depositCollectedBySql(a = 'p'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`depositCollectedBySql: "${a}" is not a table alias`)
  // Fix pass 1 (final fix): a deposit payment GAM took that a finalized
  // move-out has since used (finalize clears platform_held on it — its kept
  // part was paid to the landlord, the rest is a refund GAM owes, counted on
  // its own line in GAM's book) was still COLLECTED by GAM. Before this it
  // read 'landlord' afterwards (platform_held FALSE plus a Stripe intent),
  // though GAM took the money and may still owe part of it.
  //
  // Fix pass 2: told by a RECORDED fact, never by timing. Finalize clears
  // platform_held only on the deposit payments of a record GAM held
  // (security_deposits.held_by 'gam_escrow', set from the actual collection
  // when the deposit was paid — reconcileSettledDepositPayment); a Stripe
  // deposit passed straight to the landlord (a state where GAM may not hold
  // deposits) is on a record the landlord holds and keeps reading 'landlord'
  // before and after the move-out.
  //
  // Fix pass 3: told by the PAYMENT itself. Finalize stamps each GAM-held
  // deposit payment it releases with released_by_deposit_return_id (the same
  // UPDATE that clears platform_held) — the security deposit's GAM part AND a
  // pet, key or cleaning deposit GAM held. Before this only the security
  // deposit record's holder was read, so a pet deposit paid online through
  // GAM on a lease whose security deposit the landlord holds read 'landlord'
  // after finalize. The record test stays as the fallback for a return
  // finalized before the stamp existed.
  return `(CASE WHEN ${a}.manual_method IS NOT NULL THEN 'landlord'
                WHEN ${a}.platform_held THEN 'gam'
                WHEN ${a}.released_by_deposit_return_id IS NOT NULL THEN 'gam'
                WHEN ${a}.stripe_payment_intent_id IS NOT NULL AND ${a}.type = 'deposit' AND ${a}.settled_at IS NOT NULL
                     AND EXISTS (SELECT 1 FROM deposit_returns dcb_dr
                                   JOIN security_deposits dcb_sd ON dcb_sd.id = dcb_dr.security_deposit_id
                                  WHERE dcb_dr.lease_id = ${a}.lease_id
                                    AND dcb_dr.finalized_at IS NOT NULL
                                    AND dcb_sd.held_by = 'gam_escrow') THEN 'gam'
                WHEN ${a}.stripe_payment_intent_id IS NOT NULL THEN 'landlord'
                ELSE NULL END)`
}

/**
 * The S604 custody gate for one lease: may GAM hold deposits in this
 * property's state (state_deposit_custody_rules, fail-closed — a state nobody
 * has researched reads as "no")? The same rule syncSecurityDepositRow plans
 * with, and services/depositCustody.canCustodyDeposits reads.
 */
export async function gamMayHoldDeposits(runner: Pick<PoolClient, 'query'>, leaseId: string): Promise<boolean> {
  const r = await runner.query<{ ok: boolean }>(
    `SELECT (COALESCE(cr.custody_status, 'needs_research') = 'supported'
             AND COALESCE(cr.allows_treasury_bills, FALSE)) AS ok
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN state_deposit_custody_rules cr ON cr.state_code = p.state
      WHERE l.id = $1`, [leaseId])
  return r.rows[0]?.ok === true
}

/** What one settled security-deposit payment did to its deposit record. */
export interface DepositRecordRaised {
  depositId: string
  /** Dollars the record's collected amount rose by (0: it was already funded). */
  amount: number
  /** Who the record said held it before, and after (decisions #46.3). */
  priorHeldBy: string
  heldBy: string
  /** The record's status before (Undo puts it back). */
  priorStatus: string
}

/**
 * S515: on a settled regular (non-FlexDeposit) deposit payment, advance
 * the security_deposits row: bump collected_amount and flip status to
 * 'funded' (or 'partial'). FlexDeposit deposits do their own collected
 * accounting via the installment / pay-ahead reconcilers, so this skips
 * any FlexDeposit-enrolled row. Idempotent at the webhook layer (the
 * settle transition fires reconcile hooks exactly once).
 *
 * 10/4 (decisions #46.3): EVERY path that settles a security deposit calls
 * this — the Stripe webhook (portal, autopay, the counter card reader), and
 * every settle outside Stripe through services/manualPaymentSettle (the desk,
 * the landlord agent's cash payment, a posted receipt, the bank-deposit
 * match). It records WHO HOLDS the deposit from the actual collection
 * (depositCollectedBySql):
 *   - through GAM: GAM holds it (gam_escrow) when the record was already
 *     planned that way (the custody gate allowed it at billing) or the gate
 *     allows it now; otherwise the landlord, as before.
 *   - in person or into the landlord's bank: the landlord holds it — the
 *     record becomes 'landlord' when nothing on it was held yet. When GAM
 *     already holds part of it (paid through GAM earlier) the record stays
 *     'gam_escrow' and the landlord's part is told apart at move-out by its
 *     payment (depositReturn reads each payment's own collection).
 * FlexDeposit is left alone (its own accounting), and so is a record already
 * funded (the payment raised nothing). Returns what changed, or null.
 */
export async function reconcileSettledDepositPayment(
  paymentId: string,
  client?: PoolClient,
): Promise<DepositRecordRaised | null> {
  const exec = async (sql: string, params: any[]): Promise<void> => {
    if (client) { await client.query(sql, params) } else { await query(sql, params) }
  }
  const one = async <T extends Record<string, any>>(sql: string, params: any[]): Promise<T | null> => {
    if (client) return (await client.query<T>(sql, params)).rows[0] ?? null
    return queryOne<T>(sql, params)
  }

  const p = await one<{
    lease_id: string | null; type: string; amount: string; lease_fee_id: string | null
    collected_by: 'gam' | 'landlord' | null; reversal_id: string | null
  }>(
    `SELECT p.lease_id, p.type, p.amount::text, p.lease_fee_id, ${depositCollectedBySql('p')} AS collected_by,
            p.reversal_id
       FROM payments p WHERE p.id = $1`,
    [paymentId],
  )
  if (!p || p.type !== 'deposit' || !p.lease_id) return null
  // S653: a pet / key / cleaning deposit is its own held deposit (it carries
  // its lease_fees row). It is returned by depositReturn alongside the security
  // deposit but it does not fund THIS pool, or a pet deposit settling first
  // would read as the security deposit being paid. Who holds it is read off
  // its own payment at move-out.
  if (p.lease_fee_id) return null

  const dep = await one<{ id: string; flex_deposit_enabled: boolean; status: string; held_by: string; collected: string }>(
    `SELECT id, flex_deposit_enabled, status, held_by, collected_amount::text AS collected
       FROM security_deposits
      WHERE lease_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      ${client ? 'FOR UPDATE' : ''}`,
    [p.lease_id],
  )
  if (!dep || dep.flex_deposit_enabled || dep.status === 'funded') return null

  // Step 9 review (fix pass 2): a deposit payment a bank return or a dispute
  // reopened (payments.reversal_id), paid again. The record still counts the
  // payment the bank took back — a return never lowers it (paymentReversal);
  // the move-out takes off a reopened line still unpaid instead
  // (depositReturn.liveDepositPool) — so this payment is that same deposit
  // paid at last, never more of it: raising the record again counted the one
  // deposit twice. Who holds it is still read off how it was paid: the
  // landlord's part is told apart at move-out by its payment. Only when the
  // record holds nothing else (the returned payment was all of it) does the
  // holder follow this payment.
  if (p.reversal_id) {
    const other = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payments o
        WHERE o.lease_id = $1 AND o.type = 'deposit' AND o.lease_fee_id IS NULL
          AND o.status = 'settled' AND o.amount > 0 AND o.id <> $2`,
      [p.lease_id, paymentId])
    const heldByNow = (other?.n ?? 0) > 0 || p.collected_by == null ? dep.held_by
      : p.collected_by === 'landlord' ? 'landlord'
      : (dep.held_by === 'gam_escrow' || await gamMayHoldDeposits(client ?? db, p.lease_id)) ? 'gam_escrow' : 'landlord'
    if (heldByNow !== dep.held_by) {
      await exec(`UPDATE security_deposits SET held_by = $2, updated_at = NOW() WHERE id = $1`, [dep.id, heldByNow])
    }
    return { depositId: dep.id, amount: 0, priorHeldBy: dep.held_by, heldBy: heldByNow, priorStatus: dep.status }
  }

  const nothingHeldYet = Number(dep.collected) <= 0
  let heldBy = dep.held_by
  if (p.collected_by === 'gam') {
    const gamMay = dep.held_by === 'gam_escrow' || await gamMayHoldDeposits(client ?? db, p.lease_id)
    heldBy = gamMay ? 'gam_escrow' : (nothingHeldYet ? 'landlord' : dep.held_by)
  } else if (p.collected_by === 'landlord') {
    heldBy = nothingHeldYet ? 'landlord' : dep.held_by
  }

  const before = Number(dep.collected)
  await exec(
    `UPDATE security_deposits
        SET collected_amount = LEAST(collected_amount + $2::numeric, total_amount),
            status = CASE WHEN collected_amount + $2::numeric >= total_amount
                          THEN 'funded' ELSE 'partial' END,
            held_by = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [dep.id, Number(p.amount).toFixed(2), heldBy],
  )
  const after = await one<{ collected: string }>(
    `SELECT collected_amount::text AS collected FROM security_deposits WHERE id = $1`, [dep.id])
  return {
    depositId: dep.id,
    amount: Math.round((Number(after?.collected ?? before) - before) * 100) / 100,
    priorHeldBy: dep.held_by,
    heldBy,
    priorStatus: dep.status,
  }
}
