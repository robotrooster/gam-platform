import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { notifyLandlordRenewalDecision } from '../services/notifications'

export const leasesRouter = Router()
leasesRouter.use(requireAuth)

leasesRouter.get('/', async (req, res, next) => {
  try {
    const filter = req.user!.role === 'landlord' ? `AND l.landlord_id='${req.user!.profileId}'`
                 : req.user!.role === 'tenant'   ? `AND l.tenant_id='${req.user!.profileId}'` : ''
    const leases = await query<any>(`
      SELECT l.*, u.unit_number, p.name AS property_name,
        tu.first_name AS tenant_first, tu.last_name AS tenant_last
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN tenants t ON t.id = l.tenant_id
      JOIN users tu ON tu.id = t.user_id
      WHERE 1=1 ${filter} ORDER BY l.start_date DESC`)
    res.json({ success: true, data: leases })
  } catch (e) { next(e) }
})

leasesRouter.post('/', requireLandlord, async (req, res, next) => {
  try {
    const body = z.object({
      unitId: z.string().uuid(), tenantId: z.string().uuid(),
      startDate: z.string(), endDate: z.string(),
      rentAmount: z.number().positive(), securityDeposit: z.number().min(0),
    }).parse(req.body)
    const [lease] = await query<any>(`
      INSERT INTO leases (unit_id,tenant_id,landlord_id,start_date,end_date,rent_amount,security_deposit)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [body.unitId,body.tenantId,req.user!.profileId,body.startDate,body.endDate,body.rentAmount,body.securityDeposit])
    await query('UPDATE units SET status=$1, tenant_id=$2 WHERE id=$3', ['active', body.tenantId, body.unitId])
    res.status(201).json({ success: true, data: lease })
  } catch (e) { next(e) }
})

// POST /api/leases/:id/renewal-intent — tenant submits their renewal preference
leasesRouter.post('/:id/renewal-intent', requireAuth, async (req, res, next) => {
  try {
    const { intent, notes } = req.body // intent: 'yes'|'no'|'unsure'
    if (!['yes','no','unsure'].includes(intent)) throw new AppError(400, 'Invalid intent')

    const lease = await queryOne<any>(`
      SELECT l.*, u.unit_number, p.name as property_name,
        lu.id as landlord_user_id, lu.email as landlord_email, lu.phone as landlord_phone,
        la.id as landlord_id,
        tu.first_name as tenant_first, tu.last_name as tenant_last
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = l.landlord_id
      JOIN users lu ON lu.id = la.user_id
      LEFT JOIN tenants t ON t.id = u.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      WHERE l.id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')

    await query('UPDATE leases SET tenant_renewal_intent=$1, tenant_renewal_intent_at=NOW(), tenant_renewal_notes=$2 WHERE id=$3',
      [intent, notes||null, lease.id])

    // Notify landlord
    await notifyLandlordRenewalDecision({
      landlordUserId: lease.landlord_user_id, landlordId: lease.landlord_id,
      landlordEmail: lease.landlord_email, landlordPhone: lease.landlord_phone,
      tenantName: lease.tenant_first + ' ' + lease.tenant_last,
      unitNumber: lease.unit_number, propertyName: lease.property_name,
      endDate: lease.end_date, leaseId: lease.id, tenantIntent: intent
    })

    res.json({ success: true })
  } catch(e) { next(e) }
})

// PATCH /api/leases/:id — update lease status
leasesRouter.patch('/:id', requireLandlord, async (req, res, next) => {
  try {
    const { status } = req.body
    if (!['active','expired','terminated','month_to_month'].includes(status))
      throw new AppError(400, 'Invalid status')

    const lease = await queryOne<any>('SELECT * FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')

    await query('UPDATE leases SET status=$1 WHERE id=$2', [status, lease.id])

    // If lease ends, vacate the unit
    if (status === 'expired' || status === 'terminated') {
      await query('UPDATE units SET status=$1, tenant_id=NULL WHERE id=$2',
        ['vacant', lease.unit_id])
    }

    res.json({ success: true })
  } catch (e) { next(e) }
})
