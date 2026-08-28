/**
 * S626 — WHICH TOOLS CAN THE PHRASE TABLE NOT REACH?
 *
 * The eval fell 45/45 -> 42/45 and all three failures were the same shape: a
 * tool with no phrase route behind it, which had only ever passed because the
 * model happened to pick it unaided. One prompt change tipped all three at once.
 *
 * An unrouted tool has no deterministic backstop. The account-data safety net
 * can only force a lookup the phrase table NAMES, so a tool nothing routes to
 * is a tool one prompt edit away from being unreachable — and nothing tells you
 * until an eval case fails.
 *
 * This test makes that list explicit instead of leaving it to be rediscovered.
 * It is a RATCHET: the allowed set may shrink, never grow. Adding a tool
 * without a route now fails here, at CPU speed, instead of on the next 26-minute
 * eval run.
 */
import { describe, it, expect } from 'vitest'
import { ROUTES_FOR_TEST } from './toolRouting'
import { AGENT_PROFILES } from './profiles'
import { getTool } from './tools'

/** Every tool named by at least one route, per audience. */
const routed = new Map<string, Set<string>>()
for (const r of ROUTES_FOR_TEST as any[]) {
  if (!routed.has(r.audience)) routed.set(r.audience, new Set())
  for (const t of r.tools) routed.get(r.audience)!.add(t)
}

/**
 * WHICH tools would a route actually help?
 *
 * Only the ones the forced path can run. That path deliberately runs a lookup
 * ONLY when it needs no argument from the model — "where the model must supply
 * a value, it is the only thing that knows what was meant, and guessing the
 * argument would be the invention this whole layer exists to prevent."
 *
 * So the tools worth flagging are READ tools with NO required parameters. An
 * action, or a lookup that must be told which law or which parcel, cannot be
 * backstopped by the table however it is worded, and listing those is noise
 * that hides the real gaps.
 */
const isAction = (name: string) =>
  /^(file|log|submit|request|respond|draft|book|capture|create|update|set|record|report|send|cancel|pay|add|remove|approve|assign|decide|flag|mark|message|post|reject|schedule|decline|resolve|bill|escalate|search|check|accept|revoke|reconcile|seed|issue|clock|complete|deny|withdraw|give|rename|archive|waive|nudge|answer|dismiss|register|change|explain|clear|start|finalize|renumber|activate|draft|delete|generate|hold|sync|disconnect|reschedule|copy|confirm|unassign|correct|auto|onboard|edit|migrate|park|reach|reapply|revoke|acknowledge|invite|close|charge|void|categorize|ignore|acknowledge|offer|serve|hibernate|resume|retire|apply|renew|terminate|upload)_/.test(name)
    || name === 'escalate' || name === 'escalate_to_human'

const takesNoArgs = (name: string): boolean => {
  const t: any = getTool(name)
  if (!t) return false
  const req = (t.parameters?.required ?? []) as string[]
  return req.length === 0
}

/** S626 baseline. Only ever lower this. */
// 29 when this audit was written, immediately after the eval caught three of
// them. Routing the backlog in the same session took it to 13: tenant contacts,
// notifications, documents, inspections, entry requests, payment status and
// termination quote; landlord payouts, applications, money-in-flight, team,
// maintenance team, unreconciled cash, service interruptions, background checks
// and work trade.
//
// What is LEFT is left on purpose. Each remaining one either needs an argument
// the model must supply (the law lookups, property tax facts) or has vocabulary
// too close to a route above it to separate safely without measuring — and
// measuring needs the GPU, which is disabled.
const BASELINE_GAPS = 13

describe('phrase-table coverage', () => {
  const gaps: string[] = []
  for (const profile of AGENT_PROFILES as any[]) {
    const have = routed.get(profile.audience) ?? new Set<string>()
    for (const name of profile.toolNames ?? []) {
      if (isAction(name) || !takesNoArgs(name)) continue
      if (!have.has(name)) gaps.push(`${profile.audience}/${name}`)
    }
  }
  const unique = [...new Set(gaps)].sort()

  it('reports every READ tool the table cannot reach', () => {
    // Printed so the list is visible in CI output, not just asserted.
    if (unique.length) console.log('\nUNROUTED READ TOOLS:\n  ' + unique.join('\n  ') + '\n')
    expect(Array.isArray(unique)).toBe(true)
  })

  it('does not grow — a new lookup must come with a route', () => {
    // RATCHET. Lower this number when you route something; never raise it.
    // S626 baseline, taken immediately after routing get_my_amenities and
    // get_books_summary (the two the eval caught).
    expect(unique.length).toBeLessThanOrEqual(BASELINE_GAPS)
  })

  it('keeps the tools the eval actually failed on routed', () => {
    expect(routed.get('tenant')).toContain('get_my_amenities')
    expect(routed.get('landlord')).toContain('get_books_summary')
    expect(routed.get('guest')).toContain('get_guest_amenities')
  })
})
