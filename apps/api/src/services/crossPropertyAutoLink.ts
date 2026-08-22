import { query } from '../db'
import { logger } from '../lib/logger'
import { proposeLink } from './crossPropertyLink'
import { checkUnitAgainstAgreement } from './addressAdjacency'
import { createAdminNotification } from './adminNotifications'

// ============================================================
// S616 (Nic) — GAM links the two spaces itself.
//
//   "We are gonna be linking the units on the back end automatically, so you can
//    remove the link user interface."
//
// Nobody presses a button and nobody is asked. The utility landlord already
// told GAM where the space is when he typed the service address; the other
// landlord already told GAM where his property is when he onboarded. When those
// two descriptions turn out to be one place, the billing merges — because
// neither landlord's revenue changes and no landlord has standing to refuse
// another a payment rail.
//
// TWO SIGNALS, BOTH REQUIRED: the addresses describe one place, AND the person
// paying the utilities is the person on the lease. See the note in the loop.
//
// Runs daily rather than on a trigger because either side can arrive first.
// Nic: "we don't always know which order... it could be the lease side of
// things, or it could be the utility side." A sweep does not care which.
// ============================================================

export interface AutoLinkResult {
  agreementsScanned: number
  linked: number
}

export async function autoLinkNeighborServices(): Promise<AutoLinkResult> {
  const result: AutoLinkResult = { agreementsScanned: 0, linked: 0 }

  // Live agreements that are not already linked. An agreement whose space has
  // no address recorded cannot be matched to anything, and is skipped rather
  // than guessed at.
  const agreements = await query<{ id: string; landlord_id: string; tenant_id: string }>(
    `SELECT sa.id, sa.landlord_id, sa.tenant_id
       FROM utility_service_agreements sa
      WHERE sa.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM cross_property_service_links l
           WHERE l.service_agreement_id = sa.id AND l.status = 'active')`)
  result.agreementsScanned = agreements.length
  if (agreements.length === 0) return result

  for (const sa of agreements) {
    try {
      // Units belonging to a DIFFERENT landlord, not already linked, WHOSE
      // ACTIVE TENANT IS THE SAME PERSON who pays this agreement.
      //
      // S616 (Nic): "it also matches face, not just on the property address. It
      // needs to match on the customer name too."
      //
      // Two signals, and neither is sufficient alone. An address alone cannot
      // tell a duplex apart, and the person alone proves nothing — Nic raised
      // the case himself: "one of the roommates had the utilities in their name
      // with landlord A, and the lease is signed by tenant B." Requiring both
      // means the roommate case simply does not link, which is the safe
      // outcome: two separate bills, exactly as today.
      //
      // Matched on the tenant ID rather than a name string. The payer already
      // holds a GAM account, and the whole point of reusing it when their
      // landlord onboards is that it IS the same person — a name comparison
      // would be a worse test of a fact we can check exactly.
      const candidates = await query<{ id: string }>(
        `SELECT u.id
           FROM units u
          WHERE u.landlord_id <> $1
            AND u.status <> 'utility_service'
            AND EXISTS (
              SELECT 1
                FROM v_lease_active_tenants vt
                JOIN leases l2 ON l2.id = vt.lease_id
               WHERE l2.unit_id = u.id
                 AND l2.status = 'active'
                 AND vt.tenant_id = $2)
            AND NOT EXISTS (
              SELECT 1 FROM cross_property_service_links l
               WHERE l.unit_id = u.id AND l.status = 'active')
          LIMIT 2000`, [sa.landlord_id, sa.tenant_id])

      // Only an UNAMBIGUOUS match links. Two units that both look like the same
      // place means GAM cannot tell which, and linking the wrong one puts a
      // stranger's electricity on somebody's rent invoice and sends the money
      // to the wrong landlord. Ambiguity is a reason to do nothing.
      const matched: string[] = []
      for (const u of candidates) {
        const m = await checkUnitAgainstAgreement(sa.id, u.id)
        if (m.matched) matched.push(u.id)
        if (matched.length > 1) break
      }
      if (matched.length !== 1) {
        if (matched.length > 1) {
          // S616 (Nic): "if there's ever a system that comes up that may need
          // attention, we can flag that directly for admin profile to take a
          // look at." A log line is not a flag — nobody reads it. This is the
          // one case GAM genuinely cannot decide: the same person, the same
          // town, and two units that both fit. Linking the wrong one bills a
          // stranger's electricity to somebody's rent invoice and pays the
          // wrong landlord, so it stops and asks.
          await createAdminNotification({
            severity: 'warn',
            category: 'cross_property_link_ambiguous',
            title: 'Two units match one neighbour utility agreement',
            body: `The same person rents more than one unit that could be the space this landlord supplies, so GAM cannot tell which. Nothing was linked and both parties keep billing separately — no money is at risk. Link it by hand once you know which unit it is.`,
            context: { service_agreement_id: sa.id, candidate_unit_ids: matched },
          }).catch(() => {})
          logger.warn({ agreementId: sa.id, candidates: matched },
            '[auto-link] more than one unit matches — flagged for admin, left alone')
        }
        continue
      }

      await proposeLink({
        serviceAgreementId: sa.id, unitId: matched[0], via: 'proximity',
      })
      result.linked++
      logger.info({ agreementId: sa.id, unitId: matched[0] },
        '[auto-link] neighbor utilities now ride the lease invoice')
    } catch (e) {
      logger.error({ err: e, agreementId: sa.id },
        '[auto-link] failed for this agreement — sweep continues')
    }
  }
  return result
}
