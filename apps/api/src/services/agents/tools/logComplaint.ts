/**
 * Tool: log_complaint (tenant). Writes down a complaint the tenant raises in
 * chat, so it becomes a record the landlord can actually see and count.
 *
 * S618 (Nic): "the table is gonna be created in the agent chat. That's the
 * point of contact where tenants are gonna complain about the neighbor, or
 * they're gonna do it as a maintenance request — hey, tell my neighbor to turn
 * their shit down."
 *
 * Before this, a tenant could say exactly that and it went nowhere: the agent
 * would sympathise, the conversation would end, and the landlord would never
 * know. Asked later which tenants complain most, or which neighbour is the
 * actual problem, nothing anywhere held the answer.
 *
 * IT IS DIRECTLY RUNNABLE, and that reversed an earlier call of mine. I first
 * withheld it from the phrase table on the grounds that a write about a named
 * neighbour is too consequential to fire from a misread sentence. Then the
 * battery measured what actually happens: the model never called it — 0 of 4 —
 * and instead told the tenant "I've logged your complaint. Your landlord has
 * been notified and will follow up." while the table stayed empty. A tenant who
 * believes their complaint is filed stops pursuing it. That is worse than any
 * misfile.
 *
 * And the misfile risk was overstated. `body` is the tenant's OWN sentence,
 * stored verbatim, so a wrongly-triggered row still says exactly what they
 * said; the landlord reads their words, not an interpretation. about_unit is
 * set only when they name a unit that exists at their property. A duplicate
 * within the hour is collapsed rather than written twice.
 *
 * Identity is never taken from the model: tenant, lease, unit, property and
 * landlord all resolve from actor.profileId. The model supplies only what was
 * said and what kind of thing it is.
 */

import { COMPLAINT_CATEGORY_VALUES, COMPLAINT_CATEGORY_LABEL, type ComplaintCategory } from '@gam/shared'
import { query, queryOne } from '../../../db'
import { logger } from '../../../lib/logger'
import type { AgentTool, AgentActor } from './types'

