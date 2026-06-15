/**
 * S456 — business_users + business_user_invitations routes.
 *
 * Six endpoints serving the staff-membership lifecycle:
 *
 *   POST   /api/business-users/invite                         (owner)
 *   GET    /api/business-users/invitations/:token             (public)
 *   POST   /api/business-users/invitations/:token/accept      (public)
 *   GET    /api/business-users                                (owner)
 *   PATCH  /api/business-users/:id                            (owner)
 *   POST   /api/business-users/:id/revoke                     (owner)
 *
 * Invitation flow mirrors sublessee_invitations (S247) — token in URL is
 * the only credential, email-out at create time, single-call accept that
 * creates the users row + business_users scope row atomically.
 */

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { isDisposableEmail } from '../lib/email'
import { emailBusinessInvitation } from '../services/email'
import { logger } from '../lib/logger'
import {
  BUSINESS_STAFF_ROLES,
  BUSINESS_STAFF_PERMISSIONS,
  BUSINESS_STAFF_PERMISSIONS_BY_ROLE,
  BusinessStaffPermission,
} from '@gam/shared'

export const businessUsersRouter = Router()

const PASSWORD_MIN_LEN = 12
const INVITATION_TTL_HOURS = 24

// ── helpers ────────────────────────────────────────────────────

/** Resolve the businessId for the calling owner. Errors if non-owner
 *  or no active business. Centralized so each endpoint has the same
 *  gate semantics. */
async function requireOwnerBusinessId(req: any): Promise<string> {
  if (req.user!.role !== 'business_owner') {
    throw new AppError(403, 'Only business owners can manage staff')
  }
  const biz = await queryOne<{ id: string }>(
    `SELECT id FROM businesses
      WHERE owner_user_id = $1 AND status IN ('active', 'suspended')
      ORDER BY created_at DESC LIMIT 1`,
    [req.user!.userId])
  if (!biz) throw new AppError(404, 'No active business for this owner')
  return biz.id
}

// ═══════════════════════════════════════════════════════════════
//  POST /invite  (owner creates invitation)
// ═══════════════════════════════════════════════════════════════

// S502: permissions is now an array of grants from the catalog. Omit
// to use the role-default; pass an explicit array to override at invite
// time. Owner can also edit any time via PATCH after the staff member
// accepts.
const inviteSchema = z.object({
  email:       z.string().email(),
  staffRole:   z.enum(BUSINESS_STAFF_ROLES),
  permissions: z.array(z.enum(BUSINESS_STAFF_PERMISSIONS)).optional(),
})

