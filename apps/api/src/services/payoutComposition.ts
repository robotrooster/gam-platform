/**
 * S655 (Nic) — what a payout carried.
 *
 * "$2,638.11 from GAM" arrived in Mountain View's bank and nothing anywhere said
 * which rent it was. Stripe cannot say: GAM's Connect accounts use manual
 * payouts, and Stripe only itemizes the contents of automatic ones. GAM's own
 * records can, exactly:
 *
 *   payment ──(owner share, user_balance_ledger)──▶ platform_transfer_intents
 *            ──(this file stamps disbursement_id)──▶ disbursements (the payout)
 *
 * A transfer moves a batch of owner shares (and register / booking items held
 * for the landlord) from GAM's balance to the landlord's Stripe balance; a
 * payout then sweeps that balance to their bank. So the payout's contents are
 * the transfers it swept, and each transfer's contents are already on file.
 *
 * Example (production): $2,638.11 = transfers of $589.00 + $2,049.11 = seven
 * payments — RV 07 rent $589, RV 42 rent $589 + utilities $124.32, RV 24 rent
 * $589 + utilities $226.59, RV 23 rent $495 + utilities $25.20. The $413.00 is
 * RV 48 rent $495 less $82 of GAM charges taken out before it was sent.
 *
 * A gap between a payout and its transfers is never hidden: it is its own line
 * on the breakdown and an admin notice when the payout is filed.
 */
import type { PoolClient } from 'pg'
import type { PaymentType } from '@gam/shared'
import { query, getClient } from '../db'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'

