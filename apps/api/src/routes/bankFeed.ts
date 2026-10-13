// Bank feed (S570, Nic) — landlord links their operating bank (Stripe Financial
// Connections, transactions scope), GAM syncs + auto-matches GAM-known money, and
// the landlord categorizes the rest into the P&L. See services/bankFeed.ts.
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireLandlord, requirePerm, getScopedPropertyIds } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { MERCHANT_RULE_SCOPES, BANK_TXN_STATUSES, BANK_OUT_MATCH_KINDS, BANK_IN_MATCH_KINDS, EXPENSE_MATCH_MAX } from '@gam/shared'
import { companyWideRefusal, bookkeeperMayWrite, READ_ONLY_REFUSAL } from '../lib/bookkeeperScope'
import {
  moneyOutMatchesFor, matchLineToExpenses, matchLineToRecord, assertBookkeeperMayFileLine, assertBookkeeperMayFileTransfer,
  assertBookkeeperMayMarkNotRent,
} from '../services/bankMoneyOut'
import { queryOne } from '../db'
import { landlordScopeIds, resolveLandlordTarget } from '../lib/landlordScope'
import { logger } from '../lib/logger'
import { NOT_RENT_MARK } from '../services/bankDepositCandidates'
import {
  createLinkSession, finalizeConnection, syncConnection, listConnections,
  listTransactions, categorizeTransaction, ignoreTransaction, disconnectConnection,
  splitTransaction, undoSplit, SPLIT_MAX_PARTS, undoFiling, stopPayerAutoFiling,
} from '../services/bankFeed'

export const bankFeedRouter = Router()
bankFeedRouter.use(requireAuth)

/**
 * 10/12 (Nic, L19; design §11): bank lines are the owner's, and a
 * bookkeeper's with the bank — the company-wide box (10/12, ledger decision 2:
 * one level, so every such bookkeeper files). Money going out is open to them; money coming in only as the
 * owner chose for them (assertBookkeeperMayFileLine on each filing route).
 * Never a tenant's payment: confirming a deposit and a recorded deposit stay
 * the owner's (requireLandlord, and off the bookkeeper allowlist). 10/13 (Nic):
 * "Not rent" is the owner's and the bookkeeper's ("owner + bookkeeper (not
 * front-desk staff)") — requireBankFiler, on the bookkeeper allowlist; never a
 * bookkeeper the owner keeps away from money coming in (assertBookkeeperMayMarkNotRent).
 */
function bankGate(write: boolean) {
  return (req: any, res: any, next: any) => {
    const role = req.user?.role
    if (role === 'landlord' || role === 'admin' || role === 'super_admin') return next()
    if (role === 'bookkeeper') {
      if (!req.user.bookkeeperScope?.companyWide) {
        return res.status(403).json({ success: false, error: companyWideRefusal('The bank account') })
      }
      // 10/12 (Nic) review, SECURITY: THIS company's scope row, read live
      // (lib/bookkeeperScope), never the sign-in pass's value. 10/12 (Nic):
      // one level — refused only without a scope row on the company.
      if (write && !bookkeeperMayWrite(req.user.bookkeeperScope)) {
        return res.status(403).json({ success: false, error: READ_ONLY_REFUSAL })
      }
      return next()
    }
    return res.status(403).json({ success: false, error: 'Insufficient permissions' })
  }
}
const requireBankViewer = bankGate(false)
const requireBankFiler = bankGate(true)

// A landlord acts as themselves; landlord-scoped staff act on their landlord.
/**
 * S629 (Nic): "a property selector or entity selector, to view the transaction
 * logs and stuff specific to that entity."
 *
 * This used to be profileId and nothing else, so every bank page showed exactly
 * one entity's feed — the primary — no matter how many the landlord owned. With
 * banking anchored per entity (each LLC keeps its own account), that meant a
 * second entity's transactions were simply unreachable.
 *
 * ?entityId= selects one, and it is checked against the caller's own scope:
 * landlordScopeIds is refreshed from landlord_members on every request (see
 * middleware/auth), so an entity created moments ago resolves, and one that
 * belongs to somebody else does not.
 */
function scope(req: any, mustName = false): string {
  // ── S637: READ THE ENTITY FROM THE BODY TOO ─────────────────────────
  //
  // Nic: "When I select Mountain View or Oak Park from the banking page and
  // then click connect to bank, it still wants me to choose which one it
  // belongs to after I've already gone onto that entity's selection."
  //
  // This only ever looked at the QUERY STRING. The GET routes pass entityId
  // that way, so listing connections and transactions respected the picker —
  // but /link-session and /finalize are POSTs, and a POST carries its
  // arguments in the body. So the one action that actually links a bank threw
  // away the company the landlord had just chosen and asked again.
  //
  // bankReconciliation.ts has always read both. This is the same line.
  const fromQuery = typeof req.query?.entityId === 'string' ? req.query.entityId.trim() : ''
  const fromBody = typeof req.body?.entityId === 'string' ? req.body.entityId.trim() : ''
  const requested = fromQuery || fromBody
  if (requested) {
    if (!landlordScopeIds(req.user).includes(requested)) {
      throw new AppError(403, 'You are not a member of that entity')
    }
    return requested
  }
  // S633: no entity named — the account's only company, or a clear ask.
  return resolveLandlordTarget(req.user, undefined, mustName ? 'bank link' : 'record', mustName)
}

