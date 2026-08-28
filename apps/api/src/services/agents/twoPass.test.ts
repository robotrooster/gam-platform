/**
 * S628 — the deciding prompt must stay small, because that is the whole point.
 *
 * The measurement this rests on, taken the day it was written: same question,
 * same 67 tools, only the system prompt varying —
 *
 *    2 KB → calls the tool        16 KB → NO TOOL, invents a figure
 *    4 KB → calls the tool        26 KB → NO TOOL, invents a figure
 *    8 KB → calls the tool
 *
 * So the deciding prompt has a BUDGET, and a budget nothing enforces is a
 * budget somebody spends. The failure mode if it creeps back over the cliff is
 * silent and expensive: no error, no red test, just an agent that quietly stops
 * looking things up and starts making them up — which is what production was
 * doing this morning at 26 KB.
 */
import { describe, it, expect } from 'vitest'
import { AGENT_PROFILES } from './profiles'
import { buildDecisionPrompt, buildComposeInstruction } from './decisionPrompt'

/** Measured cliff is between 8 KB and 16 KB. Held far below it on purpose. */
const BUDGET_BYTES = 4 * 1024

describe('the deciding prompt', () => {
  it.each(AGENT_PROFILES.map((p) => [p.id, p] as const))(
    '%s stays inside the tool-calling budget', (_id, p) => {
      const built = buildDecisionPrompt(p)
      expect(built.length,
        `${p.id} deciding prompt is ${(built.length / 1024).toFixed(1)} KB. The cliff where ` +
        'this model stops calling tools is between 8 and 16 KB; keep it near 1.').toBeLessThan(BUDGET_BYTES)
    })

  it('still says the one thing that must never be dropped', () => {
    // Everything else in here is arguable. This is not: without it the model
    // answers account questions from imagination, which is the exact failure
    // the whole system exists to prevent.
    for (const p of AGENT_PROFILES) {
      const built = buildDecisionPrompt(p).toLowerCase()
      expect(built, p.id).toContain('must come from a tool')
      expect(built, p.id).toContain('never state such a fact')
    }
  })

  it('does not tell somebody without an account about their account', () => {
    // The first version built this line from one template, and produced, for a
    // prospect: "ANYTHING ABOUT THIS PERSON'S OWN ACCOUNT — what GAM costs and
    // what it does". A prospect has no account and neither does a visitor.
    // That is not clumsy phrasing, it is a false premise handed to the model
    // every turn — and the risk runs both ways: it can read public pricing as
    // account data, or decide the look-it-up rule does not apply because there
    // is no account to look up.
    const accountless = AGENT_PROFILES.filter(
      (p) => p.audience === 'prospect' || p.audience === 'visitor')
    expect(accountless.length).toBeGreaterThan(0)
    for (const p of accountless) {
      expect(buildDecisionPrompt(p), p.id).not.toMatch(/own account/i)
    }
  })

  it('names the audience, so it cannot offer the wrong side its own tools', () => {
    for (const p of AGENT_PROFILES) {
      expect(buildDecisionPrompt(p)).toContain(p.audience.toUpperCase())
    }
  })

  it('carries the hard stops — escalation is itself a tool call', () => {
    for (const p of AGENT_PROFILES) {
      const built = buildDecisionPrompt(p).toLowerCase()
      expect(built, p.id).toContain('escalate')
      expect(built, p.id).toMatch(/refund|money/)
      expect(built, p.id).toContain('permissions')
    }
  })

  it('quotes no figure at all — there is nothing here to lift', () => {
    // promptDataCollision guards the big prompt against real records. This one
    // is stricter: a deciding prompt has no reason to contain a dollar amount,
    // so any at all is a mistake.
    for (const p of AGENT_PROFILES) {
      expect(buildDecisionPrompt(p).match(/\$[\d,]+/g) ?? [], p.id).toEqual([])
    }
  })

  it('tells the composing pass where its facts must come from', () => {
    const withTools = buildComposeInstruction(true)
    expect(withTools).toContain('must appear in those results')
    // And when nothing ran, it must say so rather than leaving the model free.
    const without = buildComposeInstruction(false)
    expect(without).toMatch(/no lookup ran/i)
    expect(without).toMatch(/state no account-specific fact/i)
  })
})
