/**
 * S600 — no-double-bill onboarding grace: landlord billing activation.
 *
 * A new landlord isn't charged the per-occupied-unit platform fee while they
 * are onboarding (landlords.billing_starts_at IS NULL). (The other end of the
 * grace, the cap for landlords who never start, is handled by
 * applyBillingGraceCaps in jobs/platformFeeAccrual.ts.)
 *
 * ── 10/5 (Nic, DIRECTIVE): MONEY MOVEMENT ENDS ONBOARDING ─────────────
 *
 * "The onboarding period is until money processes through the system. Rent is
 * the same as a stay as an invoice. As soon as they start processing money
 * through the system, that's the rule... You don't need to tag it as only
 * rent. Somebody's only paying utilities, that's the landlord doesn't have free
 * onboarding... money movement is the end of onboarding."
 *
 * So the free window ends the FIRST time any payer's money lands for that
 * company through GAM — a settled payment of any type (rent, utilities, a fee,
 * a deposit, a home payment, a late fee), recorded at the desk or paid online;
 * a register sale, cash or card; a pay link paid; a booking-site deposit; a
 * paid-ahead receipt; a pay-link payment GAM holds. billing_starts_at becomes
 * the month it happened. It used to end only on the first settled RENT, so a
 * park whose tenants paid only utilities, or a stay park paid only through the
 * register, sat in free onboarding however much money went through it.
 *
 * Every one of those doors calls activateBillingForMoneyMoved (or, for
 * payments rows, activateBillingForSettledPayments) in the transaction that
 * lands the money. As a backstop, the monthly run and the nightly top-up call
 * activateBillingForMoneyMovedIn for the months they bill, so a door missed
 * here, today or by a later change, still ends the window within a day.
 *
 * What is NOT money moving through GAM: a payment row marked paid before GAM
 * (manual_method 'prior_arrangement', the onboarding transition) or imported
 * from a prior platform (import_source); a bill paid entirely with account
 * credit (the money it came from already counted when it arrived; a credit the
 * landlord gave is not money); a zero-dollar settle (work trade); a store-
 * account ('charge') register sale, which is paid later as its own payment; a
 * voided sale; a background check paid to GAM (a booking-site checkout that
 * carried nothing for the stay, or a pay link for the check alone — GAM's
 * screening money, not the company's payers'); and a re-payment of a row a dispute or bank return reopened
 * (that landlord went live when the row first settled).
 *
 * ── S637 (Nic, DIRECTIVE): OCCUPANCY ALSO ENDS IT ────────────────────
 *
 * "It's a combination of active leases on a spot... Doesn't matter if they pay
 * rent to the landlord or not. When they are in the system as an occupied
 * spot, we are billing the landlord for that occupancy." A landlord whose
 * tenants pay off the books never moves money through GAM, so the monthly run
 * also ends the window for anyone with occupancy in the month it bills
 * (activateBillingForOccupancy).
 */
import type { PoolClient } from 'pg'
import { feeCountedMonthStaySql } from './billableUnits'

type Runner = Pick<PoolClient, 'query'>

/**
 * 10/5 (Nic) — a payments row that is money moving through GAM, as SQL. `p`
 * is the payments alias, `vm` its v_payment_money row (money_part is what the
 * row's own money paid, after any credit).
 */
function paymentMovedMoneySql(p: string, vm: string): string {
  return `(${p}.status = 'settled'
       AND ${p}.reversal_id IS NULL
       AND ${p}.import_source IS NULL
       AND ${p}.manual_method IS DISTINCT FROM 'prior_arrangement'
       AND ${vm}.money_part > 0)`
}

/**
 * 10/5 — a pay link for a stay's background check alone (no booking of its
 * own, every line a screening line), as SQL on the pos_pay_links alias `pl`.
 * The SQL twin of routes/posPayLinks isFeeOnlyLink: the fee is GAM's
 * screening money, never the company's payers', so paying it is not money
 * moving for that company and does not end its free onboarding.
 */
export function feeOnlyPayLinkSql(pl: string): string {
  return `(${pl}.booking_id IS NULL
       AND jsonb_typeof(${pl}.items) = 'array' AND jsonb_array_length(${pl}.items) > 0
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${pl}.items) fo_e
                        WHERE NOT (COALESCE(fo_e->>'id', '') = '' AND fo_e->'screening' = 'true'::jsonb)))`
}

