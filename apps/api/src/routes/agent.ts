/**
 * Agent chat route — the door tenants/landlords use to talk to the
 * customer-service AI agents (Ava/Samantha for tenants, David/Sonny for
 * landlords).
 *
 * The agent's data access is bound entirely to the AUTHENTICATED user:
 * the actor is built from the JWT (req.user), never from the request
 * body, so a caller can only ever reach their own data. The audience is
 * derived from the user's role, not trusted from the client.
 *
 * Client-supplied history is sanitized to user/assistant turns only — a
 * caller may not inject system/tool messages (which would let them spoof
 * ground truth or tool results).
 */

import { Router } from 'express'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { runAgentSession } from '../services/agents/agentSession'
import { isAssistantHidden } from '../services/agents/turnBudget'
import { listAvailableSlots, formatSlotForHumans, bookSalesCall, groupSlotsByDay } from '../services/salesCalls'
import { query, queryOne } from '../db'
import { loadConversationHistory, loadGuestConversationHistory } from '../services/agents/conversationHistory'
import { resolveBookingGuestToken } from '../services/bookingGuestTokens'
import { resolveProperty } from '../services/propertyBookingQuote'
import type { AgentAudience, ChatMessage } from '../services/agents/types'

export const agentRouter = Router()
agentRouter.use(requireAuth)

// Per-USER rate limit on the expensive agent endpoint (keyed on the
// authenticated user id, NOT IP), so one user can't saturate the model
// fleet. requireAuth runs first, so req.user is always populated here.
// `max` is read per-request so it's env-tunable without a redeploy.
// SEAM: pass a `store` (rate-limit-redis) here when the dev team provisions
// Redis, so the limit is global across horizontally-scaled API instances;
// the default MemoryStore is per-instance (fine for single-instance dev).
const agentRateLimiter = rateLimit({
  windowMs: Number(process.env.AGENT_RATE_WINDOW_MS) || 60_000,
  max: () => Number(process.env.AGENT_RATE_MAX) || 20,
  keyGenerator: (req) => req.user?.userId ?? 'anonymous',
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "You're sending messages too quickly — please wait a moment." },
})
agentRouter.use(agentRateLimiter)

// GET /api/agent/visibility — should the assistant bubble render for this
// user? False only when the silent auto-hide (S553 abuse guard, dark by
// default) has tripped. The widget renders nothing on false — no
// explanation is ever shown (that's the point of "silent").
agentRouter.get('/visibility', async (req, res, next) => {
  try {
    const { userId, role } = req.user!
    const hidden = await isAssistantHidden(userId, role).catch(() => false)
    res.json({ success: true, data: { visible: !hidden } })
  } catch (e) { next(e) }
})

const chatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  // Prior turns only — the engine appends the current message. Only
  // user/assistant roles are accepted from the client.
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(8000),
      })
    )
    .max(40)
    .optional(),
})

// POST /api/agent/chat — one conversational turn.
agentRouter.post('/chat', async (req, res, next) => {
  try {
    const body = chatSchema.parse(req.body)
    const { userId, role, profileId } = req.user!

    // The CS agents serve tenants and landlords. Other roles (admin,
    // team members) have no tenant/landlord subject id for data scoping.
    if (role !== 'tenant' && role !== 'landlord') {
      throw new AppError(403, 'The assistant is available to tenants and landlords.')
    }
    const audience: AgentAudience = role

    // Conversation history is the SERVER's source of truth, not the client's.
    // Continuing a conversation → load its recent turns (ownership-checked by
    // userId). New conversation → mint an id the client threads on the next
    // turn. Client-supplied history is only a fallback for a brand-new thread.
    let conversationId = body.conversationId
    let history: ChatMessage[] | undefined = body.history
    if (conversationId) {
      history = await loadConversationHistory(conversationId, userId)
    } else {
      conversationId = randomUUID()
    }

    const result = await runAgentSession({
      audience,
      actor: { userId, role, profileId },
      message: body.message,
      conversationId,
      history,
    })

    // Return only what the client needs — never the human-handoff package
    // or raw tool internals.
    res.json({
      success: true,
      data: {
        reply: result.reply,
        handledBy: result.handledBy,
        escalations: result.escalations,
        conversationId, // client echoes this back to continue the thread
        // true when the system was at capacity and asked the user to retry
        ...(result.shed ? { shed: true } : {}),
      },
    })
  } catch (e) {
    next(e)
  }
})

// ── Public sales agent (marketing site — NO auth) ─────────────────────
// Prospects are anonymous visitors with no GAM account, so this router is
// unauthenticated and rate-limited by IP. The actor is synthetic (the chat
// session id), giving the agent no account-data access — it only answers
// product questions and captures leads.
export const salesAgentRouter = Router()

