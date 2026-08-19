/**
 * S604 deposit-custody eligibility + the immediate-build flag.
 *
 * Operating rule under test (Nic): the moment a landlord onboards from a state
 * GAM cannot lawfully hold deposits in, that must surface as a critical alert —
 * not a backlog item discovered later.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import {
  getCustodyRule, canCustodyDeposits, flagUnsupportedCustodyState,
  flagDepositInterestObligation,
} from './depositCustody'

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM admin_notifications WHERE category = 'deposit_custody_unsupported'`)
  await db.query(`DELETE FROM state_deposit_custody_rules`)
  await db.query(`DELETE FROM admin_notifications WHERE category = 'deposit_interest_obligation'`)
  await db.query(`DELETE FROM state_deposit_interest_rates WHERE state_code IN ('XC','XD')`)
  // gam_test is rebuilt from the SCHEMA dump, so migration-seeded reference
  // rows are not present. Seed the two verified cases the suite asserts on.
  await db.query(
    `INSERT INTO state_deposit_custody_rules
       (state_code, custody_status, allows_treasury_bills,
        requires_in_state_depository, requires_federally_insured,
        requires_interest_bearing, prohibits_use_of_funds, statute_citation)
     VALUES
       ('MD', 'supported', true,  true, true, false, false, 'Md. Code, Real Prop. § 8-203'),
       ('FL', 'blocked',   false, true, false, true, true,  'Fla. Stat. § 83.49')`)
})

const openAlerts = async () => (await db.query<{ id: string; body: string; severity: string }>(
  `SELECT id, body, severity FROM admin_notifications
    WHERE category = 'deposit_custody_unsupported' AND acknowledged_at IS NULL`)).rows

describe('getCustodyRule', () => {
  it('FAIL-CLOSED: an unresearched state reads as needs_research, not supported', async () => {
    // Silence in the catalog must never read as permission — that is how tenant
    // deposit money ends up somewhere unlawful.
    const rule = await getCustodyRule('XA')
    expect(rule.custody_status).toBe('needs_research')
    expect(rule.allows_treasury_bills).toBe(false)
    expect(await canCustodyDeposits('XA')).toBe(false)
  })

  it('MD is supported — statute expressly permits federal government securities', async () => {
    const rule = await getCustodyRule('MD')
    expect(rule.custody_status).toBe('supported')
    expect(rule.allows_treasury_bills).toBe(true)
    expect(await canCustodyDeposits('MD')).toBe(true)
  })

  it('FL is blocked — in-state institution required and use of funds barred', async () => {
    const rule = await getCustodyRule('FL')
    expect(rule.custody_status).toBe('blocked')
    expect(rule.allows_treasury_bills).toBe(false)
    expect(rule.prohibits_use_of_funds).toBe(true)
    expect(await canCustodyDeposits('FL')).toBe(false)
  })
})

describe('flagUnsupportedCustodyState', () => {
  it('raises a CRITICAL alert naming the state and the blocker', async () => {
    await flagUnsupportedCustodyState({ stateCode: 'FL', propertyName: 'Sunny Acres' })
    const alerts = await openAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('critical')
    expect(alerts[0].body).toMatch(/bars using\/pledging the funds/i)
    expect(alerts[0].body).toMatch(/IMMEDIATE build/i)
    // Must tell the operator what to do in the meantime.
    expect(alerts[0].body).toMatch(/held_by='landlord'/)
  })

  it('does NOT alert for a supported state', async () => {
    await flagUnsupportedCustodyState({ stateCode: 'MD' })
    expect(await openAlerts()).toHaveLength(0)
  })

  it('alerts for an unresearched state (fail-closed)', async () => {
    await flagUnsupportedCustodyState({ stateCode: 'XB' })
    expect(await openAlerts()).toHaveLength(1)
  })

  it('deduped per state — a second landlord does not bury the first alert', async () => {
    await flagUnsupportedCustodyState({ stateCode: 'FL', propertyName: 'One' })
    await flagUnsupportedCustodyState({ stateCode: 'FL', propertyName: 'Two' })
    expect(await openAlerts()).toHaveLength(1)
  })

  it('re-raises once the prior alert is acknowledged and the state is still unsupported', async () => {
    await flagUnsupportedCustodyState({ stateCode: 'FL' })
    await db.query(
      `UPDATE admin_notifications SET acknowledged_at = NOW()
        WHERE category = 'deposit_custody_unsupported'`)
    await flagUnsupportedCustodyState({ stateCode: 'FL' })
    expect(await openAlerts()).toHaveLength(1)
  })

  it('does not fire for a state whose only rows are verified negatives', async () => {
    const yr = new Date().getUTCFullYear()
    await db.query(
      `INSERT INTO state_deposit_interest_rates
         (state_code, effective_year, annual_rate_pct, statute_citation,
          unit_types, rate_basis)
       VALUES ('XC', $1, 0, 'Some § 1', '{}', 'none')`, [yr])
    await flagDepositInterestObligation({ stateCode: 'XC' })
    const alerts = await db.query(
      `SELECT id FROM admin_notifications WHERE category='deposit_interest_obligation'`)
    expect(alerts.rows).toHaveLength(0)
  })

  it('never throws — a custody gap must not be able to block onboarding', async () => {
    // Onboarding is post-commit; an alerting failure is recoverable, a failed
    // signup is not.
    await expect(
      flagUnsupportedCustodyState({ stateCode: null as any }),
    ).resolves.toBeUndefined()
  })
})

describe('flagDepositInterestObligation', () => {
  const yr = new Date().getUTCFullYear()

  it('raises a CRITICAL alert listing each obligation and its gates', async () => {
    await db.query(
      `INSERT INTO state_deposit_interest_rates
         (state_code, effective_year, annual_rate_pct, statute_citation,
          unit_types, rate_basis, min_property_units)
       VALUES ('XD', $1, 3.0, 'Some § 18', ARRAY['mobile_home'], 'fixed', 25)`, [yr])

    await flagDepositInterestObligation({ stateCode: 'XD', propertyName: 'Park' })
    const { rows } = await db.query<{ severity: string; body: string }>(
      `SELECT severity, body FROM admin_notifications
        WHERE category = 'deposit_interest_obligation'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].severity).toBe('critical')
    expect(rows[0].body).toMatch(/mobile_home/)
    expect(rows[0].body).toMatch(/25\+ units/)
    // Must warn in BOTH directions — under-pay is penalised, over-pay leaks margin.
    expect(rows[0].body).toMatch(/twice the amount withheld/i)
    expect(rows[0].body).toMatch(/over-paying/i)
  })

  it('deduped per state', async () => {
    await db.query(
      `INSERT INTO state_deposit_interest_rates
         (state_code, effective_year, annual_rate_pct, statute_citation,
          unit_types, rate_basis)
       VALUES ('XD', $1, 3.0, 'Some § 18', '{}', 'fixed')`, [yr])
    await flagDepositInterestObligation({ stateCode: 'XD' })
    await flagDepositInterestObligation({ stateCode: 'XD' })
    const { rows } = await db.query(
      `SELECT id FROM admin_notifications WHERE category='deposit_interest_obligation'`)
    expect(rows).toHaveLength(1)
  })

  it('silent for a state with no catalog rows (custody flag covers the unknown)', async () => {
    await flagDepositInterestObligation({ stateCode: 'XD' })
    const { rows } = await db.query(
      `SELECT id FROM admin_notifications WHERE category='deposit_interest_obligation'`)
    expect(rows).toHaveLength(0)
  })
})
