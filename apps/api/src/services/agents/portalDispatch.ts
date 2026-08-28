/**
 * S626 — THE AGENT USES THE SAME API THE PORTAL USES.
 *
 * Nic: "when there is a gap between what the agent can do and what the landlord
 * or tenant can do manually in the portal, you need to keep training the agent,
 * giving it skills, doing whatever you need to do... It needs to be the Jarvis
 * of our software."
 *
 * Measured, the gap was 243 of 341 reachable actions. Closing that by writing a
 * bespoke tool per endpoint means 243 second copies of route logic, every one of
 * them free to drift the moment the route changes — and route logic is where the
 * eviction pauses, the fee waivers and the ownership checks live. A copy that
 * drifts on one of those is worse than no tool at all.
 *
 * So an action tool does not reimplement the endpoint. It CALLS it, over
 * loopback, with the caller's own claims, and every piece of middleware runs for
 * real: requireAuth, requirePerm, the scope checks, the zod body validation, the
 * rate limiter. Parity is structural rather than maintained.
 *
 * WHAT KEEPS THIS SAFE
 *
 *  - An ALLOWLIST. Only actions declared in portalActions.ts can be reached, so
 *    "cannot do anything that is not relevant" is enforced by construction
 *    rather than by asking the model nicely. Admin, business, POS and public
 *    surfaces are not in it and cannot be reached by adding words to a prompt.
 *  - The audience must match. A tenant action is unreachable from a landlord
 *    agent and the reverse, checked before anything is sent.
 *  - FAIL CLOSED. No claims — an anonymous prospect, a site visitor, a
 *    token-scoped guest — means no dispatch at all.
 *  - The internal token lives for sixty seconds and carries the caller's own
 *    claims, nothing added. It cannot widen anyone's authority; it can only
 *    exercise what they already had.
 */
import jwt from 'jsonwebtoken'
import { logger } from '../../lib/logger'
import { getPortalAction, type PortalAction } from './portalActions'
import type { AgentActor } from './tools/types'

/** Injected in tests so the suite never needs a listening server. */
export type Transport = (url: string, init: any) => Promise<{ status: number; json: any }>
let transport: Transport | null = null
export function __setTransport(t: Transport | null) { transport = t }

const BASE = () => process.env.AGENT_DISPATCH_BASE || `http://127.0.0.1:${process.env.PORT || 4000}`

/**
 * Actions that actually MOVE money, as opposed to recording that money moved.
 *
 * Deliberately short. pay_bill, record_cash_payment and the rest write a record
 * of something that already happened outside GAM — running those in a test
 * dirties demo data and nothing more. These two reach Stripe.
 */
const MOVES_MONEY = new Set(['pay_my_balance', 'set_up_autopay'])

async function defaultTransport(url: string, init: any) {
  const res = await fetch(url, init)
  let json: any = null
  try { json = await res.json() } catch { json = null }
  return { status: res.status, json }
}

/** Sixty seconds, the caller's own claims, nothing added. */
function mintInternalToken(auth: Record<string, unknown>): string {
  const { iat, exp, ...claims } = auth as any
  return jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: 60 })
}

export interface DispatchResult {
  ok: boolean
  status?: number
  data?: unknown
  error?: string
  /** Set when the refusal is ours rather than the API's. */
  refused?: 'unknown_action' | 'wrong_audience' | 'no_credentials' | 'missing_param'
}

export async function dispatchPortalAction(
  actionId: string, args: Record<string, unknown>, actor: AgentActor,
): Promise<DispatchResult> {
  const action = getPortalAction(actionId)
  if (!action) {
    return { ok: false, refused: 'unknown_action', error: `No such action: ${actionId}` }
  }
  if (action.audience !== actor.role) {
    // Belt and braces — the profile should never have offered it.
    return { ok: false, refused: 'wrong_audience', error: 'That action does not belong to this user.' }
  }
  // S628 — A TEST RUN MUST NOT MOVE REAL MONEY.
  //
  // The conversation harness runs against DB_NAME=gam, which IS the production
  // database, with LIVE Stripe keys — and once the harness actors were given
  // real credentials (agentActors.ts) every allowlisted action became genuinely
  // executable from a test. `pay_my_balance` charges a saved payment method.
  //
  // Today it would have failed harmlessly because the demo tenant has no Stripe
  // customer on file. That is luck, not a control, and it stops being true the
  // first time somebody seeds a demo card. Set AGENT_HARNESS_NO_MONEY=1 in any
  // batch run; the refusal is worded so the agent still says something true
  // rather than claiming a payment went through.
  if (process.env.AGENT_HARNESS_NO_MONEY === '1' && MOVES_MONEY.has(actionId)) {
    logger.warn({ actionId }, 'agent dispatch: money action blocked — harness mode')
    return {
      ok: false, refused: 'no_credentials',
      error: 'Payments are disabled in this environment. Say plainly that the payment could NOT ' +
        'be taken and do NOT claim it went through.',
    }
  }

  if (!actor.auth) {
    return {
      ok: false, refused: 'no_credentials',
      error: 'This conversation is not signed in, so nothing can be done on the account. Say so plainly and do not claim it was done.',
    }
  }

  // Path params are substituted; everything else becomes the body. A missing
  // path param would otherwise produce a URL with ":id" in it and a confusing
  // 404 from the router.
  let path = action.path
  for (const key of action.pathParams ?? []) {
    const v = args[key]
    if (v == null || String(v).trim() === '') {
      return { ok: false, refused: 'missing_param', error: `${key} is required for this action.` }
    }
    path = path.replace(`:${key}`, encodeURIComponent(String(v)))
  }
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if ((action.pathParams ?? []).includes(k)) continue
    if (v !== undefined) body[k] = v
  }

  const send = transport ?? defaultTransport
  const url = `${BASE()}${path}`
  const started = Date.now()
  let res: { status: number; json: any }
  try {
    res = await send(url, {
      method: action.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mintInternalToken(actor.auth)}`,
        // Marks the call in logs as coming from the assistant rather than a
        // browser, so an audit can tell them apart.
        'X-GAM-Actor': 'agent',
      },
      body: action.method === 'GET' ? undefined : JSON.stringify(body),
    })
  } catch (e: any) {
    logger.error({ err: e, actionId }, 'agent dispatch: could not reach the API')
    return { ok: false, error: 'Could not complete that just now. Do NOT tell them it was done.' }
  }

  const okStatus = res.status >= 200 && res.status < 300
  logger.info({ actionId, status: res.status, ms: Date.now() - started, role: actor.role },
    'agent dispatch')

  if (!okStatus) {
    // The API's own message is the honest one — it knows why it said no.
    const msg = res.json?.error || res.json?.message || `The action was refused (${res.status}).`
    return {
      ok: false, status: res.status, error: String(msg),
      ...(res.status === 403 ? { refused: 'wrong_audience' as const } : {}),
    }
  }
  return { ok: true, status: res.status, data: res.json?.data ?? res.json ?? null }
}

export type { PortalAction }
