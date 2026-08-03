// Financed home/RV sale contracts (S568, Nic). A landlord sells a park-owned
// home to a tenant, financed over N years. Space rent stays on the normal lease;
// this manages the amortized purchase installment stream (type='home_payment').
import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requireLandlord, requirePerm } from '../middleware/auth'
import { canManageLandlordResource, canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { createHomeSaleContract } from '../services/homeSale'

export const homeSaleRouter = Router()
homeSaleRouter.use(requireAuth)

const createSchema = z.object({
  unitId:             z.string().uuid(),
  leaseId:            z.string().uuid(),
  tenantId:           z.string().uuid(),
  salePrice:          z.number().positive(),
  downPayment:        z.number().min(0).default(0),
  annualInterestRate: z.number().min(0).max(60).default(0),  // percent
  termMonths:         z.number().int().positive().max(600),
  startMonth:         z.string().regex(/^\d{4}-\d{2}-01$/),  // first billing cycle
})

// POST /api/home-sales — create a financing contract + amortization schedule.
homeSaleRouter.post('/', requireLandlord, requirePerm('leases.edit'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    const body = createSchema.parse(req.body)
    // The unit + lease must belong to this landlord, and the dwelling must be
    // landlord-owned (you can only finance-sell a home the park owns; it flips
    // to tenant-owned on payoff).
    const unit = await queryOne<any>(
      `SELECT u.id, u.landlord_id, u.dwelling_ownership, u.unit_type
         FROM units u WHERE u.id = $1`, [body.unitId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    if (unit.dwelling_ownership !== 'landlord') {
      throw new AppError(409, 'This unit is already tenant-owned — there is no park-owned home to finance.')
    }
    const lease = await queryOne<any>(`SELECT id, landlord_id, unit_id FROM leases WHERE id=$1`, [body.leaseId])
    if (!lease || lease.unit_id !== body.unitId) throw new AppError(400, 'Lease does not belong to this unit')

    await client.query('BEGIN')
    const contract = await createHomeSaleContract(client, {
      unitId: body.unitId, leaseId: body.leaseId, tenantId: body.tenantId, landlordId: unit.landlord_id,
      salePrice: body.salePrice, downPayment: body.downPayment,
      annualInterestRate: body.annualInterestRate, termMonths: body.termMonths, startMonth: body.startMonth,
    })
    await client.query('COMMIT')

    const schedule = await query<any>(
      `SELECT installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance
         FROM home_sale_installments WHERE contract_id=$1 ORDER BY installment_number`, [contract.id])
    res.json({ success: true, data: { contract, schedule } })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

// GET /api/home-sales/unit/:unitId — the active (or latest) contract + schedule.
// When there's no active contract, also returns `eligibleLease` (the unit's
// active lease + primary tenant + dwelling ownership) so the UI can offer to set
// up a financed sale without a second round-trip.
homeSaleRouter.get('/unit/:unitId', async (req: any, res, next) => {
  try {
    const contract = await queryOne<any>(
      `SELECT * FROM home_sale_contracts WHERE unit_id=$1 ORDER BY (status='active') DESC, created_at DESC LIMIT 1`,
      [req.params.unitId])
    if (!contract || contract.status !== 'active') {
      // Landlord-only setup context. Tenants get null here.
      if (req.user.role === 'tenant') return res.json({ success: true, data: contract ? { contract, schedule: [] } : null })
      const unit = await queryOne<any>(`SELECT id, landlord_id, dwelling_ownership FROM units WHERE id=$1`, [req.params.unitId])
      if (!unit) return res.json({ success: true, data: null })
      if (!canAccessLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
      const eligibleLease = await queryOne<any>(
        `SELECT l.id AS lease_id, l.rent_amount,
                vlat.tenant_id AS primary_tenant_id,
                tu.first_name AS tenant_first, tu.last_name AS tenant_last
           FROM leases l
           JOIN v_lease_active_tenants vlat ON vlat.lease_id = l.id AND vlat.role = 'primary'
           JOIN tenants t ON t.id = vlat.tenant_id
           JOIN users tu ON tu.id = t.user_id
          WHERE l.unit_id = $1 AND l.status = 'active'
          ORDER BY l.created_at DESC LIMIT 1`, [req.params.unitId])
      return res.json({ success: true, data: {
        contract: contract ?? null, schedule: [],
        dwellingOwnership: unit.dwelling_ownership,
        eligibleLease: eligibleLease ?? null,
      } })
    }
    if (req.user.role === 'tenant') {
      if (contract.tenant_id !== req.user.profileId) throw new AppError(403, 'Forbidden')
    } else if (!canAccessLandlordResource(req.user, contract.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const schedule = await query<any>(
      `SELECT i.installment_number, i.billing_month, i.amount, i.principal_portion, i.interest_portion,
              i.remaining_balance, i.payment_id, p.status AS payment_status
         FROM home_sale_installments i
         LEFT JOIN payments p ON p.id = i.payment_id
        WHERE i.contract_id=$1 ORDER BY i.installment_number`, [contract.id])
    res.json({ success: true, data: { contract, schedule } })
  } catch (e) { next(e) }
})

// POST /api/home-sales/:id/cancel — stop future billing (soft: status=cancelled,
// already-billed installments stay as the historical record).
homeSaleRouter.post('/:id/cancel', requireLandlord, requirePerm('leases.edit'), async (req: any, res, next) => {
  try {
    const contract = await queryOne<any>(`SELECT id, landlord_id, status FROM home_sale_contracts WHERE id=$1`, [req.params.id])
    if (!contract) throw new AppError(404, 'Contract not found')
    if (!canManageLandlordResource(req.user, contract.landlord_id)) throw new AppError(403, 'Forbidden')
    if (contract.status !== 'active') throw new AppError(409, `Contract is already ${contract.status}.`)
    await query(`UPDATE home_sale_contracts SET status='cancelled', cancelled_at=NOW(), updated_at=NOW() WHERE id=$1`, [req.params.id])
    res.json({ success: true, data: { id: req.params.id, status: 'cancelled' } })
  } catch (e) { next(e) }
})
