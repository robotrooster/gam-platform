/**
 * Tool: get_setup_progress (landlord). Checks where a (new) landlord is in
 * getting set up on GAM — payouts set up with Stripe, first property, units,
 * and a first tenant/lease — so the agent can guide them to the next step.
 * Hard-scoped to the account's companies (actorLandlordIds).
 *
 * 10/12 (Nic): three faults, all on the "can I get paid" answer.
 *  - The counts query bound the company list as uuid[] and then compared
 *    `id = $1` for onboarding_complete, so every call threw (uuid = uuid[]).
 *    The unit test mocked the database and never ran the SQL.
 *  - Payouts were read from users.connect_*. Since S554 a landlord's Stripe
 *    account belongs to the COMPANY (landlords.stripe_connect_account_id); no
 *    landlord has a user-level one, so Oak Park would have been told it was
 *    not connected.
 *  - "Details submitted" counted as connected. Submitting details is not
 *    being paid; only live payouts are.
 * Readiness is the shared rule in lib/payoutReadiness.ts — every company with
 * a property can be paid — and the companies that can't are named, so the
 * agent can say which one (Blu: TruBlu Management LLC, not Oak Park).
 *
 * 10/19 (review): THE SECOND BANK STEP WAS MISSING ENTIRELY. Bank setup is two
 * steps for one bank account — Stripe verifies the business so rent can reach
 * it, then the same account is linked READ-ONLY so spending becomes expenses
 * (S605, Nic, DIRECTIVE: "No landlord is gonna be able to get their PNLs
 * accurate if they can't reconcile the bank transactions"). This tool knew only
 * about the first, so it told a landlord with step 1 done and step 2 untouched
 * that their setup was complete. It is asked per company, by the same rule as
 * payouts, so one company's linked feed never answers for another's.
 */

import { query, queryOne } from '../../../db'
import { payoutReadiness } from '../../../lib/payoutReadiness'
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'

interface CountsRow {
  properties: string
  units: string
  active_leases: string
}

interface FeedRow {
  business_name: string | null
  has_property: boolean
  linked: boolean
}

/**
 * Is the read-only bank feed linked for every company that has a property?
 * Deliberately NOT "does any company in scope have one" — that is the exact
 * collapse payoutReadiness was rewritten per-company to fix, where Oak Park's
 * linked bank answered for TruBlu's missing one.
 */
async function feedReadiness(landlordIds: string[]) {
  if (landlordIds.length === 0) return { ready: false, unlinked: [] as string[] }
  const rows = await query<FeedRow>(
    `SELECT l.business_name,
            EXISTS (SELECT 1 FROM properties p WHERE p.landlord_id = l.id) AS has_property,
            EXISTS (SELECT 1 FROM bank_connections bc
                     WHERE bc.landlord_id = l.id AND bc.status = 'active') AS linked
       FROM landlords l
      WHERE l.id = ANY($1::uuid[])
      ORDER BY l.created_at, l.id`,
    [landlordIds])
  const unlinked = rows
    .filter(r => r.has_property && !r.linked)
    .map(r => r.business_name || 'Unnamed company')
  // Same shape as payoutReadiness: with no property anywhere, any one company's
  // link is enough, so a co-owner's empty company is never the reason for a nag.
  return { ready: unlinked.length === 0 && rows.some(r => r.linked), unlinked }
}

export const getSetupProgress: AgentTool = {
  name: 'get_setup_progress',
  description:
    'Check how far along a landlord is in setting up their GAM account — whether their payouts are ' +
    'set up with Stripe (so they can get paid, and which company still cannot be), whether they have ' +
    'added a property, units, and a first tenant/lease — and what the recommended next step is. Use ' +
    'for “help me get set up”, “what do I do next?”, or onboarding a new landlord. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['landlord'],

  async execute(_args, actor: AgentActor) {
    const ids = actorLandlordIds(actor)
    const payouts = await payoutReadiness(ids)
    const feed = await feedReadiness(ids)
    const counts = await queryOne<CountsRow>(
      `SELECT
         (SELECT COUNT(*) FROM properties WHERE landlord_id = ANY($1::uuid[])) AS properties,
         (SELECT COUNT(*) FROM units WHERE landlord_id = ANY($1::uuid[])) AS units,
         (SELECT COUNT(*) FROM leases WHERE landlord_id = ANY($1::uuid[]) AND status = 'active') AS active_leases`,
      [ids]
    )

    const bankConnected = payouts.ready
    const hasProperty = Number(counts?.properties ?? 0) > 0
    const hasUnits = Number(counts?.units ?? 0) > 0
    const hasTenant = Number(counts?.active_leases ?? 0) > 0

    const steps = [
      { step: 'Set up payouts — step 1 of bank setup: verify your business with Stripe on the Bank page, Bank setup tab (so rent can reach your bank)', done: bankConnected },
      { step: 'Connect your bank read-only — step 2 of bank setup, on the same tab (so your spending becomes expenses and the month reconciles)', done: feed.ready },
      { step: 'Add your first property', done: hasProperty },
      { step: 'Add units to your property', done: hasUnits },
      { step: 'Add a tenant and create their lease', done: hasTenant },
    ]
    const next = steps.find((s) => !s.done)
    const completed = steps.filter((s) => s.done).length

    return {
      ok: true,
      complete: !next,
      completedSteps: completed,
      totalSteps: steps.length,
      nextStep: next?.step ?? null,
      steps,
      // extra signals the agent can mention if helpful
      canGetPaid: payouts.ready,
      companiesThatCannotBePaid: payouts.unpaid.map((c) => c.businessName || 'Unnamed company'),
      bankFeedLinked: feed.ready,
      companiesWithNoBankFeed: feed.unlinked,
    }
  },
}
