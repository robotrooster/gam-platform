/**
 * 11/5 (Nic) — A TENANCY THAT SIMPLY ENDS BOOKS WHAT THEY LEFT OWING.
 *
 *   "That needs to be fixed right away, because people are going to leave
 *    regardless of if somebody's coming in to replace them or not."
 *
 * Until tonight the only thing in GAM that wrote tenant_left_owing from a
 * tenancy was services/spotSuccession, and it fires on a REPLACEMENT'S
 * SIGNATURE. Country Acres has both halves of that sitting side by side: MH 28
 * ended 10/31 with a replacement who signed on 10/28, so it was booked; MH 18
 * ended the same day onto an empty lot, so nothing ran and $1,252.80 was only
 * on the book because it was typed in by hand.
 *
 * And it was not one missing hook. EVERY other way a tenancy ends booked
 * nothing: the nightly end-of-lease sweep, the front desk's check-out, an early
 * termination (services/leaseTermination, which does not even cut a
 * deposit-return draft), a tenant-owned home closed out
 * (services/spaceRentCarryforward), a unit move, an issued lease unwound. Six
 * doors, one of them wired. So this file is the writer, and jobs/scheduler
 * sweeps for any ending that did not come through a hook — a door somebody adds
 * next month cannot silently miss the book.
 *
 * ── WHAT THE FIGURE IS, AND WHY IT IS NOT THE PAY-NOW FIGURE ────────────────
 *
 * whatIsStillOwedOnLease lived in spotSuccession and borrowed
 * moneyPredicates.requiredRowSql — which is the PAY-IN-FULL SET FOR ONE LEASE,
 * what the portal's Pay Now has to sweep up. That set deliberately leaves a
 * carried-forward balance out (S622: "paid last, optional, may be partial"),
 * which is right for a Pay Now button and wrong for a walk-away: a carried
 * balance is precisely money that was never paid. MH 18's $566.50 of pre-GAM
 * arrears fell straight through it, and the figure the takeover path froze
 * against MH 28 only happened to include it because it was frozen before that
 * predicate gained the exclusion.
 *
 * So the scope here is its own: every payable row of this tenancy that is THE
 * LANDLORD'S OWN MONEY. The three things it leaves out, each for a reason that
 * is about whose claim it is, never about whether it is owed:
 *
 *   • A SPACE CARRYFORWARD (space_carryforward_id). Unpaid space rent on a
 *     tenant-owned home follows the SPACE — the next lease drafted there picks
 *     the charge up (services/spaceRentCarryforward). Booking it against the
 *     person too would have two people owing one set of dollars.
 *   • ANOTHER LANDLORD'S money on a converged invoice (S616). This book is per
 *     landlord; a neighbor's utility line is the neighbor's receivable.
 *   • GAM'S OWN fees (revenue_owner 'gam' — the $4 a returned bank pull costs).
 *     The tenant owes GAM, and that is not the landlord's claim to settle or to
 *     take a share of. It wants its own book; it does not want this one.
 *   • A charge on an INSTALLMENT-SALE BILL (10/25: trailer payments are their
 *     own document). The contract has its own lifecycle — a takeover is a new
 *     agreement that supersedes — so what is unpaid on it is the contract's
 *     business, not what somebody walked away from on the lease.
 *
 * ── THE DEPOSIT, WHICH IS WHY THIS IS NOT JUST A SUM ────────────────────────
 *
 * On a real move-out the deposit pays first. Booking the gross the night the
 * tenancy ends would flag somebody whose deposit covers everything. So before
 * the landlord finalizes the deposit return, the deposit it will actually
 * consume (total_deposit less the refund) comes off. After finalize nothing is
 * subtracted — finalize has already marked those rows paid from the deposit and
 * raised the rest as a gap invoice, so the rows themselves are the answer, and
 * subtracting again would take the deposit off twice.
 *
 * ── IT IS NEVER FROZEN WHILE IT CAN STILL MOVE ─────────────────────────────
 *
 * One row per lease (tenant_left_owing_source_uniq), re-computed only while
 * nobody has settled it or begun collecting against it — the rule 10/31 put on
 * the takeover path, for the same reason: utilities bill in arrears, so the
 * final cycle does not exist yet on the day the tenancy ends. A source_kind
 * 'import' row is a different key and can never be reached from here: a
 * migrated historical balance stays frozen, which is the whole point of that
 * rule ([[gam-left-owing-amount-is-frozen]]).
 */
