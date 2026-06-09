/**
 * Tool: update_notification_preference (tenant + landlord).
 *
 * Lets the user turn notification channels (email / SMS / in-app) on or off
 * for one of THEIR OWN existing notification types. Hard-scoped to
 * actor.userId (notification_preferences.user_id). It will NOT create new
 * preference types (those are free-form and managed in settings) — if the
 * named type isn't already set, it lists the user's current types so the
 * agent can ask which to change. Unspecified channels keep their current value.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface PrefRow {
  type: string
  email_enabled: boolean
  sms_enabled: boolean
  in_app_enabled: boolean
}

export const updateNotificationPreference: AgentTool = {
  name: 'update_notification_preference',
  description:
    'Turn notification channels (email, SMS, in-app) on or off for one of the user’s existing ' +
    'notification types. Use for “stop emailing me about X” or “turn on text alerts for Y”. If you ' +
    'don’t know the exact type, call it with no type to list the user’s current settings first.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'The notification type to change (omit to list current types).' },
      emailEnabled: { type: 'boolean' },
      smsEnabled: { type: 'boolean' },
      inAppEnabled: { type: 'boolean' },
    },
  },
  audiences: ['tenant', 'landlord'],

  async execute(args, actor: AgentActor) {
    const prefs = await query<PrefRow>(
      `SELECT type, email_enabled, sms_enabled, in_app_enabled
         FROM notification_preferences WHERE user_id = $1 ORDER BY type`,
      [actor.userId]
    )

    const listCurrent = () => ({
      types: prefs.map((p) => ({ type: p.type, email: p.email_enabled, sms: p.sms_enabled, inApp: p.in_app_enabled })),
    })

    if (prefs.length === 0) {
      return { ok: false, error: 'No notification preferences are set yet. They can be managed in your settings.' }
    }

    const type = typeof args.type === 'string' ? args.type.trim() : ''
    const target = prefs.find((p) => p.type === type)
    if (!target) {
      return {
        ok: false,
        needsType: true,
        message: 'Tell me which notification type to change (one of the types below).',
        ...listCurrent(),
      }
    }

    // Apply only the channels the caller specified; keep the rest.
    const email = typeof args.emailEnabled === 'boolean' ? args.emailEnabled : target.email_enabled
    const sms = typeof args.smsEnabled === 'boolean' ? args.smsEnabled : target.sms_enabled
    const inApp = typeof args.inAppEnabled === 'boolean' ? args.inAppEnabled : target.in_app_enabled

    await query(
      `UPDATE notification_preferences
          SET email_enabled = $3, sms_enabled = $4, in_app_enabled = $5, updated_at = now()
        WHERE user_id = $1 AND type = $2`,
      [actor.userId, type, email, sms, inApp]
    )

    return { ok: true, type, email, sms, inApp, message: `Updated your “${type}” notification settings.` }
  },
}
