import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'
import { TENANT_CREDIT_CATEGORIES } from '@gam/shared'
import { lockHousehold } from '../services/moneyPredicates'
import {
  createIssuedCredit, householdQuote, runWholeBillCheckAfterCommit, undoIssuedCredit,
  CREDIT_UNDO_WINDOW_DAYS, creditUndoableSql,
} from '../services/creditUse'

// ============================================================
// S577 — Landlord-issued tenant account credits (Nic).
//
// A landlord issues a credit to a tenant for ANY reason (capped-state screening
// fee, late-fee refund, accidental overcharge, goodwill). Funded by the landlord
// — the tenant simply owes less, so the landlord receives less rent, and the
// credit is never counted as the landlord's income (payments.issued_credit_amount).
//
// S655 (Nic, 10/2): a credit that covers the whole bill pays it the moment it
// is saved — a $460 credit against a $460 bill, nothing charged.
//
// 10/15 (Nic): a credit that covers LESS no longer sits on the account either.
// "If somebody has an outstanding balance, why would they be able to add credit
// for future bills? Money gets applied to the most outstanding balance first.
// Somebody can't go put $1,000 credit and not pay a $2,000 existing bill." So a
// $300 credit against a $1,000 bill goes on that balance, oldest bill first,
// and only what is over the whole balance stays as credit. Issuing is still the
// landlord's call — he is choosing to give money away — but the box tells him
// what is owed first (GET /owed), so he is never issuing blind to a balance.
// Every spend is a record in the credit ledger (services/creditUse) — this file
// never touches a balance.
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

/**
 * GET /api/tenant-credits/owed?leaseId= — what the Issue-credit box says before
 * anything is given away (10/15, Nic: never issuing credit blind to a $2,000
 * balance). `householdOwed` is everything this person owes this company that a
 * credit may pay, across every space they hold (one person + one company = one
 * balance); `spaceOwed` is the part of it on this space.
 *
 * 10/18 (Nic), correcting what shipped: "if a person has two households, right,
 * two spaces, two bills for October, they can't pay one for October and then pay
 * that same one for November. It does need to go on the October bill for the
 * other spot." So the credit lands on the household's OLDEST bill first
 * whatever space it is on, and the box says so — it used to say a credit issued
 * here could not pay their other spaces, which is exactly what Nic reversed.
 *
 * Rent, utilities, late fees and fees only: a home payment, a GAM fee and a
 * deposit are never credit's to pay, so they are not counted.
 */
