/**
 * S654 — THE 7AM OVERDUE DIGEST READS THE OUTSTANDING LIST.
 *
 * It used to sum RENT payment rows, one line per row. Oak Park's email said
 * 7 lines / $2,860 every morning from 9/23 while $4,519.33 was open: the
 * September utility bills were invisible to it, and Billy Miranda (RV 34 +
 * RV 35) and Josh Roby (MH 03 + RV 27) each showed up twice.
 *
 * Now it asks the same question the front desk asks (services/openBalances),
 * limited to households past their grace period (10/12: the one rule,
 * services/openBalances — the 6th for rent due the 1st with the default 5
 * days), with eviction-mode units left out as
 * before. One email per landlord ACCOUNT (two companies under one login get one
 * email), one line per person, the person's whole overdue balance.
 */
import { query } from '../db'
import { sendLatePaymentDigest } from '../services/email'
import { listOpenTenantBalances } from '../services/openBalances'
import { addDaysTo, todayIn } from '../lib/timezone'
import { logger } from '../lib/logger'

export interface LateDigestResult {
  accounts: number
  sent: number
  failed: number
}

export async function runLateBalanceDigest(): Promise<LateDigestResult> {
  // GAM's home calendar, so "past due" is the same on any host. Who is LATE
  // is decided per household below (days past grace, the one rule).
  const today = todayIn(null)
  const cutoff = addDaysTo(today, -1)

  // Accounts (the founding owner's login) with at least one overdue open bill,
  // and every company that account owns — the Outstanding list reads them all,
  // so a credit on one company's books nets exactly as it does there.
  const accounts = await query<{
    user_id: string; email: string | null
    first_name: string | null; last_name: string | null
    landlord_ids: string[]; business_names: (string | null)[]
  }>(`
    SELECT l.user_id, ul.email, ul.first_name, ul.last_name,
           array_agg(l.id ORDER BY l.created_at, l.id)::text[]            AS landlord_ids,
           array_agg(l.business_name ORDER BY l.created_at, l.id)::text[] AS business_names
      FROM landlords l
      JOIN users ul ON ul.id = l.user_id
     WHERE l.user_id IN (
             SELECT lo.user_id
               FROM invoices i
               JOIN landlords lo ON lo.id = i.landlord_id
              WHERE i.status IN ('pending', 'partial')
                AND i.due_date <= $1::date)
     GROUP BY l.user_id, ul.email, ul.first_name, ul.last_name`, [cutoff])

  const result: LateDigestResult = { accounts: 0, sent: 0, failed: 0 }
  for (const a of accounts) {
    if (!a.email) continue
    // 10/12: only what is past its grace period — the email says each person
    // has "a balance past its grace period", so a bill still inside its grace
    // (October's rent on 10/2–10/5) is not in the amount.
    const owed = await listOpenTenantBalances({
      landlordIds: a.landlord_ids,
      overdueDays: 1,
      excludePaymentBlocked: true,
      pastGraceOnly: true,
    })
    // 10/12 (Nic): "'Days late' = days past the grace period everywhere." A
    // household still inside its grace period (a longer lease grace, or a bill
    // GAM wrote after its due date) is not late yet, so it is not in the email.
    const late = owed.filter(o => o.days_late > 0)
    if (!late.length) continue
    result.accounts++

    const person = `${a.first_name || ''} ${a.last_name || ''}`.trim()
    // One company: greet it as before. Several: greet the person — no company
    // is the account's "default".
    const landlordName = (a.landlord_ids.length === 1 ? (a.business_names[0] || person) : person) || 'there'
    const items = late.map(o => ({
      tenantName:   `${o.first_name || ''} ${o.last_name || ''}`.trim() || 'Tenant',
      unitNumber:   o.unit_number || '—',
      propertyName: o.property_name || '—',
      // Days past the grace period (services/openBalances, the one rule).
      daysLate:     o.days_late,
      amount:       Number(o.balance),
      tenantId:     o.tenant_id,
    }))
    try {
      // landlordId only attributes the log row; the account sees all of its
      // companies' rows, so the first one is as good as any.
      await sendLatePaymentDigest({
        landlordEmail: a.email, landlordName, items,
        ctx: { landlordId: a.landlord_ids[0] },
      })
      result.sent++
    } catch (e) {
      result.failed++
      logger.error({ err: e, userId: a.user_id }, '[EMAIL late_payment digest]')
    }
  }
  return result
}
