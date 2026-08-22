import { query } from '../db'
import { logger } from '../lib/logger'
import { proposeLink } from './crossPropertyLink'
import { checkUnitAgainstAgreement } from './addressAdjacency'

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
  const agreements = await query<{ id: string; landlord_id: string }>(
    `SELECT sa.id, sa.landlord_id
       FROM utility_service_agreements sa
      WHERE sa.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM cross_property_service_links l
           WHERE l.service_agreement_id = sa.id AND l.status = 'active')`)
  result.agreementsScanned = agreements.length
  if (agreements.length === 0) return result

  for (const sa of agreements) {
    try {
      // Units belonging to a DIFFERENT landlord, not already linked, that could
      // be the same place. The address comparison is what narrows this — not a
      // pre-filter that might quietly exclude the right answer.
      const candidates = await query<{ id: string }>(
        `SELECT u.id
           FROM units u
          WHERE u.landlord_id <> $1
            AND u.status <> 'utility_service'
            AND NOT EXISTS (
              SELECT 1 FROM cross_property_service_links l
               WHERE l.unit_id = u.id AND l.status = 'active')
          LIMIT 2000`, [sa.landlord_id])

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
          logger.warn({ agreementId: sa.id },
            '[auto-link] more than one unit matches this address — leaving it alone')
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
