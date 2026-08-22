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
// it could be the utility side." So proposal is symmetric: the same row is
// reached whether the serviced space existed first and a unit appeared next
// door, or the unit was there and the utility landlord onboarded after.
//
// NOTHING CONVERGES ON A MACHINE'S SAY-SO. Two signals raise the question and
// three people answer it. The signals are only ever enough to ASK.
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

/**
 * Raise the question. Creates a 'proposed' link carrying its evidence; grants
 * nothing and moves no money until all three consents land.
 *
 * The address gate is a REFUSAL TO GUESS, not a security boundary. A proposal
 * that cannot show the two addresses describe one place is not offered to
 * anybody, because the screen would be asking three people to approve a match
 * on no evidence — and the one thing worse than a missed link is a confident
 * wrong one, which bills a tenant for a stranger's power and pays the wrong
 * landlord.
 *
 * `force` exists for the case Nic named — "maybe escalate it to the admin, like,
 * to on purpose add this kind of thing" — where the physical truth is known to a
 * person and invisible to the text (a corner lot addressed on the other street,
 * a space described as "the blue house"). It skips the GATE, never the CONSENTS.
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
          AND status IN ('proposed','active')
        LIMIT 1`, [input.serviceAgreementId, input.unitId])
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK')
      throw new AppError(409, existing.rows[0].status === 'active'
        ? 'These are already linked.'
        : 'A link for one of these is already waiting on approvals.')
    }

    const res = await client.query<LinkRow>(
      `INSERT INTO cross_property_service_links (
         service_agreement_id, service_landlord_id, unit_id, unit_landlord_id,
         proposed_via, proposed_by_user_id,
         address_match_basis, address_match_evidence, address_checked_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       RETURNING *`,
      [input.serviceAgreementId, sa.landlord_id, input.unitId, unit.landlord_id,
       input.via, input.proposedByUserId ?? null, match.basis, match.evidence])
    await client.query('COMMIT')
    logger.info({ linkId: res.rows[0].id, via: input.via, basis: match.basis },
      '[cross-property-link] proposed')
    return res.rows[0]
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

export type ConsentParty = 'service_landlord' | 'unit_landlord' | 'tenant'

/**
 * Record one party's approval and activate the moment the third lands.
 *
 * Activation is deliberately a CONSEQUENCE of the last consent rather than a
 * separate step somebody has to remember. Three people approving something
 * that then sits there doing nothing is its own kind of broken.
 */
export async function recordConsent(
  linkId: string, party: ConsentParty, userId: string,
): Promise<LinkRow> {
  const COLUMN: Record<ConsentParty, string> = {
    service_landlord: 'service_landlord_approved',
    unit_landlord:    'unit_landlord_approved',
    tenant:           'tenant_confirmed',
  }
  const col = COLUMN[party]
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const cur = await client.query<any>(
      `SELECT * FROM cross_property_service_links WHERE id = $1 FOR UPDATE`, [linkId])
    if (cur.rows.length === 0) throw new AppError(404, 'Link not found')
    const link = cur.rows[0]
    if (link.status === 'declined' || link.status === 'ended') {
      throw new AppError(409, 'That link is no longer open.')
    }

    await client.query(
      `UPDATE cross_property_service_links
          SET ${col}_at = COALESCE(${col}_at, NOW()),
              ${col}_by = COALESCE(${col}_by, $2),
              updated_at = NOW()
        WHERE id = $1`, [linkId, userId])

    const after = await client.query<any>(
      `SELECT * FROM cross_property_service_links WHERE id = $1`, [linkId])
    const l = after.rows[0]
    const allThree = l.service_landlord_approved_at && l.unit_landlord_approved_at
      && l.tenant_confirmed_at

    if (allThree && l.status === 'proposed') {
      await client.query(
        `UPDATE cross_property_service_links
            SET status = 'active', activated_at = NOW(), updated_at = NOW()
          WHERE id = $1`, [linkId])
      // The $2 platform fee follows the tenancy from here (S614's rule that it
      // is never charged twice for one space). The agreement itself stays
      // active and keeps billing — the landlord is still supplying the power.
      const lease = await client.query<{ id: string }>(
        `SELECT id FROM leases WHERE unit_id = $1 AND status = 'active'
          ORDER BY start_date DESC LIMIT 1`, [l.unit_id])
      if (lease.rows.length > 0) {
        await client.query(
          `UPDATE utility_service_agreements
              SET superseded_by_lease_id = $2, updated_at = NOW()
            WHERE id = $1 AND superseded_by_lease_id IS NULL`,
          [l.service_agreement_id, lease.rows[0].id])
      }
      logger.info({ linkId }, '[cross-property-link] activated — utilities now ride the lease invoice')
    }

    await client.query('COMMIT')
    const final = await queryOne<LinkRow>(
      `SELECT * FROM cross_property_service_links WHERE id = $1`, [linkId])
    return final!
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

export async function declineLink(
  linkId: string, userId: string, reason?: string,
): Promise<void> {
  const r = await query(
    `UPDATE cross_property_service_links
        SET status = 'declined', declined_at = NOW(),
            declined_by_user_id = $2, decline_reason = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'proposed'`,
    [linkId, userId, reason ?? null])
  if ((r as any).length === 0) { /* already resolved — nothing to undo */ }
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
