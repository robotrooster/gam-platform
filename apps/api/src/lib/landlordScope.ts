/**
 * Every landlord entity a request may read from.
 *
 * S620 (Nic, on his co-owner opening Oak Park): "he sees Oak Park as a
 * property, but it's showing zero units, zero out of zero occupied."
 *
 * THE PATTERN THIS FIXES. A landlord's own data is scoped all over the API by
 * `req.user.profileId` — the single entity they are the registered owner of.
 * That was correct while a person had exactly one. It stopped being correct
 * when co-ownership landed: a co-owner's profileId is the empty entity that
 * registering created so they could accept the invite, so anything filtered by
 * it returns nothing for the property they were actually invited to.
 *
 * The result is a screen that half-works, which is worse than one that fails:
 * the property was listed (that query scoped differently) while its units,
 * occupancy and everything below them came back empty. Nothing errored. It just
 * looked like Oak Park had no units.
 *
 * profileId + landlordIds is the same set the dashboard has always used, where
 * the comment quotes Nic: "I see everything combined for mine, without the two
 * mixing." This makes that set reusable instead of re-derived per endpoint.
 *
 * NOT a blanket fix — there are ~380 uses of profileId across the routes and
 * most are not landlord-entity scoping at all (tenant ids, team user ids,
 * business ids). Apply this deliberately, where the thing being filtered is a
 * landlord's own book.
 */
import type { AuthPayload } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'

/**
 * The entity ids this user may read. For a landlord: the entity they own plus
 * every entity they co-own. For anyone else: their resolved landlordId, so
 * team roles keep working exactly as before.
 */
export function landlordScopeIds(user: AuthPayload): string[] {
  // S633: for a landlord this is the ACCOUNT's entities and nothing else.
  // profileId used to be folded in as "their own" entity; it no longer names one
  // (see routes/auth.ts), and an account is not an entity.
  if (user.role === 'landlord') {
    return Array.from(new Set((user.landlordIds ?? []).filter(Boolean))) as string[]
  }
  // Team roles are genuinely scoped to ONE landlord, carried as the landlordId
  // claim (S82). Everyone else has no landlord scope at all.
  //
  // S633 — THE `?? user.profileId` FALLBACK IS GONE, AND IT MATTERED.
  //
  // It existed for pre-S82 team tokens that carried the landlord id in
  // profileId. But profileId is whatever the role's own profile row is: for a
  // TENANT it is their `tenants.id`. So a tenant asking for a landlord scope got
  // back `[their own tenant id]` — a non-empty array that then read as "this
  // account owns exactly one company", and resolveLandlordTarget would hand that
  // tenant id back as the company to write against. Caught by the terminal
  // suite's "caller with perm but no landlord scope (tenant) → 400", which
  // started returning 200.
  //
  // The list is explicit for that reason: a role that is not on it has no
  // landlord scope, and gets an empty array rather than a plausible-looking id.
  const TEAM_ROLES = ['property_manager', 'onsite_manager', 'maintenance', 'bookkeeper']
  if (!TEAM_ROLES.includes(user.role)) return []
  return user.landlordId ? [user.landlordId] : []
}

/**
 * S629 — MEMBERSHIP IS A FACT IN THE DATABASE, NOT A FACT IN THE TOKEN.
 *
 * `landlordIds` is baked into the JWT at login. An entity created AFTER that
 * login therefore does not exist as far as any synchronous scope check is
 * concerned, and the session that created it is the one session that cannot
 * use it.
 *
 * Measured on a real landlord, and it cost him his whole evening: he signed up
 * on Aug 24, created "TruBlu Management LLC" on Aug 28, and could not save a
 * property under it. The Add Property form reads entities from the DATABASE,
 * so the picker offered the new entity; the route checked the TOKEN, did not
 * find it, and returned "You are not a member of that entity". Nothing in the
 * message hinted that logging out and back in would fix it, so from his side
 * the product simply refused to save, with no way forward.
 *
 * The token stays the fast path — it is right the overwhelming majority of the
 * time and costs no query. The DB is consulted only when the token says no,
 * which is exactly the case where the token may be out of date. That ordering
 * matters: it cannot LOOSEN the check (a real membership row is required
 * either way), it can only stop a stale token from denying a true one.
 */
export async function isEntityMember(
  user: AuthPayload,
  landlordId: string,
  q: <T>(sql: string, params: unknown[]) => Promise<T[]>,
): Promise<boolean> {
  if (landlordScopeIds(user).includes(landlordId)) return true
  const rows = await q<{ one: number }>(
    `SELECT 1 AS one FROM landlord_members WHERE user_id = $1 AND landlord_id = $2 LIMIT 1`,
    [user.userId, landlordId],
  )
  return rows.length > 0
}

