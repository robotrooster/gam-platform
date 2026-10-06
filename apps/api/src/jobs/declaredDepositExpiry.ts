// S624 — claims that never arrived.
//
// A tenant reports a bank deposit; the feed never produces a matching row. That
// is not automatically a lie — a money order goes astray, a deposit slip is
// filled out wrong, someone pays the wrong landlord's account. But it cannot sit
// pending forever either: an open claim is a promise to keep looking, and after
// a point the honest thing is to say we did not find it.
//
// This is the SECOND half of the anti-fraud design and much the weaker half. The
// first half is that a declaration never credits anything, so lying wins nothing
// (see the migration header). This just cleans up and records a pattern the
// landlord may want to know about.
//
// It never accuses. The note the tenant sees says the deposit was not found, not
// that they did not make it, because we genuinely cannot tell those apart.

import { DateTime } from 'luxon'
import { query } from '../db'
import { createNotification } from '../services/notifications'
import { logger } from '../lib/logger'
import { DECLARATION_EXPIRY_DAYS } from '../routes/declaredDeposits'
import { tellLandlordAtStrikeLimit } from '../services/declaredDepositTrust'

export interface ExpirySweepResult {
  expired: number
  tenantsFlagged: number
  /** S655 (decisions #11): reports closed because the landlord recorded the payment by hand. */
  recorded: number
  errors: string[]
}

/** SQL: the calendar day of the report's property (its lease's space). */
const REPORT_TZ_SQL = (d: string) => `COALESCE(
  (SELECT pr.timezone FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
    WHERE l.id = ${d}.lease_id), 'America/Phoenix')`

/**
 * SQL: GAM was reading this company's bank for the report's deposit — an
 * active link that was ALREADY THERE on the day of the deposit, for a day
 * inside the company's books (bank rows before books_start_date are set aside,
 * never matched). S655 (Step 9): a bank linked after the report was never
 * looking for it.
 */
const BANK_WATCHED_REPORT_SQL = (d: string) => `(
  EXISTS (SELECT 1 FROM bank_connections c
           WHERE c.landlord_id = ${d}.landlord_id AND c.status = 'active'
             AND (c.created_at AT TIME ZONE ${REPORT_TZ_SQL(d)})::date <= ${d}.declared_date)
  AND NOT EXISTS (SELECT 1 FROM landlords ll
                   WHERE ll.id = ${d}.landlord_id AND ll.books_start_date > ${d}.declared_date))`

/**
 * S655 (decisions #11): WHICH hand-recorded receipt may close a report — the
 * whole rule in one place, so Nic's two open answers each flip one value.
 *
 * Decisions #11 as written: a cash, check or money-order payment the landlord
 * records on that lease "dated on/after the reported day that covers at least
 * the reported amount" — for a landlord with NO bank linked.
 *
 *  - receiptWindowDays: how many days after the reported day a receipt may be
 *    dated and still close the report. null = no limit, which is #11 as
 *    written. ASKED NIC (Step 9 review): with no limit, a later month's desk
 *    payment of at least the reported amount closes an older report the
 *    landlord never recorded (MH 21's 9/4 $666.50 report would be closed by
 *    November's $815), and the tenant is told it covered their deposit.
 *  - atBankWatchedCompanies: also close reports at a company whose bank GAM
 *    was reading for the deposit, once the report's window has run (the bank
 *    match gets it first, with the tenant's own date). #11 speaks only of
 *    companies with NO bank linked, so this is OFF (#11 as written): at a
 *    company whose bank GAM reads, a report only matches or expires, as before
 *    Step 9. ASKED NIC (Step 9 review): turned on, a deposit the landlord
 *    recorded by hand instead of matching it would close as "recorded by your
 *    landlord" rather than expire as "not found" (a strike for money the
 *    landlord took). Flip it only on his yes.
 */
export interface RecordedByLandlordRule {
  receiptWindowDays: number | null
  atBankWatchedCompanies: boolean
}

