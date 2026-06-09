/**
 * S247: Sublease invite-acceptance public routes.
 *
 * Distinct router from /api/subleases because these endpoints are
 * pre-authentication — the recipient hasn't created a GAM account
 * yet. Token in the URL is the only credential; expiry + UNIQUE
 * index on token make it single-use-shaped.
 *
 *   GET  /api/sublease-invitations/:token   — token validity + preview
 *   POST /api/sublease-invitations/:token/accept — onboard + accept
 *
 * Acceptance side-effects (transactional):
 *   1. Validate token exists + not expired + status='sent'
 *   2. Create users row (role='tenant') + tenants row
 *   3. Flip invitation → status='accepted', accepted_tenant_id,
 *      accepted_at
 *   4. Flip the linked subleases row: sublessee_tenant_id filled,
 *      status='pending_invite' → 'pending'
 *   5. Notify landlord that a decision-eligible sublease has landed
 *      (S198 notifySubleaseRequested with the new sublessee context)
 *   6. Return a JWT so the new tenant can land directly in the
 *      tenant portal to verify ACH + complete BG check.
 *
 * Distinct-parties guard: re-check `sublessee_tenant_id <>
 * sublessor_tenant_id` at acceptance time. The subleases CHECK
 * constraint also enforces but we want a cleaner 400 instead of
 * a 500.
 */

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

export const subleaseInvitationsRouter = Router()

interface InvitationRow {
  id:                  string
  token:               string
  sublessor_tenant_id: string
  master_lease_id:     string
  sublessee_email:     string
  sub_monthly_amount:  string
  master_share_amount: string
  start_date:          string
  end_date:            string | null
  notes:               string | null
  status:              'sent' | 'accepted' | 'expired' | 'cancelled'
  expires_at:          string
  sublease_id:         string | null
}

async function loadInvitation(token: string): Promise<InvitationRow | null> {
  return queryOne<InvitationRow>(
    `SELECT id, token, sublessor_tenant_id, master_lease_id, sublessee_email,
            sub_monthly_amount::text, master_share_amount::text,
            start_date::text, end_date::text, notes, status,
            expires_at::text, sublease_id
       FROM sublessee_invitations
      WHERE token = $1
      LIMIT 1`,
    [token],
  )
}

function isExpired(row: InvitationRow): boolean {
  return new Date(row.expires_at).getTime() < Date.now()
}

// GET /api/sublease-invitations/:token — public preview
// Returns just enough info for the accept page to render the offer
// (property name, sublessor name, amounts, dates). Does NOT leak the
// sublessor's email or tenant id.
subleaseInvitationsRouter.get('/:token', async (req, res, next) => {
  try {
    const inv = await loadInvitation(req.params.token)
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status !== 'sent') {
      throw new AppError(409, `Invitation is ${inv.status}`)
    }
    if (isExpired(inv)) {
      throw new AppError(410, 'Invitation has expired')
    }

    const ctx = await queryOne<{
      property_name: string
      unit_number:   string
      sublessor_name: string
    }>(
      `SELECT p.name AS property_name,
              u.unit_number,
              tu.first_name || ' ' || tu.last_name AS sublessor_name
         FROM leases l
         JOIN units u      ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
         JOIN tenants t    ON t.id = $1
         JOIN users tu     ON tu.id = t.user_id
        WHERE l.id = $2`,
      [inv.sublessor_tenant_id, inv.master_lease_id],
    )
    if (!ctx) throw new AppError(404, 'Lease context vanished')

    res.json({
      success: true,
      data: {
        property_name:      ctx.property_name,
        unit_number:        ctx.unit_number,
        sublessor_name:     ctx.sublessor_name,
        sublessee_email:    inv.sublessee_email,
        sub_monthly_amount: Number(inv.sub_monthly_amount),
        start_date:         inv.start_date,
        end_date:           inv.end_date,
        notes:              inv.notes,
        expires_at:         inv.expires_at,
      },
    })
  } catch (e) { next(e) }
})