tenantCreditsRouter.get('/owed', async (req, res, next) => {
  try {
    const leaseId = typeof req.query.leaseId === 'string' ? req.query.leaseId : null
    if (!leaseId || !z.string().uuid().safeParse(leaseId).success) throw new AppError(400, 'leaseId is required')
    const lease = await leaseForLandlord(leaseId, req.user)

    const client = await getClient()
    try {
      const q = await householdQuote(client, { tenantId: lease.tenant_id, landlordId: lease.landlord_id })
      const owedOn = (ls: typeof q.leases) => ls.reduce((s, l) => s + l.rows
        .filter(r => r.required && r.creditEligible)
        .reduce((x, r) => x + cents(r.amount) - cents(r.appliedOnRow), 0), 0)
      const spaceOwed = Math.max(0, owedOn(q.leases.filter(l => l.leaseId === lease.id))) / 100
      const householdOwed = Math.max(0, owedOn(q.leases)) / 100
      const elsewhere = Math.max(0, Math.round((householdOwed - spaceOwed) * 100)) / 100
      const space = (await queryOne<{ unit_number: string | null }>(
        `SELECT un.unit_number FROM leases l LEFT JOIN units un ON un.id = l.unit_id WHERE l.id = $1`,
        [lease.id]))?.unit_number
      const who = space ? space : 'This space'
      // 10/18: one balance, oldest bill first, across every space — and the
      // landlord is told he can take the credit back if he types it wrong
      // (POST /:id/undo), which is now the honest answer to "what if I get
      // the amount wrong" (the 10/17 line told him a void takes back only the
      // leftover, which was true and useless).
      const undoSaid = ` Typed the wrong amount? You can undo the credit for ${CREDIT_UNDO_WINDOW_DAYS} days — what it paid goes back to owed.`
      const leftOver = ' Only what is over the whole balance stays on their account.'
      const message = (
        spaceOwed > 0 && elsewhere > 0
          ? `${who} still owes ${money(spaceOwed)}, and another ${money(elsewhere)} on their other spaces — `
            + `${money(householdOwed)} in all. A credit goes on the oldest bill first across every space, not just this one.`
            + leftOver
        : spaceOwed > 0
          ? `${who} still owes ${money(spaceOwed)}. A credit goes on that balance, oldest bill first.` + leftOver
        : elsewhere > 0
          ? `${who} owes nothing right now, but they owe ${money(elsewhere)} on their other spaces. `
            + 'A credit goes there instead — on their oldest bill first.' + leftOver
        : `${who} owes nothing right now, so the credit waits on their account for their next bill.`
      ) + undoSaid
      res.json({
        success: true,
        data: { spaceOwed, householdOwed, creditOnAccount: q.totals.creditOnFile, message },
      })
    } finally { client.release() }
  } catch (e) { next(e) }
})

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
    // only the one credit service — after the commit, in its own transaction —
    // may spend it: the whole bill if it covers it, else against the whole
    // balance oldest bill first (10/15), never line by line.
    const client = await getClient()
    let creditId: string
    try {
      await client.query('BEGIN')
      await lockHousehold(client, lease.tenant_id, lease.landlord_id)
      creditId = await createIssuedCredit(client, {
        landlordId: lease.landlord_id, tenantId: lease.tenant_id, leaseId: lease.id,
        amount: body.amount, category: body.category, reason: body.reason ?? null,
        createdBy: req.user!.userId,
        // The one box that gives a credit away by hand, and so the only credit
        // the landlord can take back (10/18 review fix: GAM's own credits —
        // a late fee cancelled or refunded, money paid ahead given back — are
        // not his to undo).
        issuedByLandlord: true,
      })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
    finally { client.release() }

    // Decision 1 (Nic, 10/2): a credit that covers the whole bill pays it now,
    // nothing charged and no "$0 beside an open bill". 10/15 (Nic): a credit
    // that covers less goes on the open balance oldest bill first instead of
    // waiting. Never throws: the credit is already saved; a failure here only
    // leaves the bill open.
    const wb = await runWholeBillCheckAfterCommit({ tenantId: lease.tenant_id, landlordId: lease.landlord_id })
    // Review fix (10/6): only a bill the whole-bill rule settled is "paid by the
    // credit". Credit going on part of the balance (the draw) is its own figure.
    const wholeBill = wb ? wb.leases.filter(l => l.kind === 'whole_bill' && l.settledIds.length > 0) : []
    const paidCents = wholeBill.reduce((s, l) => s + cents(l.creditUsed), 0)
    const paidBill = wholeBill.length > 0
      ? { charges: wholeBill.reduce((n, l) => n + l.settledIds.length, 0), creditUsed: paidCents / 100 }
      : null
    const drawnCents = wb ? wb.leases.filter(l => l.kind === 'balance_draw').reduce((s, l) => s + cents(l.creditUsed), 0) : 0

    const row = await queryOne<any>(
      `SELECT id, amount_original, amount_remaining, category, reason, status, created_at
         FROM tenant_credits WHERE id = $1`, [creditId])
    const credit = await householdCredit(lease.tenant_id, lease.landlord_id)
    // What of THIS credit went on the balance (the ledger moved its remaining
    // figure); the rest of the draw was credit already on the account.
    const spentCents = Math.max(0, cents(row?.amount_original) - cents(row?.amount_remaining))
    const otherCents = Math.max(0, drawnCents - spentCents)
    const otherSaid = otherCents > 0
      ? ` Credit already on their account also went on their balance (${money(otherCents / 100)}).` : ''
    const leftSaid = credit.onAccount > 0
      ? `${money(credit.onAccount)} of credit is left on their account.`
      : 'No credit is left on their account.'
    const message = (paidBill
      ? `The credit paid the tenant's whole open bill (${money(paidBill.creditUsed)}). ${leftSaid}`
      : spentCents > 0
        // 10/18 (Nic): oldest bill first across every space they hold, not
        // only the one the credit was issued on.
        ? `${money(spentCents / 100)} of the credit went on their open balance, oldest bill first. ${leftSaid}`
        : `The credit is on the tenant's account: ${money(credit.onAccount)} in all. They owe nothing it can pay right now, so it waits for their next bill.`)
      + otherSaid
      // 10/18: the way back from a wrong amount, said where he has just typed it.
      + ` Wrong amount? Undo it within ${CREDIT_UNDO_WINDOW_DAYS} days and what it paid goes back to owed.`

    res.status(201).json({
      success: true,
      data: {
        ...row,
        paidBill,
        /** 10/15: what of this credit went straight onto the open balance. */
        appliedToBalance: spentCents / 100,
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
              tc.category, tc.reason, tc.status, tc.created_at, tc.voided_at, tc.undone_at,
              -- 10/18: is the Undo offered on this credit? The cheap facts
              -- only — a live credit the LANDLORD typed himself, inside the
              -- window (creditUndoableSql, the same expression the undo itself
              -- checks, so the button and the action can never disagree).
              -- Whether real money has landed on a bill it paid is the undo's
              -- own answer, which names the bill (POST /:id/undo); asking it
              -- for every credit in a list would read every bill's money.
              ${creditUndoableSql('tc')} AS can_undo,
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

// POST /api/tenant-credits/:id/undo — take a credit back whole, including what
// it has already paid.
//
// 10/18 (Nic): "We need to undo credit, but no undoing payments that were
// actually real money handed over ... refunds of real money are only at the
// property setting by that individual landlord."
//
// Since 10/15 a credit lands on the open balance the moment it is issued, so a
// void takes back only the leftover — nothing, usually. This is the way back
// from a credit typed by mistake: every bill it settled is owed again, the
// credit is gone, and who did it and when are kept on it
// (services/creditUse undoIssuedCredit, which holds the household lock and
// refuses, in plain words, the moment real money is on one of those bills).
//
// WHO. The same authority as issuing it — the owner, or a property manager who
// manages that company. Never a bookkeeper (canManageLandlordResource never
// matches one: 10/12, Nic — "never tenant-account actions") and never the
// tenant.
tenantCreditsRouter.post('/:id/undo', async (req, res, next) => {
  try {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new AppError(404, 'Credit not found')
    const credit = await queryOne<any>(
      'SELECT id, landlord_id, tenant_id FROM tenant_credits WHERE id=$1', [req.params.id])
    if (!credit) throw new AppError(404, 'Credit not found')
    if (!canManageLandlordResource(req.user, credit.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }

    const client = await getClient()
    let undone: Awaited<ReturnType<typeof undoIssuedCredit>>
    try {
      await client.query('BEGIN')
      undone = await undoIssuedCredit(client, { creditId: credit.id, undoneBy: req.user!.userId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
    finally { client.release() }
    await undone.afterCommit()

    // The household's bills are open again, so credit still on their account
    // goes on them — the standing rule that credit never sits while they owe
    // (10/15). The credit just undone is void and can never be one of them.
    const wb = await runWholeBillCheckAfterCommit({ tenantId: undone.tenantId, landlordId: undone.landlordId })
    const sweptCents = wb ? wb.leases.reduce((t, l) => t + cents(l.creditUsed), 0) : 0

    // What it had paid is owed again — every bill it was on, and separately
    // whether any of them went from PAID back to owed (that is the part that
    // draws late fees again, so it is said in its own sentence).
    const backToOwed = undone.rows.filter(r => r.owedAgain)
    const owedSaid = undone.rows.length === 0
      ? 'It had not paid anything, so no bill changed.'
      : `${money(undone.takenBackFromBills)} it had paid is owed again (${undone.rows.map(r => r.what).join(', ')}).`
    const creditLeft = await householdCredit(undone.tenantId, undone.landlordId)
    const message = `The ${money(undone.amount)} credit is undone. ${owedSaid}`
      // Said plainly, because it is the part a landlord will not expect: GAM
      // does not backdate lateness away, and waiving a fee is his own call.
      + (backToOwed.length > 0 ? ' Those bills are late from their own due dates again, as if the credit had never been given.' : '')
      + (sweptCents > 0 ? ` Credit still on their account went on the open balance (${money(sweptCents / 100)}).` : '')
      + (creditLeft.onAccount > 0 ? ` ${money(creditLeft.onAccount)} of credit is left on their account.` : '')

    res.json({
      success: true,
      data: {
        id: undone.creditId, status: 'void',
        amount: undone.amount,
        /** What the credit had paid, now owed again. */
        takenBackFromBills: undone.takenBackFromBills,
        /** Every bill the credit had paid, in plain words; backToOwed: it went from paid to owed. */
        billsOwedAgain: undone.rows.map(r => ({ what: r.what, amount: r.amount, backToOwed: r.owedAgain })),
        creditOnAccount: creditLeft.onAccount,
        creditAvailable: creditLeft.usableNow,
        message,
      },
    })
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
    let spent = 0
    try {
      await client.query('BEGIN')
      await lockHousehold(client, credit.tenant_id, credit.landlord_id)
      // Fresh, under the lock: a payment may have used or held it since.
      const cur = (await client.query<{ status: string; amount_remaining: string; amount_original: string }>(
        `SELECT status, amount_remaining::text, amount_original::text FROM tenant_credits WHERE id = $1 FOR UPDATE`, [credit.id])).rows[0]
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
      spent = Math.max(0, cents(cur.amount_original) - cents(cur.amount_remaining)) / 100
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
    finally { client.release() }

    // Review fix (10/17): since 10/15 a credit goes on the open balance the
    // moment it is issued, so a void often finds nothing left — and "Nothing
    // was left on this credit" read as if the void had undone it. Say what the
    // credit already paid and that it stays paid.
    // 10/18: and point at the thing that DOES take it back — Undo, which puts
    // every bill it paid back to owed (POST /:id/undo). A void is now only for
    // taking the leftover off an account.
    const spentSaid = spent > 0
      ? ` ${money(spent)} of it had already gone on their open balance, and that stays paid. `
        + 'To take that back as well, undo the credit instead of voiding it.'
      : ''
    res.json({
      success: true,
      data: {
        id: credit.id, status: 'void',
        /** 10/17: what of it was already spent before the void (never taken back). */
        alreadyUsed: spent,
        message: (left > 0
          ? `Voided. The ${money(left)} left on this credit can no longer be used.`
          : spent > 0
            ? 'Voided, but there was nothing left to take back.'
            : 'Voided. Nothing was left on this credit.') + spentSaid,
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
