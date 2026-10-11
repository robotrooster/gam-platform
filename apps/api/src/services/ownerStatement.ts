/**
 * S644 — WHAT AN OWNER IS TOLD, AND WHAT THEY ARE PAID.
 *
 * Nic (S644): a property manager is onboarding with roughly 11,000 units across
 * Texas, Oklahoma and Georgia. "He has other owners that get their reports and
 * things like that, and their payments." The payments were already built — see
 * services/allocation.ts, which splits every settled rent into a PM cut, an
 * owner share and GAM's spread. The REPORT did not exist at all.
 *
 * WHERE THE NUMBERS COME FROM. Nothing here is recomputed from rent amounts or
 * lease terms, because a statement that disagrees with what actually moved is
 * worse than no statement. Every figure is read from the record of the money:
 *
 *   income     — user_balance_ledger 'allocation_owner_share', written at the
 *                moment a payment settled. This is the owner's money, after the
 *                manager and GAM have taken theirs, and it is the only number
 *                the owner's bank will ever agree with.
 *   gross      — what residents paid, before anyone's cut, in two lines
 *                (S655, money plan E6):
 *                  collected through GAM — money GAM held for the owner and
 *                    paid out: a card or bank payment, deposit interest, and
 *                    paid-ahead money GAM held, on the day it paid a bill
 *                    (when GAM releases it), and bills paid at move-out from
 *                    a deposit GAM held in escrow. Apart from that move-out
 *                    money (paid out by the deposit settlement) it is exactly
 *                    what the owner share and the manager's percentage were
 *                    taken from.
 *                  collected by the manager directly — cash, check or money
 *                    order the manager took, money paid ahead to the
 *                    manager, on the day it arrived, and bills paid at
 *                    move-out from a deposit the manager held.
 *                A move-out counts what its pool kept, as the landlord
 *                reports do under Money received: the bills it swept (less
 *                their share of a shortfall past the deductions) and the
 *                deductions it kept (less the shortfall up to them), on the
 *                finalize day, through whoever held the deposit, less
 *                paid-ahead money the pool took that already counted when it
 *                arrived (reservation money never counted: the statement has
 *                no line for stays — a reservation deposit's leftover, and the
 *                reservation's share of a shortened stay's credit,
 *                incomeBasis.reservationPartOfUseSql); a shortfall the tenant
 *                pays afterwards counts on the day it settles, through GAM
 *                when GAM held it.
 *                A security deposit, a GAM fee and a credit the owner gave
 *                never enter gross. A payment later disputed or returned
 *                stays in the month it settled; what the reversal took back
 *                is shown beside gross in the month it happened
 *                (returnedOrDisputed), so a past statement never changes.
 *                A refund made from the landlord's paid-ahead money screen
 *                (choice46c) comes off on the day it went back, where the
 *                money arrived, when that money counted in gross; its payout
 *                line (the card fee given back, or the whole refund of money
 *                the owner was already paid) is in the owner share.
 *                The card or bank fee a dispute or bank return took back is
 *                the owner's cost (decisions #38 Q4), netted from their
 *                payout: it is in the owner share too, on the day it was
 *                netted, at the disputed charge's property — never in gross
 *                or returnedOrDisputed (choice46e).
 *   billed     — S655: an information block: this month's bills (by due date)
 *                and how much of them is collected, clearing and still owed.
 *                It changes no share. It covers the same KINDS of money gross
 *                does — residents' bills and what a move-out kept — and never
 *                register sales, stays, pay links, other income, or
 *                reservation money moved to credit (a reservation deposit's
 *                leftover, the reservation's share of a shortened stay's
 *                credit) and the part of a bill it paid, none of which gross
 *                has a line for.
 *                It is not the same money in the same month: gross is money
 *                the day it arrived, billed is each bill in the month it was
 *                due. Money paid ahead to the manager counts in gross the
 *                month it arrives and, when it pays a later bill, as collected
 *                in that bill's month; a bill paid at the desk in October for
 *                September counts in September's billed block and October's
 *                gross. So in one month the block can read collected above
 *                gross, or gross above it.
 *   manager    — everything the manager charged, in both the shapes a fee plan
 *                can take: 'allocation_pm_company_fee' on the balance ledger for
 *                a percent-of-rent plan (taken per payment, at settlement), plus
 *                pm_monthly_fee_accruals for a flat-monthly or per-unit plan
 *                (taken once, on the 1st). Reading only the first reported a
 *                manager on a per-unit plan as charging nothing.
 *
 *                Nic (S646): "The property manager sets the percentage or flat
 *                rate or per-unit count, that price. So the owner sees what the
 *                property manager sets on the owner's statement." One number,
 *                whatever shape their plan is.
 *   expenses   — landlord_expenses, which is where a bill paid on the owner's
 *                behalf is recorded. Voided rows are excluded, never netted.
 *
 * WHAT IS NOT ON IT. GAM's own per-unit fee. Nic (S644, DIRECTIVE): with this
 * manager GAM bills "the PM company — one bill" for every occupied unit across
 * all their owners. That is an agreement between GAM and the manager; whether
 * the manager passes it through to an owner is the manager's business and shows
 * up, if at all, as one of their own expense lines. Printing it here would state
 * a charge the owner does not owe us.
 *
 * THE MONTH. Keyed off when the allocation was written, which is settlement —
 * the same convention collectedRentMtd uses, for the same reason: a payment that
 * is still processing has not paid anybody yet.
 */

