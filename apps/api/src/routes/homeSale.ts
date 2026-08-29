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

// planType defaults to 'amortized' so existing callers (no planType) are
// unchanged. 'flat' takes monthlyAmount + numberOfPayments instead of
// price/interest/term; the handler derives the 0%-amortization inputs from them.

/**
 * S629: who signs a purchase agreement — the selling landlord and the buying
 * tenant. Deliberately NOT the whole lease roster: a lease can have four
 * signers, and the person buying the home is the one named on this contract.
 */
async function purchaseSigners(client: any, landlordId: string, tenantId: string) {
  const l = (await client.query(
    `SELECT u.id, u.first_name, u.last_name, u.email FROM landlords l
       JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [landlordId])).rows[0]
  const t = (await client.query(
    `SELECT u.id, u.first_name, u.last_name, u.email FROM tenants t
       JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])).rows[0]
  if (!l || !t) throw new AppError(404, 'Could not resolve both parties to the sale.')
  const name = (r: any) => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email
  return [
    { userId: l.id, role: 'landlord', name: name(l), email: l.email },
    { userId: t.id, role: 'primary',  name: name(t), email: t.email },
  ]
}

const createSchema = z.object({
  unitId:             z.string().uuid(),
  leaseId:            z.string().uuid(),
  tenantId:           z.string().uuid(),
  startMonth:         z.string().regex(/^\d{4}-\d{2}-01$/),  // first billing cycle
  planType:           z.enum(['amortized', 'flat']).default('amortized'),
  // amortized inputs
  salePrice:          z.number().positive().optional(),
  downPayment:        z.number().min(0).default(0),
  annualInterestRate: z.number().min(0).max(60).default(0),  // percent
  termMonths:         z.number().int().positive().max(600).optional(),
  // flat inputs
  monthlyAmount:      z.number().positive().optional(),
  numberOfPayments:   z.number().int().positive().max(600).optional(),
  // S629 (Nic): send the purchase agreement for signature and let the SIGNATURE
  // start the billing. The contract is created holding the agreed terms with no
  // schedule and nothing billed until that document completes. Optional so the
  // existing direct-create path (a sale papered outside GAM) still works.
  templateId:         z.string().uuid().optional(),
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
      `SELECT u.id, u.landlord_id, u.dwelling_ownership, u.unit_type, u.unit_number
         FROM units u WHERE u.id = $1`, [body.unitId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    if (unit.dwelling_ownership !== 'landlord') {
      throw new AppError(409, 'This unit is already tenant-owned — there is no park-owned home to finance.')
    }
    // S613 (Nic, DIRECTIVE): "Financed sales scope needs to be limited to
    // converting park owned homes to tenant owned homes. We don't want it to be
    // anything to do with RVs."
    //
    // The shape only makes sense for a HOME: the park owns a house sitting on
    // its own lot, the household living in it buys it over time, and on payoff
    // the dwelling flips to tenant-owned and the lot becomes space rent. An RV
    // is towed away — there is nothing to convert, and financing one would make
    // GAM the lender on a vehicle that can leave the property.
    if (unit.unit_type !== 'mobile_home') {
      throw new AppError(400,
        'A financed sale converts a park-owned HOME to tenant-owned. It is only offered on mobile homes.')
    }
    const lease = await queryOne<any>(`SELECT id, landlord_id, unit_id FROM leases WHERE id=$1`, [body.leaseId])
    if (!lease || lease.unit_id !== body.unitId) throw new AppError(400, 'Lease does not belong to this unit')
    // The buyer must be an active tenant on this lease — never trust an arbitrary
    // body-supplied tenantId (it becomes the billed obligor on every installment).
    const onLease = await queryOne<any>(
      `SELECT 1 FROM v_lease_active_tenants WHERE lease_id=$1 AND tenant_id=$2 LIMIT 1`, [body.leaseId, body.tenantId])
    if (!onLease) throw new AppError(400, 'Buyer must be an active tenant on this lease.')

    // Resolve the plan into the amortization inputs. A flat plan is 0% interest
    // with each installment equal to the flat monthly amount; the total sale
    // price is that amount × the number of payments.
    let salePrice: number, downPayment: number, annualInterestRate: number, termMonths: number
    if (body.planType === 'flat') {
      if (body.monthlyAmount == null || body.numberOfPayments == null)
        throw new AppError(400, 'A flat plan needs a monthly amount and a number of payments.')
      salePrice = Math.round(body.monthlyAmount * body.numberOfPayments * 100) / 100
      downPayment = 0
      annualInterestRate = 0
      termMonths = body.numberOfPayments
    } else {
      if (body.salePrice == null || body.termMonths == null)
        throw new AppError(400, 'An amortized plan needs a sale price and a term.')
      salePrice = body.salePrice
      downPayment = body.downPayment
      annualInterestRate = body.annualInterestRate
      termMonths = body.termMonths
    }

    await client.query('BEGIN')
    const contract = await createHomeSaleContract(client, {
      unitId: body.unitId, leaseId: body.leaseId, tenantId: body.tenantId, landlordId: unit.landlord_id,
      salePrice, downPayment, annualInterestRate, termMonths, startMonth: body.startMonth,
      planType: body.planType,
      pendingSignature: !!body.templateId,
    })

    // S629: draft the purchase agreement from the terms just agreed and bind
    // it to the contract. The document is the authority — the contract stays
    // pending_signature, with no installments, until it comes back signed.
    if (body.templateId) {
      // Imported here rather than at module scope: esign.ts imports
      // activateHomeSaleContract from services/homeSale, and a static import
      // back the other way closes the cycle.
      const { createDocumentRecord } = await import('./esign')
      const doc = await createDocumentRecord(client, {
        landlordId: unit.landlord_id, templateId: body.templateId,
        unitId: body.unitId, leaseId: body.leaseId,
        title: `Purchase agreement — Unit ${unit.unit_number}`,
        basePdfUrl: null, documentType: 'purchase_agreement',
        targetLeaseTenantId: null, promoteLeaseTenantId: null,
        signers: await purchaseSigners(client, unit.landlord_id, body.tenantId),
        // S629: the terms just agreed, stamped onto the agreement so the
        // document states the same numbers the billing will use. The contract
        // is the source; the signed page is the proof.
        prefillValues: {
          sale_price:               Number(salePrice).toFixed(2),
          sale_down_payment:        Number(downPayment).toFixed(2),
          sale_financed_amount:     Number(contract.financed_amount).toFixed(2),
          sale_monthly_payment:     Number(contract.monthly_payment).toFixed(2),
          sale_term_months:         String(termMonths),
          sale_interest_rate:       String(annualInterestRate),
          sale_first_payment_month: String(body.startMonth),
        },
      })
      await client.query(
        `UPDATE home_sale_contracts SET purchase_document_id=$2, updated_at=NOW() WHERE id=$1`,
        [contract.id, doc.id])
      contract.purchase_document_id = doc.id
    }
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
      // Landlord-only setup context. A tenant only ever sees their OWN contract
      // (even a cancelled/paid-off one) — never another buyer's terms.
      if (req.user.role === 'tenant') {
        const ownsIt = !!contract && contract.tenant_id === req.user.profileId
        return res.json({ success: true, data: ownsIt ? { contract, schedule: [] } : null })
      }
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
