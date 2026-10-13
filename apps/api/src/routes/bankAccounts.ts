/**
 * S66: per-user bank account catalog — HISTORY ONLY since 10/12.
 *
 * This was the pre-Stripe-Connect payout catalog: an owner typed a routing and
 * account number here and assigned properties to it on the Properties page.
 * Payouts have run only through Stripe Connect since S561, so neither step
 * ever moved money. 10/12 (Nic): the add form and the per-property routing are
 * removed from the landlord portal and POST refuses new entries (see below).
 *
 * What stays, for the rows that already exist: GET lists the caller's rows,
 * PATCH renames one, archive retires one (soft — rows and the encrypted blob
 * persist forever for GAM audit). Account numbers are encrypted at rest
 * (lib/bankAccountCrypto); the UI only ever saw the last4.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { BankAccountSummary } from '@gam/shared'

export const bankAccountsRouter = Router()
bankAccountsRouter.use(requireAuth)

// Columns we'll always return — never include account_number_encrypted.
const SAFE_COLUMNS = `
  id, user_id, nickname, account_holder_name, account_holder_type,
  account_type, routing_number, account_number_last4, status,
  created_at, updated_at
`

bankAccountsRouter.get('/', async (req, res, next) => {
  try {
    const rows = await query<BankAccountSummary>(`
      SELECT ${SAFE_COLUMNS}
        FROM user_bank_accounts
       WHERE user_id = $1
       ORDER BY status ASC, created_at DESC
    `, [req.user!.userId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── 10/12 (Nic): "Remove the old form." NEW ENTRIES ARE REFUSED ─────────────
//
// This catalog predates Stripe Connect. Rent pays out ONLY through the Connect
// account a landlord verifies on the Disbursement Account page
// (jobs/autoPayouts.ts fires stripe.payouts.create against it and never reads
// this table), so a row added here never set up payouts and never reached
// Stripe at all — no verification, no microdeposits. It did, though, flip
// GAM's "bank account ready" checks to true.
//
// Country Acres' owner typed his First Mid checking account into this form on
// 10/5, saw it saved, and waited for microdeposits that could never come: his
// company had no Stripe account at all.
//
// So the form is gone from the landlord portal and this endpoint refuses new
// entries with the place payouts are actually set up. Existing rows stay
// (keep-everything): GET still lists them, archive still works, and the
// historical ledger joins still read them.
const REFUSAL = 'Payouts are set up with Stripe on the Disbursement Account page.'

bankAccountsRouter.post('/', async (_req, _res, next) => {
  next(new AppError(410, REFUSAL))
})

const patchSchema = z.object({
  nickname: z.string().min(1).max(80),
})

bankAccountsRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = patchSchema.parse(req.body)
    const row = await queryOne<BankAccountSummary>(`
      UPDATE user_bank_accounts
         SET nickname = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING ${SAFE_COLUMNS}
    `, [body.nickname.trim(), req.params.id, req.user!.userId])
    if (!row) throw new AppError(404, 'Bank account not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// Self-service: archives the CALLER's own bank account — not gated (see above).
bankAccountsRouter.post('/:id/archive', async (req, res, next) => {
  try {
    const row = await queryOne<BankAccountSummary>(`
      UPDATE user_bank_accounts
         SET status = 'archived', updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING ${SAFE_COLUMNS}
    `, [req.params.id, req.user!.userId])
    if (!row) throw new AppError(404, 'Bank account not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})
