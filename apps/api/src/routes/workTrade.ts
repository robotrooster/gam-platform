import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { landlordScopeIds, landlordIdForUnit, ownsLandlord } from '../lib/landlordScope'
import { logger } from '../lib/logger'
import { canManageLandlordResource } from '../middleware/scope'
import { workTradeFraction } from '../services/workTradeCredit'
import { EXTRA_HOURS_ON_LIVE_RUN_SQL, recordWorkTradeHoursPaidByHand } from '../services/workTradeBooksPay'
import { currentLedgerXid, kickLedgerAfterCommit } from '../services/ledgerEngine'
import { DateTime } from 'luxon'
import {
  lastBusinessDay, WORK_TRADE_SKILLS, WORK_TRADE_FIELD_PERMISSIONS, WORK_TRADE_COVERABLE,
  WORK_TRADE_COVERAGE_REMOVAL_CHOICES, WORK_TRADE_EXTRA_HOURS_MODES, WORK_TRADE_EXTRA_PAY_METHODS,
  WORK_TRADE_EXTRA_PAID_HOW,
} from '@gam/shared'

// 10/12: what a work trade covers, from the one shared list — and never
// nothing. An EMPTY list reads as "covers everything" to every billing run
// (invoiceGeneration, serviceAgreementInvoices), so a landlord who unticked the
// last box would have widened the trade to the whole bill. To stop a trade,
// end it.
const coveredChargesSchema = z.array(z.enum(WORK_TRADE_COVERABLE))
  .min(1, 'A work trade has to cover at least one charge. To stop it, end the agreement.')

/**
 * 10/12: the tenant's copy of an agreement row. The extra-hours rate is shown to
 * a tenant only while their agreement PAYS extra hours (Nic: "Show rate and
 * amount" for paid extra hours); a rate kept from an earlier setting is not
 * theirs to read. Nothing on the row prices a trade hour.
 */
function agreementForTenant<T extends Record<string, any> | null>(row: T): T {
  if (!row || row.extra_hours_mode === 'pay') return row
  return { ...row, extra_hours_rate: null }
}

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

/**
 * S624: the STANDING is the one work-trade fact both audiences read.
 *
 * `getAgreementForUser` is landlord-scope only, which is right for everything
 * that edits an agreement — but the hours a tenant owes are the tenant's own
 * business, and Nic's requirement is that they appear on the tenant's invoice.
 * Locking them behind landlord scope would mean a tenant being billed for hours
 * they were never shown.
 *
 * So this resolves EITHER party, and nobody else: the landlord side through the
 * usual scope check, and the tenant only when the agreement is theirs. It never
 * widens what a tenant can see — one agreement, their own.
 */
