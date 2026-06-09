/**
 * Tool: get_my_notifications (tenant + landlord). Reads the user's recent
 * account notifications. Hard-scoped to actor.userId (notifications.user_id).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row { type: string; title: string | null; body: string | null; read: boolean; created_at: string }

export const getMyNotifications: AgentTool = {
  name: 'get_my_notifications',
  description:
    'List the user’s recent account notifications (title, message, whether read). Use for “what ' +
    'notifications do I have?”, “did I miss anything?”, or “any updates on my account?”. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many recent notifications (default 10, max 30).' },
      unreadOnly: { type: 'boolean', description: 'Only return unread notifications.' },
    },
  },
  audiences: ['tenant', 'landlord'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 30) : 10
    const unreadOnly = args.unreadOnly === true
    const rows = await query<Row>(
      `SELECT type, title, body, read, created_at
         FROM notifications
        WHERE user_id = $1 ${unreadOnly ? 'AND read = FALSE' : ''}
        ORDER BY created_at DESC LIMIT $2`,
      [actor.userId, limit]
    )
    return {
      ok: true,
      count: rows.length,
      unreadOnly,
      note: rows.length === 0 ? 'No notifications to show.' : undefined,
      notifications: rows.map((r) => ({ type: r.type, title: r.title, message: r.body, read: r.read, at: r.created_at })),
    }
  },
}
