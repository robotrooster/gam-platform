/**
 * S628 — DOING THE SAME THING TWICE IS A SILENT FAILURE.
 *
 * From the validation run:
 *
 *   ▸ my kitchen sink has been leaking since yesterday
 *     "I've filed a maintenance request for the leaking kitchen sink."
 *   ▸ ok great, thanks — so that is definitely logged?
 *     "The maintenance request is already logged."   ← the reply is CORRECT
 *     tools: file_maintenance_request                ← and it filed a second one
 *
 * The reply was right and the side effect was wrong, which is the worst shape a
 * bug can take: nothing in the transcript shows it, nobody reports it, and
 * somebody eventually finds two work orders for one sink. On a money action —
 * charge_a_fee, issue_tenant_credit, pay_bill — the same shape bills a tenant
 * twice for one thing while telling them it was handled once.
 *
 * The prompt has said not to since S626. That was not enough, and four failed
 * rewrites of the waiver instruction on the same day are the argument against
 * trying a fifth wording. The conversation log already stores every call with
 * its arguments, so this is decided on the record rather than requested.
 *
 * MATCHED ON NAME **AND** ARGUMENTS, deliberately. A landlord may legitimately
 * bill two different fees, add two units, or credit two tenants in one
 * conversation — those differ in their arguments. What cannot be legitimate is
 * the identical call twice, which is always either the model re-reading a
 * confirmation as an instruction, or a retry of something that already worked.
 *
 * READS ARE NEVER BLOCKED. Asking twice what somebody owes is free and often
 * correct — the balance may have changed, and refusing it would push the agent
 * back toward answering from memory, which is the failure everything here
 * exists to prevent.
 */
import { isActionTool } from './toolSelection'

export interface PriorCall { name: string; args: unknown }

/** Stable across key order, so `{a,b}` and `{b,a}` are one call, not two. */
export function argsFingerprint(args: unknown): string {
  const norm = (v: any): any => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(norm)
    return Object.keys(v).sort().reduce((o: any, k) => { o[k] = norm(v[k]); return o }, {})
  }
  try { return JSON.stringify(norm(args ?? {})) } catch { return '' }
}

/**
 * Has this exact action already been carried out in this conversation?
 *
 * Returns the wording for the model when it has — phrased as a RESULT rather
 * than an error, because the model handles "here is what happened" far better
 * than "you did something wrong", and because it is true: the thing the person
 * asked for IS done.
 */
export function alreadyDone(
  name: string,
  args: unknown,
  prior: readonly PriorCall[],
): { repeated: true; tellThem: string } | null {
  if (!isActionTool(name)) return null
  const fp = argsFingerprint(args)
  const hit = prior.some((p) => p.name === name && argsFingerprint(p.args) === fp)
  if (!hit) return null
  return {
    repeated: true,
    tellThem:
      'This was ALREADY DONE earlier in this conversation and has NOT been done again. ' +
      'They are confirming, not asking for a second one. Tell them it is done — in a new ' +
      'sentence, not by repeating what you said before — and answer whatever else they asked.',
  }
}
