/**
 * The five test actors, built EXACTLY as their doors in routes/agent.ts build
 * them.
 *
 * S620: extracted so the single-turn battery and the two-turn conversation
 * harness cannot drift apart. An actor shaped differently from production is a
 * test of a code path that does not exist — a tenant actor missing profileId
 * scopes every lookup to nothing and every case "passes" by failing quietly.
 */
import { query } from '../../db'
import { randomUUID } from 'crypto'

export interface TestActors {
  actorFor: (audience: string) => any
  bookingId: string | null
  siteId: string | null
}

export async function buildTestActors(): Promise<TestActors> {
  const [tenant] = await query<any>(
    `SELECT u.id AS user_id, t.id AS tenant_id
       FROM users u JOIN tenants t ON t.user_id = u.id
       JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status='active'
       JOIN leases l ON l.id = lt.lease_id AND l.status='active'
      WHERE u.email = 'bob@tenant.dev' LIMIT 1`)
  const [lord] = await query<any>(
    `SELECT u.id AS user_id, ll.id AS landlord_id
       FROM users u JOIN landlords ll ON ll.user_id = u.id
      WHERE u.email = 'james@demo.dev' LIMIT 1`)
  if (!tenant || !lord) throw new Error('test actors missing — seed the demo data first')

  // PINNED fixtures, not "whichever comes back first" — see agentBattery.ts.
  const [booking] = await query<any>(
    `SELECT b.id FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.status = 'checked_in' AND p.booking_slug = 'sunset-palms'
      ORDER BY b.check_in DESC LIMIT 1`)
  const [site] = await query<any>(
    `SELECT id FROM properties
      WHERE booking_slug = 'sunset-palms' AND public_booking_enabled = true LIMIT 1`)

  /**
   * S628 — THE HARNESS ACTORS NEED CREDENTIALS, OR EVERY ACTION IS REFUSED.
   *
   * portalDispatch mints a short-lived token from `actor.auth` — the caller's
   * own verified claims, forwarded by routes/agent.ts so an action runs through
   * the real endpoint with the real authorization. Without that field it
   * refuses with `no_credentials` before a request is even built.
   *
   * These actors had no `auth`, so all 207 allowlisted actions were unreachable
   * from the harness. Every conversation testing one would have failed — and
   * failed looking like an agent that would not act, which is the exact
   * question the run exists to answer. A whole afternoon's validation would
   * have measured a missing field.
   *
   * The claims mirror what routes/auth.ts actually signs. `permissions: null`
   * is what an OWNER carries — owner roles bypass requirePerm — so this
   * exercises the same authority a landlord has in their own portal, and no
   * more. A staff-scoped harness actor would be a worthwhile addition later:
   * requirePerm running against a real permission list is the half of the
   * dispatcher's safety story that nothing currently drives.
   */
  const authFor = (userId: string, role: string, profileId: string, landlordId: string | null) => ({
    userId, role, profileId,
    landlordId,
    landlordIds: landlordId ? [landlordId] : [],
    permissions: null,
  })

  const actorFor = (a: string): any => {
    switch (a) {
      case 'tenant':
        return {
          userId: tenant.user_id, role: 'tenant', profileId: tenant.tenant_id,
          auth: authFor(tenant.user_id, 'tenant', tenant.tenant_id, null),
        }
      case 'landlord':
        return {
          userId: lord.user_id, role: 'landlord', profileId: lord.landlord_id,
          auth: authFor(lord.user_id, 'landlord', lord.landlord_id, lord.landlord_id),
        }
      case 'prospect': {
        const id = randomUUID()
        return { userId: id, role: 'prospect', profileId: id }
      }
      case 'guest':
        if (!booking) throw new Error('no checked-in booking at sunset-palms for the guest actor')
        return { userId: randomUUID(), role: 'guest', profileId: booking.id, bookingId: booking.id }
      case 'visitor': {
        if (!site) throw new Error('sunset-palms booking site not published for the visitor actor')
        const id = randomUUID()
        return { userId: id, role: 'visitor', profileId: site.id, propertyId: site.id }
      }
      default:
        throw new Error(`no actor for audience '${a}'`)
    }
  }

  return { actorFor, bookingId: booking?.id ?? null, siteId: site?.id ?? null }
}