export const logComplaint: AgentTool = {
  name: 'log_complaint',
  description:
    'Record a complaint the tenant is raising — a noisy or difficult neighbor, parking, pets, ' +
    'smells, trash, safety, or the condition of the property. Use this whenever a tenant complains ' +
    'about something that is NOT a repair (a repair is file_maintenance_request). Filing it means ' +
    'their landlord actually sees it; saying you understand does not. Tell the tenant you have ' +
    'written it down and passed it to their landlord.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: [...COMPLAINT_CATEGORY_VALUES],
        description: 'What kind of complaint. Use "neighbor" when it is about another resident and no better category fits.',
      },
      body: {
        type: 'string',
        description: 'What the tenant said, in their own words as closely as possible.',
      },
      about_unit: {
        type: 'string',
        description: 'The unit or spot they are complaining about, e.g. "Apt 102" or "RV 04". Omit if they did not say.',
      },
    },
    required: ['category', 'body'],
  },
  audiences: ['tenant'],
  async execute(args, actor: AgentActor) {
    const category = String(args.category ?? '').toLowerCase() as ComplaintCategory
    const body = String(args.body ?? '').trim()
    if (!COMPLAINT_CATEGORY_VALUES.includes(category)) {
      return { ok: false, error: `Not a complaint category. Use one of: ${COMPLAINT_CATEGORY_VALUES.join(', ')}.` }
    }
    if (!body) {
      return { ok: false, error: 'Nothing to record — ask the tenant what the problem is, then file it.' }
    }

    // Everything about WHO comes from the signed-in tenant, never the model.
    const lease = await queryOne<any>(
      `SELECT l.id AS lease_id, l.landlord_id, u.id AS unit_id, u.property_id,
              u.unit_number, p.name AS property_name,
              lu.id AS landlord_user_id,
              tu.first_name || ' ' || tu.last_name AS tenant_name
         FROM leases l
         JOIN landlords ll ON ll.id = l.landlord_id
         JOIN users lu     ON lu.id = ll.user_id
         JOIN tenants tt   ON tt.id = $1
         JOIN users tu     ON tu.id = tt.user_id
         JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
         JOIN units u          ON u.id = l.unit_id
         JOIN properties p     ON p.id = u.property_id
        WHERE lt.tenant_id = $1 AND l.status = 'active'
        ORDER BY l.start_date DESC LIMIT 1`,
      [actor.profileId],
    )
    if (!lease) {
      return {
        ok: false,
        error: 'No active lease on record, so there is no landlord to send this to. Do not claim it was filed.',
      }
    }

    // Resolve the unit they named — only within their OWN property, so a
    // complaint can never be attached to a unit in someone else's portfolio.
    const aboutRaw = String(args.about_unit ?? '').trim()
    let aboutUnitId: string | null = null
    let aboutResolved: string | null = null
    if (aboutRaw) {
      const hit = await queryOne<any>(
        `SELECT id, unit_number FROM units
          WHERE property_id = $1 AND retired_at IS NULL
            AND regexp_replace(lower(unit_number), '[^a-z0-9]', '', 'g')
              = regexp_replace(lower($2), '[^a-z0-9]', '', 'g')
          LIMIT 1`,
        [lease.property_id, aboutRaw],
      )
      if (hit) { aboutUnitId = hit.id; aboutResolved = hit.unit_number }
    }

    // Same tenant, same words, within the hour — the phrase table may fire on
    // several turns of one conversation about one problem, and a landlord
    // reading "loud neighbour" nine times learns nothing the first row did not
    // already say.
    const dupe = await queryOne<any>(
      `SELECT id FROM tenant_complaints
        WHERE tenant_id = $1 AND category = $2 AND body = $3
          AND created_at > NOW() - INTERVAL '1 hour' LIMIT 1`,
      [actor.profileId, category, body],
    )
    if (dupe) {
      return {
        ok: true, filed: true, alreadyFiled: true, complaintId: dupe.id,
        note: 'Already recorded a moment ago — tell them it is on file, do not file it twice.',
      }
    }

    const [row] = await query<any>(
      `INSERT INTO tenant_complaints
         (tenant_id, lease_id, unit_id, property_id, landlord_id,
          category, about_unit_id, about_text, body, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'agent_chat')
       RETURNING id, created_at`,
      [actor.profileId, lease.lease_id, lease.unit_id, lease.property_id, lease.landlord_id,
       category, aboutUnitId, aboutRaw || null, body],
    )

    // S618 (Nic): "the complaint generally needs to go to the landlord... that
    // needs to create a task list for them, things to address." Best-effort:
    // a notification that fails must never lose the complaint itself, which is
    // already committed above.
    try {
      const { notifyTenantComplaint } = await import('../../notifications')
      await notifyTenantComplaint({
        landlordUserId: lease.landlord_user_id,
        landlordId: lease.landlord_id,
        tenantName: lease.tenant_name,
        unitNumber: lease.unit_number,
        propertyName: lease.property_name,
        category: COMPLAINT_CATEGORY_LABEL[category],
        about: aboutResolved ?? aboutRaw ?? null,
        body,
        complaintId: row.id,
      })
    } catch (e) {
      logger.error({ err: e, complaintId: row.id }, 'agent: complaint filed but landlord notification failed')
    }

    return {
      ok: true,
      filed: true,
      complaintId: row.id,
      category: COMPLAINT_CATEGORY_LABEL[category],
      about: aboutResolved ?? (aboutRaw || null),
      // Said explicitly because the tenant needs to know something actually
      // happened — the whole point is that this no longer evaporates.
      note:
        'Recorded and visible to their landlord. Tell them it has been passed on. Do NOT promise ' +
        'any particular outcome, a timeline, or that anyone will be spoken to — that is the ' +
        'landlord’s decision, not ours.' +
        (aboutRaw && !aboutResolved
          ? ` They named "${aboutRaw}", which is not a unit at their property, so it was saved as free text.`
          : ''),
    }
  },
}