import type { PoolClient } from 'pg'
import { query as poolQuery } from '../db'
import { payableRowSql } from './moneyPredicates'
import { LEASE_CHAIN } from './depositReturn'
import { recordWalkAwayPart, dropWalkAwayPart } from './leftOwingParts'
import { logger } from '../lib/logger'

type Q = { query: PoolClient['query'] } | { query: typeof poolQuery }

const run = async <T>(q: Q, sql: string, params: unknown[]): Promise<T[]> => {
  const r: any = await (q as any).query(sql, params)
  return (Array.isArray(r) ? r : r.rows) as T[]
}

/**
 * The landlord's own unpaid money on one tenancy, as a WHERE fragment on the
 * payments alias `a`. `leaseRef` is a placeholder ('$1') or a column.
 *
 * Reads the lease's landlord from the lease itself rather than taking it as a
 * parameter, so a caller cannot widen the scope by passing the wrong one.
 */
export function leftOwingRowSql(a: string, leaseRef: string): string {
  return `(${payableRowSql(a)}
      AND (${a}.lease_id = ${leaseRef}
           OR ${a}.invoice_id IN (SELECT lo_inv.id FROM invoices lo_inv
                                   WHERE lo_inv.lease_id = ${leaseRef}))
      AND ${a}.landlord_id = (SELECT lo_lease.landlord_id FROM leases lo_lease
                               WHERE lo_lease.id = ${leaseRef})
      AND COALESCE(${a}.revenue_owner, 'landlord') = 'landlord'
      AND ${a}.space_carryforward_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM invoices lo_hs
                       WHERE lo_hs.id = ${a}.invoice_id
                         AND lo_hs.home_sale_contract_id IS NOT NULL))`
}

/**
 * WHAT IS STILL OWED ON A TENANCY. GAM's own arithmetic over GAM's own money
 * rows — this is not the imported-balance freeze, which is a figure a landlord
 * migrates in and which nothing recomputes.
 *
 * Two halves, and nothing is double-counted: the payable payments rows, plus
 * the utility bills on this lease chain that have no payment row yet (they bill
 * in arrears, so a tenancy that ends mid-cycle has one that nothing has charged
 * — the same gap the deposit sweep reads). A utility bill that HAS a payment
 * row is already in the first half and is excluded here by `payment_id IS NULL`.
 */
export async function whatIsStillOwedOnLease(
  q: Q, leaseId: string,
): Promise<{ amount: number; rows: number }> {
  const rows = await run<{ amount: string; rows: string }>(q, `
    SELECT COALESCE(SUM(p.amount), 0)::text AS amount, COUNT(*)::text AS rows
      FROM payments p
     WHERE ${leftOwingRowSql('p', '$1')}`, [leaseId])
  const utility = await run<{ amount: string; rows: string }>(q, `
    SELECT COALESCE(SUM(ub.charge_amount + ub.tax_amount), 0)::text AS amount,
           COUNT(*)::text AS rows
      FROM utility_bills ub
     WHERE ub.lease_id IN ${LEASE_CHAIN} AND ub.payment_id IS NULL
       AND ub.status IN ('unbilled', 'billed')
       AND ub.voided_at IS NULL
       AND ub.landlord_id = (SELECT lo_l.landlord_id FROM leases lo_l WHERE lo_l.id = $1)`,
    [leaseId])
  const amount = Number(rows[0]?.amount ?? 0) + Number(utility[0]?.amount ?? 0)
  return {
    amount: Math.round(amount * 100) / 100,
    rows: Number(rows[0]?.rows ?? 0) + Number(utility[0]?.rows ?? 0),
  }
}

/**
 * THE DEPOSIT THE RETURN WILL ACTUALLY SPEND, or 0 once it has been finalized
 * (by then the rows themselves have moved) or when no return was ever drafted
 * (early termination cuts none, and a takeover has not ended the lease yet).
 *
 * The draft's own figures, which are a snapshot it took when it was cut and
 * recomputes whenever the landlord edits it. Deliberately not a live
 * recalculation: this runs inside the transaction that ends a tenancy, and
 * services/depositReturn's calculation reads the pool. The snapshot is only
 * ever used to hold the figure DOWN while the return is open, and finalize
 * re-reads the rows themselves — so the worst a stale snapshot can do is make
 * the book slightly cautious for a few days.
 */
