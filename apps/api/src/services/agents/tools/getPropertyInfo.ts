/**
 * Tool: get_property_info (visitor). The property-website visitor's window into
 * the ONE property they're browsing — description, location, amenities, FAQs,
 * office contact. Hard-scoped to actor.propertyId (set by the property-agent
 * door from the site's slug); the agent can never read another property.
 * Read-only. All content is live, so it reflects whatever the landlord has
 * currently published.
 */

import { query } from '../../../db'
import { resolvePropertyById } from '../../propertyBookingQuote'
import type { AgentTool, AgentActor } from './types'

export const getPropertyInfo: AgentTool = {
  name: 'get_property_info',
  description:
    'Facts about THIS property — its description, the host’s story (who they are, family-owned, how long they’ve ' +
    'run it), a local-area / things-to-do guide, city/state, amenities (pool, clubhouse, laundry, hookups…), the ' +
    'host’s published FAQs, and office contact/hours. Use for “what’s here?”, “do you have a pool/laundry?”, ' +
    '“who runs this place?”, “what’s around / things to do nearby?”, “where are you located?”, or any general ' +
    'question about the park/property. Read-only. Don’t state property facts you can’t see here.',
  parameters: { type: 'object', properties: {} },
  audiences: ['visitor'],

  async execute(_args, actor: AgentActor) {
    if (!actor.propertyId) return { ok: false, error: 'No property is associated with this session.' }
    const prop = await resolvePropertyById(actor.propertyId)
    if (!prop) return { ok: false, error: 'This property’s booking site is not available.' }

    const amenities = await query<any>(
      `SELECT name, description, capacity, open_time, close_time,
              reservable, requires_approval, reservation_fee::float AS reservation_fee
         FROM common_areas
        WHERE property_id = $1 AND active = TRUE
        ORDER BY name`,
      [actor.propertyId])
    const faqs = await query<any>(
      `SELECT question, answer FROM property_faqs
        WHERE property_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [actor.propertyId])

    const location = [prop.city, prop.state].filter(Boolean).join(', ') || null
    return {
      ok: true,
      property: prop.name,
      location,
      intro: prop.booking_intro,
      about: prop.booking_about,          // the host's story (family-owned, years running)
      areaGuide: prop.booking_area,       // local area & things to do
      office: {
        phone: prop.office_phone,
        email: prop.office_email,
        hours: prop.office_hours,
      },
      amenities: amenities.map((a) => ({
        name: a.name,
        description: a.description,
        hours: a.open_time && a.close_time ? `${a.open_time}–${a.close_time}` : null,
        reservable: a.reservable,
        reservationFee: a.reservable ? a.reservation_fee : null,
        needsApproval: a.reservable ? a.requires_approval : null,
      })),
      faqs,
      note: faqs.length === 0 && amenities.length === 0
        ? 'This property has not published amenities or FAQs yet — offer to pass a question to the host.'
        : null,
    }
  },
}
