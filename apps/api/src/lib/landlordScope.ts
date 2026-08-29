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

/**
 * The entity ids this user may read. For a landlord: the entity they own plus
 * every entity they co-own. For anyone else: their resolved landlordId, so
 * team roles keep working exactly as before.
 */
export function landlordScopeIds(user: AuthPayload): string[] {
  if (user.role === 'landlord') {
    return Array.from(new Set([user.profileId, ...(user.landlordIds ?? [])].filter(Boolean))) as string[]
  }
  const single = user.landlordId ?? user.profileId
  return single ? [single] : []
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
