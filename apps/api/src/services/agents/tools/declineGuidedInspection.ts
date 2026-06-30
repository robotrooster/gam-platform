/**
 * Tool: decline_guided_inspection (tenant ACTION).
 *
 * "Ask once, never re-prompt" (#23). When a tenant declines the agent's offer
 * to walk them through a self-recorded (remote) move-in/move-out inspection,
 * the agent calls this to record the decline. get_inspection_checklist then
 * surfaces `guidedWalkthroughDeclined: true` on later visits so the agent
 * stops offering — it only guides if the tenant brings it up again.
 *
 * Hard-scoped to actor.profileId (unit_inspections.tenant_id). Targets a given
 * inspectionId, else the tenant's most recent OPEN inspection. Idempotent.
 */
import { queryOne } from '../../../db'
import type { AgentTool, AgentActor } from './types'

export const declineGuidedInspection: AgentTool = {
  name: 'decline_guided_inspection',
  description:
    'Record that the tenant does NOT want you to walk them through their inspection right now. Call this ' +
    'when they decline your offer of a guided/remote walkthrough, so you don’t keep asking. Targets a ' +
    'specific inspectionId, or the tenant’s most recent open inspection if omitted. They can still do the ' +
    'inspection themselves in the app, and can ask you for help later.',
  parameters: {
    type: 'object',
    properties: {
      inspectionId: { type: 'string', description: 'A specific inspection id. Omit to use the tenant’s most recent open inspection.' },
    },
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const inspectionId = String(args.inspectionId ?? '').trim()

    const insp = inspectionId
      ? await queryOne<{ id: string }>(
          `SELECT id FROM unit_inspections WHERE id = $1 AND tenant_id = $2`,
          [inspectionId, actor.profileId]
        )
      : await queryOne<{ id: string }>(
          `SELECT id FROM unit_inspections
            WHERE tenant_id = $1
            ORDER BY (status NOT IN ('finalized','cancelled')) DESC, COALESCE(scheduled_for, created_at) DESC
            LIMIT 1`,
          [actor.profileId]
        )

    if (!insp) {
      return { ok: false, error: inspectionId ? 'No such inspection on your account.' : 'You don’t have any inspections on record.' }
    }

    await queryOne(
      `UPDATE unit_inspections
          SET guided_walkthrough_declined = true,
              guided_walkthrough_declined_at = COALESCE(guided_walkthrough_declined_at, now())
        WHERE id = $1 AND tenant_id = $2
        RETURNING id`,
      [insp.id, actor.profileId]
    )

    return { ok: true, inspectionId: insp.id, declined: true }
  },
}
