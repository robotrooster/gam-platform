/**
 * S630: confirmFirst was a sentence in a tool description and a boolean the
 * MODEL fills in. Neither is a control.
 *
 * Measured: "I'm starting an eviction on spot 7" — one turn, nothing asked, no
 * consequence stated — and the unit came back suspended with payment_block set.
 * Eviction mode pauses every payment from that unit, which in many states resets
 * the eviction clock.
 */
import { describe, it, expect } from 'vitest'
import { confirmFirstSatisfied } from './agentRunner'

const AGENT_SPOKE = [
  { role: 'user', content: "I'm starting an eviction on spot 7" },
  { role: 'assistant', content: 'Turning eviction mode on pauses every payment from that unit. Do you want me to switch it on?' },
]

describe('confirmFirstSatisfied', () => {
  it('never on the opening turn — nothing has been put to them yet', () => {
    expect(confirmFirstSatisfied("I'm starting an eviction on spot 7", [])).toBe(false)
    expect(confirmFirstSatisfied('waive the late fee on 204', [])).toBe(false)
    // Even an emphatic first mention is still a first mention.
    expect(confirmFirstSatisfied('yes I am definitely evicting them', [])).toBe(false)
  })

  it('allows it once the consequence was stated and they agreed', () => {
    for (const yes of ['yes, turn it on', 'go ahead', 'do it', 'yep', 'confirmed', 'please do']) {
      expect(confirmFirstSatisfied(yes, AGENT_SPOKE), yes).toBe(true)
    }
  })

  it('a reply that is not agreement does not count as agreement', () => {
    for (const no of [
      'what would that do?',
      'hold on, let me think',
      'no, not yet',
      'how much is the late fee?',
    ]) expect(confirmFirstSatisfied(no, AGENT_SPOKE), no).toBe(false)
  })

  it('history with no assistant turn is not a conversation they could answer', () => {
    expect(confirmFirstSatisfied('yes', [{ role: 'user', content: 'evict spot 7' }])).toBe(false)
  })
})
