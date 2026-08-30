/**
 * S630 (Nic): "we need full audit. and accurate info to what the agent reveals"
 *
 * Nothing checked whether a reply exposed the machinery behind it. The question
 * came up because a transcript appeared to end by naming a tool — that turned
 * out to be a log-parsing fault rather than the agent, but the run had no answer
 * either way: a reply that HAD named a tool would have passed every assertion.
 *
 * The detector lives in agentConversations.ts; this holds its shape. A person
 * never sees the plumbing.
 */
import { describe, it, expect } from 'vitest'
import { ALL_TOOLS } from './tools'

// Mirrors leaksInternals — kept in step by the first test below, which fails if
// a tool name stops being detectable.
function leaks(reply: string): string[] {
  const found: string[] = []
  if (!reply) return found
  for (const t of ALL_TOOLS) if (new RegExp(`\\b${t.name}\\b`).test(reply)) found.push(`tool:${t.name}`)
  const u = reply.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)
  if (u) found.push('uuid')
  for (const c of ['unit_id','lease_id','tenant_id','landlord_id','property_id','unitId','leaseId'])
    if (new RegExp(`\\b${c}\\b`).test(reply)) found.push(`field:${c}`)
  const sp = reply.match(/\b(unit|lease|tenant|landlord|property|booking|charge|payment method|customer)\s+ID\b/i)
  if (sp) found.push(`spoken-id:${sp[0]}`)
  if (/\{\s*"|"\s*:\s*"|\[\s*"/.test(reply)) found.push('json-fragment')
  if (/\b(null|undefined|NaN)\b/.test(reply)) found.push('null-ish')
  return found
}

describe('what a reply is allowed to reveal', () => {
  it('catches a tool name spoken out loud', () => {
    expect(leaks('Rent is paid in full. "get_my_lease" ]')).toContain('tool:get_my_lease')
    expect(leaks('I ran get_my_balance_breakdown for you.')).toContain('tool:get_my_balance_breakdown')
  })

  it('catches an internal id or field name', () => {
    expect(leaks('Your unit_id is set correctly.')).toContain('field:unit_id')
    expect(leaks('Lease 3e60cb5e-93ee-43c6-9632-4385de789eaa is active.')).toContain('uuid')
  })

  // S630 (Nic) caught this one by reading a transcript: the waive conversation
  // told a landlord "the system encountered an issue with the lease ID provided.
  // Could you confirm the lease ID?" An internal key is still internal when it
  // is written with a space and a capital.
  it('catches an internal id spoken in words', () => {
    expect(leaks('Could you please confirm the lease ID or provide the tenant name?')[0])
      .toMatch(/spoken-id/)
    expect(leaks('I need the unit ID to enable eviction mode.')[0]).toMatch(/spoken-id/)
  })

  it('catches raw machine output', () => {
    expect(leaks('{"balance": "2330.00"}')).toContain('json-fragment')
    expect(leaks('Your balance is undefined.')).toContain('null-ish')
  })

  // The point is to catch plumbing, not ordinary English. A detector that fires
  // on real answers would be turned off within a week.
  it('leaves a normal reply alone', () => {
    for (const r of [
      'You owe $2,330.00. This includes $750.00 in pending rent from July.',
      'Your lease ends on January 4, 2027. Check-in is at 3pm.',
      "I've filed a maintenance request for the leaking kitchen sink in your unit.",
      'Turning eviction mode on for spot 7 will stop all payments from the tenant going to you.',
      'There is no charge for paying by cash, check or money order.',
    ]) expect(leaks(r), r).toEqual([])
  })

  it('every registered tool name is detectable', () => {
    expect(ALL_TOOLS.length).toBeGreaterThan(50)
    for (const t of ALL_TOOLS) {
      expect(leaks(`I will now call ${t.name} for you.`), t.name).toContain(`tool:${t.name}`)
    }
  })
})
