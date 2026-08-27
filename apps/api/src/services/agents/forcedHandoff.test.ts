/**
 * S624 — a money dispute reaches a person even when the model refuses.
 *
 * "my last payout never arrived in my bank account. where is my money?" ended
 * without an escalation: the model answered about payouts, promised nobody, and
 * declined the nudge. synthesizeHandoff only fires when the model PROMISED a
 * handoff in prose, so it had nothing to latch onto, and a landlord asking where
 * their money went was handled entirely by a bot.
 *
 * The nudge is a request, and requests get refused — tool_choice 'required' is
 * documented in this same file as honoured "most of the time, not every time".
 * So the second time of asking is the last.
 *
 * This is tested directly because in the run that prompted it the model complied
 * and the forced path never executed. An untested safety net is one that fails
 * the first time it is actually needed.
 */
import { describe, it, expect } from 'vitest'
import { forceHandoff } from './agentRunner'

const entry = { id: 'landlord_entry', tier: 'entry', toolNames: ['escalate'] } as any
const senior = { id: 'landlord_escalation', tier: 'escalation', toolNames: ['escalate_to_human'] } as any
const noEscalation = { id: 'visitor', tier: 'entry', toolNames: ['get_property_info'] } as any

describe('forcing a handoff the model would not call', () => {
  it('hands an entry-tier turn UP to the senior agent', () => {
    const h = forceHandoff(entry, 'Your last payout was $1,240 on the 12th.')
    expect(h?.kind).toBe('tier')
  })

  // Routing rule (locked): only the senior tier reaches a real person.
  it('hands a senior-tier turn to a human', () => {
    const h = forceHandoff(senior, 'Your last payout was $1,240 on the 12th.')
    expect(h?.kind).toBe('human')
  })

  it('does not require the model to have promised anything', () => {
    // The whole point — no "I'll connect you", no "a specialist will reach out".
    const h = forceHandoff(entry, 'Payouts usually land within two business days.')
    expect(h).toBeTruthy()
    expect(h?.reason).toMatch(/would not escalate/i)
  })

  it('carries the answer forward so the human is not starting cold', () => {
    const h = forceHandoff(entry, 'Your last payout was $1,240 on the 12th to account ending 4471.')
    expect(h?.summary).toContain('$1,240')
    expect(h?.summary).toContain('4471')
  })

  // A profile with no escalation tool has nowhere to hand to; inventing one
  // would produce a handoff nobody receives.
  it('refuses when the profile cannot escalate at all', () => {
    expect(forceHandoff(noEscalation, 'anything')).toBeUndefined()
  })
})
