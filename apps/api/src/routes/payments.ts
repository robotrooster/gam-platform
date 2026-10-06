import { Router } from 'express'
import fs from 'fs'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireAdmin, requirePerm, getScopedPropertyIds } from '../middleware/auth'
import { landlordScopeIds } from '../lib/landlordScope'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'
import { resolveUploadPath } from '../lib/uploadPaths'
import { bankReceiptPhotoDir, takeBankReceiptPhoto, landlordsOwnUser } from '../lib/bankReceiptPhotos'
import { AchReturnCode, ACH_RETURN_CONFIG, PLATFORM_FEES,
         MANUAL_PAYMENT_METHODS,
         PRIOR_ARRANGEMENT_METHOD } from '@gam/shared'
import { getStripe } from '../lib/stripe'
import { computePlatformCut, createRentPlatformCharge } from '../services/stripeConnect'
import { createAdminNotification } from '../services/adminNotifications'
import { computeTenantGamOutstandingTotal } from '../services/supersedence'
import { chargeLeaseBalance, chargeLeaseBalanceSchema, resolveTargetLease,
         suggestedPayAheadFor, quoteLeaseCharge, planLeaseCharge, billMethodCosts, tenantPassthroughFor,
         payAllRunCreditWaiting, payAllRunCreditRest, creditWaitingSentence,
         CARD_CONFIRM_HOLD_MINUTES } from '../services/rentCharge'
import { releaseUnconfirmedCardCharges, releaseUnconfirmedChargeDetailed, CARD_RELEASE_NOTE,
         confirmedOnScreen, heldForCardholder } from '../jobs/paymentReconcile'
import { getClient } from '../db'
import { payableRowSql, lockHousehold } from '../services/moneyPredicates'
import { settleManualRentPayment, deskQuote, zeroLateFeesAfterDeposit, DESK_SURPLUS_HANDLING, DESK_SURPLUS_HANDLING_LABEL } from '../services/manualPaymentSettle'
import { runWholeBillCheckAfterCommit, supersedeScheduledRetry, cancelSupersededIntents,
         usablePaidAheadSql, disputeClaimJoinSql } from '../services/creditUse'
import { logger } from '../lib/logger'
import { todayIn } from '../lib/timezone'

export const paymentsRouter = Router()
paymentsRouter.use(requireAuth)

// ─── 10/5 (Nic): the photo of a bank's deposit receipt ───────────────────────
//
// "maybe ... add a picture of the receipt" — for a payment recorded as a BANK
// DEPOSIT only (the resident's cash put straight into the landlord's bank).
// Stored like expense receipts (routes/expenses.ts): one directory, an
// unguessable file name, and one authed serve route that authorizes PER ROW —
// the receipt the file belongs to must be the caller's company's, at a
// property the caller works at. Only the landlord's own people ever see it:
// never a GAM admin from here, never the tenant, never a static URL.
// Registered before the '/:id/...' routes so nothing reads 'deposit-photos'
// as a payment id.
const depositPhotoDir = bankReceiptPhotoDir('bank-deposit-receipts')
const takeDepositPhoto = takeBankReceiptPhoto(depositPhotoDir)

/** The bank-deposit receipt a photo belongs to, with where it was taken. */
async function bankDepositReceipt(where: 'id' | 'photo', key: string) {
  return queryOne<{ id: string; landlord_id: string; payment_method: string | null; status: string; property_id: string | null }>(
    `SELECT r.id, r.landlord_id, r.payment_method, r.status,
            COALESCE(u.property_id,
                     (SELECT pu.property_id FROM remittance_applications ra
                        JOIN payments pp ON pp.id = ra.payment_id JOIN units pu ON pu.id = pp.unit_id
                       WHERE ra.remittance_id = r.id ORDER BY pp.due_date, pp.id LIMIT 1)) AS property_id
       FROM tenant_remittances r
       LEFT JOIN leases l ON l.id = r.lease_id
       LEFT JOIN units u  ON u.id = l.unit_id
      WHERE ${where === 'id' ? 'r.id = $1::uuid' : 'r.deposit_photo_url = $1'}`, [key])
}

// POST /api/payments/remittances/:id/deposit-photo — attach (or replace) the
// photo of the bank's receipt on a recorded bank deposit. multipart, field 'photo'.
paymentsRouter.post('/remittances/:id/deposit-photo', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw new AppError(404, 'Payment not found')
    const rem = await bankDepositReceipt('id', req.params.id)
    if (!rem || !landlordsOwnUser(req.user, rem.landlord_id)) throw new AppError(404, 'Payment not found')
    await assertChargeInStaffScope(req.user, rem.property_id)
    if (rem.payment_method !== 'bank_deposit' || rem.status !== 'settled') {
      throw new AppError(409, 'A photo of the bank\'s receipt goes only on a payment recorded as a bank deposit.')
    }
    next()
  } catch (e) { next(e) }
}, takeDepositPhoto, async (req: any, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'Choose a photo of the bank\'s receipt.')
    const url = '/api/payments/deposit-photos/' + req.file.filename
    const row = await queryOne<{ id: string; deposit_photo_url: string }>(
      `UPDATE tenant_remittances
          SET deposit_photo_url = $2, deposit_photo_name = $3, deposit_photo_mime = $4, deposit_photo_size = $5,
              deposit_photo_uploaded_by = $6, deposit_photo_uploaded_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND payment_method = 'bank_deposit'
       RETURNING id, deposit_photo_url`,
      [req.params.id, url, String(req.file.originalname || 'receipt').slice(0, 200), req.file.mimetype, req.file.size,
       req.user!.userId])
    if (!row) throw new AppError(404, 'Payment not found')
    res.json({ success: true, data: { receiptId: row.id, depositPhotoUrl: row.deposit_photo_url } })
  } catch (e) { next(e) }
})

// GET /api/payments/deposit-photos/:filename — the photo, to the landlord's own people only.
paymentsRouter.get('/deposit-photos/:filename', async (req: any, res, next) => {
  try {
    const url = '/api/payments/deposit-photos/' + req.params.filename
    const rem = await bankDepositReceipt('photo', url)
    // Someone else's photo reads as missing, never as "forbidden".
    if (!rem || !landlordsOwnUser(req.user, rem.landlord_id)) throw new AppError(404, 'Not found')
    await assertChargeInStaffScope(req.user, rem.property_id)
    const fp = resolveUploadPath(depositPhotoDir, req.params.filename)
    if (!fp) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    res.setHeader('Cache-Control', 'private, no-store')
    res.sendFile(fp)
  } catch (e) { next(e) }
})

/**
 * S655 (10/3): a staffer assigned to one property takes money only on charges
 * at that property — the scope the payments list and the balances list read
 * (getScopedPropertyIds: null = every property). Owners and all-properties
 * staff pass. A charge with no space on it cannot be placed in a scope.
 */
async function assertChargeInStaffScope(user: any, propertyId: string | null | undefined): Promise<void> {
  const scoped = await getScopedPropertyIds(user)
  if (scoped === null) return
  if (!propertyId || !scoped.includes(propertyId)) {
    throw new AppError(403, 'This charge is at a property you are not assigned to. Ask the owner or a property manager to record it.')
  }
}

