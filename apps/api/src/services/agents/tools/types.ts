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

export interface AgentActor {
  /** users.id of the logged-in caller. For a token-scoped booking guest
   *  (role='guest') there is no GAM account — this carries the access-token
   *  id instead, and no users-table row is implied. */
  userId: string
  /** caller role, e.g. 'tenant' | 'landlord' | 'guest' */
  role: string
  /** profile id: tenant uuid when role='tenant', landlord id when 'landlord',
   *  booking id when role='guest'. */
  profileId: string
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