const salesLimiter = rateLimit({
  windowMs: Number(process.env.SALES_AGENT_RATE_WINDOW_MS) || 60_000,
  max: () => Number(process.env.SALES_AGENT_RATE_MAX) || 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many messages — please wait a moment.' },
})
salesAgentRouter.use(salesLimiter)

const salesChatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) }))
    .max(40)
    .optional(),
})

// POST /api/sales/chat — one sales-conversation turn (public).
salesAgentRouter.post('/chat', async (req, res, next) => {
  try {
    const body = salesChatSchema.parse(req.body)
    const conversationId = body.conversationId ?? randomUUID()
    // Anonymous prospect actor: the session id stands in for identity; the
    // sales profile has no account-data tools, so there's nothing to scope.
    const actor = { userId: conversationId, role: 'prospect', profileId: conversationId }

    const result = await runAgentSession({
      audience: 'prospect',
      actor,
      message: body.message,
      conversationId,
      history: body.history,
    })

    res.json({
      success: true,
      data: {
        reply: result.reply,
        conversationId,
        ...(result.shed ? { shed: true } : {}),
      },
    })
  } catch (e) {
    next(e)
  }
})

// ── S553: sales-call booking (public, rides the sales limiter) ────────
// Prospects book a real-time call with a Portfolio Specialist — in-chat
// via Lucy's tools or directly. Same shared service both ways.
salesAgentRouter.get('/call-slots', async (_req, res, next) => {
  try {
    const slots = await listAvailableSlots()
    res.json({ success: true, data: slots.map((iso) => ({ startsAt: iso, label: formatSlotForHumans(iso) })) })
  } catch (e) { next(e) }
})

salesAgentRouter.post('/call-slots/book', async (req, res, next) => {
  try {
    const b = z.object({
      startsAt: z.string().datetime(),
      mode: z.enum(['video', 'phone']),
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(254),
      phone: z.string().trim().max(40).optional(),
      conversationId: z.string().uuid().optional(),
      notes: z.string().trim().max(2000).optional(),
    }).parse(req.body)
    const result = await bookSalesCall({
      startsAt: b.startsAt, mode: b.mode, name: b.name, email: b.email,
      phone: b.phone ?? null, conversationId: b.conversationId ?? null, notes: b.notes ?? null,
    })
    if (!result.ok) throw new AppError(409, result.error)
    res.status(201).json({ success: true, data: result })
  } catch (e) { next(e) }
})

// ── S596: demo booking (marketing "Book a demo" modal) ────────────────
// Survey → pick a 30-min slot → onto the owner's subscribed calendar. Public +
// unauthenticated; the POST rides a dedicated tight limiter (on top of the
// sales limiter) so a bot can't spray the calendar.
const demoBookLimiter = rateLimit({
  windowMs: Number(process.env.DEMO_BOOK_RATE_WINDOW_MS) || 10 * 60_000,
  max: () => Number(process.env.DEMO_BOOK_RATE_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many booking attempts — please wait a few minutes.' },
})

// GET /api/sales/demo/slots — open 30-min demo slots, grouped by day.
salesAgentRouter.get('/demo/slots', async (_req, res, next) => {
  try {
    const slots = await listAvailableSlots('demo')
    res.json({ success: true, data: { days: groupSlotsByDay(slots) } })
  } catch (e) { next(e) }
})

const demoBookSchema = z.object({
  startsAt:      z.string().datetime(),
  name:          z.string().trim().min(1).max(120),
  email:         z.string().trim().email().max(254),
  phone:         z.string().trim().max(40).optional(),
  timezone:      z.string().trim().max(64).optional(),
  propertyTypes: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
  unitRange:     z.string().trim().max(40).optional(),
  painPoints:    z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  lookingFor:    z.string().trim().max(2000).optional(),
  conversationId: z.string().uuid().optional(),
})

// POST /api/sales/demo — book a demo. Availability + lead-time are re-checked
// server-side inside bookSalesCall; the client's slot choice is never trusted.
salesAgentRouter.post('/demo', demoBookLimiter, async (req, res, next) => {
  try {
    const b = demoBookSchema.parse(req.body)
    const result = await bookSalesCall({
      startsAt: b.startsAt, kind: 'demo', mode: 'video',
      name: b.name, email: b.email, phone: b.phone ?? null,
      timezone: b.timezone ?? null,
      conversationId: b.conversationId ?? null,
      propertyTypes: b.propertyTypes, unitRange: b.unitRange ?? null,
      painPoints: b.painPoints, lookingFor: b.lookingFor ?? null,
    })
    if (!result.ok) throw new AppError(409, result.error)
    res.status(201).json({
      success: true,
      data: { startsAt: result.startsAt, when: result.when, meetingUrl: result.meetingUrl },
    })
  } catch (e) { next(e) }
})

// ── S605: ONBOARDING call booking (post-signup outreach email) ────────
// Same slot engine as the demo above, different kind: a landlord who already
// has an account books an "onboarding call", not a sales demo. One rep + one
// calendar, so listAvailableSlots() already excludes demo-booked starts.
//
// The link in the outreach email carries an opaque token instead of the
// landlord's details in query params (which would leak their email into every
// mail-server log and Referer header en route). The token is traded here,
// server-side, for the name/email we already have on file.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface OnboardingTokenRow {
  user_id: string
  landlord_id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
}

