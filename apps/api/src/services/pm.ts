/**
 * S157: PM third-party-companies service module.
 *
 * Two responsibilities:
 *   1. PM-company resolution for a given property — encapsulates the
 *      properties.pm_company_id (override) → landlords.default_pm_company_id
 *      (default) fallback chain. Single source of truth so UI, notifications,
 *      and conflict checks all answer "who manages property X?" the same way.
 *   2. pm_property_invitations business logic — send / accept / reject /
 *      revoke / expire. The accept handler is the only path (besides the
 *      legacy /pm-assignment route) that writes properties.pm_company_id.
 *
 * Allocation engine intentionally does NOT read through this module — it
 * reads the property columns directly because allocation requires BOTH
 * pm_company_id AND pm_fee_plan_id, and the landlord default has no fee
 * plan (deliberately — a fee plan is per-contract and gets attached to a
 * specific property at invite time).
 */

import type { PoolClient } from 'pg'
import crypto from 'crypto'
import { db, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'

// ── PM resolver ────────────────────────────────────────────────────────────

export type PmResolutionSource = 'property' | 'landlord_default' | null

export interface PmResolution {
  source: PmResolutionSource
  pm_company_id: string | null
  pm_fee_plan_id: string | null  // null when source='landlord_default' (no plan attached at landlord level)
}

interface PropertyPmRow {
  property_id: string
  property_pm_company_id: string | null
  property_pm_fee_plan_id: string | null
  landlord_default_pm_company_id: string | null
}

export async function getPmCompanyForProperty(
  propertyId: string,
  client?: PoolClient
): Promise<PmResolution> {
  const sql = `
    SELECT
      p.id                          AS property_id,
      p.pm_company_id               AS property_pm_company_id,
      p.pm_fee_plan_id              AS property_pm_fee_plan_id,
      l.default_pm_company_id       AS landlord_default_pm_company_id
    FROM properties p
    JOIN landlords l ON l.id = p.landlord_id
    WHERE p.id = $1
  `
  const row = client
    ? (await client.query<PropertyPmRow>(sql, [propertyId])).rows[0]
    : await queryOne<PropertyPmRow>(sql, [propertyId])

  if (!row) {
    throw new AppError(404, `Property ${propertyId} not found`)
  }

  if (row.property_pm_company_id !== null) {
    return {
      source: 'property',
      pm_company_id: row.property_pm_company_id,
      pm_fee_plan_id: row.property_pm_fee_plan_id,
    }
  }
  if (row.landlord_default_pm_company_id !== null) {
    return {
      source: 'landlord_default',
      pm_company_id: row.landlord_default_pm_company_id,
      pm_fee_plan_id: null,
    }
  }
  return { source: null, pm_company_id: null, pm_fee_plan_id: null }
}

// ── Invitation business logic ──────────────────────────────────────────────

const INVITATION_TTL_HOURS = 72

interface SendInvitationParams {
  client: PoolClient
  direction: 'owner_to_pm' | 'pm_to_owner'
  pmCompanyId: string
  propertyId: string
  landlordId: string
  invitedEmail: string
  invitedByUserId: string
  proposedScope: 'manage' | 'view'
  proposedFeePlanId: string | null
}

export interface SendInvitationResult {
  invitationId: string
  token: string
  expiresAt: Date
}

export async function sendPropertyInvitation(
  params: SendInvitationParams
): Promise<SendInvitationResult> {
  const {
    client, direction, pmCompanyId, propertyId, landlordId,
    invitedEmail, invitedByUserId, proposedScope, proposedFeePlanId,
  } = params

  // Sanity: property must belong to the named landlord
  const propRow = await client.query<{ landlord_id: string; pm_company_id: string | null }>(
    `SELECT landlord_id, pm_company_id FROM properties WHERE id=$1`,
    [propertyId]
  )
  if (propRow.rowCount === 0) {
    throw new AppError(404, `Property ${propertyId} not found`)
  }
  if (propRow.rows[0].landlord_id !== landlordId) {
    throw new AppError(400, `Property ${propertyId} does not belong to landlord ${landlordId}`)
  }

  // Sanity: pm_company exists and is active
  const pmRow = await client.query<{ status: string }>(
    `SELECT status FROM pm_companies WHERE id=$1`,
    [pmCompanyId]
  )
  if (pmRow.rowCount === 0) {
    throw new AppError(404, `PM company ${pmCompanyId} not found`)
  }
  if (pmRow.rows[0].status !== 'active') {
    throw new AppError(400, `PM company ${pmCompanyId} is not active`)
  }

  // Sanity: if a fee plan was proposed, it must belong to this PM company
  if (proposedFeePlanId !== null) {
    const fpRow = await client.query<{ pm_company_id: string; status: string }>(
      `SELECT pm_company_id, status FROM pm_fee_plans WHERE id=$1`,
      [proposedFeePlanId]
    )
    if (fpRow.rowCount === 0) {
      throw new AppError(404, `Fee plan ${proposedFeePlanId} not found`)
    }
    if (fpRow.rows[0].pm_company_id !== pmCompanyId) {
      throw new AppError(400, `Fee plan ${proposedFeePlanId} does not belong to PM company ${pmCompanyId}`)
    }
    if (fpRow.rows[0].status !== 'active') {
      throw new AppError(400, `Fee plan ${proposedFeePlanId} is not active`)
    }
  }

  // Sanity: no existing pending invite for this (pm_company, property) pair
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM pm_property_invitations
      WHERE pm_company_id=$1 AND property_id=$2 AND status='pending'`,
    [pmCompanyId, propertyId]
  )
  if (existing.rowCount && existing.rowCount > 0) {
    throw new AppError(409, 'A pending invitation already exists for this PM and property')
  }

  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000)

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO pm_property_invitations (
       direction, pm_company_id, property_id, landlord_id,
       invited_email, invited_by_user_id, proposed_scope, proposed_fee_plan_id,
       token, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [direction, pmCompanyId, propertyId, landlordId,
     invitedEmail, invitedByUserId, proposedScope, proposedFeePlanId,
     token, expiresAt]
  )

  return { invitationId: inserted.rows[0].id, token, expiresAt }
}

export interface AcceptInvitationParams {
  client: PoolClient
  token: string
  acceptingUserId: string
  /** When the property is already linked to a different PM, the route MUST
   *  pass replace=true after the UI has surfaced the conflict and the user
   *  has confirmed. Without this flag, accept fails with 409. */
  replace: boolean
}

export interface AcceptInvitationResult {
  invitationId: string
  pmCompanyId: string
  propertyId: string
  pmFeePlanId: string | null
  replacedPmCompanyId: string | null
}

export async function acceptPropertyInvitation(
  params: AcceptInvitationParams
): Promise<AcceptInvitationResult> {
  const { client, token, acceptingUserId, replace } = params

  const inv = await client.query<{
    id: string
    direction: string
    pm_company_id: string
    property_id: string
    landlord_id: string
    proposed_scope: string
    proposed_fee_plan_id: string | null
    status: string
    expires_at: Date
  }>(
    `SELECT id, direction, pm_company_id, property_id, landlord_id,
            proposed_scope, proposed_fee_plan_id, status, expires_at
       FROM pm_property_invitations
      WHERE token=$1
      FOR UPDATE`,
    [token]
  )
  if (inv.rowCount === 0) {
    throw new AppError(404, 'Invitation not found')
  }
  const invitation = inv.rows[0]
  if (invitation.status !== 'pending') {
    throw new AppError(409, `Invitation is ${invitation.status}, not pending`)
  }
  if (invitation.expires_at.getTime() < Date.now()) {
    await client.query(
      `UPDATE pm_property_invitations SET status='expired' WHERE id=$1`,
      [invitation.id]
    )
    throw new AppError(410, 'Invitation has expired')
  }

  // S159: bank-readiness guard for owner_to_pm direction. When the owner
  // hires the PM (direction=owner_to_pm) AND the proposed scope is 'manage'
  // (rent will route through GAM with a fee plan), the PM's Connect
  // account must be capable of receiving destination charges. Stripe
  // requires payouts_enabled + details_submitted; we cache those flags
  // on pm_companies via the account.updated webhook.
  //
  // 'view' scope skips the guard — no money flows in that direction.
  // 'pm_to_owner' direction also skips the guard at this layer; the PM
  // is requesting visibility from the owner, not asking the owner to
  // route money through them. (If the eventual scope is 'manage' that
  // PM still has to clear KYC before any allocation actually fires —
  // the allocation engine has its own guards from S110.)
  if (invitation.direction === 'owner_to_pm' && invitation.proposed_scope === 'manage') {
    const pm = await client.query<{
      connect_payouts_enabled: boolean
      connect_details_submitted: boolean
    }>(
      `SELECT connect_payouts_enabled, connect_details_submitted
         FROM pm_companies
        WHERE id = $1`,
      [invitation.pm_company_id]
    )
    if (pm.rowCount === 0) {
      throw new AppError(404, 'PM company not found')
    }
    const { connect_payouts_enabled, connect_details_submitted } = pm.rows[0]
    if (!connect_payouts_enabled || !connect_details_submitted) {
      throw new AppError(
        409,
        'Banking onboarding incomplete — complete Stripe Connect onboarding ' +
        'before accepting management invitations. Visit /banking in your PM portal.'
      )
    }
  }

  // Conflict check: is this property already linked to a different PM?
  const prop = await client.query<{ pm_company_id: string | null; pm_fee_plan_id: string | null }>(
    `SELECT pm_company_id, pm_fee_plan_id FROM properties WHERE id=$1 FOR UPDATE`,
    [invitation.property_id]
  )
  if (prop.rowCount === 0) {
    throw new AppError(404, 'Property not found')
  }
  const existingPmId = prop.rows[0].pm_company_id
  const conflict = existingPmId !== null && existingPmId !== invitation.pm_company_id

  if (conflict && !replace) {
    throw new AppError(
      409,
      `Property is currently managed by another PM company (${existingPmId}). ` +
      `Re-call accept with replace=true to override.`
    )
  }

  // Write through. Only 'manage' scope sets pm_fee_plan_id; 'view' scope
  // populates pm_company_id but leaves the fee plan null (PM was hired
  // off-platform; GAM is just exposing the property to the PM, no money
  // routing changes).
  const newFeePlanId = invitation.proposed_scope === 'manage'
    ? invitation.proposed_fee_plan_id
    : null

  await client.query(
    `UPDATE properties
        SET pm_company_id  = $1,
            pm_fee_plan_id = $2
      WHERE id = $3`,
    [invitation.pm_company_id, newFeePlanId, invitation.property_id]
  )

  await client.query(
    `UPDATE pm_property_invitations
        SET status='accepted',
            accepted_at=now(),
            accepted_user_id=$2,
            replaced_pm_company_id=$3
      WHERE id=$1`,
    [invitation.id, acceptingUserId, conflict ? existingPmId : null]
  )

  return {
    invitationId: invitation.id,
    pmCompanyId: invitation.pm_company_id,
    propertyId: invitation.property_id,
    pmFeePlanId: newFeePlanId,
    replacedPmCompanyId: conflict ? existingPmId : null,
  }
}

export async function rejectPropertyInvitation(
  client: PoolClient,
  token: string,
  reason: string | null
): Promise<{ invitationId: string }> {
  const res = await client.query<{ id: string }>(
    `UPDATE pm_property_invitations
        SET status='rejected',
            rejected_at=now(),
            rejected_reason=$2
      WHERE token=$1 AND status='pending'
      RETURNING id`,
    [token, reason]
  )
  if (res.rowCount === 0) {
    throw new AppError(404, 'Invitation not found or no longer pending')
  }
  return { invitationId: res.rows[0].id }
}

export async function revokePropertyInvitation(
  client: PoolClient,
  invitationId: string,
  revokingUserId: string
): Promise<void> {
  const res = await client.query(
    `UPDATE pm_property_invitations
        SET status='revoked',
            revoked_at=now(),
            revoked_by_user_id=$2
      WHERE id=$1 AND status='pending'`,
    [invitationId, revokingUserId]
  )
  if (res.rowCount === 0) {
    throw new AppError(404, 'Invitation not found or no longer pending')
  }
}

/** Sweep expired pending invitations. Called from the daily scheduler.
 *  Idempotent — a single sweep marks everything past expires_at as 'expired'
 *  in one statement. */
export async function expireStaleInvitations(): Promise<number> {
  const res = await db.query(
    `UPDATE pm_property_invitations
        SET status='expired'
      WHERE status='pending' AND expires_at < now()`
  )
  return res.rowCount ?? 0
}