/**
 * 10/5 (Nic) — EVERY MOMENT A PAYER'S MONEY LANDED FOR LANDLORD COMPANY `l`
 * through GAM in [`from`, `to`), as a subquery yielding one column `at`. `l`
 * is a SQL expression for landlords.id; `from` / `to` are SQL timestamptz
 * expressions, or null for no bound. One list of doors, read by the backstop
 * and by the grace cap, so the two cannot disagree about what counts.
 */
export function moneyMovedMomentsSql(l: string, from: string | null, to: string | null): string {
  const within = (col: string) =>
    [from ? `${col} >= ${from}` : null, to ? `${col} < ${to}` : null].filter(Boolean).join(' AND ') || 'TRUE'
  return `
    SELECT mm_p.settled_at AS at
      FROM payments mm_p JOIN v_payment_money mm_vm ON mm_vm.payment_id = mm_p.id
     WHERE mm_p.landlord_id = ${l} AND ${paymentMovedMoneySql('mm_p', 'mm_vm')}
       AND mm_p.settled_at IS NOT NULL AND ${within('mm_p.settled_at')}
    UNION ALL
    -- A receipt: card, bank, cash or check, including money paid ahead with
    -- nothing owed yet (no payments row settles for that).
    SELECT mm_r.settled_at
      FROM tenant_remittances mm_r
     WHERE mm_r.landlord_id = ${l} AND mm_r.status = 'settled'
       AND mm_r.settled_at IS NOT NULL AND ${within('mm_r.settled_at')}
    UNION ALL
    -- A register sale or a pay link paid, cash or card. A store-account sale
    -- is paid later, as its own payment; a voided sale moved nothing; a link
    -- for a background check alone is GAM's screening money, not the
    -- company's payers'.
    SELECT mm_t.created_at
      FROM pos_transactions mm_t
     WHERE mm_t.landlord_id = ${l} AND mm_t.status <> 'voided'
       AND mm_t.payment_method <> 'charge' AND mm_t.total > 0
       AND NOT EXISTS (SELECT 1 FROM pos_pay_links mm_tl
                        WHERE mm_tl.id = mm_t.pay_link_id AND ${feeOnlyPayLinkSql('mm_tl')})
       AND ${within('mm_t.created_at')}
    UNION ALL
    -- A booking-site deposit or stay payment. Only the site's own rows: a
    -- register sale toward a stay ('pos_sale') is already the pos_transactions
    -- branch above, which knows when that sale was voided (a void leaves its
    -- stay_payments row in place).
    SELECT mm_s.paid_at
      FROM stay_payments mm_s
     WHERE mm_s.landlord_id = ${l} AND mm_s.kind = 'site_deposit'
       AND ${within('mm_s.paid_at')}
    UNION ALL
    -- A pay-link payment that landed and is held (paid twice, wrong amount) —
    -- unless the link was for a background check alone (GAM's money).
    SELECT mm_h.created_at
      FROM pos_held_payments mm_h
     WHERE mm_h.landlord_id = ${l}
       AND NOT EXISTS (SELECT 1 FROM pos_pay_links mm_hl
                        WHERE mm_hl.id = mm_h.pay_link_id AND ${feeOnlyPayLinkSql('mm_hl')})
       AND ${within('mm_h.created_at')}`
}

/**
 * 10/5 (Nic): money landed for these landlord companies through GAM just now —
 * end the free onboarding window for any still in it. billing_starts_at
 * becomes this month. Idempotent: a company already billing is untouched.
 * Returns the number of companies whose window ended.
 */
export async function activateBillingForMoneyMoved(
  client: Runner,
  landlordIds: readonly (string | null | undefined)[],
): Promise<number> {
  const ids = [...new Set(landlordIds.filter((x): x is string => !!x))]
  if (ids.length === 0) return 0
  const res = await client.query(
    `UPDATE landlords
        SET billing_starts_at = date_trunc('month', now())::date, updated_at = now()
      WHERE billing_starts_at IS NULL
        AND id = ANY($1::uuid[])`,
    [ids])
  return res.rowCount ?? 0
}

/**
 * The payments-row door (services/settleHooks, every settle path): the
 * companies behind these just-settled rows go live, for every row that is
 * money moving through GAM — any type, not only rent (10/5, Nic). Replaces
 * S600's activateBillingForSettledRent.
 */
