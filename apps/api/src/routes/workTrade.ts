import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { resolveLandlordIdForUser } from '../lib/scope'
import { canManageLandlordResource } from '../middleware/scope'
import { workTradeFraction } from '../services/workTradeCredit'

// ============================================================
// S517 / Walkthrough Landlord #29 — work-trade routes, percent model.
//
// An agreement is just the enrollment (tenant + unit + duties + term). The
// tenant logs hours (work_trade_logs); the landlord approves/rejects. There
// are no dollar terms and no per-agreement reconciliation: at invoice
// generation, approved hours from the prior month buy a percent of the
// invoice total against the PROPERTY's monthly hours target
// (properties.work_trade_hours_target). See services/workTradeCredit.ts +
// jobs/invoiceGeneration.ts for the billing wire.
// ============================================================

export const workTradeRouter = Router()
workTradeRouter.use(requireAuth)

// ── HELPERS ──────────────────────────────────────────────────

// S130: resolve agreement and verify caller has landlord-scope authority
// over it (covers owner landlord + scoped team workers).
async function getAgreementForUser(agreementId: string, user: any) {
  const agreement = await queryOne<any>(
    'SELECT * FROM work_trade_agreements WHERE id=$1', [agreementId]
  )
  if (!agreement) throw new AppError(404, 'Agreement not found')
  if (!canManageLandlordResource(user, agreement.landlord_id, ['property_manager'])) {
    throw new AppError(403, 'Forbidden')
  }
  return agreement
}

// ── PROPERTY HOURS TARGET (the credit denominator) ───────────

// Read a property's monthly work-trade hours target.
workTradeRouter.get('/property/:propertyId/target', requirePerm('work_trade.view'), async (req, res, next) => {
  try {
    const prop = await queryOne<{ id: string; landlord_id: string; work_trade_hours_target: number }>(
      'SELECT id, landlord_id, work_trade_hours_target FROM properties WHERE id=$1', [req.params.propertyId]
    )
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    res.json({ success: true, data: { propertyId: prop.id, target: prop.work_trade_hours_target } })
  } catch (e) { next(e) }
})

// Set a property's monthly work-trade hours target. A full target month of
// verified hours covers 100% of that month's invoice.
workTradeRouter.patch('/property/:propertyId/target', requirePerm('work_trade.manage'), async (req, res, next) => {
  try {
    const { target } = z.object({
      target: z.number().int().positive().max(744),   // 744 = 31×24, a hard sanity cap
    }).parse(req.body)
    const prop = await queryOne<{ id: string; landlord_id: string }>(
      'SELECT id, landlord_id FROM properties WHERE id=$1', [req.params.propertyId]
    )
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    const updated = await queryOne<{ work_trade_hours_target: number }>(
      'UPDATE properties SET work_trade_hours_target=$1, updated_at=NOW() WHERE id=$2 RETURNING work_trade_hours_target',
      [target, prop.id]
    )
    res.json({ success: true, data: { propertyId: prop.id, target: updated!.work_trade_hours_target } })
  } catch (e) { next(e) }
})

// ── CREATE AGREEMENT (enrollment only) ───────────────────────

workTradeRouter.post('/', requirePerm('work_trade.manage'), async (req, res, next) => {
  try {
    const body = z.object({
      unitId:       z.string().uuid(),
      tenantId:     z.string().uuid(),
      duties:       z.string().optional(),
      startDate:    z.string(),
      endDate:      z.string().optional(),
      renewalTerms: z.string().optional(),
    }).parse(req.body)

    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')

    // Verify unit belongs to landlord
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [body.unitId, landlordId])
    if (!unit) throw new AppError(404, 'Unit not found or access denied')

    // S397: verify the tenant has a lease in caller's portfolio (no
    // cross-tenant assignment).
    const tenantLease = await queryOne<{ id: string }>(
      `SELECT l.id FROM leases l
       JOIN lease_tenants lt ON lt.lease_id = l.id
       WHERE lt.tenant_id = $1 AND l.landlord_id = $2 LIMIT 1`,
      [body.tenantId, landlordId])
    if (!tenantLease) throw new AppError(404, 'Tenant has no lease under this landlord')

    const agreement = await queryOne<any>(`
      INSERT INTO work_trade_agreements
        (unit_id, tenant_id, landlord_id, duties, start_date, end_date, renewal_terms)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`,
      [body.unitId, body.tenantId, landlordId, body.duties || null,
       body.startDate, body.endDate || null, body.renewalTerms || null]
    )

    res.json({ success: true, data: agreement })
  } catch (e) { next(e) }
})

