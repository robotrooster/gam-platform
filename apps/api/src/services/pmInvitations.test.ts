/**
 * S437 services-audit slice 14 — closes the S428 deferral on pm.ts.
 *
 * Five invitation-lifecycle functions:
 *   - sendPropertyInvitation
 *   - acceptPropertyInvitation
 *   - rejectPropertyInvitation
 *   - revokePropertyInvitation
 *   - expireStaleInvitations
 *
 * All exercised against real DB rows (no Stripe). The S428 paired slice
 * already covers `getPmCompanyForProperty` — this file appends the
 * lifecycle half.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUserBankAccount,
  seedPmCompany, seedPmFeePlan,
} from '../test/dbHelpers'
import {
  sendPropertyInvitation, acceptPropertyInvitation,
  rejectPropertyInvitation, revokePropertyInvitation,
  expireStaleInvitations,
} from './pm'

beforeEach(async () => {
  await cleanupAllSchema()
})

// ─── helpers ─────────────────────────────────────────────────

interface InviteCtx {
  landlordUserId: string
  landlordId: string
  propertyId: string
  pmCompanyId: string
  feePlanId: string
}

async function seedInviteCtx(opts: { pmStatus?: 'active' | 'inactive', feePlanStatus?: 'active' | 'inactive' } = {}): Promise<InviteCtx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const bankId = await seedUserBankAccount(c, { userId: landlordUserId })
    const pmCompanyId = await seedPmCompany(c, { bankAccountId: bankId })
    if (opts.pmStatus && opts.pmStatus !== 'active') {
      await c.query(`UPDATE pm_companies SET status=$2 WHERE id=$1`,
        [pmCompanyId, opts.pmStatus])
    }
    const feePlanId = await seedPmFeePlan(c, {
      pmCompanyId, feeType: 'percent_of_rent', percent: 8,
    })
    if (opts.feePlanStatus && opts.feePlanStatus !== 'active') {
      await c.query(`UPDATE pm_fee_plans SET status=$2 WHERE id=$1`,
        [feePlanId, opts.feePlanStatus])
    }
    await c.query('COMMIT')
    return { landlordUserId, landlordId, propertyId, pmCompanyId, feePlanId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function sendBasicInvite(ctx: InviteCtx, opts: {
  direction?: 'owner_to_pm' | 'pm_to_owner'
  scope?: 'manage' | 'view'
  feePlanId?: string | null
} = {}): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const res = await sendPropertyInvitation({
      client,
      direction: opts.direction ?? 'owner_to_pm',
      pmCompanyId: ctx.pmCompanyId,
      propertyId:  ctx.propertyId,
      landlordId:  ctx.landlordId,
      invitedEmail:'pm-invitee@example.com',
      invitedByUserId: ctx.landlordUserId,
      proposedScope: opts.scope ?? 'manage',
      proposedFeePlanId: opts.feePlanId === null ? null : (opts.feePlanId ?? ctx.feePlanId),
    })
    await client.query('COMMIT')
    return res
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

// ─── sendPropertyInvitation ──────────────────────────────────

describe('sendPropertyInvitation — guard rails', () => {
  it('property not found → 404', async () => {
    const ctx = await seedInviteCtx()
    const client = await getClient()
    try {
      await expect(sendPropertyInvitation({
        client, direction: 'owner_to_pm',
        pmCompanyId: ctx.pmCompanyId,
        propertyId: '00000000-0000-0000-0000-000000000000',
        landlordId: ctx.landlordId,
        invitedEmail: 'x@example.com', invitedByUserId: ctx.landlordUserId,
        proposedScope: 'manage', proposedFeePlanId: ctx.feePlanId,
      })).rejects.toThrow(/Property .* not found/)
    } finally { client.release() }
  })

  it('property landlord mismatch → 400', async () => {
    const ctx = await seedInviteCtx()
    // Make a SECOND landlord and try to invite using their id for ctx's property.
    const c = await db.connect()
    let otherLandlordId = ''
    try {
      await c.query('BEGIN')
      const { landlordId } = await seedLandlord(c)
      otherLandlordId = landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    const client = await getClient()
    try {
      await expect(sendPropertyInvitation({
        client, direction: 'owner_to_pm',
        pmCompanyId: ctx.pmCompanyId,
        propertyId: ctx.propertyId,
        landlordId: otherLandlordId,
        invitedEmail: 'x@example.com', invitedByUserId: ctx.landlordUserId,
        proposedScope: 'manage', proposedFeePlanId: ctx.feePlanId,
      })).rejects.toThrow(/does not belong to landlord/)
    } finally { client.release() }
  })

  it('pm_company not found → 404', async () => {
    const ctx = await seedInviteCtx()
    const client = await getClient()
    try {
      await expect(sendPropertyInvitation({
        client, direction: 'owner_to_pm',
        pmCompanyId: '00000000-0000-0000-0000-000000000000',
        propertyId: ctx.propertyId, landlordId: ctx.landlordId,
        invitedEmail: 'x@example.com', invitedByUserId: ctx.landlordUserId,
        proposedScope: 'manage', proposedFeePlanId: null,
      })).rejects.toThrow(/PM company .* not found/)
    } finally { client.release() }
  })

  it('pm_company inactive → 400', async () => {
    const ctx = await seedInviteCtx({ pmStatus: 'inactive' })
    await expect(sendBasicInvite(ctx, { feePlanId: null }))
      .rejects.toThrow(/not active/)
  })

  it('proposedFeePlanId not found → 404', async () => {
    const ctx = await seedInviteCtx()
    await expect(sendBasicInvite(ctx, {
      feePlanId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toThrow(/Fee plan .* not found/)
  })

  it('fee plan does not belong to the PM company → 400', async () => {
    const ctx = await seedInviteCtx()
    // Create a second PM + fee plan; invite uses ctx.pmCompanyId but the
    // other PM's fee plan id.
    const c = await db.connect()
    let otherFeePlanId = ''
    try {
      await c.query('BEGIN')
      const { userId } = await seedLandlord(c)
      const bankId = await seedUserBankAccount(c, { userId })
      const otherPmId = await seedPmCompany(c, { bankAccountId: bankId })
      otherFeePlanId = await seedPmFeePlan(c, {
        pmCompanyId: otherPmId, feeType: 'flat_monthly', flatAmount: 100,
      })
      await c.query('COMMIT')
    } finally { c.release() }
    await expect(sendBasicInvite(ctx, { feePlanId: otherFeePlanId }))
      .rejects.toThrow(/does not belong to PM company/)
  })

  it('fee plan inactive → 400', async () => {
    const ctx = await seedInviteCtx({ feePlanStatus: 'inactive' })
    await expect(sendBasicInvite(ctx))
      .rejects.toThrow(/Fee plan .* is not active/)
  })

  it('existing pending invite for same (pm_company, property) → 409', async () => {
    const ctx = await seedInviteCtx()
    await sendBasicInvite(ctx)
    await expect(sendBasicInvite(ctx))
      .rejects.toThrow(/already exists for this PM/)
  })
})

describe('sendPropertyInvitation — happy', () => {
  it('returns invitationId + token + expiresAt (~72h out)', async () => {
    const ctx = await seedInviteCtx()
    const before = Date.now()
    const res = await sendBasicInvite(ctx)
    const after = Date.now()
    expect(res.invitationId).toBeTruthy()
    expect(res.token).toBeTruthy()
    expect(res.expiresAt).toBeInstanceOf(Date)
    const elapsedToExpiry = res.expiresAt.getTime() - before
    expect(elapsedToExpiry).toBeGreaterThanOrEqual(72 * 3600_000 - 1000)
    expect(res.expiresAt.getTime() - after).toBeLessThanOrEqual(72 * 3600_000)
    // Token URL-safe base64 (base64url) — no +, /, or = characters.
    expect(res.token).toMatch(/^[A-Za-z0-9_-]+$/)
    // Row inserted in pending status with proposed values.
    const { rows: [inv] } = await db.query<any>(
      `SELECT direction, pm_company_id, property_id, landlord_id,
              proposed_scope, proposed_fee_plan_id, status
         FROM pm_property_invitations WHERE id=$1`, [res.invitationId])
    expect(inv.status).toBe('pending')
    expect(inv.pm_company_id).toBe(ctx.pmCompanyId)
    expect(inv.proposed_scope).toBe('manage')
    expect(inv.proposed_fee_plan_id).toBe(ctx.feePlanId)
  })
})

// ─── acceptPropertyInvitation ────────────────────────────────

describe('acceptPropertyInvitation — guard rails', () => {
  it('token not found → 404', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await expect(acceptPropertyInvitation({
        client, token: 'nonexistent-token',
        acceptingUserId: '00000000-0000-0000-0000-000000000000',
        replace: false,
      })).rejects.toThrow(/not found/)
      await client.query('ROLLBACK')
    } finally { client.release() }
  })

  it('status not pending (already-accepted) → 409', async () => {
    const ctx = await seedInviteCtx()
    const { token } = await sendBasicInvite(ctx)
    // Manually flip to accepted.
    await db.query(`UPDATE pm_property_invitations SET status='accepted' WHERE token=$1`, [token])
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await expect(acceptPropertyInvitation({
        client, token, acceptingUserId: ctx.landlordUserId, replace: false,
      })).rejects.toThrow(/is accepted, not pending/)
      await client.query('ROLLBACK')
    } finally { client.release() }
  })

  it('expired invitation → 410 + status flipped to expired', async () => {
    const ctx = await seedInviteCtx()
    const { token, invitationId } = await sendBasicInvite(ctx)
    // Backdate expiry.
    await db.query(
      `UPDATE pm_property_invitations SET expires_at=now() - INTERVAL '1 hour' WHERE token=$1`,
      [token])
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await expect(acceptPropertyInvitation({
        client, token, acceptingUserId: ctx.landlordUserId, replace: false,
      })).rejects.toThrow(/expired/)
      await client.query('COMMIT')
    } finally { client.release() }
    // Status was flipped to expired by the function before throwing.
    const { rows: [inv] } = await db.query<any>(
      `SELECT status FROM pm_property_invitations WHERE id=$1`, [invitationId])
    expect(inv.status).toBe('expired')
  })

  it('S159: owner_to_pm + manage + Connect not ready → 409 with banking copy', async () => {
    const ctx = await seedInviteCtx()
    const { token } = await sendBasicInvite(ctx, {
      direction: 'owner_to_pm', scope: 'manage',
    })
    // PM defaults: connect_payouts_enabled=FALSE, connect_details_submitted=FALSE
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await expect(acceptPropertyInvitation({
        client, token, acceptingUserId: ctx.landlordUserId, replace: false,
      })).rejects.toThrow(/Banking onboarding incomplete/)
      await client.query('ROLLBACK')
    } finally { client.release() }
  })

  it('S159: pm_to_owner direction skips banking guard', async () => {
    const ctx = await seedInviteCtx()
    const { token } = await sendBasicInvite(ctx, {
      direction: 'pm_to_owner', scope: 'manage', feePlanId: null,
    })
    // pm_to_owner with feePlanId null (proposedFeePlanId guard tolerates it).
    // No Connect readiness on pm_companies; banking guard SHOULD NOT fire.
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const res = await acceptPropertyInvitation({
        client, token, acceptingUserId: ctx.landlordUserId, replace: false,
      })
      expect(res.pmCompanyId).toBe(ctx.pmCompanyId)
      await client.query('COMMIT')
    } finally { client.release() }
  })

  it('view scope skips banking guard even on owner_to_pm direction', async () => {
    const ctx = await seedInviteCtx()
    const { token } = await sendBasicInvite(ctx, {
      direction: 'owner_to_pm', scope: 'view', feePlanId: null,
    })
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const res = await acceptPropertyInvitation({
        client, token, acceptingUserId: ctx.landlordUserId, replace: false,
      })
      expect(res.pmFeePlanId).toBeNull()  // 'view' scope leaves fee plan null
      await client.query('COMMIT')
    } finally { client.release() }
  })
})

describe('acceptPropertyInvitation — happy + replace', () => {
  async function readyPmConnect(pmCompanyId: string): Promise<void> {
    await db.query(
      `UPDATE pm_companies
          SET connect_payouts_enabled=TRUE, connect_details_submitted=TRUE
        WHERE id=$1`, [pmCompanyId])
  }

  it('happy "manage": properties.pm_company_id + pm_fee_plan_id written; invitation flipped accepted', async () => {
    const ctx = await seedInviteCtx()
    await readyPmConnect(ctx.pmCompanyId)
    const { token, invitationId } = await sendBasicInvite(ctx, { scope: 'manage' })
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const res = await acceptPropertyInvitation({
        client, token, acceptingUserId: ctx.landlordUserId, replace: false,
      })
      expect(res.pmCompanyId).toBe(ctx.pmCompanyId)
      expect(res.pmFeePlanId).toBe(ctx.feePlanId)
      expect(res.replacedPmCompanyId).toBeNull()
      await client.query('COMMIT')
    } finally { client.release() }
    // Property + invitation post-state
    const { rows: [p] } = await db.query<any>(
      `SELECT pm_company_id, pm_fee_plan_id FROM properties WHERE id=$1`,
      [ctx.propertyId])
    expect(p.pm_company_id).toBe(ctx.pmCompanyId)
    expect(p.pm_fee_plan_id).toBe(ctx.feePlanId)
    const { rows: [inv] } = await db.query<any>(
      `SELECT status, accepted_user_id, replaced_pm_company_id
         FROM pm_property_invitations WHERE id=$1`, [invitationId])
    expect(inv.status).toBe('accepted')
    expect(inv.accepted_user_id).toBe(ctx.landlordUserId)
    expect(inv.replaced_pm_company_id).toBeNull()
  })

  it('conflict (property has DIFFERENT pm) + replace=false → 409', async () => {
    const ctx = await seedInviteCtx()
    await readyPmConnect(ctx.pmCompanyId)
    // Seed a second PM and attach it to the property pre-invite.
    const c = await db.connect()
    let priorPmId = ''
    try {
      await c.query('BEGIN')
      const bankId = await seedUserBankAccount(c, { userId: ctx.landlordUserId })
      priorPmId = await seedPmCompany(c, { bankAccountId: bankId })
      await c.query(`UPDATE properties SET pm_company_id=$2 WHERE id=$1`,
        [ctx.propertyId, priorPmId])
      await c.query('COMMIT')
    } finally { c.release() }
    const { token } = await sendBasicInvite(ctx, { scope: 'manage' })
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await expect(acceptPropertyInvitation({
        client, token, acceptingUserId: ctx.landlordUserId, replace: false,
      })).rejects.toThrow(/currently managed by another PM/)
      await client.query('ROLLBACK')
    } finally { client.release() }
  })

  it('conflict + replace=true → succeeds; replaced_pm_company_id stamped', async () => {
    const ctx = await seedInviteCtx()
    await readyPmConnect(ctx.pmCompanyId)
    const c = await db.connect()
    let priorPmId = ''
    try {
      await c.query('BEGIN')
      const bankId = await seedUserBankAccount(c, { userId: ctx.landlordUserId })
      priorPmId = await seedPmCompany(c, { bankAccountId: bankId })
      await c.query(`UPDATE properties SET pm_company_id=$2 WHERE id=$1`,
        [ctx.propertyId, priorPmId])
      await c.query('COMMIT')
    } finally { c.release() }
    const { token, invitationId } = await sendBasicInvite(ctx, { scope: 'manage' })
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const res = await acceptPropertyInvitation({
        client, token, acceptingUserId: ctx.landlordUserId, replace: true,
      })
      expect(res.replacedPmCompanyId).toBe(priorPmId)
      await client.query('COMMIT')
    } finally { client.release() }
    const { rows: [p] } = await db.query<any>(
      `SELECT pm_company_id FROM properties WHERE id=$1`, [ctx.propertyId])
    expect(p.pm_company_id).toBe(ctx.pmCompanyId)
    const { rows: [inv] } = await db.query<any>(
      `SELECT replaced_pm_company_id FROM pm_property_invitations WHERE id=$1`,
      [invitationId])
    expect(inv.replaced_pm_company_id).toBe(priorPmId)
  })
})

// ─── rejectPropertyInvitation ────────────────────────────────

describe('rejectPropertyInvitation', () => {
  it('happy: status=rejected; rejected_at + rejected_reason stamped', async () => {
    const ctx = await seedInviteCtx()
    const { token, invitationId } = await sendBasicInvite(ctx)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const res = await rejectPropertyInvitation(
        client, token, 'Wrong fee plan')
      expect(res.invitationId).toBe(invitationId)
      await client.query('COMMIT')
    } finally { client.release() }
    const { rows: [inv] } = await db.query<any>(
      `SELECT status, rejected_at, rejected_reason
         FROM pm_property_invitations WHERE id=$1`, [invitationId])
    expect(inv.status).toBe('rejected')
    expect(inv.rejected_at).not.toBeNull()
    expect(inv.rejected_reason).toBe('Wrong fee plan')
  })

  it('token not found → 404', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await expect(rejectPropertyInvitation(client, 'nonexistent', null))
        .rejects.toThrow(/not found or no longer pending/)
      await client.query('ROLLBACK')
    } finally { client.release() }
  })

  it('non-pending invitation → 404 (WHERE clause excludes)', async () => {
    const ctx = await seedInviteCtx()
    const { token } = await sendBasicInvite(ctx)
    await db.query(`UPDATE pm_property_invitations SET status='revoked' WHERE token=$1`, [token])
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await expect(rejectPropertyInvitation(client, token, null))
        .rejects.toThrow(/no longer pending/)
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
})

// ─── revokePropertyInvitation ────────────────────────────────

describe('revokePropertyInvitation', () => {
  it('happy: status=revoked; revoked_at + revoked_by_user_id stamped', async () => {
    const ctx = await seedInviteCtx()
    const { invitationId } = await sendBasicInvite(ctx)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await revokePropertyInvitation(client, invitationId, ctx.landlordUserId)
      await client.query('COMMIT')
    } finally { client.release() }
    const { rows: [inv] } = await db.query<any>(
      `SELECT status, revoked_at, revoked_by_user_id
         FROM pm_property_invitations WHERE id=$1`, [invitationId])
    expect(inv.status).toBe('revoked')
    expect(inv.revoked_at).not.toBeNull()
    expect(inv.revoked_by_user_id).toBe(ctx.landlordUserId)
  })

  it('non-pending invitation → 404', async () => {
    const ctx = await seedInviteCtx()
    const { invitationId } = await sendBasicInvite(ctx)
    await db.query(`UPDATE pm_property_invitations SET status='accepted' WHERE id=$1`, [invitationId])
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await expect(revokePropertyInvitation(client, invitationId, ctx.landlordUserId))
        .rejects.toThrow(/not found or no longer pending/)
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
})

// ─── expireStaleInvitations ──────────────────────────────────

describe('expireStaleInvitations', () => {
  it('no pending past expiry → 0', async () => {
    const count = await expireStaleInvitations()
    expect(count).toBe(0)
  })

  it('pending past expiry → flips to expired; returns count', async () => {
    const ctx = await seedInviteCtx()
    const { token } = await sendBasicInvite(ctx)
    await db.query(
      `UPDATE pm_property_invitations SET expires_at=now() - INTERVAL '1 hour' WHERE token=$1`,
      [token])
    const count = await expireStaleInvitations()
    expect(count).toBe(1)
    const { rows: [inv] } = await db.query<any>(
      `SELECT status FROM pm_property_invitations WHERE token=$1`, [token])
    expect(inv.status).toBe('expired')
  })

  it('non-pending past-expiry rows untouched (only pending qualifies)', async () => {
    const ctx = await seedInviteCtx()
    const { token } = await sendBasicInvite(ctx)
    await db.query(
      `UPDATE pm_property_invitations
          SET expires_at=now() - INTERVAL '1 day', status='rejected'
        WHERE token=$1`, [token])
    const count = await expireStaleInvitations()
    expect(count).toBe(0)
    const { rows: [inv] } = await db.query<any>(
      `SELECT status FROM pm_property_invitations WHERE token=$1`, [token])
    expect(inv.status).toBe('rejected')  // unchanged
  })
})
