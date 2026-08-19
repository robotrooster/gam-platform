/**
 * S604: deposit CUSTODY eligibility by state.
 *
 * GAM's custody vehicle is Treasury bills via Jiko. That is lawful in some
 * states and not others: several require deposits sit in a federally insured
 * depository institution, some require it be IN-STATE, and Florida § 83.49
 * additionally bars "hypothecating, pledging, or in any other way" using the
 * funds — which rules out investing the principal at all.
 *
 * OPERATING RULE (Nic, S604): a landlord onboarding from a not-yet-supported
 * state is not a backlog item — it is an IMMEDIATE build. The moment it happens
 * we emit a critical admin notification naming the state and the blocker, so
 * the work starts that minute rather than being discovered later.
 *
 * FAIL-CLOSED: a state with no row reads as 'needs_research'. Silence in the
 * catalog means "nobody has checked", never "go ahead" — the whole point is
 * that we do not put tenant deposit money somewhere unlawful because a row was
 * missing.
 */

import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

export interface CustodyRule {
  state_code:                   string
  custody_status:               'supported' | 'needs_research' | 'blocked'
  allows_treasury_bills:        boolean
  requires_in_state_depository: boolean
  requires_federally_insured:   boolean
  requires_interest_bearing:    boolean
  prohibits_use_of_funds:       boolean
  statute_citation:             string | null
  notes:                        string | null
}

/** The fail-closed default for a state nobody has researched yet. */
function unresearched(stateCode: string): CustodyRule {
  return {
    state_code:                   stateCode,
    custody_status:               'needs_research',
    allows_treasury_bills:        false,
    requires_in_state_depository: false,
    requires_federally_insured:   false,
    requires_interest_bearing:    false,
    prohibits_use_of_funds:       false,
    statute_citation:             null,
    notes:                        'No custody research on file for this state.',
  }
}

export async function getCustodyRule(stateCode: string): Promise<CustodyRule> {
  if (!stateCode) return unresearched('??')
  const row = await queryOne<CustodyRule>(
    `SELECT state_code, custody_status, allows_treasury_bills,
            requires_in_state_depository, requires_federally_insured,
            requires_interest_bearing, prohibits_use_of_funds,
            statute_citation, notes
       FROM state_deposit_custody_rules
      WHERE state_code = $1`,
    [stateCode.toUpperCase()],
  )
  return row ?? unresearched(stateCode.toUpperCase())
}

/** Can GAM take custody of deposits in this state with the CURRENT vehicle? */
export async function canCustodyDeposits(stateCode: string): Promise<boolean> {
  const rule = await getCustodyRule(stateCode)
  return rule.custody_status === 'supported' && rule.allows_treasury_bills
}

/**
 * Raise the immediate-build flag for a state GAM cannot yet custody in.
 *
 * Deduped on the state: one open (unacknowledged) alert per state is enough —
 * a second landlord from the same state should not bury the first alert, but
 * once the alert is acknowledged and the state is still unsupported, a new
 * onboarding raises it again.
 *
 * Never throws: onboarding a property must not fail because the alerting path
 * had a problem. A missed alert is recoverable; a blocked signup is not.
 */
export async function flagUnsupportedCustodyState(opts: {
  stateCode:   string
  landlordId?: string
  propertyId?: string
  propertyName?: string
}): Promise<void> {
  try {
    const rule = await getCustodyRule(opts.stateCode)
    if (rule.custody_status === 'supported' && rule.allows_treasury_bills) return

    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM admin_notifications
        WHERE category = 'deposit_custody_unsupported'
          AND acknowledged_at IS NULL
          AND context->>'state_code' = $1
        LIMIT 1`,
      [rule.state_code],
    )
    if (existing) return

    const blockers: string[] = []
    if (rule.prohibits_use_of_funds)       blockers.push('statute bars using/pledging the funds')
    if (rule.requires_in_state_depository) blockers.push('requires an IN-STATE depository')
    if (rule.requires_federally_insured)   blockers.push('requires a federally insured institution')
    if (rule.requires_interest_bearing)    blockers.push('requires an interest-bearing account')
    if (blockers.length === 0)             blockers.push('no custody research on file')

    const body =
      `A landlord is onboarding in ${rule.state_code}, where GAM cannot yet hold deposits ` +
      `with the current vehicle (Treasury bills via Jiko).\n\n` +
      `Status: ${rule.custody_status}\n` +
      `Blocker(s): ${blockers.join('; ')}\n` +
      (rule.statute_citation ? `Statute: ${rule.statute_citation}\n` : '') +
      (rule.notes ? `Notes: ${rule.notes}\n` : '') +
      `\nPer the S604 operating rule this is an IMMEDIATE build, not backlog: ` +
      `source a lawful custody vehicle for ${rule.state_code} before taking deposits there. ` +
      `Until then this property's deposits must stay held_by='landlord'.`

    await query(
      `INSERT INTO admin_notifications (severity, category, title, body, context)
       VALUES ('critical', 'deposit_custody_unsupported', $1, $2, $3::jsonb)`,
      [
        `Deposit custody unsupported in ${rule.state_code} — landlord onboarding now`,
        body,
        JSON.stringify({
          state_code:    rule.state_code,
          custody_status: rule.custody_status,
          landlord_id:   opts.landlordId ?? null,
          property_id:   opts.propertyId ?? null,
          property_name: opts.propertyName ?? null,
        }),
      ],
    )
    logger.warn(
      { state: rule.state_code, propertyId: opts.propertyId },
      '[deposit-custody] unsupported state flagged for immediate build',
    )
  } catch (e) {
    // Deliberately swallowed — see the doc comment.
    logger.error({ err: e, state: opts.stateCode }, '[deposit-custody] failed to flag unsupported state')
  }
}