// ── GET AGREEMENT BY UNIT ─────────────────────────────────────

workTradeRouter.get('/unit/:unitId', async (req, res, next) => {
  try {
    // S397: validate caller can access the unit's landlord scope OR is the
    // tenant on the unit.
    const unit = await queryOne<{ landlord_id: string; tenant_id: string | null }>(
      `SELECT u.landlord_id,
              (SELECT lt.tenant_id FROM lease_tenants lt
                JOIN leases l ON l.id = lt.lease_id
               WHERE l.unit_id = u.id AND lt.status='active' LIMIT 1) AS tenant_id
         FROM units u WHERE u.id=$1`,
      [req.params.unitId])
    if (!unit) throw new AppError(404, 'Unit not found')
    const u = req.user!
    const isAdmin = u.role === 'admin' || u.role === 'super_admin'
    const isOwnerLandlord = u.role === 'landlord' && u.profileId === unit.landlord_id
    const isTeam = !!u.landlordId && u.landlordId === unit.landlord_id
    const isOwnTenant = u.role === 'tenant' && u.profileId === unit.tenant_id
    if (!isAdmin && !isOwnerLandlord && !isTeam && !isOwnTenant) {
      throw new AppError(403, 'Forbidden')
    }
    const agreement = await queryOne<any>(`
      SELECT wta.*,
        u.first_name as tenant_first, u.last_name as tenant_last, u.email as tenant_email,
        un.unit_number, p.name as property_name, p.work_trade_hours_target AS target
      FROM work_trade_agreements wta
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users u ON u.id = t.user_id
      JOIN units un ON un.id = wta.unit_id
      JOIN properties p ON p.id = un.property_id
      WHERE wta.unit_id=$1 AND wta.status='active'
      ORDER BY wta.created_at DESC LIMIT 1`,
      [req.params.unitId]
    )
    res.json({ success: true, data: agreement })
  } catch (e) { next(e) }
})

// ── GET AGREEMENT WITH LOGS + CURRENT-MONTH PROGRESS ──────────

workTradeRouter.get('/:id', async (req, res, next) => {
  try {
    const agreement = await queryOne<any>(`
      SELECT wta.*, p.work_trade_hours_target AS target,
        un.unit_number, p.name as property_name
      FROM work_trade_agreements wta
      JOIN units un ON un.id = wta.unit_id
      JOIN properties p ON p.id = un.property_id
      WHERE wta.id=$1`, [req.params.id])
    if (!agreement) throw new AppError(404, 'Not found')
    // S397: validate caller scope (owner landlord / team / own tenant / admin).
    const u = req.user!
    const isAdmin = u.role === 'admin' || u.role === 'super_admin'
    const isOwnerLandlord = u.role === 'landlord' && u.profileId === agreement.landlord_id
    const isTeam = !!u.landlordId && u.landlordId === agreement.landlord_id
    const isOwnTenant = u.role === 'tenant' && u.profileId === agreement.tenant_id
    if (!isAdmin && !isOwnerLandlord && !isTeam && !isOwnTenant) {
      throw new AppError(403, 'Forbidden')
    }

    const logs = await query<any>(`
      SELECT wtl.*, u.first_name, u.last_name,
        ru.first_name as reviewer_first, ru.last_name as reviewer_last
      FROM work_trade_logs wtl
      JOIN users u ON u.id = wtl.submitted_by
      LEFT JOIN users ru ON ru.id = wtl.reviewed_by
      WHERE wtl.agreement_id=$1
      ORDER BY wtl.work_date DESC`, [req.params.id])

    // Current-month progress: approved hours logged THIS calendar month are
    // what the tenant is earning toward NEXT month's invoice credit.
    const now = new Date()
    const inThisMonth = (d: string) => {
      const wd = new Date(d)
      return wd.getMonth() === now.getMonth() && wd.getFullYear() === now.getFullYear()
    }
    const target = Number(agreement.target)
    const approvedThisMonth = logs.filter(l => l.status === 'approved' && inThisMonth(l.work_date))
    const hoursApprovedThisMonth = approvedThisMonth.reduce((s: number, l: any) => s + parseFloat(l.hours), 0)
    const pendingLogs = logs.filter(l => l.status === 'pending')
    const fraction = workTradeFraction(hoursApprovedThisMonth, target)

    res.json({
      success: true,
      data: {
        agreement,
        logs,
        stats: {
          target,
          hoursApprovedThisMonth,
          pendingCount: pendingLogs.length,
          creditFraction: fraction,
          creditPct: Math.round(fraction * 1000) / 10,   // e.g. 62.5
        }
      }
    })
  } catch (e) { next(e) }
})

