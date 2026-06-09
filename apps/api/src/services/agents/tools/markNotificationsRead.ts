/**
 * Tool: mark_notifications_read (tenant + landlord ACTION). Marks the user's
 * own unread notifications as read. Hard-scoped to actor.userId
 * (notifications.user_id) — can only ever affect the caller's own rows.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

export const markNotificationsRead: AgentTool = {
  name: 'mark_notifications_read',
  description:
    "Mark the user's unread account notifications as read (clears their unread count). Use after " +
    'the user has seen their notifications and says something like “mark those as read” or “clear ' +
    'my notifications”.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant', 'landlord'],
  async execute(_args, actor: AgentActor) {
    const rows = await query<{ id: string }>(
      `UPDATE notifications SET read = TRUE, read_at = now()
        WHERE user_id = $1 AND read = FALSE RETURNING id`,
      [actor.userId]
    )
    return {
      ok: true,
      markedRead: rows.length,
      message: rows.length > 0 ? `Marked ${rows.length} notification${rows.length === 1 ? '' : 's'} as read.` : 'You had no unread notifications.',
    }
  },
}
