/**
 * Tool: update_notification_preference (tenant + landlord).
 *
 * Turns a notification's email or in-app channel on or off for the person in the
 * chat. Hard-scoped to actor.userId (notification_preferences.user_id).
 *
 * 10/20 (Nic), two root fixes in one pass:
 *
 *  1. IT USED TO ONLY EDIT ROWS THAT ALREADY EXISTED. "No notification
 *     preferences are set yet" was its answer to a landlord who had never
 *     touched the settings page — which is everyone, for most types, because a
 *     row is only written when someone answers. So "stop emailing me about
 *     maintenance" did nothing for the person most likely to ask. It now writes
 *     the row for any type in the catalog, the same as the settings page.
 *
 *  2. IT SPOKE RAW TYPE STRINGS. Listing `maintenance_submitted` at a landlord
 *     is both unreadable and unusable — they cannot name it back. It matches and
 *     speaks the human label from the catalog (memory: gam-no-raw-enums-in-ui).
 *
 * The critical five are never turned off here. The agent says which one it is
 * and why GAM still sends it, rather than pretending to switch it off.
 */

import { query } from '../../../db'
import {
  notificationCatalogFor, isCriticalNotificationType,
  type NotificationCatalogEntry,
} from '@gam/shared'
import type { AgentTool, AgentActor } from './types'

interface PrefRow {
  type: string
  email_enabled: boolean
  in_app_enabled: boolean
}

/** The types this actor's own settings page offers, so the tool and page agree. */
function catalogForActor(actor: AgentActor): NotificationCatalogEntry[] {
  // A tenant actor gets the resident's page; everyone else on the landlord side
  // (owner, manager, onsite staff) gets the landlord's.
  return notificationCatalogFor(actor.role === 'tenant' ? 'tenant' : 'landlord')
}

/**
 * What the words they said resolve to: one row, several, or nothing.
 *
 * 10/20 — THE LOOSE MATCH USED TO PICK THE FIRST OF MANY AND REPORT SUCCESS.
 *
 * "Stop emailing me about maintenance" matched 'A new maintenance request'
 * (the first of the landlord page's eight maintenance rows), wrote that one
 * row, and answered "Done". Emergency maintenance, approval-required, the PM
 * alert, assigned work and the four inspection rows all kept emailing — and he
 * had been told it was done, so he would not ask again. A one-character input
 * was worse: 'a' matched 'A payment was recorded for you'.
 *
 * It narrows and confirms now, which is the standing rule for a vague ask
 * (memory: gam-agent-goal-narrow-then-resolve). Several matches come back as
 * `many` for the agent to read out; the caller settles it either by naming one
 * exactly or by calling again with applyToAll once the person has said "all of
 * them". And the loose step needs at least three characters, because two
 * characters is not a name, it is a coincidence.
 */
const LOOSE_MATCH_MIN_CHARS = 3

type EntryMatch =
  | { kind: 'one';  entry: NotificationCatalogEntry }
  | { kind: 'many'; entries: NotificationCatalogEntry[] }
  | { kind: 'none' }

function findEntry(said: string, entries: NotificationCatalogEntry[]): EntryMatch {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const want = norm(said)
  if (!want) return { kind: 'none' }

  // Exact, in order: the stored type as given, then the label, then the type
  // with its underscores opened up. An exact hit is never ambiguous.
  const exact = entries.find(e => e.type === said)
    ?? entries.find(e => norm(e.label) === want)
    ?? entries.find(e => norm(e.type) === want)
  if (exact) return { kind: 'one', entry: exact }

  if (want.length < LOOSE_MATCH_MIN_CHARS) return { kind: 'none' }

  // Loose: EVERY row their words could mean, never just the first.
  const loose = entries.filter(e => norm(e.label).includes(want) || want.includes(norm(e.label)))
  if (loose.length === 1) return { kind: 'one', entry: loose[0]! }
  if (loose.length > 1)   return { kind: 'many', entries: loose }

  // Last resort, same rule: the stored type read loosely ("late fee" →
  // 'late_fee_*'), and again every match, not the first.
  const byType = entries.filter(e => norm(e.type).includes(want))
  if (byType.length === 1) return { kind: 'one', entry: byType[0]! }
  if (byType.length > 1)   return { kind: 'many', entries: byType }
  return { kind: 'none' }
}