// ── TENANT: SUBMIT HOURS ──────────────────────────────────────

workTradeRouter.post('/:id/logs', async (req, res, next) => {
  try {
    const body = z.object({
      workDate:    z.string(),
      hours:       z.number().positive().max(24),
      description: z.string().min(3),
    }).parse(req.body)

    const agreement = await queryOne<any>('SELECT * FROM work_trade_agreements WHERE id=$1', [req.params.id])
    if (!agreement) throw new AppError(404, 'Agreement not found')
    if (agreement.status !== 'active') throw new AppError(400, 'Agreement is not active')

    // S397: own-tenant OR own-landlord-scope may submit (landlord can log a
    // substitute entry); strangers cannot.
    const u = req.user!
    const isOwnTenant = u.role === 'tenant' && u.profileId === agreement.tenant_id
    const isAdmin = u.role === 'admin' || u.role === 'super_admin'
    const isOwnerLandlord = u.role === 'landlord' && u.profileId === agreement.landlord_id
    const isTeam = !!u.landlordId && u.landlordId === agreement.landlord_id
    if (!isOwnTenant && !isAdmin && !isOwnerLandlord && !isTeam) {
      throw new AppError(403, 'Forbidden')
    }

    const log = await queryOne<any>(`
      INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [agreement.id, agreement.tenant_id, req.user!.userId, body.workDate, body.hours, body.description]
    )

    res.json({ success: true, data: log })
  } catch (e) { next(e) }
})

// ── LANDLORD: APPROVE / REJECT LOG ───────────────────────────

workTradeRouter.patch('/logs/:logId', requirePerm('work_trade.reconcile'), async (req, res, next) => {
  try {
    const { action, rejectionReason } = z.object({
      action:          z.enum(['approve','reject']),
      rejectionReason: z.string().optional(),
    }).parse(req.body)

    const log = await queryOne<any>(
      'SELECT * FROM work_trade_logs WHERE id=$1', [req.params.logId]
    )
    if (!log) throw new AppError(404, 'Log not found')

    // Scope check (also 404s a stranger's agreement before any write).
    await getAgreementForUser(log.agreement_id, req.user!)

    // No per-log dollar value in the percent model — approval simply makes
    // the hours count toward the next invoice's credit.
    const updated = await queryOne<any>(`
      UPDATE work_trade_logs SET
        status=$1, reviewed_by=$2, reviewed_at=NOW(),
        rejection_reason=$3
      WHERE id=$4 RETURNING *`,
      [action === 'approve' ? 'approved' : 'rejected',
       req.user!.userId, rejectionReason || null, log.id]
    )

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── GET ALL WORK TRADE FOR LANDLORD (dashboard) ───────────────

workTradeRouter.get('/', requirePerm('work_trade.view'), async (req, res, next) => {
  try {
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')
    const agreements = await query<any>(`
      SELECT wta.*,
        u.first_name as tenant_first, u.last_name as tenant_last,
        un.unit_number, p.id as property_id, p.name as property_name, p.work_trade_hours_target AS target,
        (SELECT COUNT(*) FROM work_trade_logs wtl
          WHERE wtl.agreement_id=wta.id AND wtl.status='pending') as pending_count,
        (SELECT COALESCE(SUM(l.hours),0) FROM work_trade_logs l
          WHERE l.agreement_id=wta.id AND l.status='approved'
            AND date_trunc('month', l.work_date) = date_trunc('month', CURRENT_DATE)) as hours_this_month
      FROM work_trade_agreements wta
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users u ON u.id = t.user_id
      JOIN units un ON un.id = wta.unit_id
      JOIN properties p ON p.id = un.property_id
      WHERE wta.landlord_id=$1
      ORDER BY wta.created_at DESC`,
      [landlordId]
    )
    res.json({ success: true, data: agreements })
  } catch (e) { next(e) }
})

// ── UPDATE AGREEMENT STATUS ───────────────────────────────────

workTradeRouter.patch('/:id', requirePerm('work_trade.manage'), async (req, res, next) => {
  try {
    const { status, endDate } = z.object({
      status:  z.enum(['active','paused','ended']).optional(),
      endDate: z.string().optional(),
    }).parse(req.body)

    await getAgreementForUser(req.params.id, req.user!)

    const updated = await queryOne<any>(`
      UPDATE work_trade_agreements SET
        status=COALESCE($1,status),
        end_date=COALESCE($2,end_date),
        updated_at=NOW()
      WHERE id=$3 RETURNING *`,
      [status || null, endDate || null, req.params.id]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})