async function getAgreementForEitherParty(agreementId: string, user: any) {
  const agreement = await queryOne<any>(
    'SELECT * FROM work_trade_agreements WHERE id=$1', [agreementId])
  if (!agreement) throw new AppError(404, 'Agreement not found')

  if (canManageLandlordResource(user, agreement.landlord_id, ['property_manager'])) {
    return agreement
  }
  // 10/12: the session's user is `userId` — this read `user.id`, which no token
  // carries, so it matched no tenant and every tenant was refused their own
  // standing (the portal swallowed the 403 and showed no carried hours).
  const mine = await queryOne<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE t.user_id = $1 AND t.id = $2`,
    [user?.userId ?? null, agreement.tenant_id])
  if (mine) return agreement

  throw new AppError(403, 'Forbidden')
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
      // W-56: per-person target; the property value is only the default.
      monthlyHoursTarget: z.number().int().positive().optional(),
      // S637 (Nic): the parent switch. False = a trusted trade — covered charges
      // clear every month and nobody logs or approves hours. The target above is
      // still stored so switching tracking back on restores it.
      tracksHours: z.boolean().optional(),
      // S613 (Nic): what this agreement trades for. Omitted = everything, which
      // is what every agreement written before this did.
      coveredCharges: coveredChargesSchema.optional(),
    }).parse(req.body)

    // S633: the agreement belongs to the company that owns the unit it is
    // written against — derived and authorized in one step, rather than assumed
    // from whichever company the session sat on.
    const landlordId = await landlordIdForUnit(req.user!, body.unitId, query)
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [body.unitId])
    if (!unit) throw new AppError(404, 'Unit not found or access denied')

    // S397 → S576 (B-8): work trade is rent-for-labor, so it can only ride on a
    // LIVE tenancy — require an ACTIVE lease for this tenant ON THIS UNIT (not
    // just any lease anywhere in the portfolio). Without an active lease there's
    // no rent obligation for the labor to offset. If the lease later expires,
    // the 2am processor pauses the agreement (see scheduler.processLeaseEnds).
    const tenantLease = await queryOne<{ id: string }>(
      `SELECT l.id FROM leases l
       JOIN lease_tenants lt ON lt.lease_id = l.id
       WHERE lt.tenant_id = $1 AND l.landlord_id = $2 AND l.unit_id = $3
         AND l.status = 'active' AND lt.status = 'active'
       LIMIT 1`,
      [body.tenantId, landlordId, body.unitId])
    if (!tenantLease) throw new AppError(400, 'This tenant has no active lease on this unit. Work trade requires an active tenancy — add or renew the lease first.')

    // 10/6: the ONE insert of an agreement's terms (services/stayWorkTrade) —
    // the hours default to the property's work-trade setting, the covered
    // charges to everything — shared with a work trade made on a stay.
    const { insertWorkTradeAgreement } = await import('../services/stayWorkTrade')
    const agreement = await insertWorkTradeAgreement({ query: (sql: string, p?: any[]) => query(sql, p ?? []).then(rows => ({ rows })) } as any, {
      unitId: body.unitId, tenantId: body.tenantId, landlordId,
      duties: body.duties || null, startDate: body.startDate, endDate: body.endDate || null,
      renewalTerms: body.renewalTerms || null,
      hoursTarget: body.monthlyHoursTarget ?? null, tracksHours: body.tracksHours ?? true,
      coveredCharges: body.coveredCharges ?? null,
    })

    // S631 (Nic): "I have no way to mark that person as a work trade person
    // until they accept the invite and sign the lease. If they sign the lease
    // after the due date and then the bill automatically goes out, does it just
    // suspend an invoice that's already been sent?"
    //
    // It did not. A work-trade invoice issues GROSS and sits `late_fee_exempt`
    // while the tenant works the month off (S624) — but that exemption was
    // stamped at invoice GENERATION, from whether an agreement existed then. The
    // agreement cannot exist then: it requires an active lease, and the lease is
    // what the tenant is still signing. So the one ordering that actually
    // happens — invoice on the 1st, sign on the 4th, agreement on the 4th — left
    // the invoice chargeable, and the late-fee cron would fine a tenant for a
    // month they are working off.
    //
    // Starting an agreement now exempts the invoices it covers. Only OPEN ones,
    // and only cycles the agreement's own start date reaches — a debt from
    // before the trade began is still a debt.
    //
    // Late fees ALREADY CHARGED are deliberately left alone. Reversing them is a
    // credit, and a credit is the landlord's to issue (S630) — the settlement
    // report shows what accrued so they can decide.
    const exempted = await query<{ id: string }>(
      `UPDATE invoices i
          SET late_fee_exempt = true, updated_at = NOW()
        FROM leases l
       WHERE l.id = i.lease_id
         AND i.tenant_id = $1 AND l.unit_id = $2
         AND i.status IN ('pending', 'partial')
         AND i.late_fee_exempt = false
         AND i.due_date >= date_trunc('month', $3::date)
       RETURNING i.id`,
      [body.tenantId, body.unitId, body.startDate])
    if (exempted.length) {
      logger.info({ agreementId: agreement.id, invoices: exempted.length },
        'work trade: open invoices exempted from late fees for the trade period')
    }

    res.json({ success: true, data: { ...agreement, invoicesExempted: exempted.length } })
  } catch (e) { next(e) }
})

// ── GET AGREEMENT BY UNIT ─────────────────────────────────────

// ── S652: MAINTENANCE JOBS FOR WORK TRADERS ─────────────────────
// Declared before '/:id' so "jobs" is never read as an agreement id.

/** The caller's jobs: open ones they may take, theirs, and (trusted) ones to check. */
workTradeRouter.get('/jobs', async (req, res, next) => {
  try {
    const { jobsForTrader } = await import('../services/workTradeJobs')
    res.json({ success: true, data: await jobsForTrader(req.user!.userId) })
  } catch (e) { next(e) }
})

workTradeRouter.post('/jobs/:jobId/take', async (req, res, next) => {
  try {
    const { takeJob } = await import('../services/workTradeJobs')
    res.json({ success: true, data: await takeJob(req.user!.userId, req.params.jobId) })
  } catch (e) { next(e) }
})

workTradeRouter.post('/jobs/:jobId/done', async (req, res, next) => {
  try {
    const body = z.object({
      hours: z.number().positive().max(24).optional(),
      note: z.string().max(2000).optional(),
    }).parse(req.body ?? {})
    const { finishJob } = await import('../services/workTradeJobs')
    res.json({ success: true, data: await finishJob(req.user!.userId, req.params.jobId, body) })
  } catch (e) { next(e) }
})

/** Confirm finished skilled work: the landlord's side, or a trusted work trader. */
workTradeRouter.post('/jobs/:jobId/check', async (req, res, next) => {
  try {
    const job = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM maintenance_requests WHERE id=$1`, [req.params.jobId])
    if (!job) throw new AppError(404, 'Job not found')
    const asLandlord = canManageLandlordResource(req.user, job.landlord_id, ['property_manager', 'onsite_manager', 'maintenance'])
    const { checkJob } = await import('../services/workTradeJobs')
    res.json({ success: true, data: await checkJob(req.user!, req.params.jobId, asLandlord) })
  } catch (e) { next(e) }
})

