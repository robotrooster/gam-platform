/**
 * ENDING A TENANCY TAKES BACK WHAT WAS BILLED FOR AFTER IT (11/1, Nic).
 *
 *   "Have it pull the bill when it's if we forgot to check somebody out."
 *
 * Mountain View RV 20: the resident had been gone about a month and the front
 * desk never checked him out, so at 7am on the 1st his lease was still active
 * with no end date and the bill run did exactly what it is supposed to — it
 * billed him November. The owner ended the tenancy at 09:40 from the register.
 * Ending it set the end date and expired the lease and moved the unit to
 * vacant, and left the bill standing at $607.48.
 *
 * Nothing was LOST by that — it is a charge that was never owed, not income
 * that went missing. What it costs is a wrong figure sitting in the landlord's
 * receivables, a bill addressed to somebody who has left, and somebody
 * unpicking it by hand. The danger runs the other way: a charge nobody owes,
 * left on the books, is a charge somebody might collect.
 *
 * WHY NOTHING CAUGHT IT. There is machinery for this and it cannot run. The
 * shortened-stay pull-back (services/bookingLeaseBilling syncLeaseWithBookingDates,
 * reached through earlyCheckOut healLeaseEnd) is gated on the lease carrying a
 * `source_booking_id`, and NO live lease on the platform has one — 82 of 82
 * active leases are e-signed with none. So the "take those charges off" question
 * the schedule asks has never once been asked of a real resident. It is not that
 * RV 20 slipped through a gap; the gap is the whole floor.
 *
 * WHAT THIS DOES, AND THE LINE IT WILL NOT CROSS.
 * Rent is paid FORWARD. A rent or fee row due on or after the day the tenancy
 * ended covers time the resident was not there, so it is not owed and comes
 * off. A row due BEFORE that day is theirs and is left exactly alone — this
 * never forgives arrears, and a resident who leaves on the 20th still owes that
 * month. Money that MOVED (settled, processing, paid from a deposit) is never
 * touched.
 *
 * UTILITIES ARE DELIBERATELY NOT TOUCHED HERE. They bill in ARREARS, so a
 * utility line on a bill dated after the departure can still be real usage from
 * before it — the gallons Tyler used in October arrived on a November bill. A
 * due-date rule would wash away usage a resident genuinely had. GAM already has
 * the right mechanism for the final cycle (the early-departure wash in
 * services/utilityBilling), and it is gated on a booking exactly like the rest.
 * Opening that gate is its own change with its own question for the owner;
 * guessing here would either give away real usage or bill a stranger for it.
 *
 * KEEP EVERYTHING. A charge nobody owes is VOIDED, never deleted (CLAUDE.md,
 * services/chargeVoids): the row stays on record with its reason, owed by
 * nobody, in no balance and no report. A bill left with nothing live on it
 * becomes void at $0 and hands its due date back, so the month could be billed
 * again if somebody else takes the space.
 *
 * Each void is tried on its own savepoint, so one row another record points at
 * (a bank remittance applied to it) stays put and is reported in `kept` for a
 * human, instead of failing the whole move-out. Idempotent: run it again and it
 * finds nothing left to do. Lifted from renewalSuccessor's
 * clearNeverOwedOnHeldNewLease, which does the same job for a new lease that
 * will never start, and narrowed to "due on or after the day they left".
 */
import type { PoolClient } from 'pg'
import { voidUnowedCharges } from './chargeVoids'
import { lockHousehold } from './moneyPredicates'
import { logger } from '../lib/logger'
import type { KeptCharge } from './renewalSuccessor'

/** Why a rent or fee row past the end of a tenancy is not owed (payments.void_reason). */
export const PAST_TENANCY_END_CHARGE_REASON =
  'Billed for time after the tenancy ended, so it was never owed — the resident had already left.'

/** 10/12 keep-everything: the note left on a bill this emptied. */
export const PAST_TENANCY_END_BILL_NOTE = (endsOn: string) =>
  `Voided: every line on it was for time after the tenancy ended on ${endsOn}.`

/** An open work-trade period on a bill that is no longer owed has nothing to credit. */
export const PAST_TENANCY_END_WORK_TRADE_VOID =
  'Voided: the tenancy ended, so this period has nothing left to credit'

export interface LeaseEndPullBack {
  /** Rent and fee rows voided. */
  charges: number
  /** Bills left with nothing live on them, voided at $0. */
  bills: number
  /** Bills re-totalled around money still on them. */
  retotaled: number
  /** Rows a record still points at — a human has to take these off. */
  kept: number
  keptCharges: KeptCharge[]
  /** Trailer/home agreements stopped, so next month writes nothing. */
  contractsStopped: number
  /** The day the tenancy ended, as used. */
  endsOn: string | null
}

const NONE: LeaseEndPullBack = {
  charges: 0, bills: 0, retotaled: 0, kept: 0, keptCharges: [], contractsStopped: 0, endsOn: null,
}

