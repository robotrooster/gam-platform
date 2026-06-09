// PM (third-party property-management) companies router. Schema landed S108;
// this file (S109) wires the CRUD surface for pm_companies + pm_staff +
// pm_fee_plans plus the cross-table invariant checks.
//
// Auth model:
//   - Any authenticated user can create a pm_company. They auto-become
//     role='owner' on a new pm_staff row in the same transaction.
//   - role='owner' can: edit company details, invite/remove staff, edit
//     any staff role, create/edit/deprecate fee plans, set bank_account_id
//   - role='manager' can: edit company details, edit fee plans, view all
//     staff. Cannot remove other managers/owners.
//   - role='staff' can: view company details, view assigned properties,
//     act on maintenance for those properties.
//
// Property assignment lives in routes/properties.ts (PATCH /:id/pm-
// assignment) since it mutates a property, not a pm_company.
//
// Allocation-engine fee-cut routing + owner-visibility view + parallel
// pm_staff maintenance notification land in S110.

import { Router } from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'

// S321: camelCase wire-format. Backend zod schemas accept camelCase
// keys (matching the frontend wire shape per packages/shared/src/
// camelize.ts), and this helper maps each accepted body key back to
// its snake_case DB column name for the dynamic UPDATE sites below.
function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
}
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { emailPmInvitation, emailPmPropertyInvitation } from '../services/email'
import {
  PM_COMPANY_STATUSES, PM_STAFF_ROLES, PM_STAFF_STATUSES,
  PM_FEE_TYPES, PM_FEE_PLAN_STATUSES,
  PM_LINK_SCOPES,
  type PmStaffRole,
} from '@gam/shared'
import {
  sendPropertyInvitation, acceptPropertyInvitation,
  rejectPropertyInvitation, revokePropertyInvitation,
} from '../services/pm'
import {
  ensureConnectAccount, createOnboardingSession, fetchAccountStatus,
} from '../services/stripeConnect'
import { logger } from '../lib/logger'

export const pmRouter = Router()

// ── public accept endpoint (no auth wall — recipient may not yet have an
// account; the route itself decides what to do based on token state) ──
const pmInvitationsPublicRouter = Router()
pmRouter.use('/invitations', pmInvitationsPublicRouter)

// authenticated routes for everything else
pmRouter.use(requireAuth)

const INVITATION_TTL_HOURS = 24
const ACCEPT_URL_BASE = process.env.PM_ACCEPT_URL_BASE
  || `${process.env.LANDLORD_APP_URL || 'http://localhost:3001'}/pm/accept-invitation`

function buildPmAcceptUrl(token: string): string {
  return `${ACCEPT_URL_BASE}?token=${encodeURIComponent(token)}`
}

// ── helper: assert caller is staff of this pm_company in one of the allowed roles ──
//
// S353: also checks pm_companies.status. A 'suspended' company locks
// out all staff (including owners) from every pm.ts route — the
// status is intended for regulatory / compliance / dispute pauses
// where the platform needs to freeze operations until external
// review clears. Re-activation requires super_admin / DB override
// by design (a suspended company cannot unsuspend itself; that
// would defeat the purpose of suspension).
//
// 'inactive' status does NOT lock out — it's the soft self-pause
// state for companies that aren't currently operating but retain
// self-service control.
async function assertPmStaffRole(
  userId: string,
  pmCompanyId: string,
  allowedRoles: PmStaffRole[]
): Promise<void> {
  const row = await queryOne<{ role: PmStaffRole; status: string; company_status: string }>(
    `SELECT s.role, s.status, c.status AS company_status
       FROM pm_staff s
       JOIN pm_companies c ON c.id = s.pm_company_id
      WHERE s.pm_company_id=$1 AND s.user_id=$2`,
    [pmCompanyId, userId]
  )
  if (!row || row.status !== 'active') {
    throw new AppError(403, 'Not a staff member of this PM company')
  }
  if (row.company_status === 'suspended') {
    throw new AppError(403, 'PM company is suspended; contact platform support')
  }
  if (!allowedRoles.includes(row.role)) {
    throw new AppError(403, `Requires role: ${allowedRoles.join(' or ')}`)
  }
}

// ── COMPANIES ─────────────────────────────────────────────────────────────

