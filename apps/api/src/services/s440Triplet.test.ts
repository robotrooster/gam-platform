/**
 * S440 services-audit triplet slice — medium-helper sweep.
 *
 *   - posTerminal.ts (291 lines): Stripe Terminal reader management
 *     + card-present PaymentIntent lifecycle
 *   - depositInterest.ts (352 lines): S188/S190 per-state interest
 *     accrual; resolveRateForLandlord (statutory > override > null),
 *     computeMonthlyAccrual (partial-month math), runMonthlyAccrual
 *     (idempotent ON CONFLICT)
 *   - depositPortability.ts (379 lines): S255 deposit carry-forward
 *     across leases; auto-detect + authorize + decline + execute
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const {
  connectionTokensCreateMock, terminalReadersCreateMock,
  terminalProcessPaymentIntentMock, paymentIntentsCreateMock,
  paymentIntentsCaptureMock, paymentIntentsCancelMock,
  paymentIntentsRetrieveMock, adminNotifyMock,
} = vi.hoisted(() => ({
  connectionTokensCreateMock:        vi.fn(async () => ({ secret: 'pst_mock' } as any)),
  terminalReadersCreateMock:         vi.fn(async () => ({ id: 'tmr_mock' } as any)),
  terminalProcessPaymentIntentMock:  vi.fn(async () => ({ id: 'tmr_mock' } as any)),
  paymentIntentsCreateMock:          vi.fn(async () => ({ id: 'pi_mock' } as any)),
  paymentIntentsCaptureMock:         vi.fn(async () => ({ id: 'pi_mock', status: 'succeeded' } as any)),
  paymentIntentsCancelMock:          vi.fn(async () => ({ id: 'pi_mock', status: 'canceled' } as any)),
  paymentIntentsRetrieveMock:        vi.fn(async () => ({ id: 'pi_mock' } as any)),
  adminNotifyMock:                   vi.fn(async () => undefined),
}))

vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    terminal: {
      connectionTokens: { create: connectionTokensCreateMock },
      readers: {
        create: terminalReadersCreateMock,
        processPaymentIntent: terminalProcessPaymentIntentMock,
      },
    },
    paymentIntents: {
      create:   paymentIntentsCreateMock,
      capture:  paymentIntentsCaptureMock,
      cancel:   paymentIntentsCancelMock,
      retrieve: paymentIntentsRetrieveMock,
    },
  }),
}))

vi.mock('./adminNotifications', () => ({
  createAdminNotification: adminNotifyMock,
}))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedSecurityDeposit,
} from '../test/dbHelpers'
import {
  createConnectionToken, registerReader, listReaders, archiveReader,
  createCardPresentPaymentIntent, captureTerminalPaymentIntent,
} from './posTerminal'
import {
  resolveRateForLandlord, computeMonthlyAccrual, runMonthlyAccrual,
  getAccrualHistory,
} from './depositInterest'
import {
  detectPortabilityEligible, authorizeDepositPortability,
  declineDepositPortability, executeDepositPortability,
} from './depositPortability'

beforeEach(async () => {
  // Pre-clean tables not in cleanupAllSchema.
  await db.query(`DELETE FROM security_deposit_interest_accruals`)
  await db.query(`DELETE FROM landlord_deposit_interest_rate_overrides`)
  // state_deposit_interest_rates has S188 production seed; isolate at 2099.
  await db.query(`DELETE FROM state_deposit_interest_rates WHERE effective_year=2099`)
  // S604: same isolation for the market-yield side — a rate left behind by a
  // prior test silently turns "no rate on file" into "earned something".
  await db.query(`DELETE FROM deposit_pool_yield_rates WHERE effective_month >= '2099-01-01'`)
  await cleanupAllSchema()
  connectionTokensCreateMock.mockReset()
  terminalReadersCreateMock.mockReset()
  terminalProcessPaymentIntentMock.mockReset()
  paymentIntentsCreateMock.mockReset()
  paymentIntentsCaptureMock.mockReset()
  paymentIntentsCancelMock.mockReset()
  paymentIntentsRetrieveMock.mockReset()
  adminNotifyMock.mockReset()
  connectionTokensCreateMock.mockResolvedValue({ secret: 'pst_default' } as any)
  terminalReadersCreateMock.mockResolvedValue({ id: 'tmr_default' } as any)
  paymentIntentsCreateMock.mockResolvedValue({ id: 'pi_default' } as any)
})

// ═════════════════════════ posTerminal ═════════════════════════

describe('posTerminal', () => {
  async function seedLandlordProperty(): Promise<{ landlordId: string; propertyId: string; landlordUserId: string }> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      await c.query('COMMIT')
      return { landlordId, propertyId, landlordUserId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('createConnectionToken: returns secret + fires under stripeAccount', async () => {
    connectionTokensCreateMock.mockResolvedValueOnce({ secret: 'pst_real' } as any)
    const secret = await createConnectionToken('acct_landlord')
    expect(secret).toBe('pst_real')
    expect(connectionTokensCreateMock).toHaveBeenCalledWith(
      {},
      { stripeAccount: 'acct_landlord' })
  })

  it('createConnectionToken: missing secret → 500', async () => {
    connectionTokensCreateMock.mockResolvedValueOnce({ secret: null } as any)
    await expect(createConnectionToken('acct_x')).rejects.toThrow(/no secret/)
  })

  it('registerReader: happy — creates Stripe reader + inserts pos_terminal_readers row', async () => {
    const ctx = await seedLandlordProperty()
    terminalReadersCreateMock.mockResolvedValueOnce({ id: 'tmr_new' } as any)
    const row = await registerReader({
      landlordId: ctx.landlordId,
      landlordConnectAccountId: 'acct_landlord',
      propertyId: ctx.propertyId,
      registrationCode: 'pair-1234',
      nickname: 'Front Counter',
    })
    expect(row.stripe_reader_id).toBe('tmr_new')
    expect(row.nickname).toBe('Front Counter')
    expect(row.status).toBe('active')
    expect(terminalReadersCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ registration_code: 'pair-1234', label: 'Front Counter' }),
      { stripeAccount: 'acct_landlord' })
  })

  it('registerReader: 23505 duplicate → 409', async () => {
    const ctx = await seedLandlordProperty()
    // First registration.
    terminalReadersCreateMock.mockResolvedValueOnce({ id: 'tmr_dup' } as any)
    await registerReader({
      landlordId: ctx.landlordId, landlordConnectAccountId: 'acct',
      propertyId: ctx.propertyId, registrationCode: 'pair-1', nickname: 'R1',
    })
    // Same reader id again → UNIQUE catch
    terminalReadersCreateMock.mockResolvedValueOnce({ id: 'tmr_dup' } as any)
    await expect(registerReader({
      landlordId: ctx.landlordId, landlordConnectAccountId: 'acct',
      propertyId: ctx.propertyId, registrationCode: 'pair-1', nickname: 'R1 dup',
    })).rejects.toThrow(/already registered with this landlord/)
  })

  it('listReaders: with propertyId filters; without returns all active', async () => {
    const ctx = await seedLandlordProperty()
    terminalReadersCreateMock.mockResolvedValueOnce({ id: 'tmr_a' } as any)
    await registerReader({
      landlordId: ctx.landlordId, landlordConnectAccountId: 'acct',
      propertyId: ctx.propertyId, registrationCode: 'pair-a', nickname: 'A',
    })
    // Second property + reader on it.
    const c = await db.connect()
    let p2 = ''
    try {
      await c.query('BEGIN')
      p2 = await seedProperty(c, {
        landlordId: ctx.landlordId, ownerUserId: ctx.landlordUserId,
        managedByUserId: ctx.landlordUserId,
      })
      await c.query('COMMIT')
    } finally { c.release() }
    terminalReadersCreateMock.mockResolvedValueOnce({ id: 'tmr_b' } as any)
    await registerReader({
      landlordId: ctx.landlordId, landlordConnectAccountId: 'acct',
      propertyId: p2, registrationCode: 'pair-b', nickname: 'B',
    })
    const filteredA = await listReaders(ctx.landlordId, ctx.propertyId)
    expect(filteredA.map(r => r.nickname)).toEqual(['A'])
    const all = await listReaders(ctx.landlordId)
    expect(all.map(r => r.nickname).sort()).toEqual(['A', 'B'])
  })

  it('archiveReader: happy → status=archived', async () => {
    const ctx = await seedLandlordProperty()
    terminalReadersCreateMock.mockResolvedValueOnce({ id: 'tmr_x' } as any)
    const row = await registerReader({
      landlordId: ctx.landlordId, landlordConnectAccountId: 'acct',
      propertyId: ctx.propertyId, registrationCode: 'pair', nickname: 'X',
    })
    const archived = await archiveReader(ctx.landlordId, row.id)
    expect(archived.status).toBe('archived')
  })

  it('archiveReader: already-archived or wrong landlord → 404', async () => {
    const ctx = await seedLandlordProperty()
    terminalReadersCreateMock.mockResolvedValueOnce({ id: 'tmr_x' } as any)
    const row = await registerReader({
      landlordId: ctx.landlordId, landlordConnectAccountId: 'acct',
      propertyId: ctx.propertyId, registrationCode: 'pair', nickname: 'X',
    })
    await archiveReader(ctx.landlordId, row.id)
    await expect(archiveReader(ctx.landlordId, row.id))
      .rejects.toThrow(/not found or already archived/)
  })

  it('createCardPresentPaymentIntent: amountCents validation (must be positive integer)', async () => {
    const args = {
      landlordConnectAccountId: 'acct', landlordId: 'l', propertyId: 'p',
      amountCents: 0,
    }
    await expect(createCardPresentPaymentIntent(args)).rejects.toThrow(/positive integer/)
    await expect(createCardPresentPaymentIntent({ ...args, amountCents: -100 }))
      .rejects.toThrow(/positive integer/)
    await expect(createCardPresentPaymentIntent({ ...args, amountCents: 1.5 }))
      .rejects.toThrow(/positive integer/)
  })

  it('createCardPresentPaymentIntent: shape (card_present + manual capture + metadata + stripeAccount)', async () => {
    paymentIntentsCreateMock.mockResolvedValueOnce({ id: 'pi_card_present' } as any)
    await createCardPresentPaymentIntent({
      landlordConnectAccountId: 'acct_l',
      landlordId: 'l_1', propertyId: 'p_1',
      amountCents: 2500,
      posDraftRef: 'draft_abc',
    })
    expect(paymentIntentsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2500, currency: 'usd',
        payment_method_types: ['card_present'],
        capture_method: 'manual',
        metadata: expect.objectContaining({
          gam_purpose: 'pos_terminal',
          gam_landlord_id: 'l_1',
          gam_property_id: 'p_1',
          gam_pos_draft_ref: 'draft_abc',
        }),
      }),
      { stripeAccount: 'acct_l' })
  })

  it('captureTerminalPaymentIntent: fires under stripeAccount', async () => {
    paymentIntentsCaptureMock.mockResolvedValueOnce({ id: 'pi_x', status: 'succeeded' } as any)
    await captureTerminalPaymentIntent({
      landlordConnectAccountId: 'acct_l', paymentIntentId: 'pi_x',
    })
    expect(paymentIntentsCaptureMock).toHaveBeenCalledWith(
      'pi_x', {}, { stripeAccount: 'acct_l' })
  })
})

// ═════════════════════════ depositInterest ═════════════════════════

describe('depositInterest', () => {
  describe('resolveRateForLandlord', () => {
    it('statutory catalog wins when both statutory + override present', async () => {
      const c = await db.connect()
      let landlordId = ''
      try {
        await c.query('BEGIN')
        const { landlordId: lid } = await seedLandlord(c)
        landlordId = lid
        await c.query('COMMIT')
      } finally { c.release() }
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation)
         VALUES ('NY', 2099, 1.5, 'Test § 1')`)
      await db.query(
        `INSERT INTO landlord_deposit_interest_rate_overrides
           (landlord_id, state_code, effective_year, annual_rate_pct)
         VALUES ($1, 'NY', 2099, 9.99)`, [landlordId])
      const r = await resolveRateForLandlord(landlordId, 'NY', 2099)
      expect(r).not.toBeNull()
      expect(r!.source).toBe('statutory')
      expect(r!.annual_rate_pct).toBe(1.5)
    })

    it('override fallback when no statutory row', async () => {
      const c = await db.connect()
      let landlordId = ''
      try {
        await c.query('BEGIN')
        const { landlordId: lid } = await seedLandlord(c)
        landlordId = lid
        await c.query('COMMIT')
      } finally { c.release() }
      await db.query(
        `INSERT INTO landlord_deposit_interest_rate_overrides
           (landlord_id, state_code, effective_year, annual_rate_pct)
         VALUES ($1, 'NJ', 2099, 2.5)`, [landlordId])
      const r = await resolveRateForLandlord(landlordId, 'NJ', 2099)
      expect(r!.source).toBe('landlord_override')
      expect(r!.annual_rate_pct).toBe(2.5)
    })

    // ── S603: unit-type-specific statutory rates ──────────────────────────
    // Arizona is the real case, straight from GAM's 50-state corpus: a mobile
    // home owes 5% (A.R.S. § 33-1431(B)) while an apartment (§ 33-1321) and an
    // RV long-term space (§ 33-2121) owe NOTHING. One state, three unit types,
    // two obligations. Resolving on state alone was wrong for two of the three.
    it('S603: unit-type row beats the blanket row, and non-matching types get the blanket', async () => {
      const c = await db.connect()
      let landlordId = ''
      try {
        await c.query('BEGIN')
        const { landlordId: lid } = await seedLandlord(c)
        landlordId = lid
        await c.query('COMMIT')
      } finally { c.release() }
      // A blanket 1% for the state, plus 5% specifically for mobile homes.
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation, unit_types)
         VALUES ('XA', 2099, 1.0, 'Blanket § 1', '{}')`)
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation, unit_types, act_key)
         VALUES ('XA', 2099, 5.0, 'Mobile § 2', ARRAY['mobile_home'], 'mobile_home_park')`)

      const mobile = await resolveRateForLandlord(landlordId, 'XA', 2099, 'mobile_home')
      expect(mobile!.annual_rate_pct).toBe(5.0)
      expect(mobile!.act_key).toBe('mobile_home_park')

      // An unlisted type falls through to the blanket rule, not to the 5%.
      const apt = await resolveRateForLandlord(landlordId, 'XA', 2099, 'apartment')
      expect(apt!.annual_rate_pct).toBe(1.0)
    })

    it('S603: a unit-type-only state owes NOTHING on other types (the Arizona shape)', async () => {
      const c = await db.connect()
      let landlordId = ''
      try {
        await c.query('BEGIN')
        const { landlordId: lid } = await seedLandlord(c)
        landlordId = lid
        await c.query('COMMIT')
      } finally { c.release() }
      // Arizona's actual shape: a mobile-home rule and NO blanket rule.
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation, unit_types, act_key)
         VALUES ('XB', 2099, 5.0, 'A.R.S. § 33-1431(B)', ARRAY['mobile_home'], 'mobile_home_park')`)

      expect((await resolveRateForLandlord(landlordId, 'XB', 2099, 'mobile_home'))!.annual_rate_pct).toBe(5.0)
      // An apartment or RV space in that state accrues nothing — the whole point.
      expect(await resolveRateForLandlord(landlordId, 'XB', 2099, 'apartment')).toBeNull()
      expect(await resolveRateForLandlord(landlordId, 'XB', 2099, 'rv_spot')).toBeNull()
      // No unit type supplied → only a blanket row could match; there is none.
      expect(await resolveRateForLandlord(landlordId, 'XB', 2099)).toBeNull()
    })

    it('neither source → null', async () => {
      const c = await db.connect()
      let landlordId = ''
      try {
        await c.query('BEGIN')
        const { landlordId: lid } = await seedLandlord(c)
        landlordId = lid
        await c.query('COMMIT')
      } finally { c.release() }
      const r = await resolveRateForLandlord(landlordId, 'WY', 2099)
      expect(r).toBeNull()
    })
  })

  describe('computeMonthlyAccrual', () => {
    const deposit = (overrides: any = {}) => ({
      id: 'd1', lease_id: 'l1', landlord_id: 'L1',
      collected_amount: '1000',
      state: 'NY',
      funded_at: '2099-01-01T00:00:00Z',
      disbursed_at: null,
      ...overrides,
    })

    it('not funded → null', async () => {
      const r = await computeMonthlyAccrual(
        deposit({ funded_at: null }), '2099-01-01')
      expect(r).toBeNull()
    })

    it('funded after this month → null', async () => {
      const r = await computeMonthlyAccrual(
        deposit({ funded_at: '2099-02-15T00:00:00Z' }), '2099-01-01')
      expect(r).toBeNull()
    })

    it('disbursed before this month → null', async () => {
      const r = await computeMonthlyAccrual(
        deposit({ disbursed_at: '2098-12-15T00:00:00Z' }), '2099-01-01')
      expect(r).toBeNull()
    })

    it('full month happy: principal * rate * (days/365)', async () => {
      const c = await db.connect()
      let landlordId = ''
      try {
        await c.query('BEGIN')
        const { landlordId: lid } = await seedLandlord(c)
        landlordId = lid
        await c.query('COMMIT')
      } finally { c.release() }
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation)
         VALUES ('NY', 2099, 1.5, 'Test')`)
      const r = await computeMonthlyAccrual(
        deposit({ landlord_id: landlordId }), '2099-01-01')
      expect(r).not.toBeNull()
      expect(r!.days_held).toBe(31)
      expect(r!.days_in_month).toBe(31)
      expect(r!.annual_rate_pct).toBe(1.5)
      // 1000 * 0.015 * (31/365) = 1.27397... → rounded 4dp: 1.274
      expect(r!.interest_amount).toBeCloseTo(1.274, 3)
    })

    it('partial first month (funded mid-month): days = monthEnd - funded + 1', async () => {
      const c = await db.connect()
      let landlordId = ''
      try {
        await c.query('BEGIN')
        const { landlordId: lid } = await seedLandlord(c)
        landlordId = lid
        await c.query('COMMIT')
      } finally { c.release() }
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation)
         VALUES ('NY', 2099, 1.5, 'Test')`)
      const r = await computeMonthlyAccrual(
        deposit({
          landlord_id: landlordId,
          funded_at: '2099-01-15T00:00:00Z',
        }), '2099-01-01')
      // Jan 15 → Jan 31 = 17 days inclusive
      expect(r!.days_held).toBe(17)
    })

    it('principal 0 → null', async () => {
      const c = await db.connect()
      let landlordId = ''
      try {
        await c.query('BEGIN')
        const { landlordId: lid } = await seedLandlord(c)
        landlordId = lid
        await c.query('COMMIT')
      } finally { c.release() }
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation)
         VALUES ('NY', 2099, 1.5, 'Test')`)
      const r = await computeMonthlyAccrual(
        deposit({ landlord_id: landlordId, collected_amount: '0' }), '2099-01-01')
      expect(r).toBeNull()
    })
  })

  describe('runMonthlyAccrual + getAccrualHistory', () => {
    interface AccrualCtx {
      depositId: string
      leaseId: string
      landlordId: string
    }
    async function seedAccrualCtx(
      opts: { state?: string; collected?: number; unitType?: string } = {},
    ): Promise<AccrualCtx> {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const { userId, landlordId } = await seedLandlord(c)
        const propertyId = await seedProperty(c, {
          landlordId, ownerUserId: userId, managedByUserId: userId,
        })
        if (opts.state) {
          await c.query(`UPDATE properties SET state=$2 WHERE id=$1`,
            [propertyId, opts.state])
        }
        const unitId = await seedUnit(c, { propertyId, landlordId, unitType: opts.unitType })
        const tenantId = await seedTenant(c)
        const leaseId = await seedLease(c, { unitId, landlordId })
        const depositId = await seedSecurityDeposit(c, {
          unitId, leaseId, tenantId,
          totalAmount: opts.collected ?? 1000,
          collectedAmount: opts.collected ?? 1000,
          heldBy: 'gam_escrow', status: 'funded',
        })
        await c.query('COMMIT')
        return { depositId, leaseId, landlordId }
      } catch (e) { await c.query('ROLLBACK'); throw e }
      finally { c.release() }
    }

    it('happy: accrues + advances security_deposits.interest_accrued; idempotent re-run is noop', async () => {
      const ctx = await seedAccrualCtx({ state: 'NY' })
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation)
         VALUES ('NY', 2099, 1.5, 'Test')`)
      const r1 = await runMonthlyAccrual('2099-01-01')
      expect(r1.accrued_count).toBe(1)
      expect(r1.skipped_count).toBe(0)
      const { rows: [d] } = await db.query<any>(
        `SELECT interest_accrued FROM security_deposits WHERE id=$1`, [ctx.depositId])
      expect(Number(d.interest_accrued)).toBeGreaterThan(0)
      // Re-run same month → idempotent: count flips to skipped, no double-credit
      const r2 = await runMonthlyAccrual('2099-01-01')
      expect(r2.accrued_count).toBe(0)
      expect(r2.skipped_count).toBe(1)
    })

    // S604 REVERSAL (Nic): a state with no statutory rate used to be SKIPPED
    // entirely. That is the majority of deposits and the bucket where GAM keeps
    // 100% of the yield, so skipping made GAM's biggest earner invisible. It
    // now accrues with owed = 0.
    it('state with no rate still ACCRUES, owing nothing', async () => {
      await seedAccrualCtx({ state: 'WY' })  // no rate seeded for WY/2099
      const r = await runMonthlyAccrual('2099-01-01')
      expect(r.accrued_count).toBe(1)
      expect(r.skipped_count).toBe(0)
      expect(r.total_interest).toBe(0)
    })

    it('skips a deposit that was not held during the month', async () => {
      // The remaining real skip case: nothing to accrue because the deposit
      // was disbursed before the accrual month began.
      const ctx = await seedAccrualCtx({ state: 'WY' })
      await db.query(
        `UPDATE security_deposits SET disbursed_at = '2098-06-01' WHERE id = $1`,
        [ctx.depositId])
      const r = await runMonthlyAccrual('2099-01-01')
      expect(r.accrued_count).toBe(0)
      expect(r.skipped_count).toBe(1)
    })

    // S604: the S603 catalog was unit-type aware but the JOB was not — it
    // resolved on state alone, so the Arizona mobile-home row (the only reason
    // the catalog gained a unit-type dimension) could never match and Oak Park
    // would have accrued $0 forever. These two tests run the REAL Arizona
    // shape end-to-end through the job, not just the resolver.
    it('S604: mobile home in a unit-type-only state ACCRUES through the job', async () => {
      const ctx = await seedAccrualCtx({ state: 'XC', unitType: 'mobile_home', collected: 1000 })
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation, unit_types, act_key)
         VALUES ('XC', 2099, 5.0, 'A.R.S. § 33-1431(B)', ARRAY['mobile_home'], 'mobile_home_park')`)

      const r = await runMonthlyAccrual('2099-01-01')
      expect(r.accrued_count).toBe(1)
      // 1000 * 5% * 31/365 = 4.2466
      expect(r.total_interest).toBeCloseTo(4.2466, 3)

      // The row records WHY it accrued, not just how much.
      const { rows: [a] } = await db.query<any>(
        `SELECT unit_type, act_key, rate_source, annual_rate_pct
           FROM security_deposit_interest_accruals WHERE security_deposit_id=$1`,
        [ctx.depositId])
      expect(a.unit_type).toBe('mobile_home')
      expect(a.act_key).toBe('mobile_home_park')
      expect(a.rate_source).toBe('statutory')
      expect(Number(a.annual_rate_pct)).toBe(5)
    })

    it('S604: an APARTMENT in that same state is OWED nothing', async () => {
      const ctx = await seedAccrualCtx({ state: 'XD', unitType: 'apartment', collected: 1000 })
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation, unit_types, act_key)
         VALUES ('XD', 2099, 5.0, 'A.R.S. § 33-1431(B)', ARRAY['mobile_home'], 'mobile_home_park')`)

      // The unit-type rule must not reach a unit type it does not govern:
      // § 33-1431(B) is the mobile-home statute; an apartment falls under
      // § 33-1321 and is owed nothing.
      const r = await runMonthlyAccrual('2099-01-01')
      expect(r.total_interest).toBe(0)
      // It still ACCRUES a row — GAM earns on the principal either way (S604
      // core model); only the OWED side is zero.
      expect(r.accrued_count).toBe(1)
      const { rows: [a] } = await db.query<any>(
        `SELECT interest_amount, annual_rate_pct, rate_source
           FROM security_deposit_interest_accruals WHERE security_deposit_id=$1`,
        [ctx.depositId])
      expect(Number(a.interest_amount)).toBe(0)
      expect(Number(a.annual_rate_pct)).toBe(0)
      expect(a.rate_source).toBeNull()
      // Nothing is credited to the tenant.
      const { rows: [d] } = await db.query<any>(
        `SELECT interest_accrued FROM security_deposits WHERE id=$1`, [ctx.depositId])
      expect(Number(d.interest_accrued)).toBe(0)
    })

    // S604 CORE MODEL (Nic): "We earn interest on every held deposit any way we
    // can. We only pay interest on units or states that require it and only the
    // amount required. Anything above that is ours to keep."
    describe('S604 earned vs owed', () => {
      const seedMarket = (pct: number) => db.query(
        `INSERT INTO deposit_pool_yield_rates (effective_month, annual_rate_pct, source_label)
         VALUES ('2099-01-01', $1, '4-week T-bill')
         ON CONFLICT (effective_month) DO UPDATE SET annual_rate_pct = EXCLUDED.annual_rate_pct`,
        [pct])

      it('no statute → still accrues, owed 0, GAM keeps the whole yield', async () => {
        // The majority case, and pre-S604 it produced NO ROW at all — GAM's
        // largest earning bucket was invisible.
        const ctx = await seedAccrualCtx({ state: 'WY', collected: 1000 })
        await seedMarket(4.0)

        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.accrued_count).toBe(1)
        expect(r.total_interest).toBe(0)                  // owed nothing
        expect(r.total_earned).toBeCloseTo(3.3973, 3)     // 1000 * 4% * 31/365
        expect(r.total_spread).toBeCloseTo(3.3973, 3)     // all of it is GAM's

        const { rows: [a] } = await db.query<any>(
          `SELECT interest_amount, earned_amount, spread_amount, rate_source
             FROM security_deposit_interest_accruals WHERE security_deposit_id=$1`,
          [ctx.depositId])
        expect(Number(a.interest_amount)).toBe(0)
        expect(a.rate_source).toBeNull()
        // The tenant is credited nothing; interest_accrued stays 0.
        const { rows: [d] } = await db.query<any>(
          `SELECT interest_accrued FROM security_deposits WHERE id=$1`, [ctx.depositId])
        expect(Number(d.interest_accrued)).toBe(0)
      })

      it('statute below market → GAM keeps only the excess', async () => {
        await seedAccrualCtx({ state: 'XE', unitType: 'mobile_home', collected: 1000 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation, unit_types, act_key)
           VALUES ('XE', 2099, 1.0, 'Some § 1', ARRAY['mobile_home'], 'mobile_home_park')`)
        await seedMarket(4.0)

        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_interest).toBeCloseTo(0.8493, 3)  // owed at 1%
        expect(r.total_earned).toBeCloseTo(3.3973, 3)    // earned at 4%
        expect(r.total_spread).toBeCloseTo(2.5479, 3)    // the 3% difference
      })

      it('statute ABOVE market → spread is NEGATIVE, not clamped', async () => {
        // Arizona's real shape: a 5% mobile-home statute against a ~4% T-bill.
        // GAM funds the shortfall, and that is exactly what must be visible.
        await seedAccrualCtx({ state: 'XF', unitType: 'mobile_home', collected: 1000 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation, unit_types, act_key)
           VALUES ('XF', 2099, 5.0, 'A.R.S. § 33-1431(B)', ARRAY['mobile_home'], 'mobile_home_park')`)
        await seedMarket(4.0)

        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_spread).toBeLessThan(0)
        expect(r.total_spread).toBeCloseTo(-0.8493, 3)   // 1% shortfall
      })

      it('tenant-facing history NEVER exposes earned / market rate / spread', async () => {
        // GAM's margin on the tenant's own money. Same boundary S603 drew when
        // calcNetPerUnit leaked to landlords.
        const ctx = await seedAccrualCtx({ state: 'WY', collected: 1000 })
        await seedMarket(4.0)
        await runMonthlyAccrual('2099-01-01')

        const history = await getAccrualHistory(ctx.depositId)
        expect(history).toHaveLength(1)
        for (const key of ['earned_amount', 'market_rate_pct', 'spread_amount']) {
          expect(history[0]).not.toHaveProperty(key)
        }
      })

      // S604: not every statute is a flat rate. Encoding MA's lesser-of rule as
      // a flat 5% was costing more than the harshest statute in the catalog.
      it('lesser_of_actual (MA shape): owed is capped at what was EARNED', async () => {
        const ctx = await seedAccrualCtx({ state: 'XH', collected: 1000 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis)
           VALUES ('XH', 2099, 5.0, 'G.L. c. 186 § 15B', '{}', 'lesser_of_actual')`)
        await seedMarket(3.0)   // statute says 5%, bank paid 3%

        const r = await runMonthlyAccrual('2099-01-01')
        // Pays 3%, not 5% — "or such lesser amount as has been received".
        expect(r.total_interest).toBeCloseTo(2.5479, 3)
        expect(r.total_earned).toBeCloseTo(2.5479, 3)
        expect(r.total_spread).toBeCloseTo(0, 4)   // exactly break-even, never negative
        const { rows: [a] } = await db.query<any>(
          `SELECT rate_basis, annual_rate_pct FROM security_deposit_interest_accruals
            WHERE security_deposit_id=$1`, [ctx.depositId])
        // Statutory headline preserved; basis explains why the amount differs.
        expect(a.rate_basis).toBe('lesser_of_actual')
        expect(Number(a.annual_rate_pct)).toBe(5)
      })

      it('lesser_of_actual: when market BEATS the statute, tenant gets the statute', async () => {
        await seedAccrualCtx({ state: 'XI', collected: 1000 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis)
           VALUES ('XI', 2099, 3.0, 'G.L. c. 186 § 15B', '{}', 'lesser_of_actual')`)
        await seedMarket(5.0)

        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_interest).toBeCloseTo(2.5479, 3)   // the 3% statute
        expect(r.total_earned).toBeCloseTo(4.2466, 3)     // earned 5%
        expect(r.total_spread).toBeGreaterThan(0)         // GAM keeps the excess
      })

      it('share_of_actual (FL shape): tenant gets 75% of earnings, GAM keeps 25%', async () => {
        await seedAccrualCtx({ state: 'XJ', collected: 1000 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis, actual_share_pct)
           VALUES ('XJ', 2099, 5.0, 'Fla. Stat. § 83.49', '{}', 'share_of_actual', 75.0)`)
        await seedMarket(4.0)

        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_earned).toBeCloseTo(3.3973, 3)
        expect(r.total_interest).toBeCloseTo(3.3973 * 0.75, 3)
        // Structurally positive: 25% of whatever is earned, at any rate level.
        expect(r.total_spread).toBeCloseTo(3.3973 * 0.25, 3)
        expect(r.total_spread).toBeGreaterThan(0)
      })

      it('actual_earned (ND/NH shape): whole yield passes through, spread 0', async () => {
        await seedAccrualCtx({ state: 'XK', collected: 1000 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis)
           VALUES ('XK', 2099, 0, 'N.D.C.C. § 47-16-07.1', '{}', 'actual_earned')`)
        await seedMarket(4.0)
        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_earned).toBeCloseTo(3.3973, 3)
        expect(r.total_interest).toBeCloseTo(3.3973, 3)
        expect(r.total_spread).toBeCloseTo(0, 4)
      })

      it('actual_minus_admin (NY/PA shape): GAM keeps the 1% administrative retention', async () => {
        await seedAccrualCtx({ state: 'XL', collected: 1000 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis, admin_retention_pct)
           VALUES ('XL', 2099, 0, 'N.Y. Gen. Oblig. § 7-103', '{}', 'actual_minus_admin', 1.0)`)
        await seedMarket(4.0)
        const r = await runMonthlyAccrual('2099-01-01')
        // earned 4% of 1000 for 31 days; landlord retains 1%/yr of principal.
        const earned = 1000 * 0.04 * 31 / 365
        const admin  = 1000 * 0.01 * 31 / 365
        expect(r.total_earned).toBeCloseTo(earned, 3)
        expect(r.total_interest).toBeCloseTo(earned - admin, 3)
        expect(r.total_spread).toBeCloseTo(admin, 3)
      })

      it("'none' is a VERIFIED negative — owes zero even with a rate row present", async () => {
        // Distinct from "no row": records that someone read the statute and it
        // owes nothing (CA/IA/KS/NV mobile home, VA).
        await seedAccrualCtx({ state: 'XM', unitType: 'mobile_home', collected: 1000 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis)
           VALUES ('XM', 2099, 0, 'Cal. Civ. Code § 798.39(f)', ARRAY['mobile_home'], 'none')`)
        await seedMarket(4.0)
        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_interest).toBe(0)
        expect(r.total_spread).toBeCloseTo(3.3973, 3)   // all GAM's
      })

    it('TENURE GATE (IA 5yr / NH 1yr / PA 2yr): owes nothing before the gate', async () => {
        const ctx = await seedAccrualCtx({ state: 'XN', collected: 1000 })
        // Funded weeks before the accrual month → ~0 months held vs a 12-month
        // gate. (funded_at falls back to security_deposits.created_at.)
        await db.query(
          `UPDATE security_deposits SET created_at = '2098-12-20' WHERE id = $1`,
          [ctx.depositId])
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis, min_tenure_months)
           VALUES ('XN', 2099, 0, 'N.H. RSA 540-A:6', '{}', 'actual_earned', 12)`)
        await seedMarket(4.0)
        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_interest).toBe(0)
        expect(r.total_spread).toBeCloseTo(3.3973, 3)   // GAM keeps it pre-gate
      })

      it('TENURE GATE: the obligation switches on once the gate is passed', async () => {
        const ctx = await seedAccrualCtx({ state: 'XP', collected: 1000 })
        // Held two years before the accrual month — past a 12-month gate.
        await db.query(
          `UPDATE security_deposits SET created_at = '2097-01-01' WHERE id = $1`,
          [ctx.depositId])
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis, min_tenure_months)
           VALUES ('XP', 2099, 0, 'N.H. RSA 540-A:6', '{}', 'actual_earned', 12)`)
        await seedMarket(4.0)
        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_interest).toBeCloseTo(3.3973, 3)
        expect(r.total_spread).toBeCloseTo(0, 4)
      })

      it('SIZE GATE (IL 25+ homes): a small park owes nothing', async () => {
        // seedAccrualCtx creates ONE unit, well under a 25-unit threshold.
        await seedAccrualCtx({ state: 'XO', unitType: 'mobile_home', collected: 1000 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis, min_property_units)
           VALUES ('XO', 2099, 3.0, '765 ILCS 745/18', ARRAY['mobile_home'], 'fixed', 25)`)
        await seedMarket(4.0)
        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_interest).toBe(0)
        expect(r.total_spread).toBeCloseTo(3.3973, 3)
      })

      // S604: two states condition the obligation on deposit SIZE, in opposite
      // ways. Collapsing them to one flat rate overpays Ohio ~5x and underpays
      // New Mexico.
      it('excess_only (OH § 5321.16): interest runs on the EXCESS only', async () => {
        // seedAccrualCtx seeds rent_amount = 1000. Deposit 1500 → threshold is
        // max($50, 1 month rent = 1000) = 1000 → only 500 earns.
        await seedAccrualCtx({ state: 'XQ', collected: 1500 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis, threshold_rule, threshold_amount,
              threshold_months_rent)
           VALUES ('XQ', 2099, 5.0, 'Ohio Rev. Code § 5321.16', '{}', 'fixed',
                   'excess_only', 50.00, 1.00)`)
        await seedMarket(4.0)

        const r = await runMonthlyAccrual('2099-01-01')
        // owed: 500 * 5% * 31/365 = 2.1233   (NOT 1500 * 5% = 6.37)
        expect(r.total_interest).toBeCloseTo(2.1233, 3)
        // earned is on the WHOLE 1500 — GAM holds every dollar regardless.
        expect(r.total_earned).toBeCloseTo(1500 * 0.04 * 31 / 365, 3)
      })

      it('excess_only: a deposit at or below the threshold owes NOTHING', async () => {
        await seedAccrualCtx({ state: 'XR', collected: 900 })   // < 1 month rent
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis, threshold_rule, threshold_amount,
              threshold_months_rent)
           VALUES ('XR', 2099, 5.0, 'Ohio Rev. Code § 5321.16', '{}', 'fixed',
                   'excess_only', 50.00, 1.00)`)
        await seedMarket(4.0)
        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_interest).toBe(0)
        expect(r.total_spread).toBeGreaterThan(0)   // all GAM's
      })

      it('trigger (NM § 47-8-18): above the threshold the WHOLE deposit earns', async () => {
        await seedAccrualCtx({ state: 'XS', collected: 1500 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation,
              unit_types, rate_basis, threshold_rule, threshold_months_rent)
           VALUES ('XS', 2099, 2.0, 'N.M. Stat. § 47-8-18', '{}', 'index_linked',
                   'trigger', 1.00)`)
        await seedMarket(4.0)

        const r = await runMonthlyAccrual('2099-01-01')
        // Whole 1500 earns at 2% — not just the 500 above one month's rent.
        expect(r.total_interest).toBeCloseTo(1500 * 0.02 * 31 / 365, 3)
      })

      it('no market rate on file → earned/spread stay null, owed still accrues', async () => {
        await seedAccrualCtx({ state: 'XG', unitType: 'mobile_home', collected: 1000 })
        await db.query(
          `INSERT INTO state_deposit_interest_rates
             (state_code, effective_year, annual_rate_pct, statute_citation, unit_types, act_key)
           VALUES ('XG', 2099, 5.0, 'Some § 1', ARRAY['mobile_home'], 'mobile_home_park')`)
        // deliberately no deposit_pool_yield_rates row

        const r = await runMonthlyAccrual('2099-01-01')
        expect(r.total_interest).toBeGreaterThan(0)
        expect(r.total_earned).toBe(0)
        // Null, not zero — "we don't know yet" must not read as "earned nothing".
        const { rows: [a] } = await db.query<any>(
          `SELECT earned_amount, spread_amount FROM security_deposit_interest_accruals LIMIT 1`)
        expect(a.earned_amount).toBeNull()
        expect(a.spread_amount).toBeNull()
      })
    })

    it('getAccrualHistory: returns rows ordered by accrual_month ASC', async () => {
      const ctx = await seedAccrualCtx({ state: 'NY' })
      await db.query(
        `INSERT INTO state_deposit_interest_rates
           (state_code, effective_year, annual_rate_pct, statute_citation)
         VALUES ('NY', 2099, 1.5, 'Test')`)
      await runMonthlyAccrual('2099-01-01')
      await runMonthlyAccrual('2099-02-01')
      const history = await getAccrualHistory(ctx.depositId)
      expect(history).toHaveLength(2)
      expect(history[0].accrual_month < history[1].accrual_month).toBe(true)
    })
  })
})

// ═════════════════════════ depositPortability ═════════════════════════

describe('depositPortability', () => {
  interface PortCtx {
    landlordUserId: string
    landlordId: string
    unitId: string
    tenantId: string
    tenantUserId: string
    currentLeaseId: string
    depositId: string
  }

  async function seedPortCtx(opts: { withTargetLease?: boolean; heldBy?: 'gam_escrow' | 'landlord' } = {}): Promise<PortCtx> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const currentLeaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId: currentLeaseId, tenantId, role: 'primary' })
      const depositId = await seedSecurityDeposit(c, {
        unitId, leaseId: currentLeaseId, tenantId,
        totalAmount: 2000, heldBy: opts.heldBy ?? 'gam_escrow', status: 'funded',
      })
      if (opts.withTargetLease) {
        // Seed a second property + unit + lease for the same tenant.
        const propertyId2 = await seedProperty(c, {
          landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
        })
        const unitId2 = await seedUnit(c, { propertyId: propertyId2, landlordId })
        const targetLeaseId = await seedLease(c, {
          unitId: unitId2, landlordId, status: 'pending',
        })
        await seedLeaseTenant(c, { leaseId: targetLeaseId, tenantId, role: 'primary' })
        await c.query('COMMIT')
        const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
          `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
        return { landlordUserId, landlordId, unitId, tenantId, tenantUserId: user_id, currentLeaseId, depositId }
      }
      await c.query('COMMIT')
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      return { landlordUserId, landlordId, unitId, tenantId, tenantUserId: user_id, currentLeaseId, depositId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('detectPortabilityEligible: no other lease → eligible=false', async () => {
    const ctx = await seedPortCtx()
    const e = await detectPortabilityEligible({ leaseId: ctx.currentLeaseId })
    expect(e.eligible).toBe(false)
    expect(e.reason).toMatch(/no other pending\/active lease/)
    expect(e.deposit_id).toBe(ctx.depositId)
  })

  it('detectPortabilityEligible: has target lease → eligible=true', async () => {
    const ctx = await seedPortCtx({ withTargetLease: true })
    const e = await detectPortabilityEligible({ leaseId: ctx.currentLeaseId })
    expect(e.eligible).toBe(true)
    expect(e.target_lease_id).not.toBeNull()
    expect(e.deposit_id).toBe(ctx.depositId)
    expect(e.deposit_amount).toBe(2000)
    expect(e.held_by).toBe('gam_escrow')
  })

  it('authorizeDepositPortability: happy → status=authorized + signature stored', async () => {
    const ctx = await seedPortCtx({ withTargetLease: true })
    const eligibility = await detectPortabilityEligible({ leaseId: ctx.currentLeaseId })
    const targetId = eligibility.target_lease_id!
    const res = await authorizeDepositPortability({
      tenantId: ctx.tenantId, depositId: ctx.depositId,
      targetLeaseId: targetId, signature: 'Tenant Signature', ip: '1.2.3.4',
    })
    expect(res.status).toBe('authorized')
    const { rows: [d] } = await db.query<any>(
      `SELECT portability_status, portability_target_lease_id,
              portability_authorized_signature, portability_authorized_ip
         FROM security_deposits WHERE id=$1`, [ctx.depositId])
    expect(d.portability_status).toBe('authorized')
    expect(d.portability_target_lease_id).toBe(targetId)
    expect(d.portability_authorized_signature).toBe('Tenant Signature')
    expect(d.portability_authorized_ip).toBe('1.2.3.4')
  })

  it('authorizeDepositPortability: wrong tenant → 403', async () => {
    const ctx = await seedPortCtx({ withTargetLease: true })
    const e = await detectPortabilityEligible({ leaseId: ctx.currentLeaseId })
    await expect(authorizeDepositPortability({
      tenantId: '00000000-0000-0000-0000-000000000000',
      depositId: ctx.depositId, targetLeaseId: e.target_lease_id!,
      signature: 'Stranger Sig',
    })).rejects.toThrow(/Not your deposit/)
  })

  it('authorizeDepositPortability: short signature → 400', async () => {
    const ctx = await seedPortCtx({ withTargetLease: true })
    const e = await detectPortabilityEligible({ leaseId: ctx.currentLeaseId })
    await expect(authorizeDepositPortability({
      tenantId: ctx.tenantId, depositId: ctx.depositId,
      targetLeaseId: e.target_lease_id!, signature: 'X',
    })).rejects.toThrow(/Signature required/)
  })

  it('declineDepositPortability: clears authorization', async () => {
    const ctx = await seedPortCtx({ withTargetLease: true })
    const e = await detectPortabilityEligible({ leaseId: ctx.currentLeaseId })
    await authorizeDepositPortability({
      tenantId: ctx.tenantId, depositId: ctx.depositId,
      targetLeaseId: e.target_lease_id!, signature: 'X-signed',
    })
    await declineDepositPortability({
      tenantId: ctx.tenantId, depositId: ctx.depositId,
    })
    const { rows: [d] } = await db.query<any>(
      `SELECT portability_status, portability_target_lease_id,
              portability_authorized_signature
         FROM security_deposits WHERE id=$1`, [ctx.depositId])
    expect(d.portability_status).toBe('declined')
    expect(d.portability_target_lease_id).toBeNull()
    expect(d.portability_authorized_signature).toBeNull()
  })

  it('executeDepositPortability: gam_escrow → status=carried_forward + lease/unit repointed; no admin alert', async () => {
    const ctx = await seedPortCtx({ withTargetLease: true, heldBy: 'gam_escrow' })
    const e = await detectPortabilityEligible({ leaseId: ctx.currentLeaseId })
    await authorizeDepositPortability({
      tenantId: ctx.tenantId, depositId: ctx.depositId,
      targetLeaseId: e.target_lease_id!, signature: 'X-signed',
    })
    const res = await executeDepositPortability({ depositId: ctx.depositId })
    expect(res.status).toBe('carried_forward')
    expect(res.new_lease_id).toBe(e.target_lease_id)
    const { rows: [d] } = await db.query<any>(
      `SELECT lease_id, held_by, portability_status FROM security_deposits WHERE id=$1`,
      [ctx.depositId])
    expect(d.lease_id).toBe(e.target_lease_id)
    expect(d.held_by).toBe('gam_escrow')
    expect(d.portability_status).toBe('carried_forward')
    expect(adminNotifyMock).not.toHaveBeenCalled()
  })

  it('executeDepositPortability: landlord-held → status=pending_transfer + admin alert fired', async () => {
    const ctx = await seedPortCtx({ withTargetLease: true, heldBy: 'landlord' })
    const e = await detectPortabilityEligible({ leaseId: ctx.currentLeaseId })
    await authorizeDepositPortability({
      tenantId: ctx.tenantId, depositId: ctx.depositId,
      targetLeaseId: e.target_lease_id!, signature: 'X-signed',
    })
    const res = await executeDepositPortability({ depositId: ctx.depositId })
    expect(res.status).toBe('pending_transfer')
    const { rows: [d] } = await db.query<any>(
      `SELECT held_by, portability_status FROM security_deposits WHERE id=$1`,
      [ctx.depositId])
    expect(d.held_by).toBe('gam_escrow')  // flipped to escrow even though physical funds elsewhere
    expect(d.portability_status).toBe('pending_transfer')
    expect(adminNotifyMock).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warn',
      category: 'deposit_portability_pending_transfer',
    }))
  })

  it('executeDepositPortability: not in authorized state → 409', async () => {
    const ctx = await seedPortCtx({ withTargetLease: true })
    await expect(executeDepositPortability({ depositId: ctx.depositId }))
      .rejects.toThrow(/not ready to execute/)
  })
})
