/**
 * Agent tool layer — types (Step 4).
 *
 * A tool is a scoped GAM action the agent may invoke. The critical
 * safety property: a tool reads/writes ONLY the logged-in user's own
 * data. Identity comes from the AgentActor — injected server-side by
 * the caller (the route that runs the agent), derived from the JWT.
 * The model supplies a tool's ARGUMENTS (e.g. a maintenance title) but
 * NEVER the actor — it cannot choose whose records to touch.
 */

import type { AgentAudience } from '../types'

/**
 * S634 — WHICH COMPANIES DOES THIS ACTOR'S ACCOUNT OWN?
 *
 * Nic (DIRECTIVE, S633): "Account ownership is no correlation to a specific
 * entity. Entities own properties. The account owns the entities."
 *
 * Every landlord tool scopes its SQL by landlord_id, and until now each read
 * `actor.profileId` — the ONE company a session used to sit on. An account that
 * owns two got answers about one of them, silently: the agent would report a
 * portfolio, an occupancy figure or a delinquency list that was true of half
 * the business and looked like the whole of it. That is worse than an error,
 * because a wrong number spoken confidently is one somebody acts on.
 *
 * Use this in every landlord-audience tool, with
 * `WHERE landlord_id = ANY($n::uuid[])`. A landlord actor's profileId is EMPTY
 * (S634) — there is nothing else to read.
 *
 * For a TENANT actor profileId is their `tenants.id` and is still exactly
 * right — tenant tools must keep using it, and this returns an empty array for
 * them so a misuse scopes to nothing rather than to a tenant id that would read
 * as a company.
 */
export function actorLandlordIds(actor: AgentActor): string[] {
  if (actor.role !== 'landlord') return []
  return Array.from(new Set((actor.landlordIds ?? []).filter(Boolean)))
}

export interface AgentActor {
  /** users.id of the logged-in caller. For a token-scoped booking guest
   *  (role='guest') there is no GAM account — this carries the access-token
   *  id instead, and no users-table row is implied. */
  userId: string
  /** caller role, e.g. 'tenant' | 'landlord' | 'guest' */
  role: string
  /** profile id: tenant uuid when role='tenant', booking id when role='guest'.
   *
   *  S634 — EMPTY FOR A LANDLORD, ON PURPOSE.
   *  An account is not an entity; it owns entities (see lib/landlordScope).
   *  `landlordIds` below is a landlord actor's scope, full stop, and every
   *  landlord tool reads it through actorLandlordIds(). This is left EMPTY
   *  rather than pinned to the account's first company so that a tool which
   *  still reached for it scopes to nothing and becomes visible, instead of
   *  quietly answering for one company out of several — which is the failure
   *  this release exists to remove. */
  profileId: string
  /** S633/S634: every company the ACCOUNT owns. Empty for non-landlord actors.
   *  This — not profileId — is a landlord actor's scope. */
  landlordIds?: string[]
  /** the unit_bookings.id a guest actor is scoped to. Set ONLY for
   *  role='guest'; guest tools read/write only this one booking. */
  bookingId?: string
  /** the properties.id a visitor actor is scoped to. Set ONLY for
   *  role='visitor' (an unauthenticated property-website visitor); visitor
   *  tools read/write only this one property, never a neighboring one. */
  propertyId?: string
  /**
   * S626 — the caller's own verified JWT claims, forwarded from routes/agent.ts.
   *
   * Present ONLY for a signed-in human. It exists so an action tool can perform
   * the action through the REAL endpoint, with the REAL authorization, instead
   * of a second copy of the route's logic that drifts from it.
   *
   * Authentication is not being skipped: requireAuth already ran on the request
   * that reached the agent, and this is the payload it produced. What this
   * preserves is AUTHORIZATION — requirePerm reads req.user.permissions, and
   * without these claims a staff member's agent would be denied everything
   * their portal allows.
   *
   * NEVER shown to the model, never logged, and absent for anonymous audiences
   * (prospect, visitor, token-scoped guest), which is why dispatch fails closed
   * for them.
   */
  auth?: Record<string, unknown>
}

export interface AgentTool {
  /** function name the model calls */
  name: string
  /** description the model sees — say when to use it */
  description: string
  /** JSON Schema for the arguments the model supplies */
  parameters: Record<string, unknown>
  /** which audiences may use this tool (defense in depth vs the profile allowlist) */
  audiences: AgentAudience[]
  /** run the tool, hard-scoped to `actor`. Return value is JSON-serialized
   *  back to the model as the tool result. */
  execute(args: Record<string, unknown>, actor: AgentActor): Promise<unknown>
}