// GET /api/pm/companies — list pm_companies the caller is staff of
pmRouter.get('/companies', async (req: any, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT c.id, c.name, c.business_email, c.business_phone, c.status,
             c.created_at, c.updated_at, c.bank_account_id, c.ein,
             s.role AS my_role, s.status AS my_membership_status
        FROM pm_companies c
        JOIN pm_staff s ON s.pm_company_id = c.id
       WHERE s.user_id = $1 AND s.status = 'active'
       ORDER BY c.name ASC
    `, [req.user!.userId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/pm/companies — create new pm_company; caller becomes owner
pmRouter.post('/companies', async (req: any, res, next) => {
  try {
    const body = z.object({
      name: z.string().min(1).max(200),
      businessEmail: z.string().email().nullish(),
      businessPhone: z.string().max(50).nullish(),
      businessStreet1: z.string().max(200).nullish(),
      businessCity: z.string().max(100).nullish(),
      businessState: z.string().max(50).nullish(),
      businessZip: z.string().max(20).nullish(),
      ein: z.string().max(20).nullish(),
    }).parse(req.body)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const company = (await client.query(
        `INSERT INTO pm_companies (
           name, business_email, business_phone,
           business_street1, business_city, business_state, business_zip,
           ein, created_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [body.name, body.businessEmail ?? null, body.businessPhone ?? null,
         body.businessStreet1 ?? null, body.businessCity ?? null,
         body.businessState ?? null, body.businessZip ?? null,
         body.ein ?? null, req.user!.userId]
      )).rows[0]
      await client.query(
        `INSERT INTO pm_staff (pm_company_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'owner', 'active', NOW())`,
        [company.id, req.user!.userId]
      )
      await client.query('COMMIT')
      res.status(201).json({ success: true, data: company })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// GET /api/pm/companies/:id — full company detail (any active staff member)
pmRouter.get('/companies/:id', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager', 'staff'])
    const company = await queryOne<any>(`SELECT * FROM pm_companies WHERE id=$1`, [req.params.id])
    if (!company) throw new AppError(404, 'PM company not found')
    res.json({ success: true, data: company })
  } catch (e) { next(e) }
})

