/**
 * 10/19 (Nic): THE SPACE'S OWN DOOR to a carried space-rent balance.
 *
 * The lease-keyed doors already exist (routes/leases.ts: preview, close-out,
 * read, take-off, arrangement). This file is the SPACE-keyed ones, which the
 * lease routes cannot answer, because the moment that matters most has no lease
 * yet:
 *
 *   "I want to see how that carry forward balance flow goes. I want to see what
 *    triggers, what actually asks the landlord, hey, is your new tenant carrying
 *    forward this balance from this spot?"
 *
 * At that moment the landlord is in the invite screen with a UNIT picked and no
 * lease drafted, so the question has to be answerable by space:
 *
 *   GET  /api/space-carryforward                  what every space carries
 *   GET  /api/space-carryforward/unit/:unitId     what THIS space carries
 *   POST /api/space-carryforward/:id/assumption   the landlord's answer, recorded
 *
 * WHY HERE AND NOT IN THE INVITE ITSELF. services/newLeaseInvite.ts was being
 * edited by another session when this was written, so the invite modal makes
 * the /assumption call of its own, after the invite lands. Nothing about the
 * MONEY depends on that: the trigger in migration 20261021100000 moves the
 * charge onto the new lease whichever of the half-dozen draft paths wrote it.
 * What the second call costs is atomicity — an invite can succeed while the
 * note recording the landlord's answer does not, which the modal reports
 * ("the note that they are taking it on did not save").
 *
 * THE ONE CHANGE THAT FOLDS IT IN, for whoever wires it next. In
 * services/newLeaseInvite.ts, inside the same transaction that drafts the
 * lease, after the lease row is inserted:
 *
 *   if (body.assumesSpaceBalance) {
 *     const { carryforwardForUnit, recordAssumptionAtInvite } =
 *       await import('./spaceRentCarryforward')
 *     const claim = await carryforwardForUnit(unitId)
 *     if (claim?.followsToNextLease) {
 *       await recordAssumptionAtInvite(client, {
 *         carryforwardId: claim.id,
 *         byUserEmail: actorEmail,
 *         residents: residents.map(r => ({ name: `${r.firstName} ${r.lastName}`.trim(), email: r.email })),
 *       })
 *     }
 *   }
 *
 * plus `assumesSpaceBalance: z.boolean().optional()` on the invite body in
 * routes/tenants.ts, and the modal passing it instead of its second call. The
 * route below stays either way: the screening door assigns no unit and drafts
 * no lease, so a landlord answering the question weeks before a lease exists
 * still needs somewhere to put the answer.
 *
 * PROPERTY SCOPE IS NOT OPTIONAL HERE. A debt on a space is money, and a staff
 * member locked to one park must not read or write one in another. Every route
 * in this file goes through assertPropertyInScope on the claim's own property
 * (owners bypass, all_properties bypasses), and the lease-keyed routes in
 * leases.ts were given the same guard in the same pass — they had only the
 * landlord-level check, so an on-site manager at one park could have closed out
 * a lease at another one.
 */
import { Router } from 'express'
import { z } from 'zod'
import { getClient, queryOne } from '../db'
import { requireAuth, requirePerm, getScopedPropertyIds, assertPropertyInScope } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { landlordScopeIds } from '../lib/landlordScope'
import { AppError } from '../middleware/errorHandler'
import {
  carryforwardsForLandlords, carryforwardForUnit, carryforwardById, recordAssumptionAtInvite,
  type SpaceClaim,
} from '../services/spaceRentCarryforward'

export const spaceCarryforwardRouter = Router()
spaceCarryforwardRouter.use(requireAuth)

/**
 * One gate, used by every route below: the caller's company owns it AND the
 * caller's property scope reaches it. Write actions take the stricter of the
 * two company checks.
 */