export const RECORDED_BY_LANDLORD_RULE: Readonly<RecordedByLandlordRule> = Object.freeze({
  receiptWindowDays: null,
  atBankWatchedCompanies: false,
})

/**
 * SQL: receipt `r` may close report `d` under `rule` — money the landlord took
 * by hand (a settled cash, check or money-order receipt from this household
 * with this company), for at least the reported amount, dated on or after the
 * reported day (the property's calendar) and, when the rule has a window, no
 * more than that many days after it. Every reader of the rule uses this.
 *
 * ONE RECEIPT CLOSES ONE REPORT, however the report was closed. A receipt
 * that already closed a report by hand (recorded_remittance_id) is spent, and
 * so is the receipt a bank match wrote when it CONFIRMED a report (Step 9
 * review): that report points at its bank row, and the bank row's undo record
 * names the receipt. Without that, MH 21's $815 deposit of 10/1 — matched at
 * the bank, confirming the 10/1 report — would also close the 9/4 $666.50
 * report, and the tenant would be told the $815 covered it.
 */
function recordedReceiptMatchSql(rule: RecordedByLandlordRule, d = 'd', r = 'r'): string {
  const window = rule.receiptWindowDays
  if (window !== null && !(Number.isInteger(window) && window >= 0)) {
    throw new Error(`recordedReceiptMatchSql: receiptWindowDays must be a whole number of days, not ${window}`)
  }
  const recordedOn = `(${r}.settled_at AT TIME ZONE ${REPORT_TZ_SQL(d)})::date`
  return `(${r}.landlord_id = ${d}.landlord_id
        AND ${r}.status = 'settled'
        -- 10/5 (Nic): a bank deposit the landlord recorded from the bank's
        -- receipt is the very deposit a resident reports making.
        AND ${r}.payment_method IN ('cash','check','money_order','bank_deposit')
        AND ${r}.settled_at IS NOT NULL
        AND ${r}.amount >= ${d}.amount
        AND (${r}.tenant_id = ${d}.tenant_id OR ${r}.lease_id = ${d}.lease_id)
        AND ${recordedOn} >= ${d}.declared_date
        ${window === null ? '' : `AND ${recordedOn} <= ${d}.declared_date + ${window}`}
        AND NOT EXISTS (SELECT 1 FROM tenant_declared_deposits spent
                         WHERE spent.recorded_remittance_id = ${r}.id)
        AND NOT EXISTS (SELECT 1 FROM tenant_declared_deposits spent
                          JOIN bank_transactions spent_bt ON spent_bt.id = spent.bank_transaction_id
                         WHERE spent.status = 'confirmed'
                           AND spent_bt.auto_settle_undo->>'receiptId' = ${r}.id::text))`
}

/**
 * S655 (decisions #11): a report the LANDLORD then recorded by hand.
 *
 * "A tenant's reported bank deposit at a landlord with NO bank linked resolves
 * as 'recorded by your landlord' when the landlord records a cash/check/money-
 * order payment on that lease dated on/after the reported day that covers at
 * least the reported amount; it never stays pending forever." The landlord
 * looked at their own bank and took it at the desk (or posted it, or matched a
 * bank deposit to it). Which receipt counts is RECORDED_BY_LANDLORD_RULE
 * (recordedReceiptMatchSql). One receipt closes one report: a receipt for
 * exactly the reported amount goes to that report first, then the oldest
 * report takes the earliest receipt.
 *
 * At a company whose bank GAM was reading for this deposit, only when the rule
 * says so (off: #11 as written) and only once the report's window has run out;
 * everywhere else, at once. 10/5 (Nic): a receipt the office recorded as a
 * BANK DEPOSIT closes it at once everywhere — the bank feed holds that line for
 * review and never confirms the report against it.
 */
