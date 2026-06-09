/**
 * S434 services-audit slice 11 — first cut of stripeConnect.ts.
 *
 * Targets the account-management surface (the embedded-onboarding +
 * status side, not the money-movement side). Each session in this
 * multi-session arc carves off a coherent subset:
 *   S434 (this): ensureConnectAccount + createOnboardingSession +
 *                fetchAccountStatus + computeApplicationFee +
 *                recordAccountUpdated
 *   S435+: charges (rent destination + platform), transfers
 *          (PM company), payout/dispute webhook recorders
 *
 * Stripe is mocked at the `lib/stripe` module boundary. DB rows are real
 * — readiness flags get written to `users` / `pm_companies` and queried
 * back.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const {
  accountsCreateMock, accountsRetrieveMock, accountSessionsCreateMock,
  transfersCreateMock, adminNotifyMock,
} = vi.hoisted(() => ({
  accountsCreateMock:        vi.fn(async () => ({ id: 'acct_mock' } as any)),
  accountsRetrieveMock:      vi.fn(async () => ({} as any)),
  accountSessionsCreateMock: vi.fn(async () => ({ client_secret: 'cs_mock' } as any)),
  transfersCreateMock:       vi.fn(async () => ({ id: 'tr_mock' } as any)),
  adminNotifyMock:           vi.fn(async () => undefined),
}))

vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    accounts:        { create: accountsCreateMock, retrieve: accountsRetrieveMock },
    accountSessions: { create: accountSessionsCreateMock },
    transfers:       { create: transfersCreateMock },
  }),
}))

vi.mock('./adminNotifications', () => ({
  createAdminNotification: adminNotifyMock,
}))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedUserBankAccount, seedPmCompany,
} from '../test/dbHelpers'
import {
  ensureConnectAccount, createOnboardingSession, fetchAccountStatus,
  computeApplicationFee, recordAccountUpdated,
} from './stripeConnect'

beforeEach(async () => {
  await cleanupAllSchema()
  accountsCreateMock.mockReset()
  accountsRetrieveMock.mockReset()
  accountSessionsCreateMock.mockReset()
  transfersCreateMock.mockReset()
  adminNotifyMock.mockReset()
  accountsCreateMock.mockResolvedValue({ id: 'acct_mock_default' } as any)
  accountSessionsCreateMock.mockResolvedValue({ client_secret: 'cs_default' } as any)
  accountsRetrieveMock.mockResolvedValue({} as any)
})

// ─── ensureConnectAccount ────────────────────────────────────

describe('ensureConnectAccount — user entity', () => {
  it('creates a new account when user has none; persists id; returns it', async () => {
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const { userId: uid } = await seedLandlord(c)
      userId = uid
      await c.query('COMMIT')
    } finally { c.release() }
    accountsCreateMock.mockResolvedValueOnce({ id: 'acct_new_user' } as any)
    const acctId = await ensureConnectAccount({
      entity: 'user', entityId: userId, email: 'l@example.com',
    })
    expect(acctId).toBe('acct_new_user')
    expect(accountsCreateMock).toHaveBeenCalledTimes(1)
    // Persisted on users row.
    const { rows: [u] } = await db.query<any>(
      `SELECT stripe_connect_account_id FROM users WHERE id=$1`, [userId])
    expect(u.stripe_connect_account_id).toBe('acct_new_user')
  })

  it('idempotent: pre-existing connect id returned without a Stripe call', async () => {
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const { userId: uid } = await seedLandlord(c)
      userId = uid
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(
      `UPDATE users SET stripe_connect_account_id='acct_already' WHERE id=$1`, [userId])
    const acctId = await ensureConnectAccount({
      entity: 'user', entityId: userId, email: 'l@example.com',
    })
    expect(acctId).toBe('acct_already')
    expect(accountsCreateMock).not.toHaveBeenCalled()
  })

  it('passes controller config + US country + capabilities + manual payout schedule + metadata', async () => {
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const { userId: uid } = await seedLandlord(c)
      userId = uid
      await c.query('COMMIT')
    } finally { c.release() }
    accountsCreateMock.mockResolvedValueOnce({ id: 'acct_check_shape' } as any)
    await ensureConnectAccount({
      entity: 'user', entityId: userId, email: 'l@example.com',
      metadata: { custom_key: 'custom_value' },
    })
    expect(accountsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      controller: expect.objectContaining({
        stripe_dashboard: { type: 'express' },
        fees:             { payer: 'application' },
        losses:           { payments: 'application' },
      }),
      country: 'US',
      email:   'l@example.com',
      capabilities: {
        card_payments: { requested: true },
        transfers:     { requested: true },
      },
      settings: { payouts: { schedule: { interval: 'manual' } } },
      metadata: expect.objectContaining({
        gam_entity:    'user',
        gam_entity_id: userId,
        custom_key:    'custom_value',
      }),
    }))
  })

  it('unknown user → 404', async () => {
    await expect(ensureConnectAccount({
      entity: 'user', entityId: '00000000-0000-0000-0000-000000000000',
      email: 'x@example.com',
    })).rejects.toThrow(/User not found/)
  })
})

describe('ensureConnectAccount — pm_company entity', () => {
  it('creates + persists on pm_companies row', async () => {
    const c = await db.connect()
    let pmCompanyId = ''
    try {
      await c.query('BEGIN')
      const { userId } = await seedLandlord(c)
      const bankId = await seedUserBankAccount(c, { userId })
      pmCompanyId = await seedPmCompany(c, { bankAccountId: bankId })
      await c.query('COMMIT')
    } finally { c.release() }
    accountsCreateMock.mockResolvedValueOnce({ id: 'acct_new_pm' } as any)
    const acctId = await ensureConnectAccount({
      entity: 'pm_company', entityId: pmCompanyId, email: 'pm@example.com',
      businessName: 'Acme PM',
    })
    expect(acctId).toBe('acct_new_pm')
    expect(accountsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      business_profile: { name: 'Acme PM' },
    }))
    const { rows: [pm] } = await db.query<any>(
      `SELECT stripe_connect_account_id FROM pm_companies WHERE id=$1`, [pmCompanyId])
    expect(pm.stripe_connect_account_id).toBe('acct_new_pm')
  })

  it('unknown pm_company → 404', async () => {
    await expect(ensureConnectAccount({
      entity: 'pm_company', entityId: '00000000-0000-0000-0000-000000000000',
      email: 'x@example.com',
    })).rejects.toThrow(/PM company not found/)
  })

  it('omits business_profile when businessName not provided', async () => {
    const c = await db.connect()
    let pmCompanyId = ''
    try {
      await c.query('BEGIN')
      const { userId } = await seedLandlord(c)
      const bankId = await seedUserBankAccount(c, { userId })
      pmCompanyId = await seedPmCompany(c, { bankAccountId: bankId })
      await c.query('COMMIT')
    } finally { c.release() }
    accountsCreateMock.mockResolvedValueOnce({ id: 'acct_no_bp' } as any)
    await ensureConnectAccount({
      entity: 'pm_company', entityId: pmCompanyId, email: 'pm@example.com',
    })
    const call = (accountsCreateMock.mock.calls[0] as any[])[0]
    expect(call.business_profile).toBeUndefined()
  })
})

// ─── createOnboardingSession ─────────────────────────────────

describe('createOnboardingSession', () => {
  it('happy: enables account_onboarding component + returns client_secret', async () => {
    accountSessionsCreateMock.mockResolvedValueOnce({ client_secret: 'cs_abc' } as any)
    const secret = await createOnboardingSession('acct_test')
    expect(secret).toBe('cs_abc')
    expect(accountSessionsCreateMock).toHaveBeenCalledWith({
      account: 'acct_test',
      components: { account_onboarding: { enabled: true } },
    })
  })

  it('missing client_secret → 500', async () => {
    accountSessionsCreateMock.mockResolvedValueOnce({ client_secret: null } as any)
    await expect(createOnboardingSession('acct_test'))
      .rejects.toThrow(/no client_secret/)
  })
})

// ─── fetchAccountStatus ──────────────────────────────────────

describe('fetchAccountStatus', () => {
  it('extracts charges/payouts/details flags + requirements arrays', async () => {
    accountsRetrieveMock.mockResolvedValueOnce({
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      requirements: {
        currently_due: ['individual.dob'],
        past_due:      ['external_account'],
        disabled_reason: 'requirements.past_due',
      },
    } as any)
    const status = await fetchAccountStatus('acct_test')
    expect(status).toEqual({
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      requirements_currently_due: ['individual.dob'],
      requirements_past_due:      ['external_account'],
      requirements_disabled_reason: 'requirements.past_due',
    })
  })

  it('defaults nullish fields safely (no requirements object)', async () => {
    accountsRetrieveMock.mockResolvedValueOnce({} as any)
    const status = await fetchAccountStatus('acct_test')
    expect(status).toEqual({
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements_currently_due: [],
      requirements_past_due:      [],
      requirements_disabled_reason: null,
    })
  })
})

// ─── computeApplicationFee ───────────────────────────────────

describe('computeApplicationFee — ACH', () => {
  it('ACH 1% on small amounts ($100 → $1)', () => {
    expect(computeApplicationFee({ amount: 100, paymentMethod: 'ach' })).toBe(1)
  })

  it('ACH cap at $6 ($1000 → $6, not $10)', () => {
    expect(computeApplicationFee({ amount: 1000, paymentMethod: 'ach' })).toBe(6)
  })

  it('ACH at exact cap boundary ($600 → $6)', () => {
    expect(computeApplicationFee({ amount: 600, paymentMethod: 'ach' })).toBe(6)
  })
})

describe('computeApplicationFee — card', () => {
  it('US card 3.25% ($100 → $3.25)', () => {
    expect(computeApplicationFee({
      amount: 100, paymentMethod: 'card', cardCountry: 'US',
    })).toBe(3.25)
  })

  it('card with null country defaults to base 3.25%', () => {
    expect(computeApplicationFee({
      amount: 100, paymentMethod: 'card', cardCountry: null,
    })).toBe(3.25)
  })

  it('non-US card adds 1.5% surcharge (CA $100 → $4.75)', () => {
    expect(computeApplicationFee({
      amount: 100, paymentMethod: 'card', cardCountry: 'CA',
    })).toBe(4.75)
  })

  it('card amount rounded to cents (3.25% of $33.33 → $1.08, not $1.083225)', () => {
    expect(computeApplicationFee({
      amount: 33.33, paymentMethod: 'card', cardCountry: 'US',
    })).toBe(1.08)
  })
})

// ─── recordAccountUpdated ────────────────────────────────────

describe('recordAccountUpdated', () => {
  it('user with the account_id → updates readiness + synced_at', async () => {
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const { userId: uid } = await seedLandlord(c)
      userId = uid
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(
      `UPDATE users SET stripe_connect_account_id='acct_sync1' WHERE id=$1`,
      [userId])
    await recordAccountUpdated({
      id: 'acct_sync1',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    } as any)
    const { rows: [u] } = await db.query<any>(
      `SELECT connect_charges_enabled, connect_payouts_enabled,
              connect_details_submitted, stripe_connect_status_synced_at
         FROM users WHERE id=$1`, [userId])
    expect(u.connect_charges_enabled).toBe(true)
    expect(u.connect_payouts_enabled).toBe(true)
    expect(u.connect_details_submitted).toBe(true)
    expect(u.stripe_connect_status_synced_at).not.toBeNull()
  })

  it('pm_company with the account_id → updates readiness + synced_at', async () => {
    const c = await db.connect()
    let pmCompanyId = ''
    try {
      await c.query('BEGIN')
      const { userId } = await seedLandlord(c)
      const bankId = await seedUserBankAccount(c, { userId })
      pmCompanyId = await seedPmCompany(c, { bankAccountId: bankId })
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(
      `UPDATE pm_companies SET stripe_connect_account_id='acct_pm_sync' WHERE id=$1`,
      [pmCompanyId])
    await recordAccountUpdated({
      id: 'acct_pm_sync',
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
    } as any)
    const { rows: [pm] } = await db.query<any>(
      `SELECT connect_charges_enabled, connect_payouts_enabled,
              connect_details_submitted, stripe_connect_status_synced_at
         FROM pm_companies WHERE id=$1`, [pmCompanyId])
    expect(pm.connect_charges_enabled).toBe(true)
    expect(pm.connect_payouts_enabled).toBe(false)
    expect(pm.connect_details_submitted).toBe(true)
    expect(pm.stripe_connect_status_synced_at).not.toBeNull()
  })

  it('nullish capability flags default to FALSE', async () => {
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const { userId: uid } = await seedLandlord(c)
      userId = uid
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(
      `UPDATE users SET stripe_connect_account_id='acct_nullish' WHERE id=$1`,
      [userId])
    await recordAccountUpdated({ id: 'acct_nullish' } as any)
    const { rows: [u] } = await db.query<any>(
      `SELECT connect_charges_enabled, connect_payouts_enabled, connect_details_submitted
         FROM users WHERE id=$1`, [userId])
    expect(u.connect_charges_enabled).toBe(false)
    expect(u.connect_payouts_enabled).toBe(false)
    expect(u.connect_details_submitted).toBe(false)
  })

  it('no matching row → noop (both UPDATEs match 0; no throw)', async () => {
    await expect(recordAccountUpdated({
      id: 'acct_does_not_exist',
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
    } as any)).resolves.toBeUndefined()
  })

  it('S113-PhaseA: charges_enabled + details_submitted → tries passthrough reconcile (no platform_held → noop)', async () => {
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const { userId: uid } = await seedLandlord(c)
      userId = uid
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(
      `UPDATE users SET stripe_connect_account_id='acct_ready' WHERE id=$1`,
      [userId])
    await recordAccountUpdated({
      id: 'acct_ready',
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
    } as any)
    // No platform_held payments seeded → reconcile inspects + no-ops; no
    // Stripe transfer fires. The function must complete without throwing.
    expect(transfersCreateMock).not.toHaveBeenCalled()
  })

  it('NOT details_submitted → does NOT invoke reconcile path', async () => {
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const { userId: uid } = await seedLandlord(c)
      userId = uid
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(
      `UPDATE users SET stripe_connect_account_id='acct_partial' WHERE id=$1`,
      [userId])
    await recordAccountUpdated({
      id: 'acct_partial',
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: false,  // not ready
    } as any)
    expect(transfersCreateMock).not.toHaveBeenCalled()
  })
})
