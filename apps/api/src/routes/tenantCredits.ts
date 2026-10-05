import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'
import { TENANT_CREDIT_CATEGORIES } from '@gam/shared'
import { lockHousehold } from '../services/moneyPredicates'
import {
  createIssuedCredit, householdQuote, runWholeBillCheckAfterCommit,
} from '../services/creditUse'

// ============================================================
// S577 — Landlord-issued tenant account credits (Nic).
//
// A landlord issues a credit to a tenant for ANY reason (capped-state screening
// fee, late-fee refund, accidental overcharge, goodwill). Funded by the landlord
// — the tenant simply owes less, so the landlord receives less rent, and the
// credit is never counted as the landlord's income (payments.issued_credit_amount).
//
// S655 (Nic, 10/2): a credit pays a bill BY ITSELF only when it covers the
// whole bill. Issuing one runs that check the moment it is saved: a $460
// credit against a $460 bill pays it, nothing charged; a $300 credit against
// $1,000 settles nothing and sits on the account, and the tenant chooses at
// payment ("Use all $300" or "Save it for later"). Every spend is a record in
// the credit ledger (services/creditUse) — this file never touches a balance.
//
// Authority: the caller must manage the landlord that owns the lease
// (owner or scoped property manager). GAM never computes state caps — the
// landlord decides the amount.
// ============================================================

export const tenantCreditsRouter = Router()
tenantCreditsRouter.use(requireAuth)

const money = (n: number) => `$${n.toFixed(2)}`
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100)

// Resolve the lease + verify the caller has landlord authority over it, and find
// the primary tenant to attribute the credit to.
async function leaseForLandlord(leaseId: string, user: any) {
  const lease = await queryOne<any>(
    `SELECT l.id, l.landlord_id,
            (SELECT lt.tenant_id FROM lease_tenants lt
              WHERE lt.lease_id = l.id AND lt.status = 'active'
              ORDER BY (lt.role = 'primary') DESC, lt.added_at ASC NULLS LAST
              LIMIT 1) AS tenant_id
       FROM leases l WHERE l.id = $1`, [leaseId])
  if (!lease) throw new AppError(404, 'Lease not found')
  if (!canManageLandlordResource(user, lease.landlord_id, ['property_manager'])) {
    throw new AppError(403, 'Forbidden')
  }
  if (!lease.tenant_id) throw new AppError(400, 'This lease has no active tenant to credit')
  return lease
}

/**
 * The household's credit as the landlord's screens show it: every dollar of
 * credit on the account, and the part that could pay their open bill right
 * now (the same figure the desk and the tenant's Pay screen offer). Read-only.
 */
async function householdCredit(tenantId: string, landlordId: string): Promise<{ onAccount: number; usableNow: number }> {
  const client = await getClient()
  try {
    const q = await householdQuote(client, { tenantId, landlordId })
    return { onAccount: q.totals.creditOnFile, usableNow: q.totals.usableCredit }
  } finally {
    client.release()
  }
}

