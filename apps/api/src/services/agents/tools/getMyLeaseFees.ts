/**
 * Tool: get_my_lease_fees (tenant). The fees and deposits written on the
 * tenant's OWN active lease — pet deposit, pet rent, cleaning, parking,
 * storage, trash, and the rest. Hard-scoped to actor.profileId (tenant_id).
 *
 * S618 (Nic): "anytime somebody said the word pink [pet], you would know — hey,
 * I'm gonna pull up the pet deposit on the lease, on their specific lease."
 *
 * Building the phrase table for that turned up the real problem: there was
 * nothing to route TO. `lease_fees` holds 21 fee types and the ONLY code that
 * read it was billFee.ts — a landlord's write path. No tenant-facing tool
 * exposed any of it, so "how much was my pet deposit?" had no lookup behind it
 * at all. The agent's own guards would (correctly) suppress a made-up figure,
 * which means the honest outcome was a dead end on a question with a precise
 * answer sitting in the database.
 *
 * LEASE IS LAW. These rows ARE the signed lease — this reads them and never
 * computes, estimates or infers a fee. A fee that is not on the lease does not
 * exist, and is reported as not on the lease.
 *
 * Labels come from the shared LEASE_COLUMN_LABEL map rather than the raw enum,
 * so the tenant reads "Pet deposit", never "pet_deposit".
 */

import { LEASE_COLUMN_LABEL } from '@gam/shared'
import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface FeeRow {
  fee_type: string
  amount: string | null
  is_refundable: boolean | null
  due_timing: string | null
  description: string | null
}

/** How a person would say each timing — never the raw column value. */
const TIMING_LABEL: Record<string, string> = {
  move_in: 'due at move-in',
  monthly_ongoing: 'charged every month',
  move_out: 'settled at move-out',
  other: 'one-off',
}

export const getMyLeaseFees: AgentTool = {
  name: 'get_my_lease_fees',
  description:
    'Look up the fees and deposits written on the tenant’s own active lease — pet deposit, pet ' +
    'rent, cleaning fee, parking, storage, trash, move-in fee and the rest, each with its amount, ' +
    'whether it is refundable, and when it is charged. Use for any question about a NAMED fee or ' +
    'deposit other than the security deposit itself ("how much is my pet deposit?", "what am I ' +
    'paying for parking?", "what other fees do I have?"). These come from the signed lease. ' +
    'Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],
  async execute(_args, actor: AgentActor) {
    const rows = await query<FeeRow>(
      `SELECT lf.fee_type, lf.amount, lf.is_refundable, lf.due_timing, lf.description
         FROM lease_fees lf
         JOIN leases l          ON l.id  = lf.lease_id
         JOIN lease_tenants lt  ON lt.lease_id = l.id
        WHERE lt.tenant_id = $1
          AND lt.status = 'active'
          AND l.status   = 'active'
        ORDER BY lf.fee_type`,
      [actor.profileId]
    )

    if (rows.length === 0) {
      return {
        ok: true,
        hasFees: false,
        note:
          'There are no extra fees or deposits on this lease beyond rent. If they asked about a ' +
          'specific one (a pet deposit, parking, cleaning), say plainly that it is not on their ' +
          'lease — do not guess at an amount.',
      }
    }

    return {
      ok: true,
      hasFees: true,
      count: rows.length,
      fees: rows.map((r) => ({
        // "Pet deposit", not "pet_deposit".
        fee: LEASE_COLUMN_LABEL[r.fee_type as keyof typeof LEASE_COLUMN_LABEL] ?? r.fee_type,
        amount: r.amount != null ? Number(r.amount) : null,
        refundable: r.is_refundable,
        when: r.due_timing ? (TIMING_LABEL[r.due_timing] ?? r.due_timing) : null,
        note: r.description,
      })),
    }
  },
}
