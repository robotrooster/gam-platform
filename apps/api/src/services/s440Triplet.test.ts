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
    async function seedAccrualCtx(opts: { state?: string; collected?: number } = {}): Promise<AccrualCtx> {
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
        const unitId = await seedUnit(c, { propertyId, landlordId })
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

    it('skips deposit when state has no rate registered', async () => {
      await seedAccrualCtx({ state: 'WY' })  // no rate seeded for WY/2099
      const r = await runMonthlyAccrual('2099-01-01')
      expect(r.accrued_count).toBe(0)
      expect(r.skipped_count).toBe(1)
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
