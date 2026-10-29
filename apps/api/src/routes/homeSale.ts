// Financed home/RV sale contracts (S568, Nic). A landlord sells a park-owned
// home to a tenant, financed over N years. Space rent stays on the normal lease;
// this manages the amortized purchase installment stream (type='home_payment').
import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requireLandlord, requirePerm } from '../middleware/auth'
import { canManageLandlordResource, canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { createHomeSaleContract, assertUnitIsSaleable, assertBuyerIsKnown } from '../services/homeSale'

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
  // S651: optional. A home sale is not a tenancy — see the note on
  // CreateHomeSaleInput.leaseId. Supplied when the buyer does rent the space,
  // because it is useful context; never required for the sale to exist.
  leaseId:            z.string().uuid().optional(),
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
  // schedule and nothing billed until the LANDLORD signs it (10/12, Nic: "we
  // need people to be billed correctly regardless of signing status" — the
  // buyer's signature no longer holds it back). Optional so the existing
  // direct-create path (a sale papered outside GAM) still works.
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
    // S652: these two checks moved into services/homeSale so the lease-packet
    // path runs the identical ones. They read the same and they ARE the same —
    // the next change to either applies to both doors at once.
    const unit = await assertUnitIsSaleable({ query }, body.unitId)
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    // A lease, when there is one, still has to be this unit's.
    if (body.leaseId) {
      const lease = await queryOne<any>(`SELECT id, landlord_id, unit_id FROM leases WHERE id=$1`, [body.leaseId])
      if (!lease || lease.unit_id !== body.unitId) throw new AppError(400, 'Lease does not belong to this unit')
    }

    // THE GUARD THAT MATTERS, and why it is not the lease check any more.
    //
    // tenantId becomes the billed obligor on every installment, so it can never
    // be an arbitrary id from the body (memory: gam-foreign-ref-write-scope).
    // That used to be enforced by requiring the buyer to be active on a lease —
    // which also, wrongly, made a tenancy a precondition of buying a home.
    //
    // What is actually required is that this landlord has some standing with
    // this person: a lease of any status, an open onboarding invite, or a
    // utility agreement. A buyer who rents nowhere still reaches GAM through an
    // invite from the seller, so they have one. A stranger's tenant id does not.
    await assertBuyerIsKnown({ query }, body.tenantId, unit.landlord_id)
    if (body.leaseId) {
      // When a lease IS given, the buyer should genuinely be on it; a mismatch
      // is a mistake worth stopping rather than quietly recording.
      const onLease = await queryOne<any>(
        `SELECT 1 FROM v_lease_active_tenants WHERE lease_id=$1 AND tenant_id=$2 LIMIT 1`,
        [body.leaseId, body.tenantId])
      if (!onLease) throw new AppError(400, 'That buyer is not an active tenant on the lease you gave.')
    }

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
      unitId: body.unitId, leaseId: body.leaseId ?? null, tenantId: body.tenantId, landlordId: unit.landlord_id,
      salePrice, downPayment, annualInterestRate, termMonths, startMonth: body.startMonth,
      planType: body.planType,
      pendingSignature: !!body.templateId,
    })

    // S629: draft the purchase agreement from the terms just agreed and bind
    // it to the contract. The document is the authority — the contract stays
    // pending_signature, with no installments, until the landlord signs it
    // (10/12: his signature starts the billing, as it issues a lease).
    if (body.templateId) {
      // Imported here rather than at module scope: esign.ts imports
      // activateHomeSaleContract from services/homeSale, and a static import
      // back the other way closes the cycle.
      const { createDocumentRecord } = await import('./esign')
      const doc = await createDocumentRecord(client, {
        landlordId: unit.landlord_id, templateId: body.templateId,
        unitId: body.unitId, leaseId: body.leaseId ?? null,
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
              i.remaining_balance, i.payment_id, p.status AS payment_status,
              -- 10/25: on a contract GAM tracks but does not bill, this stamp IS
              -- the record that the payment arrived (there is no charge to read
              -- a status from), so the ledger needs it to show paid from due.
              i.settled_off_platform_at, i.reminded_at
         FROM home_sale_installments i
         LEFT JOIN payments p ON p.id = i.payment_id
        WHERE i.contract_id=$1 ORDER BY i.installment_number`, [contract.id])
    res.json({ success: true, data: { contract, schedule } })
  } catch (e) { next(e) }
})

// POST /api/home-sales/:id/cancel — stop future billing (soft: status=cancelled,
// already-billed installments stay as the historical record).
/**
 * 10/25 (Nic): HOW THIS CONTRACT IS PAID — the landlord's own terms on it.
 *
 *   "A trailer bill could possibly have late fees. It's an installment contract
 *    that may carry its own late terms. I don't have any specific to these
 *    contracts, but we need to have the capability for landlords. We provide
 *    the tools to do the job, whatever their job is."
 *
 *   "We need the ability to have the contract flagged as, you know, prevent
 *    credit card payments on that bill. That's an exposure where we would have
 *    to backtrack bookkeeping and stuff."
 *
 * Settable on an existing contract, not only at creation: a landlord who takes
 * one of these on later (Dominic Gonzalez's, whose money goes to the trust)
 * must be able to say so without re-papering the sale. Omitted fields are left
 * exactly as they are.
 *
 * Late fees are OFF by default on every contract and stay off unless a
 * landlord turns them on — a fee nobody signed for is never charged.
 */
const termsSchema = z.object({
  lateFeeEnabled:       z.boolean().optional(),
  lateFeeGraceDays:     z.number().int().min(0).max(60).nullable().optional(),
  lateFeeInitialType:   z.enum(['flat', 'percent']).nullable().optional(),
  lateFeeInitialAmount: z.number().min(0).nullable().optional(),
  lateFeeAccrualType:   z.enum(['flat', 'percent']).nullable().optional(),
  lateFeeAccrualAmount: z.number().min(0).nullable().optional(),
  lateFeeAccrualPeriod: z.enum(['daily', 'weekly', 'monthly']).nullable().optional(),
  lateFeeAccrualFrom:   z.enum(['grace_end', 'due_date']).nullable().optional(),
  lateFeeCapType:       z.enum(['flat', 'percent']).nullable().optional(),
  lateFeeCapAmount:     z.number().min(0).nullable().optional(),
  cardPaymentsBlocked:  z.boolean().optional(),
  /**
   * 10/25 (Nic): GAM tracks this contract and reminds, but bills nothing —
   * "it's just going to be a ledger that keeps track... it stays off the books."
   */
  trackedNotBilled:     z.boolean().optional(),
}).refine(o => Object.keys(o).length > 0, { message: 'Nothing to change.' })

const TERMS_COLUMNS: Record<string, string> = {
  lateFeeEnabled: 'late_fee_enabled',
  lateFeeGraceDays: 'late_fee_grace_days',
  lateFeeInitialType: 'late_fee_initial_type',
  lateFeeInitialAmount: 'late_fee_initial_amount',
  lateFeeAccrualType: 'late_fee_accrual_type',
  lateFeeAccrualAmount: 'late_fee_accrual_amount',
  lateFeeAccrualPeriod: 'late_fee_accrual_period',
  lateFeeAccrualFrom: 'late_fee_accrual_from',
  lateFeeCapType: 'late_fee_cap_type',
  lateFeeCapAmount: 'late_fee_cap_amount',
  cardPaymentsBlocked: 'card_payments_blocked',
  trackedNotBilled: 'tracked_not_billed',
}

// PATCH /api/home-sales/:id/terms
homeSaleRouter.patch('/:id/terms', requireLandlord, requirePerm('leases.edit'), async (req: any, res, next) => {
  try {
    const body = termsSchema.parse(req.body)
    const contract = await queryOne<any>(
      `SELECT id, landlord_id, status FROM home_sale_contracts WHERE id=$1`, [req.params.id])
    if (!contract) throw new AppError(404, 'Contract not found')
    if (!canManageLandlordResource(req.user, contract.landlord_id)) throw new AppError(403, 'Forbidden')
    if (contract.status === 'paid_off' || contract.status === 'cancelled') {
      throw new AppError(409, `This contract is ${contract.status} — its terms can no longer be changed.`)
    }
    const sets: string[] = []
    const vals: any[] = [req.params.id]
    for (const [field, column] of Object.entries(TERMS_COLUMNS)) {
      if (!(field in body)) continue
      vals.push((body as any)[field])
      sets.push(`${column} = $${vals.length}`)
    }
    // A bill already written KEEPS the exemption it was written with (S558: the
    // document is the charge), so turning fees on governs bills from here on
    // and nothing existing is touched. No statement is needed for either
    // direction, and one would be wrong in both:
    //
    //   ON  — every trailer bill on the platform is written exempt (fees
    //         default off), so none has ever been fined. A back-fill guarded on
    //         "has never been fined" therefore excludes nothing, and clearing
    //         the exemption would fine every open past-due bill at once, with
    //         daily accrual counted back to a due date the buyer was told
    //         carried no fee. That is the one outcome this must not produce.
    //   OFF — jobs/lateFees reads the contract's terms LIVE (its
    //         home_sale_contracts join), so switching fees off stops any new
    //         fee on the next run by itself. Marking bills exempt as well would
    //         add nothing.
    const updated = await queryOne<any>(
      `UPDATE home_sale_contracts SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1
       RETURNING id, late_fee_enabled, late_fee_grace_days, late_fee_initial_type,
                 late_fee_initial_amount, late_fee_accrual_type, late_fee_accrual_amount,
                 late_fee_accrual_period, late_fee_accrual_from, late_fee_cap_type,
                 late_fee_cap_amount, card_payments_blocked, tracked_not_billed`,
      vals)
    // 10/25: TURNING BILLING ON must not bill the months GAM was not billing.
    // While a contract is tracked, its months pass unbilled by design; flipping
    // it to billed would otherwise make the next run invoice every one of them
    // at once — months the buyer may well have already paid off the books. So
    // the past is stamped as settled outside GAM, which is what it was, and
    // billing starts from the current month. The same rule as a property's
    // first billing cycle: GAM bills from when it starts billing.
    if (body.trackedNotBilled === false) {
      await query(
        `UPDATE home_sale_installments i
            SET settled_off_platform_at = NOW()
          WHERE i.contract_id = $1
            AND i.payment_id IS NULL
            AND i.settled_off_platform_at IS NULL
            AND i.billing_month < date_trunc('month', CURRENT_DATE)::date`,
        [req.params.id])
      const { reconcileHomeSaleContract } = await import('../services/homeSale')
      await reconcileHomeSaleContract(req.params.id)
    }
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

/**
 * 10/25 (Nic): "when that payment comes in, we will mark that it was paid, but
 * it stays off the books." Only on a contract GAM tracks and does not bill —
 * a payment GAM billed is marked on its own bill, through the desk or the
 * payments page, so that money reaches the books the ordinary way.
 */
const markPaidSchema = z.object({
  installmentNumber: z.number().int().positive(),
  paid: z.boolean(),
})

// PATCH /api/home-sales/:id/installments/mark
// 10/25 (Nic): 'take_payment', and NOT a lease permission.
//
//   "Lisa is not going to get permission to edit leases. That is a non-starter
//    right there. Marking that somebody logged a payment for a contract that's
//    being kept off the books has nothing to do with leases. You need to take a
//    different route."
//
// He is right twice over. The concept is wrong — this is somebody at the counter
// saying money changed hands, which is what 'take_payment' is for ("Record a
// cash / check payment... cash, check, money order") — and naming leases.edit
// here, even as an alternative, reads as though the desk needs lease rights to
// do it. It does not and must not.
//
// It also would not have worked: Lisa's granted keys include take_payment and
// do NOT include leases.edit. Owners and property managers still reach it,
// because requirePerm lets owner roles through.
//
// requireLandlord is deliberately NOT here either: it is
// requireRole('admin','super_admin','landlord'), so it refuses the front desk
// outright — the 403 nobody would have understood. This follows the pattern the
// desk's other money routes use (routes/payments: requireAuth on the router,
// requirePerm per route), and the handler still checks the contract belongs to
// the company the caller works for (canManageLandlordResource).
homeSaleRouter.patch('/:id/installments/mark', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const body = markPaidSchema.parse(req.body)
    const contract = await queryOne<any>(
      `SELECT id, landlord_id, status FROM home_sale_contracts WHERE id=$1`, [req.params.id])
    if (!contract) throw new AppError(404, 'Contract not found')
    if (!canManageLandlordResource(req.user, contract.landlord_id)) throw new AppError(403, 'Forbidden')
    const { markTrackedInstallmentPaid } = await import('../services/homeSale')
    const out = await markTrackedInstallmentPaid(req.params.id, body.installmentNumber, body.paid)
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

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