// POST /api/tenant-credits — issue a credit against a lease.
tenantCreditsRouter.post('/', async (req, res, next) => {
  try {
    const body = z.object({
      leaseId:  z.string().uuid(),
      amount:   z.number().positive().max(100000),
      category: z.enum(TENANT_CREDIT_CATEGORIES as unknown as [string, ...string[]]).default('other'),
      reason:   z.string().trim().max(500).optional().nullable(),
    }).parse(req.body)

    const lease = await leaseForLandlord(body.leaseId, req.user)

    // ── S638 (Nic, DIRECTIVE): ISSUING A CREDIT SPENDS NOTHING BY ITSELF ────
    //
    //   "The credit doesn't settle individual items. It takes just the total
    //    down. It's not separatable."
    //
    // This used to walk the open charges and close them one by one. Kim
    // Harland's $450 Move In Special was issued and instantly consumed a $10.45
    // water row, a $25 trash row and five $5 late fees — so her credit read
    // $389.55, her landlord saw settled charges no money arrived for, and she
    // was still asked for the full rent. The credit is created whole, under the
    // household lock (every writer of this household's money takes it), and
    // only the whole-bill rule — after the commit, in its own transaction —
    // may spend it.
    const client = await getClient()
    let creditId: string
    try {
      await client.query('BEGIN')
      await lockHousehold(client, lease.tenant_id, lease.landlord_id)
      creditId = await createIssuedCredit(client, {
        landlordId: lease.landlord_id, tenantId: lease.tenant_id, leaseId: lease.id,
        amount: body.amount, category: body.category, reason: body.reason ?? null,
        createdBy: req.user!.userId,
      })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
    finally { client.release() }

    // Decision 1 (Nic, 10/2): a credit that covers the whole bill pays it now,
    // nothing charged and no "$0 beside an open bill". Never throws: the
    // credit is already saved; a failure here only leaves the bill open.
    const wb = await runWholeBillCheckAfterCommit({ tenantId: lease.tenant_id, landlordId: lease.landlord_id })
    const paidCents = wb ? wb.leases.reduce((s, l) => s + cents(l.creditUsed), 0) : 0
    const paidBill = wb && wb.settledIds.length > 0
      ? { charges: wb.settledIds.length, creditUsed: paidCents / 100 }
      : null

    const row = await queryOne<any>(
      `SELECT id, amount_original, amount_remaining, category, reason, status, created_at
         FROM tenant_credits WHERE id = $1`, [creditId])
    const credit = await householdCredit(lease.tenant_id, lease.landlord_id)
    const message = paidBill
      ? `The credit paid the tenant's whole open bill (${money(paidBill.creditUsed)}). ${money(credit.onAccount)} of credit is left on their account.`
      : `The credit is on the tenant's account: ${money(credit.onAccount)} in all. It pays a bill by itself only when it covers the whole bill; until then the tenant can use it when they pay.`

    res.status(201).json({
      success: true,
      data: {
        ...row,
        paidBill,
        creditOnAccount: credit.onAccount,
        creditAvailable: credit.usableNow,
        message,
      },
    })
  } catch (e) { next(e) }
})

// GET /api/tenant-credits?leaseId=|tenantId= — list credits the caller can see.
tenantCreditsRouter.get('/', async (req, res, next) => {
  try {
    const leaseId  = typeof req.query.leaseId === 'string' ? req.query.leaseId : null
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : null
    if (!leaseId && !tenantId) throw new AppError(400, 'leaseId or tenantId is required')
    const uuid = z.string().uuid()
    if ((leaseId && !uuid.safeParse(leaseId).success) || (tenantId && !uuid.safeParse(tenantId).success)) {
      throw new AppError(400, 'leaseId and tenantId must be ids')
    }

    // Authority. A lease names its landlord: the caller must manage it.
    if (leaseId) {
      const l = await queryOne<{ landlord_id: string }>('SELECT landlord_id FROM leases WHERE id=$1', [leaseId])
      if (!l) throw new AppError(404, 'Lease not found')
      if (!canManageLandlordResource(req.user, l.landlord_id, ['property_manager'])) {
        throw new AppError(403, 'Forbidden')
      }
    }

    const rows = await query<any>(
      `SELECT tc.id, tc.landlord_id, tc.tenant_id, tc.lease_id, tc.amount_original, tc.amount_remaining,
              tc.category, tc.reason, tc.status, tc.created_at, tc.voided_at,
              -- What can still be spent. A void keeps its leftover recorded in
              -- amount_remaining (only the credit ledger moves that figure),
              -- but none of it can be used: a screen shows a void credit as
              -- "Voided" with nothing available, from this field.
              CASE WHEN tc.status = 'active' THEN tc.amount_remaining ELSE 0 END::numeric(10,2) AS amount_usable,
              (u.first_name || ' ' || u.last_name) AS tenant_name
         FROM tenant_credits tc
         JOIN tenants t ON t.id = tc.tenant_id
         JOIN users u ON u.id = t.user_id
        WHERE ($1::uuid IS NULL OR tc.lease_id = $1)
          AND ($2::uuid IS NULL OR tc.tenant_id = $2)
        ORDER BY tc.created_at DESC`,
      [leaseId, tenantId])
    // S655 (audience isolation): a tenant can hold credits with several
    // companies. By tenant, the caller sees only the credits of a company they
    // manage — never another landlord's (the check used to look at the newest
    // credit's landlord only, and skipped itself when that credit had no lease).
    const visible = rows
      .filter(r => canManageLandlordResource(req.user, r.landlord_id, ['property_manager']))
      .map(({ landlord_id: _landlord, ...r }) => r)
    res.json({ success: true, data: visible })
  } catch (e) { next(e) }
})

// POST /api/tenant-credits/:id/void — withdraw what is left of a credit.
//
// S655: a void is a status, not a spend. What was left stays recorded in
// amount_remaining (the credit ledger moves that figure, nothing else), and a
// void credit is out of every balance and can never be used. Refused while a
// payment still in flight has part of it set aside — that money is spoken for
// until the payment clears or fails.
tenantCreditsRouter.post('/:id/void', async (req, res, next) => {
  try {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new AppError(404, 'Credit not found')
    const credit = await queryOne<any>(
      'SELECT id, landlord_id, tenant_id, category FROM tenant_credits WHERE id=$1', [req.params.id])
    if (!credit) throw new AppError(404, 'Credit not found')
    if (!canManageLandlordResource(req.user, credit.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    // Statutory interest on the tenant's deposit is GAM's payment to the
    // tenant, not the landlord's gift: it is not the landlord's to take back.
    if (credit.category === 'deposit_interest') {
      throw new AppError(409, "This is interest on the tenant's security deposit, which they are owed by law, so it can't be voided.")
    }

    const client = await getClient()
    let left: number
    try {
      await client.query('BEGIN')
      await lockHousehold(client, credit.tenant_id, credit.landlord_id)
      // Fresh, under the lock: a payment may have used or held it since.
      const cur = (await client.query<{ status: string; amount_remaining: string }>(
        `SELECT status, amount_remaining::text FROM tenant_credits WHERE id = $1 FOR UPDATE`, [credit.id])).rows[0]
      if (cur.status === 'void') throw new AppError(400, 'This credit is already void.')
      const held = (await client.query<{ held: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS held FROM credit_uses
          WHERE tenant_credit_id = $1 AND status = 'held'`, [credit.id])).rows[0]
      if (cents(held.held) > 0) {
        throw new AppError(409,
          `${money(cents(held.held) / 100)} of this credit is set aside for a payment that is still going through, so it can't be voided yet. ` +
          'Try again once that payment clears or fails — a bank payment takes a few business days.')
      }
      await client.query(
        `UPDATE tenant_credits SET status = 'void', voided_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [credit.id])
      await client.query('COMMIT')
      left = cents(cur.amount_remaining) / 100
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
    finally { client.release() }

    res.json({
      success: true,
      data: {
        id: credit.id, status: 'void',
        message: left > 0
          ? `Voided. The ${money(left)} left on this credit can no longer be used.`
          : 'Voided. Nothing was left on this credit.',
      },
    })
  } catch (e) { next(e) }
})

// GET /api/tenant-credits/mine — tenant sees credits waiting on their account.
tenantCreditsRouter.get('/mine', async (req, res, next) => {
  try {
    const t = await queryOne<{ id: string }>('SELECT id FROM tenants WHERE user_id=$1 ORDER BY created_at LIMIT 1', [req.user!.userId])
    if (!t) return res.json({ success: true, data: [] })
    const rows = await query<any>(
      `SELECT id, amount_original, amount_remaining, category, reason, created_at
         FROM tenant_credits
        WHERE tenant_id=$1 AND status='active' AND amount_remaining > 0
        ORDER BY created_at ASC`, [t.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