async function reachable(req: any, claim: SpaceClaim, mode: 'read' | 'write'): Promise<void> {
  const ok = mode === 'write'
    ? canManageLandlordResource(req.user, claim.landlordId)
    : canAccessLandlordResource(req.user, claim.landlordId)
  if (!ok) throw new AppError(403, 'Forbidden')
  await assertPropertyInScope(req.user, claim.propertyId)
}

// What every space in reach carries. The working list is the OPEN ones; ?all=1
// adds the ones paid off and the ones taken off, because a landlord looking
// back at a space wants to see that it was settled rather than nothing at all.
spaceCarryforwardRouter.get('/', async (req: any, res, next) => {
  try {
    const claims = await carryforwardsForLandlords({
      landlordIds: landlordScopeIds(req.user),
      scopedPropertyIds: await getScopedPropertyIds(req.user),
      include: req.query.all === '1' ? 'all' : 'open',
    })
    res.json({ success: true, data: claims })
  } catch (e) { next(e) }
})

// What THIS space carries — the invite screen's read. null when it carries
// nothing, which is the answer on every space but a handful.
//
// The SPACE is authorized first, before the claim is looked at. Checking the
// claim instead would have answered "nothing here" on every space outside a
// locked staff member's parks — the same answer as the truth on almost all of
// them, so no fact leaked, but a door that is open until it happens to hold
// something is the wrong shape for a door onto money. It is 403 the moment
// the space is not theirs, whether or not it carries anything.
spaceCarryforwardRouter.get('/unit/:unitId', async (req: any, res, next) => {
  try {
    const unit = await queryOne<{ landlord_id: string; property_id: string }>(
      `SELECT landlord_id, property_id FROM units WHERE id = $1`, [req.params.unitId])
    if (!unit) throw new AppError(404, 'Space not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertPropertyInScope(req.user, unit.property_id)

    const claim = await carryforwardForUnit(req.params.unitId)
    if (!claim) return res.json({ success: true, data: null })
    // The claim's own property is checked too: a space whose property moved
    // under a claim written before the move is still that claim's property.
    await reachable(req, claim, 'read')
    res.json({ success: true, data: claim })
  } catch (e) { next(e) }
})

// One claim by its id, for a screen that already has it.
spaceCarryforwardRouter.get('/:id', async (req: any, res, next) => {
  try {
    const claim = await carryforwardById(req.params.id)
    if (!claim) throw new AppError(404, 'That carried balance was not found.')
    await reachable(req, claim, 'read')
    res.json({ success: true, data: claim })
  } catch (e) { next(e) }
})

/**
 * The landlord's answer at the invite, written on the claim.
 *
 * Only "yes" is recordable, and that is the product rule rather than a missing
 * branch: a "no" means the person does not move onto the space, so there is no
 * invite to attach an answer to. The screen refuses to send instead, and offers
 * the take-off to a landlord who has decided to eat it.
 *
 * Same permission as the invite that follows it (tenants.invite): this writes
 * no money and moves no charge — the trigger does that when the lease drafts —
 * it records that the condition was put on a named person on a day.
 */
spaceCarryforwardRouter.post('/:id/assumption', requirePerm('tenants.invite'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    const body = z.object({
      residents: z.array(z.object({
        name:  z.string().max(200).nullable().optional(),
        email: z.string().max(200).nullable().optional(),
      })).min(1).max(20),
    }).parse(req.body ?? {})
    const claim = await carryforwardById(req.params.id)
    if (!claim) throw new AppError(404, 'That carried balance was not found.')
    await reachable(req, claim, 'write')

    await client.query('BEGIN')
    const result = await recordAssumptionAtInvite(client, {
      carryforwardId: claim.id,
      // Both: the email is what the sentence names, and the id is the stamp
      // (assumption_recorded_by), the way opened_by and taken_off_by are.
      byUserId: req.user?.userId ?? null,
      byUserEmail: req.user?.email ?? null,
      residents: body.residents,
    })
    await client.query('COMMIT')
    res.status(201).json({ success: true, data: result })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally { client.release() }
})
