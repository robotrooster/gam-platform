/**
 * S626 — agent tools generated from the portal-action allowlist.
 *
 * One AgentTool per entry in portalActions.ts. They are real, individually
 * named tools rather than a single generic "do_thing(action)" because tool
 * SELECTION is the thing the model is actually good at: given twenty well-named
 * tools with descriptions written in a person's words it picks correctly, and
 * given one tool with an action enum it picks the enum badly and silently.
 *
 * The body of every one of them is the same: hand the action id and the
 * arguments to the dispatcher, which checks the allowlist and the audience,
 * refuses without credentials, and calls the real endpoint. None of them
 * contains a line of route logic, which is the entire point.
 */
import { dispatchPortalAction } from '../portalDispatch'
import { PORTAL_ACTIONS, type PortalAction } from '../portalActions'
import type { AgentTool, AgentActor } from './types'

function toTool(a: PortalAction): AgentTool {
  const confirm = a.confirmFirst
    ? '\nCONFIRM FIRST — read back what you are about to do and get an explicit yes. This changes ' +
      'their account and some of it cannot be undone.'
    : ''
  return {
    name: a.id,
    description: a.description + confirm,
    parameters: { type: 'object', properties: a.params, required: a.required ?? [] },
    audiences: [a.audience] as any,
    async execute(args: Record<string, unknown>, actor: AgentActor) {
      const r = await dispatchPortalAction(a.id, args ?? {}, actor)
      if (!r.ok) {
        return {
          ok: false,
          error: r.error,
          // The agent must not dress a refusal up as success, and must not
          // invent a reason the API did not give.
          tellThem:
            r.refused === 'no_credentials'
              ? 'Say plainly that this cannot be done from here and do NOT claim it was done.'
              : 'Tell them what the system said, in their words. Do not retry the same thing twice.',
        }
      }
      return { ok: true, done: true, result: r.data }
    },
  }
}

export const PORTAL_ACTION_TOOLS: readonly AgentTool[] = PORTAL_ACTIONS.map(toTool)