// POST /api/payments/quote — what a payment will ACTUALLY cost (S601, Nic),
// before anything is charged.
//
// S655 (Nic, 10/2): for a tenant this is their bill — the full balance, the
// credit that may pay part of it ("Use all $X — pay $Y" / "Save it for later —
// pay $Z", or "Pay with credit — nothing charged" when it covers the whole
// bill), GAM's own charges as their own line, any bank retry already scheduled,
// and the fee on the money for the method chosen. It is the same arithmetic
// /pay-balance enforces and autopay charges (services/rentCharge
// quoteLeaseCharge), so the figure read back is the figure charged.
// expectedCredit is what to send back with the payment.
//
// Anyone else (or a tenant naming only an amount with no bill to quote) gets
// the plain fee on that amount, as before.
paymentsRouter.post('/quote', async (req, res, next) => {
  try {
    const body = z.object({
      amount:  z.number().nonnegative().optional(),
      method:  z.enum(['ach', 'card']),
      leaseId: z.string().uuid().optional(),
      serviceAgreementId: z.string().uuid().optional(),
      useCredit: z.boolean().optional(),
      // "Pay all" with "Use all": the leases this run charges before this one,
      // in order (balance-context payAll.order). The quote is this lease's
      // charge as it will be when its turn comes — the figure it is sent.
      afterLeaseIds: z.array(z.string().uuid()).max(50).optional(),
      // Fix pass 3: the pay screen's bills when they are not the run
      // balance-context sequenced (payAll.order), in the order they will be
      // charged. Answers only the credit another bank payment still holds
      // that the whole run would have used — one figure for the run.
      runLeaseIds: z.array(z.string().uuid()).min(1).max(50).optional(),
    }).parse(req.body)

    if (req.user!.role === 'tenant' && body.runLeaseIds && !body.leaseId && !body.serviceAgreementId && body.amount == null) {
      const tenantId = req.user!.profileId as string
      const client = await getClient()
      try {
        // Only this tenant's household leases count (payAllRunCreditWaiting
        // reads the household quote); any other id adds nothing.
        const runCreditWaiting = await payAllRunCreditWaiting(client, { tenantId, order: body.runLeaseIds })
        return res.json({ success: true, data: {
          runLeaseIds: body.runLeaseIds,
          runCreditWaiting,
          runCreditWaitingNote: creditWaitingSentence(Math.round(runCreditWaiting * 100)),
        } })
      } finally { client.release() }
    }

    if (req.user!.role === 'tenant') {
      const tenantId = req.user!.profileId as string
      let leaseId: string | undefined
      if (body.serviceAgreementId) {
        const owns = await queryOne<{ id: string }>(
          `SELECT id FROM utility_service_agreements WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
          [body.serviceAgreementId, tenantId])
        if (!owns) throw new AppError(404, 'Service agreement not found')
      } else {
        leaseId = await resolveTargetLease(tenantId, body.leaseId ?? null).catch((e) => {
          // Nothing owed: fall through to the plain fee on the amount asked.
          if (e instanceof AppError && e.statusCode === 409 && body.amount != null) return undefined
          throw e
        })
      }
      if (leaseId || body.serviceAgreementId) {
        const q = await quoteLeaseCharge({
          tenantId, leaseId, serviceAgreementId: leaseId ? undefined : body.serviceAgreementId,
          useCredit: body.useCredit === true, paymentMethodType: body.method,
          afterLeaseIds: leaseId ? body.afterLeaseIds : undefined,
        })
        const usable = q.usableCredit
        const useCredit = body.useCredit === true && usable > 0
        const due = q.landing.dueCents / 100
        // Paying ahead (no credit used): the fee is on what they choose to send.
        const base = !useCredit && body.amount != null && body.amount > due ? body.amount : due
        // q.fee is the processing fee on the bill plus the tenant-payer platform
        // fee the charge adds on top of any payment with money in it; paying
        // ahead moves the processing fee to the larger amount, not the platform fee.
        const payer = body.method === 'ach' ? q.ctx.achFeePayer : q.ctx.cardFeePayer
        const fee = base === due ? q.fee
          : Math.round(((payer !== 'landlord' ? computePlatformCut({ amount: base, paymentMethod: body.method }) : 0)
              + (base > 0 ? await tenantPassthroughFor(q.ctx.propertyId) : 0)) * 100) / 100
        const saved = (q.requiredTotal * 100 - q.creditAlreadyApplied * 100) / 100
        return res.json({ success: true, data: {
          base, method: body.method, fee,
          tenantPaysFee: (body.method === 'ach' ? q.ctx.achFeePayer : q.ctx.cardFeePayer) !== 'landlord',
          total: Math.round((base + fee) * 100) / 100,
          intlCardSurcharge: body.method === 'card',
          leaseId: leaseId ?? null,
          serviceAgreementId: leaseId ? null : body.serviceAgreementId ?? null,
          // The whole bill now, before any credit.
          outstanding: Math.round((q.requiredTotal + q.carriedTotal) * 100) / 100,
          requiredNow: Math.round(saved * 100) / 100,
          carriedBalance: q.carriedTotal,
          usableCredit: usable,
          expectedCredit: usable,
          creditOnFile: q.creditOnFile,
          useCredit,
          creditUsed: q.landing.creditUsedCents / 100,
          payIfUsed: Math.round((saved - usable) * 100) / 100,
          payIfSaved: Math.round(saved * 100) / 100,
          coversWholeBill: q.coversWholeBill,
          // Credit another bank payment still holds, and why, in plain words:
          // why only part of the credit on file can pay this bill.
          creditWaiting: q.creditStillHeldElsewhere,
          creditWaitingNote: q.creditWaitingNote,
          // Fix pass 3: the rest of the credit on file and where it goes, in
          // plain words — every dollar of creditOnFile is explained.
          creditKeptElsewhere: q.creditKeptElsewhere,
          creditKeptForLater: q.creditKeptForLater,
          creditAlsoHeld: q.creditAlsoHeld,
          creditRestNote: q.creditRestNote,
          payWithCreditNothingCharged: useCredit && due === 0,
          gamCharges: q.gamTotal,
          inFlight: q.inFlightTotal,
          scheduledRetries: q.scheduledRetries.map(r => ({ nextRetryAt: r.nextRetryAt })),
          amountRequested: body.amount ?? null,
        } })
      }
    }

    let feePayer: string = 'tenant'   // default when no rule (mirrors allocation: null → tenant pays)
    if (body.leaseId) {
      const row = await queryOne<{ ach_fee_payer: string | null; card_fee_payer: string | null }>(
        `SELECT r.ach_fee_payer, r.card_fee_payer
           FROM leases l
           JOIN units u ON u.id = l.unit_id
           JOIN property_allocation_rules r ON r.property_id = u.property_id
          WHERE l.id = $1`, [body.leaseId])
      feePayer = (body.method === 'ach' ? row?.ach_fee_payer : row?.card_fee_payer) ?? 'tenant'
    }
    const amount = body.amount ?? 0
    const tenantPaysFee = feePayer !== 'landlord'
    // cardCountry omitted → US base rate; a non-US card adds 1.5% at charge time (flagged in the UI).
    const fee = tenantPaysFee && amount > 0 ? computePlatformCut({ amount, paymentMethod: body.method }) : 0
    const total = Math.round((amount + fee) * 100) / 100
    res.json({ success: true, data: {
      base: amount, method: body.method, fee, tenantPaysFee, total,
      intlCardSurcharge: body.method === 'card',
    } })
  } catch (e) { next(e) }
})

// GET /api/payments — filtered by landlord or tenant
paymentsRouter.get('/', async (req, res, next) => {
  try {
    // ── S639: A TIE IS NOT AN ORDER ────────────────────────────────────────
    //
    // Nic: "on the outstanding balances tab six leases that are all overdue,
    // and on the payments tab it's only showing five... The outstanding balance
    // still has Steven Starr. The payments tab, his name is removed from."
    //
    // 52 payments, LIMIT 50, and every single one of them due 2026-09-01 —
    // rent and utilities are all billed on the 1st, so `ORDER BY due_date DESC`
    // was one flat tie across the whole table. Postgres may return a tie in any
    // order it likes, so which two rows fell off the page was arbitrary and
    // could differ between refreshes. Steven Starr's $589 rent and $264.39
    // utilities were two of them, on the screen the desk collects money from.
    //
    // Two things were wrong and both are fixed: the sort now has a deterministic
    // tiebreaker, and the caller can ask for the whole set (clamped, so a large
    // portfolio cannot be turned into a table scan by a query string).
    const { status, type, from, to, page = '1', limit = '50' } = req.query as Record<string,string>
    const limitN = Math.min(Math.max(parseInt(limit) || 50, 1), 1000)
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limitN
    const conditions: string[] = []
    const params: any[] = []
    let pi = 1

    const role = req.user!.role
    const isAdmin = role === 'admin' || role === 'super_admin'
    const isTeamRole = role === 'property_manager' || role === 'onsite_manager' || role === 'maintenance'
    if (role === 'landlord') {
      // S620: own + co-owned entities (Nic: a co-owner sees what the owner sees).
      conditions.push(`p.landlord_id = ANY($${pi++})`); params.push(landlordScopeIds(req.user!))
    } else if (role === 'tenant') {
      conditions.push(`p.tenant_id = $${pi++}`); params.push(req.user!.profileId)
    } else if (isTeamRole) {
      // Team members scoped to their landlord; without a landlordId claim,
      // return nothing rather than leak across landlords. S81: also gate
      // on payments.view_all sub-perm — onsite/maintenance without explicit
      // permission do not see the landlord's payments roster.
      if (!req.user!.landlordId) {
        return res.json({ success: true, data: [], total: 0, page: 1, totalPages: 0 })
      }
      // S641 (Nic): "the outstanding balances section of the payments tab is
      // where you have to record a payment. My front desk needs to be able to
      // record the damn payment."
      //
      // This used to return an EMPTY LIST to anyone without payments.view_all,
      // which is why the front desk saw a blank tab: the page renders three
      // sections off one query, and the one she needs came back with nothing.
      //
      // So `payments.view` is the narrow grant it always read like — the money
      // still to collect, and nothing else. No settled history ("I don't want
      // her seeing the histories at all") and no work-trade rows, which are a
      // private arrangement between the landlord and that resident. Neither is
      // needed to take cash across a counter.
      const seesAll = req.user!.permissions?.['payments.view_all'] === true
      if (!seesAll && req.user!.permissions?.['payments.view'] !== true) {
        return res.json({ success: true, data: [], total: 0, page: 1, totalPages: 0 })
      }
      conditions.push(`p.landlord_id = $${pi++}`); params.push(req.user!.landlordId)
      // S655 (10/3): a staffer assigned to one property sees that property's
      // charges only — the same scope the balances list applies
      // (getScopedPropertyIds: null = every property, [] = none). A charge
      // with no space on it cannot be placed in their scope, so it is left out.
      const scoped = await getScopedPropertyIds(req.user)
      if (scoped !== null) {
        conditions.push(`p.unit_id IN (SELECT su.id FROM units su WHERE su.property_id = ANY($${pi++}::uuid[]))`)
        params.push(scoped)
      }
      if (!seesAll) {
        conditions.push(`p.status IN ('pending', 'failed')`)
        conditions.push(`p.work_trade_suspended_at IS NULL`)
      }
    } else if (!isAdmin) {
      // Unknown role with no scope — empty rather than leak.
      return res.json({ success: true, data: [], total: 0, page: 1, totalPages: 0 })
    }
    // admin/super_admin fall through: super_admin sees everything; a regular
    // admin (portfolio manager) is scoped to landlords they close or service.
    if (role === 'admin') {
      conditions.push(`p.landlord_id IN (SELECT id FROM landlords WHERE portfolio_manager_id = $${pi} OR service_manager_id = $${pi})`)
      params.push(req.user!.userId); pi++
    }
    // FlexPay never appears in the landlord portal (CLAUDE.md, S541): GAM's
    // FlexPay pull is the tenant's business with GAM, not a charge of the
    // landlord's, so the landlord and their staff never see that row.
    const landlordFacing = role === 'landlord' || isTeamRole
    if (landlordFacing) conditions.push(`p.entry_description IS DISTINCT FROM 'FLEXPAY'`)
    if (status)  { conditions.push(`p.status = $${pi++}`);       params.push(status) }
    if (type)    { conditions.push(`p.type = $${pi++}`);         params.push(type) }
    if (from)    { conditions.push(`p.due_date >= $${pi++}`);    params.push(from) }
    if (to)      { conditions.push(`p.due_date <= $${pi++}`);    params.push(to) }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
    const [{ total }] = await query<any>(
      `SELECT COUNT(*)::int AS total FROM payments p ${where}`, params
    )
    params.push(limitN, offset)
    const payments = await query<any>(`
      SELECT p.*, u.unit_number, pr.name AS property_name,
        tu.first_name AS tenant_first, tu.last_name AS tenant_last,
        -- S654: how it was paid, for the history's "Paid by" column.
        COALESCE(p.manual_method, rm.payment_method) AS paid_by,
        -- S568: is this the FIRST open rent charge of a lease while the LANDLORD
        -- is still inside their onboarding reconciliation window? If so the
        -- landlord may mark it paid off-platform (old-system autopay overlap),
        -- fee-free. Mirrors the route guard. New-vs-imported is irrelevant.
        (p.type = 'rent' AND p.status IN ('pending', 'failed')
          AND ld.reconciliation_until IS NOT NULL AND ld.reconciliation_until > NOW()
          AND NOT EXISTS (
            SELECT 1 FROM payments p2
             WHERE p2.lease_id = p.lease_id AND p2.type = 'rent'
               AND p2.status IN ('settled', 'paid_via_deposit') AND p2.id <> p.id)
        ) AS prior_arrangement_eligible
      FROM payments p
      -- A failed pull paid nothing: a row it was on that account credit paid
      -- later is never "Paid by" that bank or card.
      LEFT JOIN tenant_remittances rm ON p.stripe_payment_intent_id IS NOT NULL
                                     AND rm.stripe_payment_intent_id = p.stripe_payment_intent_id
                                     AND NOT (rm.status = 'failed' AND p.status = 'settled')
      LEFT JOIN units u ON u.id = p.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN landlords ld ON ld.id = p.landlord_id
      LEFT JOIN tenants t ON t.id = p.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      ${where}
      -- S639: created_at then id break the due-date tie, so the same query
      -- returns the same rows in the same order every time. Without this a
      -- paginated list can show one row twice and hide another entirely.
      ORDER BY p.due_date DESC, p.created_at DESC, p.id
      LIMIT $${pi} OFFSET $${pi+1}`, params
    )
    // S655 (Nic, 10/2): landlord screens show the FULL balance with the credit
    // on file BESIDE it — never netted off the bill. credit_on_file is every
    // dollar of credit this person's household has with this company, read
    // once per household on the page: what the landlord gave (tenant_credits:
    // theirs, or tied to a lease they are on) and what was paid ahead on a
    // lease they are on (lease_prepaid_credits; withdrawn credit left out).
    // Credit a payment still clearing has set aside is not on file, and nor is
    // paid-ahead money a dispute or return of its own funding still claims
    // (creditUse.usablePaidAheadSql — the one rule the portal, the desk and the
    // monthly draw share). What part of it can pay the bill now is the desk
    // window's answer (GET /payments/:id/record-manual/quote).
    const pairs = [...new Map(payments
      .filter((p: any) => p.tenant_id && p.landlord_id)
      .map((p: any) => [`${p.tenant_id}|${p.landlord_id}`, [p.tenant_id, p.landlord_id]])).values()]
    const creditByHousehold = new Map<string, number>()
    if (pairs.length > 0) {
      const credit = await query<{ tenant_id: string; landlord_id: string; credit: string }>(
        `WITH h AS (SELECT DISTINCT x.t AS tenant_id, x.l AS landlord_id
                      FROM unnest($1::uuid[], $2::uuid[]) AS x(t, l)),
              member AS (SELECT h.tenant_id, h.landlord_id, lt.lease_id
                           FROM h JOIN lease_tenants lt ON lt.tenant_id = h.tenant_id
                                  AND lt.status IN ('active','pending_add','pending_remove')
                           JOIN leases ml ON ml.id = lt.lease_id AND ml.landlord_id = h.landlord_id),
              pa AS (SELECT h.tenant_id, h.landlord_id, ${usablePaidAheadSql('pc', 'dc')} AS usable
                       FROM h
                       JOIN lease_prepaid_credits pc ON pc.voided_at IS NULL AND pc.amount_remaining > 0
                       JOIN leases pcl ON pcl.id = pc.lease_id AND pcl.landlord_id = h.landlord_id
                       ${disputeClaimJoinSql('pc', 'dc')}
                      WHERE pc.tenant_id = h.tenant_id
                         OR pc.lease_id IN (SELECT m.lease_id FROM member m
                                             WHERE m.tenant_id = h.tenant_id AND m.landlord_id = h.landlord_id))
         SELECT h.tenant_id, h.landlord_id,
                (COALESCE((SELECT SUM(tc.amount_remaining) FROM tenant_credits tc
                            WHERE tc.status = 'active' AND tc.amount_remaining > 0 AND tc.landlord_id = h.landlord_id
                              AND (tc.tenant_id = h.tenant_id
                                   OR tc.lease_id IN (SELECT m.lease_id FROM member m
                                                       WHERE m.tenant_id = h.tenant_id AND m.landlord_id = h.landlord_id))), 0)
                 + COALESCE((SELECT SUM(pa.usable) FROM pa
                              WHERE pa.tenant_id = h.tenant_id AND pa.landlord_id = h.landlord_id), 0)
                )::text AS credit
           FROM h`,
        [pairs.map(x => x[0]), pairs.map(x => x[1])])
      for (const c of credit) {
        creditByHousehold.set(`${c.tenant_id}|${c.landlord_id}`, Math.max(0, Math.round(Number(c.credit) * 100)) / 100)
      }
    }
    const data = payments.map((p: any) => {
      const row: any = { ...p, credit_on_file: creditByHousehold.get(`${p.tenant_id}|${p.landlord_id}`) ?? 0 }
      // FlexPay never appears in the landlord portal: a bill line FlexPay
      // covered reads as paid, with no trace of which product paid it.
      if (landlordFacing) delete row.flexpay_advance_id
      return row
    })
    res.json({ success: true, data, total, page: Math.max(parseInt(page) || 1, 1), totalPages: Math.ceil(total / limitN) })
  } catch (e) { next(e) }
})

// POST /api/payments/initiate-rent-collection — trigger ACH pulls for upcoming month
// Called by scheduler on ~28th of month
paymentsRouter.post('/initiate-rent-collection', requireAdmin, async (req, res, next) => {
  try {
    const { targetMonth } = z.object({
      targetMonth: z.string().regex(/^\d{4}-\d{2}$/) // YYYY-MM
    }).parse(req.body)

    // Get all active units with verified ACH whose landlord has at least one
    // active bank account in the user_bank_accounts catalog. Pre-S67 the
    // gate was l.stripe_account_id (Connect-flavored, deleted in S67).
    const units = await query<any>(`
      SELECT u.*, t.stripe_customer_id, t.ach_verified, t.on_time_pay_enrolled,
        t.float_fee_active, t.income_arrival_day, t.id AS tenant_profile_id
      FROM units u
      JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      JOIN tenants t ON t.id = vuo.primary_tenant_id
      JOIN landlords l ON l.id = u.landlord_id
      -- ── S638: A DELINQUENT UNIT STILL OWES NEXT MONTH'S RENT ───────────────
      --
      -- This collected only from units marked 'active', so the moment a unit
      -- flipped to 'delinquent' GAM stopped pulling its rent — the tenant who
      -- was already behind became the one nobody billed. It was survivable
      -- while delinquency was set once a day and never cleared; now that the
      -- status tracks the ledger in real time it would have bitten immediately.
      --
      -- 'suspended' stays excluded on purpose: that is a unit taken out of
      -- service, not a resident who is late. Matches how the rent roll counts
      -- occupancy (services/reportEngine.ts).
      WHERE u.status IN ('active', 'delinquent')
        AND u.payment_block = FALSE
        AND t.ach_verified = TRUE
        -- S655: a NACHA zero-tolerance suspension blocks bank pulls.
        AND t.ach_suspended_at IS NULL
        AND EXISTS (
          SELECT 1 FROM user_bank_accounts ba
           WHERE ba.user_id = l.user_id AND ba.status = 'active'
        )
    `)

    // S654: the 1st as a plain calendar string, so the due date never depends
    // on the host clock or the database session's zone.
    const dueDate = `${targetMonth}-01` // 1st of target month

    let initiated = 0
    const errors: string[] = []

    let skipped = 0
    for (const unit of units) {
      try {
        // Determine pull date based on On-Time Pay enrollment
        const pullDay = unit.on_time_pay_enrolled && unit.income_arrival_day
          ? unit.income_arrival_day  // SSI/SSDI: pull on income arrival day
          : 28                       // Standard: pull ~28th for 1st settlement

        // S407 idempotency guard: pre-fix, calling this route twice for the
        // same targetMonth created DUPLICATE rent payment rows for every
        // unit (no UNIQUE constraint on payments(unit_id, type, due_date),
        // and the route loop INSERT'd unconditionally). A scheduler
        // misfire / admin double-click would double-bill every tenant.
        // Skip silently when an active rent row already exists for this
        // (unit, due_date). S414: the residual concurrent-write race is
        // now also closed by the partial UNIQUE index
        // ux_payments_unit_type_due_date_active.
        // S414 status filter: only skip when an ACTIVE (non-failed,
        // non-returned) row exists. Failed/returned rows are retry-
        // eligible — the system should be able to re-bill that month.
        const existing = await queryOne<{ id: string }>(
          `SELECT id FROM payments
            WHERE unit_id = $1
              AND type = 'rent'
              AND due_date = $2
              AND status NOT IN ('failed', 'returned')
            LIMIT 1`,
          [unit.id, dueDate]
        )
        if (existing) { skipped++; continue }

        const [payment] = await query<any>(`
          INSERT INTO payments
            (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
          VALUES ($1,$2,$3,'rent',$4,'pending','RENT',$5)
          RETURNING id`,
          [unit.id, unit.tenant_profile_id, unit.landlord_id, unit.rent_amount, dueDate]
        )

        // If float fee active, create float fee payment too
        if (unit.float_fee_active) {
          await query(`
            INSERT INTO payments
              (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, revenue_owner)
            -- -- S609: GAM's own fee (REVENUE_OWNERS, packages/shared) — never an owner share.
            VALUES ($1,$2,$3,'float_fee',$4,'pending','ONTIMEPAY',$5,'gam')`,
            [unit.id, unit.tenant_profile_id, unit.landlord_id, PLATFORM_FEES.FLOAT_FEE_MO, dueDate]
          )
        }

        initiated++
      } catch (err: any) {
        errors.push(`Unit ${unit.unit_number}: ${err.message}`)
      }
    }

    res.json({
      success: true,
      data: { initiated, skipped, errors, targetMonth }
    })
  } catch (e) { next(e) }
})

// POST /api/payments/:id/handle-return — record a bank (ACH) return by hand.
// Zero tolerance: R05, R07, R10, R29 — bank payments are blocked at once.
//
// Fix pass (Step 8, money plan §3 two-row model): a return the bank sent for a
// bank debit that had SETTLED reopens through paymentReversal — the original
// rows go 'returned' and a fresh owed row is written at each row's money part
// (payments.reversal_id), so the amount is owed exactly once: on Outstanding,
// the digest, the reminder, the bill email and every agent (openBalanceSql
// never counts a 'returned' original). The old code only marked the row
// 'returned', which dropped the money out of what is owed. Every row the debit
// paid reopens (a bank return takes the whole debit back), any paid-ahead money
// it banked is taken back first, and the bank's return fee (`returnFee`, what
// Stripe charged for it) is passed to the tenant at cost.
//
// A debit that never settled ('failed') keeps owing on its own row: the code is
// written on it, and a code the bank says not to retry (closed account,
// unauthorized) cancels any retry still scheduled — its set-aside credit given
// back the way paying over a retry gives it back.
//
// A row an earlier event marked 'returned' only for its paid-ahead part (a
// reversed credit use) still holds its own bank money; the bank's return of
// that money reopens it the way a settled debit reopens.
//
// Refused, with nothing written: a debit still on its way (Stripe reports its
// own failure), a charge never sent to the bank, a card payment, settled or
// failed (a chargeback arrives as a dispute), money recorded by hand, and a
// return already recorded — two presses at the same moment included: each
// return writes one NACHA log row (keyed in its notes), and the second press
// gets a 409.
const MANUAL_RETURN_EVENT = (pi: string) => `manual_return:${pi}`
/** A NACHA return code (R01…R99), as this tool writes it; paymentReversal writes its own type there first. */
const BANK_RETURN_CODE = /^R[0-9]{2}$/
const ALREADY_RECORDED = 'This return is already recorded. The amount is owed again on its reopened charge.'
/**
 * Whether a row's own bank money still stands (paymentReversal's money part:
 * its money less what earlier records already took back of it). Asked of a
 * row an earlier event marked 'returned' only for its paid-ahead part — one
 * with a reversed credit use.
 */
async function ownMoneyStands(client: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> }, paymentId: string): Promise<boolean> {
  const row = (await client.query(
    `SELECT GREATEST(0, vm.money_part - GREATEST(0,
              COALESCE((SELECT SUM(pr.reversed_amount) FROM payment_reversals pr WHERE pr.payment_id = p.id), 0)
              - COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                           WHERE cu.payment_id = p.id AND cu.status = 'reversed'), 0)))::text AS money_part
       FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id
      WHERE p.id = $1
        AND EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status = 'reversed')`,
    [paymentId])).rows[0]
  return !!row && Math.round(Number(row.money_part) * 100) > 0
}
paymentsRouter.post('/:id/handle-return', requireAdmin, async (req: any, res, next) => {
  const client = await getClient()
  let zeroToleranceTenant: string | null = null
  let cancelAfterCommit: string[] = []
  try {
    const { returnCode, returnReason, returnFee } = z.object({
      returnCode:   z.nativeEnum(AchReturnCode),
      returnReason: z.string().max(500).optional(),
      // What Stripe charged GAM for this return. Required for a settled debit
      // (0 when it charged nothing): GAM never absorbs it.
      returnFee:    z.number().nonnegative().max(1000).optional(),
    }).parse(req.body)
    const config = ACH_RETURN_CONFIG[returnCode]
    const reason = returnReason ?? config.description

    await client.query('BEGIN')
    const head = (await client.query<{ tenant_id: string | null; landlord_id: string }>(
      `SELECT tenant_id, landlord_id FROM payments WHERE id = $1`, [req.params.id])).rows[0]
    if (!head) throw new AppError(404, 'Payment not found')
    // S655 lock order (§1.5): the household, then the row.
    if (head.tenant_id) await lockHousehold(client, head.tenant_id, head.landlord_id)
    const payment = (await client.query<any>(
      `SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0]
    if (!payment) throw new AppError(404, 'Payment not found')
    const pi: string | null = payment.stripe_payment_intent_id ?? null

    type Path = 'reverse' | 'resume' | 'failed'
    let path: Path
    /** The refusals a settled bank debit must pass before it is reopened. */
    const mustBeBankDebitWithFee = async () => {
      if (payment.manual_method || !pi) {
        throw new AppError(409,
          'This payment was not a bank debit GAM sent (it was recorded by hand or paid from credit), so there is no bank return to record here.')
      }
      await mustNotBeCard()
      if (returnFee == null) {
        throw new AppError(400,
          'Enter what Stripe charged for this return (returnFee — 0 if it charged nothing). It is passed to the tenant at cost.')
      }
    }
    /** A card payment has no bank return: its chargeback comes from Stripe as a dispute. */
    const mustNotBeCard = async () => {
      if (!pi) return
      const rem = (await client.query<{ payment_method: string | null }>(
        `SELECT payment_method FROM tenant_remittances WHERE stripe_payment_intent_id = $1 ORDER BY created_at, id LIMIT 1`,
        [pi])).rows[0]
      if (rem && rem.payment_method !== 'ach') {
        throw new AppError(409,
          'This was a card payment. A card chargeback comes from Stripe as a dispute and is handled there, not recorded here.')
      }
    }
    if (payment.status === 'returned') {
      // Three kinds of 'returned' row:
      //  - one this tool reopened whose bank code was not yet written (the
      //    second step failed — paymentReversal writes its own type there,
      //    e.g. 'ach_return'): finish it;
      //  - one an earlier event marked 'returned' only for its paid-ahead part
      //    (a reversed credit use) while its own bank money still stands, and
      //    no return is recorded on the debit yet: the bank's return of that
      //    money reopens it like a settled debit (paymentReversal reopens such
      //    a row for its money part);
      //  - anything else is already recorded.
      const recorded = pi
        ? ((await client.query(`SELECT 1 FROM payment_reversals WHERE stripe_event_id = $1 LIMIT 1`,
            [MANUAL_RETURN_EVENT(pi)])).rowCount ?? 0) > 0
        : false
      const ours = recorded && !BANK_RETURN_CODE.test(payment.return_code ?? '')
        ? ((await client.query(
            `SELECT 1 FROM payment_reversals WHERE payment_id = $1 AND stripe_event_id = $2 LIMIT 1`,
            [payment.id, MANUAL_RETURN_EVENT(pi!)])).rowCount ?? 0) > 0
        : false
      if (ours) {
        path = 'resume'
      } else if (!recorded && pi && !payment.manual_method && await ownMoneyStands(client, payment.id)) {
        await mustBeBankDebitWithFee()
        path = 'reverse'
      } else {
        throw new AppError(409, ALREADY_RECORDED)
      }
    } else if (payment.status === 'failed') {
      // Fix pass 3: a failed row is a bank return only when GAM sent it to the
      // bank. Money recorded by hand, or a row with no debit behind it, is
      // refused before any code, NACHA row or bank-payment block is written.
      if (payment.manual_method) {
        throw new AppError(409,
          'This payment was not a bank debit GAM sent (it was recorded by hand or paid from credit), so there is no bank return to record here.')
      }
      if (!pi) {
        throw new AppError(409, 'This charge was never sent to the bank, so there is no return to record. It is still owed as it is.')
      }
      await mustNotBeCard()
      path = 'failed'
    } else {
      // S655: account credit a payment in flight set aside is the credit
      // ledger's to give back (Stripe's own failure or return event does it,
      // row by row). Marking the row here would leave that credit set aside.
      const held = await client.query(
        `SELECT 1 FROM credit_uses WHERE payment_id = $1 AND status = 'held' LIMIT 1`, [payment.id])
      if ((held.rowCount ?? 0) > 0) {
        throw new AppError(409,
          'This payment has account credit set aside on it. Let Stripe\'s own failure or return event close it, ' +
          'so the credit goes back to the tenant; this tool only records returns with no credit on them.')
      }
      if (payment.status === 'processing' || (payment.status === 'pending' && pi)) {
        throw new AppError(409,
          'This payment is still on its way through the bank, and Stripe reports a failure on it by itself. ' +
          'Record a return here only once the payment shows as settled or failed.')
      }
      if (payment.status === 'pending') {
        throw new AppError(409, 'This charge was never sent to the bank, so there is no return to record. It is still owed as it is.')
      }
      if (payment.status !== 'settled') {
        throw new AppError(409, 'This charge was not paid by a bank debit, so there is no bank return to record.')
      }
      await mustBeBankDebitWithFee()
      path = 'reverse'
    }

    // The rows of this debit: every row on its intent (one bank debit, one
    // return), or the row alone when it carries no intent.
    const debitRows = (sql: string) => pi
      ? { sql: `${sql} WHERE stripe_payment_intent_id = $1`, params: [pi] as unknown[] }
      : { sql: `${sql} WHERE id = $1`, params: [payment.id] as unknown[] }

    // Which bank return this is, for the NACHA log: a settled debit is
    // returned once; a failed debit once per attempt (a retry confirms the
    // same intent again, and its failure is a new return).
    let returnKey: string
    if (path === 'failed') {
      const q = debitRows(`SELECT COALESCE(MAX(retry_count), 0)::int AS n FROM payments`)
      const attempt = (await client.query<{ n: number }>(`${q.sql} AND status = 'failed'`, q.params)).rows[0]?.n ?? 0
      returnKey = `${MANUAL_RETURN_EVENT(pi!)}:attempt${attempt}`
    } else {
      returnKey = MANUAL_RETURN_EVENT(pi!)
    }
    // Two presses of this tool are one return: the second is refused, and
    // nothing is written twice (the NACHA return rate counts each one).
    const refuseIfLogged = async () => {
      const logged = await client.query(
        `SELECT 1 FROM ach_monitoring_log WHERE event_type = 'return_received' AND notes = $1
          UNION ALL
         SELECT 1 FROM ach_monitoring_log_archive WHERE event_type = 'return_received' AND notes = $1
          LIMIT 1`, [returnKey])
      if ((logged.rowCount ?? 0) > 0) {
        throw new AppError(409, path === 'failed'
          ? 'This return is already recorded on this failed payment. It is still owed on its own charge.'
          : ALREADY_RECORDED)
      }
    }
    if (path !== 'reverse') await refuseIfLogged()

    let reopened: Array<{ paymentId: string; newPaymentId: string | null; owedAgain: number }> = []
    let owedAgain = 0
    let retryScheduled = false
    if (path === 'failed') {
      // Still owed on its own rows: write the code on every failed row of the
      // debit. A code the bank says not to retry ends any retry still
      // scheduled on it (and gives back the credit it set aside), canceled at
      // Stripe after the commit.
      const upd = debitRows(`UPDATE payments SET return_code = $2, return_reason = $3, zero_tolerance_flag = $4`)
      await client.query(`${upd.sql} AND status = 'failed'`, [...upd.params, returnCode, reason, config.zeroTolerance])
      if (!config.retryEligible && pi) {
        const rows = (await client.query<{ id: string }>(
          `SELECT id FROM payments WHERE stripe_payment_intent_id = $1 AND status = 'failed' ORDER BY id`, [pi])).rows.map(r => r.id)
        cancelAfterCommit = (await supersedeScheduledRetry(client, rows)).cancelAfterCommit
      }
      const next = debitRows(`SELECT 1 FROM payments`)
      retryScheduled = ((await client.query(
        `${next.sql} AND status = 'failed' AND next_retry_at IS NOT NULL LIMIT 1`, next.params)).rowCount ?? 0) > 0
    } else {
      if (path === 'reverse') {
        // paymentReversal takes its own locks in the same order (household,
        // payouts, charge, rows) on its own connection, so this lock is let go
        // first; this connection waits idle and takes the household again after.
        await client.query('ROLLBACK')
        const { handlePaymentReversal } = await import('../services/paymentReversal')
        const result = await handlePaymentReversal({
          paymentIntentId: pi,
          reversalType:    config.zeroTolerance ? 'ach_unauthorized' : 'ach_return',
          reversedAmount:  null,
          reversalFee:     returnFee ?? 0,
          stripeEventId:   MANUAL_RETURN_EVENT(pi!),
          stripeObjectId:  null,
          rawEvent:        { source: 'admin_handle_return', payment_id: payment.id, return_code: returnCode,
                             return_reason: reason, recorded_by: req.user?.userId ?? null, recorded_at: new Date().toISOString() },
        }).catch((e: any) => {
          // Until contract step C0 drops the old UNIQUE(stripe_event_id), a
          // debit that paid two or more charges cannot get one record per
          // charge: the whole return rolls back (paymentReversal's deploy note).
          if (e?.code === '23505' && e?.constraint === 'payment_reversals_stripe_event_id_key') {
            throw new AppError(409,
              'This debit paid more than one charge, and returns like that can be recorded only after this release\'s ' +
              'database step C0 has run. Nothing was changed — record it again once C0 is in.')
          }
          throw e
        })
        // A second press at the same moment: the first one's return is the
        // record (a finished or half-finished one is caught above, by status).
        if (!result.handled && result.reason === 'already_processed') throw new AppError(409, ALREADY_RECORDED)
        if (!result.handled) {
          throw new AppError(409, result.reason === 'not_settled'
            ? 'Nothing this debit paid is still settled, so there is nothing to reopen. Look at the charge again.'
            : 'GAM could not match this debit to a payment it can reopen. Nothing was changed.')
        }
        reopened = result.rows.filter(r => r.newPaymentId)
          .map(r => ({ paymentId: r.paymentId, newPaymentId: r.newPaymentId, owedAgain: r.owedAgain }))
        owedAgain = result.reopenedTotal
        await client.query('BEGIN')
        if (head.tenant_id) await lockHousehold(client, head.tenant_id, head.landlord_id)
        // A press that finished this return's second step while this one
        // waited has already written the codes and the NACHA log.
        await refuseIfLogged()
      } else {
        // Finishing a return: the charges it reopened, as they were written.
        reopened = (await client.query<{ paymentId: string; newPaymentId: string; owedAgain: number }>(
          `SELECT pr.payment_id::text AS "paymentId", n.id::text AS "newPaymentId", n.amount::float AS "owedAgain"
             FROM payment_reversals pr JOIN payments n ON n.reversal_id = pr.id
            WHERE pr.stripe_event_id = $1 ORDER BY n.created_at, n.id`, [MANUAL_RETURN_EVENT(pi!)])).rows
        owedAgain = Math.round(reopened.reduce((s, r) => s + r.owedAgain, 0) * 100) / 100
      }
      // The code on every row this return reopened (theirs, not another event's).
      await client.query(
        `UPDATE payments p SET return_code = $1, return_reason = $2, zero_tolerance_flag = $3
          WHERE p.stripe_payment_intent_id = $4 AND p.status = 'returned'
            AND (p.return_code IS NULL OR p.return_code !~ '^R[0-9]{2}$')
            AND EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id AND pr.stripe_event_id = $5)`,
        [returnCode, reason, config.zeroTolerance, pi, MANUAL_RETURN_EVENT(pi!)])
    }

    // Log to NACHA monitoring — once per return (returnKey in notes), at the
    // whole debit's amount whichever of its rows was pressed (fix pass 3): what
    // the bank pulled (the receipt's gross, fee on top included), else the
    // receipt's amount, else the money parts of the debit's own rows.
    const debit = (await client.query<{ amt: string | null }>(
      `SELECT COALESCE(
          (SELECT COALESCE(tr.gross_amount, tr.amount) FROM tenant_remittances tr
            WHERE tr.stripe_payment_intent_id = $1 ORDER BY tr.created_at, tr.id LIMIT 1),
          (SELECT SUM(vm.money_part) FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id
            WHERE p.stripe_payment_intent_id = $1 AND p.reversal_id IS NULL))::text AS amt`,
      [pi])).rows[0]?.amt ?? null
    await client.query(`
      INSERT INTO ach_monitoring_log
        (payment_id, event_type, tenant_id, amount, return_code, flagged, notes)
      VALUES ($1,'return_received',$2,$3,$4,$5,$6)`,
      [payment.id, payment.tenant_id, debit ?? payment.amount, returnCode, config.zeroTolerance, returnKey]
    )

    if (config.zeroTolerance && payment.tenant_id) {
      // Zero tolerance — suspend ACH for this tenant immediately. S655: the
      // block is its own column (ach_verified now only says "has a verified
      // bank"); chargeLeaseBalance and autopay refuse bank payments while set.
      await client.query(`UPDATE tenants SET ach_suspended_at = COALESCE(ach_suspended_at, NOW()) WHERE id = $1`, [payment.tenant_id])
      await client.query(`
        INSERT INTO ach_monitoring_log
          (payment_id, event_type, tenant_id, return_code, flagged, notes)
        VALUES ($1,'zero_tolerance_block',$2,$3,TRUE,'Tenant ACH suspended per NACHA zero-tolerance policy')`,
        [payment.id, payment.tenant_id, returnCode]
      )
      zeroToleranceTenant = payment.tenant_id
    }
    await client.query('COMMIT')
    await cancelSupersededIntents(cancelAfterCommit)

    // Fix pass (rev8): a bank return of a move-out balance charge (the gap
    // charge a finalized move-out took) reopens its row here as the dispute
    // webhook does — so the move-out is marked as not collected and the
    // owner's move-out page says so, exactly as when Stripe reports it
    // (webhooks.ts, charge.dispute.created). Every reopened row is checked;
    // only a move-out balance charge is marked. Never throws, once per move-out.
    if (path !== 'failed' && reopened.length > 0) {
      const { noteGapChargeReturned } = await import('../services/depositReturn')
      for (const r of reopened) {
        if (!r.newPaymentId) continue
        await noteGapChargeReturned(r.paymentId,
          `the bank returned the move-out balance charge (${returnCode}: ${reason}), recorded by hand`, { how: 'came_back' })
          .catch((err) => logger.error({ err, payment_id: r.paymentId }, '[ach-return] move-out balance charge note failed'))
      }
    }

    if (zeroToleranceTenant) {
      // ACH is the operating rail for FlexPay + OTP — once it's suspended those
      // subscriptions can't pull, so disenroll the tenant (best-effort, after
      // the commit; never blocks the return handler). These were previously
      // dead code (exported, never called).
      try {
        const { autoDisenrollFlexPayOnAchUnverified } = await import('../services/flexpay')
        await autoDisenrollFlexPayOnAchUnverified(zeroToleranceTenant)
      } catch (e) { logger.error({ err: e, tenant_id: zeroToleranceTenant }, '[ach-return] flexpay auto-disenroll failed') }
      // OTP auto-disenroll (gated/no-op while OTP is hidden; kept for re-enable).
      try {
        const { autoDisenrollOnAchUnverified } = await import('../services/otp')
        await autoDisenrollOnAchUnverified(zeroToleranceTenant)
      } catch (e) { logger.error({ err: e, tenant_id: zeroToleranceTenant }, '[ach-return] otp auto-disenroll failed') }
    }

    const owedLine = path === 'failed'
      ? 'The payment stays failed and is still owed on its own charge'
      : `Reopened — $${owedAgain.toFixed(2)} is owed again on ${reopened.length === 1 ? 'a new charge' : `${reopened.length} new charges`}`
    const retryLine = path !== 'failed' ? ''
      : !config.retryEligible ? ' (no retry: the bank says not to try this account again)'
      : retryScheduled ? ' (a scheduled retry still runs)'
      : ' (no retry is scheduled)'
    res.json({ success: true, data: {
      returnCode,
      zeroTolerance: config.zeroTolerance,
      outcome: path === 'failed' ? 'failed' : 'reopened',
      reopened,
      owedAgain,
      action: `${owedLine}${retryLine}.${config.zeroTolerance ? ' Bank payments for this tenant are suspended — manual review required.' : ''}`,
    }})
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

// POST /api/payments/:id/pay — RETIRED (S655, money plan Step 8).
//
// It charged ONE row on its own: no household lock, no pay-in-full check
// across the bill, no credit choice, and nothing to stop a second charge on a
// row Pay Now had already taken. Every payment goes through
// POST /api/payments/pay-balance (services/rentCharge), which charges the
// whole bill once. Kept registered so an old screen gets a plain answer
// instead of a 404.
paymentsRouter.post('/:id/pay', async (_req: any, _res, next) => {
  next(new AppError(410,
    'Paying one charge on its own has been retired. Pay the whole bill with POST /api/payments/pay-balance ' +
    '(the Pay Now button on the Payments page).'))
})

// ── S537 (Nic): ONE "Pay now" ───────────────────────────────────────────
// The tenant portal shows a read-only oldest-first ledger and a single Pay Now
// per lease (S581: each lease is its own charge and receipt). Rent is
// pay-in-full: the whole bill or more (paying ahead), never less (S616: there
// is no setting for partials — "in the case of it going to two different
// operators, how would you allocate that?").
//
// S655 (Nic, 10/2) — THE CREDIT PROMPT. The bill is shown IN FULL. When credit
// could pay part of it the screen offers two buttons, both actions:
//   "Use all $X — pay $Y"  (payIfUsed)   and   "Save it for later — pay $Z" (payIfSaved)
// and when the credit covers the whole bill, "Pay with credit — nothing
// charged" (coversWholeBill). The choice goes back to /pay-balance with
// expectedCredit = usableCredit; a credit that moved is a 409 and the screen
// asks again in place. Credit is applied by itself only when it covers a whole
// bill (the bill run does that). GAM's own charges are listed as their own
// line; a bank retry already scheduled says when it will run (paying now
// replaces it); money already on its way is shown as clearing, not owed.
//
// Everything here is the same arithmetic /pay-balance enforces
// (services/rentCharge planLeaseCharge), so the number shown is the number
// charged.
paymentsRouter.get('/balance-context', async (req: any, res, next) => {
  const client = await getClient()
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Only tenants can call this endpoint')
    const tenantId = req.user!.profileId

    // decisions.md #48.4: a card payment on this household's bills that nobody
    // confirmed within the hold is released before the bill is read, so any
    // look at the bill after the hold shows it open again — even if the
    // payer closed the page and the sweep has not come round yet.
    await releaseUnconfirmedCardCharges(getStripe, { tenantId }).catch((err) => {
      logger.warn({ err, tenantId }, '[balance-context] unconfirmed card release failed; the sweep will retry')
    })

    // The leases with anything to pay: rows billed to this tenant, or any row
    // on a lease they are on (one household balance), or a row on an invoice
    // of such a lease (a neighbor landlord's utility, S616).
    const leaseIds = (await client.query<{ lease_id: string }>(
      `SELECT DISTINCT COALESCE(p.lease_id, inv.lease_id) AS lease_id
         FROM payments p
         LEFT JOIN invoices inv ON inv.id = p.invoice_id
        WHERE COALESCE(p.lease_id, inv.lease_id) IS NOT NULL
          AND inv.service_agreement_id IS NULL
          AND (p.tenant_id = $1
               OR EXISTS (SELECT 1 FROM lease_tenants lt
                           WHERE lt.lease_id = COALESCE(p.lease_id, inv.lease_id) AND lt.tenant_id = $1
                             AND lt.status IN ('active','pending_add','pending_remove')))
          AND (${payableRowSql('p')} OR p.status = 'processing')`,
      [tenantId])).rows.map(r => r.lease_id)

    const r2 = (n: number) => Math.round(n * 100) / 100
    // decisions.md #48.4: card payments on this household's bills still
    // waiting on their card's bank (3-D Secure) — held, not clearing. The payer
    // is offered "Confirm with your bank" and "Cancel it and pay another way";
    // the rest of the household is told whose bank it waits on.
    const awaiting = await awaitingCardConfirmations(client, tenantId)
    const leases: any[] = []
    const allRows: any[] = []
    for (const leaseId of leaseIds.sort()) {
      const plan = await planLeaseCharge(client, { tenantId, scope: { kind: 'lease', leaseId } })
      const rowsShown = [...plan.required, ...plan.carried]
      if (rowsShown.length === 0 && plan.inFlightTotal === 0) continue
      const head = (await client.query<any>(
        `SELECT l.landlord_id, u.unit_number, pr.name AS property_name, COALESCE(u.payment_block, FALSE) AS payment_block
           FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
          WHERE l.id = $1`, [leaseId])).rows[0]
      const ids = rowsShown.map(r => r.id)
      const detail = ids.length ? (await client.query<any>(
        `SELECT p.id, p.amount::float AS amount, p.due_date::text AS due_date, p.type,
                p.entry_description, p.notes, p.lease_id, p.landlord_id, p.revenue_owner,
                p.status, p.next_retry_at, u.unit_number, pr.name AS property_name, u.payment_block
           FROM payments p
           LEFT JOIN units u ON u.id = p.unit_id
           LEFT JOIN properties pr ON pr.id = u.property_id
          WHERE p.id = ANY($1::uuid[])`, [ids])).rows : []
      const byId = new Map(detail.map((d: any) => [d.id, d]))
      const rows = rowsShown.map(r => ({ ...byId.get(r.id), creditAlreadyApplied: r.appliedCredit, carried: r.carried }))
      allRows.push(...rows)
      // What must be paid in full now if the credit is saved, and if it is used.
      const payIfSaved = r2(plan.requiredTotal - plan.creditAlreadyApplied)
      const payIfUsed = r2(payIfSaved - plan.usableCredit)
      const outstanding = r2(plan.requiredTotal + plan.carriedTotal)
      const passthrough = await tenantPassthroughFor(plan.ctx.propertyId, client)
      leases.push({
        leaseId,
        propertyName: head?.property_name ?? null,
        unitNumber: head?.unit_number ?? null,
        landlordId: plan.landlordId,
        paymentBlocked: head?.payment_block === true,
        // The whole bill, before any credit (Nic: the full balance is shown).
        outstanding,
        grossOutstanding: outstanding,
        // S622: the old balance is paid last and may be paid in part; the
        // floor is everything else. Matches /pay-balance exactly.
        carriedBalance: plan.carriedTotal,
        requiredNow: payIfSaved,
        // The credit prompt.
        usableCredit: plan.usableCredit,
        expectedCredit: plan.usableCredit,
        creditOnFile: plan.creditOnFile,
        payIfUsed: plan.usableCredit > 0 ? payIfUsed : payIfSaved,
        payIfSaved,
        coversWholeBill: plan.coversWholeBill,
        // 10/4: credit another bank payment still holds (an earlier bill's
        // scheduled retry) — left alone, the rest of the bill charged — and the
        // sentence that tells the tenant why only part of their credit is used.
        creditWaiting: plan.creditStillHeldElsewhere,
        creditWaitingNote: plan.creditWaitingNote,
        creditWaitingHeldBy: plan.creditWaitingHeldBy,
        // Fix pass 3: the rest of the credit on file and where it goes (another
        // lease's bill, or a later bill), in plain words — one bill.
        creditKeptElsewhere: plan.creditKeptElsewhere,
        creditKeptForLater: plan.creditKeptForLater,
        creditAlsoHeld: plan.creditAlsoHeld,
        creditRestNote: plan.creditRestNote,
        // "Pay all" figures (set below when 2+ bills can be paid together).
        payAll: null as any,
        // GAM's own charges on this bill, as their own line.
        gamCharges: plan.gamTotal,
        // Already on its way — clearing, not owed. A card payment still
        // waiting on its bank's confirmation is not on its way: it is listed
        // apart (awaitingConfirmation), never called clearing.
        clearing: r2(Math.max(0, plan.inFlightTotal - awaiting.filter(a => a.leaseId === leaseId).reduce((x, a) => x + a.heldOnLease, 0))),
        awaitingConfirmation: awaiting.filter(a => a.leaseId === leaseId).map(awaitingView),
        scheduledRetries: plan.scheduledRetries.map(r => ({ nextRetryAt: r.nextRetryAt })),
        // Priced exactly as /pay-balance charges: the processing fee only when
        // this property's tenant pays it, plus any tenant-payer platform fee on
        // top of a payment with money in it. S654: cash, check and money order
        // are free — the manual row is fee 0.
        methodCosts: billMethodCosts(plan.ctx, payIfSaved, passthrough),
        methodCostsIfUsed: plan.usableCredit > 0 ? billMethodCosts(plan.ctx, Math.max(0, payIfUsed), passthrough) : null,
        // S609: a SUGGESTION for the amount box. NOT a limit.
        suggestedPayAhead: r2(payIfSaved + await suggestedPayAheadFor(leaseId)),
        rows,
      })
    }

    // "Pay all" with "Use all" charges these bills one after another: each
    // lease with a bank retry scheduled first (paying it replaces the retry and
    // frees what it set aside), then the rest in this list's order. Each bill
    // gets the credit figure its charge will find when its turn comes (the
    // earlier charges played through first — rentCharge planLeaseCharge
    // `after`), so the run never stops on "Your credit changed" and the same
    // dollars are never offered on two bills. The screen sends these figures,
    // and asks the quote with the same order.
    // The same set the Payments page's "Pay all" sends (not paused, something owed).
    const payAllSet = leases.filter(l => !l.paymentBlocked && r2(Math.max(0, l.requiredNow) + Math.max(0, l.carriedBalance)) > 0)
    if (payAllSet.length >= 2) {
      const retrying = (l: any) => (l.scheduledRetries?.length ?? 0) > 0
      const order: string[] = [...payAllSet.filter(retrying), ...payAllSet.filter(l => !retrying(l))].map(l => l.leaseId)
      // Fix pass 2: ONE waiting figure for the whole run. Each bill's own
      // figure may count the same held dollars (a paused lease's retry holds
      // credit every bill of the run could use), so the screen says this one.
      const runCreditWaiting = await payAllRunCreditWaiting(client, { tenantId, order })
      const runCreditWaitingNote = creditWaitingSentence(Math.round(runCreditWaiting * 100))
      // The credit on file for the run's landlords and where the rest of it
      // goes — so the Pay all box explains every dollar, as one bill's does.
      const runRest = await payAllRunCreditRest(client, { tenantId, order })
      for (let i = 0; i < order.length; i++) {
        const plan = await planLeaseCharge(client, { tenantId, scope: { kind: 'lease', leaseId: order[i] }, after: order.slice(0, i) })
        const l = leases.find(x => x.leaseId === order[i])!
        l.payAll = {
          order,
          usableCredit: plan.usableCredit,
          expectedCredit: plan.usableCredit,
          payIfUsed: plan.usableCredit > 0 ? r2(l.payIfSaved - plan.usableCredit) : l.payIfSaved,
          coversWholeBill: plan.coversWholeBill,
          creditWaiting: plan.creditStillHeldElsewhere,
          creditWaitingNote: plan.creditWaitingNote,
          // The run's one figure (the same on every bill): what the pay screen says.
          runCreditWaiting,
          runCreditWaitingNote,
          // The run's credit on file and the rest of it, in plain words (the
          // same on every bill): "You have $X credit. $Y of it can pay these
          // bills." followed by runCreditRestNote.
          runCreditOnFile: runRest.onFile,
          runCreditKeptElsewhere: runRest.elsewhere,
          runCreditKeptForLater: runRest.later,
          runCreditAlsoHeld: runRest.heldMore,
          runCreditRestNote: runRest.note,
        }
      }
    }

    // S615/S616: a payer with no lease (the neighbor buying trash and
    // electric) pays per AGREEMENT — one bill, however many utilities. No
    // credit pays these (credit pays a lease's own charges).
    const serviceRows = (await client.query<any>(
      `SELECT p.id, p.amount::float AS amount, p.due_date::text AS due_date, p.type,
              p.notes, u.unit_number, pr.name AS property_name, inv.service_agreement_id
         FROM payments p
         JOIN invoices inv ON inv.id = p.invoice_id
         JOIN units u ON u.id = p.unit_id
         JOIN properties pr ON pr.id = u.property_id
        WHERE p.tenant_id = $1 AND inv.service_agreement_id IS NOT NULL
          AND ${payableRowSql('p')}
        ORDER BY p.due_date ASC, p.created_at ASC, p.id`,
      [tenantId])).rows
    const byAgreement = new Map<string, {
      serviceAgreementId: string; outstanding: number
      unitNumber: string; propertyName: string; dueDate: string
      rows: any[]; methodCosts?: any
    }>()
    for (const r of serviceRows) {
      let g = byAgreement.get(r.service_agreement_id)
      if (!g) {
        g = { serviceAgreementId: r.service_agreement_id, outstanding: 0, unitNumber: r.unit_number,
              propertyName: r.property_name, dueDate: r.due_date, rows: [] }
        byAgreement.set(r.service_agreement_id, g)
      }
      g.outstanding = r2(g.outstanding + r.amount)
      if (r.due_date < g.dueDate) g.dueDate = r.due_date
      g.rows.push({ id: r.id, amount: r.amount, dueDate: r.due_date, type: r.type, notes: r.notes })
    }
    // Priced as /pay-balance charges the agreement (its property's fee payer,
    // any tenant-payer platform fee on top), the same as a lease's bill.
    const serviceAgreements: any[] = []
    for (const a of byAgreement.values()) {
      const plan = await planLeaseCharge(client, { tenantId, scope: { kind: 'service', serviceAgreementId: a.serviceAgreementId } })
      serviceAgreements.push({
        ...a, methodCosts: billMethodCosts(plan.ctx, a.outstanding, await tenantPassthroughFor(plan.ctx.propertyId, client)),
        awaitingConfirmation: awaiting.filter(x => x.serviceAgreementId === a.serviceAgreementId).map(awaitingView),
      })
    }

    res.json({ success: true, data: {
      totalOutstanding: r2(leases.reduce((s, l) => s + l.outstanding, 0)
        + serviceAgreements.reduce((s, a) => s + a.outstanding, 0)),
      // Legacy scalar: blocked only if EVERY lease is (leases[].paymentBlocked is the real signal).
      paymentBlocked: leases.length ? leases.every(l => l.paymentBlocked) : false,
      leases,
      serviceAgreements,
      // decisions.md #48.4: every held card payment in one list, for the
      // Payments page — a bill whose whole amount is held shows nothing owed,
      // so its lease card (and the pay window) is not drawn; this is where the
      // page offers Confirm / Cancel for it.
      awaitingCardConfirmations: awaiting.map(awaitingView),
      rows: [...allRows, ...serviceRows],
    } })
  } catch (e) { next(e) } finally { client.release() }
})

// S539: tenant-facing "where every dollar went" — the tenant's Pay Now
// remittances with their per-line FIFO applications (stored in
// remittance_applications since S537, never surfaced until now), plus
// any prepaid credit still waiting for invoice generation to consume.
paymentsRouter.get('/remittances', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Only tenants can call this endpoint')
    const tenantId = req.user!.profileId

    // S655: each receipt says how much MONEY it was and, apart from that, how
    // much account credit it used (set aside while a payment clears, or used).
    const remits = await query<any>(
      `SELECT r.id, r.amount::float AS amount,
              r.applied_amount::float AS applied_amount,
              r.unapplied_amount::float AS unapplied_amount,
              r.status, r.payment_method,
              r.created_at, r.settled_at,
              COALESCE((SELECT SUM(u.amount) FROM credit_uses u
                         WHERE u.remittance_id = r.id AND u.status IN ('held','applied')), 0)::float AS credit_used,
              -- decisions.md #48.4: a card payment released before anything
              -- was charged has why on its receipt, recorded when it was
              -- released (jobs/paymentReconcile CARD_RELEASE_NOTE): canceled
              -- (its bank's confirmation closed, failed or ran out, or canceled
              -- to pay another way), or declined by the card's bank. The page
              -- says so instead of a red 'Failed'.
              COALESCE(r.payment_method = 'card' AND r.status = 'failed' AND r.notes = $2, FALSE) AS canceled_before_charge,
              COALESCE(r.payment_method = 'card' AND r.status = 'failed' AND r.notes = $3, FALSE) AS declined_before_charge
         FROM tenant_remittances r
        WHERE r.tenant_id = $1
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [tenantId, CARD_RELEASE_NOTE.canceled, CARD_RELEASE_NOTE.declined])

    const linesByRemit = new Map<string, any[]>()
    if (remits.length > 0) {
      const lines = await query<any>(
        `SELECT ra.remittance_id, ra.payment_id,
                ra.amount_applied::float AS amount_applied,
                p.type, p.due_date::text AS due_date,
                p.entry_description, p.status AS payment_status
           FROM remittance_applications ra
           JOIN payments p ON p.id = ra.payment_id
          WHERE ra.remittance_id = ANY($1::uuid[])
          ORDER BY p.due_date ASC, p.created_at ASC`,
        [remits.map((r: any) => r.id)])
      for (const ln of lines) {
        const bucket = linesByRemit.get(ln.remittance_id)
        if (bucket) bucket.push(ln)
        else linesByRemit.set(ln.remittance_id, [ln])
      }
    }

    // A withdrawn credit (an undone bank-deposit match) is out of every balance,
    // and so is paid-ahead money a dispute or return of its own funding still
    // claims (creditUse.usablePaidAheadSql, the one rule): it is not the
    // tenant's to spend.
    const paidAhead = await queryOne<{ usable: string }>(
      `SELECT COALESCE(SUM(${usablePaidAheadSql('pc', 'dc')}), 0)::text AS usable
         FROM lease_prepaid_credits pc
         ${disputeClaimJoinSql('pc', 'dc')}
        WHERE pc.tenant_id = $1 AND pc.amount_remaining > 0 AND pc.voided_at IS NULL`,
      [tenantId])
    const prepaidRemaining = Math.max(0, Math.round(Number(paidAhead?.usable ?? 0) * 100) / 100)

    // ── S642: CREDITS THAT ARE NOT PAY-AHEAD ──────────────────────────────
    //
    // This card read lease_prepaid_credits ONLY — money the tenant paid ahead.
    // Statutory deposit interest is now credited to tenant_credits instead, and
    // that table already reduces what they owe (see the balance query above).
    // So the balance would drop and the card would explain nothing: money
    // appearing from nowhere, which reads as a bug to the one person who can
    // least afford to guess.
    //
    // Returned SEPARATELY rather than folded into prepaidRemaining, because
    // "you paid ahead" and "your state owes you interest on your deposit" are
    // different sentences and the second one is worth reading.
    const otherCredits = await query<any>(
      `SELECT category,
              SUM(amount_remaining)::float AS remaining
         FROM tenant_credits
        WHERE tenant_id = $1 AND status = 'active' AND amount_remaining > 0
        GROUP BY category`,
      [tenantId])
    const depositInterestCredit = Math.round(
      (otherCredits.find((c: any) => c.category === 'deposit_interest')?.remaining ?? 0) * 100) / 100
    const otherCreditTotal = Math.round(
      otherCredits.filter((c: any) => c.category !== 'deposit_interest')
        .reduce((s: number, c: any) => s + Number(c.remaining), 0) * 100) / 100

    // S653: if the resident asked for a monthly cap on their paid-ahead money,
    // say so — "$200 of this goes on each bill" is the sentence they expect.
    const drawRow = await queryOne<{ draw: string | null }>(
      `SELECT MAX(prepaid_monthly_draw)::text AS draw FROM leases l
        JOIN lease_tenants lt ON lt.lease_id = l.id
       WHERE lt.tenant_id = $1 AND lt.status = 'active' AND l.status = 'active'`, [tenantId])
    const prepaidMonthlyDraw = drawRow?.draw != null ? Number(drawRow.draw) : null
    res.json({ success: true, data: {
      remittances: remits.map((r: any) => ({ ...r, lines: linesByRemit.get(r.id) ?? [] })),
      prepaidRemaining,
      prepaidMonthlyDraw,
      depositInterestCredit,
      otherCreditTotal,
    } })
  } catch (e) { next(e) }
})

paymentsRouter.post('/pay-balance', async (req: any, res, next) => {
  try {
    const body = chargeLeaseBalanceSchema.parse(req.body)
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only tenants can call this endpoint')
    }
    const tenantId = req.user!.profileId
    // S655 (Nic, 10/2): "Use all $X" or "Save it for later", and the credit
    // figure the screen showed. Required when credit could pay part of the
    // bill; a moved figure is a 409 and the screen asks again in place. The
    // answer never travels without the figure it answered (shelved 8).
    if (body.useCredit != null && body.expectedCredit == null) {
      throw new AppError(422, 'Send the credit figure you were shown (expectedCredit) with the answer to use or save it.')
    }
    const creditChoice = body.useCredit == null ? null
      : { use: body.useCredit, expected: body.expectedCredit ?? null }
    // decisions.md #48.4: a card payment of this payer's that nobody confirmed
    // within the hold is released before anything else is read, so the bill
    // it held can be paid now (the sweep does this every few minutes anyway).
    await releaseUnconfirmedCardCharges(getStripe, { tenantId }).catch((err) => {
      logger.warn({ err, tenantId }, '[pay-balance] unconfirmed card release failed; the sweep will retry')
    })

    // S616 (Nic): a payer with no lease — the neighbor buying trash and
    // electric — settles their agreement's whole bill in one charge. "Their
    // trash and electric needs to be on one bill if they have more than one
    // utility through this subsystem." Ownership is checked against the
    // agreement rather than a lease, which they do not have.
    if (body.serviceAgreementId) {
      const owns = await queryOne<{ id: string }>(
        `SELECT id FROM utility_service_agreements
          WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
        [body.serviceAgreementId, tenantId])
      if (!owns) throw new AppError(404, 'Service agreement not found')
      const result = await chargeLeaseBalance({
        tenantId,
        serviceAgreementId: body.serviceAgreementId,
        amount:            body.amount,
        paymentMethodId:   body.paymentMethodId,
        paymentMethodType: body.paymentMethodType,
        source:            'portal',
        credit:            creditChoice,
        idempotencyKey:    body.idempotencyKey ?? null,
        confirmOnScreen:   body.confirmOnScreen === true,
      })
      return res.json({ success: true, data: result })
    }

    const leaseId = await resolveTargetLease(tenantId, body.leaseId ?? null)

    // S609: the charge itself lives in services/rentCharge so the autopay
    // runner charges through the exact same code — one implementation of "how
    // rent is charged", never two that can drift.
    const result = await chargeLeaseBalance({
      tenantId,
      leaseId,
      amount:            body.amount,
      paymentMethodId:   body.paymentMethodId,
      paymentMethodType: body.paymentMethodType,
      source:            'portal',
      credit:            creditChoice,
      // One key per press of Pay: the same press re-sent is never charged twice.
      idempotencyKey:    body.idempotencyKey ?? null,
      // decisions.md #48.4: the pay screen finishes a card's 3-D Secure
      // confirmation itself (the assistant does not send this).
      confirmOnScreen:   body.confirmOnScreen === true,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

/**
 * decisions.md #48.4: a card payment of THIS payer's still waiting on their
 * card's bank (3-D Secure). 404 for anyone else's (or none).
 */
async function ownUnconfirmedCardCharge(tenantId: string, paymentIntentId: string): Promise<{ status: string; createdAt: string; declined: boolean }> {
  const rem = await queryOne<{ status: string; created_at: string; notes: string | null }>(
    `SELECT status, created_at, notes FROM tenant_remittances
      WHERE stripe_payment_intent_id = $1 AND tenant_id = $2 AND payment_method = 'card'
      ORDER BY created_at LIMIT 1`, [paymentIntentId, tenantId])
  if (!rem) throw new AppError(404, 'That card payment was not found on your account.')
  return {
    status: rem.status, createdAt: new Date(rem.created_at).toISOString(),
    // Released because the card's bank declined it (jobs/paymentReconcile CARD_RELEASE_NOTE).
    declined: rem.status === 'failed' && rem.notes === CARD_RELEASE_NOTE.declined,
  }
}

/**
 * decisions.md #48.4: said when a payer asks to confirm or cancel a card
 * charge that is not a pay-screen charge (paymentReconcile.confirmedOnScreen
 * — e.g. a move-out balance charge GAM finishes itself). Nothing is done.
 */
const NOT_HELD_FOR_YOU_TEXT =
  'That card payment isn\'t waiting on your card\'s bank, so there is nothing to confirm or cancel here. Where it stands shows in your payment history.'

const unconfirmedSchema = z.object({ paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9_]+$/, 'paymentIntentId: a Stripe payment id') })

// POST /api/payments/pay-balance/release — the pay screen's "the bank did not
// confirm it" (the cardholder closed the bank's window, or the bank said no),
// and its "Cancel it and pay another way": the charge is canceled and the bill
// it held is open again at once, with the credit it set aside back. A charge
// that went through meanwhile is left alone and said so. `declined`: the
// card's bank refused the payment itself (after the cardholder confirmed it),
// so the screen says "declined", not "didn't confirm" — released the same way.
paymentsRouter.post('/pay-balance/release', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Only tenants can call this endpoint')
    const { paymentIntentId } = unconfirmedSchema.parse(req.body)
    const rem = await ownUnconfirmedCardCharge(req.user!.profileId, paymentIntentId)
    if (rem.status === 'settled') return res.json({ success: true, data: { outcome: 'went_through', declined: false } })
    const { outcome, declined } = await releaseUnconfirmedChargeDetailed(getStripe(), paymentIntentId)
    // Only the pay screen's own charge is the payer's to cancel; anything
    // else is left exactly as it is.
    if (outcome === 'not_held') throw new AppError(409, NOT_HELD_FOR_YOU_TEXT)
    res.json({ success: true, data: { outcome, declined } })
  } catch (e) { next(e) }
})