// POST /api/sublease-invitations/:token/accept — onboard sublessee
// Body: { firstName, lastName, password, phone? }
subleaseInvitationsRouter.post('/:token/accept', async (req, res, next) => {
  try {
    const { firstName, lastName, password, phone } = req.body || {}
    if (!firstName || !lastName || !password) {
      throw new AppError(400, 'firstName, lastName, password required')
    }
    if (String(password).length < 8) {
      throw new AppError(400, 'Password must be at least 8 characters')
    }

    const inv = await loadInvitation(req.params.token)
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status !== 'sent') throw new AppError(409, `Invitation is ${inv.status}`)
    if (isExpired(inv)) throw new AppError(410, 'Invitation has expired')
    if (!inv.sublease_id) throw new AppError(500, 'Invitation is not linked to a sublease row')

    // Email collision check — invitations target a specific email; if
    // someone signed up with the same email after the invite was sent,
    // they're already a GAM tenant and the sublessor should re-issue
    // the request via the regular existing-tenant path.
    const existingUser = await queryOne<{ id: string }>(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
      [inv.sublessee_email],
    )
    if (existingUser) {
      throw new AppError(
        409,
        'An account with this email already exists. Ask the sublessor to re-submit the request now that you have an account.',
      )
    }

    const hash = await bcrypt.hash(String(password), 12)
    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [user] } = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
         VALUES ($1, $2, 'tenant', $3, $4, $5)
         RETURNING *`,
        [inv.sublessee_email, hash, firstName, lastName, phone || null],
      )

      const { rows: [tenant] } = await client.query(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING *`,
        [user.id],
      )

      if (tenant.id === inv.sublessor_tenant_id) {
        await client.query('ROLLBACK')
        throw new AppError(400, 'Sublessor and sublessee must be different people')
      }

      await client.query(
        `UPDATE sublessee_invitations
            SET status = 'accepted',
                accepted_tenant_id = $1,
                accepted_at = NOW(),
                updated_at = NOW()
          WHERE id = $2`,
        [tenant.id, inv.id],
      )

      await client.query(
        `UPDATE subleases
            SET sublessee_tenant_id = $1,
                status = 'pending',
                updated_at = NOW()
          WHERE id = $2`,
        [tenant.id, inv.sublease_id],
      )

      await client.query('COMMIT')

      // Landlord notify — same payload shape as the regular
      // existing-tenant path. Outside the tx so failure doesn't
      // roll back the signup.
      try {
        const ctx = await queryOne<{
          landlord_user_id: string
          landlord_email:   string
          landlord_id:      string
          unit_number:      string
          property_name:    string
          sublessor_name:   string
        }>(
          `SELECT lu.id    AS landlord_user_id,
                  lu.email AS landlord_email,
                  la.id    AS landlord_id,
                  u.unit_number,
                  p.name   AS property_name,
                  tu_or.first_name || ' ' || tu_or.last_name AS sublessor_name
             FROM leases l
             JOIN units u      ON u.id = l.unit_id
             JOIN properties p ON p.id = u.property_id
             JOIN landlords la ON la.id = l.landlord_id
             JOIN users     lu ON lu.id = la.user_id
             JOIN tenants  t_or ON t_or.id = $2
             JOIN users   tu_or ON tu_or.id = t_or.user_id
            WHERE l.id = $1`,
          [inv.master_lease_id, inv.sublessor_tenant_id],
        )
        if (ctx) {
          const { notifySubleaseRequested } = await import('../services/notifications')
          await notifySubleaseRequested({
            landlordUserId:   ctx.landlord_user_id,
            landlordId:       ctx.landlord_id,
            landlordEmail:    ctx.landlord_email,
            subleaseId:       inv.sublease_id,
            sublessorName:    ctx.sublessor_name,
            sublesseeName:    `${firstName} ${lastName}`,
            unitNumber:       ctx.unit_number,
            propertyName:     ctx.property_name,
            startDate:        inv.start_date,
            subMonthlyAmount: Number(inv.sub_monthly_amount),
          })
        }
      } catch (e) {
        logger.error({ err: e }, '[NOTIFY] sublease_requested (post-invite-accept):')
      }

      // S277: dropped the `|| 'gam_dev_secret'` fallback. The literal
      // string was repo-committed; non-null assertion fails-closed
      // when JWT_SECRET is unset, matching the rest of the codebase.
      const token = jwt.sign(
        { userId: user.id, role: 'tenant', profileId: tenant.id },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' },
      )

      res.status(201).json({
        success: true,
        data: {
          token,
          user: { id: user.id, email: user.email, firstName, lastName, role: 'tenant' },
          subleaseId: inv.sublease_id,
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
