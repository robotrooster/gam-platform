import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { emailInvitation } from '../services/email'
import {
  LANDLORD_ASSIGNABLE_ROLES,
  LandlordAssignableRole,
  MAINTENANCE_JOB_CATEGORIES,
  BOOKKEEPER_ACCESS_LEVELS,
} from '@gam/shared'

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
  propertyIds: z.array(z.string().uuid()).default([]),
  unitIds:     z.array(z.string().uuid()).default([]),
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

// Only landlords manage their own scoped users. Admin/super_admin can
// optionally pass ?landlordId=... but we do not expose that in the UI yet.
function getLandlordIdFromReq(req: any): string {
  if (req.user?.role === 'landlord') return req.user.profileId
  if (req.user?.role === 'admin' || req.user?.role === 'super_admin') {
    const lid = req.query?.landlordId || req.body?.landlordId
    if (!lid) throw new AppError(400, 'landlordId required for admin calls')
    return String(lid)
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
           (user_id, landlord_id, property_ids, unit_ids)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [userId, landlordId, payload.propertyIds, payload.unitIds])
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

// GET /api/scopes/:roleType — scoped users + invitations for this role
scopesRouter.get('/:roleType', requireLandlord, async (req, res, next) => {
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
scopesRouter.post('/:roleType/invite', requireLandlord, async (req, res, next) => {
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
      emailInvitation(body.email, inviterName, role, buildAcceptUrl(token))
        .catch(e => console.error('[EMAIL] invite failed', e))

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

// PATCH /api/scopes/:roleType/:userId — update scope row
scopesRouter.patch('/:roleType/:userId', requireLandlord, async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    const landlordId = getLandlordIdFromReq(req)
    const scope = validateScopePayload(role, req.body)

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
scopesRouter.delete('/:roleType/:userId', requireLandlord, async (req, res, next) => {
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
scopesRouter.post('/invitations/:id/resend', requireLandlord, async (req, res, next) => {
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
      emailInvitation(inv.email, inviterName, inv.role, buildAcceptUrl(token))
        .catch(e => console.error('[EMAIL] resend failed', e))

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
scopesRouter.post('/invitations/:id/revoke', requireLandlord, async (req, res, next) => {
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
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})