// POST /api/payments/pay-balance/resume — a card payment still waiting on its
// bank's confirmation, picked up again (the payer left the screen before
// confirming): what the screen needs to show the bank's window again. Read
// fresh from Stripe; never stored.
//
// A payment already released says why, so the screen never guesses it from
// the clock: `expired` — released now because nobody confirmed it within the
// time the screen showed; `declined` — the card's bank refused it; neither —
// it was already canceled (another tab, the sweep, its bank's window).
paymentsRouter.post('/pay-balance/resume', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Only tenants can call this endpoint')
    const { paymentIntentId } = unconfirmedSchema.parse(req.body)
    const rem = await ownUnconfirmedCardCharge(req.user!.profileId, paymentIntentId)
    const confirmBy = new Date(new Date(rem.createdAt).getTime() + CARD_CONFIRM_HOLD_MINUTES * 60_000)
    // Already decided — the receipt says so first, then Stripe: a payment
    // that went through (its webhook may not have landed yet), or one already
    // canceled (another tab, the sweep). The screen says which; it never asks
    // the payer to cancel something that is gone or that went through.
    if (rem.status === 'settled') {
      return res.json({ success: true, data: { status: 'succeeded', outcome: 'went_through', declined: false, expired: false, clientSecret: null, confirmBy: confirmBy.toISOString() } })
    }
    if (rem.status === 'failed') {
      return res.json({ success: true, data: { status: 'canceled', outcome: 'released', declined: rem.declined, expired: false, clientSecret: null, confirmBy: confirmBy.toISOString() } })
    }
    const pi = await getStripe().paymentIntents.retrieve(paymentIntentId)
    // Only the pay screen's own charge is the payer's to confirm.
    if (!confirmedOnScreen(pi)) throw new AppError(409, NOT_HELD_FOR_YOU_TEXT)
    // Past the time the screen promised: never offered again. Released now
    // (as the sweep would), so the bill is open — unless it went through.
    // `expired` only when the time ran out on a payment still waiting: one
    // already canceled in Stripe (its dashboard, another tab) was canceled,
    // and the screen says that, not that the time ran out.
    if (rem.status === 'processing' && Date.now() >= confirmBy.getTime()) {
      const canceledBefore = pi.status === 'canceled'
      const { outcome, declined } = await releaseUnconfirmedChargeDetailed(getStripe(), paymentIntentId)
      return res.json({ success: true, data: {
        status: outcome === 'went_through' ? 'processing' : 'canceled',
        outcome, declined, expired: outcome === 'released' && !declined && !canceledBefore,
        clientSecret: null, confirmBy: confirmBy.toISOString(),
      } })
    }
    // Canceled in Stripe (its dashboard, or a cancel whose bill side did not
    // finish) while the receipt here still holds the bill: the bill side runs
    // now (idempotent, under the household lock), so "your bill is open to
    // pay" is true when the screen says it.
    if (rem.status === 'processing' && pi.status === 'canceled') {
      const { outcome, declined } = await releaseUnconfirmedChargeDetailed(getStripe(), paymentIntentId)
      return res.json({ success: true, data: {
        status: outcome === 'went_through' ? 'processing' : 'canceled',
        outcome, declined, expired: false,
        clientSecret: null, confirmBy: confirmBy.toISOString(),
      } })
    }
    const outcome =['succeeded', 'processing', 'requires_capture'].includes(pi.status) ? 'went_through'
      : pi.status === 'canceled' ? 'released'
      : null
    const canConfirm = rem.status === 'processing' && pi.status === 'requires_action'
    res.json({ success: true, data: {
      status: pi.status,
      ...(outcome ? { outcome, declined: false, expired: false } : {}),
      clientSecret: canConfirm ? pi.client_secret : null,
      confirmBy: confirmBy.toISOString(),
    } })
  } catch (e) { next(e) }
})

