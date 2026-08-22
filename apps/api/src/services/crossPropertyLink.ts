import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { checkUnitAgainstAgreement, type AdjacencyBasis } from './addressAdjacency'
import { logger } from '../lib/logger'

// ============================================================
// S616 (Nic) — proposing, consenting to, and activating the link between a
// serviced space and the unit another landlord leases at the same place.
//
// THE ORDER IS NOT KNOWN IN ADVANCE. Nic: "we don't always know which order.
// If there's a utility split crossing the property line, we don't know which
// landlord is gonna be the first one. It could be the lease side of things, or
// it could be the utility side." So matching is symmetric: the same row is
// reached whether the serviced space existed first and a unit appeared next
// door, or the unit was there and the utility landlord onboarded after.
//
// NOBODY APPROVES IT (Nic, correcting an earlier version of this file that
// required three consents):
//
//   "Each landlord is entitled to their revenue stream according to how the
//    property is set up... you can't have landlord B refusing permission to
//    have landlord A's utilities ride on the same payment rail as the lease
//    invoice. The other landlord shouldn't even see anything about it. We are
//    matching it up on the back end without anybody knowing."
//
// Neither landlord's revenue changes and neither charge changes — only which
// document they print on and which rail carries them. A landlord has no
// standing to refuse another landlord a payment rail, and a feature that
// needed a stranger's cooperation to work would not have worked at all.
// ============================================================

export type ProposedVia = 'tenant_account' | 'proximity' | 'admin'

export interface ProposeInput {
  serviceAgreementId: string
  unitId: string
  via: ProposedVia
  proposedByUserId?: string | null
  /** Admin proposals bypass the proximity gate — see the note in propose(). */
  force?: boolean
}

export interface LinkRow {
  id: string
  status: string
  address_match_basis: AdjacencyBasis | null
  address_match_evidence: string | null
  [k: string]: any
}

/** How a link comes into being. Kept as one exported name so the callers that
 *  used to "propose" read correctly now that matching IS linking. */
export type LinkResult = LinkRow

/**
 * Match and link. Creates a LIVE link carrying the evidence that produced it.
 *
 * The address gate is now the ONLY safeguard, which makes it the important
 * part rather than a preamble to a consent screen. It fires only when the two
 * addresses agree on town AND street AND street numbers close together. What
 * still protects people if it is ever wrong: the amounts do not change, the
 * tenant's line still itemises the meter reads behind the charge so something
 * that is not theirs is visible rather than buried, and unlinking separates the
 * billing again from the next cycle.
 *
 * `force` exists for the case Nic named — "maybe escalate it to the admin, like,
 * to on purpose add this kind of thing" — where the physical truth is known to a
 * person and invisible to the text (a corner lot addressed on the other street,
 * a space described as "the blue house").
 */
export async function proposeLink(input: ProposeInput): Promise<LinkRow> {
  const sa = await queryOne<any>(
    `SELECT sa.id, sa.landlord_id, sa.unit_id, sa.tenant_id, sa.status
       FROM utility_service_agreements sa WHERE sa.id = $1`,
    [input.serviceAgreementId])
  if (!sa) throw new AppError(404, 'Service agreement not found')
  if (sa.status !== 'active') {
    throw new AppError(409, 'That utility service agreement is no longer active.')
  }

  const unit = await queryOne<any>(
    `SELECT u.id, u.landlord_id FROM units u WHERE u.id = $1`, [input.unitId])
  if (!unit) throw new AppError(404, 'Unit not found')

  if (unit.landlord_id === sa.landlord_id) {
    // Same landlord on both sides is not a cross-property link — it is one
    // landlord leasing a space he already services, which the supersedence
    // trigger already handles on its own.
    throw new AppError(400,
      'That unit belongs to the same landlord as the service agreement, so there is nothing to link across.')
  }

  const match = await checkUnitAgainstAgreement(input.serviceAgreementId, input.unitId)
  if (!match.matched && !input.force) {
    throw new AppError(409, match.evidence)
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')
    // The partial unique indexes make a second live link on either side an
    // error rather than a silent second row, so a duplicate proposal surfaces
    // as a clear message instead of two competing claims on one meter.
    const existing = await client.query<any>(
      `SELECT id, status FROM cross_property_service_links
        WHERE (service_agreement_id = $1 OR unit_id = $2)
          AND status = 'active'
        LIMIT 1`, [input.serviceAgreementId, input.unitId])
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK')
      throw new AppError(409, 'These are already linked.')
    }

    const res = await client.query<LinkRow>(
      `INSERT INTO cross_property_service_links (
         service_agreement_id, service_landlord_id, unit_id, unit_landlord_id,
         proposed_via, proposed_by_user_id,
         address_match_basis, address_match_evidence, address_checked_at,
         status, activated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),'active',NOW())
       RETURNING *`,
      [input.serviceAgreementId, sa.landlord_id, input.unitId, unit.landlord_id,
       input.via, input.proposedByUserId ?? null, match.basis, match.evidence])
    await client.query('COMMIT')
    // The $2 platform fee follows the tenancy from here (S614: never charged
    // twice for one space). The agreement itself stays active and keeps
    // billing — the landlord is still supplying the power.
    const lease = await client.query<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id = $1 AND status = 'active'
        ORDER BY start_date DESC LIMIT 1`, [input.unitId])
    if (lease.rows.length > 0) {
      await client.query(
        `UPDATE utility_service_agreements
            SET superseded_by_lease_id = $2, updated_at = NOW()
          WHERE id = $1 AND superseded_by_lease_id IS NULL`,
        [input.serviceAgreementId, lease.rows[0].id])
    }
    logger.info({ linkId: res.rows[0].id, via: input.via, basis: match.basis },
      '[cross-property-link] matched and linked — utilities now ride the lease invoice')
    return res.rows[0]
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

/**
 * Break a live link. Billing separates again from the next cycle; nothing
 * already invoiced or settled is rewritten or clawed back — GAM never erases,
 * and money that has already reached the right landlord is not a mistake to
 * correct.
 */
export async function endLink(linkId: string): Promise<void> {
  await query(
    `UPDATE cross_property_service_links
        SET status = 'ended', ended_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'active'`, [linkId])
}

/**
 * The live link for a leased unit, if any — the question converged billing
 * asks on every invoice run.
 */
export async function activeLinkForUnit(unitId: string, client?: PoolClient) {
  // `l.unit_id` is the LEASED unit; the serviced space is the agreement's own
  // unit. Naming it explicitly here so a caller can never confuse the two —
  // they are different rows at different properties under different landlords,
  // and mixing them up bills the wrong person for the wrong meter.
  const q = `SELECT l.*,
                    sa.unit_id     AS service_unit_id,
                    sa.tenant_id   AS service_tenant_id,
                    sa.landlord_id AS service_landlord_id
               FROM cross_property_service_links l
               JOIN utility_service_agreements sa ON sa.id = l.service_agreement_id
              WHERE l.unit_id = $1 AND l.status = 'active'
              LIMIT 1`
  if (client) return (await client.query<any>(q, [unitId])).rows[0] ?? null
  return queryOne<any>(q, [unitId])
}
