import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { emailInvitation } from '../services/email'
import { createNotification } from '../services/notifications'
import { fetchAccountStatus } from '../services/stripeConnect'
import {
  LANDLORD_ASSIGNABLE_ROLES,
  LandlordAssignableRole,
  MAINTENANCE_JOB_CATEGORIES,
  BOOKKEEPER_ACCESS_LEVELS,
} from '@gam/shared'
import { logger } from '../lib/logger'

// ── Shared helpers ────────────────────────────────────────────────

const INVITATION_TTL_HOURS = 24

const SCOPE_TABLES: Record<LandlordAssignableRole, string> = {
  property_manager: 'property_manager_scopes',
  onsite_manager:   'onsite_manager_scopes',
  maintenance:      'maintenance_worker_scopes',
  bookkeeper:       'bookkeeper_scopes',
}

// Per-role scope payload validation
const pmScopeSchema = z.object({
  propertyIds:               z.array(z.string().uuid()).default([]),
  unitIds:                   z.array(z.string().uuid()).default([]),
  allProperties:             z.boolean().default(false),
  maintApprovalCeilingCents: z.number().int().nullable().default(null),
})

const osScopeSchema = z.object({
  propertyIds:   z.array(z.string().uuid()).default([]),
  unitIds:       z.array(z.string().uuid()).default([]),
  allProperties: z.boolean().default(false),  // S187
})

const mwScopeSchema = z.object({
  propertyIds:   z.array(z.string().uuid()).default([]),
  unitIds:       z.array(z.string().uuid()).default([]),
  jobCategories: z.array(z.enum(MAINTENANCE_JOB_CATEGORIES)).default([]),
  allProperties: z.boolean().default(false),
})

const bkScopeSchema = z.object({
  accessLevel: z.enum(BOOKKEEPER_ACCESS_LEVELS),
})

function validateScopePayload(role: LandlordAssignableRole, raw: unknown): any {
  switch (role) {
    case 'property_manager': return pmScopeSchema.parse(raw)
    case 'onsite_manager':   return osScopeSchema.parse(raw)
    case 'maintenance':      return mwScopeSchema.parse(raw)
    case 'bookkeeper':       return bkScopeSchema.parse(raw)
  }
}

function isAssignableRole(s: string): s is LandlordAssignableRole {
  return (LANDLORD_ASSIGNABLE_ROLES as readonly string[]).includes(s)
}

// Resolve the landlord_id whose team the caller is acting on.
// - landlord: their own profileId
// - admin/super_admin: explicit ?landlordId= or body.landlordId
// - property_manager (S81, with team.invite or team.manage_permissions perm):
//   their scope's landlordId. They cannot act on any other landlord.
function getLandlordIdFromReq(req: any): string {
  if (req.user?.role === 'landlord') return req.user.profileId
  if (req.user?.role === 'admin' || req.user?.role === 'super_admin') {
    const lid = req.query?.landlordId || req.body?.landlordId
    if (!lid) throw new AppError(400, 'landlordId required for admin calls')
    return String(lid)
  }
  if (req.user?.role === 'property_manager' && req.user?.landlordId) {
    return req.user.landlordId
  }
  throw new AppError(403, 'Only landlords may manage scoped users')
}

