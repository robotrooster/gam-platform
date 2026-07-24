/**
 * Service-interruption (utility outage) tools — landlord (S553).
 *
 * get_service_interruptions (READ) — live + recent outage notices across the
 * landlord's portfolio, optional property filter.
 *
 * post_service_interruption (ACTION, confirm-first) — post an outage notice.
 * Runs the same shared service as POST /service-interruptions: residents are
 * notified immediately, staff holding the Outages tab + the owner hear too
 * (minus the poster). Agent-posted notices are property-wide; unit-level
 * targeting stays in the portal.
 *
 * resolve_service_interruption (ACTION, confirm-first) — mark restored, with
 * an optional all-clear notification to residents. Same shared service as
 * the portal resolve route. All-clear only when the landlord CONFIRMS the
 * service is actually back — a false "restored" signal is worse than none.
 */

import {
  SERVICE_INTERRUPTION_TYPES, SERVICE_INTERRUPTION_TYPE_LABELS,
  type ServiceInterruptionType,
} from '@gam/shared'
import { query, queryOne } from '../../../db'
import {
  createServiceInterruption, resolveServiceInterruption,
} from '../../serviceInterruptions'
import type { AgentTool, AgentActor } from './types'

const label = (t: string) => SERVICE_INTERRUPTION_TYPE_LABELS[t as ServiceInterruptionType] ?? t

/** Resolve a property NAME to exactly one property this landlord owns. */
async function resolveOwnProperty(landlordId: string, propertyName: string) {
  const rows = await query<{ id: string; name: string }>(
    `SELECT id, name FROM properties WHERE landlord_id = $1 AND name ILIKE $2 ORDER BY name LIMIT 5`,
    [landlordId, `%${propertyName.trim()}%`]
  )
  if (rows.length === 1) return { property: rows[0] as { id: string; name: string }, error: null }
  if (rows.length === 0) return { property: null, error: `No property named "${propertyName}" on this account.` }
  return {
    property: null,
    error: `"${propertyName}" matches several properties (${rows.map((r) => r.name).join(', ')}) — ask which one.`,
  }
}

export const getServiceInterruptions: AgentTool = {
  name: 'get_service_interruptions',
  description:
    'Utility outage / service-interruption notices on the landlord’s properties — live (active or scheduled) ' +
    'first, then recent history. Use for “is anything down?”, “what outages are posted?”, or to find the ' +
    'notice id before resolving one. Optional propertyName filter.',
  parameters: {
    type: 'object',
    properties: {
      propertyName: { type: 'string', description: 'Optional — limit to this property (by name).' },
    },
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const params: any[] = [actor.profileId]
    let propFilter = ''
    const propertyName = typeof args.propertyName === 'string' && args.propertyName.trim() ? args.propertyName.trim() : null
    if (propertyName) {
      params.push(`%${propertyName}%`)
      propFilter = `AND p.name ILIKE $${params.length}`
    }
    const rows = await query<any>(
      `SELECT si.id, p.name AS property_name, si.utility_type, si.title, si.message,
              si.is_emergency, si.status, si.starts_at, si.expected_restore_at, si.resolved_at,
              cardinality(si.unit_ids) AS targeted_units
         FROM service_interruptions si
         JOIN properties p ON p.id = si.property_id
        WHERE si.landlord_id = $1 ${propFilter}
        ORDER BY (si.status IN ('scheduled','active')) DESC, si.starts_at DESC
        LIMIT 25`,
      params
    )
    const live = rows.filter((r) => r.status === 'active' || r.status === 'scheduled')
    return {
      ok: true,
      notices: rows.map((r) => ({
        ...r,
        utility: label(r.utility_type),
        scope: Number(r.targeted_units) === 0 ? 'property-wide' : `${r.targeted_units} unit(s)`,
      })),
      note: live.length === 0
        ? 'No live outage notices.'
        : `${live.length} live notice(s) (active or scheduled).`,
    }
  },
}

