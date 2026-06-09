/**
 * S426 services-audit slice 3: riskScore.ts.
 *
 * `calculateRiskScore` is a single function that aggregates four
 * scoring categories — identity / financial / behavioral / duplicate
 * — and returns { score, level, flags, categories }. Mostly pure;
 * the behavioral + duplicate categories hit the DB
 * (background_checks lookups).
 *
 * Test layout mirrors the four categories + the level-mapping rules
 * + the score-cap behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { calculateRiskScore } from './riskScore'

beforeEach(async () => {
  await cleanupAllSchema()
})

// Baseline-clean intake: should score 0 (no flags fire).
const baselineIntake = () => ({
  firstName: 'Jane',
  lastName:  'Doe',
  email:     'jane@gmail.com',
  phone:     null as string | null,
  ssn:       '147258369',         // mixed digits, no repeats / sequences
  dob:       '1990-04-12',
  state:     'AZ',
  zip:       '85001',
  employmentStatus: 'employed',
  monthlyIncome:    5000,
  timeToComplete:   600,           // 10 min — well clear
  ipAddress:        '1.2.3.4',
  userAgent:        'Mozilla/5.0',
  landlordId:       '00000000-0000-0000-0000-000000000000',
  unitRent:         1000,
})

// ─── baseline ────────────────────────────────────────────────

describe('calculateRiskScore — baseline', () => {
  it('clean intake → score=0 (after income/rent ratio credits), level=low, no flags', async () => {
    const res = await calculateRiskScore(baselineIntake())
    // income $5000 / rent $1000 = 5x → -5 credit; score floors at 0.
    expect(res.score).toBeGreaterThanOrEqual(0)
    expect(res.level).toBe('low')
    expect(res.flags).toEqual([])
  })

  it('returns categorized flags shape', async () => {
    const res = await calculateRiskScore(baselineIntake())
    expect(res.categories).toHaveProperty('identity')
    expect(res.categories).toHaveProperty('financial')
    expect(res.categories).toHaveProperty('behavioral')
    expect(res.categories).toHaveProperty('duplicate')
  })
})

// ─── identity category ──────────────────────────────────────

describe('identity flags', () => {
  it('unrealistic first name (consonants only) → first_name_not_realistic + +20', async () => {
    const res = await calculateRiskScore({ ...baselineIntake(), firstName: 'xkpz' })
    expect(res.categories.identity).toContain('first_name_not_realistic')
    expect(res.score).toBeGreaterThanOrEqual(20 - 5)  // accounting for ratio credit
  })

  it('unrealistic last name → last_name_not_realistic', async () => {
    const res = await calculateRiskScore({ ...baselineIntake(), lastName: 'qqqqqq' })
    expect(res.categories.identity).toContain('last_name_not_realistic')
  })

  it('keyboard-walk name → not_realistic', async () => {
    const res = await calculateRiskScore({ ...baselineIntake(), firstName: 'qwerty' })
    expect(res.categories.identity).toContain('first_name_not_realistic')
  })

  it('disposable email domain → disposable_email + +40', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), email: 'foo@mailinator.com',
    })
    expect(res.categories.identity).toContain('disposable_email')
  })

  it('suspicious email keyword (temp/trash/spam) → suspicious_email_domain', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), email: 'foo@tempaddress.org',
    })
    expect(res.categories.identity).toContain('suspicious_email_domain')
  })

  it('SSN with five identical digits → ssn_five_repeated_digit_X', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), ssn: '111112389',
    })
    expect(res.categories.identity.some(f => f.startsWith('ssn_five_repeated_digit_'))).toBe(true)
  })

  it('SSN sequential ascending → ssn_sequential_ascending', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), ssn: '512345689',
    })
    expect(res.categories.identity).toContain('ssn_sequential_ascending')
  })

  it('SSN sequential descending → ssn_sequential_descending', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), ssn: '598765489',
    })
    expect(res.categories.identity).toContain('ssn_sequential_descending')
  })

  it('SSN repeating-prefix pattern → ssn_repeating_pattern', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), ssn: '121212389',
    })
    expect(res.categories.identity).toContain('ssn_repeating_pattern')
  })

  it('under-18 dob → under_18 +50', async () => {
    const tooYoung = new Date(Date.now() - 17 * 365.25 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
    const res = await calculateRiskScore({
      ...baselineIntake(), dob: tooYoung,
    })
    expect(res.categories.identity).toContain('under_18')
  })

  it('over-100 dob → age_over_100', async () => {
    const ancient = new Date(Date.now() - 105 * 365.25 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
    const res = await calculateRiskScore({
      ...baselineIntake(), dob: ancient,
    })
    expect(res.categories.identity).toContain('age_over_100')
  })
})

// ─── financial category ─────────────────────────────────────

describe('financial flags', () => {
  it('income < 2× rent → income_below_2x_rent +35', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), monthlyIncome: 1500,  // 1.5× $1000
    })
    expect(res.categories.financial).toContain('income_below_2x_rent')
  })

  it('income between 2× and 3× rent → income_below_3x_rent +10', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), monthlyIncome: 2500,  // 2.5×
    })
    expect(res.categories.financial).toContain('income_below_3x_rent')
  })

  it('unemployed but high income → unemployed_high_income +20', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), employmentStatus: 'unemployed', monthlyIncome: 6000,
      unitRent: 0,  // skip ratio so this flag is the only financial flag
    })
    expect(res.categories.financial).toContain('unemployed_high_income')
  })

  it('employed but income < 500 → employed_very_low_income +20', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), employmentStatus: 'employed', monthlyIncome: 200,
      unitRent: 0,  // skip ratio
    })
    expect(res.categories.financial).toContain('employed_very_low_income')
  })

  it('self-employed under 22 with high income → age_income_inconsistency', async () => {
    const youngDob = new Date(Date.now() - 20 * 365.25 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
    const res = await calculateRiskScore({
      ...baselineIntake(),
      dob: youngDob,
      employmentStatus: 'self_employed', monthlyIncome: 12000,
      unitRent: 0,
    })
    expect(res.categories.financial).toContain('age_income_inconsistency')
  })
})

// ─── behavioral category ────────────────────────────────────

describe('behavioral flags', () => {
  it('completed under 60s → completed_under_60s +30', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), timeToComplete: 45,
    })
    expect(res.categories.behavioral).toContain('completed_under_60s')
  })

  it('completed between 60s and 120s → completed_under_2min +10', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), timeToComplete: 90,
    })
    expect(res.categories.behavioral).toContain('completed_under_2min')
  })

  it('3+ background_checks from same IP in 24h → multiple_apps_same_ip', async () => {
    // Seed a landlord + user so background_checks FK resolves.
    const c = await db.connect()
    let landlordId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      const r = await seedLandlord(c)
      landlordId = r.landlordId; userId = r.userId
      // Seed 3 background_checks with the same IP, within 24h.
      for (let i = 0; i < 3; i++) {
        await c.query(
          `INSERT INTO background_checks
             (landlord_id, user_id, status, ip_address,
              consent_credit, consent_criminal, consent_pool,
              applicant_payment_intent_id)
           VALUES ($1, $2, 'pending', '7.7.7.7', TRUE, TRUE, FALSE, $3)`,
          [landlordId, userId, `pi_test_${i}`])
      }
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await calculateRiskScore({
      ...baselineIntake(), landlordId, ipAddress: '7.7.7.7',
    })
    expect(res.categories.behavioral).toContain('multiple_apps_same_ip')
  })
})

// ─── duplicate category ────────────────────────────────────

describe('duplicate flags', () => {
  it('matching SSN+DOB but different name → ssn_dob_name_mismatch', async () => {
    // Seed a prior background_check with same ssn_last4 + dob, different name.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await seedLandlord(c)
      await c.query(
        `INSERT INTO background_checks
           (landlord_id, user_id, status,
            first_name, last_name, date_of_birth, ssn_last4,
            consent_credit, consent_criminal, consent_pool,
            applicant_payment_intent_id)
         VALUES ($1, $2, 'pending',
                 'Different', 'Person', '1990-04-12', '8369',
                 TRUE, TRUE, FALSE, 'pi_dup_1')`,
        [r.landlordId, r.userId])
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await calculateRiskScore({
      ...baselineIntake(),
      ssn: '147258369',  // last4 = 8369
    })
    expect(res.categories.duplicate).toContain('ssn_dob_name_mismatch')
  })

  it('prior denial under same email → previous_denials_N', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await seedLandlord(c)
      // Tie a user to the email we'll send in.
      const { rows: [{ id: appUserId }] } = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ('jane@gmail.com', 'x', 'tenant', 'Jane', 'Doe', TRUE) RETURNING id`)
      // Two denied prior background checks for that user.
      for (let i = 0; i < 2; i++) {
        await c.query(
          `INSERT INTO background_checks
             (landlord_id, user_id, status,
              consent_credit, consent_criminal, consent_pool,
              applicant_payment_intent_id)
           VALUES ($1, $2, 'denied', TRUE, TRUE, FALSE, $3)`,
          [r.landlordId, appUserId, `pi_denial_${i}`])
      }
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await calculateRiskScore({
      ...baselineIntake(), email: 'jane@gmail.com',
    })
    expect(res.categories.duplicate.some(f => f.startsWith('previous_denials_'))).toBe(true)
  })
})

// ─── level mapping ──────────────────────────────────────────

describe('level mapping', () => {
  it('score ≥ 70 → very_high', async () => {
    // Stack flags: under_18 (50) + disposable_email (40) → 90,
    // minus 5 ratio credit = 85. Crosses the very_high threshold.
    const tooYoung = new Date(Date.now() - 16 * 365.25 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
    const res = await calculateRiskScore({
      ...baselineIntake(), dob: tooYoung, email: 'x@mailinator.com',
    })
    expect(res.score).toBeGreaterThanOrEqual(70)
    expect(res.level).toBe('very_high')
  })

  it('score in [45, 69] → high', async () => {
    // Disposable email alone is +40; combine with another small flag.
    const res = await calculateRiskScore({
      ...baselineIntake(), email: 'x@mailinator.com', timeToComplete: 90,
    })
    expect(res.score).toBeGreaterThanOrEqual(45)
    expect(res.score).toBeLessThanOrEqual(69)
    expect(res.level).toBe('high')
  })

  it('score in [20, 44] → medium', async () => {
    // Single +30 behavioral flag puts us in medium.
    const res = await calculateRiskScore({
      ...baselineIntake(), timeToComplete: 30,
    })
    expect(res.score).toBeGreaterThanOrEqual(20)
    expect(res.score).toBeLessThanOrEqual(44)
    expect(res.level).toBe('medium')
  })

  it('score < 20 → low', async () => {
    const res = await calculateRiskScore({
      ...baselineIntake(), timeToComplete: 90,  // +10 behavioral only
    })
    expect(res.score).toBeLessThan(20)
    expect(res.level).toBe('low')
  })

  it('score caps at 100', async () => {
    // Pile on multiple high-weight flags.
    const tooYoung = new Date(Date.now() - 15 * 365.25 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
    const res = await calculateRiskScore({
      ...baselineIntake(),
      firstName: 'xxx',          // +20
      lastName:  'yyy',          // +20
      dob:       tooYoung,        // +50
      email:     'x@mailinator.com',  // +40
      ssn:       '111111111',     // +25 +30
      timeToComplete: 10,         // +30
    })
    expect(res.score).toBe(100)
  })
})