const cents = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100)
const dollars = (c: number) => c / 100
const money = (n: number) =>
  `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type Queryable = Pick<PoolClient, 'query'>

// What a payment was for, in the words a landlord uses. Typed against the shared
// list so a new payment type is a compile error here, not a raw word on screen.
const PAYMENT_TYPE_WORD: Record<PaymentType, string> = {
  rent: 'rent',
  fee: 'fee',
  deposit: 'deposit',
  utility: 'utilities',
  float_fee: 'FlexPay fee',
  late_fee: 'late fee',
  platform_fee: 'platform fee',
  home_payment: 'home payment',
}

// held_payout_items.source_type — money GAM holds for a landlord outside rent.
const HELD_SOURCE_LABEL: Record<string, string> = {
  pos_sale: 'Register sale',
  booking_deposit: 'Booking deposit',
  business_invoice_payment: 'Invoice payment',
  business_pos_sale: 'Register sale',
  refund: 'Refund',
  dispute: 'Disputed payment',
  platform_fee: 'Platform fee',
  prepaid_draw: 'Prepaid credit',
}

/**
 * Payouts GAM fires itself (jobs/autoPayouts.ts — the weekly run, its month-end
 * sweep and the catch-up) pay out the whole available balance. A payout made
 * in the Stripe dashboard may be for any amount, so it bounds nothing.
 */
const FULL_SWEEP_TRIGGERS = ['auto_friday', 'catch_up'] as const

/** SQL: the Connect account a disbursement row paid out from — its company's, else its user's. */
const PAYOUT_ACCOUNT_SQL = (d: string) => `COALESCE(
  (SELECT l.stripe_connect_account_id FROM landlords l WHERE l.id = ${d}.landlord_id),
  (SELECT u.stripe_connect_account_id FROM users u WHERE u.id = ${d}.user_id))`

export interface StampResult {
  /** Transfers linked to the payout by this call. */
  intentIds: string[]
  /** Everything now linked to the payout, in dollars. */
  transfersTotal: number
  /** payout − transfersTotal. Zero when the payout is fully traced. */
  residual: number
}

/**
 * Link a payout to the transfers it swept off the landlord's Stripe balance.
 *
 * Takes the account's transfers that landed before the payout and are not yet
 * in any payout, oldest first, while they fit inside the payout amount. A payout
 * sweeps the whole available balance, so in the normal case this is every
 * waiting transfer and the residual is zero. Whatever does not fit stays
 * unassigned for the next payout; whatever the payout carried beyond its
 * transfers is reported as the residual — and, unless told otherwise, raised as
 * an admin notice.
 *
 * Never a transfer an earlier GAM sweep already carried. GAM's own weekly and
 * catch-up payouts pay out the whole available balance, so every transfer that
 * landed before the last such sweep was paid by it or by a payout before it.
 * Without this, a payout filed before the S655 backfill linked the old payouts
 * would claim September's transfers as its own. The one exception is a
 * transfer whose payout failed after that sweep: the money came back onto the
 * balance, so a later payout does carry it — a failed payout made between the
 * transfer and the sweep keeps it eligible.
 *
 * Pass `client` to run inside the caller's transaction (the backfill's dry run);
 * otherwise it runs in its own.
 */
export async function stampPayoutTransfers(o: {
  disbursementId: string
  connectAccountId: string
  payoutAmount: number
  /** When the payout was created. Defaults to now. */
  payoutAt?: Date | null
  client?: Queryable
  notifyOnGap?: boolean
}): Promise<StampResult> {
  const run = async (c: Queryable): Promise<StampResult> => {
    // The last full sweep of this account before this payout (see above).
    const lastSweep = (await c.query<{ at: Date | null }>(
      `SELECT MAX(COALESCE(d.initiated_at, d.created_at)) AS at
         FROM disbursements d
        WHERE d.id <> $3
          AND d.status <> 'failed'
          AND d.stripe_payout_id IS NOT NULL
          AND d.trigger_type IN (${FULL_SWEEP_TRIGGERS.map(t => `'${t}'`).join(', ')})
          AND COALESCE(d.initiated_at, d.created_at) < COALESCE($2::timestamptz, NOW())
          AND ${PAYOUT_ACCOUNT_SQL('d')} = $1`,
      [o.connectAccountId, o.payoutAt ?? null, o.disbursementId])).rows[0]?.at ?? null
    const waiting = (await c.query<{ id: string; amount: string }>(
      `SELECT i.id, i.amount::text AS amount
         FROM platform_transfer_intents i
        WHERE i.destination_connect_account_id = $1
          AND i.status = 'transferred'
          AND i.disbursement_id IS NULL
          AND i.transferred_at IS NOT NULL
          AND i.transferred_at <= COALESCE($2::timestamptz, NOW())
          AND ($3::timestamptz IS NULL
               OR i.transferred_at > $3::timestamptz
               OR EXISTS (SELECT 1 FROM disbursements f
                           WHERE f.status = 'failed'
                             AND f.stripe_payout_id IS NOT NULL
                             AND COALESCE(f.initiated_at, f.created_at) >= i.transferred_at
                             AND COALESCE(f.initiated_at, f.created_at) < $3::timestamptz
                             AND ${PAYOUT_ACCOUNT_SQL('f')} = $1))
        ORDER BY i.transferred_at, i.created_at, i.id
          FOR UPDATE OF i`,
      [o.connectAccountId, o.payoutAt ?? null, lastSweep])).rows
    // A webhook may already have filed this payout and linked part of it.
    const already = cents((await c.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS s FROM platform_transfer_intents WHERE disbursement_id = $1`,
      [o.disbursementId])).rows[0]?.s)
    let room = cents(o.payoutAmount) - already
    const take: string[] = []
    for (const w of waiting) {
      const a = cents(w.amount)
      if (a > room) break      // oldest first: a later transfer never jumps the queue
      take.push(w.id)
      room -= a
    }
    if (take.length) {
      await c.query(
        `UPDATE platform_transfer_intents SET disbursement_id = $1, updated_at = NOW()
          WHERE id = ANY($2::uuid[]) AND disbursement_id IS NULL`,
        [o.disbursementId, take])
    }
    const total = cents((await c.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS s FROM platform_transfer_intents WHERE disbursement_id = $1`,
      [o.disbursementId])).rows[0]?.s)
    return { intentIds: take, transfersTotal: dollars(total), residual: dollars(cents(o.payoutAmount) - total) }
  }

  let result: StampResult
  if (o.client) {
    result = await run(o.client)
  } else {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      result = await run(client)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  if (result.residual !== 0 && o.notifyOnGap !== false) {
    await createAdminNotification({
      severity: 'warn',
      category: 'payout_composition_gap',
      title: `A ${money(o.payoutAmount)} payout does not equal the transfers inside it`,
      body: `GAM traced ${money(result.transfersTotal)} of this payout to its own transfers; ` +
        `${money(result.residual)} is ${result.residual > 0 ? 'not traced to any payment GAM moved' : 'in those transfers but not in this payout'}. ` +
        'The landlord sees the gap as its own line on the payout. Check the Connect account’s balance history.',
      context: { disbursementId: o.disbursementId, account: o.connectAccountId,
                 payoutAmount: o.payoutAmount, transfersTotal: result.transfersTotal, residual: result.residual },
    }).catch(e => logger.warn({ err: e }, '[payout-composition] gap notice failed'))
  }
  return result
}

export interface PayoutPaymentLine {
  paymentId: string
  intentId: string
  type: string
  /** "Rent", "Utilities" — what it was for. */
  what: string
  /** "RV 07 rent" */
  label: string
  propertyName: string | null
  unitNumber: string | null
  tenantName: string | null
  /** What the tenant paid. */
  paid: number
  /** What reached the landlord — the owner share. */
  amount: number
  paidOn: string | null
}

export interface PayoutHeldLine {
  id: string
  intentId: string
  sourceType: string
  label: string
  amount: number
}

export interface PayoutAdjustment {
  kind: 'unitemized' | 'reversals' | 'gam_charges' | 'residual'
  label: string
  /** Signed: what this line adds to (or takes from) the payout. */
  amount: number
}

export interface PayoutComposition {
  disbursementId: string
  amount: number
  /** False when no transfer is linked — GAM cannot say what this payout carried. */
  traced: boolean
  transfers: Array<{ intentId: string; amount: number; grossOwed: number; transferredAt: string | null }>
  payments: PayoutPaymentLine[]
  heldItems: PayoutHeldLine[]
  /** Everything that is not a payment or held item; payments + held + adjustments = amount. */
  adjustments: PayoutAdjustment[]
  gamChargesNetted: number
  reversalsNetted: number
  residual: number
  /** "$2,638.11 from GAM — 7 payments: RV 07 rent $589.00, …" */
  summary: string
}

/**
 * The contents of several payouts, in a fixed number of queries (the bank page
 * asks for every payout on screen at once).
 */
export async function payoutCompositions(disbursementIds: string[]): Promise<Map<string, PayoutComposition>> {
  const out = new Map<string, PayoutComposition>()
  const ids = [...new Set(disbursementIds.filter(Boolean))]
  if (!ids.length) return out

  const disbs = await query<{ id: string; amount: string }>(
    `SELECT id, amount::text AS amount FROM disbursements WHERE id = ANY($1::uuid[])`, [ids])
  const intents = await query<any>(
    `SELECT id, disbursement_id, amount::text AS amount, gross_owed::text AS gross_owed,
            netted_amount::text AS netted_amount, transferred_at
       FROM platform_transfer_intents
      WHERE disbursement_id = ANY($1::uuid[])
      ORDER BY transferred_at, created_at`, [ids])
  const payments = await query<any>(
    `SELECT i.disbursement_id, i.id AS intent_id, p.id AS payment_id, p.type,
            ubl.amount::text AS amount, p.amount::text AS paid,
            to_char(COALESCE(p.settled_at, p.processed_at, p.created_at), 'YYYY-MM-DD') AS paid_on,
            u.unit_number, pr.name AS property_name,
            (SELECT us.first_name || ' ' || us.last_name FROM tenants t JOIN users us ON us.id = t.user_id
              WHERE t.id = p.tenant_id) AS tenant_name
       FROM platform_transfer_intents i
       JOIN user_balance_ledger ubl
         ON ubl.type = 'allocation_owner_share' AND ubl.reference_type = 'payment'
        -- the real transfer id once confirmed; the reserve sentinels before that
        AND ubl.stripe_transfer_id IN (i.stripe_transfer_id, 'intent:' || i.id::text, 'netted:' || i.id::text)
       JOIN payments p ON p.id = ubl.reference_id
       LEFT JOIN units u ON u.id = p.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE i.disbursement_id = ANY($1::uuid[])
      ORDER BY COALESCE(p.settled_at, p.processed_at, p.created_at), u.unit_number, p.type`, [ids])
  const held = await query<any>(
    `SELECT i.disbursement_id, h.id, h.payout_intent_id, h.source_type, h.description, h.amount::text AS amount
       FROM held_payout_items h
       JOIN platform_transfer_intents i ON i.id = h.payout_intent_id
      WHERE i.disbursement_id = ANY($1::uuid[])
      ORDER BY h.created_at`, [ids])

  for (const d of disbs) {
    const myIntents = intents.filter((i: any) => i.disbursement_id === d.id)
    const myPayments: PayoutPaymentLine[] = payments
      .filter((p: any) => p.disbursement_id === d.id)
      .map((p: any) => {
        const word = PAYMENT_TYPE_WORD[p.type as PaymentType] ?? 'payment'
        return {
          paymentId: p.payment_id, intentId: p.intent_id, type: p.type,
          what: word.charAt(0).toUpperCase() + word.slice(1),
          label: [p.unit_number, word].filter(Boolean).join(' '),
          propertyName: p.property_name ?? null, unitNumber: p.unit_number ?? null,
          tenantName: p.tenant_name ?? null,
          paid: dollars(cents(p.paid)), amount: dollars(cents(p.amount)), paidOn: p.paid_on ?? null,
        }
      })
    const myHeld: PayoutHeldLine[] = held
      .filter((h: any) => h.disbursement_id === d.id)
      .map((h: any) => ({
        id: h.id, intentId: h.payout_intent_id, sourceType: h.source_type,
        label: h.description || HELD_SOURCE_LABEL[h.source_type] || 'Held for you',
        amount: dollars(cents(h.amount)),
      }))

    const amountC = cents(d.amount)
    const paymentsC = myPayments.reduce((s, p) => s + cents(p.amount), 0)
    const heldC = myHeld.reduce((s, h) => s + cents(h.amount), 0)
    const grossC = myIntents.reduce((s: number, i: any) => s + cents(i.gross_owed), 0)
    const reversalsC = myIntents.reduce((s: number, i: any) => s + cents(i.netted_amount), 0)
    const transfersC = myIntents.reduce((s: number, i: any) => s + cents(i.amount), 0)
    const gamC = grossC - reversalsC - transfersC
    const unitemizedC = grossC - paymentsC - heldC
    const residualC = amountC - transfersC

    const adjustments: PayoutAdjustment[] = []
    if (unitemizedC !== 0) adjustments.push({ kind: 'unitemized', label: 'Part of a transfer GAM could not itemize', amount: dollars(unitemizedC) })
    if (reversalsC !== 0) adjustments.push({ kind: 'reversals', label: 'Returned or disputed payments taken back', amount: dollars(-reversalsC) })
    if (gamC !== 0) adjustments.push({ kind: 'gam_charges', label: 'GAM charges taken out before it was sent', amount: dollars(-gamC) })
    if (residualC !== 0) adjustments.push({
      kind: 'residual',
      label: residualC > 0 ? 'Not traced to a payment GAM moved' : 'In these transfers but not in this payout',
      amount: dollars(residualC),
    })

    const traced = myIntents.length > 0
    let summary: string
    if (!traced) {
      summary = `${money(dollars(amountC))} from GAM — GAM has no record of which payments this payout carried.`
    } else {
      const n = myPayments.length
      const parts: string[] = []
      if (n) parts.push(`${n} payment${n === 1 ? '' : 's'}: ${myPayments.map(p => `${p.label} ${money(p.amount)}`).join(', ')}`)
      if (myHeld.length) parts.push(`${myHeld.length} other item${myHeld.length === 1 ? '' : 's'}: ${myHeld.map(h => `${h.label} ${money(h.amount)}`).join(', ')}`)
      let s = `${money(dollars(amountC))} from GAM — ${parts.join('; ') || 'no payments'}`
      if (reversalsC) s += `, less ${money(dollars(reversalsC))} of returned payments`
      if (gamC) s += `, less ${money(dollars(gamC))} of GAM charges`
      if (residualC) s += `; ${money(dollars(residualC))} ${residualC > 0 ? 'not traced' : 'not in this payout'}`
      summary = s
    }

    out.set(d.id, {
      disbursementId: d.id,
      amount: dollars(amountC),
      traced,
      transfers: myIntents.map((i: any) => ({
        intentId: i.id, amount: dollars(cents(i.amount)), grossOwed: dollars(cents(i.gross_owed)),
        transferredAt: i.transferred_at ? new Date(i.transferred_at).toISOString() : null,
      })),
      payments: myPayments,
      heldItems: myHeld,
      adjustments,
      gamChargesNetted: dollars(gamC),
      reversalsNetted: dollars(reversalsC),
      residual: dollars(residualC),
      summary,
    })
  }
  return out
}

export async function payoutComposition(disbursementId: string): Promise<PayoutComposition | null> {
  return (await payoutCompositions([disbursementId])).get(disbursementId) ?? null
}
