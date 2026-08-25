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