/** A card payment held while its bank asks the cardholder to confirm it (decisions.md #48.4). */
interface AwaitingCardConfirmationRow {
  paymentIntentId: string
  /** Its receipt (the Payments page's history marks it "Waiting on your bank"). */
  remittanceId: string
  /** The company the payment goes to (the desk shows only its own). */
  landlordId: string
  /** The lease whose bill it holds; null for a payer with no lease (a service agreement). */
  leaseId: string | null
  /** The service agreement whose bill it holds (a payer with no lease); null on a lease. */
  serviceAgreementId: string | null
  amount: number
  heldOnLease: number
  confirmBy: string
  /** The viewer made this payment: only they can confirm or cancel it. */
  mine: boolean
  /** Who made it, by name (shown to the rest of the household); null when no name is on file (the screen words it). */
  payerName: string | null
  /** The bank's window can still be shown (Stripe 'requires_action') — the payer only. */
  canConfirm: boolean
  /** The park's clock (its property's time zone) for the time the bill opens; null when the charge is on no space. */
  timezone: string | null
}

/**
 * decisions.md #48.4: card payments still waiting on their card's bank
 * (receipt 'processing', a row still waiting on it, and Stripe says it needs
 * the cardholder) on any bill the viewer pays — their own, and those of their
 * household on a lease they share (one household balance: a co-tenant's held
 * payment is "waiting on <name>'s card bank", never "clearing"). Per lease, or
 * per service agreement for a payer with no lease. Asked of Stripe only for
 * these processing card receipts — normally none (a card settles in seconds).
 */
