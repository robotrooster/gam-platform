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
import { loadConversationHistory, loadGuestConversationHistory } from '../services/agents/conversationHistory'
import { resolveBookingGuestToken } from '../services/bookingGuestTokens'
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
