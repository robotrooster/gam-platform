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
 */

import { queryOne } from '../../../db'
import { payoutReadiness } from '../../../lib/payoutReadiness'
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'

interface CountsRow {
  properties: string
  units: string
  active_leases: string
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
      { step: 'Set up payouts — verify your business with Stripe on the Disbursement Account page (so you can get paid)', done: bankConnected },
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
    }
  },
}
