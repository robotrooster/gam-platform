// Lot-rent obligations + investor net (S568, Nic). The operator's expense to an
// external park (homes-only properties). GAM tracks the obligation + paid status.
import { Router } from 'express'
import { query } from '../db'
import { requireAuth, requireLandlord, requireAdmin } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { getInvestorPortfolio, recordLotRentPaid, accrueLotRentCharges } from '../services/lotRent'

export const lotRentRouter = Router()
lotRentRouter.use(requireAuth)

function landlordScope(req: any): string {
  const id = req.user.role === 'landlord' ? req.user.profileId : req.user.landlordId
  if (!id) throw new AppError(403, 'A landlord/operator context is required.')
  return id
}

// GET /api/lot-rent/portfolio — investor net across their homes-only properties.
lotRentRouter.get('/portfolio', requireLandlord, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await getInvestorPortfolio(landlordScope(req)) })
  } catch (e) { next(e) }
})

// GET /api/lot-rent/charges — the operator's lot-rent obligations (newest first).
lotRentRouter.get('/charges', requireLandlord, async (req: any, res, next) => {
  try {
    const landlordId = landlordScope(req)
    const status = (req.query.status as string) || undefined
    const rows = await query<any>(
      `SELECT lrc.id, lrc.unit_id, lrc.billing_month, lrc.amount::float AS amount, lrc.status, lrc.paid_at,
              u.unit_number, p.name AS property_name
         FROM lot_rent_charges lrc
         JOIN units u ON u.id = lrc.unit_id
         JOIN properties p ON p.id = lrc.property_id
        WHERE lrc.landlord_id = $1 ${status ? 'AND lrc.status = $2' : ''}
        ORDER BY lrc.billing_month DESC, p.name, u.unit_number`,
      status ? [landlordId, status] : [landlordId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/lot-rent/charges/:id/record-paid — mark a lot-rent obligation paid
// (the operator paid the external park directly; GAM moves no money).
lotRentRouter.post('/charges/:id/record-paid', requireLandlord, async (req: any, res, next) => {
  try {
    await recordLotRentPaid(req.params.id, landlordScope(req))
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