async function awaitingCardConfirmations(
  client: import('pg').PoolClient, tenantId: string,
): Promise<AwaitingCardConfirmationRow[]> {
  const pending = (await client.query<{
    pi: string; created_at: string; gross: string; lease_id: string | null; agreement_id: string | null
    held: string; payer_id: string; first_name: string | null; last_name: string | null
    remittance_id: string; landlord_id: string; tz: string | null
  }>(
    `SELECT r.stripe_payment_intent_id AS pi, r.created_at, r.id AS remittance_id, r.landlord_id,
            COALESCE(r.gross_amount, r.amount)::text AS gross,
            COALESCE(p.lease_id, inv.lease_id) AS lease_id, inv.service_agreement_id AS agreement_id,
            SUM(p.amount)::text AS held, r.tenant_id AS payer_id, u.first_name, u.last_name,
            MIN(pr.timezone) AS tz
       FROM tenant_remittances r
       JOIN payments p ON p.stripe_payment_intent_id = r.stripe_payment_intent_id AND p.status = 'processing'
       LEFT JOIN invoices inv ON inv.id = p.invoice_id
       LEFT JOIN units un ON un.id = p.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
       LEFT JOIN tenants t ON t.id = r.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
      WHERE r.status = 'processing' AND r.payment_method = 'card'
        AND r.stripe_payment_intent_id IS NOT NULL
        AND (r.tenant_id = $1
             OR EXISTS (SELECT 1 FROM lease_tenants lt
                         WHERE lt.lease_id = COALESCE(p.lease_id, inv.lease_id) AND lt.tenant_id = $1
                           AND lt.status IN ('active','pending_add','pending_remove')))
      GROUP BY r.stripe_payment_intent_id, r.created_at, r.id, r.landlord_id, 5, 6, 7, r.tenant_id, u.first_name, u.last_name`,
    [tenantId])).rows
  if (pending.length === 0) return []
  const out: AwaitingCardConfirmationRow[] = []
  const live = new Map<string, { status: string; metadata?: import('stripe').Stripe.Metadata | null } | null>()
  for (const r of pending) {
    if (!live.has(r.pi)) {
      // Not readable just now: shown as it stands (clearing) — the sweep and
      // the next read settle it.
      let pi: { status: string; metadata?: import('stripe').Stripe.Metadata | null } | null = null
      try { pi = await getStripe().paymentIntents.retrieve(r.pi) } catch { pi = null }
      live.set(r.pi, pi)
    }
    const pi = live.get(r.pi) ?? null
    // Only the pay screen's own charge waits on its cardholder; any other
    // card charge (a move-out balance charge GAM is finishing) is never
    // shown as waiting on the tenant's bank, nor offered to cancel.
    if (!heldForCardholder(pi)) continue
    const st = pi!.status
    if (!r.lease_id && !r.agreement_id) continue
    const mine = r.payer_id === tenantId
    out.push({
      paymentIntentId: r.pi,
      remittanceId: r.remittance_id,
      landlordId: r.landlord_id,
      leaseId: r.lease_id,
      serviceAgreementId: r.lease_id ? null : r.agreement_id,
      amount: Math.round(Number(r.gross) * 100) / 100,
      heldOnLease: Math.round(Number(r.held) * 100) / 100,
      confirmBy: new Date(new Date(r.created_at).getTime() + CARD_CONFIRM_HOLD_MINUTES * 60_000).toISOString(),
      mine,
      payerName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || null,
      canConfirm: mine && st === 'requires_action',
      timezone: r.tz,
    })
  }
  return out
}

/**
 * decisions.md #48.4: release the household's card holds that nobody confirmed
 * within CARD_CONFIRM_HOLD_MINUTES before a desk screen or desk write reads the
 * bill. Never throws (the five-minute sweep tries again). Call it outside any
 * transaction that holds the household's lock or rows.
 */
async function releaseExpiredCardHolds(tenantId: string, where: string, landlordIds: string[]): Promise<void> {
  // Only the caller's own companies' charges: staff act within their scope.
  await releaseUnconfirmedCardCharges(getStripe, { tenantId, landlordIds }).catch((err) => {
    logger.warn({ err, tenantId }, `[${where}] unconfirmed card release failed; the sweep will retry`)
  })
}

/**
 * Why the desk cannot take payment on a charge that is not open, in plain
 * words with the next step — never a status value. A card payment still
 * waiting on its card's bank (decisions.md #48.4) says when the bill opens
 * and how the resident can pay another way now. Stripe decides which it is,
 * however old the card payment is (a hold whose release failed — Stripe was
 * down for the sweep — is still a hold, not a payment): a card that went
 * through but whose success has not landed yet (a desk reader capture just
 * booked, a portal card a moment ago) is "just paid", never "nothing has been
 * charged"; a pay-screen card already canceled in Stripe, or past the time
 * the hold promised, is released here and now (the same release the sweep
 * makes, idempotent, under the household lock), so the bill the desk reads
 * again is open. Stripe not readable: "in progress, try again in a minute" —
 * never "just paid". Call it with no transaction open (it may ask Stripe and
 * take the household lock).
 */
async function notOpenAtDeskText(paymentId: string, status: string): Promise<string> {
  // The desk window reads the bill again by itself on every refusal, so the
  // words never ask staff to close or reopen it.
  if (status === 'processing') {
    const held = await queryOne<{ pi: string; created_at: string; tz: string | null; same_company: boolean }>(
      `SELECT r.stripe_payment_intent_id AS pi, r.created_at, pr.timezone AS tz,
              (r.landlord_id = p.landlord_id) AS same_company
         FROM payments p
         JOIN tenant_remittances r ON r.stripe_payment_intent_id = p.stripe_payment_intent_id
         LEFT JOIN units un ON un.id = p.unit_id LEFT JOIN properties pr ON pr.id = un.property_id
        WHERE p.id = $1 AND p.status = 'processing' AND r.status = 'processing' AND r.payment_method = 'card'
        ORDER BY r.created_at LIMIT 1`, [paymentId])
    if (held) {
      let pi: Awaited<ReturnType<ReturnType<typeof getStripe>['paymentIntents']['retrieve']>> | null = null
      try { pi = await getStripe().paymentIntents.retrieve(held.pi) } catch (err) {
        logger.warn({ err, paymentIntentId: held.pi }, '[desk] could not read the card payment on a bill that is not open')
      }
      if (!pi) {
        return 'This charge has a card payment in progress that could not be checked just now — the bill above was read again. Try again in a minute.'
      }
      const confirmBy = new Date(new Date(held.created_at).getTime() + CARD_CONFIRM_HOLD_MINUTES * 60_000)
      const canceled = confirmedOnScreen(pi) && pi.status === 'canceled'
      const runOut = heldForCardholder(pi) && Date.now() >= confirmBy.getTime()
      if ((canceled || runOut) && held.same_company) {
        // Nothing was charged and nothing more will be: the bill opens now.
        let outcome: string | null = null
        try { outcome = (await releaseUnconfirmedChargeDetailed(getStripe(), held.pi)).outcome } catch (err) {
          logger.warn({ err, paymentIntentId: held.pi }, '[desk] could not release a card payment nobody confirmed; the sweep will retry')
        }
        if (outcome === 'released') {
          return 'The resident\'s card payment on this bill was canceled before anything was charged, so the bill is open again — the bill above was read again. Take the payment now.'
        }
        if (outcome === 'went_through') return 'This charge was just paid or is on its way — the bill above was read again.'
        return 'The resident\'s card payment on this bill was not confirmed by their card\'s bank, so nothing has been charged and the bill is opening again. '
          + 'It opens here in a few minutes — try again then.'
      }
      if (canceled) {
        return 'The resident\'s card payment on this bill was canceled before anything was charged, so nothing has been charged and the bill is opening again. '
          + 'It opens here in a few minutes — try again then.'
      }
      if (heldForCardholder(pi)) {
        if (Date.now() >= confirmBy.getTime()) {
          return 'This bill is waiting on the resident\'s card payment to be confirmed by their card\'s bank — nothing has been charged yet. '
            + 'Its time to confirm has run out, so it opens here in a few minutes. '
            + 'The bill above was read again.'
        }
        // The park's own clock; a charge on no space has no park, so no clock
        // time is guessed for it.
        const opensAt = held.tz
          ? `at ${confirmBy.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: held.tz })}`
          : `within ${CARD_CONFIRM_HOLD_MINUTES} minutes of when they paid`
        return 'This bill is waiting on the resident\'s card payment to be confirmed by their card\'s bank — nothing has been charged yet. '
          + `It opens here by itself ${opensAt} if they don't confirm it. `
          + 'If they want to pay another way now, whoever made the card payment can tap \'Cancel it and pay another way\' on their Payments page, and the bill opens here. '
          + 'The bill above was read again.'
      }
    }
  }
  return 'This charge was just paid or is on its way — the bill above was read again.'
}