export async function resolveReportsRecordedByLandlord(
  asOf?: string,
  rule: RecordedByLandlordRule = RECORDED_BY_LANDLORD_RULE,
): Promise<{ recorded: number; errors: string[] }> {
  const today = asOf ?? DateTime.now().setZone('America/Phoenix').toISODate()!
  const out = { recorded: 0, errors: [] as string[] }
  const pairs = await query<{
    declaration_id: string; tenant_id: string; amount: string; declared_date: string
    remittance_id: string; payment_method: string; receipt_amount: string; recorded_on: string
  }>(
    `SELECT d.id AS declaration_id, d.tenant_id, d.amount::text AS amount,
            to_char(d.declared_date,'YYYY-MM-DD') AS declared_date,
            r.id AS remittance_id, r.payment_method, r.amount::text AS receipt_amount,
            to_char((r.settled_at AT TIME ZONE ${REPORT_TZ_SQL('d')})::date, 'YYYY-MM-DD') AS recorded_on
       FROM tenant_declared_deposits d
       JOIN tenant_remittances r ON ${recordedReceiptMatchSql(rule)}
      WHERE d.status = 'pending'
        AND (NOT ${BANK_WATCHED_REPORT_SQL('d')}
             -- 10/5 (Nic): a BANK DEPOSIT the office recorded from the bank's
             -- receipt closes the report at once, bank linked or not. The bank
             -- feed holds that line for a person (bankFeed.decideDeposit step
             -- 0) and never confirms the report against it, so without this an
             -- honest report would expire as "not found" — a strike for the
             -- very deposit the landlord recorded.
             OR r.payment_method = 'bank_deposit'
             OR ($3::boolean AND d.declared_date < ($1::date - $2::int)))
      -- A receipt for exactly the reported amount is that report's first (MH 21
      -- reported $666.50 on 9/4 and $815 on 10/1: an $815 receipt is the 10/1
      -- report's); then oldest report first, earliest receipt first.
      ORDER BY (r.amount = d.amount) DESC, d.declared_date, d.created_at, d.id, r.settled_at, r.id`,
    [today, DECLARATION_EXPIRY_DAYS, rule.atBankWatchedCompanies])
  const usedReceipts = new Set<string>()
  const doneReports = new Set<string>()
  for (const p of pairs) {
    if (doneReports.has(p.declaration_id) || usedReceipts.has(p.remittance_id)) continue
    try {
      const word = p.payment_method === 'money_order' ? 'money order'
        : p.payment_method === 'bank_deposit' ? 'bank deposit' : p.payment_method
      const row = await query<{ id: string }>(
        `UPDATE tenant_declared_deposits
            SET status = 'recorded', recorded_remittance_id = $2, confirmed_at = NOW(),
                resolution_note = $3, updated_at = NOW()
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [p.declaration_id, p.remittance_id,
         `Recorded by your landlord: a $${Number(p.receipt_amount).toFixed(2)} ${word} payment on ${p.recorded_on}.`])
      doneReports.add(p.declaration_id)
      usedReceipts.add(p.remittance_id)
      if (row.length === 0) continue
      out.recorded++
      const t = await query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [p.tenant_id])
      if (t[0]?.user_id) {
        await createNotification({
          userId: t[0].user_id,
          type: 'payment_recorded',
          title: 'Your landlord recorded your payment',
          body: `Your landlord recorded a $${Number(p.receipt_amount).toFixed(2)} ${word} payment on ${p.recorded_on}, which covers the $${Number(p.amount).toFixed(2)} deposit you reported on ${p.declared_date}. Your report is closed — there is nothing else to do.`,
          actionUrl: '/payments',
        })
      }
    } catch (e) {
      out.errors.push(e instanceof Error ? e.message : String(e))
    }
  }
  return out
}

export async function sweepExpiredDeclarations(
  asOf?: string,
): Promise<ExpirySweepResult> {
  const result: ExpirySweepResult = { expired: 0, tenantsFlagged: 0, recorded: 0, errors: [] }
  const today = asOf ?? DateTime.now().setZone('America/Phoenix').toISODate()!

  // S655 (decisions #11): first close the reports the landlord recorded by
  // hand — they are not "not found", and must never become a strike.
  try {
    const r = await resolveReportsRecordedByLandlord(today)
    result.recorded = r.recorded
    result.errors.push(...r.errors)
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e))
    logger.error({ err: e }, '[declared-deposit-expiry] recorded-by-landlord pass failed')
  }

  try {
    // Expire on the DECLARED date, not on created_at: a tenant reporting a
    // deposit they made a week ago should not get a fresh week of waiting.
    //
    // ── S655: ONLY WHEN THE BANK WAS ACTUALLY LOOKED AT ──────────────────────
    //
    // "Not found in your landlord's bank feed" is only true if there IS a feed
    // and it has been read past the end of the report's window. Country Acres
    // has no bank linked at all, so MH 21's $666.50 report of 9/4 expired as
    // not found — a strike against a tenant for nothing they did — and the 10/1
    // report was headed the same way, which would have been the second strike
    // and a "repeated reports have not matched" alert to the landlord.
    //
    // A report now waits, still pending, until the company has an active link
    // whose last sync came after declared_date + the window. Nothing is
    // credited while it waits (a declaration never credits anything), so
    // waiting costs nobody anything; expiring wrongly costs the tenant a strike.
    //
    // S655 (Step 9): and only a link that was ALREADY THERE on the day of the
    // deposit, for a day inside the company's books. A bank linked after the
    // report, or a deposit before books_start_date (bank rows before it are
    // set aside, never matched), was never looked for — so it is not "not
    // found" either.
    const rows = await query<any>(
      `UPDATE tenant_declared_deposits d
          SET status = 'unconfirmed',
              resolution_note = 'We could not find a matching deposit in the bank feed.',
              updated_at = NOW()
        WHERE d.status = 'pending'
          AND d.declared_date < ($1::date - $2::int)
          AND ${BANK_WATCHED_REPORT_SQL('d')}
          AND EXISTS (
            SELECT 1 FROM bank_connections c
             WHERE c.landlord_id = d.landlord_id
               AND c.status = 'active'
               AND c.last_synced_at >= (d.declared_date + $2::int)::timestamp
               AND (c.created_at AT TIME ZONE ${REPORT_TZ_SQL('d')})::date <= d.declared_date)
        RETURNING d.id, d.tenant_id, d.amount::float AS amount,
                  to_char(d.declared_date,'YYYY-MM-DD') AS declared_date,
                  d.landlord_id`,
      [today, DECLARATION_EXPIRY_DAYS])
    result.expired = rows.length

    for (const r of rows) {
      try {
        const t = await query<{ user_id: string }>(
          `SELECT user_id FROM tenants WHERE id = $1`, [r.tenant_id])
        if (t[0]?.user_id) {
          await createNotification({
            userId: t[0].user_id,
            type: 'deposit_report_unconfirmed',
            title: 'We could not find your deposit',
            // Deliberately not an accusation — we cannot distinguish a lie from
            // a deposit made into the wrong account, and the tenant is far more
            // likely to be the second.
            body: `We looked for the $${Number(r.amount).toFixed(2)} deposit you reported on ${r.declared_date} and it has not appeared in your landlord's bank feed. Your balance is unchanged. If you did pay, check the deposit slip and talk to your landlord — they can look it up directly.`,
            actionUrl: '/payments',
          })
        }

        // Count strikes AFTER this one lands, so the threshold means what it
        // says. 10/5 (Nic): a report the bank showed on a later day than the
        // tenant gave counts too (services/declaredDepositTrust).
        if (await tellLandlordAtStrikeLimit(r.tenant_id, r.landlord_id)) result.tenantsFlagged++
      } catch (e) {
        result.errors.push(e instanceof Error ? e.message : String(e))
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.errors.push(msg)
    logger.error({ err: e }, '[declared-deposit-expiry] sweep failed')
  }
  return result
}
