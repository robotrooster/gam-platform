import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource } from '../middleware/scope'
import {
  proposeLink, recordConsent, declineLink, endLink, type ConsentParty,
} from '../services/crossPropertyLink'
import { checkUnitAgainstAgreement } from '../services/addressAdjacency'

// ============================================================
// S616 — the screens for linking a serviced space to another landlord's unit.
//
// Nic: "I'm not sure when that would show up to people." It shows up in exactly
// one place per party: on the row of the thing they already own. The utility
// landlord sees it under the serviced space on his Utilities page; the other
// landlord sees it on his unit; the tenant sees it in their portal. Nobody has
// to go looking for a screen called "links".
// ============================================================

export const crossPropertyLinksRouter = Router()
crossPropertyLinksRouter.use(requireAuth)

/** Everything waiting on ME, plus everything already live that concerns me. */
crossPropertyLinksRouter.get('/', async (req, res, next) => {
  try {
    const role = req.user!.role
    const isTenant = role === 'tenant'
    const landlordId = role === 'landlord' ? req.user!.profileId : req.user!.landlordId

    const rows = await query<any>(`
      SELECT l.id, l.status, l.address_match_basis, l.address_match_evidence,
             l.proposed_via, l.created_at, l.activated_at,
             l.service_landlord_approved_at, l.unit_landlord_approved_at,
             l.tenant_confirmed_at,
             l.service_landlord_id, l.unit_landlord_id,
             sa.id AS service_agreement_id,
             sa.service_address,
             su.unit_number  AS service_space,
             sp.name         AS service_property_name,
             sp.street1      AS service_street1,
             lu.unit_number  AS unit_number,
             lp.name         AS unit_property_name,
             lp.street1      AS unit_street1,
             t.id            AS tenant_id,
             tu.first_name, tu.last_name, tu.email,
             slu.first_name AS service_landlord_first, slu.last_name AS service_landlord_last,
             ulu.first_name AS unit_landlord_first,    ulu.last_name AS unit_landlord_last
        FROM cross_property_service_links l
        JOIN utility_service_agreements sa ON sa.id = l.service_agreement_id
        JOIN units su      ON su.id = sa.unit_id
        JOIN properties sp ON sp.id = su.property_id
        JOIN units lu      ON lu.id = l.unit_id
        JOIN properties lp ON lp.id = lu.property_id
        JOIN tenants t     ON t.id = sa.tenant_id
        JOIN users tu      ON tu.id = t.user_id
        JOIN landlords sl  ON sl.id = l.service_landlord_id
        JOIN users slu     ON slu.id = sl.user_id
        JOIN landlords ul  ON ul.id = l.unit_landlord_id
        JOIN users ulu     ON ulu.id = ul.user_id
       WHERE l.status IN ('proposed','active')
         AND (${isTenant ? 't.id = $1' : '(l.service_landlord_id = $1 OR l.unit_landlord_id = $1)'})
       ORDER BY l.status, l.created_at DESC`,
      [isTenant ? req.user!.profileId : landlordId])

    // Which hat is this viewer wearing, and have they already answered? The
    // screen needs both to decide whether to show an approve button at all.
    const data = rows.map((r: any) => {
      const party: ConsentParty | null = isTenant ? 'tenant'
        : r.service_landlord_id === landlordId ? 'service_landlord'
        : r.unit_landlord_id === landlordId ? 'unit_landlord' : null
      const mine = party === 'tenant' ? r.tenant_confirmed_at
        : party === 'service_landlord' ? r.service_landlord_approved_at
        : party === 'unit_landlord' ? r.unit_landlord_approved_at : null
      return {
        ...r,
        yourRole: party,
        youHaveApproved: !!mine,
        awaitingYou: r.status === 'proposed' && !!party && !mine,
      }
    })
    res.json({ success: true, data })
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
    // Proposing is the service landlord's own approval — he is the one asking.
    const after = await recordConsent(link.id, 'service_landlord', req.user!.userId)
    res.status(201).json({ success: true, data: after })
  } catch (e) { next(e) }
})

/** Approve as whichever party you actually are. Never as a party you are not. */
crossPropertyLinksRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const link = await queryOne<any>(
      `SELECT l.*, sa.tenant_id
         FROM cross_property_service_links l
         JOIN utility_service_agreements sa ON sa.id = l.service_agreement_id
        WHERE l.id = $1`, [req.params.id])
    if (!link) throw new AppError(404, 'Link not found')

    const role = req.user!.role
    const landlordId = role === 'landlord' ? req.user!.profileId : req.user!.landlordId
    let party: ConsentParty | null = null
    if (role === 'tenant' && link.tenant_id === req.user!.profileId) party = 'tenant'
    else if (landlordId && link.service_landlord_id === landlordId) party = 'service_landlord'
    else if (landlordId && link.unit_landlord_id === landlordId) party = 'unit_landlord'
    if (!party) throw new AppError(403, 'This link is not yours to approve.')

    const after = await recordConsent(req.params.id, party, req.user!.userId)
    res.json({ success: true, data: after })
  } catch (e) { next(e) }
})

crossPropertyLinksRouter.post('/:id/decline', async (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().trim().max(300).optional() })
      .parse(req.body ?? {})
    const link = await queryOne<any>(
      `SELECT l.*, sa.tenant_id
         FROM cross_property_service_links l
         JOIN utility_service_agreements sa ON sa.id = l.service_agreement_id
        WHERE l.id = $1`, [req.params.id])
    if (!link) throw new AppError(404, 'Link not found')

    const role = req.user!.role
    const landlordId = role === 'landlord' ? req.user!.profileId : req.user!.landlordId
    const isParty = (role === 'tenant' && link.tenant_id === req.user!.profileId)
      || (landlordId && (link.service_landlord_id === landlordId || link.unit_landlord_id === landlordId))
    if (!isParty) throw new AppError(403, 'This link is not yours.')

    // Any one party can say no — a link needs all three, so a single refusal
    // settles it. An ACTIVE link is ENDED rather than declined: it separates
    // the billing going forward and leaves everything already invoiced alone.
    if (link.status === 'active') await endLink(req.params.id)
    else await declineLink(req.params.id, req.user!.userId, reason)
    res.json({ success: true, data: { id: req.params.id } })
  } catch (e) { next(e) }
})
