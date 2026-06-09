/**
 * S66: per-user bank account catalog.
 *
 * Owner workflow: add accounts here, then assign each property to one of
 * them on the Properties page. Multiple properties can share one account
 * (LLC consolidation) — they collapse into a single Friday disbursement.
 *
 * Mutation surface is intentionally narrow: routing/account numbers are
 * immutable once written (a number change = add new + archive old). Edit
 * exposes nickname only. Delete is soft (`status='archived'`) — rows and
 * the encrypted blob persist forever for GAM audit.
 *
 * Account numbers are encrypted at rest (lib/bankAccountCrypto). UI only
 * ever sees the last4; the full number is decrypted server-side at payout
 * fire time and via the super_admin reveal flow (separate route).
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { validateAbaRoutingNumber } from '../lib/banking'
import { encryptBankAccountNumber, last4 } from '../lib/bankAccountCrypto'
import {
  ACCOUNT_TYPE_VALUES,
  ACCOUNT_HOLDER_TYPE_VALUES,
  BankAccountSummary,
} from '@gam/shared'

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

const createSchema = z.object({
  nickname: z.string().min(1).max(80),
  accountHolderName: z.string().min(1).max(120),
  accountHolderType: z.enum(ACCOUNT_HOLDER_TYPE_VALUES),
  accountType: z.enum(ACCOUNT_TYPE_VALUES),
  routingNumber: z.string(),
  accountNumber: z.string(),
})

bankAccountsRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body)

    const routing = body.routingNumber.replace(/\D/g, '')
    const aba = validateAbaRoutingNumber(routing)
    if (!aba.ok) {
      throw new AppError(400, `Invalid routing number (${aba.reason})`)
    }

    const acctRaw = body.accountNumber.replace(/\D/g, '')
    if (acctRaw.length < 4 || acctRaw.length > 17) {
      throw new AppError(400, 'Account number must be 4–17 digits')
    }

    const encrypted = encryptBankAccountNumber(acctRaw)
    const acctLast4 = last4(acctRaw)

    const row = await queryOne<BankAccountSummary>(`
      INSERT INTO user_bank_accounts
        (user_id, nickname, account_holder_name, account_holder_type,
         account_type, routing_number, account_number_last4, account_number_encrypted)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING ${SAFE_COLUMNS}
    `, [
      req.user!.userId,
      body.nickname.trim(),
      body.accountHolderName.trim(),
      body.accountHolderType,
      body.accountType,
      routing,
      acctLast4,
      encrypted,
    ])
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
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
