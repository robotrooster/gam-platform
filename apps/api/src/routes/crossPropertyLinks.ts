import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource } from '../middleware/scope'
import { proposeLink, endLink } from '../services/crossPropertyLink'
import { checkUnitAgainstAgreement } from '../services/addressAdjacency'

// ============================================================
// S616 — linking a serviced space to another landlord's unit.
//
// Nic, after an earlier version asked all three parties to approve: "The other
// landlord shouldn't even see anything about it. We are matching it up on the
// back end without anybody knowing."
//
// So there is exactly ONE surface, and it belongs to the utility landlord —
// the person who set the serviced space up and typed its address. The unit's
// landlord is never shown a request and the tenant is never asked; neither
// party's money changes, only which document the charges print on.
// ============================================================

export const crossPropertyLinksRouter = Router()
crossPropertyLinksRouter.use(requireAuth)

/** The utility landlord's own live links. */
crossPropertyLinksRouter.get('/', async (req, res, next) => {
  try {
    const landlordId = req.user!.role === 'landlord'
      ? req.user!.profileId : req.user!.landlordId
    if (!landlordId) return res.json({ success: true, data: [] })

    // Scoped to the SERVICE landlord alone. The unit's landlord is deliberately
    // not served his own links here — he was never told one exists.
    const rows = await query<any>(`
      SELECT l.id, l.status, l.address_match_basis, l.address_match_evidence,
             l.proposed_via, l.created_at, l.activated_at,
             sa.id AS service_agreement_id, sa.service_address,
             su.unit_number AS service_space,
             lu.unit_number AS unit_number,
             lp.name        AS unit_property_name
        FROM cross_property_service_links l
        JOIN utility_service_agreements sa ON sa.id = l.service_agreement_id
        JOIN units su      ON su.id = sa.unit_id
        JOIN units lu      ON lu.id = l.unit_id
        JOIN properties lp ON lp.id = lu.property_id
       WHERE l.status = 'active'
         AND l.service_landlord_id = $1
       ORDER BY l.created_at DESC`, [landlordId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

/**
 * Candidate units for a serviced space — the other landlords' units at what
 * looks like the same address. Empty is the normal answer until the neighbour
 * onboards, and the screen says so rather than looking broken.
 */
crossPropertyLinksRouter.get('/candidates', async (req, res, next) => {
  try {
    const serviceAgreementId = z.string().uuid().parse(req.query.serviceAgreementId)
    const sa = await queryOne<any>(
      `SELECT sa.id, sa.landlord_id, sa.service_address, u.property_id
         FROM utility_service_agreements sa
         JOIN units u ON u.id = sa.unit_id
        WHERE sa.id = $1`, [serviceAgreementId])
    if (!sa) throw new AppError(404, 'Service agreement not found')
    if (!canAccessLandlordResource(req.user, sa.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    // Only OTHER landlords' units, and only ones not already linked. Scanning
    // the whole platform is fine at this size and honest at any size: the
    // address comparison below is what narrows it, not a pre-filter that could
    // quietly exclude the right answer.
    const units = await query<any>(`
      SELECT u.id, u.unit_number, p.name AS property_name, p.street1, p.city,
             p.state, p.zip, ll.id AS landlord_id,
             lu.first_name, lu.last_name
        FROM units u
        JOIN properties p ON p.id = u.property_id
        JOIN landlords ll ON ll.id = u.landlord_id
        JOIN users lu     ON lu.id = ll.user_id
       WHERE u.landlord_id <> $1
         AND u.status <> 'utility_service'
         AND NOT EXISTS (
           SELECT 1 FROM cross_property_service_links l
            WHERE l.unit_id = u.id AND l.status IN ('proposed','active'))
       LIMIT 2000`, [sa.landlord_id])

    const matches = []
    for (const u of units) {
      const m = await checkUnitAgainstAgreement(serviceAgreementId, u.id)
      if (m.matched) matches.push({ ...u, matchBasis: m.basis, evidence: m.evidence })
    }
    res.json({ success: true, data: matches })
  } catch (e) { next(e) }
})

crossPropertyLinksRouter.post('/', async (req, res, next) => {
  try {
    const body = z.object({
      serviceAgreementId: z.string().uuid(),
      unitId: z.string().uuid(),
    }).parse(req.body)

    const sa = await queryOne<any>(
      `SELECT landlord_id FROM utility_service_agreements WHERE id = $1`,
      [body.serviceAgreementId])
    if (!sa) throw new AppError(404, 'Service agreement not found')
    if (!canAccessLandlordResource(req.user, sa.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    const link = await proposeLink({
      serviceAgreementId: body.serviceAgreementId,
      unitId: body.unitId,
      via: 'proximity',
      proposedByUserId: req.user!.userId,
    })
    res.status(201).json({ success: true, data: link })
  } catch (e) { next(e) }
})

/**
 * Break a live link. Billing separates again from the next cycle; nothing
 * already invoiced or settled is rewritten or clawed back — GAM never erases,
 * and money that has already reached the right landlord is not a mistake.
 *
 * Only the SERVICE landlord can do this. It is his arrangement, and the other
 * landlord does not know it exists.
 */
crossPropertyLinksRouter.post('/:id/unlink', async (req, res, next) => {
  try {
    const link = await queryOne<any>(
      `SELECT id, service_landlord_id FROM cross_property_service_links WHERE id = $1`,
      [req.params.id])
    if (!link) throw new AppError(404, 'Link not found')
    if (!canAccessLandlordResource(req.user, link.service_landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    await endLink(req.params.id)
    res.json({ success: true, data: { id: req.params.id } })
  } catch (e) { next(e) }
})