/** Resolve a live token, or null. Enumeration-safe: callers must 404 on null
 *  without distinguishing malformed / unknown / expired. */
async function resolveOnboardingToken(raw: string): Promise<OnboardingTokenRow | null> {
  if (!UUID_RE.test(raw)) return null
  return queryOne<OnboardingTokenRow>(
    `SELECT t.user_id, t.landlord_id, u.first_name, u.last_name, u.email, u.phone
       FROM landlord_onboarding_booking_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token = $1::uuid AND t.expires_at > now()`,
    [raw])
}

// GET /api/sales/onboarding/prefill/:token — the booking form's identity read.
// Returns ONLY what the form renders. No portfolio, no account state, no
// anything else the token holder shouldn't be handed.
salesAgentRouter.get('/onboarding/prefill/:token', async (req, res, next) => {
  try {
    const row = await resolveOnboardingToken(req.params.token)
    if (!row) { res.status(404).json({ success: false, error: 'Not found' }); return }
    // S605: THIS is the read receipt worth having. Reaching this endpoint means
    // the landlord opened the outreach email AND clicked through to book —
    // first-party, server-side, and it proves intent rather than proving an
    // image loaded (which is all an open pixel shows, and Apple Mail pre-fetches
    // those for everyone anyway). Best-effort: never let tracking break booking.
    void query(
      `UPDATE landlord_onboarding_booking_tokens
          SET first_clicked_at = COALESCE(first_clicked_at, now()),
              click_count = click_count + 1
        WHERE token = $1::uuid`,
      [req.params.token]
    ).catch(() => {})
    res.json({
      success: true,
      data: {
        firstName: row.first_name,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
        email: row.email,
        phone: row.phone,
      },
    })
  } catch (e) { next(e) }
})

// GET /api/sales/onboarding/slots — open onboarding slots, grouped by day.
salesAgentRouter.get('/onboarding/slots', async (_req, res, next) => {
  try {
    const slots = await listAvailableSlots('onboarding')
    res.json({ success: true, data: { days: groupSlotsByDay(slots) } })
  } catch (e) { next(e) }
})

// POST /api/sales/onboarding — book it. The token is REQUIRED and is the only
// accepted source of identity: name/email come off the token row, never off the
// request body, so a stranger who guessed the endpoint can't book in someone
// else's name. Availability + lead time are re-checked inside bookSalesCall.
salesAgentRouter.post('/onboarding', demoBookLimiter, async (req, res, next) => {
  try {
    const b = z.object({
      token:         z.string().trim(),
      startsAt:      z.string().datetime(),
      timezone:      z.string().trim().max(64).optional(),
      propertyTypes: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
      unitRange:     z.string().trim().max(40).optional(),
      painPoints:    z.array(z.string().trim().min(1).max(80)).max(20).optional(),
      lookingFor:    z.string().trim().max(2000).optional(),
    }).parse(req.body)

    const who = await resolveOnboardingToken(b.token)
    if (!who) throw new AppError(404, 'That booking link has expired — reply to the email and we’ll send a fresh one.')

    const result = await bookSalesCall({
      startsAt: b.startsAt, kind: 'onboarding', mode: 'video',
      name: [who.first_name, who.last_name].filter(Boolean).join(' ').trim() || who.email,
      email: who.email, phone: who.phone,
      timezone: b.timezone ?? null,
      propertyTypes: b.propertyTypes, unitRange: b.unitRange ?? null,
      painPoints: b.painPoints, lookingFor: b.lookingFor ?? null,
      notes: 'Booked from the post-signup onboarding outreach email.',
    })
    if (!result.ok) throw new AppError(409, result.error)

    // Visibility only — never gates redemption, so rescheduling from the same
    // email keeps working (see the migration header).
    await query(
      `UPDATE landlord_onboarding_booking_tokens SET used_at = now() WHERE token = $1::uuid`,
      [b.token]).catch(() => {})

    res.status(201).json({
      success: true,
      data: { startsAt: result.startsAt, when: result.when, meetingUrl: result.meetingUrl },
    })
  } catch (e) { next(e) }
})