export const updateNotificationPreference: AgentTool = {
  name: 'update_notification_preference',
  description:
    'Turn a notification’s email or in-app channel on or off for the person you are talking to. ' +
    'Use for “stop emailing me about X”. Name the notification the way they said it — call it with ' +
    'no name to list what can be changed. If what they said matches several notifications the tool ' +
    'returns all of them and changes nothing: read them out, ask whether they mean one or all of ' +
    'them, and then call again either naming the one or with applyToAll=true.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'The notification, named the way they said it (omit to list what can be changed).' },
      emailEnabled: { type: 'boolean' },
      inAppEnabled: { type: 'boolean' },
      applyToAll: { type: 'boolean', description: 'Set true only after they have confirmed they mean every notification that matched the words they used.' },
    },
  },
  audiences: ['tenant', 'landlord'],

  async execute(args, actor: AgentActor) {
    const entries = catalogForActor(actor)
    const stored = await query<PrefRow>(
      `SELECT type, email_enabled, in_app_enabled
         FROM notification_preferences WHERE user_id = $1`,
      [actor.userId]
    )
    const byType = new Map(stored.map(r => [r.type, r]))

    /** What they can change, in words they can say back. */
    const listCurrent = () => ({
      notifications: entries.map(e => {
        const row = byType.get(e.type)
        return {
          notification: e.label,
          whenItFires: e.when,
          email: isCriticalNotificationType(e.type) ? 'always on' : (row ? row.email_enabled : true),
          inApp: isCriticalNotificationType(e.type) ? 'always on' : (row ? row.in_app_enabled : true),
        }
      }),
    })

    const said = typeof args.type === 'string' ? args.type.trim() : ''
    if (!said) {
      return {
        ok: false,
        needsType: true,
        message: 'Which notification should I change? Here is everything that can be turned on or off.',
        ...listCurrent(),
      }
    }

    const match = findEntry(said, entries)
    if (match.kind === 'none') {
      return {
        ok: false,
        needsType: true,
        message: `I could not match “${said}” to one of their notifications. Ask which of these they mean.`,
        ...listCurrent(),
      }
    }

    // Several rows could be what they meant. Nothing is written: name them and
    // let the person settle it (memory: gam-agent-goal-narrow-then-resolve).
    // Writing the first one and saying "done" is how a landlord came to believe
    // maintenance email was off while seven of his eight maintenance rows kept
    // sending.
    const matched = match.kind === 'many' ? match.entries : [match.entry]
    if (match.kind === 'many' && args.applyToAll !== true) {
      return {
        ok: false,
        needsChoice: true,
        saidWords: said,
        matches: matched.map(e => ({
          notification: e.label,
          whenItFires: e.when,
          alwaysOn: isCriticalNotificationType(e.type) || undefined,
        })),
        message: `“${said}” matches ${matched.length} of their notifications, so nothing was changed. `
          + 'Read them out and ask whether they mean one of them or all of them. Then call again '
          + 'either naming the one, or with applyToAll=true.',
      }
    }

    // The locked ones are never written here, whether they were named directly
    // or swept up in an "all of them". The agent says which and why.
    const locked = matched.filter(e => isCriticalNotificationType(e.type))
    const changeable = matched.filter(e => !isCriticalNotificationType(e.type))
    if (!changeable.length) {
      const one = locked[0]!
      return {
        ok: false,
        alwaysOn: true,
        notification: one.label,
        message: `“${one.label}” is one GAM always sends. ${one.whyAlways ?? ''} `.trim()
          + ' Tell them it cannot be switched off, and that it only fires on those rare occasions.',
      }
    }

    // Unspecified channels keep what is stored, or GAM's default (on) when
    // nothing is stored — the same reading the settings page shows them.
    const rows = changeable.map(e => {
      const row = byType.get(e.type)
      return {
        entry: e,
        email: typeof args.emailEnabled === 'boolean' ? args.emailEnabled : (row ? row.email_enabled : true),
        inApp: typeof args.inAppEnabled === 'boolean' ? args.inAppEnabled : (row ? row.in_app_enabled : true),
      }
    })

    // One statement for all of them, the same shape the settings page's
    // "turn off every optional email" uses — a loop that half-succeeds leaves
    // somebody believing they answered rows that were never written.
    await query(
      `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
       SELECT $1, t, e, a FROM unnest($2::text[], $3::boolean[], $4::boolean[]) AS s(t, e, a)
       ON CONFLICT (user_id, type)
       DO UPDATE SET email_enabled  = EXCLUDED.email_enabled,
                     in_app_enabled = EXCLUDED.in_app_enabled,
                     updated_at     = NOW()`,
      [actor.userId, rows.map(r => r.entry.type), rows.map(r => r.email), rows.map(r => r.inApp)]
    )

    const first = rows[0]!
    const changedAll = rows.length > 1
    return {
      ok: true,
      notification: first.entry.label,
      changed: rows.map(r => ({ notification: r.entry.label, email: r.email, inApp: r.inApp })),
      alwaysOnSkipped: locked.length ? locked.map(e => e.label) : undefined,
      email: first.email, inApp: first.inApp,
      message: (changedAll
        ? `Done — ${rows.length} notifications: ${rows.map(r => `“${r.entry.label}”`).join(', ')}. `
          + `Email ${first.email ? 'on' : 'off'}, in-app ${first.inApp ? 'on' : 'off'} on each.`
        : `Done — “${first.entry.label}”: email ${first.email ? 'on' : 'off'}, in-app ${first.inApp ? 'on' : 'off'}.`)
        + (!first.email && first.inApp ? ' It still shows in their notifications when they sign in.' : '')
        + (locked.length
          ? ` ${locked.map(e => `“${e.label}”`).join(', ')} ${locked.length === 1 ? 'is one' : 'are ones'} GAM always sends, so ${locked.length === 1 ? 'it' : 'they'} ${locked.length === 1 ? 'was' : 'were'} left on.`
          : ''),
    }
  },
}