import { query } from '../db'
import { round2 } from './workTradeCredit'
import { landlordIncomeSql } from './landlordPL'
import {
  incomeEvents, summarize, moveOutSweepSql, moveOutDeductionsKeptSql, gapChainSql,
  stayShortenedCtes, reservationPartOfUseSql, disputeFeePropertySql,
} from './incomeBasis'
import { disputeFeeLineSql } from './paymentReversal'

/** The landlord filter the shortened-stay CTEs read: this statement's owner ($1). */
const OWNER = (col: string) => `${col} = $1`

/**
 * Lines of the landlord reports' Money billed facts that the statement's billed
 * block leaves out: register sales, stays and pay links (open one-time links
 * included), other income the landlord filed, and reservation money moved to
 * credit ("Moved to credit": a reservation deposit's leftover, and the part of
 * a shortened stay's credit the reservation paid — it takes stay money back
 * off, and the statement never counted the stay). Gross on this statement has
 * no line for any of that money, so the billed block keeps to the kinds of
 * money gross counts. The other side — the part of a later bill that money
 * paid — comes off the block too (reservationCover below).
 */
export const STATEMENT_BILLED_EXCLUDES: ReadonlySet<string> = new Set(['registerAndStays', 'otherIncome', 'movedToCredit'])

export interface OwnerStatementBilled {
  /** This month's bills (by due date), net of credits given. */
  billed: number
  collectedSoFar: number
  clearing: number
  stillOwed: number
}

export interface OwnerStatementProperty {
  propertyId: string
  propertyName: string
  /** What residents actually paid on this property, before anyone's cut. */
  grossCollected: number
  /** S655: of gross, money GAM held and paid out (ties to the owner share and the manager fee). */
  collectedThroughGam: number
  /** S655: of gross, money the manager took directly (cash, check, money paid ahead to them). */
  collectedDirectly: number
  /**
   * S655: what a dispute or bank return took back this month (negative, or 0)
   * — shown beside gross, never inside it: the payment it reverses stays in
   * the month it settled, with its owner share, so a past statement is never
   * rewritten.
   */
  returnedOrDisputed: number
  /** S655: information only — this month's bills and what became of them. */
  billed: OwnerStatementBilled
  /**
   * The owner's share of it, as allocated at settlement — plus what the
   * paid-ahead money screen released to their payout without paying a bill
   * (Keep it, and money GAM held for a refund the desk handed back in cash),
   * less what a card or bank refund from that screen took off it (choice46c),
   * and less the card or bank fee a dispute or bank return took back
   * (paymentReversal's kept-fee payout line, choice46e), so it is what the
   * payout carries (choice46b pass 2).
   */
  ownerShare: number
  /** What management took. */
  managementFee: number
  /** Bills paid on the owner's behalf this month. */
  expenses: number
  /** ownerShare - expenses. What the month was worth to them. */
  net: number
  expenseLines: Array<{
    date: string; category: string; amount: number
    description: string | null; vendor: string | null
  }>
}

export interface OwnerStatement {
  landlordId: string
  pmCompanyId: string | null
  /** ISO first-of-month. */
  periodMonth: string
  properties: OwnerStatementProperty[]
  totals: {
    grossCollected: number
    collectedThroughGam: number
    collectedDirectly: number
    returnedOrDisputed: number
    billed: OwnerStatementBilled
    ownerShare: number
    managementFee: number
    expenses: number
    net: number
  }
}

/** ISO first-of-month for the month containing `month` (accepts 'YYYY-MM' too). */
export function monthStart(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month)
  if (!m) throw new Error(`ownerStatement: unrecognized month "${month}"`)
  return `${m[1]}-${m[2]}-01`
}

/**
 * Build one owner's statement for one month.
 *
 * `pmCompanyId` narrows to the properties that manager runs for this owner —
 * an owner with parks under two managers gets two statements, because they get
 * two sets of fees and two people to ask about them. Omit it for the owner's
 * whole portfolio.
 */
