/**
 * S513 (J) — discount code resolution + application.
 *
 * One place that knows how a discount code turns into a dollar amount and
 * how a redemption is recorded, shared by the POS sale path and the
 * invoice-create path so the rules never drift between them.
 *
 * Money rule: the discount applies to the PRE-TAX subtotal.
 *   percent → round(subtotal * value/100)
 *   fixed   → min(value, subtotal)   (never discount more than the sale)
 * The result is clamped to [0, subtotal].
 */

import type { PoolClient } from 'pg'
import { AppError } from '../middleware/errorHandler'
import type { BusinessDiscountType } from '@gam/shared'

export interface DiscountCodeRow {
  id: string
  code: string
  discount_type: BusinessDiscountType
  discount_value: string
  is_active: boolean
  max_redemptions: number | null
  redemption_count: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Dollars off a given pre-tax subtotal, clamped to [0, subtotal]. */
export function computeDiscountAmount(
  type: BusinessDiscountType,
  value: number,
  subtotal: number,
): number {
  if (subtotal <= 0) return 0
  const raw = type === 'percent'
    ? round2(subtotal * (value / 100))
    : round2(value)
  return Math.min(Math.max(raw, 0), round2(subtotal))
}

/**
 * Resolve + validate a code WITHOUT consuming a redemption. Used by the
 * preview endpoint and as the read half of apply. Validates existence,
 * active flag, active window (NOW within starts_at/expires_at), and the
 * redemption cap. Throws AppError on any failure.
 *
 * `lock` row-locks the code (FOR UPDATE) so the caller can safely
 * increment within the same transaction without a race.
 */
export async function resolveDiscountCode(
  client: PoolClient,
  businessId: string,
  code: string,
  opts: { lock?: boolean } = {},
): Promise<DiscountCodeRow> {
  const normalized = code.trim().toUpperCase()
  if (!normalized) throw new AppError(400, 'Discount code required')
  const { rows } = await client.query<DiscountCodeRow & {
    in_window: boolean
  }>(
    `SELECT id, code, discount_type, discount_value, is_active,
            max_redemptions, redemption_count,
            (starts_at IS NULL OR starts_at <= NOW())
              AND (expires_at IS NULL OR expires_at > NOW()) AS in_window
       FROM business_discount_codes
      WHERE business_id = $1 AND code = $2
      ${opts.lock ? 'FOR UPDATE' : ''}`,
    [businessId, normalized])
  const row = rows[0]
  if (!row) throw new AppError(404, `Discount code "${normalized}" not found`)
  if (!row.is_active) throw new AppError(409, `Discount code "${normalized}" is inactive`)
  if (!row.in_window) throw new AppError(409, `Discount code "${normalized}" is not currently active`)
  if (row.max_redemptions !== null && row.redemption_count >= row.max_redemptions) {
    throw new AppError(409, `Discount code "${normalized}" has reached its usage limit`)
  }
  return row
}

export interface AppliedDiscount {
  discountCodeId: string
  discountAmount: number
}

/**
 * Resolve a code, compute the dollar discount against `subtotal`, and
 * consume one redemption — all within the caller's transaction. The code
 * row is locked FOR UPDATE and the cap re-checked under the lock, so two
 * concurrent sales can't both slip past the last redemption.
 */
export async function applyDiscount(
  client: PoolClient,
  businessId: string,
  code: string,
  subtotal: number,
): Promise<AppliedDiscount> {
  const row = await resolveDiscountCode(client, businessId, code, { lock: true })
  const discountAmount = computeDiscountAmount(
    row.discount_type, Number(row.discount_value), subtotal)
  await client.query(
    `UPDATE business_discount_codes
        SET redemption_count = redemption_count + 1, updated_at = NOW()
      WHERE id = $1`,
    [row.id])
  return { discountCodeId: row.id, discountAmount }
}