/**
 * S633 — THE ACCOUNT IS NOT AN ENTITY.
 *
 * Nic (DIRECTIVE, verbatim): "My account should be an account level setting.
 * Each property could be linked individually to an entity or multiple properties
 * to the same entity outside of the account controlling it. I don't want my
 * account entity to be Oak Park. I want my account to just be my account. People
 * buy and sell entities all the time. That's just a stupid structure. Things
 * need to be set at the entity level, but the account needs to not be any entity
 * at all. It needs to be sitting outside of it."
 *
 * A landlord's SESSION used to *be* one `landlords` row: `users.active_landlord_id`
 * picked it, login stamped it into the JWT as `profileId`, and every landlord
 * call site read `profileId` as "the landlord". A person who owns two companies
 * was therefore only ever half signed in — and it did not fail loudly, it
 * returned an empty list. Three separate bugs in one day traced to this: meters
 * 404ing at his own park, a billing-cycle card that could not reach his second
 * company, and an invite that refused a unit he owns.
 *
 * The replacement is two rules, and every landlord call site is one of them:
 *
 *   READS  span every entity the account owns   -> landlordScopeIds()
 *   WRITES take an explicit target, authorised  -> the resolvers below
 *
 * Once both hold, `profileId` no longer decides what a landlord can see or
 * touch, which is exactly what "the account sits outside the entities" means.
 * It survives in the token only as the founding entity — a creation default for
 * an account that owns exactly one — and never as identity.
 */

/**
 * The entity a WRITE lands on, when the caller names it.
 *
 * `explicit` is the entity id from the request body/query. Three outcomes, and
 * the third is the one that matters:
 *
 *  - named and owned      -> that entity
 *  - named and not owned  -> 403, in a sentence
 *  - not named            -> the account's only entity, or 400 asking which
 *
 * The last branch is deliberately a 400 and not a silent default. Defaulting to
 * "whichever entity the session sat on" is the entire bug this replaces: it
 * created a property under the wrong company without ever saying so, and a
 * property under the wrong company is a record that has to be unwound by hand.
 * Asking is cheap; guessing is not.
 *
 * `what` names the thing being created so the message can be about the user's
 * problem ("Choose which company this property belongs to") rather than ours.
 */
export function resolveLandlordTarget(
  user: AuthPayload,
  explicit: string | null | undefined,
  what = 'record',
): string {
  if (explicit) {
    if (!canManageLandlordResource(user, explicit, [])) {
      throw new AppError(403, 'That company is not yours to act on.')
    }
    return explicit
  }
  const owned = landlordScopeIds(user)
  if (owned.length === 1) return owned[0]
  // 400, not 403, and deliberately: this is the long-standing "No landlord scope
  // on this user" contract that admins, tenants and unscoped callers have always
  // received from these endpoints. The refactor changes WHICH company a write
  // lands on; it must not change the status code a client already handles.
  if (owned.length === 0) throw new AppError(400, 'No landlord scope on this user')
  throw new AppError(400,
    `You own more than one company. Choose which one this ${what} belongs to.`)
}

/**
 * The entity a write lands on, DERIVED FROM THE PROPERTY it concerns.
 *
 * The best answer to "which company?" is almost always "the one that owns the
 * property you just named", and most write paths already carry a propertyId.
 * Deriving beats asking: there is nothing for the caller to get wrong, and the
 * authorisation is the same check either way.
 *
 * 403, never 404, when the property exists but belongs to someone else — the
 * distinction is deliberate. A 404 tells a landlord their own property does not
 * exist, which is what sent Nic looking for a banner that could not render.
 */
export async function landlordIdForProperty(
  user: AuthPayload,
  propertyId: string,
  q: <T>(sql: string, params: unknown[]) => Promise<T[]>,
): Promise<string> {
  const rows = await q<{ landlord_id: string }>(
    `SELECT landlord_id FROM properties WHERE id = $1`, [propertyId])
  if (!rows.length) throw new AppError(404, 'Property not found')
  const landlordId = rows[0].landlord_id
  if (!canManageLandlordResource(user, landlordId, [])) {
    throw new AppError(403, 'That property is not yours to act on.')
  }
  return landlordId
}

/**
 * Does this request concern an entity the account owns? Read-side companion to
 * the resolvers, for the "is this row mine" check that follows a lookup.
 *
 * Kept here rather than called inline as `landlordScopeIds(u).includes(x)` so
 * the intent reads at the call site, and so a single place can be found again
 * when the rule changes.
 */
export function ownsLandlord(user: AuthPayload, landlordId: string | null | undefined): boolean {
  if (!landlordId) return false
  return landlordScopeIds(user).includes(landlordId)
}

/**
 * The entity a write lands on, DERIVED FROM THE UNIT it concerns.
 *
 * Same reasoning as landlordIdForProperty: most unit-level writes already name
 * the unit, and the unit knows its company. `units.landlord_id` is denormalised
 * from the property, so this is one lookup rather than a join.
 */
export async function landlordIdForUnit(
  user: AuthPayload,
  unitId: string,
  q: <T>(sql: string, params: unknown[]) => Promise<T[]>,
): Promise<string> {
  const rows = await q<{ landlord_id: string }>(
    `SELECT landlord_id FROM units WHERE id = $1`, [unitId])
  if (!rows.length) throw new AppError(404, 'Unit not found')
  const landlordId = rows[0].landlord_id
  if (!canManageLandlordResource(user, landlordId, [])) {
    throw new AppError(403, 'That unit is not yours to act on.')
  }
  return landlordId
}
