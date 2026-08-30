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
import { query } from '../../db'
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const norm = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * A unit id from what the landlord actually said. See the note at the call site.
 *
 * Resolution is deliberately conservative, because the actions behind it include
 * eviction: an exact number match, or a unique numeric match, and otherwise a
 * refusal listing the real candidates. It never guesses between two units.
 */
async function resolveUnitId(
  raw: unknown, actor: AgentActor,
): Promise<{ ok: true; unitId: string } | { ok: false; refusal: DispatchResult }> {
  const given = String(raw ?? '').trim()
  if (!given) {
    return { ok: false, refusal: { ok: false, refused: 'missing_param',
      error: 'Which unit? Ask them for the unit number — you do not need an id.' } }
  }
  // Already a real id from a lookup; S628's traceability guard has vetted it.
  if (UUID_RE.test(given)) return { ok: true, unitId: given }

  let rows: Array<{ id: string; unit_number: string }> = []
  try {
    rows = await query<{ id: string; unit_number: string }>(
      `SELECT un.id, un.unit_number
         FROM units un
         JOIN properties p ON p.id = un.property_id
        WHERE p.landlord_id = $1 AND un.retired_at IS NULL`,
      [actor.profileId])
  } catch (e) {
    // Fail CLOSED. If the unit list cannot be read there is no safe way to turn
    // a spoken number into an id, and guessing is the one thing this must not
    // do — the actions behind it include eviction.
    logger.error({ err: e, landlordId: actor.profileId },
      'agent dispatch: could not resolve a unit number — refusing rather than guessing')
    return { ok: false, refusal: { ok: false, refused: 'missing_param',
      error: 'I could not confirm which unit that is. Ask them for the unit number and try again.' } }
  }

  const exact = rows.filter((r) => norm(r.unit_number) === norm(given))
  if (exact.length === 1) return { ok: true, unitId: exact[0].id }

  // "spot 7" against "RV 07" — the number is the part a landlord means. Only
  // when it lands on exactly one unit; two matches is a question, not a guess.
  const digits = given.match(/\d+/)
  if (digits) {
    const n = parseInt(digits[0], 10)
    const byNumber = rows.filter((r) => {
      const d = String(r.unit_number).match(/\d+/)
      return d != null && parseInt(d[0], 10) === n
    })
    if (byNumber.length === 1) return { ok: true, unitId: byNumber[0].id }
    if (byNumber.length > 1) {
      return { ok: false, refusal: { ok: false, refused: 'missing_param',
        error: `"${given}" matches more than one unit — ${byNumber.map((r) => r.unit_number).join(', ')}. ` +
               'Ask which one they mean and use that number. Do NOT pick one.' } }
    }
  }

  const known = rows.map((r) => r.unit_number).filter(Boolean).sort()
  return { ok: false, refusal: { ok: false, refused: 'missing_param',
    error: `There is no unit "${given}" on this account. ` +
           (known.length ? `Their units are: ${known.join(', ')}. ` : '') +
           'Ask which one they mean. Never invent an id.' } }
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

  // S630 — RESOLVE THE LANDLORD'S OWN WORDS INTO A UNIT ID.
  //
  // S628 stopped an invented id from reaching a mutating endpoint, which was
  // right, but left the landlord no way through. The measured transcript, twice:
  //
  //   ▸ I'm starting an eviction on spot 7
  //     "I need the unit ID to enable eviction mode..."
  //   ▸ yes, turn it on
  //     → set_eviction_mode({ unitId: 'unit_12345' })   ← invented, refused
  //
  // The unit id is an internal uuid. A landlord does not have one and never
  // will; they have "spot 7". The model was being asked to chain a lookup it
  // does not reliably chain, and when it failed it either asked the landlord for
  // a uuid or made one up. Every S628 action case in the two-turn run died here.
  //
  // So a non-uuid unitId is read as what it plainly is — a unit NUMBER — and
  // resolved here, against this landlord's own units only. Scoped by
  // landlord_id, so it cannot reach a neighbour's unit no matter what the model
  // passes. An ambiguous or unknown number is REFUSED with the real list, which
  // turns a dead end into a question the landlord can answer.
  if (actor.role === 'landlord' && (action.pathParams ?? []).includes('unitId')) {
    const resolved = await resolveUnitId(args.unitId, actor)
    if (!resolved.ok) return resolved.refusal
    args = { ...args, unitId: resolved.unitId }
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
