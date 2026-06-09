/**
 * Tool: get_setup_progress (landlord). Checks where a (new) landlord is in
 * getting set up on GAM — bank/identity connected, first property, units,
 * and a first tenant/lease — so the agent can guide them to the next step.
 * Hard-scoped: Connect status by actor.userId, counts by actor.profileId
 * (landlord_id).
 */

import { query, queryOne } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface ConnectRow {
  connect_details_submitted: boolean | null
  connect_charges_enabled: boolean | null
  connect_payouts_enabled: boolean | null
}
interface CountsRow {
  properties: string
  units: string
  active_leases: string
  onboarding_complete: boolean | null
}

export const getSetupProgress: AgentTool = {
  name: 'get_setup_progress',
  description:
    'Check how far along a landlord is in setting up their GAM account — whether their bank/identity ' +
    'is connected (so they can get paid), whether they have added a property, units, and a first ' +
    'tenant/lease — and what the recommended next step is. Use for “help me get set up”, “what do I ' +
    'do next?”, or onboarding a new landlord. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['landlord'],

  async execute(_args, actor: AgentActor) {
    const connect = await queryOne<ConnectRow>(
      `SELECT connect_details_submitted, connect_charges_enabled, connect_payouts_enabled
         FROM users WHERE id = $1`,
      [actor.userId]
    )
    const counts = await queryOne<CountsRow>(
      `SELECT
         (SELECT COUNT(*) FROM properties WHERE landlord_id = $1) AS properties,
         (SELECT COUNT(*) FROM units WHERE landlord_id = $1) AS units,
         (SELECT COUNT(*) FROM leases WHERE landlord_id = $1 AND status = 'active') AS active_leases,
         (SELECT onboarding_complete FROM landlords WHERE id = $1) AS onboarding_complete`,
      [actor.profileId]
    )

    const bankConnected = !!(connect?.connect_payouts_enabled || connect?.connect_details_submitted)
    const hasProperty = Number(counts?.properties ?? 0) > 0
    const hasUnits = Number(counts?.units ?? 0) > 0
    const hasTenant = Number(counts?.active_leases ?? 0) > 0

    const steps = [
      { step: 'Connect your bank & verify your identity (so you can get paid)', done: bankConnected },
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
      canGetPaid: !!connect?.connect_payouts_enabled,
    }
  },
}
