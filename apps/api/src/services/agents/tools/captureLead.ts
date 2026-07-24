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
    'Save the prospect as a lead so a GAM Portfolio Specialist can follow up. Call this once you have ' +
    'at least their email or phone (confirm it with them first). Fill EVERY other field you can from ' +
    'what they said anywhere in the conversation — states, unit count, property mix — even if you never ' +
    'asked directly; partial is fine, never leave a field empty that the chat answered. After saving, ' +
    'let them know a Portfolio Specialist will reach out.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The prospect’s name, if given.' },
      email: { type: 'string', description: 'Their email (need email OR phone).' },
      phone: { type: 'string', description: 'Their phone (need email OR phone).' },
      states: { type: 'string', description: 'State(s) they operate in, in their words (e.g. "Arizona and Utah").' },
      portfolioSize: { type: 'string', description: 'How many units/properties/sites they have, in their words (e.g. "about 40 units", "30-site park").' },
      propertyType: { type: 'string', description: 'Their property mix, in their words (e.g. "mostly RVs, one storage facility, some boat parking").' },
      notes: { type: 'string', description: 'What they’re interested in / their situation / anything useful for the Specialist’s call.' },
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
    const states = typeof args.states === 'string' ? args.states.trim() : null
    const lead = await queryOne<{ id: string }>(
      `INSERT INTO sales_leads (conversation_id, name, email, phone, states, portfolio_size, property_type, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        actor.profileId || null,
        name,
        email || null,
        phone || null,
        states,
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
          [email && `email: ${email}`, phone && `phone: ${phone}`, states && `states: ${states}`, args.portfolioSize && `portfolio: ${args.portfolioSize}`]
            .filter(Boolean)
            .join(' · ') || 'New lead from the sales assistant',
          JSON.stringify({ leadId: lead?.id, name, email, phone, states, portfolioSize: args.portfolioSize, propertyType: args.propertyType, notes: args.notes }),
        ]
      )
    } catch (e) {
      logger.error({ err: e, leadId: lead?.id }, '[sales] lead-notify failed')
    }

    return { ok: true, leadId: lead?.id, message: 'Lead saved — the sales team has been notified and will reach out.' }
  },
}