/** What the pay screen is told about one held card payment. */
function awaitingView(a: AwaitingCardConfirmationRow) {
  return {
    paymentIntentId: a.paymentIntentId, remittanceId: a.remittanceId, amount: a.amount, confirmBy: a.confirmBy,
    canConfirm: a.canConfirm, mine: a.mine, payerName: a.mine ? null : a.payerName,
    leaseId: a.leaseId, serviceAgreementId: a.serviceAgreementId,
  }
}

// S652 (Nic): POST a payment that arrived before there was a bill — a check
// paid ahead for October. Settles what is open, banks the rest as paid ahead.
const postPaymentSchema = z.object({
  tenantId:   z.string().uuid(),
  method:     z.enum(MANUAL_PAYMENT_METHODS),
  amount:     z.number().positive(),
  // A check or money-order number, or (10/5) a bank deposit's reference number.
  reference:  z.string().max(120).optional().nullable(),
  notes:      z.string().max(500).optional().nullable(),
  receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
})
paymentsRouter.post('/post-payment', requirePerm('take_payment'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    const body = postPaymentSchema.parse(req.body)
    const landlordIds = landlordScopeIds(req.user!)
    if (!landlordIds.length) throw new AppError(403, 'Landlord scope required')
    // 10/5 (Nic): a bank deposit's date cannot be after today where the
    // resident's space is (the lease postTenantPayment posts to).
    if (body.method === 'bank_deposit' && body.receivedAt) {
      const where = await queryOne<{ property_id: string | null }>(
        `SELECT u.property_id
           FROM leases l JOIN lease_tenants lt ON lt.lease_id = l.id
           LEFT JOIN units u ON u.id = l.unit_id
          WHERE lt.tenant_id = $1 AND lt.status = 'active' AND l.status IN ('active', 'pending')
            AND l.landlord_id = ANY($2::uuid[])
          ORDER BY l.status = 'active' DESC, l.start_date DESC, l.id LIMIT 1`,
        [body.tenantId, landlordIds])
      depositedOnAsSettledAt(body.method, body.receivedAt, await propertyToday(where?.property_id))
    }
    // decisions.md #48.4: an expired card hold on the household is released
    // before the payment is posted against its bill (before BEGIN — the
    // release takes the household lock on its own connection).
    await releaseExpiredCardHolds(body.tenantId, 'post-payment', landlordIds)
    await client.query('BEGIN')
    const { postTenantPayment } = await import('../services/postPayment')
    const { afterCommit, ...r } = await postTenantPayment(client, {
      tenantId: body.tenantId, landlordIds, method: body.method, amount: body.amount,
      reference: body.reference ?? null, notes: body.notes ?? null,
      // S654: noon UTC is the same calendar day in every US zone, so the date
      // the desk typed survives whatever clock the host runs on.
      receivedAt: body.receivedAt ? new Date(body.receivedAt + 'T12:00:00Z') : null,
      // 10/5 (Nic): a bank deposit dated back takes off the late fees charged after it, paid in full.
      depositedOn: body.method === 'bank_deposit' ? (body.receivedAt ?? null) : null,
      postedBy: req.user!.userId,
    })
    // A staffer assigned to one property posts only for a resident there.
    // Checked inside the transaction: a refusal rolls the whole post back.
    const where = (await client.query<{ property_id: string | null }>(
      `SELECT u.property_id FROM leases l LEFT JOIN units u ON u.id = l.unit_id WHERE l.id = $1`, [r.leaseId])).rows[0]
    await assertChargeInStaffScope(req.user, where?.property_id ?? null)
    await client.query('COMMIT')
    // The receipt, and the whole-bill check for money paid ahead — after the
    // commit, never able to undo a payment that happened.
    await afterCommit()
    res.json({ success: true, data: r })
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); next(e) } finally { client.release() }
})