// PATCH /api/pm/companies/:id — owner or manager
pmRouter.patch('/companies/:id', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager'])
    const body = z.object({
      name: z.string().min(1).max(200).optional(),
      businessEmail: z.string().email().nullable().optional(),
      businessPhone: z.string().max(50).nullable().optional(),
      businessStreet1: z.string().max(200).nullable().optional(),
      businessCity: z.string().max(100).nullable().optional(),
      businessState: z.string().max(50).nullable().optional(),
      businessZip: z.string().max(20).nullable().optional(),
      ein: z.string().max(20).nullable().optional(),
      bankAccountId: z.string().uuid().nullable().optional(),
      status: z.enum(PM_COMPANY_STATUSES).optional(),
    }).parse(req.body)

    // S353: bank_account_id and status are both owner-only.
    //   - bank_account_id: payout routing is sensitive.
    //   - status: company-existential decision (suspending the company
    //     locks every staff member out, so it must require the highest
    //     trust tier). Pre-S353 a manager could flip status to
    //     suspended/inactive.
    if (body.bankAccountId !== undefined || body.status !== undefined) {
      await assertPmStaffRole(req.user!.userId, req.params.id, ['owner'])
    }

    const fields: string[] = []
    const params: any[] = []
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue
      params.push(v)
      fields.push(`${toSnake(k)} = $${params.length}`)
    }
    if (fields.length === 0) throw new AppError(400, 'No fields to update')
    params.push(req.params.id)
    const updated = await queryOne<any>(
      `UPDATE pm_companies SET ${fields.join(', ')}, updated_at=NOW()
        WHERE id = $${params.length} RETURNING *`,
      params
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── STAFF ─────────────────────────────────────────────────────────────────

// GET /api/pm/companies/:id/staff — list staff (any active member)
pmRouter.get('/companies/:id/staff', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager', 'staff'])
    const rows = await query<any>(`
      SELECT s.id, s.user_id, s.role, s.status, s.permissions,
             s.invited_by_user_id, s.joined_at, s.removed_at, s.created_at,
             u.email, u.first_name, u.last_name
        FROM pm_staff s
        JOIN users u ON u.id = s.user_id
       WHERE s.pm_company_id = $1
       ORDER BY
         CASE s.role WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END,
         u.last_name ASC, u.first_name ASC
    `, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/pm/companies/:id/staff — add staff member by user_id (owner only)
// NOTE: invitation flow (email + accept) is a separate session; this is the
// "add an existing user" admin path.
pmRouter.post('/companies/:id/staff', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner'])
    const body = z.object({
      userId: z.string().uuid(),
      role: z.enum(PM_STAFF_ROLES).default('staff'),
      permissions: z.record(z.any()).default({}),
    }).parse(req.body)

    // Confirm the user exists
    const user = await queryOne<{ id: string }>(`SELECT id FROM users WHERE id=$1`, [body.userId])
    if (!user) throw new AppError(404, 'User not found')

    try {
      const row = await queryOne<any>(
        `INSERT INTO pm_staff (pm_company_id, user_id, role, permissions, status, invited_by_user_id, joined_at)
         VALUES ($1, $2, $3, $4, 'active', $5, NOW())
         RETURNING *`,
        [req.params.id, body.userId, body.role, JSON.stringify(body.permissions), req.user!.userId]
      )
      res.status(201).json({ success: true, data: row })
    } catch (e: any) {
      if (e.code === '23505' && e.constraint === 'pm_staff_unique_membership') {
        throw new AppError(409, 'User already a staff member of this company')
      }
      throw e
    }
  } catch (e) { next(e) }
})

// PATCH /api/pm/companies/:id/staff/:staffId — change role/permissions/status
pmRouter.patch('/companies/:id/staff/:staffId', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner'])
    const body = z.object({
      role: z.enum(PM_STAFF_ROLES).optional(),
      permissions: z.record(z.any()).optional(),
      status: z.enum(PM_STAFF_STATUSES).optional(),
    }).parse(req.body)

    // Block self-demotion / self-removal of the only owner
    if (body.role === 'staff' || body.role === 'manager' || body.status === 'removed' || body.status === 'inactive') {
      const target = await queryOne<{ userId: string; role: PmStaffRole }>(
        `SELECT user_id, role FROM pm_staff WHERE id=$1 AND pm_company_id=$2`,
        [req.params.staffId, req.params.id]
      )
      if (target && target.role === 'owner') {
        const otherOwners = await queryOne<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM pm_staff
            WHERE pm_company_id=$1 AND role='owner' AND status='active' AND id <> $2`,
          [req.params.id, req.params.staffId]
        )
        if ((otherOwners?.c ?? 0) === 0) {
          throw new AppError(409, 'Cannot demote/remove the last active owner')
        }
      }
    }

    const fields: string[] = []
    const params: any[] = []
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue
      params.push(k === 'permissions' ? JSON.stringify(v) : v)
      fields.push(`${toSnake(k)} = $${params.length}`)
    }
    if (body.status === 'removed') fields.push(`removed_at = NOW()`)
    if (fields.length === 0) throw new AppError(400, 'No fields to update')
    params.push(req.params.staffId, req.params.id)
    const updated = await queryOne<any>(
      `UPDATE pm_staff SET ${fields.join(', ')}, updated_at=NOW()
        WHERE id = $${params.length - 1} AND pm_company_id = $${params.length}
        RETURNING *`,
      params
    )
    if (!updated) throw new AppError(404, 'Staff row not found')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── FEE PLANS ─────────────────────────────────────────────────────────────

// GET /api/pm/companies/:id/fee-plans
pmRouter.get('/companies/:id/fee-plans', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager', 'staff'])
    const rows = await query<any>(
      `SELECT * FROM pm_fee_plans WHERE pm_company_id=$1 ORDER BY status ASC, name ASC`,
      [req.params.id]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/pm/companies/:id/fee-plans
pmRouter.post('/companies/:id/fee-plans', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager'])
    const body = z.object({
      name: z.string().min(1).max(200),
      feeType: z.enum(PM_FEE_TYPES),
      percent: z.number().min(0).max(100).nullish(),
      flatAmount: z.number().min(0).nullish(),
      floorAmount: z.number().min(0).nullish(),
      ceilingAmount: z.number().min(0).nullish(),
      leasingFeeAmount: z.number().min(0).nullish(),
      maintenanceMarkupPct: z.number().min(0).max(100).nullish(),
    }).parse(req.body)

    // Per-fee_type required-field guard. The schema CHECK is loose by design
    // (S108 architecture decision); the route enforces shape.
    const requirePresent = (field: string, value: any) => {
      if (value === null || value === undefined) {
        throw new AppError(400, `${body.feeType} requires ${field}`)
      }
    }
    switch (body.feeType) {
      case 'percent_of_rent':         requirePresent('percent', body.percent); break
      case 'flat_monthly':            requirePresent('flatAmount', body.flatAmount); break
      case 'percent_with_floor':      requirePresent('percent', body.percent); requirePresent('floorAmount', body.floorAmount); break
      case 'percent_with_ceiling':    requirePresent('percent', body.percent); requirePresent('ceilingAmount', body.ceilingAmount); break
      case 'per_unit':                requirePresent('flatAmount', body.flatAmount); break
      case 'leasing_fee':             requirePresent('leasingFeeAmount', body.leasingFeeAmount); break
      case 'maintenance_markup_pct': requirePresent('maintenanceMarkupPct', body.maintenanceMarkupPct); break
    }

    const row = await queryOne<any>(
      `INSERT INTO pm_fee_plans (
         pm_company_id, name, fee_type,
         percent, flat_amount, floor_amount, ceiling_amount,
         leasing_fee_amount, maintenance_markup_pct
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, body.name, body.feeType,
       body.percent ?? null, body.flatAmount ?? null,
       body.floorAmount ?? null, body.ceilingAmount ?? null,
       body.leasingFeeAmount ?? null, body.maintenanceMarkupPct ?? null]
    )
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

// PATCH /api/pm/companies/:id/fee-plans/:planId
pmRouter.patch('/companies/:id/fee-plans/:planId', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager'])
    const body = z.object({
      name: z.string().min(1).max(200).optional(),
      percent: z.number().min(0).max(100).nullable().optional(),
      flatAmount: z.number().min(0).nullable().optional(),
      floorAmount: z.number().min(0).nullable().optional(),
      ceilingAmount: z.number().min(0).nullable().optional(),
      leasingFeeAmount: z.number().min(0).nullable().optional(),
      maintenanceMarkupPct: z.number().min(0).max(100).nullable().optional(),
      status: z.enum(PM_FEE_PLAN_STATUSES).optional(),
    }).parse(req.body)

    const fields: string[] = []
    const params: any[] = []
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue
      params.push(v)
      fields.push(`${toSnake(k)} = $${params.length}`)
    }
    if (fields.length === 0) throw new AppError(400, 'No fields to update')
    params.push(req.params.planId, req.params.id)
    const updated = await queryOne<any>(
      `UPDATE pm_fee_plans SET ${fields.join(', ')}, updated_at=NOW()
        WHERE id = $${params.length - 1} AND pm_company_id = $${params.length}
        RETURNING *`,
      params
    )
    if (!updated) throw new AppError(404, 'Fee plan not found')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── INVITATIONS (S112) ────────────────────────────────────────────────────
// Email + accept-token flow for adding new staff to a pm_company without
// the inviter needing the recipient's pre-existing user_id. Mirrors the
// in-house invitations pattern from S80 but scoped to pm_company.
//
// Lifecycle:
//   POST   /companies/:id/invitations        — owner sends invite (creates
//                                              row + emails token)
//   GET    /companies/:id/invitations        — active staff list pending
//                                              + recent
//   POST   /companies/:id/invitations/:i/resend  — owner regenerates token
//                                                  + resends email
//   DELETE /companies/:id/invitations/:i     — owner revokes pending invite
//   POST   /invitations/accept               — public, by token. Creates
//                                              the pm_staff row binding
//                                              the calling user to the
//                                              company. (Recipient must
//                                              have a GAM user account
//                                              first; signup flow is
//                                              outside this route.)

pmRouter.post('/companies/:id/invitations', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner'])
    const body = z.object({
      email: z.string().email(),
      role: z.enum(PM_STAFF_ROLES).default('staff'),
      permissions: z.record(z.any()).default({}),
    }).parse(req.body)
    const emailNorm = body.email.toLowerCase().trim()

    const company = await queryOne<{ name: string }>(
      `SELECT name FROM pm_companies WHERE id=$1`, [req.params.id]
    )
    if (!company) throw new AppError(404, 'PM company not found')

    // Block duplicate-pending and duplicate-membership.
    const existingMembership = await queryOne<{ id: string }>(
      `SELECT s.id FROM pm_staff s
       JOIN users u ON u.id=s.user_id
       WHERE s.pm_company_id=$1 AND lower(u.email)=$2 AND s.status='active'`,
      [req.params.id, emailNorm]
    )
    if (existingMembership) {
      throw new AppError(409, 'A user with this email is already an active staff member')
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000)

    const inviterRow = await queryOne<{ first_name: string; last_name: string }>(
      `SELECT first_name, last_name FROM users WHERE id=$1`, [req.user!.userId]
    )
    const inviterName = inviterRow ? `${inviterRow.first_name} ${inviterRow.last_name}`.trim() : 'A team member'

    let inv: any
    try {
      inv = await queryOne<any>(
        `INSERT INTO pm_invitations
           (pm_company_id, email, role, permissions, invited_by_user_id, token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.params.id, emailNorm, body.role, JSON.stringify(body.permissions),
         req.user!.userId, token, expiresAt]
      )
    } catch (e: any) {
      if (e.code === '23505' && e.constraint === 'pm_invitations_unique_pending') {
        throw new AppError(409, 'A pending invitation already exists for this email')
      }
      throw e
    }

    emailPmInvitation(emailNorm, inviterName, company.name, body.role, buildPmAcceptUrl(token),
      { pmCompanyId: req.params.id, invitationId: inv.id })
      .catch(e => logger.error({ err: e }, '[EMAIL pm_invitation send failed]'))

    res.status(201).json({ success: true, data: inv })
  } catch (e) { next(e) }
})

pmRouter.get('/companies/:id/invitations', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager', 'staff'])
    const rows = await query<any>(`
      SELECT id, email, role, status, expires_at, accepted_at, revoked_at, created_at
        FROM pm_invitations
       WHERE pm_company_id=$1
       ORDER BY status='pending' DESC, created_at DESC
       LIMIT 100
    `, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

pmRouter.post('/companies/:id/invitations/:invId/resend', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner'])
    const inv = await queryOne<any>(
      `SELECT * FROM pm_invitations WHERE id=$1 AND pm_company_id=$2`,
      [req.params.invId, req.params.id]
    )
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status !== 'pending') throw new AppError(409, `Cannot resend a ${inv.status} invitation`)

    const company = await queryOne<{ name: string }>(`SELECT name FROM pm_companies WHERE id=$1`, [req.params.id])
    const inviterRow = await queryOne<{ first_name: string; last_name: string }>(
      `SELECT first_name, last_name FROM users WHERE id=$1`, [req.user!.userId]
    )
    const inviterName = inviterRow ? `${inviterRow.first_name} ${inviterRow.last_name}`.trim() : 'A team member'

    const newToken = crypto.randomBytes(32).toString('hex')
    const newExpires = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000)
    const updated = await queryOne<any>(
      `UPDATE pm_invitations SET token=$1, expires_at=$2 WHERE id=$3 RETURNING *`,
      [newToken, newExpires, inv.id]
    )

    emailPmInvitation(inv.email, inviterName, company!.name, inv.role, buildPmAcceptUrl(newToken),
      { pmCompanyId: req.params.id, invitationId: inv.id })
      .catch(e => logger.error({ err: e }, '[EMAIL pm_invitation resend failed]'))

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

pmRouter.delete('/companies/:id/invitations/:invId', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner'])
    const updated = await queryOne<any>(
      `UPDATE pm_invitations
          SET status='revoked', revoked_at=NOW(), revoked_by_user_id=$1
        WHERE id=$2 AND pm_company_id=$3 AND status='pending'
        RETURNING *`,
      [req.user!.userId, req.params.invId, req.params.id]
    )
    if (!updated) throw new AppError(404, 'Pending invitation not found')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PUBLIC: accept invitation by token. Requires the caller to already have
// a GAM user account (signup flow is outside this route — the frontend
// sends the user through signup first if needed, then loops back here
// with the same token + an Authorization header). The acceptance creates
// the pm_staff row in one transaction.
pmInvitationsPublicRouter.post('/accept', requireAuth, async (req: any, res, next) => {
  try {
    const body = z.object({ token: z.string().min(16) }).parse(req.body)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const inv = (await client.query<any>(
        `SELECT * FROM pm_invitations WHERE token=$1 FOR UPDATE`, [body.token]
      )).rows[0]
      if (!inv) throw new AppError(404, 'Invitation not found')
      if (inv.status !== 'pending') throw new AppError(409, `Invitation is ${inv.status}`)
      if (new Date(inv.expires_at) < new Date()) {
        await client.query(`UPDATE pm_invitations SET status='expired' WHERE id=$1`, [inv.id])
        await client.query('COMMIT')
        throw new AppError(409, 'Invitation has expired')
      }

      // Caller's email must match the invitation. Prevents token theft from
      // letting an unrelated user join the company.
      const caller = (await client.query<{ email: string }>(
        `SELECT email FROM users WHERE id=$1`, [req.user!.userId]
      )).rows[0]
      if (!caller || caller.email.toLowerCase() !== inv.email.toLowerCase()) {
        throw new AppError(403, 'Invitation email does not match the logged-in account')
      }

      // Block duplicate active membership (race vs the create-route's
      // existingMembership check).
      const dupe = await client.query(
        `SELECT 1 FROM pm_staff WHERE pm_company_id=$1 AND user_id=$2 AND status='active'`,
        [inv.pm_company_id, req.user!.userId]
      )
      if (dupe.rowCount && dupe.rowCount > 0) {
        throw new AppError(409, 'You are already an active staff member of this company')
      }

      await client.query(
        `INSERT INTO pm_staff (pm_company_id, user_id, role, permissions, status, invited_by_user_id, joined_at)
         VALUES ($1, $2, $3, $4, 'active', $5, NOW())
         ON CONFLICT (pm_company_id, user_id) DO UPDATE
           SET status='active', role=EXCLUDED.role, permissions=EXCLUDED.permissions,
               invited_by_user_id=EXCLUDED.invited_by_user_id, joined_at=NOW(),
               removed_at=NULL, updated_at=NOW()`,
        [inv.pm_company_id, req.user!.userId, inv.role, inv.permissions, inv.invited_by_user_id]
      )

      await client.query(
        `UPDATE pm_invitations SET status='accepted', accepted_at=NOW(), accepted_user_id=$1 WHERE id=$2`,
        [req.user!.userId, inv.id]
      )
      await client.query('COMMIT')
      res.json({ success: true, data: { pm_company_id: inv.pm_company_id, role: inv.role } })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ── S118: PM company dashboard endpoints ──────────────────────────────────

// GET /api/pm/companies/:id/payouts — list Stripe Payouts that fired
// against the pm_company's Connect account. Active staff can view.
pmRouter.get('/companies/:id/payouts', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager', 'staff'])
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)
    const status = typeof req.query.status === 'string' ? req.query.status : null

    const params: any[] = [req.params.id]
    let statusClause = ''
    if (status) { params.push(status); statusClause = `AND status = $${params.length}` }
    params.push(limit)

    const rows = await query<any>(`
      SELECT id, stripe_payout_id, amount, currency, status,
             destination_bank_last4, arrival_date, failure_code, failure_message,
             created_at, updated_at
        FROM connect_payouts
       WHERE pm_company_id = $1 ${statusClause}
       ORDER BY created_at DESC
       LIMIT $${params.length}
    `, params)

    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/pm/companies/:id/properties/:propertyId/drilldown
// One-shot bundle for the PM-portal property detail page: property +
// units + active leases + recent maintenance + MTD fee impact for THIS
// property. Active staff (any role) of the company can view, gated on
// properties.pm_company_id matching the URL :id.
pmRouter.get('/companies/:id/properties/:propertyId/drilldown', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager', 'staff'])

    const property = await queryOne<any>(
      `SELECT p.id, p.name, p.street1, p.city, p.state, p.zip, p.type,
              p.pm_company_id, p.pm_fee_plan_id,
              fp.name      AS pm_fee_plan_name,
              fp.fee_type  AS pm_fee_type,
              fp.percent   AS pm_fee_percent,
              fp.flat_amount AS pm_fee_flat_amount,
              (SELECT COUNT(*)::int FROM units WHERE property_id = p.id)                          AS total_units,
              (SELECT COUNT(*)::int FROM units WHERE property_id = p.id AND status = 'active')    AS occupied_units
         FROM properties p
         LEFT JOIN pm_fee_plans fp ON fp.id = p.pm_fee_plan_id
        WHERE p.id = $1 AND p.pm_company_id = $2`,
      [req.params.propertyId, req.params.id]
    )
    if (!property) {
      throw new AppError(404, 'Property not found or not managed by this PM company')
    }

    const units = await query<any>(
      `SELECT u.id, u.unit_number, u.status, u.rent_amount,
              vuo.primary_first_name AS tenant_first,
              vuo.primary_last_name  AS tenant_last,
              vuo.primary_tenant_id  AS tenant_id
         FROM units u
         LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
        WHERE u.property_id = $1
        ORDER BY u.unit_number`,
      [req.params.propertyId]
    )

    const activeLeases = await query<any>(
      `SELECT l.id, l.unit_id, u.unit_number,
              l.start_date, l.end_date, l.monthly_rent, l.status,
              tu.first_name AS tenant_first, tu.last_name AS tenant_last
         FROM leases l
         JOIN units u ON u.id = l.unit_id
         LEFT JOIN lease_tenants lt ON lt.lease_id = l.id
                                    AND lt.role = 'primary'
                                    AND lt.status = 'active'
         LEFT JOIN tenants t ON t.id = lt.tenant_id
         LEFT JOIN users tu ON tu.id = t.user_id
        WHERE u.property_id = $1 AND l.status = 'active'
        ORDER BY u.unit_number`,
      [req.params.propertyId]
    )

    const recentMaintenance = await query<any>(
      `SELECT mr.id, mr.title, mr.status, mr.priority, mr.category,
              mr.created_at, mr.completed_at, mr.estimated_cost, mr.actual_cost,
              u.unit_number
         FROM maintenance_requests mr
         JOIN units u ON u.id = mr.unit_id
        WHERE u.property_id = $1
        ORDER BY mr.created_at DESC
        LIMIT 20`,
      [req.params.propertyId]
    )

    const feeImpact = await queryOne<any>(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'allocation_owner_share'    THEN amount END), 0)::numeric AS owner_net,
         COALESCE(SUM(CASE WHEN type = 'allocation_pm_company_fee' THEN amount END), 0)::numeric AS pm_company_cut,
         COALESCE(SUM(CASE WHEN type IN ('allocation_owner_share','allocation_pm_company_fee','allocation_manager_fee') THEN amount END), 0)::numeric AS gross,
         COUNT(DISTINCT reference_id) FILTER (WHERE type = 'allocation_pm_company_fee')::int AS payment_count
         FROM user_balance_ledger
        WHERE property_id = $1
          AND reference_type = 'payment'
          AND created_at >= date_trunc('month', NOW())`,
      [req.params.propertyId]
    )

    res.json({
      success: true,
      data: {
        property,
        units,
        active_leases:        activeLeases,
        recent_maintenance:   recentMaintenance,
        mtd_fee_impact: {
          gross:          parseFloat(feeImpact?.gross ?? '0'),
          pm_company_cut: parseFloat(feeImpact?.pm_company_cut ?? '0'),
          owner_net:      parseFloat(feeImpact?.owner_net ?? '0'),
          payment_count:  feeImpact?.payment_count ?? 0,
        },
      },
    })
  } catch (e) { next(e) }
})

// ── S157: pm_property_invitations (mutual property-link handshake) ────────
//
// Direction='owner_to_pm'  → owner sends from landlord portal (see
//   routes/landlords.ts). PM staff accept/reject from this router.
// Direction='pm_to_owner'  → PM staff send from this router (POST below).
//   Owner accepts/rejects from landlord portal.
//
// Public lookup-by-token endpoint lets either side preview the invite
// before signing in (used by the email accept-link).

const PM_PROPERTY_INVITE_ACCEPT_URL_BASE = process.env.PM_PROPERTY_INVITE_ACCEPT_URL_BASE
  || `${process.env.LANDLORD_APP_URL || 'http://localhost:3001'}/pm-property-invitations/accept`

function buildPropertyInviteAcceptUrl(token: string): string {
  return `${PM_PROPERTY_INVITE_ACCEPT_URL_BASE}?token=${encodeURIComponent(token)}`
}

// PUBLIC: GET /api/pm/invitations/property/:token — preview an invite.
//
// Returns minimal info needed for the recipient to decide. No auth wall;
// possession of the token is the gate. Sensitive fields (recipient PII,
// audit trail) intentionally omitted.
pmInvitationsPublicRouter.get('/property/:token', async (req, res, next) => {
  try {
    const inv = await queryOne<{
      direction: string
      pm_company_id: string
      property_id: string
      landlord_id: string
      proposed_scope: string
      proposed_fee_plan_id: string | null
      status: string
      expires_at: Date
      pm_company_name: string
      property_name: string
      fee_plan_name: string | null
      fee_plan_type: string | null
    }>(
      `SELECT i.direction, i.pm_company_id, i.property_id, i.landlord_id,
              i.proposed_scope, i.proposed_fee_plan_id,
              i.status, i.expires_at,
              c.name AS pm_company_name,
              p.name AS property_name,
              fp.name AS fee_plan_name,
              fp.fee_type AS fee_plan_type
         FROM pm_property_invitations i
         JOIN pm_companies c ON c.id = i.pm_company_id
         JOIN properties   p ON p.id = i.property_id
    LEFT JOIN pm_fee_plans fp ON fp.id = i.proposed_fee_plan_id
        WHERE i.token = $1`,
      [req.params.token]
    )
    if (!inv) throw new AppError(404, 'Invitation not found')
    res.json({ success: true, data: inv })
  } catch (e) { next(e) }
})

// POST /api/pm/companies/:id/property-invitations — PM sends pm_to_owner invite
pmRouter.post('/companies/:id/property-invitations', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager'])
    const body = z.object({
      property_id:           z.string().uuid(),
      landlord_id:           z.string().uuid(),
      invited_email:         z.string().email().max(255),
      proposed_scope:        z.enum(PM_LINK_SCOPES),
      proposed_fee_plan_id:  z.string().uuid().nullish(),
    }).parse(req.body)

    // Fee plan only meaningful when scope='manage'. 'view' scope = no money flow.
    const feePlanId = body.proposed_scope === 'manage' ? (body.proposed_fee_plan_id ?? null) : null

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { invitationId, token } = await sendPropertyInvitation({
        client,
        direction: 'pm_to_owner',
        pmCompanyId: req.params.id,
        propertyId: body.property_id,
        landlordId: body.landlord_id,
        invitedEmail: body.invited_email,
        invitedByUserId: req.user!.userId,
        proposedScope: body.proposed_scope,
        proposedFeePlanId: feePlanId,
      })
      await client.query('COMMIT')

      // Send email outside the transaction (network call shouldn't hold a tx open).
      const ctxRow = await queryOne<{ pm_company_name: string; property_name: string; inviter_name: string }>(
        `SELECT c.name AS pm_company_name,
                p.name AS property_name,
                COALESCE(u.first_name || ' ' || u.last_name, u.email) AS inviter_name
           FROM pm_companies c, properties p, users u
          WHERE c.id=$1 AND p.id=$2 AND u.id=$3`,
        [req.params.id, body.property_id, req.user!.userId]
      )
      if (ctxRow) {
        try {
          await emailPmPropertyInvitation({
            to: body.invited_email,
            direction: 'pm_to_owner',
            inviterName: ctxRow.inviter_name,
            pmCompanyName: ctxRow.pm_company_name,
            propertyName: ctxRow.property_name,
            proposedScope: body.proposed_scope,
            acceptUrl: buildPropertyInviteAcceptUrl(token),
            ctx: { pmCompanyId: req.params.id, invitationId, landlordId: body.landlord_id },
          })
        } catch (mailErr) {
          logger.error({ err: mailErr }, '[PM PROPERTY INVITE EMAIL FAILED]')
        }
      }

      res.status(201).json({ success: true, data: { invitation_id: invitationId } })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// GET /api/pm/companies/:id/property-invitations — list invitations involving this PM (sent or received)
pmRouter.get('/companies/:id/property-invitations', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager', 'staff'])
    const status = typeof req.query.status === 'string' ? req.query.status : null
    const params: any[] = [req.params.id]
    let statusClause = ''
    if (status) { params.push(status); statusClause = `AND i.status = $${params.length}` }

    const rows = await query(`
      SELECT i.id, i.direction, i.property_id, i.landlord_id, i.invited_email,
             i.proposed_scope, i.proposed_fee_plan_id, i.status,
             i.expires_at, i.accepted_at, i.rejected_at, i.rejected_reason,
             i.revoked_at, i.replaced_pm_company_id, i.created_at,
             p.name AS property_name,
             fp.name AS fee_plan_name, fp.fee_type AS fee_plan_type
        FROM pm_property_invitations i
        JOIN properties   p  ON p.id = i.property_id
   LEFT JOIN pm_fee_plans fp ON fp.id = i.proposed_fee_plan_id
       WHERE i.pm_company_id = $1 ${statusClause}
       ORDER BY i.created_at DESC
    `, params)

    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/pm/companies/:id/property-invitations/:invId/accept — PM accepts owner_to_pm invite
pmRouter.post('/companies/:id/property-invitations/:invId/accept', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager'])
    const body = z.object({ replace: z.boolean().default(false) }).parse(req.body ?? {})

    const inv = await queryOne<{ direction: string; token: string; pm_company_id: string }>(
      `SELECT direction, token, pm_company_id
         FROM pm_property_invitations
        WHERE id = $1`,
      [req.params.invId]
    )
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.pm_company_id !== req.params.id) {
      throw new AppError(403, 'Invitation does not belong to this PM company')
    }
    if (inv.direction !== 'owner_to_pm') {
      throw new AppError(400, 'Only owner_to_pm invitations can be accepted by PM staff')
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const result = await acceptPropertyInvitation({
        client, token: inv.token, acceptingUserId: req.user!.userId, replace: body.replace,
      })
      await client.query('COMMIT')
      res.json({ success: true, data: result })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// POST /api/pm/companies/:id/property-invitations/:invId/reject — PM rejects owner_to_pm invite
pmRouter.post('/companies/:id/property-invitations/:invId/reject', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager'])
    const body = z.object({ reason: z.string().max(500).nullish() }).parse(req.body ?? {})

    const inv = await queryOne<{ direction: string; token: string; pm_company_id: string }>(
      `SELECT direction, token, pm_company_id
         FROM pm_property_invitations
        WHERE id = $1`,
      [req.params.invId]
    )
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.pm_company_id !== req.params.id) {
      throw new AppError(403, 'Invitation does not belong to this PM company')
    }
    if (inv.direction !== 'owner_to_pm') {
      throw new AppError(400, 'Only owner_to_pm invitations can be rejected by PM staff')
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const result = await rejectPropertyInvitation(client, inv.token, body.reason ?? null)
      await client.query('COMMIT')
      res.json({ success: true, data: result })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// DELETE /api/pm/companies/:id/property-invitations/:invId — PM revokes own pm_to_owner invite
pmRouter.delete('/companies/:id/property-invitations/:invId', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager'])

    const inv = await queryOne<{ direction: string; pm_company_id: string }>(
      `SELECT direction, pm_company_id
         FROM pm_property_invitations
        WHERE id = $1`,
      [req.params.invId]
    )
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.pm_company_id !== req.params.id) {
      throw new AppError(403, 'Invitation does not belong to this PM company')
    }
    if (inv.direction !== 'pm_to_owner') {
      throw new AppError(400, 'Only PM-sent invitations can be revoked here')
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await revokePropertyInvitation(client, req.params.invId, req.user!.userId)
      await client.query('COMMIT')
      res.json({ success: true })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ── S159: Stripe Connect Express embedded onboarding ──────────────────────
//
// POST /api/pm/companies/:id/connect/onboarding-link — idempotent. Ensures
// the pm_company has a Stripe Connect account (creates on first call),
// then mints a fresh Account Session client_secret for the embedded
// onboarding component. Frontend calls this each time the BankingPage
// onboarding component mounts (sessions are short-lived).
//
// Auth: PM staff with role owner|manager. 'staff' role can't kick off
// onboarding — that's an organizational decision (banking == owner-level).
pmRouter.post('/companies/:id/connect/onboarding-link', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager'])

    const company = await queryOne<{
      id: string; name: string; business_email: string | null
      stripe_connect_account_id: string | null
    }>(
      `SELECT id, name, business_email, stripe_connect_account_id
         FROM pm_companies WHERE id = $1`,
      [req.params.id]
    )
    if (!company) throw new AppError(404, 'PM company not found')

    // Use the company's business_email if set, else fall back to the
    // calling user's email (Stripe requires *some* email at account
    // creation time).
    let kycEmail = company.business_email
    if (!kycEmail) {
      const u = await queryOne<{ email: string }>(
        `SELECT email FROM users WHERE id=$1`, [req.user!.userId]
      )
      kycEmail = u?.email ?? null
    }
    if (!kycEmail) {
      throw new AppError(400, 'No email on the company or calling user — set business_email first')
    }

    const connectAccountId = await ensureConnectAccount({
      entity: 'pm_company',
      entityId: company.id,
      email: kycEmail,
      businessName: company.name,
    })

    const clientSecret = await createOnboardingSession(connectAccountId)

    res.json({
      success: true,
      data: {
        connect_account_id: connectAccountId,
        client_secret: clientSecret,
      },
    })
  } catch (e) { next(e) }
})

// GET /api/pm/companies/:id/connect/account-status — read live capability
// flags from Stripe. Used by BankingPage to show "verifying…" states
// before the webhook lands. The cached row state lives on
// pm_companies.connect_*_enabled (only flip on webhook receipt); this
// endpoint reads live truth from Stripe.
pmRouter.get('/companies/:id/connect/account-status', async (req: any, res, next) => {
  try {
    await assertPmStaffRole(req.user!.userId, req.params.id, ['owner', 'manager', 'staff'])

    const company = await queryOne<{ stripe_connect_account_id: string | null }>(
      `SELECT stripe_connect_account_id FROM pm_companies WHERE id=$1`,
      [req.params.id]
    )
    if (!company) throw new AppError(404, 'PM company not found')
    if (!company.stripe_connect_account_id) {
      res.json({
        success: true,
        data: {
          has_account: false,
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          requirements_currently_due: [],
        },
      })
      return
    }

    const status = await fetchAccountStatus(company.stripe_connect_account_id)
    res.json({ success: true, data: { has_account: true, ...status } })
  } catch (e) { next(e) }
})
