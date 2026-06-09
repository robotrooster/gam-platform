/**
 * Tool: capture_lead (sales / prospect ACTION).
 *
 * The sales agent's one action: save a prospect as a lead for the human
 * sales team and alert them. No actor scoping (prospects are anonymous,
 * unauthenticated marketing-site visitors) — the tool only writes a new
 * lead from the info the prospect shared. Requires at least an email or
 * phone so the team can actually follow up. The prospect's session id
 * (actor.profileId) links the lead to its chat.
 */

import { query, queryOne } from '../../../db'
import { logger } from '../../../lib/logger'
import type { AgentTool, AgentActor } from './types'

export const captureLead: AgentTool = {
  name: 'capture_lead',
  description:
    'Save the prospect as a lead so the GAM sales team can follow up, and (optionally) set up a ' +
    'call. Call this once you have at least their email or phone, plus their name and whatever they ' +
    'shared about their portfolio (size/type) and what they’re looking for. Confirm their contact ' +
    'info with them before saving. After saving, let them know someone from the team will reach out.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The prospect’s name, if given.' },
      email: { type: 'string', description: 'Their email (need email OR phone).' },
      phone: { type: 'string', description: 'Their phone (need email OR phone).' },
      portfolioSize: { type: 'string', description: 'How many units/properties they have, in their words (e.g. "about 40 units").' },
      propertyType: { type: 'string', description: 'What kind of properties (e.g. "RV park", "apartments", "single-family").' },
      notes: { type: 'string', description: 'What they’re interested in / their situation / anything useful for the call.' },
    },
  },
  audiences: ['prospect'],

  async execute(args, actor: AgentActor) {
    const email = typeof args.email === 'string' ? args.email.trim() : ''
    const phone = typeof args.phone === 'string' ? args.phone.trim() : ''
    if (!email && !phone) {
      return { ok: false, error: 'Ask for an email or phone number first so the team can follow up.' }
    }

    const name = typeof args.name === 'string' ? args.name.trim() : null
    const lead = await queryOne<{ id: string }>(
      `INSERT INTO sales_leads (conversation_id, name, email, phone, portfolio_size, property_type, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        actor.profileId || null,
        name,
        email || null,
        phone || null,
        typeof args.portfolioSize === 'string' ? args.portfolioSize.trim() : null,
        typeof args.propertyType === 'string' ? args.propertyType.trim() : null,
        typeof args.notes === 'string' ? args.notes.trim() : null,
      ]
    )

    // Alert the sales team (best-effort — never block the prospect on it).
    try {
      await query(
        `INSERT INTO admin_notifications (severity, category, title, body, context)
         VALUES ('info', 'sales_lead', $1, $2, $3::jsonb)`,
        [
          `New sales lead${name ? `: ${name}` : ''}`,
          [email && `email: ${email}`, phone && `phone: ${phone}`, args.portfolioSize && `portfolio: ${args.portfolioSize}`]
            .filter(Boolean)
            .join(' · ') || 'New lead from the sales assistant',
          JSON.stringify({ leadId: lead?.id, name, email, phone, portfolioSize: args.portfolioSize, propertyType: args.propertyType, notes: args.notes }),
        ]
      )
    } catch (e) {
      logger.error({ err: e, leadId: lead?.id }, '[sales] lead-notify failed')
    }

    return { ok: true, leadId: lead?.id, message: 'Lead saved — the sales team has been notified and will reach out.' }
  },
}