// S652 (Nic): "I select Mountain View, it shows the linked bank, and when I
// click sync it tells me I need to choose which business." A connection or a
// transaction already belongs to ONE company; an action on it never needs to
// be told which. Read the company off the row and check it is the caller's.
async function scopeFromRow(req: any, table: 'bank_connections' | 'bank_transactions', id: string): Promise<string> {
  const row = await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM ${table} WHERE id = $1`, [id])
  if (!row || !landlordScopeIds(req.user).includes(row.landlord_id)) {
    throw new AppError(404, table === 'bank_connections' ? 'Connection not found' : 'Transaction not found')
  }
  return row.landlord_id
}

// POST /api/bank-feed/link-session — start FC link; returns client secret.
bankFeedRouter.post('/link-session', requireLandlord, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await createLinkSession(scope(req, true)) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/finalize — after the FC modal, persist the linked accounts.
// S605: books start date — keep pre-onboarding history out of the review queue.
bankFeedRouter.put('/books-start-date', requireLandlord, async (req: any, res, next) => {
  try {
    const b = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    }).parse(req.body)
    const { setBooksStartDate } = await import('../services/bankFeed')
    res.json({ success: true, data: await setBooksStartDate(scope(req), b.date) })
  } catch (e: any) {
    // 10/13: a books start that would fall between a fixed asset and the loan
    // that paid for it is refused by the database (20261015190100) in words —
    // a 409 with those words, as Books Settings shows it, never a 500.
    if (e?.code === '23514' || e?.code === 'P0001') return next(new AppError(409, String(e.message || 'That books start is not allowed.')))
    next(e)
  }
})

bankFeedRouter.post('/finalize', requireLandlord, async (req: any, res, next) => {
  try {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(req.body)
    res.json({ success: true, data: await finalizeConnection(scope(req, true), sessionId) })
  } catch (e) { next(e) }
})

// GET /api/bank-feed/connections
bankFeedRouter.get('/connections', requireBankViewer, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await listConnections(scope(req)) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/connections/:id/sync
bankFeedRouter.post('/connections/:id/sync', requireLandlord, async (req: any, res, next) => {
  try {
    await scopeFromRow(req, 'bank_connections', req.params.id)
    const synced = await syncConnection(req.params.id)
    // S652 (Nic): Sync means "what does the bank say now" — transactions AND
    // the balance. Best-effort: a balance that will not come never blocks the
    // transactions that did.
    try {
      const { refreshBalance } = await import('../services/bankFeed')
      const conn = await queryOne<any>('SELECT * FROM bank_connections WHERE id = $1', [req.params.id])
      if (conn) await refreshBalance(conn)
    } catch (e) { logger.warn({ err: e, connectionId: req.params.id }, '[bank-feed] balance refresh on sync failed') }
    res.json({ success: true, data: synced })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/connections/:id/disconnect
// S655 (Step 12): refused for the last bank GAM can collect its fees from; when
// a debit-capable link goes and another stays, the debit moves to the one that stays.
bankFeedRouter.post('/connections/:id/disconnect', requireLandlord, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await disconnectConnection(await scopeFromRow(req, 'bank_connections', req.params.id), req.params.id) })
  } catch (e) { next(e) }
})

// GET /api/bank-feed/transactions?status=needs_review&connectionId=&limit=
bankFeedRouter.get('/transactions', requireBankViewer, async (req: any, res, next) => {
  try {
    const q = z.object({
      // S655: the shared list, not a re-declared copy of it.
      status: z.enum(BANK_TXN_STATUSES).optional(),
      connectionId: z.string().uuid().optional(),
      limit: z.coerce.number().int().positive().max(500).optional(),
      // 10/12: one line (the Expenses page links to the bank line an expense came from).
      lineId: z.string().uuid().optional(),
    }).parse(req.query)
    const rows = await listTransactions(scope(req), q)
    // 10/12 (Nic, L19): a bookkeeper reads the same lines with any email or
    // phone number on a memo taken out (routes/financials memoWithoutContact).
    if (req.user?.role === 'bookkeeper') {
      const { memoWithoutContact } = await import('./financials')
      for (const r of rows as any[]) {
        if (typeof r.description === 'string') r.description = memoWithoutContact(r.description)
        if (typeof r.normalized_merchant === 'string') r.normalized_merchant = memoWithoutContact(r.normalized_merchant)
      }
    }
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/categorize
bankFeedRouter.post('/transactions/:id/categorize', requireBankFiler, async (req: any, res, next) => {
  try {
    const body = z.object({
      // S605: accepts BOTH sides — the service picks by the transaction's sign
      // (expense categories for money out, income for money in) and rejects a
      // mismatch, so widening here can't file a deposit as 'repairs'.
      // 10/12 (Nic, L5): a company's own category (categoryId), or GAM's
      // starting key (category); the service checks it is the company's and
      // of the line's direction.
      category: z.string().max(60).default('other'),
      categoryId: z.string().uuid().nullable().optional(),
      scopeKind: z.enum(MERCHANT_RULE_SCOPES as unknown as [string, ...string[]]),
      unitId: z.string().uuid().nullable().optional(),
      propertyId: z.string().uuid().nullable().optional(),
      vendor: z.string().max(200).nullable().optional(),
      description: z.string().max(500).nullable().optional(),
      // 10/12 review (Nic L5, match first): "none of these" — money going out
      // that fits a record to the cent is refused (409 MATCH_FIRST) without it.
      notAMatch: z.boolean().optional(),
    }).parse(req.body)
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    await assertBookkeeperMayFileLine(req.user, landlordId, req.params.id)
    res.json({ success: true, data: await categorizeTransaction(landlordId, req.params.id, body as any) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/split — 10/12 (Nic): "categories are
// separate. if a deposit is multiple sources it should be split for record
// keeping." Files one bank line as parts, each with its own category and its
// own unit or property, adding up to the bank's amount to the cent. On a line
// already filed from the Bank page (as one category, or in parts) it replaces
// that filing; the old rows are voided, never deleted. Body { parts: [{
// category, amount, scopeKind, unitId | propertyId, description? }] }. The
// owner's, like filing (services/bankFeed splitTransaction). 10/12 (Nic): the
// reply carries payerQuestion for a deposit whose payer files itself (or
// would) — the page asks whether that payer should stop; yes is
// POST /transactions/:id/stop-auto-filing.
bankFeedRouter.post('/transactions/:id/split', requireBankFiler, async (req: any, res, next) => {
  try {
    const body = z.object({
      parts: z.array(z.object({
        // Both sides, as on categorize: the service picks the list by the
        // line's sign and refuses a part from the other one.
        // 10/12 (Nic, L5): or one of the company's own categories (categoryId).
        category: z.string().max(60).default('other'),
        categoryId: z.string().uuid().nullable().optional(),
        amount: z.number().positive().max(100_000_000),
        scopeKind: z.enum(MERCHANT_RULE_SCOPES as unknown as [string, ...string[]]),
        unitId: z.string().uuid().nullable().optional(),
        propertyId: z.string().uuid().nullable().optional(),
        description: z.string().max(500).nullable().optional(),
      })).max(SPLIT_MAX_PARTS),
      // 10/12 review (Nic L5, match first): as on categorize.
      notAMatch: z.boolean().optional(),
    }).parse(req.body)
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    await assertBookkeeperMayFileLine(req.user, landlordId, req.params.id)
    res.json({ success: true, data: await splitTransaction(landlordId, req.params.id, body.parts as any, { by: req.user.userId ?? null, notAMatch: body.notAMatch }) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/split/undo — 10/12 (Nic): the split's
// parts are voided (kept on file) and the line goes back to review.
bankFeedRouter.post('/transactions/:id/split/undo', requireBankFiler, async (req: any, res, next) => {
  try {
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    await assertBookkeeperMayFileLine(req.user, landlordId, req.params.id)
    res.json({ success: true, data: await undoSplit(landlordId, req.params.id, { undoneBy: req.user.userId ?? null }) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/undo-filing — 10/12 (Nic): "every
// bank filing (hand-filed too) can be undone (kept on record)." Takes back how
// a line is filed, whichever way: one category the owner picked, a filing the
// feed made by itself, a split, or the owner's Ignore. What it booked is voided
// (never deleted, stamped with the line) and the line goes back to review,
// never again filed by itself (services/bankFeed undoFiling). The owner's.
bankFeedRouter.post('/transactions/:id/undo-filing', requireBankFiler, async (req: any, res, next) => {
  try {
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    await assertBookkeeperMayFileLine(req.user, landlordId, req.params.id)
    // 10/12 review (L19): undoing a transfer releases the line it arrived as too.
    await assertBookkeeperMayFileTransfer(req.user, landlordId, req.params.id)
    res.json({ success: true, data: await undoFiling(landlordId, req.params.id, { undoneBy: req.user.userId ?? null }) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/stop-auto-filing — 10/12 (Nic): "after
// a split, ASK whether future deposits from that payer should stop filing
// automatically." The owner's yes: deposits from this line's payer stop filing
// themselves (services/bankFeed stopPayerAutoFiling). No body — the payer is
// the line's own, never a name sent in. A no needs no call.
bankFeedRouter.post('/transactions/:id/stop-auto-filing', requireLandlord, async (req: any, res, next) => {
  try {
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    res.json({ success: true, data: await stopPayerAutoFiling(landlordId, req.params.id) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/ignore
bankFeedRouter.post('/transactions/:id/ignore', requireBankFiler, async (req: any, res, next) => {
  try {
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    await assertBookkeeperMayFileLine(req.user, landlordId, req.params.id)
    res.json({ success: true, data: await ignoreTransaction(landlordId, req.params.id) })
  } catch (e) { next(e) }
})

// ── 10/12 (Nic, L5): money going out matches what is already on record ─────
//
// "money out = ONE record": a line going out is matched FIRST to what already
// has its record — one or several open expenses (a bill, a check written),
// GAM's fee debit, a register refund or a refund check, or a transfer to
// another of the company's linked accounts — and filed as a new expense only
// when nothing fits (categorize / split above). Undone like any filing
// (POST /transactions/:id/undo-filing). services/bankMoneyOut.

// GET /api/bank-feed/transactions/:id/matches — what this money-out line could be, in that order.
bankFeedRouter.get('/transactions/:id/matches', requireBankViewer, async (req: any, res, next) => {
  try {
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    const found = await moneyOutMatchesFor(landlordId, req.params.id)
    // 10/12 review (L19): a bookkeeper is offered only the transfers they may
    // file (the line arriving is money coming in, the owner's choice for them).
    if (req.user?.role === 'bookkeeper') {
      const allowed: typeof found.records = []
      for (const r of found.records) {
        if (r.kind !== 'transfer') { allowed.push(r); continue }
        try { await assertBookkeeperMayFileLine(req.user, landlordId, r.id); allowed.push(r) } catch { /* not theirs to file */ }
      }
      found.records = allowed
    }
    res.json({ success: true, data: found })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/match-expenses — { expenseIds?, paymentIds? }:
// the open expenses this line paid (each paid from it), and/or checks already
// recorded as written that it cleared. They add up to the line, except one
// expense the line paid only part of.
bankFeedRouter.post('/transactions/:id/match-expenses', requireBankFiler, async (req: any, res, next) => {
  try {
    const body = z.object({
      expenseIds: z.array(z.string().uuid()).max(EXPENSE_MATCH_MAX).optional(),
      paymentIds: z.array(z.string().uuid()).max(EXPENSE_MATCH_MAX).optional(),
    }).parse(req.body ?? {})
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    res.json({ success: true, data: await matchLineToExpenses({
      landlordId, lineId: req.params.id, expenseIds: body.expenseIds, paymentIds: body.paymentIds, by: req.user.userId ?? null,
    }) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/match-record — { kind, recordId }: GAM's
// fee debit, a register refund by check, a refund check, or a transfer (the
// line it arrived as). The same amount to the cent.
// 10/12 (Nic): or a loan (recordId = the loan) — money out as its payment
// ({ split } in cents: principal + interest + escrow = the line, else GAM's
// suggestion), money in as its money arriving. A bookkeeper matches money in
// only as the owner chose for them (Nic L19).
const splitCents = z.number().int().min(0)
bankFeedRouter.post('/transactions/:id/match-record', requireBankFiler, async (req: any, res, next) => {
  try {
    const body = z.object({
      kind: z.enum([...BANK_OUT_MATCH_KINDS.filter(k => k !== 'expenses'), ...BANK_IN_MATCH_KINDS] as string[] as [string, ...string[]]),
      recordId: z.string().uuid(),
      split: z.object({ principalCents: splitCents, interestCents: splitCents, escrowCents: splitCents }).nullish(),
    }).parse(req.body ?? {})
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    await assertBookkeeperMayFileLine(req.user, landlordId, req.params.id)
    // 10/12 review (L19): a transfer files the money arriving on the other
    // account too — under the owner's choice for this bookkeeper.
    if (body.kind === 'transfer') await assertBookkeeperMayFileTransfer(req.user, landlordId, req.params.id, body.recordId)
    await matchLineToRecord({
      landlordId, lineId: req.params.id, kind: body.kind as any, recordId: body.recordId, by: req.user.userId ?? null,
      split: body.split ?? null,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── S624: MATCHING A DEPOSIT TO THE RENT IT PAID ────────────────────────────
//
// The bank feed already auto-matched inbound deposits to GAM's own
// disbursements. It never matched the OTHER kind of inbound money: a tenant
// depositing their own rent at a branch. That gap is why a landlord running a
// property remotely had to reconstruct every cash payment by hand — find it,
// date it, waive the late fee it accrued in transit, mark the charges, and
// unwind the lot if a check bounced.

// GET /api/bank-feed/deposits/unmatched — the queue, each with its shortlist,
// and (setAside) the deposits the owner set aside as "Not a rent payment" that
// still wait on the Bank feed: the review shows each with its Undo for as long
// as it waits, so a reload or a deposit the assistant set aside never loses it.
bankFeedRouter.get('/deposits/unmatched', requireLandlord, async (req: any, res, next) => {
  try {
    const { unmatchedDepositsWithCandidates } = await import('../services/bankDepositCandidates')
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
    const out = await unmatchedDepositsWithCandidates(scope(req), limit)
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/deposits/:id/confirm — this deposit paid these charges.
//
// The landlord CONFIRMS; GAM never decides on its own from an amount alone. In
// a park where every lot pays the same rent, an amount identifies nobody, and a
// confident wrong answer books one tenant's money onto another's ledger and then
// onto their credit file. The only case that settles without a person is a
// tenant declaration corroborated by the bank — two independent signals, neither
// of them the landlord's guess (see the auto-settle path in the sync job).
bankFeedRouter.post('/deposits/:id/confirm', requireLandlord, async (req: any, res, next) => {
  try {
    const { z } = await import('zod')
    // 10/5: the form the money took when it went into the bank (cash, a check,
    // a money order) — a recorded "bank deposit" is not one of them.
    const { DEPOSITABLE_PAYMENT_METHODS } = await import('@gam/shared')
    const body = z.object({
      chargeIds: z.array(z.string().uuid()).min(1).max(20),
      method: z.enum(DEPOSITABLE_PAYMENT_METHODS),
      declarationId: z.string().uuid().nullish(),
    }).parse(req.body)

    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    // Scope check before anything else: the transaction must be this landlord's.
    // confirmDepositMatch re-checks charge ownership against the transaction, so
    // this is the outer of two gates rather than the only one.
    const owned = await queryOne<{ id: string }>(
      `SELECT id FROM bank_transactions WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, landlordId])
    if (!owned) throw new AppError(404, 'Deposit not found')

    const { confirmDepositMatch } = await import('../services/bankDepositConfirm')
    const result = await confirmDepositMatch({
      bankTransactionId: req.params.id,
      chargeIds: body.chargeIds,
      method: body.method,
      declarationId: body.declarationId ?? null,
      // S655: the user id is userId — `req.user.id` does not exist, so every
      // landlord's confirm was recorded as made by nobody.
      confirmedByUserId: req.user.userId,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/deposits/:id/recorded-deposit — 10/6 (Nic, "Yes, build
// it"): this bank line IS a deposit the office already logged by hand (Record
// payment / Post a payment, "Bank deposit"). Body { receiptId }. No money moves
// again — the line is tied to that receipt, and the bank's date decides: a late
// fee the bank shows was never owed comes off (its late-fee credit withdrawn),
// and the payment mark counts from the bank's day, on time if it was on time
// (services/recordedDepositMatch). Undo (POST /deposits/:id/undo) puts it back.
bankFeedRouter.post('/deposits/:id/recorded-deposit', requireLandlord, async (req: any, res, next) => {
  try {
    const { z } = await import('zod')
    const body = z.object({ receiptId: z.string().uuid() }).parse(req.body)
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    const owned = await queryOne<{ id: string }>(
      `SELECT id FROM bank_transactions WHERE id = $1 AND landlord_id = $2`, [req.params.id, landlordId])
    if (!owned) throw new AppError(404, 'Deposit not found')
    const { matchRecordedDeposit } = await import('../services/recordedDepositMatch')
    const result = await matchRecordedDeposit({
      bankTransactionId: req.params.id, receiptId: body.receiptId, confirmedByUserId: req.user.userId,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/deposits/:id/not-rent — it was not a tenant payment.
//
// Offering this explicitly matters: without it, a landlord facing a shortlist
// of tenants who did NOT pay this deposit has no honest way out except to pick
// one.
//
// What it does (fix pass 2 — it used to touch only updated_at, so the deposit
// came straight back on the match list with the same tenants offered):
//   - the deposit leaves the rent-matching queue for good
//     (bankDepositCandidates.unmatchedDepositsWithCandidates leaves out a row
//     carrying the person's "not rent" mark);
//   - GAM never settles, slips or files it by itself afterwards: the mark sits
//     in bank_transactions.auto_settle_undo, the column whose presence already
//     means "a person said no to the automatic steps" (services/bankFeed
//     RECONCILABLE_SQL leaves out any row that carries it). The mark is MERGED
//     into what is there (an earlier undone match keeps its record);
//   - the row stays 'needs_review', so it waits on the Bank feed with the other
//     transactions to file. No category is chosen for the owner: a transfer
//     between their own accounts and income are different things, and which
//     one it is, is theirs to say there (file it, or ignore it).
// Pressing it twice is harmless (the first mark stands).
//
// WHO — 10/13 (Nic): "Bank deposit 'Not rent': owner + bookkeeper (not
// front-desk staff)." The owner, and a bookkeeper with the bank (the
// company-wide box, requireBankFiler — the same door as filing a bank line).
// Never staff who take payments: the front desk makes the deposit slip, it
// does not say what a bank line was. The mark keeps who pressed it ('by').
// Nic L19: a bookkeeper the owner keeps away from money coming in ('never')
// does not make this call either (assertBookkeeperMayMarkNotRent).
bankFeedRouter.post('/deposits/:id/not-rent', requireBankFiler, async (req: any, res, next) => {
  try {
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    await assertBookkeeperMayMarkNotRent(req.user, landlordId)
    const row = await queryOne<{ id: string; amount: string; posted_date: string }>(
      `UPDATE bank_transactions
          SET auto_settle_undo = CASE
                WHEN COALESCE(auto_settle_undo, '{}'::jsonb) ? '${NOT_RENT_MARK}' THEN auto_settle_undo
                ELSE COALESCE(auto_settle_undo, '{}'::jsonb)
                     || jsonb_build_object('${NOT_RENT_MARK}', jsonb_build_object('at', now(), 'by', $3::text))
              END,
              updated_at = NOW()
        WHERE id = $1 AND landlord_id = $2 AND status = 'needs_review' AND amount > 0
        RETURNING id, amount::text AS amount, to_char(posted_date, 'YYYY-MM-DD') AS posted_date`,
      [req.params.id, landlordId, String(req.user.userId ?? '')])
    if (!row) {
      throw new AppError(409,
        'That deposit is no longer waiting to be matched: it was matched, filed or ignored meanwhile.')
    }
    res.json({ success: true, data: { id: row.id, amount: Number(row.amount), postedDate: row.posted_date, setAside: true } })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/deposits/:id/not-rent/undo — the one-button back-out:
// the deposit comes back on the rent-matching list exactly as it was (the
// mark is removed; anything else the column held stays). 10/13 (Nic): the
// owner's and a bookkeeper's with the bank, like the mark itself.
bankFeedRouter.post('/deposits/:id/not-rent/undo', requireBankFiler, async (req: any, res, next) => {
  try {
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    await assertBookkeeperMayMarkNotRent(req.user, landlordId)
    const row = await queryOne<{ id: string }>(
      `UPDATE bank_transactions
          SET auto_settle_undo = NULLIF(auto_settle_undo - '${NOT_RENT_MARK}', '{}'::jsonb),
              updated_at = NOW()
        WHERE id = $1 AND landlord_id = $2 AND status = 'needs_review'
          AND COALESCE(auto_settle_undo, '{}'::jsonb) ? '${NOT_RENT_MARK}'
        RETURNING id`, [req.params.id, landlordId])
    if (!row) {
      // Nothing matched: read why, so the answer is true. Another tab or person
      // pressed Undo first → the deposit is already back on the list, which is
      // what this person asked for (a 200, said plainly). Only a deposit that
      // left Needs review (filed or ignored on the Bank feed) is refused.
      const now = await queryOne<{ status: string; marked: boolean }>(
        `SELECT status, COALESCE(auto_settle_undo, '{}'::jsonb) ? '${NOT_RENT_MARK}' AS marked
           FROM bank_transactions WHERE id = $1 AND landlord_id = $2`, [req.params.id, landlordId])
      if (now && now.status === 'needs_review' && !now.marked) {
        res.json({ success: true, data: { id: req.params.id, alreadyBack: true } })
        return
      }
      throw new AppError(409, now?.status === 'matched'
        ? 'That deposit was matched on the Bank feed meanwhile, so it cannot come back to this list.'
        : 'That deposit was already filed or ignored on the Bank feed, so it cannot come back to this list.')
    }
    res.json({ success: true, data: { id: row.id, alreadyBack: false } })
  } catch (e) { next(e) }
})

// GET /api/bank-feed/cash-position — did the office bank what it collected?
//
// S624 (Nic): the on-site "double verification". Rents marked collected in
// person with no bank deposit accounting for them, oldest first, with names.
bankFeedRouter.get('/cash-position', requireLandlord, async (req: any, res, next) => {
  try {
    const { cashBankingPosition } = await import('../services/cashBankingControl')
    const graceDays = req.query.graceDays != null
      ? Math.min(30, Math.max(0, Number(req.query.graceDays))) : undefined
    const data = await cashBankingPosition(scope(req), { graceDays })
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

// ── S655 (money plan Step 12, K-B / K-C / K-D) ──────────────────────────────
//
// "Make a bank deposit" is a FRONT DESK job (Nic 10/2: "staff tick what went in
// the bag"), so the slip routes are open to staff who may take a payment
// (take_payment, the same permission that records cash), scoped to their own
// properties. Undoing a match and undoing a filing are the owner's (the bank
// feed is the owner's page).

/** A staffer's properties (null = every property). */
async function staffScope(req: any): Promise<string[] | null> {
  return getScopedPropertyIds(req.user)
}

// GET /api/bank-feed/deposits/undeposited — cash, checks and money orders taken
// and not yet in the bank, split into "on a slip" and "not on any slip".
bankFeedRouter.get('/deposits/undeposited', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const landlordId = scope(req)
    const { cashNotBanked } = await import('../services/depositSlips')
    const { db } = await import('../db')
    const items = await cashNotBanked(db, landlordId, { includeOnSlip: true, propertyIds: await staffScope(req) })
    const cents = (n: number) => Math.round(n * 100)
    const sum = (xs: typeof items) => xs.reduce((s, i) => s + cents(i.amount), 0) / 100
    const onSlip = items.filter(i => i.slipId)
    const notOnSlip = items.filter(i => !i.slipId)
    res.json({ success: true, data: {
      notOnSlip: notOnSlip.map(({ amountCents: _c, ...i }) => i),
      onSlip: onSlip.map(({ amountCents: _c, ...i }) => i),
      notOnSlipTotal: sum(notOnSlip),
      onSlipTotal: sum(onSlip),
    } })
  } catch (e) { next(e) }
})

/**
 * decisions.md #48.1 in SQL: TRANSFER or XFER as a word of its own (no letter
 * either side), on the upper-cased memo — what memoSaysTransfer
 * (services/bankDepositMatch) finds by splitting the memo on non-letters.
 */
const TRANSFER_MEMO_PATTERN = '(^|[^A-Z])(TRANSFER|XFER)([^A-Z]|$)'

// GET /api/bank-feed/deposit-slips — open slips (flagged when the bank has not
// shown them in 5 business days) and the last 45 days of the rest. For the
// owner, also the bank deposits still waiting that may be the office's cash,
// each with GAM's closest proposal.
bankFeedRouter.get('/deposit-slips', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const landlordId = scope(req)
    const { listSlips, cashProposalFor, openSlipsFitting } = await import('../services/depositSlips')
    const { db, query } = await import('../db')
    const { namesAPayer, normalizeMerchant } = await import('../services/bankFeed')
    const { memoSaysTransfer } = await import('../services/bankDepositMatch')
    const propertyIds = await staffScope(req)
    const slips = await listSlips(landlordId, { propertyIds })
    let waiting: any[] = []
    // The bank's own rows are the owner's (the Bank page is owner-only): a
    // staffer with every property still never sees bank deposits here.
    if (['landlord', 'admin', 'super_admin'].includes(req.user.role)) {
      // decisions.md #48.1: a memo that says TRANSFER/XFER is money moved
      // between accounts — never the office's cash and never a deposit slip.
      // It is not offered here at all (no proposal, no fitting slip); it waits
      // on the Bank page with the other transactions to file. Left out IN SQL,
      // before the limit (the pattern mirrors memoSaysTransfer: the word on its
      // own, not inside another word), so a run of newer transfers never pushes
      // an older office-cash deposit off this list. Rows that name a payer and
      // fit no slip are dropped below, so more rows are read than are shown and
      // the list stops once WAITING_SHOWN have been kept.
      const WAITING_SHOWN = 20
      const rows = await query<any>(
        `SELECT id, amount::float AS amount, to_char(posted_date, 'YYYY-MM-DD') AS posted_date, description
           FROM bank_transactions
          WHERE landlord_id = $1 AND status = 'needs_review' AND amount > 0
            AND COALESCE(bank_status, 'posted') = 'posted'
            AND posted_date >= CURRENT_DATE - 45
            AND upper(COALESCE(description, '')) !~ $2
            AND upper(COALESCE(normalized_merchant, '')) !~ $2
          ORDER BY posted_date DESC, id LIMIT 100`, [landlordId, TRANSFER_MEMO_PATTERN])
      for (const r of rows) {
        if (waiting.length >= WAITING_SHOWN) break
        // The same rule in code, for any memo the pattern and the word split read differently.
        if (memoSaysTransfer(r.description)) continue
        // An open slip of exactly this amount, in its window — the person picks
        // when more than one fits or a tenant's report competes with it.
        const fitting = (await openSlipsFitting(db, landlordId, r)).map(f => f.id)
        const p = namesAPayer(normalizeMerchant(r.description)) ? null : await cashProposalFor(db, landlordId, r)
        if ((!p || p.kind === 'none') && fitting.length === 0) continue
        waiting.push({
          transactionId: r.id, amount: r.amount, postedDate: r.posted_date, description: r.description,
          fittingSlipIds: fitting,
          proposal: p && p.kind !== 'none'
            ? { kind: p.kind, note: p.note, total: p.totalCents / 100, items: p.items.map(({ amountCents: _c, ...i }) => i) }
            : null,
        })
      }
    }
    res.json({ success: true, data: { slips, waiting } })
  } catch (e) { next(e) }
})

/**
 * decisions.md #48.1: a bank memo that says TRANSFER/XFER ("ONLINE TRANSFER
 * FROM CHK 1234") is money moved between accounts. It is never the office's
 * cash, so neither slip route may make it a slip's bank deposit — the owner
 * files it with the other bank transactions instead. (The sync's own matching
 * already refuses it: services/bankFeed.ts.)
 */
async function refuseTransferMemo(bankTransactionId: string): Promise<void> {
  const { memoSaysTransfer } = await import('../services/bankDepositMatch')
  const row = await queryOne<{ description: string | null; normalized_merchant: string | null }>(
    `SELECT description, normalized_merchant FROM bank_transactions WHERE id = $1`, [bankTransactionId])
  if (row && (memoSaysTransfer(row.description) || memoSaysTransfer(row.normalized_merchant))) {
    throw new AppError(409,
      'That bank deposit is a transfer between accounts, not the office\u2019s cash, so it cannot be matched to a deposit slip. File it with the other bank transactions on the Bank page.')
  }
}

// POST /api/bank-feed/deposit-slips — make a slip: what went into the bag.
bankFeedRouter.post('/deposit-slips', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    const body = z.object({
      depositDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      receiptIds: z.array(z.string().uuid()).max(200).default([]),
      registerSaleIds: z.array(z.string().uuid()).max(200).default([]),
      otherAmount: z.number().min(0).max(1_000_000).default(0),
      otherNote: z.string().max(300).nullish(),
      otherIsNotRent: z.boolean().optional(),
      expectedTotal: z.number().nullish(),
      // Accepting GAM's proposal for a bank deposit already in (owner only).
      bankTransactionId: z.string().uuid().nullish(),
    }).parse(req.body)
    const landlordId = scope(req)
    const propertyIds = await staffScope(req)
    if (body.bankTransactionId) {
      if (!['landlord', 'admin', 'super_admin'].includes(req.user.role)) {
        throw new AppError(403, 'Only the owner can match a slip to a bank deposit.')
      }
      await scopeFromRow(req, 'bank_transactions', body.bankTransactionId)
      await refuseTransferMemo(body.bankTransactionId)
    }
    const { createSlip } = await import('../services/depositSlips')
    const slip = await createSlip({
      landlordId, depositDate: body.depositDate,
      receiptIds: body.receiptIds, registerSaleIds: body.registerSaleIds,
      otherAmount: body.otherAmount, otherNote: body.otherNote ?? null, otherIsNotRent: body.otherIsNotRent,
      expectedTotal: body.expectedTotal ?? null, bankTransactionId: body.bankTransactionId ?? null,
      createdBy: req.user.userId, propertyIds,
    })
    res.json({ success: true, data: slip })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/deposit-slips/:id/void — the bag did not go (or went
// with something else): its receipts are free for another slip.
bankFeedRouter.post('/deposit-slips/:id/void', requirePerm('take_payment'), async (req: any, res, next) => {
  try {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new AppError(404, 'That deposit slip was not found.')
    const { queryOne } = await import('../db')
    const row = await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM bank_deposit_slips WHERE id = $1`, [req.params.id])
    if (!row || !landlordScopeIds(req.user).includes(row.landlord_id)) throw new AppError(404, 'That deposit slip was not found.')
    const { voidSlip } = await import('../services/depositSlips')
    res.json({ success: true, data: await voidSlip(row.landlord_id, req.params.id, req.user.userId, await staffScope(req)) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/deposit-slips/:id/match — the owner says this open slip IS
// this bank deposit (two slips fit, a tenant's report competes, or a match
// that was undone is redone). Same total, untouched deposit.
bankFeedRouter.post('/deposit-slips/:id/match', requireLandlord, async (req: any, res, next) => {
  try {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new AppError(404, 'That deposit slip was not found.')
    const { bankTransactionId } = z.object({ bankTransactionId: z.string().uuid() }).parse(req.body)
    const landlordId = await scopeFromRow(req, 'bank_transactions', bankTransactionId)
    await refuseTransferMemo(bankTransactionId)
    const { matchSlipByHand } = await import('../services/depositSlips')
    res.json({ success: true, data: await matchSlipByHand(landlordId, req.params.id, bankTransactionId, req.user.userId) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/deposits/:id/undo — take a deposit's match back exactly
// (a tenant deposit a person confirmed or the feed applied by itself, or a
// deposit slip). Refused when anything changed since.
bankFeedRouter.post('/deposits/:id/undo', requireLandlord, async (req: any, res, next) => {
  try {
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    const { undoDepositMatch } = await import('../services/bankDepositConfirm')
    res.json({ success: true, data: await undoDepositMatch({
      bankTransactionId: req.params.id, landlordId, undoneBy: req.user.userId,
    }) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/undo-auto-file — a deposit that filed
// itself as income goes back to review; optionally stop that payer filing itself.
bankFeedRouter.post('/transactions/:id/undo-auto-file', requireLandlord, async (req: any, res, next) => {
  try {
    const body = z.object({ stopAutoFiling: z.boolean().default(false) }).parse(req.body ?? {})
    const landlordId = await scopeFromRow(req, 'bank_transactions', req.params.id)
    const { undoAutoFile } = await import('../services/bankFeed')
    res.json({ success: true, data: await undoAutoFile(landlordId, req.params.id, {
      stopAutoFiling: body.stopAutoFiling, undoneBy: req.user.userId,
    }) })
  } catch (e) { next(e) }
})
