/**
 * S66: super_admin bank-account oversight (read-only).
 *
 * Two surfaces:
 *   GET  /api/admin/users/:userId/bank-accounts
 *     List one user's accounts (last4 only).
 *   POST /api/admin/bank-accounts/:id/reveal
 *     Decrypt + return the full account number. Writes an audit_log row
 *     with action='super_admin_bank_reveal'.
 *
 * Intentionally no edit / archive endpoints. The owner is the only party
 * who can mutate their own catalog. super_admin reveal exists for support
 * triage and disbursement-failure investigation, with audit attribution.
 */

import { Router } from 'express'
import { query, queryOne } from '../../db'
import { requireAuth, requireSuperAdmin } from '../../middleware/auth'
import { AppError } from '../../middleware/errorHandler'
import { decryptBankAccountNumber } from '../../lib/bankAccountCrypto'
import { BankAccountSummary } from '@gam/shared'

export const adminBankAccountsRouter = Router()
adminBankAccountsRouter.use(requireAuth, requireSuperAdmin)

const SAFE_COLUMNS = `
  id, user_id, nickname, account_holder_name, account_holder_type,
  account_type, routing_number, account_number_last4, status,
  created_at, updated_at
`

adminBankAccountsRouter.get('/users/:userId/bank-accounts', async (req, res, next) => {
  try {
    const rows = await query<BankAccountSummary>(`
      SELECT ${SAFE_COLUMNS}
        FROM user_bank_accounts
       WHERE user_id = $1
       ORDER BY status ASC, created_at DESC
    `, [req.params.userId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

adminBankAccountsRouter.post('/bank-accounts/:id/reveal', async (req, res, next) => {
  try {
    const row = await queryOne<{
      id: string
      user_id: string
      nickname: string
      routing_number: string
      account_number_last4: string
      account_number_encrypted: string
    }>(`
      SELECT id, user_id, nickname, routing_number,
             account_number_last4, account_number_encrypted
        FROM user_bank_accounts
       WHERE id = $1
    `, [req.params.id])
    if (!row) throw new AppError(404, 'Bank account not found')

    const accountNumber = decryptBankAccountNumber(row.account_number_encrypted)

    await query(`
      INSERT INTO audit_log
        (user_id, action, entity_type, entity_id, ip_address, new_value)
      VALUES ($1, 'super_admin_bank_reveal', 'user_bank_account', $2, $3, $4::jsonb)
    `, [
      req.user!.userId,
      row.id,
      req.ip ?? null,
      JSON.stringify({
        revealed_for_user_id: row.user_id,
        revealed_at: new Date().toISOString(),
      }),
    ])

    res.json({
      success: true,
      data: {
        id: row.id,
        user_id: row.user_id,
        nickname: row.nickname,
        routing_number: row.routing_number,
        account_number: accountNumber,
        account_number_last4: row.account_number_last4,
      },
    })
  } catch (e) { next(e) }
})
