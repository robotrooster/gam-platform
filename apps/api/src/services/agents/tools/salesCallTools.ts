/**
 * Sales-call tools (S553) — Lucy books the Portfolio Strategist call
 * in-chat, using the SAME service as the public booking route.
 *
 * get_available_call_times (READ) — upcoming bookable slots, humanized.
 * book_sales_call (ACTION, confirm-first) — books one; sends the prospect
 * a confirmation email and links the lead (via the chat's conversation id,
 * which is the prospect actor's profileId).
 */

import { listAvailableSlots, formatSlotForHumans, bookSalesCall } from '../../salesCalls'
import type { AgentTool, AgentActor } from './types'

export const getAvailableCallTimes: AgentTool = {
  name: 'get_available_call_times',
  description:
    'Upcoming times a GAM Portfolio Strategist is free for a call. Use when the prospect is interested in ' +
    'talking to the team — offer 2-3 near-term options conversationally (never dump the whole list). ' +
    'Read-only; book with book_sales_call.',
  parameters: { type: 'object', properties: {} },
  audiences: ['prospect'],

  async execute(_args, _actor: AgentActor) {
    const slots = await listAvailableSlots()
    if (slots.length === 0) {
      return { ok: true, slots: [], note: 'No open times right now — capture the lead and the team will reach out to schedule.' }
    }
    return {
      ok: true,
      // enough choice without flooding the context
      slots: slots.slice(0, 16).map((iso) => ({ startsAt: iso, label: formatSlotForHumans(iso) })),
      note: 'Offer a few options; the prospect picks video or phone when booking.',
    }
  },
}

export const bookSalesCallTool: AgentTool = {
  name: 'book_sales_call',
  description:
    'Book the prospect’s call with a Portfolio Strategist. CONFIRM FIRST: the exact time (startsAt from ' +
    'get_available_call_times), video or phone, their name, and their email — read the details back and get an ' +
    'explicit yes before calling, because booking sends a real confirmation email. On success, tell them the ' +
    'confirmed time and that the confirmation is in their inbox.',
  parameters: {
    type: 'object',
    properties: {
      startsAt: { type: 'string', description: 'The slot’s startsAt ISO datetime, exactly as returned by get_available_call_times.' },
      mode: { type: 'string', enum: ['video', 'phone'], description: 'video (recommended — includes a live demo) or phone.' },
      name: { type: 'string', description: 'The prospect’s name.' },
      email: { type: 'string', description: 'Their email — the confirmation goes here.' },
      phone: { type: 'string', description: 'Their phone (required for phone calls).' },
      notes: { type: 'string', description: 'Anything useful for the Strategist (portfolio, what they want to see).' },
    },
    required: ['startsAt', 'mode', 'name', 'email'],
  },
  audiences: ['prospect'],

  async execute(args, actor: AgentActor) {
    const mode = args.mode === 'phone' ? 'phone' : 'video'
    const name = String(args.name ?? '').trim()
    const email = String(args.email ?? '').trim()
    const phone = typeof args.phone === 'string' && args.phone.trim() ? args.phone.trim() : null
    if (!name || !email) return { ok: false, error: 'Name and email are both required.' }
    if (mode === 'phone' && !phone) return { ok: false, error: 'A phone number is required for a phone call.' }

    const result = await bookSalesCall({
      startsAt: String(args.startsAt ?? ''),
      mode, name, email, phone,
      // the prospect actor's profileId IS the chat conversation id — links
      // the call to the captured lead
      conversationId: actor.profileId || null,
      notes: typeof args.notes === 'string' && args.notes.trim() ? args.notes.trim().slice(0, 2000) : null,
    })
    if (!result.ok) return result
    return {
      ok: true,
      when: result.when,
      message: `Booked — ${result.when}, ${mode} call. A confirmation email is on its way to ${email}.`,
    }
  },
}