/**
 * Take back everything billed on `leaseId` for time on or after the day the
 * tenancy ended. Runs INSIDE the caller's transaction and takes the household
 * lock first, like every other writer of this household's money.
 *
 * `endsOn` defaults to the lease's own end date (or the day it was terminated,
 * whichever is earlier) — so a caller that has just written one does not have
 * to pass it, and a caller that is about to can.
 */
/**
 * The transaction handle. Typed structurally, like cascadeLeaseEnd's, because
 * the callers hold different things: a real PoolClient (the ending sweep, the
 * early-termination path) and the looser `{ query }` the shared cascade is
 * handed. All any of this needs is a connection already inside a transaction.
 */
export type TxClient = { query: PoolClient['query'] }

export async function pullBackChargesPastLeaseEnd(
  client: TxClient,
  args: { leaseId: string; endsOn?: string | null; reason?: string },
): Promise<LeaseEndPullBack> {
  const lease = (await client.query<{
    ends_on: string | null; tenant_id: string | null; landlord_id: string; unit_number: string | null
  }>(`
    SELECT to_char(NULLIF(LEAST(
             COALESCE(l.end_date, 'infinity'::date),
             COALESCE(timezone(COALESCE(p.timezone, 'America/Phoenix'), l.terminated_at)::date, 'infinity'::date)
           ), 'infinity'::date), 'YYYY-MM-DD') AS ends_on,
           lt.tenant_id, l.landlord_id, u.unit_number
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.role = 'primary'
     WHERE l.id = $1`, [args.leaseId])).rows[0]
  if (!lease) return NONE
  const endsOn = args.endsOn ?? lease.ends_on
  // A tenancy with no end is still running: nothing is "past" it.
  if (!endsOn) return NONE

  // lockHousehold only ever calls .query on it, and it THROWS if it is not
  // inside a transaction — which is the guard that matters here, so the cast is
  // narrowing the type to what the function actually uses, not loosening a check.
  if (lease.tenant_id) await lockHousehold(client as PoolClient, lease.tenant_id, lease.landlord_id)

  const q = (text: string, params?: any[]) => client.query(text, params)
  const reason = args.reason ?? PAST_TENANCY_END_CHARGE_REASON

  /** Try one step alone, so a refusal costs only that row. */
  const alone = async (step: () => Promise<unknown>): Promise<boolean> => {
    await q('SAVEPOINT lease_end_pull_back')
    try {
      await step()
      await q('RELEASE SAVEPOINT lease_end_pull_back')
      return true
    } catch {
      await q('ROLLBACK TO SAVEPOINT lease_end_pull_back')
      await q('RELEASE SAVEPOINT lease_end_pull_back')
      return false
    }
  }

  const out: LeaseEndPullBack = {
    charges: 0, bills: 0, retotaled: 0, kept: 0, keptCharges: [], contractsStopped: 0, endsOn,
  }
  const touched = new Set<string>()

  // RENT, FEES AND TRAILER PAYMENTS, due on or after the day they left.
  // Utilities are left alone on purpose (see the header): they bill in arrears,
  // so a line dated after the departure can still be usage from before it. A
  // late fee raised on a charge that was never owed comes off with it.
  //
  // 11/1 (Nic, DIRECTIVE): A PERSON WHO HAS LEFT ACCRUES NOTHING FURTHER.
  //   "When they're not living there, they're not going to pay anything else
  //    to the park. So we need to sever their ability to accrue any other
  //    charges."
  // Country Acres MH 18: the resident left on 10/31 and her November rent came
  // off here, but her $100 trailer installment did not — home_payment was not
  // in this list — so a bill for November stood against somebody who had gone,
  // and December's run would have written another. Taking only the charge would
  // leave the contract behind it still due, so the contract is stopped too,
  // below. Utilities remain the one deliberate exception.
  const unpaid = (await q(
    `SELECT p.id, p.invoice_id, p.type, p.amount::text AS amount,
            to_char(p.due_date, 'YYYY-MM-DD') AS due_date
       FROM payments p
      WHERE p.status IN ('pending', 'failed')
        AND p.type IN ('rent', 'fee', 'late_fee', 'home_payment')
        AND p.due_date IS NOT NULL
        AND p.due_date >= $2::date
        AND (p.lease_id = $1 OR p.invoice_id IN (SELECT id FROM invoices WHERE lease_id = $1))
      ORDER BY p.due_date, p.id`, [args.leaseId, endsOn])).rows

  for (const r of unpaid) {
    const done = await alone(async () => {
      const { voided } = await voidUnowedCharges(q, [r.id], reason)
      if (voided.length === 0) throw new Error(`charge ${r.id} kept: a record points at it`)
    })
    if (done) {
      out.charges++
      if (r.invoice_id) touched.add(r.invoice_id)
    } else {
      out.kept++
      out.keptCharges.push({
        paymentId: r.id, utilityBillId: null,
        kind: r.type === 'rent' ? 'rent'
          : r.type === 'late_fee' ? 'late fee'
          : r.type === 'home_payment' ? 'trailer payment'
          : 'fee',
        amount: Number(r.amount), dueDate: r.due_date ?? null,
      })
    }
  }

  // Every bill a line came off: either it has nothing live left (void it at $0
  // and give the due date back) or it is re-totalled around what remains.
  for (const invoiceId of touched) {
    const liveLeft = (await q(
      `SELECT 1 FROM payments
        WHERE invoice_id = $1 AND status NOT IN ('voided') LIMIT 1`, [invoiceId])).rows.length > 0
    await q(
      `UPDATE work_trade_settlements
          SET status = 'voided', voided_at = NOW(), void_reason = $2, updated_at = NOW()
        WHERE invoice_id = $1 AND status = 'open'`, [invoiceId, PAST_TENANCY_END_WORK_TRADE_VOID])
    if (!liveLeft) {
      const killed = await q(
        `UPDATE invoices i
            SET status = 'void', total_amount = 0, updated_at = NOW(),
                voided_from_lease_id = COALESCE(i.voided_from_lease_id, i.lease_id), lease_id = NULL,
                notes = LEFT(CONCAT_WS(E'\n', NULLIF(i.notes, ''), $2::text), 2000)
          WHERE i.id = $1 AND i.status <> 'void'
          RETURNING i.id`, [invoiceId, PAST_TENANCY_END_BILL_NOTE(endsOn)])
      if (killed.rowCount) out.bills++
      continue
    }
    // Something real is still on it (settled money, or a utility line that is
    // genuinely owed), so the bill stays and its totals are rebuilt from what
    // is actually there. Suspended work-trade lines are on the document at full
    // value but are not asked for, exactly as the bill run writes them.
    const changed = await q(
      `WITH lines AS (
         SELECT p.type, p.amount, p.lease_fee_id, p.work_trade_suspended_at
           FROM payments p
          WHERE p.invoice_id = $1
            AND p.status IN ('pending', 'failed', 'processing', 'settled', 'paid_via_deposit')),
       t AS (
         SELECT COALESCE(SUM(amount) FILTER (WHERE work_trade_suspended_at IS NULL AND type <> 'late_fee'), 0) AS total,
                COALESCE(SUM(amount) FILTER (WHERE type = 'rent'), 0) AS rent,
                COALESCE(SUM(amount) FILTER (WHERE type = 'fee'
                                             OR (type = 'deposit' AND lease_fee_id IS NOT NULL)), 0) AS fees,
                COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND lease_fee_id IS NULL), 0) AS deposits,
                COALESCE(SUM(amount) FILTER (WHERE type = 'utility'), 0) AS utilities,
                COALESCE(SUM(amount) FILTER (WHERE type = 'home_payment'), 0) AS home
           FROM lines)
       UPDATE invoices i
          SET total_amount = t.total, subtotal_rent = t.rent, subtotal_fees = t.fees,
              subtotal_deposits = t.deposits, subtotal_utilities = t.utilities,
              subtotal_home_payments = t.home, updated_at = NOW()
         FROM t
        WHERE i.id = $1
          AND (i.total_amount, i.subtotal_rent, i.subtotal_fees, i.subtotal_deposits,
               i.subtotal_utilities, i.subtotal_home_payments)
              IS DISTINCT FROM (t.total, t.rent, t.fees, t.deposits, t.utilities, t.home)
        RETURNING i.id`, [invoiceId])
    if (changed.rowCount) out.retotaled++
  }

  if (out.charges > 0 || out.kept > 0) {
    logger.info({ leaseId: args.leaseId, unit: lease.unit_number, ...out, keptCharges: undefined },
      '[lease-end] took back what was billed for after the tenancy ended')
  }

  // ── AND THE CONTRACT BEHIND IT STOPS ────────────────────────────────────
  // Voiding November's installment without stopping the agreement would have
  // the next monthly run write December's, and the one after that, against
  // somebody who has gone — the charge would come back every month until a
  // human noticed. Nic, 11/1: "when we mark somebody as moved out and they
  // have trailer installments or whatever, they're just — it stops."
  //
  // Scoped to THIS buyer on THIS space: a contract belongs to the unit, and the
  // next resident's agreement must not be stopped by the last one leaving.
  // Already-cancelled rows are left alone, so running this twice changes
  // nothing.
  if (lease.tenant_id) {
    const stopped = await q(
      `UPDATE home_sale_contracts h
          SET status = 'cancelled', updated_at = NOW()
         FROM leases l
        WHERE l.id = $1 AND h.unit_id = l.unit_id AND h.tenant_id = $2
          AND h.status = 'active'
        RETURNING h.id`, [args.leaseId, lease.tenant_id])
    out.contractsStopped = stopped.rowCount ?? 0
    if (out.contractsStopped > 0) {
      logger.info({ leaseId: args.leaseId, endsOn, stopped: out.contractsStopped },
        '[LeaseEndPullBack] trailer/home agreement stopped — the resident has left')
    }
  }

  return out
}