// POST /api/payments/:id/record-manual — S562.
//
// Landlord/staff records that a tenant paid a pending rent charge OFF-PLATFORM
// (cash / check / money order). The rent obligation is satisfied WITHOUT GAM
// moving any money: the row is marked settled with platform_held=FALSE,
// stripe_payment_intent_id=NULL, and manual_method set. It reads as "paid"
// everywhere that treats settled as paid (balance / FIFO / late-fee / rent-roll),
// while the weekly batch (services/landlordPassthrough.ts) SKIPS it because that
// path requires platform_held=TRUE — so the landlord, who already physically
// holds the cash, is never double-paid.
//
// S654 (Nic): "There's no fee. Paying cash or check is free." Recording a cash,
// check or money-order payment charges nobody — no fee row, no waiver, no
// fee-payer setting.
//
// Auth: requirePerm('take_payment') (owner roles auto-pass; staff need the
// take_payment sub-permission). canManageLandlordResource confirms scope.
const recordManualSchema = z.object({
  // S651 — CARD IS NOT AND WILL NOT BE ON THIS LIST. Nic: "record payment
  // never does card. card is through pos/paylink for non tenants. invoices for
  // tenants are through portal if electronic." record-manual writes down money
  // that moved somewhere GAM was not; a card on the counter goes through the
  // reader (POST /:id/reader/charge), which is a card payment like any other.
  // 'cash' | 'check' | 'money_order' | 'bank_deposit' (10/5, Nic: residents who
  // pay by depositing cash at the landlord's bank; the reference is required).
  method:    z.enum(MANUAL_PAYMENT_METHODS),
  reference: z.string().max(120).optional(),   // check # / money-order # / bank deposit reference, for the audit trail
  // S655 (Step 8): what was handed over is REQUIRED — the receipt records it,
  // pay-in-full is measured against it, and any surplus comes from it. A check
  // or money order is identified by its amount as much as its number.
  amountTendered:   z.number().nonnegative(),
  // Cash over the bill: "Give $X change" or "Keep $X as credit — no change on
  // hand". No default (S637): a surplus with no answer is refused.
  surplusHandling:  z.enum(DESK_SURPLUS_HANDLING).optional(),
  // S655 (Nic, 10/2): the desk's answer to "credit available $X" — the usable
  // figure ("Use $X") or 0 ("Save"). Required when credit could pay part of
  // the bill; a figure that moved is a 409 and the window refetches.
  creditToUse:      z.number().nonnegative().optional(),
  // Money toward the old (carried-forward) balance, paid last and in any
  // amount. Cash: the desk says how much. A check's extra goes there first.
  towardOldBalance: z.number().nonnegative().optional(),
  // A check or money order over the bill: "is it really $X?" answered yes.
  confirmWrittenAmount: z.boolean().optional(),
  // S652 (Nic): one person, several leases, one balance. Always the household
  // now; kept so an older screen's flag is accepted.
  settleHousehold:  z.boolean().optional(),
  // 10/5 (Nic): a bank deposit is logged after the fact, from the bank's
  // receipt — the day the resident put the money in the bank (YYYY-MM-DD, not
  // after today). The payment counts from that day (its on-time or late mark),
  // never from the day the office typed it in. Bank deposits only; absent = today.
  depositedOn:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

/** 10/5: the property's own calendar day today (its timezone; America/Phoenix when unknown). */
async function propertyToday(propertyId: string | null | undefined): Promise<string> {
  const tz = propertyId
    ? (await queryOne<{ timezone: string | null }>(`SELECT timezone FROM properties WHERE id = $1`, [propertyId]))?.timezone
    : null
  return todayIn(tz)
}

/**
 * 10/5: a typed deposit date as the moment the payment counts from (noon UTC:
 * the same calendar day in every US zone). `today` is the PROPERTY's calendar
 * day (propertyToday) — never UTC's, which is already tomorrow on a US
 * evening and would let tomorrow's date through.
 */
function depositedOnAsSettledAt(method: string, depositedOn: string | undefined, today: string): Date | null {
  if (depositedOn == null) return null
  if (method !== 'bank_deposit') throw new AppError(422, 'A deposit date is taken only for a bank deposit.')
  const at = new Date(depositedOn + 'T12:00:00Z')
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== depositedOn) {
    throw new AppError(422, 'Enter the date deposited as a real date, from the bank\'s receipt.')
  }
  if (depositedOn > today) {
    throw new AppError(422, 'The date deposited cannot be after today.')
  }
  // Today's noon may not have come yet: a deposit made today counts from now.
  return at.getTime() > Date.now() ? null : at
}

paymentsRouter.post('/:id/record-manual', requirePerm('take_payment'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    const body = recordManualSchema.parse(req.body)
    // decisions.md #48.4: a card hold on this household that nobody confirmed
    // in time is released first, so the desk settles the bill as it really
    // stands (never refused over a hold that has run out) — only once the
    // caller may take payment on this charge. Before BEGIN: the release takes
    // the household lock on its own connection.
    const pre = await queryOne<{ tenant_id: string | null; landlord_id: string; property_id: string | null }>(
      `SELECT p.tenant_id, p.landlord_id, u.property_id
         FROM payments p LEFT JOIN units u ON u.id = p.unit_id WHERE p.id = $1`, [req.params.id])
    if (!pre) throw new AppError(404, 'Payment not found')
    if (!canManageLandlordResource(req.user, pre.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertChargeInStaffScope(req.user, pre.property_id)
    // 10/5 (Nic): a bank deposit's date cannot be after today where the property is.
    const depositedAt = body.depositedOn == null ? null
      : depositedOnAsSettledAt(body.method, body.depositedOn, await propertyToday(pre.property_id))
    if (pre.tenant_id) await releaseExpiredCardHolds(pre.tenant_id, 'record-manual', [pre.landlord_id])
    await client.query('BEGIN')

    // S655 lock order (§1.5): the household first, then the rows. The charge is
    // read once to learn whose household it is, then locked under that lock, so
    // a portal payment, a webhook or a second desk on the same household waits.
    const head = (await client.query<{ tenant_id: string | null; landlord_id: string; property_id: string | null }>(
      `SELECT p.tenant_id, p.landlord_id, u.property_id
         FROM payments p LEFT JOIN units u ON u.id = p.unit_id WHERE p.id = $1`, [req.params.id])).rows[0]
    if (!head) throw new AppError(404, 'Payment not found')
    if (!canManageLandlordResource(req.user, head.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    await assertChargeInStaffScope(req.user, head.property_id)
    if (head.tenant_id) await lockHousehold(client, head.tenant_id, head.landlord_id)
    const pmt = (await client.query<any>(
      `SELECT p.id, p.type, p.status, p.landlord_id, p.tenant_id, p.unit_id,
              p.lease_id, p.amount::float AS amount, p.due_date::text AS due_date,
              COALESCE(u.payment_block, FALSE) AS payment_block
         FROM payments p
         LEFT JOIN units u ON u.id = p.unit_id
        WHERE p.id = $1
          FOR UPDATE OF p`,
      [req.params.id])).rows[0]
    if (!pmt) throw new AppError(404, 'Payment not found')
    if (!canManageLandlordResource(req.user, pmt.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // S641 — TWO DIFFERENT THINGS, and only one of them is a manager's call.
    //
    // Nic: "Lisa should have all access to take payments in whatever form they
    // come, including giving change out at the register… or applying credit to
    // the next bill if that's what she wants. She cannot just issue random
    // credits that a landlord would issue for, you know, waiving a late fee."
    //
    // An overpayment surplus is money ALREADY IN THE DRAWER. The resident handed
    // over $500 against $460 and the desk records where the $40 went — change
    // back, or sitting on the account for next month. Recording that is part of
    // taking the payment, not an act of discretion, and take_payment covers it.
    //
    // A DISCRETIONARY credit — waiving a late fee, a goodwill adjustment —
    // creates money that was never received. That stays owner / property
    // manager, enforced on the tenant-credits route.
    //
    // I gated the surplus here first and was wrong: it read as "issuing credit"
    // because the word matched, and blocked a desk from recording the truth
    // about cash they were holding.
    // S649 (Nic): "we need to be able to settle any outstanding balances at any
    // time. If it's outstanding, we should be able to reconcile it." Jeremy
    // Parker's September electric ($96.81) came after his rent was already
    // paid, and with no open rent to anchor on it could not be recorded at all.
    // The payment settles the household's whole balance either way (S636), so
    // any open charge can carry it. A work-trade row is excluded: it is not owed
    // now, it settles against hours at month close.
    if ((await client.query(
      `SELECT 1 FROM payments WHERE id = $1 AND work_trade_suspended_at IS NOT NULL`, [pmt.id])).rows.length) {
      throw new AppError(409, 'This charge is covered by work trade and settles at month close')
    }
    if (pmt.status !== 'pending' && pmt.status !== 'failed') {
      // Worded after the household lock is let go: it may ask Stripe.
      await client.query('ROLLBACK')
      throw new AppError(409, await notOpenAtDeskText(pmt.id, pmt.status))
    }
    // Eviction pause (matches the tenant pay routes): accepting/booking landlord-
    // bound money can reset the eviction timeline, so recording is blocked too.
    if (pmt.payment_block) {
      throw new AppError(409, 'This unit is in eviction mode — recording a payment is paused. Contact the landlord.')
    }

    // S624: the settle itself lives in services/manualPaymentSettle.ts (one
    // home for the desk, the assistant, a posted payment and the bank match).
    // S655: the household's bank-payable balance, the credit choice, the old
    // balance, the surplus and the receipt are all decided there, under the
    // household lock, against figures read inside this transaction.
    const result = await settleManualRentPayment(client, {
      payment: pmt,
      method: body.method,
      settledAt: depositedAt,
      reference: body.reference ?? null,
      settleHousehold: true,
      amountTendered: body.amountTendered,
      surplusHandling: body.surplusHandling,
      creditToUse: body.creditToUse ?? null,
      towardOldBalance: body.towardOldBalance ?? null,
      confirmWrittenAmount: body.confirmWrittenAmount === true,
      takenBy: req.user!.userId,
      source: 'desk',
      // 10/5 (Nic): paid in full, late fees charged after the deposit come off.
      depositedOn: body.method === 'bank_deposit' ? (body.depositedOn ?? null) : null,
    })

    await client.query('COMMIT')

    // S637 (Nic): "Fix it so that people get an email confirmation of their
    // receipt." After the commit — a mail failure must never roll back a
    // payment that physically happened. Then, if money was kept as credit, the
    // whole-bill check (a credit that covers a whole bill pays it).
    await result.afterCommit()
    if (result.creditId && pmt.tenant_id) {
      await runWholeBillCheckAfterCommit({ tenantId: pmt.tenant_id, landlordId: pmt.landlord_id })
    }

    res.json({
      success: true,
      data: {
        paymentId:    pmt.id,
        status:       'settled',
        method:       body.method,
        settledPaymentIds: result.settledPaymentIds,
        // Money that landed on charges (the bill and any old balance).
        amountSettled: result.amountSettled,
        // S638: how much of the bill an account credit covered.
        creditUsed:   result.creditUsed,
        towardOldBalance: result.towardOldBalance,
        surplus:      result.surplus,
        changeGiven:  result.changeGiven,
        surplusHandling: result.surplus > 0 ? (result.creditId ? 'credit' : 'change') : null,
        creditId:     result.creditId,
        receiptId:    result.receiptId,
        // 10/5 (Nic): a part payment (the property takes them) — what is still
        // owed after it, and on which bills. 0 / [] when paid in full.
        partial:      result.stillOwed > 0,
        stillOwed:    result.stillOwed,
        stillOwedRows: result.stillOwedRows,
        // 10/5 (Nic): late fees charged after a bank deposit's date that came
        // off because it paid the bill in full (unbilled, and refunded as credit).
        lateFeesUnbilled: result.lateFeesReversed.unbilled,
        lateFeesRefunded: result.lateFeesReversed.refunded,
      },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

// GET /api/payments/:id/record-manual/quote — what the desk window shows for
// the household this charge belongs to (S655, money plan §3 desk row).
//
// The full balance, laid out the way the desk takes it: the current bill the
// desk settles (this company's charges, oldest first), the old balance (paid
// last, optional), GAM's own charges and another company's on the same bill
// as a "Pay online" line (so the window's total equals the portal's), anything
// paused by an eviction hold, money already clearing, and "credit available $X"
// beside the bill — with what is owed if the desk uses it or saves it. Read
// fresh every time the window opens and after any 409.
paymentsRouter.get('/:id/record-manual/quote', requirePerm('take_payment'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    const pmt = (await client.query<any>(
      `SELECT p.id, p.landlord_id, p.tenant_id, p.status, p.work_trade_suspended_at, u.payment_block, u.property_id
         FROM payments p LEFT JOIN units u ON u.id = p.unit_id WHERE p.id = $1`, [req.params.id])).rows[0]
    if (!pmt) throw new AppError(404, 'Payment not found')
    if (!canManageLandlordResource(req.user, pmt.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertChargeInStaffScope(req.user, pmt.property_id)
    if (!pmt.tenant_id) throw new AppError(409, 'This charge has no resident on it.')
    // decisions.md #48.4: a card hold that ran out is released before the
    // window reads the bill, so staff never see a stale hold as clearing.
    await releaseExpiredCardHolds(pmt.tenant_id, 'record-manual/quote', [pmt.landlord_id])
    // The charge itself may have been one the hold kept: read where it stands now.
    pmt.status = (await client.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [pmt.id])).rows[0]?.status ?? pmt.status
    // 10/5 (Nic): a bank deposit dated back (?depositedOn=YYYY-MM-DD): the
    // bill as the record will take it when the deposit pays it in full —
    // late fees charged after that day off (manualPaymentSettle
    // zeroLateFeesAfterDeposit), inside a transaction that is rolled back.
    const depositedOn = typeof req.query.depositedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.depositedOn)
      ? req.query.depositedOn : null
    if (depositedOn) depositedOnAsSettledAt('bank_deposit', depositedOn, await propertyToday(pmt.property_id))
    let lateFeesOffIfPaidInFull = 0
    // 10/5: the same, bill by bill — a bill a part payment pays only in part
    // keeps its own late fees (manualPaymentSettle judges each bill).
    const lateFeesOffByBill = new Map<string, number>()
    let q: Awaited<ReturnType<typeof deskQuote>>
    if (depositedOn) {
      await client.query('BEGIN')
      try {
        await lockHousehold(client, pmt.tenant_id, pmt.landlord_id)
        const q0 = await deskQuote(client, { tenantId: pmt.tenant_id, landlordId: pmt.landlord_id, lock: true })
        const z = await zeroLateFeesAfterDeposit(client, q0, depositedOn, { createdBy: null })
        lateFeesOffIfPaidInFull = z.unbilled
        for (const r of q0.rows) {
          if (!r.invoiceId || !z.zeroedIds.includes(r.id)) continue
          lateFeesOffByBill.set(r.invoiceId, Math.round(((lateFeesOffByBill.get(r.invoiceId) ?? 0) + r.amount) * 100) / 100)
        }
        q = z.zeroedIds.length > 0 ? await deskQuote(client, { tenantId: pmt.tenant_id, landlordId: pmt.landlord_id, lock: true }) : q0
      } finally {
        await client.query('ROLLBACK').catch(() => {})
      }
    } else {
      q = await deskQuote(client, { tenantId: pmt.tenant_id, landlordId: pmt.landlord_id })
    }
    // decisions.md #48.4: a card payment still waiting on its card's bank
    // (inside its 30 minutes) has charged nothing yet. Its rows are held, so
    // they stay inside `clearing` (the desk window shows that amount today);
    // `awaitingCard` says which part of `clearing` is such a payment — by who
    // made it and when the bill opens here by itself — so the window can say
    // so plainly. Asked of Stripe only when a card payment of this
    // household's is still processing.
    const awaitingCard = (await awaitingCardConfirmations(client, pmt.tenant_id))
      .filter(a => a.landlordId === pmt.landlord_id)
    const ids = [...q.rows, ...q.carried, ...q.payOnline, ...q.paused].map(r => r.id)
    const labels = ids.length ? await client.query<any>(
      `SELECT p.id, p.notes, u.unit_number, pr.name AS property_name
         FROM payments p LEFT JOIN units u ON u.id = p.unit_id LEFT JOIN properties pr ON pr.id = u.property_id
        WHERE p.id = ANY($1::uuid[])`, [ids]) : { rows: [] as any[] }
    const byId = new Map(labels.rows.map((r: any) => [r.id, r]))
    const show = (rs: typeof q.rows) => rs.map(r => ({
      id: r.id, leaseId: r.leaseId, invoiceId: r.invoiceId, type: r.type, entryDescription: r.entryDescription,
      amount: r.amount, dueDate: r.dueDate, creditAlreadyApplied: r.appliedCredit,
      // What "Use" would spend on this charge — so the window can say which
      // bill a part payment leaves owed.
      creditIfUsed: r.creditIfUsed,
      notes: byId.get(r.id)?.notes ?? null, unitNumber: byId.get(r.id)?.unit_number ?? null,
      propertyName: byId.get(r.id)?.property_name ?? null,
    }))
    res.json({ success: true, data: {
      anchorPaymentId: pmt.id,
      anchorOpen: (pmt.status === 'pending' || pmt.status === 'failed') && !pmt.work_trade_suspended_at,
      paymentsPaused: pmt.payment_block === true,
      rows: show(q.rows),
      currentTotal: q.currentTotal,
      oldBalance: show(q.carried),
      oldBalanceTotal: q.carriedTotal,
      payOnline: show(q.payOnline),
      payOnlineTotal: q.payOnlineTotal,
      paused: show(q.paused),
      pausedTotal: q.pausedTotal,
      clearing: q.inFlightTotal,
      // The part of `clearing` that is a card payment waiting on the card's
      // bank: nothing charged yet; the bill opens here by itself at confirmBy
      // if nobody confirms it (heldAmount is what it holds on these bills).
      awaitingCard: awaitingCard.map(a => ({
        amount: a.amount, heldAmount: a.heldOnLease, confirmBy: a.confirmBy, payerName: a.payerName,
        // The park's clock for "opens here at …"; null: the desk names its own zone.
        timezone: a.timezone,
      })),
      creditAlreadyApplied: q.creditAlreadyApplied,
      creditAvailable: q.usableCredit,
      // Credit a bank payment retrying on a bill the desk does not take (an
      // eviction hold, rent past a stay's end) still sets aside: not usable here.
      creditSetAsideElsewhere: q.creditSetAsideElsewhere,
      creditOnFile: q.creditOnFile,
      owedIfUsed: q.owedIfUsed,
      owedIfSaved: q.owedIfSaved,
      fullBalance: q.fullBalance,
      scheduledRetries: q.scheduledRetries.map(r => ({ nextRetryAt: r.nextRetryAt })),
      surplusOptions: DESK_SURPLUS_HANDLING.map(v => ({ value: v, label: DESK_SURPLUS_HANDLING_LABEL[v] })),
      // 10/5 (Nic): the property takes part payments — less than the bill may
      // be recorded (oldest bills first; what is left stays owed, late fees and all).
      partialPaymentsAllowed: q.partialAllowed,
      // 10/5 (Nic): with ?depositedOn=, the late fees charged after that day
      // that come off when the deposit pays this bill in full (0: none).
      lateFeesOffIfPaidInFull,
      lateFeesOffByBill: [...lateFeesOffByBill].map(([invoiceId, amount]) => ({ invoiceId, amount })),
    } })
  } catch (e) { next(e) } finally { client.release() }
})

// POST /api/payments/:id/record-prior-arrangement — S568 (Nic).
// Onboarding-transition ONLY: mark the FIRST rent charge of an IMPORTED lease as
// paid via a prior off-platform arrangement. It comes off the books and no money
// moves. Distinct from record-manual (a
// cash/check received now) — this is "already paid before they came onto GAM."
//
// Hard gating (all enforced here, no landlord toggle): rent charge, still open,
// lease_source='imported' (a brand-new GAM lease has no prior arrangement),
// within PRIOR_ARRANGEMENT_TRANSITION_DAYS of onboarding, and it must be the
// FIRST rent charge (no already-satisfied rent on the lease).
paymentsRouter.post('/:id/record-prior-arrangement', requirePerm('take_payment'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // S655 lock order (§1.5): the household first, then the row — a portal
    // payment, a webhook or the desk on the same household waits.
    const head = (await client.query<{ tenant_id: string | null; landlord_id: string; property_id: string | null }>(
      `SELECT p.tenant_id, p.landlord_id, u.property_id
         FROM payments p LEFT JOIN units u ON u.id = p.unit_id WHERE p.id = $1`, [req.params.id])).rows[0]
    if (!head) throw new AppError(404, 'Payment not found')
    if (!canManageLandlordResource(req.user, head.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    await assertChargeInStaffScope(req.user, head.property_id)
    if (head.tenant_id) await lockHousehold(client, head.tenant_id, head.landlord_id)

    const pmt = (await client.query<any>(
      `SELECT p.id, p.type, p.status, p.landlord_id, p.tenant_id, p.lease_id,
              p.stripe_payment_intent_id,
              p.due_date::text AS due_date, u.payment_block,
              (ld.reconciliation_until IS NOT NULL AND ld.reconciliation_until > NOW()) AS within_window
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         JOIN landlords ld ON ld.id = p.landlord_id
        WHERE p.id = $1
          FOR UPDATE OF p`,
      [req.params.id])).rows[0]
    if (!pmt) throw new AppError(404, 'Payment not found')
    if (pmt.type !== 'rent') {
      throw new AppError(409, 'Only a rent charge can be marked as a prior arrangement')
    }
    if (pmt.status !== 'pending' && pmt.status !== 'failed') {
      throw new AppError(409, `This charge is not open (status: ${pmt.status})`)
    }
    // S655: a payment already on its way for this charge is not overruled by
    // a note that it was paid before — wait for it to clear or fail.
    if (pmt.status === 'pending' && pmt.stripe_payment_intent_id) {
      throw new AppError(409, 'A payment for this charge is already on its way. Wait for it to clear or fail, then look again.')
    }
    if (pmt.payment_block) {
      throw new AppError(409, 'This unit is in eviction mode — recording a payment is paused.')
    }
    // Landlord onboarding reconciliation window only (old-system autopay overlap).
    // New-vs-imported is irrelevant; what matters is the landlord still migrating.
    if (!pmt.within_window) {
      throw new AppError(409, 'The onboarding reconciliation window has closed for this landlord — record payments normally.')
    }
    // First rent charge only — no already-satisfied rent on the lease.
    const priorPaid = (await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM payments
        WHERE lease_id = $1 AND type = 'rent'
          AND status IN ('settled', 'paid_via_deposit') AND id <> $2`,
      [pmt.lease_id, pmt.id])).rows[0]
    if (parseInt(priorPaid.n, 10) > 0) {
      throw new AppError(409, 'Prior-arrangement only applies to the first rent charge; a later rent charge has already been paid.')
    }

    // S655: a bank retry scheduled on this charge would pull money for rent
    // already paid — it is replaced (its held credit given back, its schedule
    // cleared, its pull canceled after commit).
    const superseded = await supersedeScheduledRetry(client, [pmt.id])

    // Satisfy the obligation off-platform. platform_held FALSE. Guarded: only a
    // charge still payable is taken.
    const done = await client.query(
      `UPDATE payments p
          SET status = 'settled', settled_at = NOW(), manual_method = $2,
              platform_held = FALSE, next_retry_at = NULL,
              notes = COALESCE(p.notes || ' — ', '') ||
                      'Paid off-platform via prior arrangement (onboarding transition)'
        WHERE p.id = $1 AND ${payableRowSql('p')}`,
      [pmt.id, PRIOR_ARRANGEMENT_METHOD])
    if ((done.rowCount ?? 0) !== 1) {
      throw new AppError(409, 'This charge changed while it was being marked. Nothing was recorded — look at it again.')
    }

    await client.query('COMMIT')
    await cancelSupersededIntents(superseded.cancelAfterCommit)
    res.json({
      success: true,
      data: { paymentId: pmt.id, status: 'settled', method: PRIOR_ARRANGEMENT_METHOD },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

// ── S654 (Nic): A CARD ON THE COUNTER READER, FOR A LEASE BALANCE ────────────
//
//   "It needs to be both. It's going to be for the point of sale, ringing up
//    propane transactions. It's also going to be somebody stops by to pay their
//    rent because maybe they couldn't log in online and they don't know how
//    much they owe."
//
// Four calls, same shape the register uses for a sale:
//   GET  /:id/reader/readers          — the readers paired at this charge's property
//   POST /:id/reader/charge           — quote the balance + card fee, create the
//                                       (held) intent, push it to the reader
//   GET  /reader/intents/:pi          — poll while the customer taps
//   POST /reader/intents/:pi/capture  — book it like an online card payment,
//                                       then capture; the webhook settles
//   POST /reader/intents/:pi/cancel   — the customer walked, or the desk changed its mind
//
// Money: the intent lands on GAM's Stripe balance and rides Tuesday's payout,
// exactly like Pay Now (2a). The card fee is the customer's at the same rate as
// online (3). Nothing is booked until the reader has approved the card — a
// decline or a walk-away leaves the ledger untouched.
import { holdForTheCart, createRentReaderPaymentIntent, processPaymentIntentOnReader, retrieveTerminalPaymentIntent, cancelTerminalPaymentIntent, showCartOnReader, cancelReaderAction, clearCartOnReader, readerAction } from '../services/posTerminal'
import { chargeLabel, chargeDetail, chargeLabelColumnsSql, type ChargeLabelRow } from '../services/invoiceNotice'

/** A charge's line on the reader: its name, then its detail (the meter read), kept short for the screen. */
function readerLineName(row: ChargeLabelRow): string {
  const label = chargeLabel(row)
  const detail = chargeDetail(row)
  const line = detail ? `${label} ${detail}` : label
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

async function readerAnchor(req: any, paymentId: string) {
  const pmt = await queryOne<any>(
    `SELECT p.id, p.landlord_id, p.tenant_id, p.lease_id, p.status, p.work_trade_suspended_at,
            u.property_id, inv.service_agreement_id
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       LEFT JOIN invoices inv ON inv.id = p.invoice_id
      WHERE p.id = $1`, [paymentId])
  if (!pmt) throw new AppError(404, 'Payment not found')
  if (!canManageLandlordResource(req.user, pmt.landlord_id)) throw new AppError(403, 'Forbidden')
  await assertChargeInStaffScope(req.user, pmt.property_id)
  if (!pmt.tenant_id) throw new AppError(409, 'This charge has no resident to take a card from')
  if (pmt.work_trade_suspended_at) throw new AppError(409, 'This charge is covered by work trade and settles at month close')
  // decisions.md #48.4: a card hold on this household that nobody confirmed in
  // time is released before the reader is quoted, sent or captured — the same
  // as the desk window — so the reader never asks for less than is owed over a
  // hold that has already run out. The charge itself may have been one the
  // hold kept: read where it stands now.
  await releaseExpiredCardHolds(pmt.tenant_id, 'reader', [pmt.landlord_id])
  pmt.status = (await queryOne<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [pmt.id]))?.status ?? pmt.status
  if (pmt.status === 'processing') throw new AppError(409, await notOpenAtDeskText(pmt.id, pmt.status))
  // Any other closed state: the desk screens put the status in plain words
  // (landlord lib/creditDesk plainRefusal).
  if (pmt.status !== 'pending' && pmt.status !== 'failed') throw new AppError(409, `This charge is not open (status: ${pmt.status})`)
  return pmt
}

paymentsRouter.get('/:id/reader/readers', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const pmt = await readerAnchor(req, req.params.id)
    const readers = await query<any>(
      `SELECT id, stripe_reader_id, nickname FROM pos_terminal_readers
        WHERE landlord_id = $1 AND property_id = $2 AND status = 'active'
        ORDER BY nickname`, [pmt.landlord_id, pmt.property_id])
    res.json({ success: true, data: readers })
  } catch (e) { next(e) }
})

// S655 (Nic, 10/2): the desk asks "Use $X credit or Save it?" BEFORE the
// amount goes to the reader, and may add "also pay $X toward the old balance"
// (carried arrears, paid last; anything beyond them becomes paid-ahead money
// GAM holds). The choice rides on the intent's metadata, so a resend and the
// capture re-quote exactly what the reader was sent.
const readerChoiceSchema = z.object({
  useCredit:        z.boolean().optional(),
  expectedCredit:   z.number().nonnegative().optional(),
  towardOldBalance: z.number().nonnegative().optional(),
})
type ReaderChoice = z.infer<typeof readerChoiceSchema>

function choiceFromIntent(pi: any): ReaderChoice {
  const m = pi?.metadata ?? {}
  return {
    useCredit: m.gam_use_credit === 'true' ? true : m.gam_use_credit === 'false' ? false : undefined,
    expectedCredit: m.gam_expected_credit != null && m.gam_expected_credit !== '' ? Number(m.gam_expected_credit) : undefined,
    towardOldBalance: m.gam_toward_old != null && m.gam_toward_old !== '' ? Number(m.gam_toward_old) : undefined,
  }
}

paymentsRouter.post('/:id/reader/charge', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const { stripeReaderId, cartOnReader, ...choice } = z.object({
      stripeReaderId: z.string().min(1), cartOnReader: z.boolean().optional(),
    }).merge(readerChoiceSchema).parse(req.body)
    const pmt = await readerAnchor(req, req.params.id)
    const reader = await queryOne<{ id: string }>(
      `SELECT id FROM pos_terminal_readers
        WHERE landlord_id = $1 AND stripe_reader_id = $2 AND status = 'active'`,
      [pmt.landlord_id, stripeReaderId])
    if (!reader) throw new AppError(404, 'That reader is not paired to this company')
    // The answer never travels without the credit figure the desk read out
    // (shelved 8): a credit that moved since is a 409 and the desk re-quotes.
    if (choice.useCredit != null && choice.expectedCredit == null) {
      throw new AppError(422, 'Send the credit figure the desk was shown (expectedCredit) with the answer to use or save it.')
    }

    const quote = await readerQuote(pmt, choice)
    if (quote.usableCredit > 0 && choice.useCredit == null) {
      throw new AppError(422,
        `This account has $${quote.usableCredit.toFixed(2)} of credit. Ask whether to use it or save it before sending the amount to the reader.`)
    }
    if (!(quote.total > 0)) {
      throw new AppError(409,
        'The credit covers this whole bill — nothing goes on a card. Record it in the payment window and use the credit there.')
    }
    const intent = await createRentReaderPaymentIntent({
      landlordId: pmt.landlord_id, propertyId: pmt.property_id, tenantId: pmt.tenant_id,
      anchorPaymentId: pmt.id,
      amountCents: Math.round(quote.total * 100),
      cardFeeCents: Math.round(quote.cardFee * 100),
    })
    // What the DESK asked for, exactly as the reader was priced: the capture
    // and a resend re-quote from these. The old-balance figure is the amount
    // asked for, not the part of it the carried rows took — anything beyond
    // the old balance is paid-ahead money, and dropping it here would make the
    // capture re-price lower than the reader was sent and refuse every time.
    await getStripe().paymentIntents.update(intent.id, { metadata: {
      gam_use_credit: choice.useCredit == null ? '' : String(choice.useCredit),
      gam_expected_credit: choice.useCredit == null || choice.expectedCredit == null ? '' : choice.expectedCredit.toFixed(2),
      gam_toward_old: choice.towardOldBalance != null && choice.towardOldBalance > 0 ? choice.towardOldBalance.toFixed(2) : '',
    } })
    await sendToReader(pmt, quote, intent.id, stripeReaderId, cartOnReader === true)
    res.status(201).json({ success: true, data: { paymentIntentId: intent.id, ...quote } })
  } catch (e) { next(e) }
})

// S654 (Nic): "it needs to be there the whole time … until the payment is
// processed." Stripe's pay screen shows the total only and Stripe sends no word
// of a tap on the breakdown, so the breakdown goes up as soon as the desk has
// the total — the resident taps on it — and Send finishes with that tap.
// Display only. `clear` takes the breakdown down (and only a breakdown); a
// reader mid-payment or asking someone a question is left alone.
paymentsRouter.post('/:id/reader/show', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const { stripeReaderId, clear, ...choice } = z.object({
      stripeReaderId: z.string().min(1), clear: z.boolean().optional(),
    }).merge(readerChoiceSchema).parse(req.body)
    const pmt = await readerAnchor(req, req.params.id)
    const reader = await queryOne<{ id: string }>(
      `SELECT id FROM pos_terminal_readers WHERE landlord_id = $1 AND stripe_reader_id = $2 AND status = 'active'`,
      [pmt.landlord_id, stripeReaderId])
    if (!reader) throw new AppError(404, 'That reader is not paired to this company')
    if (clear) return res.json({ success: true, data: { shown: false, cleared: await clearCartOnReader(stripeReaderId, `rent:${pmt.id}`) } })
    const quote = await readerQuote(pmt, choice)
    const action = await readerAction(stripeReaderId).catch(() => null)
    if (action && action.status === 'in_progress' && action.type !== 'set_reader_display') {
      return res.json({ success: true, data: { shown: false, busy: action.type } })
    }
    const shown = await showCartOnReader({ stripeReaderId, lines: await rentReaderLines(pmt, quote), taxCents: 0,
      totalCents: Math.round(quote.total * 100), owner: `rent:${pmt.id}` })
    res.json({ success: true, data: { shown: !!shown, total: quote.total } })
  } catch (e) { next(e) }
})

// S654 (Nic): "will it show somebody's name on this screen?" — the first line
// carries the resident and the space; then each charge by name; then the fee;
// then the reader asks for the card.
async function rentReaderLines(pmt: any, quote: Awaited<ReturnType<typeof readerQuote>>) {
  const who = await queryOne<{ first_name: string | null; last_name: string | null; unit_number: string | null }>(
    `SELECT u.first_name, u.last_name, un.unit_number
       FROM payments p JOIN tenants t ON t.id = p.tenant_id JOIN users u ON u.id = t.user_id JOIN units un ON un.id = p.unit_id
      WHERE p.id = $1`, [pmt.id])
  const name = who ? `${who.first_name ?? ''} ${who.last_name ?? ''}`.trim() : ''
  const lines = quote.lineItems.map((l, i) => i === 0 && name
    ? { ...l, description: `${l.description} — ${name}${who?.unit_number ? ` (${who.unit_number})` : ''}` }
    : l)
  if (quote.cardFee > 0) lines.push({ description: 'Card processing fee', amountCents: Math.round(quote.cardFee * 100), quantity: 1 })
  return lines
}
async function sendToReader(pmt: any, quote: Awaited<ReturnType<typeof readerQuote>>, paymentIntentId: string, stripeReaderId: string, cartOnReader = false) {
  const shown = await showCartOnReader({ stripeReaderId, lines: await rentReaderLines(pmt, quote), taxCents: 0,
    totalCents: Math.round(quote.total * 100), owner: `rent:${pmt.id}` })
  // A breakdown that has been up (POST /:id/reader/show) has had its tap; one
  // that was not — or that another flow had taken over — is held so the
  // resident reads it before the pay screen.
  if (!cartOnReader || shown === 'took_over') await holdForTheCart()
  await processPaymentIntentOnReader({ stripeReaderId, paymentIntentId })
}

// S654 (Nic): "I don't want it to void the charge… revert back so they can try
// again." A charge the reader timed out on, or a card it declined, is still
// open: clear the reader, and send the SAME charge again when they are back —
// provided the balance has not moved (a moved balance means start again).
paymentsRouter.post('/reader/intents/:pi/clear-reader', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const { stripeReaderId } = z.object({ stripeReaderId: z.string().min(1) }).parse(req.body)
    const pi = await ownReaderIntent(req, req.params.pi)
    const reader = await queryOne<{ id: string }>(
      `SELECT id FROM pos_terminal_readers WHERE landlord_id = $1 AND stripe_reader_id = $2 AND status = 'active'`,
      [pi.metadata?.gam_landlord_id, stripeReaderId])
    if (!reader) throw new AppError(404, 'That reader is not paired to this company')
    await cancelReaderAction(stripeReaderId)
    res.json({ success: true, data: { cleared: true } })
  } catch (e) { next(e) }
})

paymentsRouter.post('/reader/intents/:pi/resend', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const { stripeReaderId, cartOnReader } = z.object({ stripeReaderId: z.string().min(1), cartOnReader: z.boolean().optional() }).parse(req.body)
    const pi = await ownReaderIntent(req, req.params.pi)
    if (pi.status !== 'requires_payment_method') {
      throw new AppError(409, pi.status === 'requires_capture' || pi.status === 'succeeded'
        ? 'The card was already approved — record it.'
        : `This charge cannot be sent again (${pi.status}). Start again.`)
    }
    const pmt = await readerAnchor(req, String(pi.metadata?.gam_anchor_payment_id))
    const reader = await queryOne<{ id: string }>(
      `SELECT id FROM pos_terminal_readers WHERE landlord_id = $1 AND stripe_reader_id = $2 AND status = 'active'`,
      [pmt.landlord_id, stripeReaderId])
    if (!reader) throw new AppError(404, 'That reader is not paired to this company')
    const quote = await readerQuote(pmt, choiceFromIntent(pi))
    if (Math.round(quote.total * 100) !== pi.amount) {
      throw new AppError(409, 'The balance changed since this charge was created — start again.')
    }
    await sendToReader(pmt, quote, pi.id, stripeReaderId, cartOnReader === true)
    res.json({ success: true, data: { paymentIntentId: pi.id, ...quote } })
  } catch (e) { next(e) }
})

// S654: the figure the desk shows is the SERVER's — the same arithmetic that
// prices the online card payment and the property's fee rule — never a
// client-side recomputation. S655: the bill is shown in full with the usable
// credit beside it; the total follows the desk's Use / Save answer (Save until
// they answer) and any amount added toward the old balance.
async function readerQuote(pmt: any, choice: ReaderChoice = {}) {
  const run = (useCredit: boolean | undefined) => chargeLeaseBalance({
    tenantId: pmt.tenant_id,
    leaseId: pmt.lease_id ?? undefined,
    serviceAgreementId: pmt.lease_id ? undefined : (pmt.service_agreement_id ?? undefined),
    chargeEverything: true, dryRun: true,
    credit: useCredit == null ? null : { use: useCredit, expected: choice.expectedCredit ?? null },
    towardOldBalance: choice.towardOldBalance ?? null,
    paymentMethodType: 'card_present', source: 'front_desk_reader',
  })
  const q = await run(choice.useCredit)
  // S654 (Nic): the reader shows what the money is for — each charge by name,
  // at what the CARD pays on it. 10/3 (decisions #17): a utility line names
  // the utility from its bill ("Water", "Electric"), followed by the meter
  // read when there is one — never a generic "Utilities".
  const ids = (q.lines ?? []).map(l => l.payment_id)
  const rows = ids.length ? await query<ChargeLabelRow & { id: string }>(
    `SELECT p.id, p.type, p.notes, p.entry_description, ${chargeLabelColumnsSql('p')}
       FROM payments p WHERE p.id = ANY($1::uuid[])`, [ids]) : []
  const byId = new Map(rows.map(r => [r.id, r]))
  const lineItems = (q.lines ?? []).map(l => ({
    description: readerLineName(byId.get(l.payment_id) ?? { type: 'charge', notes: null }),
    amountCents: Math.round(l.amount_applied * 100), quantity: 1,
  }))
  const figures = (x: typeof q) => ({
    balance: Math.round((x.chargeAmount - x.processingFee) * 100) / 100,
    cardFee: x.processingFee,
    total: x.chargeAmount,
  })
  // Before the desk answers, both prices — "Use $X: card $Y" / "Save: card $Z".
  const both = q.usableCredit > 0 && choice.useCredit == null
    ? { ifUsed: figures(await run(true)), ifSaved: figures(q) } : {}
  return {
    // The whole bill, before any credit.
    outstanding: q.outstanding,
    usableCredit: q.usableCredit,
    needsCreditChoice: q.usableCredit > 0 && choice.useCredit == null,
    useCredit: q.creditUsed > 0,
    creditUsed: q.creditUsed,
    creditApplied: q.creditUsed,
    oldBalance: q.carriedTotal,
    towardOldBalance: q.towardOldBalance,
    paidAhead: q.payAhead,
    ...figures(q),
    ...both,
    lineItems,
  }
}

paymentsRouter.get('/:id/reader/quote', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const pmt = await readerAnchor(req, req.params.id)
    const q = req.query as Record<string, string | undefined>
    const choice = readerChoiceSchema.parse({
      useCredit: q.useCredit === 'true' ? true : q.useCredit === 'false' ? false : undefined,
      expectedCredit: q.expectedCredit != null && q.expectedCredit !== '' ? Number(q.expectedCredit) : undefined,
      towardOldBalance: q.towardOldBalance != null && q.towardOldBalance !== '' ? Number(q.towardOldBalance) : undefined,
    })
    res.json({ success: true, data: await readerQuote(pmt, choice) })
  } catch (e) { next(e) }
})

async function ownReaderIntent(req: any, paymentIntentId: string) {
  const pi = await retrieveTerminalPaymentIntent({ paymentIntentId })
  const purpose = pi.metadata?.gam_purpose
  if ((purpose !== 'rent_terminal_pending' && purpose !== 'rent_terminal')
      || !canManageLandlordResource(req.user, pi.metadata?.gam_landlord_id)) {
    throw new AppError(404, 'Card charge not found')
  }
  // A staffer assigned to one property handles only that property's reader
  // charges (the charge it was started from says where).
  const anchorId = String(pi.metadata?.gam_anchor_payment_id ?? '')
  const anchor = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(anchorId)
    ? await queryOne<{ property_id: string | null }>(
        `SELECT u.property_id FROM payments p LEFT JOIN units u ON u.id = p.unit_id WHERE p.id = $1`, [anchorId])
    : null
  await assertChargeInStaffScope(req.user, anchor?.property_id ?? null)
  return pi
}

paymentsRouter.get('/reader/intents/:pi', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const pi = await ownReaderIntent(req, req.params.pi)
    res.json({ success: true, data: {
      id: pi.id, status: pi.status, amount: pi.amount,
      lastPaymentError: pi.last_payment_error?.message ?? null,
    } })
  } catch (e) { next(e) }
})

/**
 * Why a capture was refused, in one sentence — the first sentence of the
 * charge path's refusal ("Your credit changed — it's now $50.00."), without
 * its own "nothing was charged / look again" tail, so the desk reads each
 * part once: the cause, then what happened to the hold, then the next step.
 */
function readerMovedCause(message: string): string {
  const first = (message.split(/(?<=[.!?])\s+/)[0] ?? message).trim()
  return /[.!?]$/.test(first) ? first : `${first}.`
}

paymentsRouter.post('/reader/intents/:pi/capture', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const pi = await ownReaderIntent(req, req.params.pi)
    // A double click, or a retried request: the first click booked and
    // captured this card. Say it is done — never book it twice, and never try
    // to release a hold that was already captured.
    const alreadyBooked = async (live: { status?: string } | null) => {
      const receipt = await queryOne<{ id: string }>(
        `SELECT id FROM tenant_remittances WHERE stripe_payment_intent_id = $1 ORDER BY created_at, id LIMIT 1`, [pi.id])
      if (!receipt && live?.status !== 'succeeded') return false
      res.json({ success: true, data: {
        paymentIntentId: pi.id, remittanceId: receipt?.id ?? null, status: 'succeeded', alreadyBooked: true,
      } })
      return true
    }
    if (await alreadyBooked(pi)) return
    if (pi.status !== 'requires_capture') {
      throw new AppError(409, pi.status === 'canceled' ? 'This charge was canceled' : 'The reader has not approved the card yet')
    }
    // Status, not the metadata label, decides: a 'rent_terminal' intent still at
    // requires_capture is a capture that failed and was rolled back — it may be
    // tried again or canceled, never treated as booked.
    //
    // Book it exactly as a portal card payment is booked — rows to processing,
    // remittance, credit set aside, the intent's metadata rewritten to the rent
    // shape — and capture inside that same transaction, so
    // payment_intent.succeeded settles the rows down the one path every card
    // payment takes and a failed capture leaves nothing behind. The credit
    // choice and the old-balance amount are the ones the reader was sent.
    const choice = choiceFromIntent(pi)
    let booked
    try {
      const pmt = await readerAnchor(req, String(pi.metadata?.gam_anchor_payment_id))
      booked = await chargeLeaseBalance({
        tenantId: pmt.tenant_id,
        leaseId: pmt.lease_id ?? undefined,
        serviceAgreementId: pmt.lease_id ? undefined : (pmt.service_agreement_id ?? undefined),
        chargeEverything: true,
        credit: choice.useCredit == null ? null : { use: choice.useCredit, expected: choice.expectedCredit ?? null },
        towardOldBalance: choice.towardOldBalance ?? null,
        paymentMethodType: 'card_present', source: 'front_desk_reader',
        existingIntent: { id: pi.id, amountCents: pi.amount, capture: true },
      })
    } catch (e) {
      if (e instanceof AppError && (e.statusCode === 409 || e.statusCode === 422)) {
        // A second click that waited behind the first (on the charge, or on
        // the household lock) finds it booked: done, not a moved balance.
        const live = await retrieveTerminalPaymentIntent({ paymentIntentId: pi.id }).catch(() => null)
        if (await alreadyBooked(live)) return
        // S655: the balance or the credit moved since the reader was sent the
        // amount. Nothing was booked; the hold on the card is released so the
        // resident is not left with money set aside, and the desk re-quotes.
        await cancelTerminalPaymentIntent({ paymentIntentId: pi.id }).catch((err) =>
          logger.warn({ err, paymentIntentId: pi.id }, '[reader] could not release a hold after a moved balance'))
        throw new AppError(409, `${readerMovedCause(e.message)} The hold on the card was released and nothing was charged — look at the balance again and start over.`)
      }
      throw e
    }
    res.json({ success: true, data: {
      paymentIntentId: pi.id, remittanceId: booked.remittanceId,
      total: booked.chargeAmount, cardFee: booked.processingFee, status: 'captured',
    } })
  } catch (e) { next(e) }
})

paymentsRouter.post('/reader/intents/:pi/cancel', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const pi = await ownReaderIntent(req, req.params.pi)
    if (pi.status === 'succeeded') throw new AppError(409, 'This charge is already booked')
    const bodyReaderId = typeof req.body?.stripeReaderId === 'string' ? req.body.stripeReaderId : null
    // Only a reader paired to the company this charge belongs to — a body-supplied
    // id is never trusted on its own.
    const reader = bodyReaderId ? await queryOne<{ stripe_reader_id: string }>(
      `SELECT stripe_reader_id FROM pos_terminal_readers
        WHERE landlord_id = $1 AND stripe_reader_id = $2 AND status = 'active'`,
      [pi.metadata?.gam_landlord_id, bodyReaderId]) : null
    if (reader) {
      // Clear the prompt off the reader's screen; the intent cancel below is
      // what matters for the money.
      await getStripe().terminal.readers.cancelAction(reader.stripe_reader_id).catch(() => {})
    }
    const canceled = pi.status === 'canceled' ? pi : await cancelTerminalPaymentIntent({ paymentIntentId: pi.id })
    res.json({ success: true, data: { paymentIntentId: canceled.id, status: canceled.status } })
  } catch (e) { next(e) }
})