async function insertScopeRow(
  client: any,
  role: LandlordAssignableRole,
  userId: string,
  landlordId: string,
  payload: any,
) {
  switch (role) {
    case 'property_manager': {
      const { rows } = await client.query(
        `INSERT INTO property_manager_scopes
           (user_id, landlord_id, property_ids, unit_ids, all_properties, maint_approval_ceiling_cents)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [userId, landlordId, payload.propertyIds, payload.unitIds,
         payload.allProperties, payload.maintApprovalCeilingCents])
      return rows[0]
    }
    case 'onsite_manager': {
      const { rows } = await client.query(
        `INSERT INTO onsite_manager_scopes
           (user_id, landlord_id, property_ids, unit_ids, all_properties)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [userId, landlordId, payload.propertyIds, payload.unitIds,
         payload.allProperties])
      return rows[0]
    }
    case 'maintenance': {
      const { rows } = await client.query(
        `INSERT INTO maintenance_worker_scopes
           (user_id, landlord_id, property_ids, unit_ids, job_categories, all_properties)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [userId, landlordId, payload.propertyIds, payload.unitIds,
         payload.jobCategories, payload.allProperties])
      return rows[0]
    }
    case 'bookkeeper': {
      const { rows } = await client.query(
        `INSERT INTO bookkeeper_scopes
           (user_id, landlord_id, access_level)
         VALUES ($1,$2,$3) RETURNING *`,
        [userId, landlordId, payload.accessLevel])
      return rows[0]
    }
  }
}

async function getInviterName(landlordId: string): Promise<string> {
  const landlord = await queryOne<any>(
    `SELECT u.first_name, u.last_name, l.business_name
     FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
    [landlordId])
  return landlord?.business_name
    || [landlord?.first_name, landlord?.last_name].filter(Boolean).join(' ')
    || 'Your landlord'
}

function buildAcceptUrl(token: string): string {
  const base = process.env.LANDLORD_PORTAL_URL || 'http://localhost:3001'
  return `${base}/invite/${token}`
}

// ── Authenticated router: landlord manages scoped users ───────────

export const scopesRouter = Router()
scopesRouter.use(requireAuth)

// GET /api/scopes/team — unified roll-up across all 4 scope tables + invitations.
// S80 / Item 8b. Single endpoint feeds the landlord TeamPage view so the
// frontend doesn't have to query four endpoints and merge client-side.
// Registered BEFORE /:roleType so Express doesn't match 'team' as a roleType.
scopesRouter.get('/team', requirePerm('team.invite', 'team.manage_permissions'), async (req, res, next) => {
  try {
    const landlordId = getLandlordIdFromReq(req)

    // S168: surface direct_deposit_enabled (per-manager opt-in toggle) and
    // the cached Connect-readiness flags from users so TeamPage can render
    // both the toggle state and the manager's onboarding progress without
    // a second round-trip.
    const pmRows = await query<any>(
      `SELECT 'property_manager' AS role, s.user_id, s.permissions,
              jsonb_build_object(
                'propertyIds', s.property_ids,
                'unitIds', s.unit_ids,
                'allProperties', s.all_properties,
                'maintApprovalCeilingCents', s.maint_approval_ceiling_cents
              ) AS scope,
              s.direct_deposit_enabled,
              u.connect_charges_enabled,
              u.connect_payouts_enabled,
              u.connect_details_submitted,
              s.created_at, s.updated_at,
              u.email, u.first_name, u.last_name, u.phone
         FROM property_manager_scopes s JOIN users u ON u.id = s.user_id
        WHERE s.landlord_id = $1`, [landlordId])

    const omRows = await query<any>(
      `SELECT 'onsite_manager' AS role, s.user_id, s.permissions,
              jsonb_build_object(
                'propertyIds', s.property_ids,
                'unitIds', s.unit_ids,
                'allProperties', s.all_properties
              ) AS scope,
              s.created_at, s.updated_at,
              u.email, u.first_name, u.last_name, u.phone
         FROM onsite_manager_scopes s JOIN users u ON u.id = s.user_id
        WHERE s.landlord_id = $1`, [landlordId])

    const mwRows = await query<any>(
      `SELECT 'maintenance' AS role, s.user_id, s.permissions,
              jsonb_build_object(
                'propertyIds', s.property_ids,
                'unitIds', s.unit_ids,
                'jobCategories', s.job_categories,
                'allProperties', s.all_properties
              ) AS scope,
              s.created_at, s.updated_at,
              u.email, u.first_name, u.last_name, u.phone
         FROM maintenance_worker_scopes s JOIN users u ON u.id = s.user_id
        WHERE s.landlord_id = $1`, [landlordId])

    const bkRows = await query<any>(
      `SELECT 'bookkeeper' AS role, s.user_id,
              jsonb_build_object('access_level', s.access_level) AS permissions,
              jsonb_build_object('accessLevel', s.access_level) AS scope,
              s.created_at, s.updated_at,
              u.email, u.first_name, u.last_name, u.phone
         FROM bookkeeper_scopes s JOIN users u ON u.id = s.user_id
        WHERE s.landlord_id = $1`, [landlordId])

    const members = [...pmRows, ...omRows, ...mwRows, ...bkRows]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    const invitations = await query<any>(
      `SELECT id, email, role, status, expires_at, created_at, accepted_at, revoked_at
         FROM invitations
        WHERE landlord_id = $1 AND status = 'pending'
        ORDER BY created_at DESC`, [landlordId])

    res.json({ success: true, data: { members, invitations } })
  } catch (e) { next(e) }
})

// PATCH /api/scopes/property_manager/:userId/direct-deposit — landlord
// flips the per-manager Connect opt-in toggle. Only valid for the
// property_manager role; other worker roles have no rent-share allocation
// path so they don't need a Connect account. On false→true, an in-app
// notification fires to the manager telling them to onboard.
//
// S168: locks the CLAUDE.md spec — manager Connect is opt-in by the
// landlord, default off. Allocation_manager_fee Stripe Transfers
// silent-skip until the manager completes Connect onboarding.
scopesRouter.patch(
  '/property_manager/:userId/direct-deposit',
  requirePerm('team.manage_permissions'),
  async (req, res, next) => {
    try {
      const landlordId = getLandlordIdFromReq(req)
      const body = z.object({ enabled: z.boolean() }).parse(req.body)

      // S236: self-target guard. CLAUDE.md spec: manager Connect is
      // opt-in by the LANDLORD, default off. A manager with
      // team.manage_permissions managing another manager is delegated
      // team work; a manager flipping their own toggle is privilege
      // escalation around the landlord's financial-routing decision.
      if (req.user!.role === 'property_manager' && req.params.userId === req.user!.userId) {
        throw new AppError(403, 'Managers cannot flip their own direct-deposit toggle. Ask your landlord to enable it.')
      }

      // Snapshot the prior state so we only fire the notification on a
      // genuine false→true transition, not on idempotent re-enables.
      const before = await queryOne<{ direct_deposit_enabled: boolean }>(
        `SELECT direct_deposit_enabled
           FROM property_manager_scopes
          WHERE user_id = $1 AND landlord_id = $2`,
        [req.params.userId, landlordId])
      if (!before) throw new AppError(404, 'Scope row not found')

      const updated = await queryOne<any>(
        `UPDATE property_manager_scopes
            SET direct_deposit_enabled = $1, updated_at = NOW()
          WHERE user_id = $2 AND landlord_id = $3
          RETURNING *`,
        [body.enabled, req.params.userId, landlordId])

      if (body.enabled && !before.direct_deposit_enabled) {
        const manager = await queryOne<{ email: string; first_name: string }>(
          `SELECT email, first_name FROM users WHERE id = $1`,
          [req.params.userId])
        if (manager) {
          const inviterName = await getInviterName(landlordId)
          const portalBase = process.env.LANDLORD_PORTAL_URL || 'http://localhost:3001'
          createNotification({
            userId:    req.params.userId,
            landlordId,
            type:      'manager_direct_deposit_enabled',
            title:     'Direct Deposit Enabled — Set Up Stripe Connect',
            body:      `${inviterName} enabled direct deposit on your account. ` +
                       `Visit Banking in the portal to complete Stripe Connect onboarding ` +
                       `before your manager fees can be paid out.`,
            data:      { landlordId, portalUrl: `${portalBase}/banking` },
            sendEmail: true,
            emailTo:   manager.email,
            emailSubject: 'Direct Deposit Enabled — Action Required',
          }).catch(e => logger.error({ err: e }, '[NOTIFY] manager direct-deposit enable'))
        }
      }

      res.json({ success: true, data: updated })
    } catch (e) { next(e) }
  }
)

// GET /api/scopes/property_manager/:userId/connect-status — returns the
// manager's live Stripe Connect account state so the landlord can see
// exactly which KYC items the manager hasn't filled in. Verifies the
// caller actually employs this manager (scope row exists under their
// landlord_id) before proxying to Stripe. Stripe errors propagate.
//
// S168 follow-on: complement to the direct-deposit toggle. When a
// manager sits on "Awaiting onboarding" or "Verifying" for too long,
// the landlord can drill into requirements_currently_due to nudge them
// with specifics ("you need to upload an ID document" beats "finish
// stripe onboarding").
scopesRouter.get(
  '/property_manager/:userId/connect-status',
  requirePerm('team.manage_permissions'),
  async (req, res, next) => {
    try {
      const landlordId = getLandlordIdFromReq(req)

      // Authorize: caller must employ this manager.
      const scope = await queryOne<{ id: string }>(
        `SELECT id FROM property_manager_scopes
          WHERE user_id = $1 AND landlord_id = $2`,
        [req.params.userId, landlordId])
      if (!scope) throw new AppError(404, 'Manager not found in your team')

      const userRow = await queryOne<{ stripe_connect_account_id: string | null }>(
        `SELECT stripe_connect_account_id FROM users WHERE id = $1`,
        [req.params.userId])
      const connectAccountId = userRow?.stripe_connect_account_id ?? null
      if (!connectAccountId) {
        return res.json({ success: true, data: { exists: false } })
      }

      const status = await fetchAccountStatus(connectAccountId)
      res.json({ success: true, data: { exists: true, connectAccountId, ...status } })
    } catch (e) { next(e) }
  }
)

// GET /api/scopes/:roleType — scoped users + invitations for this role
scopesRouter.get('/:roleType', requirePerm('team.invite', 'team.manage_permissions'), async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    const landlordId = getLandlordIdFromReq(req)
    const table = SCOPE_TABLES[role]

    const users = await query<any>(
      `SELECT s.*, u.email, u.first_name, u.last_name, u.phone
       FROM ${table} s
       JOIN users u ON u.id = s.user_id
       WHERE s.landlord_id = $1
       ORDER BY s.created_at DESC`,
      [landlordId])

    const invitations = await query<any>(
      `SELECT * FROM invitations
       WHERE landlord_id = $1 AND role = $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [landlordId, role])

    res.json({ success: true, data: { users, invitations } })
  } catch (e) { next(e) }
})

// POST /api/scopes/:roleType/invite
scopesRouter.post('/:roleType/invite', requirePerm('team.invite'), async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    const landlordId = getLandlordIdFromReq(req)

    const body = z.object({
      email: z.string().email(),
      scope: z.any(),
    }).parse(req.body)
    const scope = validateScopePayload(role, body.scope)

    // Onsite manager uniqueness: one landlord per user, platform-wide
    if (role === 'onsite_manager') {
      const existing = await queryOne<any>(
        `SELECT 1 FROM onsite_manager_scopes s
         JOIN users u ON u.id = s.user_id
         WHERE lower(u.email) = lower($1) LIMIT 1`, [body.email])
      if (existing) throw new AppError(409, 'This user is already an on-site manager for another landlord')
    }

    // Block duplicate pending invite (same landlord + role + email)
    const dup = await queryOne<any>(
      `SELECT id FROM invitations
       WHERE landlord_id=$1 AND role=$2 AND lower(email)=lower($3) AND status='pending'
       LIMIT 1`,
      [landlordId, role, body.email])
    if (dup) throw new AppError(409, 'A pending invitation already exists for this email')

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const invRes = await client.query(
        `INSERT INTO invitations
           (email, landlord_id, role, scope_payload, invited_by_user_id, token, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [body.email, landlordId, role, JSON.stringify(scope),
         req.user!.userId, token, expiresAt])
      const invitation = invRes.rows[0]

      await client.query(
        `INSERT INTO platform_events
           (subject_type, subject_id, event_type, actor_user_id, payload)
         VALUES ('invitation', $1, 'invitation.created', $2, $3)`,
        [invitation.id, req.user!.userId, JSON.stringify({ role, email: body.email })])

      await client.query('COMMIT')

      const inviterName = await getInviterName(landlordId)
      emailInvitation(body.email, inviterName, role, buildAcceptUrl(token), { landlordId, invitationId: invitation.id })
        .catch(e => logger.error({ err: e }, '[EMAIL] invite failed'))

      res.status(201).json({ success: true, data: invitation })
    } catch (e: any) {
      await client.query('ROLLBACK')
      if (e?.code === '23505' && e?.constraint === 'invitations_unique_pending') {
        throw new AppError(409, 'A pending invitation already exists for this email')
      }
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// PATCH /api/scopes/:roleType/:userId/permissions — sub-permission toggle update.
// S80 / Item 8a. Replaces full-scope PATCH for the permissions field only.
// Bookkeeper rejected — use PATCH /scopes/bookkeeper/:userId for accessLevel.
scopesRouter.patch('/:roleType/:userId/permissions', requirePerm('team.manage_permissions'), async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    if (role === 'bookkeeper') throw new AppError(400, 'Bookkeeper uses accessLevel, not permissions toggles')
    const landlordId = getLandlordIdFromReq(req)
    const body = z.object({ permissions: z.record(z.boolean()) }).parse(req.body)
    const table = SCOPE_TABLES[role]

    // S236: self-edit guard. Without this, a property_manager who has
    // `team.manage_permissions` could grant themselves every other
    // sub-permission in the catalog — a permanent privilege escalation
    // around the landlord's intended scope. Owner roles (admin /
    // super_admin / landlord) bypass since they hold all perms by
    // definition.
    if (req.user!.role === 'property_manager' && req.params.userId === req.user!.userId) {
      throw new AppError(403, 'Managers cannot edit their own permissions. Ask your landlord to update them.')
    }

    const updated = await queryOne<any>(
      `UPDATE ${table} SET permissions = $1, updated_at = NOW()
        WHERE user_id = $2 AND landlord_id = $3 RETURNING *`,
      [JSON.stringify(body.permissions), req.params.userId, landlordId])
    if (!updated) throw new AppError(404, 'Scope row not found')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/scopes/:roleType/:userId — update scope row
scopesRouter.patch('/:roleType/:userId', requirePerm('team.manage_permissions'), async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    const landlordId = getLandlordIdFromReq(req)
    const scope = validateScopePayload(role, req.body)

    // S236: self-edit guard. Same reasoning as the /permissions
    // sibling — a manager could grant themselves access to additional
    // properties/units (or for PM, set their own approval ceiling)
    // without the landlord's knowledge.
    if (req.user!.role === 'property_manager' && req.params.userId === req.user!.userId) {
      throw new AppError(403, 'Managers cannot edit their own scope. Ask your landlord to update it.')
    }

    let updated: any = null
    switch (role) {
      case 'property_manager':
        updated = await queryOne<any>(
          `UPDATE property_manager_scopes SET
             property_ids = $1, unit_ids = $2, all_properties = $3,
             maint_approval_ceiling_cents = $4, updated_at = NOW()
           WHERE user_id = $5 AND landlord_id = $6 RETURNING *`,
          [scope.propertyIds, scope.unitIds, scope.allProperties,
           scope.maintApprovalCeilingCents, req.params.userId, landlordId])
        break
      case 'onsite_manager':
        updated = await queryOne<any>(
          `UPDATE onsite_manager_scopes SET
             property_ids = $1, unit_ids = $2, updated_at = NOW()
           WHERE user_id = $3 AND landlord_id = $4 RETURNING *`,
          [scope.propertyIds, scope.unitIds, req.params.userId, landlordId])
        break
      case 'maintenance':
        updated = await queryOne<any>(
          `UPDATE maintenance_worker_scopes SET
             property_ids = $1, unit_ids = $2, job_categories = $3,
             all_properties = $4, updated_at = NOW()
           WHERE user_id = $5 AND landlord_id = $6 RETURNING *`,
          [scope.propertyIds, scope.unitIds, scope.jobCategories,
           scope.allProperties, req.params.userId, landlordId])
        break
      case 'bookkeeper':
        updated = await queryOne<any>(
          `UPDATE bookkeeper_scopes SET
             access_level = $1, updated_at = NOW()
           WHERE user_id = $2 AND landlord_id = $3 RETURNING *`,
          [scope.accessLevel, req.params.userId, landlordId])
        break
    }
    if (!updated) throw new AppError(404, 'Scope row not found')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// DELETE /api/scopes/:roleType/:userId — remove scope row (revoke access)
scopesRouter.delete('/:roleType/:userId', requirePerm('team.manage_permissions'), async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    const landlordId = getLandlordIdFromReq(req)
    const table = SCOPE_TABLES[role]

    const deleted = await queryOne<any>(
      `DELETE FROM ${table} WHERE user_id = $1 AND landlord_id = $2 RETURNING *`,
      [req.params.userId, landlordId])
    if (!deleted) throw new AppError(404, 'Scope row not found')
    res.json({ success: true, data: deleted })
  } catch (e) { next(e) }
})

// POST /api/scopes/invitations/:id/resend — new token, reset expiry
scopesRouter.post('/invitations/:id/resend', requirePerm('team.invite'), async (req, res, next) => {
  try {
    const landlordId = getLandlordIdFromReq(req)
    const inv = await queryOne<any>(
      `SELECT * FROM invitations WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, landlordId])
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status !== 'pending') throw new AppError(400, 'Only pending invitations can be resent')

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const upd = await client.query(
        `UPDATE invitations SET token = $1, expires_at = $2 WHERE id = $3 RETURNING *`,
        [token, expiresAt, inv.id])
      await client.query(
        `INSERT INTO platform_events (subject_type, subject_id, event_type, actor_user_id, payload)
         VALUES ('invitation', $1, 'invitation.resent', $2, '{}'::jsonb)`,
        [inv.id, req.user!.userId])
      await client.query('COMMIT')

      const inviterName = await getInviterName(landlordId)
      emailInvitation(inv.email, inviterName, inv.role, buildAcceptUrl(token), { landlordId, invitationId: inv.id })
        .catch(e => logger.error({ err: e }, '[EMAIL] resend failed'))

      res.json({ success: true, data: upd.rows[0] })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// POST /api/scopes/invitations/:id/revoke
scopesRouter.post('/invitations/:id/revoke', requirePerm('team.invite'), async (req, res, next) => {
  try {
    const landlordId = getLandlordIdFromReq(req)
    const inv = await queryOne<any>(
      `SELECT * FROM invitations WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, landlordId])
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status !== 'pending') throw new AppError(400, 'Only pending invitations can be revoked')

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const upd = await client.query(
        `UPDATE invitations SET status='revoked', revoked_at=NOW(), revoked_by_user_id=$1
         WHERE id=$2 RETURNING *`,
        [req.user!.userId, inv.id])
      await client.query(
        `INSERT INTO platform_events (subject_type, subject_id, event_type, actor_user_id, payload)
         VALUES ('invitation', $1, 'invitation.revoked', $2, '{}'::jsonb)`,
        [inv.id, req.user!.userId])
      await client.query('COMMIT')
      res.json({ success: true, data: upd.rows[0] })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ── Public invitation router (no auth) ────────────────────────────

export const invitationsRouter = Router()

// GET /api/invitations/:token — accept-screen payload
invitationsRouter.get('/:token', async (req, res, next) => {
  try {
    const inv = await queryOne<any>(
      `SELECT i.*, u.first_name as inviter_first, u.last_name as inviter_last,
              l.business_name as inviter_business
       FROM invitations i
       LEFT JOIN users u ON u.id = i.invited_by_user_id
       LEFT JOIN landlords l ON l.id = i.landlord_id
       WHERE i.token = $1`,
      [req.params.token])
    if (!inv) throw new AppError(404, 'Invitation not found')

    if (inv.status === 'pending' && new Date(inv.expires_at) > new Date()) {
      await query(
        `INSERT INTO platform_events (subject_type, subject_id, event_type, actor_user_id, payload)
         VALUES ('invitation', $1, 'invitation.viewed', NULL, '{}'::jsonb)`,
        [inv.id])
    }

    const existingUser = await queryOne<any>(
      `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [inv.email])

    res.json({
      success: true,
      data: {
        id:          inv.id,
        email:       inv.email,
        role:        inv.role,
        status:      inv.status,
        expiresAt:   inv.expires_at,
        inviterName: inv.inviter_business
          || [inv.inviter_first, inv.inviter_last].filter(Boolean).join(' ')
          || 'Your landlord',
        userExists:  !!existingUser,
      }
    })
  } catch (e) { next(e) }
})

// POST /api/invitations/:token/accept
invitationsRouter.post('/:token/accept', async (req, res, next) => {
  try {
    const body = z.object({
      password:  z.string().min(8).optional(),
      firstName: z.string().min(1).optional(),
      lastName:  z.string().min(1).optional(),
      phone:     z.string().optional(),
    }).parse(req.body)

    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Lock the invitation row to prevent double-accept races
      const invRes = await client.query(
        `SELECT * FROM invitations WHERE token = $1 FOR UPDATE`,
        [req.params.token])
      const inv = invRes.rows[0]
      if (!inv) throw new AppError(404, 'Invitation not found')
      if (inv.status !== 'pending') throw new AppError(400, `Invitation is ${inv.status}`)
      if (new Date(inv.expires_at) <= new Date()) throw new AppError(400, 'Invitation has expired')

      const role = inv.role as LandlordAssignableRole
      if (!isAssignableRole(role)) throw new AppError(500, 'Invitation has invalid role')

      // Find or create the user
      const userRes = await client.query(
        `SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1`,
        [inv.email])
      let user = userRes.rows[0]

      if (!user) {
        if (!body.password) throw new AppError(400, 'Password required for new account')
        if (!body.firstName || !body.lastName) throw new AppError(400, 'First and last name required')
        const hash = await bcrypt.hash(body.password, 12)
        const newUser = await client.query(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [inv.email, hash, role, body.firstName, body.lastName, body.phone || null])
        user = newUser.rows[0]
      } else {
        // Existing account: only allow accept if existing role matches the invite role.
        // A landlord/tenant/admin cannot be rewritten into a worker role by accepting.
        // A worker role user can take additional scope with another landlord only if
        // the invite is for the same worker role they already have.
        if (user.role !== role) {
          throw new AppError(409, `This email is already registered as ${user.role}`)
        }
      }

      // Scope-row uniqueness per landlord + user
      const table = SCOPE_TABLES[role]
      const existingScope = await client.query(
        `SELECT 1 FROM ${table} WHERE user_id = $1 AND landlord_id = $2 LIMIT 1`,
        [user.id, inv.landlord_id])
      if (existingScope.rows.length) throw new AppError(409, 'Scope already exists for this user and landlord')

      const scopePayload = typeof inv.scope_payload === 'string'
        ? JSON.parse(inv.scope_payload)
        : inv.scope_payload
      const scopeRow = await insertScopeRow(client, role, user.id, inv.landlord_id, scopePayload)

      await client.query(
        `UPDATE invitations
         SET status = 'accepted', accepted_at = NOW(), accepted_user_id = $1
         WHERE id = $2`,
        [user.id, inv.id])

      await client.query(
        `INSERT INTO platform_events (subject_type, subject_id, event_type, actor_user_id, payload)
         VALUES ('invitation', $1, 'invitation.accepted', $2, '{}'::jsonb)`,
        [inv.id, user.id])

      await client.query('COMMIT')
      res.json({ success: true, data: { userId: user.id, role, scope: scopeRow } })
    } catch (e: any) {
      await client.query('ROLLBACK')
      // S349: the invite-time onsite-manager uniqueness guard (scopes.ts:378)
      // is racy — two landlords can each create pending invites for the
      // same email before either is accepted. The schema enforces
      // platform-wide one-landlord-per-onsite-manager via
      // UNIQUE(user_id) on onsite_manager_scopes; pre-S349 the
      // accept-time race produced a 500 with the raw postgres
      // constraint-violation message. Translate to a clean 409.
      if (e?.code === '23505' && e?.constraint === 'onsite_manager_scopes_user_id_key') {
        return next(new AppError(409, 'This user is already an on-site manager for another landlord'))
      }
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})