export async function activateBillingForSettledPayments(
  client: Runner,
  paymentIds: readonly string[],
): Promise<number> {
  if (paymentIds.length === 0) return 0
  const res = await client.query(
    `UPDATE landlords
        SET billing_starts_at = date_trunc('month', now())::date, updated_at = now()
      WHERE billing_starts_at IS NULL
        AND id IN (SELECT DISTINCT p.landlord_id
                     FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id
                    WHERE p.id = ANY($1::uuid[]) AND ${paymentMovedMoneySql('p', 'vm')})`,
    [[...paymentIds]])
  return res.rowCount ?? 0
}

/**
 * 10/5 (Nic) — THE BACKSTOP. Any company still in onboarding whose payers'
 * money moved through GAM from `fromMonthIso` up to (not including)
 * `toMonthIso` goes live as of the month that money FIRST moved — exactly what
 * the door would have set had it fired. The monthly run and the nightly top-up
 * call it for the months they bill, so a door missed by the code still ends the
 * window within a day. Never reaches before `fromMonthIso`, so nothing earlier
 * is ever treated as a billed month. Idempotent.
 */
export async function activateBillingForMoneyMovedIn(
  client: Runner,
  fromMonthIso: string,
  toMonthIso: string,
): Promise<number> {
  const res = await client.query(
    `UPDATE landlords l
        SET billing_starts_at = mv.first_month, updated_at = now()
       FROM (
         SELECT g.id,
                date_trunc('month', (SELECT MIN(mm.at) FROM (
                  ${moneyMovedMomentsSql('g.id', '$1::date::timestamptz', '$2::date::timestamptz')}) mm))::date AS first_month
           FROM landlords g
          WHERE g.billing_starts_at IS NULL AND g.is_system = FALSE
       ) mv
      WHERE l.id = mv.id AND mv.first_month IS NOT NULL
        AND l.billing_starts_at IS NULL`,
    [fromMonthIso, toMonthIso])
  return res.rowCount ?? 0
}

/**
 * S637: end the grace for a landlord who HAD OCCUPANCY in the month being
 * billed.
 *
 * Called by the monthly run before its per-property gate, so the month being
 * billed is the month that proves they went live. Sets billing_starts_at to
 * that month, which is exactly the month about to be accrued — so the first
 * bill covers the first month they actually had somebody in a spot, and
 * nothing earlier.
 *
 * Idempotent: only touches landlords still in grace.
 */
export async function activateBillingForOccupancy(
  client: Runner,
  monthIso: string,
): Promise<number> {
  const res = await client.query(
    `UPDATE landlords l
        SET billing_starts_at = $1::date, updated_at = now()
      WHERE l.billing_starts_at IS NULL
        AND (
          EXISTS (
            SELECT 1
              FROM leases le
              JOIN units u ON u.id = le.unit_id
             WHERE u.landlord_id = l.id
               AND le.status = 'active'
               AND le.start_date <= ($1::date + INTERVAL '1 month' - INTERVAL '1 day')
               AND (le.end_date IS NULL OR le.end_date >= $1::date))
          -- S652 (Nic): "We charge for anything occupied, no matter the status."
          -- An owner_use space has no lease by design — that is the anti-cheat,
          -- so a landlord cannot park a relative in a spot and call it rented.
          -- But a landlord whose only occupancy was owner-use would have sat in
          -- grace forever: no lease to find, so never activated, so never
          -- billed, however many spaces were full.
          OR EXISTS (
            SELECT 1 FROM units u
             WHERE u.landlord_id = l.id AND u.status = 'owner_use'
               AND u.retired_at IS NULL)
          -- 10/5 (Nic): a month stay on the schedule is an occupied space,
          -- paid or not ("it's on the schedule. So we are billing ... for it
          -- either way"). A park whose only occupancy is month stays would
          -- otherwise sit in free onboarding forever, however full it was.
          OR EXISTS (
            SELECT 1 FROM unit_bookings ms
              JOIN units u ON u.id = ms.unit_id
             WHERE u.landlord_id = l.id
               AND ${feeCountedMonthStaySql('ms', '$1::date')}
               AND ms.check_in  < $1::date + INTERVAL '1 month'
               AND ms.check_out > $1::date)
        )`,
    [monthIso],
  )
  return res.rowCount ?? 0
}
