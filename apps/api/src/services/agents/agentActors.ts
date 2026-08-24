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

  const actorFor = (a: string): any => {
    switch (a) {
      case 'tenant':
        return { userId: tenant.user_id, role: 'tenant', profileId: tenant.tenant_id }
      case 'landlord':
        return { userId: lord.user_id, role: 'landlord', profileId: lord.landlord_id }
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