businessUsersRouter.post('/invite', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const body = inviteSchema.parse(req.body)

    if (isDisposableEmail(body.email)) {
      throw new AppError(400, 'Disposable / temporary email addresses are not allowed')
    }

    // Pre-flight: if a user with this email already has a business_users
    // row in THIS business (active or invited), refuse with 409.
    const existingScope = await queryOne<{ id: string }>(
      `SELECT bu.id
         FROM business_users bu
         JOIN users u ON u.id = bu.user_id
        WHERE bu.business_id = $1
          AND LOWER(u.email) = LOWER($2)
          AND bu.status <> 'revoked'`,
      [businessId, body.email])
    if (existingScope) {
      throw new AppError(409, 'This person is already part of your team')
    }
    // Same pre-flight against an outstanding invitation (sent status,
    // not expired). If they already have an open invite, no need to
    // spam-send a second.
    const existingInvite = await queryOne<{ id: string }>(
      `SELECT id FROM business_user_invitations
        WHERE business_id = $1
          AND LOWER(email) = LOWER($2)
          AND status = 'sent'
          AND expires_at > NOW()`,
      [businessId, body.email])
    if (existingInvite) {
      throw new AppError(409, 'An open invitation already exists for this email')
    }

    const token = crypto.randomBytes(32).toString('hex')
    const { rows: [inv] } = await db.query<{
      id: string; token: string; email: string; staff_role: string; expires_at: string
    }>(
      `INSERT INTO business_user_invitations
         (business_id, invited_by_user_id, token, email, staff_role,
          permissions, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' hours')::interval)
       RETURNING id, token, email, staff_role, expires_at`,
      [businessId, req.user!.userId, token, body.email,
       body.staffRole,
       JSON.stringify(body.permissions
         ?? BUSINESS_STAFF_PERMISSIONS_BY_ROLE[body.staffRole]),
       String(INVITATION_TTL_HOURS)])

    // Fire-and-forget email. Failure shouldn't fail the API call —
    // owner can re-send via a (future) /resend endpoint. Logged in
    // email_send_log via services/email.ts:send.
    try {
      const bizRow = await queryOne<{ name: string }>(
        `SELECT name FROM businesses WHERE id = $1`, [businessId])
      const inviterRow = await queryOne<{ first_name: string | null; last_name: string | null }>(
        `SELECT first_name, last_name FROM users WHERE id = $1`,
        [req.user!.userId])
      const base = process.env.BUSINESS_INVITE_URL
        || 'http://localhost:3012/accept-invitation'
      const acceptUrl = `${base}?token=${encodeURIComponent(token)}`
      const inviterName = [inviterRow?.first_name, inviterRow?.last_name]
        .filter(Boolean).join(' ') || 'A business owner'
      emailBusinessInvitation(
        body.email,
        inviterName,
        bizRow?.name ?? 'a GAM business',
        body.staffRole,
        acceptUrl,
        { businessId, invitationId: inv.id })
        .catch((e) => {
          // fire-and-forget — async rejection from the mailer falls
          // here. Logged for ops visibility; doesn't fail the API.
          logger.error({ err: e, ctx: inv.id }, '[business-invite] email-send rejected:')
        })
    } catch (e) {
      // Synchronous throw — context-load failures (DB queries above)
      // get caught here. Email-send rejection is the .catch chain.
      logger.error({ err: e, ctx: inv.id }, '[business-invite] email-context threw:')
    }

    res.status(201).json({
      success: true,
      data: {
        id: inv.id,
        email: inv.email,
        staffRole: inv.staff_role,
        expiresAt: inv.expires_at,
      },
    })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /invitations/:token  (public preview)
// ═══════════════════════════════════════════════════════════════

interface InvitationRow {
  id:           string
  business_id:  string
  email:        string
  staff_role:   string
  status:       string
  expires_at:   string
}

async function loadInvitation(token: string): Promise<InvitationRow | null> {
  return queryOne<InvitationRow>(
    `SELECT id, business_id, email, staff_role, status, expires_at::text
       FROM business_user_invitations
      WHERE token = $1 LIMIT 1`,
    [token])
}

function isExpired(row: InvitationRow): boolean {
  return new Date(row.expires_at).getTime() < Date.now()
}

businessUsersRouter.get('/invitations/:token', async (req, res, next) => {
  try {
    const inv = await loadInvitation(req.params.token)
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status !== 'sent') {
      throw new AppError(409, `Invitation is ${inv.status}`)
    }
    if (isExpired(inv)) {
      throw new AppError(410, 'Invitation has expired')
    }
    const ctx = await queryOne<{ name: string; inviter_name: string }>(
      `SELECT b.name,
              u.first_name || ' ' || u.last_name AS inviter_name
         FROM businesses b
         JOIN users u ON u.id = b.owner_user_id
        WHERE b.id = $1`, [inv.business_id])
    if (!ctx) throw new AppError(404, 'Business context vanished')
    res.json({
      success: true,
      data: {
        business_name: ctx.name,
        inviter_name:  ctx.inviter_name,
        email:         inv.email,
        staff_role:    inv.staff_role,
        expires_at:    inv.expires_at,
      },
    })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /invitations/:token/accept  (public — creates user + scope)
// ═══════════════════════════════════════════════════════════════

const acceptSchema = z.object({
  firstName: z.string().min(1),
  lastName:  z.string().min(1),
  password:  z.string().min(PASSWORD_MIN_LEN),
  phone:     z.string().optional(),
})

businessUsersRouter.post('/invitations/:token/accept', async (req, res, next) => {
  try {
    const body = acceptSchema.parse(req.body)
    const inv = await loadInvitation(req.params.token)
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status !== 'sent') throw new AppError(409, `Invitation is ${inv.status}`)
    if (isExpired(inv)) throw new AppError(410, 'Invitation has expired')

    // Email collision — if a user exists with this email already, refuse.
    // Same posture as sublease_invitations: the invitee already has a
    // GAM account; owner needs to re-issue via the in-app path (future).
    const existingUser = await queryOne<{ id: string }>(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [inv.email])
    if (existingUser) {
      throw new AppError(409,
        'An account with this email already exists. Ask the business owner to add you directly from the staff list.')
    }

    const hash = await bcrypt.hash(body.password, 12)
    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [user] } = await client.query<{
        id: string; email: string; first_name: string; last_name: string
      }>(
        `INSERT INTO users
           (email, password_hash, role, first_name, last_name, phone,
            accepted_tos_at, accepted_privacy_at, email_verified)
         VALUES ($1, $2, 'business_staff', $3, $4, $5, NOW(), NOW(), TRUE)
         RETURNING id, email, first_name, last_name`,
        [inv.email, hash, body.firstName, body.lastName, body.phone ?? null])

      // Permissions came from the invite row; we pass them through to
      // the scope so the JWT login flow sees them on next /login.
      await client.query(
        `INSERT INTO business_users
           (business_id, user_id, staff_role, permissions, status,
            invited_at, accepted_at)
         VALUES ($1, $2, $3,
                 (SELECT permissions FROM business_user_invitations WHERE id = $4),
                 'active',
                 (SELECT created_at FROM business_user_invitations WHERE id = $4),
                 NOW())`,
        [inv.business_id, user.id, inv.staff_role, inv.id])

      await client.query(
        `UPDATE business_user_invitations
            SET status = 'accepted',
                accepted_user_id = $1,
                accepted_at = NOW()
          WHERE id = $2`,
        [user.id, inv.id])

      await client.query('COMMIT')

      const token = jwt.sign(
        { userId:     user.id,
          role:       'business_staff',
          email:      user.email,
          profileId:  inv.business_id,
          businessId: inv.business_id,
          staffRole:  inv.staff_role },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' })

      res.status(201).json({
        success: true,
        data: {
          token,
          user: {
            id: user.id, email: user.email, role: 'business_staff',
            firstName: user.first_name, lastName: user.last_name,
            profileId:  inv.business_id,
            businessId: inv.business_id,
            staffRole:  inv.staff_role,
          },
        },
      })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /  (owner lists staff + pending invitations)
// ═══════════════════════════════════════════════════════════════

businessUsersRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const staff = await query<any>(
      `SELECT bu.id, bu.user_id, bu.staff_role, bu.permissions, bu.status,
              bu.invited_at, bu.accepted_at, bu.revoked_at,
              u.email, u.first_name, u.last_name
         FROM business_users bu
         JOIN users u ON u.id = bu.user_id
        WHERE bu.business_id = $1
        ORDER BY bu.status DESC, bu.created_at DESC`,
      [businessId])
    const pendingInvites = await query<any>(
      `SELECT id, email, staff_role, expires_at, created_at
         FROM business_user_invitations
        WHERE business_id = $1
          AND status = 'sent'
          AND expires_at > NOW()
        ORDER BY created_at DESC`,
      [businessId])
    res.json({ success: true, data: { staff, pendingInvites } })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id  (owner updates staff_role / permissions)
// ═══════════════════════════════════════════════════════════════

// S502: permissions is now a string array of grants from the shared
// BUSINESS_STAFF_PERMISSIONS catalog. Special control flag
// `resetToRoleDefault: true` skips the permissions array and recomputes
// from BUSINESS_STAFF_PERMISSIONS_BY_ROLE — handy when an owner has
// over-customized and wants to start fresh.
const patchSchema = z.object({
  staffRole:           z.enum(BUSINESS_STAFF_ROLES).optional(),
  permissions:         z.array(z.enum(BUSINESS_STAFF_PERMISSIONS)).optional(),
  resetToRoleDefault:  z.boolean().optional(),
}).strict()

businessUsersRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const patch = patchSchema.parse(req.body)
    if (Object.keys(patch).length === 0) {
      throw new AppError(400, 'Nothing to update')
    }

    // Resolve the new permissions array.
    let permsToWrite: BusinessStaffPermission[] | null = null
    if (patch.resetToRoleDefault) {
      // Need the effective staff_role — either the one in this patch or
      // the existing row's role.
      let role = patch.staffRole
      if (!role) {
        const existing = await queryOne<{ staff_role: string }>(
          `SELECT staff_role FROM business_users
            WHERE id = $1 AND business_id = $2`,
          [req.params.id, businessId])
        if (!existing) throw new AppError(404, 'Staff member not found')
        role = existing.staff_role as any
      }
      permsToWrite = BUSINESS_STAFF_PERMISSIONS_BY_ROLE[role!]
    } else if (patch.permissions !== undefined) {
      // Dedupe + keep the catalog order so the editor doesn't see a
      // surprise reorder after PATCH.
      const grantedSet = new Set(patch.permissions)
      permsToWrite = BUSINESS_STAFF_PERMISSIONS.filter(p => grantedSet.has(p))
    }

    const r = await query<{ id: string; staff_role: string; permissions: any }>(
      `UPDATE business_users
          SET staff_role  = COALESCE($1, staff_role),
              permissions = COALESCE($2, permissions)
        WHERE id = $3 AND business_id = $4
        RETURNING id, staff_role, permissions`,
      [patch.staffRole ?? null,
       permsToWrite ? JSON.stringify(permsToWrite) : null,
       req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Staff member not found')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/revoke  (owner revokes a staff member)
// ═══════════════════════════════════════════════════════════════

businessUsersRouter.post('/:id/revoke', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const r = await query<{ id: string; status: string }>(
      `UPDATE business_users
          SET status = 'revoked', revoked_at = NOW()
        WHERE id = $1 AND business_id = $2 AND status <> 'revoked'
        RETURNING id, status`,
      [req.params.id, businessId])
    if (r.length === 0) {
      // Either not in this business OR already revoked — both 404 here
      // to avoid leaking "already revoked" as a distinct response.
      throw new AppError(404, 'Staff member not found')
    }
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})