// ── Booking-guest agent (NO login — bearer token) ─────────────────────
// A no-account booking guest reaches their stay assistant via a per-booking
// access token (delivered by email-link or on-site QR). The token IS the
// identity: it resolves to exactly one booking, and the guest actor is
// scoped to it server-side — the model never chooses the booking. Rate-
// limited by token so one stay can't saturate the fleet.
export const guestAgentRouter = Router()

const guestLimiter = rateLimit({
  windowMs: Number(process.env.GUEST_AGENT_RATE_WINDOW_MS) || 60_000,
  max: () => Number(process.env.GUEST_AGENT_RATE_MAX) || 20,
  keyGenerator: (req) => (typeof req.body?.token === 'string' ? req.body.token : req.ip) ?? 'anonymous',
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "You're sending messages too quickly — please wait a moment." },
})
guestAgentRouter.use(guestLimiter)

const guestChatSchema = z.object({
  token: z.string().min(16).max(128),
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) }))
    .max(40)
    .optional(),
})

// POST /api/guest/chat — one stay-assistant turn (token-authenticated).
guestAgentRouter.post('/chat', async (req, res, next) => {
  try {
    const body = guestChatSchema.parse(req.body)
    const guest = await resolveBookingGuestToken(body.token)
    if (!guest) {
      throw new AppError(401, 'This stay link is invalid or has expired. Ask your host for a new one.')
    }

    // The guest actor is bound entirely to the token's booking. profileId and
    // bookingId are the booking id; userId carries the token id (no GAM user).
    const actor = {
      userId: guest.tokenId,
      role: 'guest',
      profileId: guest.bookingId,
      bookingId: guest.bookingId,
    }

    // Server-owned history, same posture as the authenticated door: continue a
    // thread by id (ownership = the token's booking), else mint a new id.
    let conversationId = body.conversationId
    let history: ChatMessage[] | undefined = body.history
    if (conversationId) {
      history = await loadGuestConversationHistory(conversationId, guest.bookingId)
    } else {
      conversationId = randomUUID()
    }

    const result = await runAgentSession({
      audience: 'guest',
      actor,
      message: body.message,
      conversationId,
      history,
    })

    res.json({
      success: true,
      data: {
        reply: result.reply,
        conversationId,
        ...(result.shed ? { shed: true } : {}),
      },
    })
  } catch (e) {
    next(e)
  }
})

// ── Public property agent (a landlord's booking subdomain — NO auth) ──
// The pre-booking property host (Skye): a visitor browsing ONE property's public
// booking site asks about pricing/availability and can start a reservation.
// Unauthenticated + IP-rate-limited; the actor is synthetic (the chat session
// id) and HARD-SCOPED to the property the slug resolves to, so the agent can
// only ever read/book that one property — never a neighboring one. History is
// client-supplied (localStorage), same posture as the sales door.
export const propertyAgentRouter = Router()

const propertyAgentLimiter = rateLimit({
  windowMs: Number(process.env.PROPERTY_AGENT_RATE_WINDOW_MS) || 60_000,
  max: () => Number(process.env.PROPERTY_AGENT_RATE_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many messages — please wait a moment.' },
})
propertyAgentRouter.use(propertyAgentLimiter)

const propertyChatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) }))
    .max(40)
    .optional(),
})

// POST /api/property/:slug/agent/chat — one property-agent turn (public).
propertyAgentRouter.post('/:slug/agent/chat', async (req, res, next) => {
  try {
    const body = propertyChatSchema.parse(req.body)
    // Resolve slug → property FIRST. resolveProperty 404s unless the booking
    // site is published, so a disabled/unknown slug can never open a chat.
    const prop = await resolveProperty(req.params.slug)
    const conversationId = body.conversationId ?? randomUUID()
    // Anonymous visitor actor, HARD-SCOPED to this property: the session id is
    // the identity; profileId + propertyId are the property id, so every
    // property tool binds to this one property and nothing else.
    const actor = { userId: conversationId, role: 'visitor', profileId: prop.id, propertyId: prop.id }

    const result = await runAgentSession({
      audience: 'visitor',
      actor,
      message: body.message,
      conversationId,
      history: body.history,
    })

    res.json({
      success: true,
      data: {
        reply: result.reply,
        conversationId,
        ...(result.shed ? { shed: true } : {}),
      },
    })
  } catch (e) {
    next(e)
  }
})
