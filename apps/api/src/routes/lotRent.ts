// Lot-rent obligations + investor net (S568, Nic). The operator's expense to an
// external park (homes-only properties). GAM tracks the obligation + paid status.
import { Router } from 'express'
import { query } from '../db'
import { requireAuth, requireLandlord, requireAdmin } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { resolveLandlordTarget, landlordScopeIds, ownsLandlord } from '../lib/landlordScope'
import { getInvestorPortfolio, recordLotRentPaid, accrueLotRentCharges } from '../services/lotRent'

export const lotRentRouter = Router()
lotRentRouter.use(requireAuth)

/**
 * S637 (Nic, on a two-company account): GET /lot-rent/portfolio answered
 * "You own more than one company. Choose which one this record belongs to."
 * — on a READ. The Lot Rent tab could not be opened at all, the same way the
 * Expenses tab could not; the WRITE resolver was scoping a list.
 *
 * S633's rule has two halves and this route only had one: READS span every
 * entity the account owns, WRITES take an explicit authorized target. A read
 * narrows only when ?entityId= names one, and that path still goes through the
 * same resolver, so an entity the account does not own is still a 403.
 */
function readScope(req: any): string[] {
  const explicit = req.query?.entityId
  if (explicit) return [resolveLandlordTarget(req.user, explicit, 'record')]
  return landlordScopeIds(req.user)
}

// GET /api/lot-rent/portfolio — investor net across their homes-only properties.
lotRentRouter.get('/portfolio', requireLandlord, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await getInvestorPortfolio(readScope(req)) })
  } catch (e) { next(e) }
})

// GET /api/lot-rent/charges — the operator's lot-rent obligations (newest first).
lotRentRouter.get('/charges', requireLandlord, async (req: any, res, next) => {
  try {
    const landlordIds = readScope(req)
    const status = (req.query.status as string) || undefined
    const rows = await query<any>(
      `SELECT lrc.id, lrc.unit_id, lrc.billing_month, lrc.amount::float AS amount, lrc.status, lrc.paid_at,
              u.unit_number, p.name AS property_name
         FROM lot_rent_charges lrc
         JOIN units u ON u.id = lrc.unit_id
         JOIN properties p ON p.id = lrc.property_id
        WHERE lrc.landlord_id = ANY($1::uuid[]) ${status ? 'AND lrc.status = $2' : ''}
        ORDER BY lrc.billing_month DESC, p.name, u.unit_number`,
      status ? [landlordIds, status] : [landlordIds])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/lot-rent/charges/:id/record-paid — mark a lot-rent obligation paid
// (the operator paid the external park directly; GAM moves no money).
lotRentRouter.post('/charges/:id/record-paid', requireLandlord, async (req: any, res, next) => {
  try {
    // S654: the charge row names its company, so a several-company account is
    // never asked which. Another account's charge reads as missing (404).
    const id = String(req.params.id || '')
    const rows = /^[0-9a-f-]{36}$/i.test(id)
      ? await query<{ landlord_id: string }>(`SELECT landlord_id FROM lot_rent_charges WHERE id = $1`, [id])
      : []
    // S654 (review): a GAM admin acting from the landlord screens keeps the access it had.
    const admin = req.user?.role === 'admin' || req.user?.role === 'super_admin'
    if (!rows.length || !(ownsLandlord(req.user, rows[0].landlord_id) || admin)) {
      throw new AppError(404, 'Lot-rent charge not found, already paid, or not yours')
    }
    await recordLotRentPaid(id, rows[0].landlord_id)
    res.json({ success: true, data: { id: req.params.id, status: 'paid' } })
  } catch (e) { next(e) }
})

// POST /api/lot-rent/accrue — admin manual accrual for a month (the monthly cron
// runs this automatically). Body: { month: 'YYYY-MM-01' }.
lotRentRouter.post('/accrue', requireAdmin, async (req, res, next) => {
  try {
    const month = String((req.body || {}).month || '')
    if (!/^\d{4}-\d{2}-01$/.test(month)) throw new AppError(400, 'month must be YYYY-MM-01')
    res.json({ success: true, data: { accrued: await accrueLotRentCharges(month) } })
  } catch (e) { next(e) }
})