// ── 10/12: PAID EXTRA HOURS — what the landlord owes, and paying it ──────────
// Declared before '/:id' so "extra-hours" is never read as an agreement id.
//
// Nic, 10/12: "Both." GAM shows what is owed; the landlord either pays by hand
// and presses Mark paid, or presses Send to GAM Books to have it paid through
// payroll (W-2) or a contractor payment (1099).

/**
 * Paid extra hours not yet paid, across every company the caller may pay them
 * for. 10/12: the same people who may pay them (payableForManager) — an owner,
 * or a property manager of that company. Pay owed to a person is a private
 * arrangement (S641); a team role that can see work trade but not pay it never
 * reads who is owed what.
 */
workTradeRouter.get('/extra-hours', requirePerm('work_trade.view'), async (req, res, next) => {
  try {
    const scoped = landlordScopeIds(req.user!)
    if (!scoped.length) throw new AppError(400, 'No landlord scope on this user')
    const landlordIds = scoped.filter(id => canManageLandlordResource(req.user, id, ['property_manager']))
    if (!landlordIds.length) throw new AppError(403, 'Forbidden')
    const rows = await query<any>(`
      SELECT x.id, x.agreement_id, x.status, x.hours::float AS hours, x.rate::float AS rate,
             x.amount::float AS amount, x.pay_method,
             to_char(x.period_month,'YYYY-MM-DD') AS period_month,
             to_char(x.period_start,'YYYY-MM-DD') AS period_start,
             x.sent_to_books_at, x.created_at,
             u.first_name AS tenant_first, u.last_name AS tenant_last,
             un.unit_number, p.name AS property_name
        FROM work_trade_extra_hours x
        JOIN work_trade_agreements wta ON wta.id = x.agreement_id
        JOIN tenants t ON t.id = x.tenant_id
        JOIN users u ON u.id = t.user_id
        JOIN units un ON un.id = wta.unit_id
        JOIN properties p ON p.id = un.property_id
       WHERE x.landlord_id = ANY($1::uuid[]) AND x.status IN ('unpaid', 'sent_to_books')
       ORDER BY x.period_start, u.last_name`, [landlordIds])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

/** Load a payable and check the caller may pay it: an owner, or a manager with work-trade permission. */
async function payableForManager(payableId: string, user: any) {
  const row = await queryOne<any>(`SELECT * FROM work_trade_extra_hours WHERE id = $1`, [payableId])
  if (!row) throw new AppError(404, 'Extra hours not found')
  if (!canManageLandlordResource(user, row.landlord_id, ['property_manager'])) {
    throw new AppError(403, 'Forbidden')
  }
  return row
}

/**
 * Paid by hand — a check or cash, on a date, with a note. Also closes one that
 * was sent to GAM Books and then paid another way.
 *
 * 10/12 (Nic): money out is ONE record (L5) — the same transaction records the
 * payment as a PAID expense under "Work trade labor" (to the work trader's
 * contractor vendor for a 1099 agreement; a plain expense for W-2 wages paid
 * outside payroll), so hours paid by hand reach the books and the P&L
 * (services/workTradeBooksPay recordWorkTradeHoursPaidByHand). Removing that
 * expense puts the hours back to owed.
 */
workTradeRouter.post('/extra-hours/:payableId/mark-paid', requirePerm('work_trade.manage'), async (req, res, next) => {
  try {
    const body = z.object({
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the date it was paid.'),
      paidHow: z.enum(WORK_TRADE_EXTRA_PAID_HOW),
      note: z.string().max(1000).optional(),
    }).parse(req.body)
    const before = await payableForManager(req.params.payableId, req.user)
    const tz = (await queryOne<{ timezone: string | null }>(
      `SELECT p.timezone FROM work_trade_agreements wta
         JOIN units un ON un.id = wta.unit_id JOIN properties p ON p.id = un.property_id
        WHERE wta.id = $1`, [before.agreement_id]))?.timezone || 'America/Phoenix'
    if (body.paidOn > DateTime.now().setZone(tz).toISODate()!) {
      throw new AppError(400, 'The date it was paid cannot be in the future.')
    }
    // 10/12 (Nic, ledger P7): hours GAM Books has picked up — on a payroll run
    // that is not voided, or a contractor bill that stands — are paid there.
    // Marked paid here too, the same hours would be paid twice.
    const BILL_STANDS = `EXISTS (SELECT 1 FROM landlord_expenses le
                                  WHERE le.id = x.books_reference_id AND le.status = 'active' AND le.voided_at IS NULL)`
    const inBooks = await queryOne<{ run: boolean; bill: boolean }>(
      `SELECT ${EXTRA_HOURS_ON_LIVE_RUN_SQL} AS run, ${BILL_STANDS} AS bill FROM work_trade_extra_hours x WHERE x.id = $1`,
      [before.id])
    if (inBooks?.run) throw new AppError(409, 'These extra hours are on a payroll run in GAM Books. Pay them there, or void that run first.')
    if (inBooks?.bill) throw new AppError(409, 'These extra hours are a contractor bill in GAM Books. Pay that bill there, or void it first.')
    const client = await getClient()
    let updated: any
    let xid: string
    try {
      await client.query('BEGIN')
      updated = (await client.query<any>(
        `UPDATE work_trade_extra_hours x
            SET status = 'paid', paid_on = $2::date, paid_how = $3, paid_note = $4,
                paid_by = $5, paid_at = NOW(), updated_at = NOW()
          WHERE x.id = $1 AND x.status IN ('unpaid', 'sent_to_books')
            AND NOT ${EXTRA_HOURS_ON_LIVE_RUN_SQL} AND NOT ${BILL_STANDS}
          RETURNING *`,
        [before.id, body.paidOn, body.paidHow, body.note?.trim() || null, req.user!.userId])).rows[0]
      if (!updated) {
        const now = (await client.query<{ status: string }>(`SELECT status FROM work_trade_extra_hours WHERE id = $1`, [before.id])).rows[0]
        throw new AppError(409, now?.status === 'paid'
          ? 'These extra hours are already marked paid.'
          : 'GAM Books has just picked these extra hours up. Pay them there.')
      }
      // 10/12 (Nic): the paid expense that records it (money out is one record).
      const paid = await recordWorkTradeHoursPaidByHand(client, { extraHoursId: before.id, createdBy: req.user!.userId })
      updated = { ...updated, books_reference_id: paid.expenseId }
      xid = await currentLedgerXid(client)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    void kickLedgerAfterCommit(xid)
    logger.info({ payableId: before.id, agreementId: before.agreement_id, by: req.user!.userId, expenseId: updated.books_reference_id },
      '[work-trade] extra hours marked paid by hand')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

/**
 * Queue for GAM Books: payroll (W-2) or a contractor payment (1099). The record
 * is marked sent with its pay method; books_reference_id stays NULL until GAM
 * Books picks it up and pays it.
 */
workTradeRouter.post('/extra-hours/:payableId/send-to-books', requirePerm('work_trade.manage'), async (req, res, next) => {
  try {
    const body = z.object({
      payMethod: z.enum(WORK_TRADE_EXTRA_PAY_METHODS).optional(),
    }).parse(req.body ?? {})
    const before = await payableForManager(req.params.payableId, req.user)
    const updated = await queryOne<any>(
      `UPDATE work_trade_extra_hours
          SET status = 'sent_to_books', pay_method = COALESCE($2, pay_method),
              sent_to_books_at = NOW(), sent_to_books_by = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'unpaid'
        RETURNING *`,
      [before.id, body.payMethod ?? null, req.user!.userId])
    if (!updated) {
      throw new AppError(409, before.status === 'paid'
        ? 'These extra hours are already marked paid.'
        : 'These extra hours were already sent to GAM Books.')
    }
    logger.info({ payableId: before.id, agreementId: before.agreement_id, payMethod: updated.pay_method },
      '[work-trade] extra hours sent to GAM Books')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

/** Work traders a landlord may assign a job at this property to. */
workTradeRouter.get('/assignable/:propertyId', requirePerm('maintenance.assign'), async (req, res, next) => {
  try {
    const prop = await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM properties WHERE id=$1`, [req.params.propertyId])
    if (!prop || !canManageLandlordResource(req.user, prop.landlord_id, ['property_manager', 'onsite_manager', 'maintenance'])) {
      throw new AppError(404, 'Property not found')
    }
    const { assignableForProperty } = await import('../services/workTradeJobs')
    res.json({ success: true, data: await assignableForProperty(req.params.propertyId) })
  } catch (e) { next(e) }
})

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
    // S633: the ACCOUNT owns companies — ask whether this company is one of
    // them, not whether it is the one the session sat on.
    const isOwnerLandlord = u.role === 'landlord' && ownsLandlord(u, unit.landlord_id)
    const isTeam = !!u.landlordId && u.landlordId === unit.landlord_id
    const isOwnTenant = u.role === 'tenant' && u.profileId === unit.tenant_id
    if (!isAdmin && !isOwnerLandlord && !isTeam && !isOwnTenant) {
      throw new AppError(403, 'Forbidden')
    }
    const agreement = await queryOne<any>(`
      SELECT wta.*,
        u.first_name as tenant_first, u.last_name as tenant_last, u.email as tenant_email,
        un.unit_number, p.name as property_name, wta.monthly_hours_target AS target
      FROM work_trade_agreements wta
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users u ON u.id = t.user_id
      JOIN units un ON un.id = wta.unit_id
      JOIN properties p ON p.id = un.property_id
      WHERE wta.unit_id=$1 AND wta.status='active'
      ORDER BY wta.created_at DESC LIMIT 1`,
      [req.params.unitId]
    )
    res.json({ success: true, data: isOwnTenant ? agreementForTenant(agreement) : agreement })
  } catch (e) { next(e) }
})

// ── GET AGREEMENT WITH LOGS + CURRENT-MONTH PROGRESS ──────────

workTradeRouter.get('/:id', async (req, res, next) => {
  try {
    const agreement = await queryOne<any>(`
      SELECT wta.*, wta.monthly_hours_target AS target,
        un.unit_number, p.name as property_name, p.id AS property_id,
        tu.first_name AS tenant_first, tu.last_name AS tenant_last, tu.id AS tenant_user_id
      FROM work_trade_agreements wta
      JOIN units un ON un.id = wta.unit_id
      JOIN properties p ON p.id = un.property_id
      LEFT JOIN tenants tt ON tt.id = wta.tenant_id
      LEFT JOIN users tu ON tu.id = tt.user_id
      WHERE wta.id=$1`, [req.params.id])
    if (!agreement) throw new AppError(404, 'Not found')
    // S397: validate caller scope (owner landlord / team / own tenant / admin).
    const u = req.user!
    const isAdmin = u.role === 'admin' || u.role === 'super_admin'
    // S633: any company the account owns.
    const isOwnerLandlord = u.role === 'landlord' && ownsLandlord(u, agreement.landlord_id)
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
    // S637: tracks_hours is the parent switch — a trusted agreement asks for no
    // hours, so its effective target is 0 and workTradeFraction reads that as
    // fully covered.
    const target = agreement.tracks_hours === false ? 0 : Number(agreement.target)
    const approvedThisMonth = logs.filter(l => l.status === 'approved' && inThisMonth(l.work_date))
    const hoursApprovedThisMonth = approvedThisMonth.reduce((s: number, l: any) => s + parseFloat(l.hours), 0)
    const pendingLogs = logs.filter(l => l.status === 'pending')
    const fraction = workTradeFraction(hoursApprovedThisMonth, target)

    // S652 (Nic): "keep track of how many total sets of hours they turn in and
    // percentage of denied versus approved... hey, you don't do the right thing
    // half the time." Counted by submissions AND by hours — a denied 10-hour
    // day and a denied half hour are not the same thing.
    const decided = logs.filter((l: any) => l.status === 'approved' || l.status === 'rejected')
    const sumH = (xs: any[]) => xs.reduce((s: number, l: any) => s + parseFloat(l.hours), 0)
    const approvedAll = logs.filter((l: any) => l.status === 'approved')
    const deniedAll = logs.filter((l: any) => l.status === 'rejected')
    const pct = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 10 : null
    const record = {
      submitted: logs.length,
      approved: approvedAll.length,
      denied: deniedAll.length,
      logged: pendingLogs.length,
      approvedPct: pct(approvedAll.length, decided.length),
      deniedPct: pct(deniedAll.length, decided.length),
      hoursApproved: sumH(approvedAll),
      hoursDenied: sumH(deniedAll),
      hoursDeniedPct: pct(sumH(deniedAll), sumH(decided)),
    }
    // Hours are reviewed by the last business day of the month — the same day
    // meters are read. Anything still logged then counts as not worked.
    const tz = (await queryOne<{ timezone: string | null }>(
      `SELECT p.timezone FROM units un JOIN properties p ON p.id=un.property_id WHERE un.id=$1`,
      [agreement.unit_id]))?.timezone || 'America/Phoenix'
    const nowTz = DateTime.now().setZone(tz)
    const reviewBy = lastBusinessDay(nowTz.year, nowTz.month, tz).toISODate()

    res.json({
      success: true,
      data: {
        agreement: isOwnTenant ? agreementForTenant(agreement) : agreement,
        logs,
        stats: {
          target,
          hoursApprovedThisMonth,
          pendingCount: pendingLogs.length,
          creditFraction: fraction,
          creditPct: Math.round(fraction * 1000) / 10,   // e.g. 62.5
          reviewBy,
        },
        record,
        // S652: this person's jobs, for the landlord's copy of the window —
        // what they have on the go and what they finished lately.
        jobs: await query<any>(`
          SELECT mr.id, mr.title, mr.category, mr.status, mr.needs_check, mr.completed_at,
                 un.unit_number
            FROM maintenance_requests mr JOIN units un ON un.id = mr.unit_id
           WHERE (mr.assigned_to = $1 OR mr.done_by_user_id = $1)
             AND (mr.status IN ('assigned','in_progress') OR mr.completed_at > NOW() - interval '60 days')
           ORDER BY mr.status = 'completed', mr.completed_at DESC NULLS FIRST
           LIMIT 40`, [agreement.tenant_user_id ?? null]),
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
    // S633: any company the account owns.
    const isOwnerLandlord = u.role === 'landlord' && ownsLandlord(u, agreement.landlord_id)
    const isTeam = !!u.landlordId && u.landlordId === agreement.landlord_id
    if (!isOwnTenant && !isAdmin && !isOwnerLandlord && !isTeam) {
      throw new AppError(403, 'Forbidden')
    }

    // S652: a TRUSTED person's hours count the moment they log them (Nic:
    // "some people can be trusted to do their own hours"); hours the landlord's
    // side logs are the reviewer's own word. Everyone else's stay "logged"
    // until approved or denied.
    const approvedNow = (isOwnTenant && agreement.trusted === true) || isOwnerLandlord || isTeam || isAdmin
    const log = await queryOne<any>(`
      INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description,
                                   status, reviewed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [agreement.id, agreement.tenant_id, req.user!.userId, body.workDate, body.hours, body.description,
       approvedNow ? 'approved' : 'pending', approvedNow ? new Date() : null]
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
    // S633: a read — every company the account owns.
    const landlordIds = landlordScopeIds(req.user!)
    if (!landlordIds.length) throw new AppError(400, 'No landlord scope on this user')
    const agreements = await query<any>(`
      SELECT wta.*,
        u.first_name as tenant_first, u.last_name as tenant_last,
        un.unit_number, p.id as property_id, p.name as property_name,
        wta.monthly_hours_target AS target,
        -- W-56: the roster row click-through pulls up the tenant's lease.
        (SELECT l.id FROM leases l
          JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.tenant_id = wta.tenant_id
         WHERE l.unit_id = wta.unit_id AND l.status = 'active'
         ORDER BY l.start_date DESC LIMIT 1) AS lease_id,
        (SELECT COUNT(*) FROM work_trade_logs wtl
          WHERE wtl.agreement_id=wta.id AND wtl.status='pending') as pending_count,
        (SELECT COALESCE(SUM(l.hours),0) FROM work_trade_logs l
          WHERE l.agreement_id=wta.id AND l.status='approved'
            AND date_trunc('month', l.work_date) = date_trunc('month', CURRENT_DATE)) as hours_this_month,
        -- S576 (B-8): the latest work-trade addendum document for this agreement
        -- (stamped work_trade_agreement_id when sent). Drives the "addendum on
        -- file / send addendum" surface on the row.
        (SELECT json_build_object('id', d.id, 'status', d.status, 'title', d.title)
           FROM lease_documents d
          WHERE d.work_trade_agreement_id = wta.id
          ORDER BY d.created_at DESC LIMIT 1) AS addendum_doc
      FROM work_trade_agreements wta
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users u ON u.id = t.user_id
      JOIN units un ON un.id = wta.unit_id
      JOIN properties p ON p.id = un.property_id
      WHERE wta.landlord_id = ANY($1::uuid[])
      ORDER BY wta.created_at DESC`,
      [landlordIds]
    )
    res.json({ success: true, data: agreements })
  } catch (e) { next(e) }
})

// ── WHERE THE TENANT STANDS, IN HOURS ─────────────────────────
//
// S624 (Nic, S623): the next invoice must state "both the new month's hours owed
// and the hours still owed from the carried balance." Both audiences read the
// same figures from the same place — a tenant seeing one number and a landlord
// seeing another is how a work-trade argument starts.
workTradeRouter.get('/:id/standing', async (req, res, next) => {
  try {
    const agreement = await getAgreementForEitherParty(req.params.id, req.user!)
    // S643 (Nic, DIRECTIVE): the tenant's copy of this never carries a dollar
    // figure next to an hour count — "don't show the tenant any sort of hourly
    // rate... that's when they decide it's not worth it." The two audiences
    // still read the SAME HOURS from the same place, which is the point of one
    // endpoint; what differs is only whether the shortfall is priced. Decided
    // here rather than on the screen so the tenant portal cannot render it by
    // accident (see the audience-isolation rule).
    const audience = canManageLandlordResource(
      req.user, agreement.landlord_id, ['property_manager']) ? 'landlord' : 'tenant'
    const { loadWorkTradeStanding } = await import('../services/workTradeStanding')
    const standing = await loadWorkTradeStanding(
      req.params.id,
      typeof req.query.month === 'string' ? req.query.month : undefined,
      audience)
    if (!standing) throw new AppError(404, 'Work-trade agreement not found')
    res.json({ success: true, data: standing })
  } catch (e) { next(e) }
})

// ── 10/12: OPEN CHARGES PARKED UNDER THE TRADE, BY KIND ──────────────────────
//
// What the landlord is asked about when unticking a type that has open parked
// charges: "Keep the open Water charges covered" or "Put them back on the
// tenant's balance". Landlord side only.
workTradeRouter.get('/:id/covered-open', requirePerm('work_trade.view'), async (req, res, next) => {
  try {
    await getAgreementForUser(req.params.id, req.user!)
    const { openCoveredByKind } = await import('../services/workTradeCoverage')
    res.json({ success: true, data: await openCoveredByKind(
      { query: (sql: string, p?: any[]) => query(sql, p ?? []).then(rows => ({ rows })) } as any, req.params.id) })
  } catch (e) { next(e) }
})

// ── 10/12: THIS AGREEMENT'S PAID EXTRA HOURS (landlord) ──────────────────────
workTradeRouter.get('/:id/extra-hours', requirePerm('work_trade.view'), async (req, res, next) => {
  try {
    await getAgreementForUser(req.params.id, req.user!)
    const rows = await query<any>(`
      SELECT x.id, x.status, x.hours::float AS hours, x.rate::float AS rate, x.amount::float AS amount,
             x.pay_method, to_char(x.period_month,'YYYY-MM-DD') AS period_month,
             to_char(x.paid_on,'YYYY-MM-DD') AS paid_on, x.paid_how, x.paid_note,
             x.sent_to_books_at, x.created_at
        FROM work_trade_extra_hours x
       WHERE x.agreement_id = $1
       ORDER BY x.period_start DESC, x.created_at DESC`, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── UPDATE AGREEMENT STATUS ───────────────────────────────────

workTradeRouter.patch('/:id', requirePerm('work_trade.manage'), async (req, res, next) => {
  try {
    const { status, endDate, monthlyHoursTarget, tracksHours, coveredCharges, carryForwardMonths,
            trusted, skills, duties, carryForwardIndefinite, fieldPermissions,
            openCoveredCharges, extraHours, extraHoursRate, extraHoursPayMethod } = z.object({
      // S652: trusted or monitored, what they can fix, and the duties in words.
      trusted: z.boolean().optional(),
      skills: z.array(z.enum(WORK_TRADE_SKILLS as unknown as [string, ...string[]])).optional(),
      // S652: field work the landlord lets this person do from their tenant portal.
      fieldPermissions: z.array(z.enum(WORK_TRADE_FIELD_PERMISSIONS as unknown as [string, ...string[]])).optional(),
      duties: z.string().max(5000).nullable().optional(),
      coveredCharges: coveredChargesSchema.optional(),
      // 10/12 (Nic): a type taken off while open charges of it are parked under
      // the trade — the landlord's choice at that moment. Not sent = keep them
      // covered.
      openCoveredCharges: z.enum(WORK_TRADE_COVERAGE_REMOVAL_CHOICES).optional(),
      // 10/12 (Nic): "When they work more hours than the agreement needs" —
      // bank them, or pay them at an hourly rate by payroll or 1099.
      extraHours: z.enum(WORK_TRADE_EXTRA_HOURS_MODES).optional(),
      // Dollars and cents: the column is numeric(10,2), so 0.004 would store as
      // 0.00, break the positive-rate CHECK and fail as a 500 (10/12 review).
      extraHoursRate: z.number().min(0.01, 'Set a rate of at least $0.01.').max(1000)
        .multipleOf(0.01, 'Set the rate in dollars and cents.').optional(),
      extraHoursPayMethod: z.enum(WORK_TRADE_EXTRA_PAY_METHODS).optional(),
      status:  z.enum(['active','paused','ended']).optional(),
      endDate: z.string().optional(),
      // W-56: per-person target is editable on the agreement.
      monthlyHoursTarget: z.number().int().positive().optional(),
      tracksHours: z.boolean().optional(),   // S637: parent switch
      // S624 (Nic): how long a shortfall may carry before it is billed in cash
      // and the agreement ends. "My two month rule was just an example. If a
      // landlord wants to give leniency for six months, they may choose to do
      // so... but at some point, a landlord's gonna know that somebody's never
      // gonna be able to physically catch up." 0 = bill at the first close.
      carryForwardMonths: z.number().int().min(0).max(24).optional(),
      // S652: float a shortfall with no deadline while the agreement runs.
      carryForwardIndefinite: z.boolean().optional(),
    }).parse(req.body)

    const before = await getAgreementForUser(req.params.id, req.user!)
    // Only a LIVE agreement has a remainder to bill. Re-ending an ended one must
    // not charge the tenant a second time.
    const wasActive = (before as any)?.status !== 'ended'

    // 10/12: paying extra hours needs a rate and a way to pay them — the ones
    // sent now, or the ones the agreement already holds.
    if ((extraHours ?? before.extra_hours_mode) === 'pay'
        && (!(Number(extraHoursRate ?? before.extra_hours_rate) > 0) || !(extraHoursPayMethod ?? before.extra_hours_pay_method))) {
      throw new AppError(400, 'To pay extra hours, set the hourly rate and how they are paid (payroll or a contractor payment).')
    }

    // One transaction: the new terms, and (10/12) what a change of coverage
    // does to the bills already out — they land together or not at all.
    const client = await getClient()
    let updated: any
    let coverage: Awaited<ReturnType<typeof import('../services/workTradeCoverage')['applyCoverageChange']>> | null = null
    try {
      await client.query('BEGIN')
      const fresh = (await client.query<{ covered_charges: string[]; status: string }>(
        `SELECT covered_charges, status FROM work_trade_agreements WHERE id = $1 FOR UPDATE`,
        [req.params.id])).rows[0]
      updated = (await client.query<any>(`
        UPDATE work_trade_agreements SET
          status=COALESCE($1,status),
          end_date=COALESCE($2,end_date),
          monthly_hours_target=COALESCE($4,monthly_hours_target),
          covered_charges=COALESCE($5::text[], covered_charges),
          carry_forward_months=COALESCE($6,carry_forward_months),
          tracks_hours=COALESCE($7,tracks_hours),
          trusted=COALESCE($8,trusted),
          skills=COALESCE($9::text[],skills),
          duties=CASE WHEN $10::boolean THEN $11 ELSE duties END,
          carry_forward_indefinite=COALESCE($12,carry_forward_indefinite),
          field_permissions=COALESCE($13::text[],field_permissions),
          extra_hours_mode=COALESCE($14,extra_hours_mode),
          extra_hours_rate=COALESCE($15,extra_hours_rate),
          extra_hours_pay_method=COALESCE($16,extra_hours_pay_method),
          -- 10/6 (review): a work trade made on a reservation that the landlord
          -- ENDS here no longer follows the stay — a later change to the stay
          -- (a drag, an edit, Add a month) must not bring it back.
          booking_id=CASE WHEN $1::text = 'ended' THEN NULL ELSE booking_id END,
          updated_at=NOW()
        WHERE id=$3 RETURNING *`,
        [status || null, endDate || null, req.params.id, monthlyHoursTarget ?? null,
         coveredCharges ?? null, carryForwardMonths ?? null, tracksHours ?? null,
         trusted ?? null, skills ?? null, duties !== undefined, duties ?? null, carryForwardIndefinite ?? null,
         fieldPermissions ?? null, extraHours ?? null, extraHoursRate ?? null, extraHoursPayMethod ?? null]
      )).rows[0]

      // 10/12 (Nic, Curtis Clabough): a change of coverage used to reach only
      // the NEXT bill. Now a type added brings the still-open charges of it on
      // this agreement's bills under the trade, and a type taken off does what
      // the landlord chose for its open parked charges. An agreement that has
      // ended has no month left to settle anything, so nothing is parked on it.
      if (coveredCharges && fresh && fresh.status !== 'ended') {
        const { applyCoverageChange } = await import('../services/workTradeCoverage')
        coverage = await applyCoverageChange(client, {
          agreementId: req.params.id, from: fresh.covered_charges, to: coveredCharges,
          removal: openCoveredCharges ?? 'keep_covered',
        })
        if (coverage.parked || coverage.covered || coverage.putBack) {
          logger.info({ agreementId: req.params.id, coverage }, '[work-trade] coverage change reached the bills already out')
        }
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }

    // S624 (Nic): "when the landlord marks the work trade agreement as over, any
    // percentage of hours unpaid or uncompleted is billed immediately."
    //
    // Settling here rather than waiting for the next month-close is the whole
    // point — an ended agreement has no next month, and the hours owed would
    // otherwise sit open forever with nothing to collect them. Runs AFTER the
    // status write so the settlement sees the agreement in its final state.
    //
    // Deliberately not fatal: the status change is the landlord's decision and
    // must stand even if billing the remainder fails. A failure here leaves open
    // periods that the month-close run will still find.
    // S652: an agreement that stops hands back the jobs its person had taken.
    if ((status === 'ended' || status === 'paused') && wasActive) {
      const { releaseJobsFor } = await import('../services/workTradeJobs')
      await releaseJobsFor({ query: (sql: string, p: any[]) => query(sql, p) }, [req.params.id])
    }
    let settlement = null
    if (status === 'ended' && wasActive) {
      try {
        const { settleAgreementOnEnd } = await import('../jobs/workTradeSettlement')
        settlement = await settleAgreementOnEnd(req.params.id)
      } catch (e) {
        logger.error({ err: e, agreement_id: req.params.id },
          '[work-trade] ending settlement failed; status change stands')
      }
    }
    res.json({ success: true, data: { ...updated, settlement, coverage } })
  } catch (e) { next(e) }
})
