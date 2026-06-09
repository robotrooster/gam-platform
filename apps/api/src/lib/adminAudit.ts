/**
 * S67: admin_action_log writer.
 *
 * Centralizes the INSERT so callers don't repeat the column list and so we
 * have one place to add things like Sentry breadcrumbs or async forwarding
 * later. Failure-tolerant on purpose: a write here failing must not break
 * the user-facing action that triggered it. We log to console and continue.
 */

import { query } from '../db'
import { logger } from './logger'

export interface AdminActionLogInput {
  adminUserId: string
  actionType: string
  targetId?: string | null
  targetType?: string | null
  notes?: string | null
  metadata?: Record<string, unknown> | null
  ipAddress?: string | null
}

export async function logAdminAction(input: AdminActionLogInput): Promise<void> {
  try {
    await query(`
      INSERT INTO admin_action_log
        (admin_user_id, action_type, target_id, target_type, notes, metadata, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      input.adminUserId,
      input.actionType,
      input.targetId ?? null,
      input.targetType ?? null,
      input.notes ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.ipAddress ?? null,
    ])
  } catch (e: any) {
    logger.error({ err: e }, '[admin_action_log] write failed:')
  }
}
