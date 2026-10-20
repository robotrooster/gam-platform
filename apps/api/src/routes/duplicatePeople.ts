/**
 * 10/20 (Nic) — "ALWAYS HAVE THE LANDLORD CHECK THAT THE CUSTOMER IS THE SAME."
 *
 * Three endpoints and that is the whole surface: here are the pairs that look
 * like one person, this one IS, this one ISN'T. There is no fourth endpoint
 * that merges on its own and there is no job that calls these.
 *
 * WHO. Looking is for anybody who may see the Tenants list (tenants.view) —
 * it is the same people, read a different way. ANSWERING is for the owner or a
 * manager trusted with who a resident is (tenants.invite, the same key that
 * lets somebody skip a background check for a resident they vouch for).
 * An answer here changes a sign-in address and moves reservations between
 * people; that is not a front-desk key.
 *
 * SCOPE. Every call is bounded by the companies this ACCOUNT owns
 * (landlordScopeIds) — never one entity, because a landlord who runs two parks
 * has one book of people and the same man winters in both; and never across
 * accounts, because Nic must not be shown Blu's guests and a merge must not
 * reach a row outside the account that asked for it.
 *
 * NOTHING HERE SENDS AN EMAIL.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { landlordScopeIds } from '../lib/landlordScope'
import {
  decidedProposals, dismissProposal, mergePeople, openProposals, scanForDuplicates, signalSentences,
} from '../services/duplicatePeople'

export const duplicatePeopleRouter = Router()
duplicatePeopleRouter.use(requireAuth)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The account's companies, or the plain refusal every landlord endpoint gives. */
function scope(req: any): string[] {
  const ids = landlordScopeIds(req.user!)
  if (!ids.length) throw new AppError(400, 'No landlord scope on this user')
  return ids
}

/**
 * GET /api/duplicate-people — look, and look FRESH.
 *
 * The scan runs on the way in rather than on a timer. Opening the screen is the
 * one moment somebody actually wants to know, the write it does is an idempotent
 * upsert that cannot reopen an answered pair (services/duplicatePeople), and a
 * nightly job would mean a landlord reading a list that is up to a day behind
 * the import he finished ten minutes ago. ?scan=0 reads the stored list without
 * looking again.
 */
duplicatePeopleRouter.get('/', requirePerm('tenants.view'), async (req: any, res, next) => {
  try {
    const landlordIds = scope(req)
    const scanned = req.query.scan === '0'
      ? null
      : await scanForDuplicates({ landlordIds })
    const rows = await openProposals(landlordIds)
    res.json({
      success: true,
      data: {
        proposals: rows.map(r => ({
          id: r.id,
          confidence: r.confidence,
          score: r.score,
          signals: r.signals,
          // The signals as sentences, built from the one shared list, so the
          // screen never has to turn a stored value into English itself.
          reasons: signalSentences(r.signals ?? []),
          a: r.snapshot?.a ?? null,
          b: r.snapshot?.b ?? null,
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at,
        })),
        decided: await decidedProposals(landlordIds),
        openCount: rows.length,
        scanned,
      },
    })
  } catch (e) { next(e) }
})

const sameSchema = z.object({
  keeperSide: z.enum(['a', 'b']),
  /**
   * Which address the surviving account signs in with. Defaults to the one it
   * already has: changing somebody's sign-in address is a decision, not a
   * side effect of tidying up.
   */
  signInAddress: z.enum(['keeper', 'folded']).optional(),
})

/** POST /api/duplicate-people/:id/same-person — the landlord says: one person. */
duplicatePeopleRouter.post('/:id/same-person', requirePerm('tenants.invite'), async (req: any, res, next) => {
  try {
    const landlordIds = scope(req)
    if (!UUID.test(String(req.params.id))) throw new AppError(400, 'That question is not one GAM knows.')
    const parsed = sameSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new AppError(400, 'Say which of the two should stay.')
    const outcome = await mergePeople({
      proposalId: req.params.id,
      landlordIds,
      keeperSide: parsed.data.keeperSide,
      signInAddress: parsed.data.signInAddress,
      byUserId: req.user!.userId,
    })
    res.json({ success: true, data: outcome, message: outcome.summary.join(' ') })
  } catch (e) { next(e) }
})

/** POST /api/duplicate-people/:id/not-duplicate — and it stays said. */
duplicatePeopleRouter.post('/:id/not-duplicate', requirePerm('tenants.invite'), async (req: any, res, next) => {
  try {
    const landlordIds = scope(req)
    if (!UUID.test(String(req.params.id))) throw new AppError(400, 'That question is not one GAM knows.')
    await dismissProposal({
      proposalId: req.params.id, landlordIds, byUserId: req.user!.userId,
    })
    res.json({
      success: true,
      data: { dismissed: true },
      message: 'Noted — two different people. GAM will not ask about this pair again.',
    })
  } catch (e) { next(e) }
})
