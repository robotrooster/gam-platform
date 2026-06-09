/**
 * S197: Sublease subsystem phase 1 — backend workflow.
 *
 * Wires the long-existing `subleases` table (in initial_schema, never
 * consumed by code) to a real workflow:
 *
 *   1. Tenant requests a sublease     → POST   /api/subleases
 *   2. Landlord approves or denies    → PATCH  /api/subleases/:id/decision
 *   3. Either party terminates        → PATCH  /api/subleases/:id/terminate
 *   4. List subleases                 → GET    /api/subleases
 *   5. Get one                        → GET    /api/subleases/:id
 *
 * Lifecycle (per subleases.status_check):
 *   pending → active   (landlord approves)
 *   pending → terminated (landlord denies)
 *   active  → terminated (either party terminates, or end_date hits)
 *
 * Honors `leases.subleasing_allowed` at request time:
 *   'prohibited'    → 409, request rejected outright
 *   'with_consent'  → request accepted; landlord must approve
 *   'allowed'       → request accepted AND auto-approved (status='active'
 *                     immediately, landlord_consent_date=NOW())
 *
 * Phase 1 scope (this session):
 *   - Sublessee must already exist as a GAM tenant (looked up by email).
 *     Sublessee onboarding via invitation token is phase 2.
 *   - master_share_amount defaults to sub_monthly_amount (full pass-
 *     through to landlord). Sublessor markup happens in phase 2 when
 *     the product call on "what does the sublessor pocket?" is settled.
 *   - Money flow / billing implications NOT wired yet — sublease is
 *     a recorded agreement; the master lease's payments flow continues
 *     as before. Phase 3 wires sub-tenant billing.
 *
 * Auth posture:
 *   - POST: requireAuth + tenant role (only tenants request subleases)
 *   - PATCH /decision: requireLandlord (only landlord decides)
 *   - PATCH /terminate: requireAuth (either party — sublessor, sublessee,
 *     or landlord)
 *   - GET endpoints: requireAuth, scoped per role
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { appendEvent } from '../services/creditLedger'
import { logger } from '../lib/logger'

export const subleasesRouter = Router()
subleasesRouter.use(requireAuth)

// ── POST /api/subleases — sublessor (tenant) requests a sublease ──────────

const createSchema = z.object({
  masterLeaseId: z.string().uuid(),
  sublesseeEmail: z.string().email(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  subMonthlyAmount: z.number().positive().max(1_000_000),
  masterShareAmount: z.number().min(0).max(1_000_000).optional(),
  notes:              z.string().max(2000).optional(),
})

subleasesRouter.post('/', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only tenants may request a sublease')
    }
    const body = createSchema.parse(req.body)

    const sublessorTenantId = req.user!.profileId

    // 1. Master lease exists + caller is on it. S247: also join the
    //    property to enforce the property-level subleasing_allowed
    //    toggle AND'd with the existing lease-level enum.
    const lease = await queryOne<{
      id: string
      landlord_id: string
      status: string
      subleasing_allowed: 'prohibited' | 'with_consent' | 'allowed'
      property_id: string
      property_subleasing_allowed: boolean
    }>(
      `SELECT l.id, l.landlord_id, l.status, l.subleasing_allowed,
              u.property_id, p.subleasing_allowed AS property_subleasing_allowed
         FROM leases l
         JOIN units u      ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE l.id = $1`,
      [body.masterLeaseId],
    )
    if (!lease) throw new AppError(404, 'Master lease not found')
    if (lease.status !== 'active') {
      throw new AppError(409, `Cannot sublease a ${lease.status} lease`)
    }
    // S247: property-level gate. AND'd with lease-level — both must
    // permit. Property is the master switch driven by landlord's lease
    // document; lease enum is the per-tenancy refinement.
    if (!lease.property_subleasing_allowed) {
      throw new AppError(409, 'Subleasing is not permitted at this property')
    }
    if (lease.subleasing_allowed === 'prohibited') {
      throw new AppError(409, 'Subleasing is prohibited under this lease')
    }

    const onLease = await queryOne<{ id: string }>(
      `SELECT id FROM lease_tenants
        WHERE lease_id = $1 AND tenant_id = $2 AND status = 'active'
        LIMIT 1`,
      [body.masterLeaseId, sublessorTenantId],
    )
    if (!onLease) {
      throw new AppError(403, 'You are not an active tenant on this lease')
    }

    // 2. Resolve sublessee by email. If found → existing-tenant path
    //    (pre-S247 behavior). If not found → S247 invite path: create
    //    a sublessee_invitations row + sublease in 'pending_invite'
    //    status; sublessee onboards via the email link, accepts, and
    //    only then can the landlord decide.
    const sublessee = await queryOne<{ id: string; user_id: string }>(
      `SELECT t.id, t.user_id
         FROM tenants t
         JOIN users u ON u.id = t.user_id
        WHERE LOWER(u.email) = LOWER($1)
        LIMIT 1`,
      [body.sublesseeEmail],
    )
    const isInviteFlow = !sublessee

    if (sublessee && sublessee.id === sublessorTenantId) {
      throw new AppError(400, 'Sublessor and sublessee cannot be the same person')
    }

    // 3. Date range validation
    if (body.endDate && body.endDate < body.startDate) {
      throw new AppError(400, 'end_date must be on or after start_date')
    }

    // 4. master_share_amount defaults to sub_monthly_amount (full
    //    pass-through). Sublessor markup is optional — the
    //    `sub_monthly_amount - master_share_amount` difference
    //    accrues to sublessor_credit_balances as profit.
    const masterShare = body.masterShareAmount ?? body.subMonthlyAmount

    // 5. INSERT — branches by invite-flow vs existing-tenant.
    let initialStatus: 'pending_invite' | 'pending' | 'active'
    let consentDate: string | null = null
    let invitation: { id: string; token: string } | null = null

    if (isInviteFlow) {
      // Create invitation first (token + expiry); sublease row links to it.
      const tokenBytes = await import('node:crypto').then(c => c.randomBytes(32).toString('hex'))
      const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000)  // 14 days
      invitation = await queryOne<{ id: string; token: string }>(
        `INSERT INTO sublessee_invitations (
           token, sublessor_tenant_id, master_lease_id, sublessee_email,
           sub_monthly_amount, master_share_amount, start_date, end_date,
           notes, expires_at
         ) VALUES ($1, $2, $3, LOWER($4), $5, $6, $7, $8, $9, $10)
         RETURNING id, token`,
        [
          tokenBytes, sublessorTenantId, body.masterLeaseId, body.sublesseeEmail,
          body.subMonthlyAmount, masterShare,
          body.startDate, body.endDate ?? null,
          body.notes ?? null, expiresAt.toISOString(),
        ],
      )
      initialStatus = 'pending_invite'
    } else {
      const autoApprove = lease.subleasing_allowed === 'allowed'
      initialStatus = autoApprove ? 'active' : 'pending'
      consentDate = autoApprove ? new Date().toISOString().slice(0, 10) : null
    }

    const inserted = await queryOne<any>(
      `INSERT INTO subleases (
         master_lease_id, sublessee_tenant_id, sublessor_tenant_id,
         status, start_date, end_date,
         sub_monthly_amount, master_share_amount,
         landlord_consent_date, notes, sublessee_invitation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        body.masterLeaseId,
        sublessee?.id ?? null,
        sublessorTenantId,
        initialStatus, body.startDate, body.endDate ?? null,
        body.subMonthlyAmount, masterShare,
        consentDate, body.notes ?? null,
        invitation?.id ?? null,
      ],
    )

    // S247: back-link the invitation to the sublease row (for the
    // public accept page to find the agreement at acceptance time).
    if (invitation) {
      await query(
        `UPDATE sublessee_invitations SET sublease_id = $1, updated_at = NOW() WHERE id = $2`,
        [inserted.id, invitation.id],
      )
    }

    // S199: credit-ledger event for sublease_requested. Records
    // sublessor behavior on subletting; not scored in v1.0.0
    // formula. Visible to current landlord (not network-wide; may
    // contain sensitive context).
    try {
      await appendEvent({
        subjectType: 'tenant',
        subjectRefId: sublessorTenantId,
        eventType: 'sublease_requested',
        eventData: {
          sublease_id: inserted.id,
          master_lease_id: body.masterLeaseId,
          sublessee_tenant_id: sublessee?.id ?? null,
          sublessee_email: sublessee ? undefined : body.sublesseeEmail.toLowerCase(),
          sub_monthly_amount: body.subMonthlyAmount,
          start_date: body.startDate,
          end_date: body.endDate ?? null,
          subleasing_policy: lease.subleasing_allowed,
          auto_approved: initialStatus === 'active',
          invite_flow: isInviteFlow,
        },
        occurredAt: new Date(),
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: { sublease_id: inserted.id },
        dimensionTags: ['tenancy_stability'],
        networkVisibility: 'visible_to_current_landlord',
      })
    } catch (e) {
      logger.error({ err: e }, '[CREDIT] sublease_requested:')
    }

    // S247: invite-flow side effect — email the sublessee with the
    // accept link. The invitation row carries the token; the public
    // accept route validates it + onboards the sublessee.
    if (invitation && isInviteFlow) {
      try {
        const inviteCtx = await queryOne<{
          unit_number: string
          property_name: string
          sublessor_name: string
        }>(
          `SELECT u.unit_number,
                  p.name AS property_name,
                  tu.first_name || ' ' || tu.last_name AS sublessor_name
             FROM leases l
             JOIN units u ON u.id = l.unit_id
             JOIN properties p ON p.id = u.property_id
             JOIN tenants t ON t.id = $2
             JOIN users tu ON tu.id = t.user_id
            WHERE l.id = $1`,
          [body.masterLeaseId, sublessorTenantId],
        )
        if (inviteCtx) {
          const { sendSubleaseInvite } = await import('../services/email')
          await sendSubleaseInvite({
            sublesseeEmail:   body.sublesseeEmail,
            sublessorName:    inviteCtx.sublessor_name,
            token:            invitation.token,
            propertyName:     inviteCtx.property_name,
            unitNumber:       inviteCtx.unit_number,
            subMonthlyAmount: body.subMonthlyAmount,
            startDate:        body.startDate,
            endDate:          body.endDate ?? null,
            ctx: {
              masterLeaseId:     body.masterLeaseId,
              sublessorTenantId,
            },
          })
        }
      } catch (e) {
        logger.error({ err: e }, '[NOTIFY] sublease invite send:')
      }
    }

    // S198: notify landlord (only when status='pending' — auto-
    // approved subleases under 'allowed' policy don't need a
    // decision ping; landlord still sees the row in their list).
    // pending_invite: no landlord notify yet — invitation hasn't
    // been accepted, sublessee is unknown to the landlord.
    if (initialStatus === 'pending' && sublessee) {
      try {
        const ctx = await queryOne<{
          landlord_user_id: string
          landlord_email:   string
          unit_number:      string
          property_name:    string
          sublessor_name:   string
          sublessee_name:   string
        }>(
          `SELECT lu.id    AS landlord_user_id,
                  lu.email AS landlord_email,
                  u.unit_number,
                  p.name   AS property_name,
                  tu_or.first_name || ' ' || tu_or.last_name AS sublessor_name,
                  tu_ee.first_name || ' ' || tu_ee.last_name AS sublessee_name
             FROM leases l
             JOIN units u ON u.id = l.unit_id
             JOIN properties p ON p.id = u.property_id
             JOIN landlords la ON la.id = l.landlord_id
             JOIN users    lu  ON lu.id = la.user_id
             JOIN tenants  t_or ON t_or.id = $2
             JOIN users    tu_or ON tu_or.id = t_or.user_id
             JOIN tenants  t_ee ON t_ee.id = $3
             JOIN users    tu_ee ON tu_ee.id = t_ee.user_id
            WHERE l.id = $1`,
          [body.masterLeaseId, sublessorTenantId, sublessee.id],
        )
        if (ctx) {
          const { notifySubleaseRequested } = await import('../services/notifications')
          await notifySubleaseRequested({
            landlordUserId:   ctx.landlord_user_id,
            landlordId:       lease.landlord_id,
            landlordEmail:    ctx.landlord_email,
            subleaseId:       inserted.id,
            sublessorName:    ctx.sublessor_name,
            sublesseeName:    ctx.sublessee_name,
            unitNumber:       ctx.unit_number,
            propertyName:     ctx.property_name,
            startDate:        body.startDate,
            subMonthlyAmount: body.subMonthlyAmount,
          })
        }
      } catch (e) {
        logger.error({ err: e }, '[NOTIFY] sublease_requested:')
      }
    }

    res.status(201).json({ success: true, data: inserted })
  } catch (e) { next(e) }
})

// ── PATCH /api/subleases/:id/decision — landlord approves or denies ───────

const decisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  notes:    z.string().max(2000).optional(),
})

subleasesRouter.patch('/:id/decision', requireLandlord, async (req, res, next) => {
  try {
    const body = decisionSchema.parse(req.body)

    const row = await queryOne<{
      id: string
      master_lease_id: string
      status: string
      landlord_id: string
    }>(
      `SELECT s.id, s.master_lease_id, s.status, l.landlord_id
         FROM subleases s
         JOIN leases l ON l.id = s.master_lease_id
        WHERE s.id = $1`,
      [req.params.id],
    )
    if (!row) throw new AppError(404, 'Sublease not found')
    if (!canManageLandlordResource(req.user, row.landlord_id, [])) {
      throw new AppError(403, 'Forbidden')
    }
    if (row.status !== 'pending') {
      throw new AppError(409, `Sublease is ${row.status}; cannot decide`)
    }

    // S251: approve no longer flips directly to 'active'. Sublease
    // enters 'awaiting_signatures', a sublease_agreement document is
    // generated, and both parties sign before the status flips. The
    // existing esign dispatch handles activation via
    // executeSubleaseAgreementCompletion when both signers complete.
    const updated = body.decision === 'approve'
      ? await queryOne<any>(
          `UPDATE subleases
              SET status = 'awaiting_signatures',
                  landlord_consent_date = CURRENT_DATE,
                  notes = COALESCE(notes || E'\\n', '') ||
                          'Approved: ' || COALESCE($2, '(no note)'),
                  updated_at = NOW()
            WHERE id = $1
            RETURNING *`,
          [row.id, body.notes ?? null],
        )
      : await queryOne<any>(
          `UPDATE subleases
              SET status = 'terminated',
                  terminated_at = NOW(),
                  terminated_reason = 'landlord_denied',
                  notes = COALESCE(notes || E'\\n', '') ||
                          'Denied: ' || COALESCE($2, '(no note)'),
                  updated_at = NOW()
            WHERE id = $1
            RETURNING *`,
          [row.id, body.notes ?? null],
        )

    // S251: on approve, generate the sublease agreement PDF + send
    // first signer email. Best-effort: a generator failure leaves
    // the sublease in 'awaiting_signatures' without a document —
    // admin alert via the catch block flags it for manual recovery.
    if (body.decision === 'approve') {
      try {
        const { generateSubleaseDocument } = await import('../services/subleaseDocuments')
        await generateSubleaseDocument({ subleaseId: row.id })
      } catch (e: any) {
        logger.error({ err: e }, '[SUBLEASE-DOC] generation failed:')
        try {
          const { createAdminNotification } = await import('../services/adminNotifications')
          await createAdminNotification({
            severity: 'warn',
            category: 'sublease_doc_generation_failed',
            title:    `Sublease document generation failed — ${row.id}`,
            body:     `Sublease ${row.id} approved but document generation failed: ${e?.message ?? e}. Manual recovery needed.`,
            context:  { sublease_id: row.id, error: String(e?.message ?? e) },
          })
        } catch {}
      }
    }

    // S199: credit-ledger event for the decision.
    try {
      await appendEvent({
        subjectType: 'tenant',
        subjectRefId: (await queryOne<{ sublessor_tenant_id: string }>(
          `SELECT sublessor_tenant_id FROM subleases WHERE id = $1`,
          [row.id],
        ))!.sublessor_tenant_id,
        eventType: body.decision === 'approve' ? 'sublease_approved' : 'sublease_denied',
        eventData: {
          sublease_id: row.id,
          master_lease_id: row.master_lease_id,
          decision_note: body.notes ?? null,
        },
        occurredAt: new Date(),
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: { sublease_id: row.id },
        dimensionTags: ['tenancy_stability'],
        networkVisibility: 'visible_to_current_landlord',
      })
    } catch (e) {
      logger.error({ err: e }, '[CREDIT] sublease_decision:')
    }

    // S198: notify the sublessor of the decision.
    try {
      const ctx = await queryOne<{
        sublessor_user_id: string
        sublessor_email:   string
        unit_number:       string
        property_name:     string
      }>(
        `SELECT tu.id    AS sublessor_user_id,
                tu.email AS sublessor_email,
                u.unit_number,
                p.name   AS property_name
           FROM subleases s
           JOIN leases    l  ON l.id = s.master_lease_id
           JOIN units     u  ON u.id = l.unit_id
           JOIN properties p ON p.id = u.property_id
           JOIN tenants   t  ON t.id = s.sublessor_tenant_id
           JOIN users     tu ON tu.id = t.user_id
          WHERE s.id = $1`,
        [row.id],
      )
      if (ctx) {
        const { notifySubleaseDecision } = await import('../services/notifications')
        await notifySubleaseDecision({
          sublessorUserId: ctx.sublessor_user_id,
          sublessorEmail:  ctx.sublessor_email,
          subleaseId:      row.id,
          decision:        body.decision === 'approve' ? 'approved' : 'denied',
          unitNumber:      ctx.unit_number,
          propertyName:    ctx.property_name,
          landlordNote:    body.notes ?? null,
        })
      }
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] sublease_decision:')
    }

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── PATCH /api/subleases/:id/terminate — early termination ────────────────

const terminateSchema = z.object({
  reason: z.string().min(1).max(500),
})

subleasesRouter.patch('/:id/terminate', async (req, res, next) => {
  try {
    const body = terminateSchema.parse(req.body)

    const row = await queryOne<{
      id: string
      status: string
      sublessor_tenant_id: string
      sublessee_tenant_id: string
      landlord_id: string
    }>(
      `SELECT s.id, s.status, s.sublessor_tenant_id, s.sublessee_tenant_id,
              l.landlord_id
         FROM subleases s
         JOIN leases l ON l.id = s.master_lease_id
        WHERE s.id = $1`,
      [req.params.id],
    )
    if (!row) throw new AppError(404, 'Sublease not found')
    if (row.status === 'terminated') {
      throw new AppError(409, 'Sublease already terminated')
    }

    // Auth: any of the three parties can terminate
    const isSublessor = req.user!.role === 'tenant' && req.user!.profileId === row.sublessor_tenant_id
    const isSublessee = req.user!.role === 'tenant' && req.user!.profileId === row.sublessee_tenant_id
    const isLandlord = canManageLandlordResource(req.user, row.landlord_id, [])
    if (!isSublessor && !isSublessee && !isLandlord) {
      throw new AppError(403, 'Forbidden')
    }

    const reasonPrefix =
      isSublessor ? 'sublessor_terminated' :
      isSublessee ? 'sublessee_terminated' :
      'landlord_terminated'

    const updated = await queryOne<any>(
      `UPDATE subleases
          SET status = 'terminated',
              terminated_at = NOW(),
              terminated_reason = $2 || ': ' || $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [row.id, reasonPrefix, body.reason],
    )

    // S199: credit-ledger event for early termination. Distinct from
    // the auto-termination cron (sublease_completed_natural) which
    // emits when end_date is reached as planned.
    try {
      await appendEvent({
        subjectType: 'tenant',
        subjectRefId: row.sublessor_tenant_id,
        eventType: 'sublease_terminated_early',
        eventData: {
          sublease_id: row.id,
          triggered_by: reasonPrefix,
          reason: body.reason,
        },
        occurredAt: new Date(),
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: { sublease_id: row.id },
        dimensionTags: ['tenancy_stability'],
        networkVisibility: 'visible_to_current_landlord',
      })
    } catch (e) {
      logger.error({ err: e }, '[CREDIT] sublease_terminated_early:')
    }

    // S198: notify the OTHER two parties — the one who triggered
    // doesn't need a ping. Pull all three, skip the trigger.
    try {
      const ctx = await queryOne<{
        sublessor_user_id: string
        sublessor_email:   string
        sublessee_user_id: string
        sublessee_email:   string
        landlord_user_id:  string
        landlord_email:    string
        unit_number:       string
        property_name:     string
      }>(
        `SELECT tu_or.id    AS sublessor_user_id,
                tu_or.email AS sublessor_email,
                tu_ee.id    AS sublessee_user_id,
                tu_ee.email AS sublessee_email,
                lu.id       AS landlord_user_id,
                lu.email    AS landlord_email,
                u.unit_number,
                p.name      AS property_name
           FROM subleases s
           JOIN leases     l   ON l.id = s.master_lease_id
           JOIN units      u   ON u.id = l.unit_id
           JOIN properties p   ON p.id = u.property_id
           JOIN landlords  la  ON la.id = l.landlord_id
           JOIN users      lu  ON lu.id = la.user_id
           JOIN tenants    t_or ON t_or.id = s.sublessor_tenant_id
           JOIN users      tu_or ON tu_or.id = t_or.user_id
           JOIN tenants    t_ee  ON t_ee.id = s.sublessee_tenant_id
           JOIN users      tu_ee ON tu_ee.id = t_ee.user_id
          WHERE s.id = $1`,
        [row.id],
      )
      if (ctx) {
        const { notifySubleaseTerminated } = await import('../services/notifications')
        const recipients: Array<{ userId: string; email: string }> = []
        if (!isSublessor) recipients.push({ userId: ctx.sublessor_user_id, email: ctx.sublessor_email })
        if (!isSublessee) recipients.push({ userId: ctx.sublessee_user_id, email: ctx.sublessee_email })
        if (!isLandlord)  recipients.push({ userId: ctx.landlord_user_id,  email: ctx.landlord_email })
        for (const r of recipients) {
          await notifySubleaseTerminated({
            recipientUserId: r.userId,
            recipientEmail:  r.email,
            subleaseId:      row.id,
            unitNumber:      ctx.unit_number,
            propertyName:    ctx.property_name,
            triggeredBy:     reasonPrefix as 'sublessor_terminated' | 'sublessee_terminated' | 'landlord_terminated',
            reason:          body.reason,
          })
        }
      }
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] sublease_terminated:')
    }

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── GET /api/subleases — list scoped per role ──────────────────────────────

// ── S248: Sublessor credit balance + withdraw ──────────────────────────────
// Tenants who sublease at a markup accrue the difference in
// sublessor_credit_balances. These routes expose the balance for the
// portal tile and let the sublessor pay it out to their bank via
// Stripe Connect Transfer.

// GET /api/subleases/me/credit — list all balances + grand total
subleasesRouter.get('/me/credit', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only tenants have sublessor credit balances')
    }
    const { getSublessorCredit } = await import('../services/subleaseAllocation')
    const view = await getSublessorCredit(req.user!.profileId)
    res.json({ success: true, data: view })
  } catch (e) { next(e) }
})

// POST /api/subleases/me/credit/withdraw — body: { amount }
// Fires Stripe Transfer to sublessor's user-level Connect account.
// Requires Connect onboarding complete + connect_payouts_enabled.
subleasesRouter.post('/me/credit/withdraw', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only tenants can withdraw sublessor credit')
    }
    const amount = Number(req.body?.amount)
    const { withdrawSublessorCredit } = await import('../services/subleaseAllocation')
    const out = await withdrawSublessorCredit({
      sublessorTenantId: req.user!.profileId,
      amountDollars:     amount,
    })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

subleasesRouter.get('/', async (req, res, next) => {
  try {
    const role = req.user!.role
    let rows: any[]

    if (role === 'tenant') {
      // S247: sublessee_tenant_id is nullable now (pending_invite case).
      // LEFT JOIN to tenants + sublessee_invitations so the sublessor's
      // pending_invite rows show up with the invitee email instead of
      // an internal name.
      rows = await query<any>(
        `SELECT s.*,
                l.unit_id, u.unit_number, p.name AS property_name,
                tu_or.first_name || ' ' || tu_or.last_name AS sublessor_name,
                tu_ee.first_name || ' ' || tu_ee.last_name AS sublessee_name,
                tu_or.email AS sublessor_email,
                COALESCE(tu_ee.email, si.sublessee_email) AS sublessee_email,
                si.status AS invitation_status,
                si.expires_at AS invitation_expires_at
           FROM subleases s
           JOIN leases l ON l.id = s.master_lease_id
           JOIN units u ON u.id = l.unit_id
           JOIN properties p ON p.id = u.property_id
           JOIN tenants t_or ON t_or.id = s.sublessor_tenant_id
           JOIN users   tu_or ON tu_or.id = t_or.user_id
           LEFT JOIN tenants t_ee ON t_ee.id = s.sublessee_tenant_id
           LEFT JOIN users   tu_ee ON tu_ee.id = t_ee.user_id
           LEFT JOIN sublessee_invitations si ON si.id = s.sublessee_invitation_id
          WHERE s.sublessor_tenant_id = $1
             OR s.sublessee_tenant_id = $1
          ORDER BY s.created_at DESC`,
        [req.user!.profileId],
      )
    } else if (role === 'landlord') {
      // S247: pending_invite subleases stay hidden from landlords
      // (filtered out below) — landlord only sees subleases once the
      // sublessee has accepted the invitation. The LEFT JOINs still
      // catch sublessee_tenant_id being null defensively.
      rows = await query<any>(
        `SELECT s.*,
                l.unit_id, u.unit_number, p.name AS property_name,
                tu_or.first_name || ' ' || tu_or.last_name AS sublessor_name,
                tu_ee.first_name || ' ' || tu_ee.last_name AS sublessee_name,
                tu_or.email AS sublessor_email,
                tu_ee.email AS sublessee_email
           FROM subleases s
           JOIN leases l ON l.id = s.master_lease_id
           JOIN units u ON u.id = l.unit_id
           JOIN properties p ON p.id = u.property_id
           JOIN tenants t_or ON t_or.id = s.sublessor_tenant_id
           JOIN users   tu_or ON tu_or.id = t_or.user_id
           LEFT JOIN tenants t_ee ON t_ee.id = s.sublessee_tenant_id
           LEFT JOIN users   tu_ee ON tu_ee.id = t_ee.user_id
          WHERE l.landlord_id = $1
            AND s.status <> 'pending_invite'
          ORDER BY s.created_at DESC`,
        [req.user!.profileId],
      )
    } else if (role === 'admin' || role === 'super_admin') {
      rows = await query<any>(
        `SELECT s.*,
                l.landlord_id, l.unit_id, u.unit_number, p.name AS property_name,
                tu_or.first_name || ' ' || tu_or.last_name AS sublessor_name,
                tu_ee.first_name || ' ' || tu_ee.last_name AS sublessee_name
           FROM subleases s
           JOIN leases l ON l.id = s.master_lease_id
           JOIN units u ON u.id = l.unit_id
           JOIN properties p ON p.id = u.property_id
           JOIN tenants t_or ON t_or.id = s.sublessor_tenant_id
           JOIN users   tu_or ON tu_or.id = t_or.user_id
           LEFT JOIN tenants t_ee ON t_ee.id = s.sublessee_tenant_id
           LEFT JOIN users   tu_ee ON tu_ee.id = t_ee.user_id
          ORDER BY s.created_at DESC`,
      )
    } else {
      rows = []
    }

    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── GET /api/subleases/:id ─────────────────────────────────────────────────

subleasesRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await queryOne<any>(
      `SELECT s.*,
              l.landlord_id, l.unit_id, u.unit_number, p.name AS property_name,
              tu_or.first_name || ' ' || tu_or.last_name AS sublessor_name,
              tu_ee.first_name || ' ' || tu_ee.last_name AS sublessee_name,
              tu_or.email AS sublessor_email,
              tu_ee.email AS sublessee_email
         FROM subleases s
         JOIN leases l ON l.id = s.master_lease_id
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
         JOIN tenants t_or ON t_or.id = s.sublessor_tenant_id
         JOIN users   tu_or ON tu_or.id = t_or.user_id
         JOIN tenants t_ee ON t_ee.id = s.sublessee_tenant_id
         JOIN users   tu_ee ON tu_ee.id = t_ee.user_id
        WHERE s.id = $1`,
      [req.params.id],
    )
    if (!row) throw new AppError(404, 'Sublease not found')

    // Auth: tenant on either side, or landlord on master lease, or admin
    const role = req.user!.role
    const isParty = role === 'tenant' && (
      row.sublessor_tenant_id === req.user!.profileId ||
      row.sublessee_tenant_id === req.user!.profileId
    )
    const isLandlord = role === 'landlord' && row.landlord_id === req.user!.profileId
    const isAdmin = role === 'admin' || role === 'super_admin'
    if (!isParty && !isLandlord && !isAdmin) {
      throw new AppError(403, 'Forbidden')
    }

    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// Suppress unused import warning — getClient is reserved for phase 2
// (transaction-aware sublease creation paired with notification emit).
void getClient