async function depositStillToBeSpent(q: Q, leaseId: string): Promise<number> {
  const d = (await run<{ spend: string }>(q, `
    SELECT GREATEST(0, total_deposit - refund_amount)::text AS spend
      FROM deposit_returns
     WHERE lease_id = $1 AND finalized_at IS NULL`, [leaseId]))[0]
  return d ? Math.round(Number(d.spend) * 100) / 100 : 0
}

/**
 * The key for ONE person's walk-away debt with ONE landlord, as this file and
 * services/leftOwingCollection wrote it between 10/27 and 11/5.
 *
 * 11/5, SUPERSEDED BY tenant_left_owing.person_key: the record is now found by
 * WHO somebody is (services/leftOwingParts, which shares leftOwing's own
 * matcher), because a tenant id cannot name a walk-in guest who has no account
 * and a stay of theirs has to land on the same record as their lease. This is
 * kept because live records carry it as their legacy source_key and reading it
 * back is how a script finds one; nothing keys a lookup on it any more.
 */
export const personDebtKey = (tenantId: string, landlordId: string): string =>
  `carried:${tenantId}:${landlordId}`

/**
 * THE PERSON A LEASE'S WALK-AWAY DEBT BELONGS TO, as a SQL scalar — the same
 * one freezeWhatTheyLeftOwing picks, so a pre-filter and the writer can never
 * disagree about whose debt a lease's is. `leaseRef` is a placeholder or a
 * column.
 *
 * Mirrors leftOwing.personKey: account, else email, else phone. The licence
 * branch is deliberately absent — a lease's primary resident always has a user
 * row, so the account branch always wins here.
 */
export function leasePersonKeySql(leaseRef: string): string {
  return `(SELECT CASE
             WHEN lpk_u.id IS NOT NULL THEN 'user:' || lpk_u.id::text
             WHEN NULLIF(btrim(COALESCE(lpk_u.email, '')), '') IS NOT NULL
               THEN 'email:' || lower(btrim(lpk_u.email))
             WHEN NULLIF(right(regexp_replace(COALESCE(lpk_u.phone, ''), '[^0-9]', '', 'g'), 10), '') IS NOT NULL
               THEN 'phone:' || right(regexp_replace(lpk_u.phone, '[^0-9]', '', 'g'), 10)
             ELSE NULL END
            FROM lease_tenants lpk_lt
            JOIN tenants lpk_t ON lpk_t.id = lpk_lt.tenant_id
            JOIN users lpk_u ON lpk_u.id = lpk_t.user_id
           WHERE lpk_lt.lease_id = ${leaseRef}
             AND lpk_lt.status IN ('active', 'pending_add', 'removed')
           ORDER BY (lpk_lt.role = 'primary') DESC, lpk_lt.created_at
           LIMIT 1)`
}

export interface LeftOwingFreeze {
  id: string
  amount: number
  who: string
  /** True when the row already existed and this run changed the figure. */
  recomputed: boolean
}

/**
 * Freeze what a departing household left owing against the person by name.
 *
 * Returns null — doing nothing at all — when they owe nothing, when the lease
 * has nobody on it to name, or when a row exists that may no longer move
 * (settled, or something has been collected against it). Never throws for any
 * of those: an ending must not fail because the book could not be written.
 *
 * `amount` may be passed by a caller that has to read the figure BEFORE it ends
 * the lease (the takeover path does: reading it afterwards would read a lease
 * that no longer bills). Everybody else lets this compute it.
 */