export const postServiceInterruption: AgentTool = {
  name: 'post_service_interruption',
  description:
    'Post a utility outage / service-interruption notice for one of the landlord’s properties — residents at ' +
    'the property are notified immediately, and front-desk staff hear too. Property-wide only (use the portal ' +
    'to target specific units). CONFIRM every detail with the landlord first — the utility, the property, ' +
    'whether it is an emergency, when it starts, and the expected restore time — because posting notifies real ' +
    `residents right away. utilityType must be one of: ${SERVICE_INTERRUPTION_TYPES.join(', ')}. Omit startsAt ` +
    'for “down right now”; give ISO datetimes for scheduled work. Resolve later with resolve_service_interruption.',
  parameters: {
    type: 'object',
    properties: {
      propertyName: { type: 'string', description: 'Which property (by name).' },
      utilityType: { type: 'string', enum: [...SERVICE_INTERRUPTION_TYPES], description: 'What service is interrupted.' },
      title: { type: 'string', description: 'Optional short headline residents see (e.g. "Water main repair").' },
      message: { type: 'string', description: 'Optional detail for residents — what happened, what to expect.' },
      isEmergency: { type: 'boolean', description: 'true for an unplanned emergency outage (🚨 framing).' },
      startsAt: { type: 'string', description: 'Optional ISO datetime the interruption starts. Omit = now.' },
      expectedRestoreAt: { type: 'string', description: 'Optional ISO datetime service is expected back. An estimate, not a promise.' },
    },
    required: ['propertyName', 'utilityType'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const propertyName = String(args.propertyName ?? '').trim()
    const utilityType = String(args.utilityType ?? '').trim()
    if (!propertyName) return { ok: false, error: 'A propertyName is required.' }
    if (!(SERVICE_INTERRUPTION_TYPES as readonly string[]).includes(utilityType))
      return { ok: false, error: `utilityType must be one of: ${SERVICE_INTERRUPTION_TYPES.join(', ')}.` }

    const parseIso = (v: unknown): string | null | 'bad' => {
      if (typeof v !== 'string' || !v.trim()) return null
      const d = new Date(v)
      return isNaN(d.getTime()) ? 'bad' : d.toISOString()
    }
    const startsAt = parseIso(args.startsAt)
    const expectedRestoreAt = parseIso(args.expectedRestoreAt)
    if (startsAt === 'bad') return { ok: false, error: 'startsAt is not a valid datetime.' }
    if (expectedRestoreAt === 'bad') return { ok: false, error: 'expectedRestoreAt is not a valid datetime.' }

    const { property, error } = await resolveOwnProperty(actor.profileId, propertyName)
    if (!property) return { ok: false, error }

    try {
      const { row, residentsNotified, staffNotified } = await createServiceInterruption({
        propertyId: property.id, landlordId: actor.profileId, unitIds: [],
        utilityType,
        title: typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 160) : null,
        message: typeof args.message === 'string' && args.message.trim() ? args.message.trim().slice(0, 2000) : null,
        isEmergency: args.isEmergency === true,
        startsAt, expectedRestoreAt,
        createdByUserId: actor.userId,
      })
      return {
        ok: true,
        noticeId: row.id,
        status: row.status,
        message:
          `${label(utilityType)} notice posted for ${property.name} (${row.status}). ` +
          `${residentsNotified} resident(s) notified` +
          (staffNotified > 0 ? ` and ${staffNotified} team member(s) alerted.` : '.'),
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'Could not post the notice.' }
    }
  },
}

export const resolveServiceInterruptionTool: AgentTool = {
  name: 'resolve_service_interruption',
  description:
    'Mark a live outage notice resolved. Get the noticeId from get_service_interruptions and CONFIRM with the ' +
    'landlord before calling. Set sendAllClear=true ONLY when the landlord confirms service is actually ' +
    'restored — it sends a “restored” notification to residents, and a false all-clear is worse than silence.',
  parameters: {
    type: 'object',
    properties: {
      noticeId: { type: 'string', description: 'From get_service_interruptions.' },
      sendAllClear: { type: 'boolean', description: 'true to notify residents service is restored. Only when confirmed restored.' },
    },
    required: ['noticeId'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const id = String(args.noticeId ?? '').trim()
    if (!id) return { ok: false, error: 'A noticeId is required (from get_service_interruptions).' }
    const si = await queryOne<any>(
      `SELECT * FROM service_interruptions WHERE id = $1 AND landlord_id = $2`,
      [id, actor.profileId]
    )
    if (!si) return { ok: false, error: 'No such outage notice on this account.' }
    try {
      const sendAllClear = args.sendAllClear === true
      await resolveServiceInterruption(si, sendAllClear)
      return {
        ok: true,
        noticeId: si.id,
        message: `${label(si.utility_type)} notice resolved` +
          (sendAllClear ? ' — residents got the all-clear.' : ' (no all-clear sent).'),
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'Could not resolve the notice.' }
    }
  },
}
