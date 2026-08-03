/**
 * FlexCredit — $5/mo rent-credit-reporting subscription (S565).
 *
 * Full money workflow, WIRED but INVISIBLE. Enrollment is gated on
 * flexcredit_rollout_visible (OFF), so no tenant can be enrolled yet → this
 * monthly cron scans zero tenants and does nothing until the flag flips. It
 * exists so every path is in place at launch:
 *   enrolled tenant → monthly $5 charge (flexcredit_charges ledger) → platform
 *   rail pull (createRentPlatformCharge, GAM-first supersedence boost like the
 *   FlexDeposit custody fee) → payments 'fee' line item the tenant sees/pays →
 *   settles to GAM revenue (income pie reads flexcredit_charges).
 *
 * The provider (Esusu) side — the $1.50/enrollment payout + the $500/mo
 * minimum + the actual bureau reporting — is a separate external integration,
 * NOT wired here (needs the provider account/keys, like Checkr).
 *
 * Mirrors services/flexDeposit.ts processFlexDepositCustodyFee exactly.
 */
import { query, queryOne } from '../db'
import { FLEX_CREDIT_FEE } from '@gam/shared'
import { getStripe } from '../lib/stripe'
import { createRentPlatformCharge } from './stripeConnect'
import { computeTenantGamOutstandingTotal } from './supersedence'
import { isFeatureEnabled } from './systemFeatures'
import { logger } from '../lib/logger'

function firstOfMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export interface FlexCreditChargeResult {
  cycle_month: string
  candidates_scanned: number
  charges_created: number
  charges_skipped_existing: number
  errors: number
}

export async function processFlexCreditFee(now: Date = new Date()): Promise<FlexCreditChargeResult> {
  const cycle = firstOfMonth(now)
  const out: FlexCreditChargeResult = {
    cycle_month: cycle, candidates_scanned: 0, charges_created: 0,
    charges_skipped_existing: 0, errors: 0,
  }
  // The enrollment gate: invisible until launch, so no enrolled tenants exist
  // while OFF — the cron no-ops.
  if (!await isFeatureEnabled('flexcredit_rollout_visible')) return out

  const rows = await query<{
    tenant_id: string
    stripe_customer_id: string | null
    landlord_id: string
    lease_id: string
    unit_id: string
  }>(
    `SELECT DISTINCT t.id AS tenant_id, t.stripe_customer_id,
            l.landlord_id, l.id AS lease_id, l.unit_id
       FROM tenants t
       JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
       JOIN leases l         ON l.id = lt.lease_id AND l.status IN ('active', 'pending')
      WHERE t.credit_reporting_enrolled = TRUE`,
  )
  out.candidates_scanned = rows.length

  const stripe = getStripe()
  for (const r of rows) {
    try {
      const insert = await queryOne<{ id: string }>(
        `INSERT INTO flexcredit_charges (tenant_id, cycle_month, amount, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (cycle_month, tenant_id) DO NOTHING
         RETURNING id`,
        [r.tenant_id, cycle, FLEX_CREDIT_FEE],
      )
      if (!insert) { out.charges_skipped_existing += 1; continue }
      if (!r.stripe_customer_id) { out.errors += 1; continue }

      let paymentMethodId: string | null = null
      try {
        const cust = await stripe.customers.retrieve(r.stripe_customer_id)
        if (cust && !(cust as any).deleted) {
          const c = cust as any
          paymentMethodId = c.invoice_settings?.default_payment_method ?? c.default_source ?? null
        }
      } catch {}
      if (!paymentMethodId) { out.errors += 1; continue }

      // GAM-first supersedence boost on the pull (same as custody).
      const boost = await computeTenantGamOutstandingTotal(r.tenant_id)
      const pullAmount = Math.round((FLEX_CREDIT_FEE + boost) * 100) / 100

      const intent = await createRentPlatformCharge({
        amount:             pullAmount,
        stripeCustomerId:   r.stripe_customer_id,
        paymentMethodId,
        paymentMethodTypes: ['us_bank_account'],
        entryDescription:   'SUBSCRIP',
        metadata: {
          gam_purpose:   'flexcredit_fee',
          gam_charge_id: insert.id,
          gam_tenant_id: r.tenant_id,
          gam_cycle:     cycle,
        },
      })

      const pay = await queryOne<{ id: string }>(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, amount, status, entry_description,
           due_date, stripe_payment_intent_id, notes,
           gam_supersedence_amount
         ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'SUBSCRIP',
                   $6, $7, $8, $9)
         RETURNING id`,
        [
          r.landlord_id, r.tenant_id, r.lease_id, r.unit_id,
          pullAmount.toFixed(2), cycle, intent.id,
          `FlexCredit reporting fee ${cycle}`,
          boost.toFixed(2),
        ],
      )
      await query(
        `UPDATE flexcredit_charges SET payment_id = $1, updated_at = NOW() WHERE id = $2`,
        [pay!.id, insert.id],
      )
      out.charges_created += 1
    } catch (e: any) {
      logger.error({ err: e, ctx: r.tenant_id }, '[flexcredit][fee]')
      out.errors += 1
    }
  }
  return out
}