export async function freezeWhatTheyLeftOwing(
  q: Q,
  opts: { leaseId: string; leftOn?: string | null; amount?: number; unitLabel?: string },
): Promise<LeftOwingFreeze | null> {
  const lease = (await run<{
    landlord_id: string; property_id: string; left_on: string | null
  }>(q, `
    SELECT l.landlord_id, u.property_id,
           to_char(COALESCE(l.end_date, l.terminated_at::date), 'YYYY-MM-DD') AS left_on
      FROM leases l JOIN units u ON u.id = l.unit_id
     WHERE l.id = $1`, [opts.leaseId]))[0]
  if (!lease) return null

  const p = (await run<{
    tenant_id: string; user_id: string; email: string | null; phone: string | null; who: string
  }>(q, `
    SELECT t.id AS tenant_id, u.id AS user_id, u.email, u.phone,
           u.first_name || ' ' || u.last_name AS who
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users u ON u.id = t.user_id
     WHERE lt.lease_id = $1 AND lt.status IN ('active', 'pending_add', 'removed')
     ORDER BY (lt.role = 'primary') DESC, lt.created_at
     LIMIT 1`, [opts.leaseId]))[0]
  if (!p) return null

  // ── 11/5 (Nic): ONE DEBT PER PERSON, THE LEASE IS ONE PART OF IT ─────────
  //
  //   "We need a way for it to only record once, but it needs to be able to be
  //    infused from different sources."
  //
  // So this no longer writes a figure. It writes what the LEASE contributes —
  // one part, keyed on the lease — and services/leftOwingParts finds the
  // person's one live record with this landlord and adds its parts up. A stay
  // of theirs and a counter tab of theirs land on the same record, which is the
  // whole point; and two writers that mean the same money (this and the
  // deposit-return carry-forward) now restate ONE part instead of overwriting
  // each other's total.
  const person = {
    userId: p.user_id, who: p.who, email: p.email, phone: p.phone,
  }

  const gross = opts.amount != null
    ? opts.amount
    : (await whatIsStillOwedOnLease(q, opts.leaseId)).amount
  // PAID UP WITHDRAWS THE LEASE'S PART. Somebody who settles everything after
  // they left must not stay flagged for it — and if that was all they owed, the
  // record settles. What it must NOT do any more is settle the whole record
  // outright: paying off the lease does not pay for the propane they never came
  // back for, and before parts existed that is exactly what it did.
  if (gross <= 0) {
    await dropWalkAwayPart(q, {
      landlordId: lease.landlord_id, person, kind: 'lease', sourceKey: opts.leaseId,
      reason: 'Paid in full after they left — nothing is owed on this tenancy any more',
    })
    return null
  }

  // A figure a caller read BEFORE the lease ended is the gross on purpose —
  // there is no deposit return yet. Either way, the deposit the return is about
  // to spend comes off here.
  const deposit = await depositStillToBeSpent(q, opts.leaseId)
  const amount = Math.round(Math.max(0, gross - deposit) * 100) / 100
  // The deposit about to be spent covers it. Nothing is booked, and nothing
  // already booked is touched either: once the landlord finalizes, this runs
  // again against the rows the deposit really did pay and lands on the truth.
  if (amount <= 0) return null

  const rec = await recordWalkAwayPart(q, {
    landlordId: lease.landlord_id,
    propertyId: lease.property_id,
    person,
    kind: 'lease',
    sourceKey: opts.leaseId,
    amount,
    leftOn: opts.leftOn ?? lease.left_on,
    note: opts.unitLabel ? `Tenancy ended at ${opts.unitLabel}` : 'Tenancy ended owing',
  })
  if (!rec) return null
  // `amount` is the LEASE's part; `total` is the record. They differ only when
  // something else of theirs is on it too, and the caller that logs this wants
  // the record's figure.
  return { id: rec.owingId, amount: rec.total, who: p.who, recomputed: rec.joined }
}

/**
 * The one call every ending makes. Logs rather than throwing, because a tenancy
 * must still end when the book cannot be written — the sweep in jobs/scheduler
 * picks it up the next night.
 */
export async function bookWhatTheyLeftOwing(
  q: Q, opts: { leaseId: string; leftOn?: string | null; amount?: number; unitLabel?: string },
): Promise<LeftOwingFreeze | null> {
  try {
    const r = await freezeWhatTheyLeftOwing(q, opts)
    if (r) {
      logger.info({ leaseId: opts.leaseId, amount: r.amount, leftOwingId: r.id,
                    recomputed: r.recomputed },
        `[left-owing] ${opts.unitLabel ?? 'a tenancy'} ended with $${r.amount.toFixed(2)} unpaid — `
        + `${r.recomputed ? 'figure re-computed' : 'frozen'} against ${r.who}`)
    }
    return r
  } catch (e) {
    logger.error({ err: e, leaseId: opts.leaseId },
      '[left-owing] could not book what this tenancy left owing — the sweep retries tonight')
    return null
  }
}