export async function ownerStatement(opts: {
  landlordId: string
  periodMonth: string
  pmCompanyId?: string | null
}): Promise<OwnerStatement> {
  const start = monthStart(opts.periodMonth)
  const pmId = opts.pmCompanyId ?? null

  // One pass over the properties in scope, with the money attached. Written as
  // one query rather than a loop because this runs for a manager with thousands
  // of units: a per-property round trip is how a report becomes a timeout.
  const rows = await query<any>(
    `WITH ${stayShortenedCtes(OWNER)},
     scope AS (
       SELECT p.id, p.name, p.owner_user_id
         FROM properties p
        WHERE p.landlord_id = $1
          AND ($3::uuid IS NULL OR p.pm_company_id = $3::uuid)
     ),
     shortfall_rows AS (
       -- A deposit shortfall the tenant pays after move-out: the gap row the
       -- move-out billed, and any row a dispute reopened from it. It is money
       -- the resident paid, so it is gross on the day it settles, like any
       -- bill (a move-out row is otherwise not the owner's income).
       SELECT gc.id
         FROM deposit_returns dr
         CROSS JOIN LATERAL ${gapChainSql('dr')} gc
        WHERE dr.landlord_id = $1
     ),
     money AS (
       SELECT l.property_id,
              SUM(CASE WHEN l.type = 'allocation_owner_share'    THEN l.amount ELSE 0 END) AS owner_share,
              SUM(CASE WHEN l.type = 'allocation_pm_company_fee' THEN l.amount ELSE 0 END) AS pm_fee
         FROM user_balance_ledger l
         JOIN scope s ON s.id = l.property_id
        WHERE l.created_at >= $2::date
          AND l.created_at <  ($2::date + INTERVAL '1 month')
          AND l.type IN ('allocation_owner_share','allocation_pm_company_fee')
        GROUP BY l.property_id
     ),
     gross AS (
       -- What the resident paid, before anyone's cut (S655, E6), split by who
       -- held the money. Dated on the property's own calendar day.
       --
       -- SETTLED MONEY ONLY — deliberately narrower than the live dashboards,
       -- which show 'processing' beside their totals. A statement is not a
       -- dashboard. Rent still in flight has not been split yet, so counting it
       -- here would print "collected $1,000, your share $0" and read as though
       -- management took the lot. Gross and owner share have to describe the
       -- SAME money or the document argues with itself.
       --
       -- A row later disputed or returned ('returned') stays in the month it
       -- settled, as it was: its owner share stays in that month too, so a
       -- past statement is never rewritten. What the reversal took back is
       -- shown in the month it happened (taken_back). A row the legacy admin
       -- return marked 'returned' has no reversal record: it still stays in
       -- its month (the landlord reports' Money received counts it the same
       -- way), and nothing shows as taken back for it.
       --
       -- through GAM = v_payment_money.gam_held_part: the only figure a payout
       --   (and so the owner share and a percentage manager fee) is taken from.
       --   A returned row's own money went through GAM when it was a card or
       --   bank payment (the view counts it only while the row is 'settled').
       -- directly    = the row's own money GAM never held (a hand payment).
       -- A bill paid from the security deposit at move-out (paid_via_deposit)
       -- went through whoever HELD the deposit: GAM, when it held it in
       -- escrow (it pays the owner's share out at move-out), else the manager.
       -- It counts what the pool kept for it: less its share of a shortfall
       -- past the deductions (mo.short, the reports' own figure), which the
       -- tenant still owes. Who held the deposit is read off the move-out's
       -- lease — the sweep reaches the whole renewal chain, so the bill can
       -- sit on the previous lease while the deposit sits on the new one.
       -- A credit the owner gave is in neither (no money moved for it); a
       -- deposit, a GAM fee and a FlexPay pull are not the owner's income.
       SELECT u.property_id,
              SUM(gh.gam_held
                  + CASE WHEN pay.status = 'paid_via_deposit' AND sd.held_by = 'gam_escrow'
                         THEN vm.money_part + vm.gam_funded_credit - gh.gam_held - COALESCE(mo.short, 0) ELSE 0 END) AS through_gam,
              SUM(CASE WHEN pay.status = 'paid_via_deposit' AND sd.held_by = 'gam_escrow' THEN 0
                       ELSE vm.money_part + vm.gam_funded_credit - gh.gam_held - COALESCE(mo.short, 0) END) AS direct
         FROM payments pay
         JOIN v_payment_money vm ON vm.payment_id = pay.id
         CROSS JOIN LATERAL (SELECT CASE
                  WHEN pay.status = 'returned'
                    THEN vm.gam_funded_credit
                         + CASE WHEN pay.manual_method IS NULL
                                 AND (pay.stripe_charge_id IS NOT NULL OR pay.flexpay_advance_id IS NOT NULL)
                                THEN vm.money_part ELSE 0 END
                  ELSE vm.gam_held_part END AS gam_held) gh
         LEFT JOIN leases pl ON pl.id = pay.lease_id
         JOIN units u ON u.id = COALESCE(pay.unit_id, pl.unit_id)
         JOIN scope s ON s.id = u.property_id
         JOIN properties pr ON pr.id = u.property_id
         LEFT JOIN LATERAL ${moveOutSweepSql('pay')} mo ON TRUE
         LEFT JOIN LATERAL (SELECT sd0.held_by FROM security_deposits sd0
                             WHERE sd0.lease_id = COALESCE(mo.move_out_lease_id, pay.lease_id)
                             ORDER BY sd0.created_at DESC LIMIT 1) sd ON TRUE
        WHERE pay.status IN ('settled','paid_via_deposit','returned')
          AND (${landlordIncomeSql('pay')}
               OR (pay.revenue_owner = 'landlord' AND pay.id IN (SELECT id FROM shortfall_rows)))
          AND pay.settled_at IS NOT NULL
          AND (pay.settled_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date >= $2::date
          AND (pay.settled_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date <  ($2::date + INTERVAL '1 month')::date
        GROUP BY u.property_id
     ),
     taken_back AS (
       -- What a dispute or bank return took back, in the month it happened
       -- (the property's day of the reversal record): the money each row lost,
       -- payment_reversals.reversed_amount — the same figure the landlord
       -- reports' "Returned or disputed" line reads. Shown beside gross, never
       -- netted into it: the owner share of the original stays in its own month.
       SELECT u.property_id, SUM(r.reversed_amount) AS returned
         FROM payment_reversals r
         JOIN payments op ON op.id = r.payment_id
         LEFT JOIN leases pl ON pl.id = op.lease_id
         JOIN units u ON u.id = COALESCE(op.unit_id, pl.unit_id)
         JOIN scope s ON s.id = u.property_id
         JOIN properties pr ON pr.id = u.property_id
        WHERE (${landlordIncomeSql('op')}
               OR (op.revenue_owner = 'landlord' AND op.id IN (SELECT id FROM shortfall_rows)))
          AND op.settled_at IS NOT NULL
          AND (r.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date >= $2::date
          AND (r.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date <  ($2::date + INTERVAL '1 month')::date
        GROUP BY u.property_id
     ),
     move_out AS (
       -- A move-out's own money, beside the bills it swept (gross, above), on
       -- the property's day it was finalized — the same figures the landlord
       -- reports count under Money received:
       --   deductions kept — cleaning, damage and other deductions the pool
       --     kept: less the shortfall up to them, which the tenant still owes
       --     (it counts when they pay it, above), and less a shortfall past
       --     them that no swept bill carries (incomeBasis.moveOutDeductionsKeptSql);
       --   paid-ahead money the pool took back off: money paid ahead to the
       --     manager counted the day it arrived (and stay-shortened rent when it
       --     was paid), so keeping or refunding it now is not new money. Money
       --     GAM held never counted; at move-out GAM pays it out, so it moves
       --     from the manager's line to GAM's and adds nothing. Reservation
       --     money (a reservation deposit's leftover, and the reservation's
       --     share of a shortened stay's credit:
       --     incomeBasis.reservationPartOfUseSql) never counted either — the
       --     manager has held it since the stay was paid, and this statement
       --     counts no stays — so it is not taken back off: what the pool
       --     keeps of it counts now, collected directly.
       -- Through whoever HELD the deposit, as a swept bill: an escrowed
       -- deposit is settled by GAM (its settlement nets the paid-ahead money
       -- the manager already holds); a deposit the manager held they keep, and
       -- GAM pays out only the paid-ahead money it held.
       --
       -- Review fix (choice46b pass 3): split by where each dollar counted.
       -- The move-out's own figures (what the pool kept, through whoever held
       -- the deposit, and GAM-held paid-ahead money moving from the manager's
       -- line to GAM's) are the move-out property's. Taking back money paid
       -- ahead to the manager — the offset of its arrival, less the
       -- reservation part that never counted (stay_leftover) — is at the lease
       -- it ARRIVED on (COALESCE(received_lease_id, lease_id), the lease
       -- paid_ahead_direct counts it on): money left as the tenant's credit
       -- and carried to a lease at another property nets to $0 where it
       -- arrived, and the property that swept it shows only what its pool
       -- kept. One property: the same totals as before.
       SELECT x.property_id, SUM(x.through_gam) AS through_gam, SUM(x.direct) AS direct
         FROM (
           SELECT u.property_id,
                  CASE WHEN sd.held_by = 'gam_escrow' THEN k.kept - pa.manager_held ELSE pa.gam_held END AS through_gam,
                  CASE WHEN sd.held_by = 'gam_escrow' THEN pa.manager_held ELSE k.kept - pa.gam_held END AS direct
             FROM deposit_returns dr
             JOIN leases l ON l.id = dr.lease_id
             JOIN units u ON u.id = l.unit_id
             JOIN scope s ON s.id = u.property_id
             JOIN properties pr ON pr.id = u.property_id
             CROSS JOIN LATERAL (SELECT ${moveOutDeductionsKeptSql('dr')} AS kept) k
             CROSS JOIN LATERAL (
               SELECT COALESCE(SUM(v.amount) FILTER (WHERE v.gam_held), 0) AS gam_held,
                      COALESCE(SUM(v.amount) FILTER (WHERE NOT v.gam_held), 0) AS manager_held
                 FROM v_credit_uses v
                WHERE v.deposit_return_id = dr.id AND v.status = 'applied' AND v.kind = 'paid_ahead') pa
             LEFT JOIN LATERAL (SELECT sd0.held_by FROM security_deposits sd0
                                 WHERE sd0.lease_id = dr.lease_id
                                 ORDER BY sd0.created_at DESC LIMIT 1) sd ON TRUE
            WHERE dr.landlord_id = $1
              AND dr.finalized_at IS NOT NULL AND dr.status NOT IN ('draft','awaiting_approval')
              AND (dr.finalized_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date >= $2::date
              AND (dr.finalized_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date <  ($2::date + INTERVAL '1 month')::date
           UNION ALL
           SELECT ou.property_id, 0,
                  -(v.amount - ${reservationPartOfUseSql('v.amount', 'vc', 'ts')})
             FROM deposit_returns dr
             JOIN leases l ON l.id = dr.lease_id
             JOIN units u ON u.id = l.unit_id
             JOIN properties pr ON pr.id = u.property_id
             JOIN v_credit_uses v ON v.deposit_return_id = dr.id AND v.status = 'applied' AND v.kind = 'paid_ahead' AND NOT v.gam_held
             JOIN lease_prepaid_credits vc ON vc.id = v.prepaid_credit_id
             LEFT JOIN tk_share ts ON ts.lease_id = vc.lease_id
             JOIN leases ol ON ol.id = COALESCE(vc.received_lease_id, vc.lease_id)
             JOIN units ou ON ou.id = ol.unit_id
             JOIN scope s ON s.id = ou.property_id
            WHERE dr.landlord_id = $1
              AND dr.finalized_at IS NOT NULL AND dr.status NOT IN ('draft','awaiting_approval')
              AND (dr.finalized_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date >= $2::date
              AND (dr.finalized_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date <  ($2::date + INTERVAL '1 month')::date
         ) x
        GROUP BY x.property_id
     ),
     paid_ahead_direct AS (
       -- Money paid ahead to the manager (cash, check, money order, a bank
       -- deposit), on the day it arrived. Paid-ahead money GAM held is not
       -- here: it reaches the owner on the day it pays a bill (through GAM).
       -- Review fix (choice46b pass 2): at the lease it ARRIVED on — money
       -- left as the tenant's credit and carried to their next lease
       -- (paid_ahead_carry_left) keeps received_lease_id, so a carry never
       -- moves it out of a closed statement or onto another property's.
       SELECT u.property_id, SUM(c.amount_original) AS direct_paid_ahead
         FROM lease_prepaid_credits c
         JOIN leases l ON l.id = COALESCE(c.received_lease_id, c.lease_id)
         JOIN units u ON u.id = l.unit_id
         JOIN scope s ON s.id = u.property_id
         JOIN properties pr ON pr.id = u.property_id
        WHERE c.voided_at IS NULL
          AND (c.funded_by = 'landlord'
               OR (c.funded_by IS NULL
                   AND NOT EXISTS (SELECT 1 FROM tenant_remittances r
                                    WHERE r.id = c.source_remittance_id
                                      AND r.payment_method IN ('ach','card') AND r.stripe_payment_intent_id IS NOT NULL)
                   AND NOT EXISTS (SELECT 1 FROM payments sp WHERE sp.id = c.source_payment_id AND sp.platform_held)))
          AND (COALESCE(c.received_at, c.created_at) AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date >= $2::date
          AND (COALESCE(c.received_at, c.created_at) AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date <  ($2::date + INTERVAL '1 month')::date
        GROUP BY u.property_id
     ),
     choice_release AS (
       -- Review fix (choice46b): what the paid-ahead money screen
       -- (services/paidAheadChoice) released to the owner's payout. Neither
       -- paid a bill, so no allocation (and no other line here) counts them,
       -- yet each is on the payout — so (pass 2) each is in the owner share
       -- and net too, and the statement ties to what the owner's bank sees:
       --   kept      — money paid ahead GAM held that the landlord chose to
       --               keep ("Keep it": a 'prepaid_draw' held item per spend,
       --               keyed by the spend): collected through GAM;
       --   cash_back — a card or bank refund of money GAM held that the desk
       --               handed back in cash instead ('prepaid_draw' keyed
       --               'cash-part:<the cash part>'): GAM pays the owner what it
       --               held, which reimburses the cash that left their drawer.
       --               Through GAM +X and collected directly −X (the cash went
       --               back to the resident), so gross is unchanged by it.
       -- On the property's day it was released, at the lease's property.
       SELECT u.property_id,
              SUM(h.amount) FILTER (WHERE cu.id IS NOT NULL) AS kept,
              SUM(h.amount) FILTER (WHERE rp.id IS NOT NULL) AS cash_back
         FROM held_payout_items h
         LEFT JOIN credit_uses cu
           ON cu.id = CASE WHEN h.source_id ~ '^[0-9a-f-]{36}$' THEN h.source_id::uuid END
          AND cu.paid_ahead_choice_id IS NOT NULL
         LEFT JOIN stay_refund_parts rp
           ON rp.id = CASE WHEN h.source_id ~ '^cash-part:[0-9a-f-]{36}$' THEN substr(h.source_id, 11)::uuid END
          AND rp.paid_ahead_choice_id IS NOT NULL
         JOIN paid_ahead_choices pc ON pc.id = COALESCE(cu.paid_ahead_choice_id, rp.paid_ahead_choice_id)
         JOIN leases l ON l.id = pc.lease_id
         JOIN units u ON u.id = l.unit_id
         JOIN scope s ON s.id = u.property_id
         JOIN properties pr ON pr.id = u.property_id
        WHERE h.landlord_id = $1 AND h.source_type = 'prepaid_draw'
          AND (h.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date >= $2::date
          AND (h.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date <  ($2::date + INTERVAL '1 month')::date
        GROUP BY u.property_id
     ),
     choice_returned AS (
       -- Review fix (choice46b pass 2): kept money (above) that a dispute or
       -- bank return of the payment that brought it in took back — charged
       -- back on the owner's payout, one negative 'dispute' line per spend
       -- (creditUse.choiceNetSourceId). Shown under returnedOrDisputed in the
       -- month it happened, like any reversal: the release stays in its own
       -- month, so a past statement is never rewritten.
       -- Choice46c: what GAM released for cash handed back instead of a card
       -- or bank refund (cash_back above), charged back the same way — its
       -- line is keyed by the cash part.
       SELECT u.property_id, SUM(-h.amount) AS returned
         FROM held_payout_items h
         LEFT JOIN credit_uses cu
           ON cu.id = CASE WHEN split_part(h.source_id, ':', 4) ~ '^[0-9a-f-]{36}$' THEN split_part(h.source_id, ':', 4)::uuid END
          AND cu.paid_ahead_choice_id IS NOT NULL
         LEFT JOIN stay_refund_parts crp
           ON crp.id = CASE WHEN split_part(h.source_id, ':', 4) ~ '^[0-9a-f-]{36}$' THEN split_part(h.source_id, ':', 4)::uuid END
          AND crp.paid_ahead_choice_id IS NOT NULL AND crp.kind = 'cash'
         JOIN paid_ahead_choices pc ON pc.id = COALESCE(cu.paid_ahead_choice_id, crp.paid_ahead_choice_id)
         JOIN leases l ON l.id = pc.lease_id
         JOIN units u ON u.id = l.unit_id
         JOIN scope s ON s.id = u.property_id
         JOIN properties pr ON pr.id = u.property_id
        WHERE h.landlord_id = $1 AND h.source_type = 'dispute'
          AND h.source_id LIKE 'owner\\_share\\_returned:paid-ahead-choice:%'
          AND (h.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date >= $2::date
          AND (h.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date <  ($2::date + INTERVAL '1 month')::date
        GROUP BY u.property_id
     ),
     choice_refund AS (
       -- Choice46c (review): a refund made from the paid-ahead money screen,
       -- so the statement ties to the payout and to Money received for every
       -- refund made there, on the property's day:
       --   payout — a card or bank refund is a payout line (held item
       --     'refund': the card fee given back for money GAM held, the whole
       --     refund for money the owner was already paid; '<refund>:failed'
       --     puts it back when Stripe sends the refund back): in the owner
       --     share and net, as the payout carries it;
       --   gross — money that counted in gross the day it arrived (money paid
       --     ahead to the manager, rent the owner was already paid) comes back
       --     off on the day it went back, at the lease it ARRIVED on (where it
       --     counted): handed back at the desk off collected directly, sent
       --     back to the card or bank off collected through GAM, and added back
       --     on the day Stripe sent a refund back. Money GAM held never
       --     counted in gross, so its refund takes nothing off it (cash handed
       --     back instead of its card refund is cash_back, above).
       -- Stays are not on this statement: a refund of a stay's own payment is
       -- left out, as the stay never counted.
       SELECT x.property_id, SUM(x.owner) AS owner, SUM(x.through) AS through, SUM(x.direct) AS direct
         FROM (
           SELECT u.property_id, h.amount AS owner, 0::numeric AS through, 0::numeric AS direct
             FROM held_payout_items h
             JOIN stay_refund_parts rp ON rp.stripe_refund_id IS NOT NULL
                                      AND rp.stripe_refund_id = regexp_replace(h.source_id, ':failed$', '')
                                      AND rp.paid_ahead_choice_id IS NOT NULL AND rp.stay_payment_id IS NULL
             JOIN paid_ahead_choices pc ON pc.id = rp.paid_ahead_choice_id
             LEFT JOIN lease_prepaid_credits rc ON rc.id = rp.prepaid_credit_id
             JOIN leases l ON l.id = COALESCE(rc.received_lease_id, pc.lease_id)
             JOIN units u ON u.id = l.unit_id
             JOIN scope s ON s.id = u.property_id
             JOIN properties pr ON pr.id = u.property_id
            WHERE h.landlord_id = $1 AND h.source_type = 'refund'
              AND (h.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date >= $2::date
              AND (h.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date <  ($2::date + INTERVAL '1 month')::date
           UNION ALL
           SELECT u.property_id, 0,
                  CASE WHEN rp.kind IN ('card','bank') THEN ev.sign * rp.toward_amount ELSE 0 END,
                  CASE WHEN rp.kind IN ('card','bank') THEN 0 ELSE ev.sign * rp.toward_amount END
             FROM stay_refund_parts rp
             JOIN paid_ahead_choices pc ON pc.id = rp.paid_ahead_choice_id
             JOIN lease_prepaid_credits rc ON rc.id = rp.prepaid_credit_id
             JOIN leases l ON l.id = COALESCE(rc.received_lease_id, pc.lease_id)
             JOIN units u ON u.id = l.unit_id
             JOIN scope s ON s.id = u.property_id
             JOIN properties pr ON pr.id = u.property_id
             CROSS JOIN LATERAL (VALUES (rp.refunded_at, -1), (rp.reversed_at, 1)) AS ev(at, sign)
            WHERE rp.landlord_id = $1
              AND rp.status IN ('refunded','handed_back') AND rp.kind IN ('card','bank','cash','check','money_order')
              AND rp.stay_payment_id IS NULL AND rp.pos_refund_id IS NULL
              -- Money the owner held or was already paid (paidAheadChoice's
              -- creditGamHeldSql, negated): GAM-held money never counted.
              AND NOT (CASE WHEN rc.funded_by IS NOT NULL THEN rc.funded_by = 'gam'
                            ELSE EXISTS (SELECT 1 FROM tenant_remittances r
                                          WHERE r.id = rc.source_remittance_id AND r.payment_method IN ('ach','card')
                                            AND r.stripe_payment_intent_id IS NOT NULL)
                                 OR EXISTS (SELECT 1 FROM payments sp WHERE sp.id = rc.source_payment_id AND sp.platform_held) END)
              AND ev.at IS NOT NULL
              AND (ev.at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date >= $2::date
              AND (ev.at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date <  ($2::date + INTERVAL '1 month')::date
         ) x
        GROUP BY x.property_id
     ),
     dispute_fee AS (
       -- Choice46e (review): the card or bank fee a dispute or bank return took
       -- back, netted from the owner's payout (paymentReversal's
       -- 'stripe_fee_kept:…' line, decisions #38 Q4: the landlord's cost, GAM
       -- absorbs nothing). It is on the payout, so it is in the owner share
       -- and net — as the card fee given back with a refund from the
       -- paid-ahead money screen is (choice_refund) — and never in gross or
       -- returnedOrDisputed, which stay the money that arrived and the money
       -- a reversal took back (Money received shows this fee beside its
       -- total, as "Chargeback fees", not inside it). At the disputed
       -- charge's property, on that property's day of the line — the same
       -- property and day Money received reads (disputeFeePropertySql,
       -- which always places it — choice46e fix pass 2 — so no payout line is
       -- dropped from the statement).
       SELECT fp.property_id, SUM(h.amount) AS fee
         FROM held_payout_items h
         CROSS JOIN LATERAL ${disputeFeePropertySql('h')} fp
         JOIN scope s ON s.id = fp.property_id
        WHERE h.landlord_id = $1 AND ${disputeFeeLineSql('h')}
          AND (h.created_at AT TIME ZONE COALESCE(fp.tz, 'America/Phoenix'))::date >= $2::date
          AND (h.created_at AT TIME ZONE COALESCE(fp.tz, 'America/Phoenix'))::date <  ($2::date + INTERVAL '1 month')::date
        GROUP BY fp.property_id
     ),
     monthly_fee AS (
       -- The other half of what a manager charges. A percent-of-rent plan is
       -- taken per payment and lands on the balance ledger above; a flat or
       -- per-unit plan is taken once a month and lands here. An owner's
       -- statement has to add both or it understates their manager's price.
       SELECT a.property_id, SUM(a.total_amount) AS monthly_fee
         FROM pm_monthly_fee_accruals a
         JOIN scope s ON s.id = a.property_id
        WHERE a.accrual_month = $2::date
          AND ($3::uuid IS NULL OR a.pm_company_id = $3::uuid)
        GROUP BY a.property_id
     ),
     spend AS (
       SELECT e.property_id, SUM(e.amount) AS expenses
         FROM landlord_expenses e
         JOIN scope s ON s.id = e.property_id
        WHERE e.status = 'active' AND e.voided_at IS NULL
          AND e.expense_date >= $2::date
          AND e.expense_date <  ($2::date + INTERVAL '1 month')
        GROUP BY e.property_id
     )
     SELECT s.id AS property_id, s.name AS property_name,
            (COALESCE(g.through_gam, 0) + COALESCE(mo.through_gam, 0)
              + COALESCE(cr.kept, 0) + COALESCE(cr.cash_back, 0) + COALESCE(cf.through, 0))::float AS through_gam,
            (COALESCE(g.direct, 0) + COALESCE(pad.direct_paid_ahead, 0) + COALESCE(mo.direct, 0)
              - COALESCE(cr.cash_back, 0) + COALESCE(cf.direct, 0))::float AS direct,
            (COALESCE(rt.returned, 0) + COALESCE(crt.returned, 0))::float AS returned,
            (COALESCE(m.owner_share, 0) + COALESCE(cr.kept, 0) + COALESCE(cr.cash_back, 0) + COALESCE(cf.owner, 0)
              + COALESCE(df.fee, 0))::float AS owner_share,
            COALESCE(m.pm_fee, 0)::float          AS pm_fee,
            COALESCE(sp.expenses, 0)::float       AS expenses,
            COALESCE(mf.monthly_fee, 0)::float    AS monthly_fee
       FROM scope s
       LEFT JOIN money m  ON m.property_id  = s.id
       LEFT JOIN gross g  ON g.property_id  = s.id
       LEFT JOIN taken_back rt ON rt.property_id = s.id
       LEFT JOIN paid_ahead_direct pad ON pad.property_id = s.id
       LEFT JOIN move_out mo ON mo.property_id = s.id
       LEFT JOIN choice_release cr ON cr.property_id = s.id
       LEFT JOIN choice_returned crt ON crt.property_id = s.id
       LEFT JOIN choice_refund cf ON cf.property_id = s.id
       LEFT JOIN dispute_fee df ON df.property_id = s.id
       LEFT JOIN spend sp ON sp.property_id = s.id
       LEFT JOIN monthly_fee mf ON mf.property_id = s.id
      ORDER BY s.name`,
    [opts.landlordId, start, pmId])

  // Expense detail, separately. An owner disputing a statement disputes a LINE
  // ("what was this $1,400?"), so the total alone is not a usable answer.
  const expenseRows = await query<any>(
    `SELECT e.property_id, e.expense_date::text AS date, e.category,
            e.amount::float AS amount, e.description, e.vendor
       FROM landlord_expenses e
       JOIN properties p ON p.id = e.property_id
      WHERE p.landlord_id = $1
        AND ($3::uuid IS NULL OR p.pm_company_id = $3::uuid)
        AND e.status = 'active' AND e.voided_at IS NULL
        AND e.expense_date >= $2::date
        AND e.expense_date <  ($2::date + INTERVAL '1 month')
      ORDER BY e.expense_date, e.created_at`,
    [opts.landlordId, start, pmId])

  const linesByProperty = new Map<string, OwnerStatementProperty['expenseLines']>()
  for (const e of expenseRows) {
    const list = linesByProperty.get(e.property_id) ?? []
    list.push({
      date: e.date, category: e.category, amount: Number(e.amount),
      description: e.description ?? null, vendor: e.vendor ?? null,
    })
    linesByProperty.set(e.property_id, list)
  }

  // S655: the billed information block, from the landlord reports' own facts,
  // kept to the kinds of money gross counts: residents' bills and what a
  // move-out kept. Register sales, stays, pay links, other income and
  // reservation money moved to credit are the landlord reports' own lines;
  // this statement has no gross line for that money, so they stay out of the
  // billed block too (STATEMENT_BILLED_EXCLUDES) — and so does the part of a
  // bill that reservation money paid (reservationCover), or a month would read
  // billed −$58.06 with nothing billed and a later one collected $58.06 more
  // than any resident paid. It still counts by due date where gross counts by
  // the day money arrived, so one month can read collected above gross (money
  // paid ahead to the manager paying a later bill) or below it.
  const monthEnd = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0)).toISOString().slice(0, 10)
  const scopeIds: string[] = rows.map((r: any) => r.property_id)
  const billedEvents = (rows.length
    ? await incomeEvents({ landlordIds: [opts.landlordId], start, end: monthEnd, basis: 'billed', propertyIds: scopeIds })
    : []).filter(e => !STATEMENT_BILLED_EXCLUDES.has(e.line))
  // The part of this month's bills reservation money still pays (a
  // reservation deposit's leftover, and the reservation's share of a shortened
  // stay's credit: reservationPartOfUseSql): the facts count it as "covered by
  // money paid ahead" (spent, or set aside by a payment still clearing). The
  // same bills the facts read: the landlord's income rows due this month on
  // these properties, outside work trade. A shortened stay can take some of
  // that cover back off a rent bill (the facts take it off as "Stay
  // shortened"): only what is left of it is the reservation's, so what the
  // take-back moved back to credit (tk_res_back) comes off — never the use's
  // whole amount. Review of 10/3 (R6): $410 of a leftover and $540 of cash
  // paid October's $950, the guest left Oct 5 and $827.42 went back to credit
  // ($540 of the cash, $287.42 of the leftover): October's block reads $0
  // billed and $0 collected, never −$287.42.
  const reservationCover = new Map<string, number>()
  if (rows.length) {
    const cover = await query<{ property_id: string; amount: string }>(
      `WITH ${stayShortenedCtes(OWNER)},
       cover_use AS (
         SELECT u.property_id, SUM(${reservationPartOfUseSql('cu.amount', 'c', 'ts')}) AS amount
           FROM credit_uses cu
           JOIN lease_prepaid_credits c ON c.id = cu.prepaid_credit_id
           LEFT JOIN tk_share ts ON ts.lease_id = c.lease_id
           JOIN payments p ON p.id = cu.payment_id
           LEFT JOIN leases pl ON pl.id = p.lease_id
           JOIN units u ON u.id = COALESCE(p.unit_id, pl.unit_id)
          WHERE c.funded_by = 'reclassified'
            AND cu.status IN ('applied','held')
            AND p.landlord_id = $1 AND ${landlordIncomeSql('p')}
            AND p.work_trade_suspended_at IS NULL
            AND p.due_date BETWEEN $2::date AND $3::date
            AND u.property_id = ANY($4::uuid[])
          GROUP BY u.property_id),
       cover_back AS (
         SELECT rb.property_id, SUM(rb.amount) AS amount
           FROM tk_res_back rb
          WHERE rb.due_date BETWEEN $2::date AND $3::date
            AND rb.property_id = ANY($4::uuid[])
          GROUP BY rb.property_id)
       SELECT COALESCE(cvu.property_id, cvb.property_id) AS property_id,
              (COALESCE(cvu.amount, 0) - COALESCE(cvb.amount, 0))::text AS amount
         FROM cover_use cvu
         FULL JOIN cover_back cvb ON cvb.property_id = cvu.property_id`,
      [opts.landlordId, start, monthEnd, scopeIds])
    for (const r of cover) reservationCover.set(r.property_id, Number(r.amount))
  }
  const billedOf = (events: typeof billedEvents, cover: number): OwnerStatementBilled => {
    const t = summarize(events, 'billed')
    return {
      billed: round2(t.total - cover),
      collectedSoFar: round2(t.beside.collectedSoFar - cover),
      clearing: t.beside.clearing,
      stillOwed: t.beside.stillOwed,
    }
  }

  const properties: OwnerStatementProperty[] = rows.map((r: any) => {
    const ownerShare = round2(Number(r.owner_share))
    const expenses = round2(Number(r.expenses))
    const throughGam = round2(Number(r.through_gam))
    const direct = round2(Number(r.direct))
    return {
      propertyId: r.property_id,
      propertyName: r.property_name,
      grossCollected: round2(throughGam + direct),
      collectedThroughGam: throughGam,
      collectedDirectly: direct,
      returnedOrDisputed: round2(-Number(r.returned)) || 0,
      billed: billedOf(billedEvents.filter(e => e.propertyId === r.property_id), reservationCover.get(r.property_id) ?? 0),
      ownerShare,
      managementFee: round2(Number(r.pm_fee) + Number(r.monthly_fee)),
      expenses,
      net: round2(ownerShare - expenses),
      expenseLines: linesByProperty.get(r.property_id) ?? [],
    }
  })

  const sum = (pick: (p: OwnerStatementProperty) => number) =>
    round2(properties.reduce((s, p) => s + pick(p), 0))

  return {
    landlordId: opts.landlordId,
    pmCompanyId: pmId,
    periodMonth: start,
    properties,
    totals: {
      grossCollected: sum(p => p.grossCollected),
      collectedThroughGam: sum(p => p.collectedThroughGam),
      collectedDirectly: sum(p => p.collectedDirectly),
      returnedOrDisputed: sum(p => p.returnedOrDisputed) || 0,
      billed: billedOf(billedEvents, [...reservationCover.values()].reduce((x, v) => x + v, 0)),
      ownerShare: sum(p => p.ownerShare),
      managementFee: sum(p => p.managementFee),
      expenses: sum(p => p.expenses),
      net: sum(p => p.net),
    },
  }
}
