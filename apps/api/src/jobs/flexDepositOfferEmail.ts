/**
 * ── 10/29 (Nic): TELL A RESIDENT THEIR DEPOSIT CAN BE SPLIT ────────────────
 *
 *   "We need the prompt to pop up for any tenants when the deposit has not
 *    been paid yet... It needs to be there until the deposit is handled one
 *    way or another."
 *
 * The portal prompt covers anybody who logs in. This covers the ones who do
 * not: it reaches them in the inbox the bill already landed in.
 *
 * ONCE per resident, and never again. Not a cadence, not a chase — a reminder
 * without a ceiling is how signing reminders once sent 74 emails to one person
 * (jobs/bankVerificationNudge). Somebody who reads it and decides to pay in
 * full should not hear about it a second time, and the prompt is still in
 * their portal either way.
 *
 * The offer itself is services/flexDeposit.flexDepositOffer — the SAME call
 * the portal and the signing prompt make — so the figures in the email cannot
 * drift from the figures on the screen they land on.
 */
import { query } from '../db'
import { logger } from '../lib/logger'
import { flexDepositOffer } from '../services/flexDeposit'
import { emailFlexDepositOffer } from '../services/email'

export interface FlexDepositOfferEmailResult {
  considered: number
  sent: number
  failed: number
}

export async function sendFlexDepositOfferEmails(): Promise<FlexDepositOfferEmailResult> {
  const out: FlexDepositOfferEmailResult = { considered: 0, sent: 0, failed: 0 }

  // The shortlist is cheap and wide; flexDepositOffer decides for real. A
  // tenant with no email cannot be told, so they are not considered at all.
  const rows = await query<{
    deposit_id: string; tenant_id: string; email: string; first_name: string | null
    landlord_id: string; due_date: string | null
  }>(
    `SELECT DISTINCT ON (sd.id)
            sd.id AS deposit_id, t.id AS tenant_id, u.email, u.first_name,
            un.landlord_id,
            to_char(p.due_date, 'FMMonth FMDD') AS due_date
       FROM security_deposits sd
       JOIN tenants t ON t.id = sd.tenant_id
       JOIN users u ON u.id = t.user_id
       JOIN units un ON un.id = sd.unit_id
       LEFT JOIN payments p
              ON p.lease_id = sd.lease_id AND p.type = 'deposit'
             AND p.status IN ('pending', 'failed') AND p.lease_fee_id IS NULL
      WHERE sd.status IN ('pending', 'partial')
        AND sd.total_amount > 0
        AND sd.collected_amount < sd.total_amount
        AND sd.flex_deposit_enabled IS NOT TRUE
        AND sd.voided_at IS NULL
        AND u.email IS NOT NULL AND u.email <> ''
        -- Once per DEPOSIT, ever. Stamped on the deposit rather than read back
        -- out of email_send_log, whose rows complianceArchive moves out for
        -- every category email_log_is_permanent() does not name — a check
        -- against that table starts answering "not sent" again after the
        -- archive runs, and the resident gets it twice.
        AND sd.flexdeposit_offer_emailed_at IS NULL
      ORDER BY sd.id, sd.created_at DESC`)

  for (const r of rows) {
    out.considered += 1
    try {
      const offer = await flexDepositOffer({ tenantId: r.tenant_id })
      if (!offer) continue
      await emailFlexDepositOffer(
        r.email,
        r.first_name || 'there',
        {
          depositAmount: offer.depositAmount,
          lowestFirstPull: offer.lowestFirstPull,
          splits: offer.choices.map(c => c.payments),
          dueDate: r.due_date,
        },
        undefined,
        { landlordId: r.landlord_id, tenantId: r.tenant_id },
      )
      // Stamped only after the send returns, so a send that threw is retried
      // on the next run rather than silently swallowed.
      await query(
        `UPDATE security_deposits SET flexdeposit_offer_emailed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND flexdeposit_offer_emailed_at IS NULL`, [r.deposit_id])
      out.sent += 1
    } catch (err) {
      // One resident's bad address must never stop the rest of the run.
      out.failed += 1
      logger.error({ err, ctx: r.tenant_id }, '[flexdeposit-offer-email] send failed')
    }
  }
  return out
}