/**
 * S604 (Nic): "any states where people are owed interest in any form, flag that
 * as being mandatory the minute a landlord onboards a property in that state."
 *
 * Separate from the custody flag: a state can be perfectly fine to HOLD deposits
 * in and still impose an interest obligation that has to be honoured from day
 * one. Getting it wrong is expensive in both directions — Arizona penalises a
 * shortfall at TWICE the amount wrongfully withheld (§ 33-1431(D)), and
 * over-paying a lesser-of state is a permanent silent margin leak.
 *
 * Fires for every basis EXCEPT 'none'. A state absent from the catalog raises
 * nothing here — the custody flag already fails closed on unresearched states,
 * so an unknown state is never silently treated as obligation-free.
 */
export async function flagDepositInterestObligation(opts: {
  stateCode:    string
  landlordId?:  string
  propertyId?:  string
  propertyName?: string
}): Promise<void> {
  try {
    const state = (opts.stateCode || '').toUpperCase()
    if (!state) return
    const year = new Date().getUTCFullYear()

    const rows = await query<{
      unit_types:         string[]
      rate_basis:         string
      annual_rate_pct:    string
      statute_citation:   string | null
      min_tenure_months:  number | null
      min_property_units: number | null
      notes:              string | null
    }>(
      `SELECT unit_types, rate_basis, annual_rate_pct::text AS annual_rate_pct,
              statute_citation, min_tenure_months, min_property_units, notes
         FROM state_deposit_interest_rates
        WHERE state_code = $1 AND effective_year = $2 AND rate_basis <> 'none'
        ORDER BY cardinality(unit_types)`,
      [state, year],
    )
    if (rows.length === 0) return

    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM admin_notifications
        WHERE category = 'deposit_interest_obligation'
          AND acknowledged_at IS NULL
          AND context->>'state_code' = $1
        LIMIT 1`,
      [state],
    )
    if (existing) return

    const lines = rows.map(r => {
      const scope = r.unit_types.length ? r.unit_types.join(', ') : 'ALL unit types';
      const gates = [
        r.min_tenure_months  ? `only after ${r.min_tenure_months} months held` : null,
        r.min_property_units ? `only at properties with ${r.min_property_units}+ units` : null,
      ].filter(Boolean).join('; ')
      return `  • ${scope}: ${r.rate_basis}` +
             (Number(r.annual_rate_pct) > 0 ? ` @ ${Number(r.annual_rate_pct)}%` : '') +
             (r.statute_citation ? ` (${r.statute_citation})` : '') +
             (gates ? ` — ${gates}` : '')
    })

    await query(
      `INSERT INTO admin_notifications (severity, category, title, body, context)
       VALUES ('critical', 'deposit_interest_obligation', $1, $2, $3::jsonb)`,
      [
        `${state} owes tenants deposit interest — mandatory from day one`,
        `A landlord is onboarding in ${state}, which imposes a statutory deposit-interest ` +
        `obligation. This is MANDATORY the moment deposits are taken here.\n\n` +
        `Obligations on file:\n${lines.join('\n')}\n\n` +
        `The accrual engine handles this automatically once the property's units carry the ` +
        `right unit_type. Verify the unit types are correct — the obligation is unit-type ` +
        `specific and the wrong type pays the wrong amount in either direction. ` +
        `Under-paying is penalised (AZ § 33-1431(D) is twice the amount withheld); ` +
        `over-paying is a silent permanent margin leak.`,
        JSON.stringify({
          state_code:    state,
          obligations:   rows.length,
          landlord_id:   opts.landlordId ?? null,
          property_id:   opts.propertyId ?? null,
          property_name: opts.propertyName ?? null,
        }),
      ],
    )
    logger.warn({ state, propertyId: opts.propertyId },
      '[deposit-interest] statutory obligation flagged on onboarding')
  } catch (e) {
    logger.error({ err: e, state: opts.stateCode },
      '[deposit-interest] failed to flag obligation')
  }
}

/** Admin surface: which states still need a custody vehicle, worst first. */
export async function listUnsupportedCustodyStates() {
  return query<{
    state_code: string
    custody_status: string
    requires_in_state_depository: boolean
    prohibits_use_of_funds: boolean
    statute_citation: string | null
    properties: number
  }>(
    `SELECT r.state_code, r.custody_status,
            r.requires_in_state_depository, r.prohibits_use_of_funds,
            r.statute_citation,
            (SELECT COUNT(*)::int FROM properties p WHERE p.state = r.state_code) AS properties
       FROM state_deposit_custody_rules r
      WHERE r.custody_status <> 'supported' OR r.allows_treasury_bills = false
      ORDER BY (SELECT COUNT(*) FROM properties p WHERE p.state = r.state_code) DESC,
               r.state_code`,
  )
}
