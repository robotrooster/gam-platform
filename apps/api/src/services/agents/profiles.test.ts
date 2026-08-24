/**
 * Agent profile registry (Step 2).
 *
 * Pins registry integrity and the structural guarantees the handoff's
 * future-proofing depends on: the four CS profiles exist on the generic
 * 3-axis structure, ids are unique and looked up correctly, and every
 * profile carries the shared guardrails. No model / network needed.
 */

import { describe, it, expect } from 'vitest'
import {
  AGENT_PROFILES,
  getProfile,
  requireProfile,
  getEntryProfile,
} from './profiles'
import { AGENT_TYPES, AGENT_AUDIENCES, AGENT_TIERS } from './types'

// Customer-service profiles only (the sales agent has its own prompt/rules).
const CS = AGENT_PROFILES.filter((p) => p.agentType === 'customer_service')

describe('agent profile registry', () => {
  it('contains exactly the four CS profiles', () => {
    expect(CS.map((p) => p.id).sort()).toEqual([
      'landlord_entry',
      'landlord_escalation',
      'tenant_entry',
      'tenant_escalation',
    ])
  })

  it('has unique ids', () => {
    const ids = AGENT_PROFILES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every profile uses valid axis values', () => {
    for (const p of AGENT_PROFILES) {
      expect(AGENT_TYPES).toContain(p.agentType)
      expect(AGENT_AUDIENCES).toContain(p.audience)
      expect(AGENT_TIERS).toContain(p.tier)
    }
  })

  // S620: ONE scope per audience and no shared pool. Every profile is asserted
  // here, not just the four CS ones — the guest and visitor agents are exactly
  // the ones that used to read nothing but tenant-voiced account articles.
  it('gives every profile exactly one knowledge scope, matching its audience', () => {
    expect(requireProfile('tenant_entry').knowledgeScopes).toEqual(['tenant'])
    expect(requireProfile('tenant_escalation').knowledgeScopes).toEqual(['tenant'])
    expect(requireProfile('landlord_entry').knowledgeScopes).toEqual(['landlord'])
    expect(requireProfile('landlord_escalation').knowledgeScopes).toEqual(['landlord'])
    expect(requireProfile('sales_entry').knowledgeScopes).toEqual(['sales'])
    expect(requireProfile('guest_entry').knowledgeScopes).toEqual(['guest'])
    expect(requireProfile('visitor_entry').knowledgeScopes).toEqual(['visitor'])
  })

  it('covers both audiences at both tiers (CS)', () => {
    const combos = CS.map((p) => `${p.audience}:${p.tier}`).sort()
    expect(combos).toEqual([
      'landlord:entry',
      'landlord:escalation',
      'tenant:entry',
      'tenant:escalation',
    ])
  })

  it('bakes the shared guardrails into every CS system prompt', () => {
    for (const p of CS) {
      expect(p.systemPrompt).toContain('Never invent facts')
      expect(p.systemPrompt).toContain('Hard stops')
      // Law posture: GAM may flag OBJECTIVE figure mismatches but gives no
      // legal advice/interpretation, and points to an attorney.
      expect(p.systemPrompt).toContain('not legal advice or interpretation')
      expect(p.systemPrompt).toContain('consult a licensed attorney')
    }
  })

  it('gives each agent its name and uses it in the system prompt', () => {
    expect(requireProfile('tenant_entry').name).toBe('Ava')
    expect(requireProfile('tenant_escalation').name).toBe('Samantha')
    expect(requireProfile('landlord_entry').name).toBe('David')
    expect(requireProfile('landlord_escalation').name).toBe('Sonny')
    for (const p of AGENT_PROFILES) {
      expect(p.systemPrompt).toContain(p.name)
    }
  })

  it('wires escalation tools by tier: entry escalates up, seniors escalate to human', () => {
    expect(requireProfile('tenant_entry').toolNames).toContain('escalate')
    expect(requireProfile('landlord_entry').toolNames).toContain('escalate')
    expect(requireProfile('tenant_escalation').toolNames).toContain('escalate_to_human')
    expect(requireProfile('landlord_escalation').toolNames).toContain('escalate_to_human')
    // entry agents do NOT get the straight-to-human tool
    expect(requireProfile('tenant_entry').toolNames).not.toContain('escalate_to_human')
  })

  it('tells every CS agent it is the platform, not the landlord', () => {
    for (const p of CS) {
      expect(p.systemPrompt).toContain('NOT the landlord')
    }
  })

  it('registers the sales agent as its own type/audience with the capture_lead tool', () => {
    const sales = requireProfile('sales_entry')
    expect(sales.agentType).toBe('sales')
    expect(sales.audience).toBe('prospect')
    expect(sales.toolNames).toEqual(['capture_lead', 'get_available_call_times', 'book_sales_call'])
    expect(sales.systemPrompt).toContain('Lucy')
    // sales does NOT carry the CS guardrails (its own prompt)
    expect(sales.systemPrompt).not.toContain('Hard stops')
  })

  it('routes tenant property/maintenance issues to a maintenance request, not escalation', () => {
    for (const id of ['tenant_entry', 'tenant_escalation']) {
      const prompt = requireProfile(id).systemPrompt
      expect(prompt).toMatch(/maintenance request/i)
      expect(prompt).toMatch(/property-level matter that belongs to the LANDLORD/i)
    }
    // landlord agents do not carry the tenant property-routing block (they
    // receive maintenance requests, they don't file them)
    for (const id of ['landlord_entry', 'landlord_escalation']) {
      expect(requireProfile(id).systemPrompt).not.toMatch(/property-level matter that belongs to the LANDLORD/i)
    }
  })

  it('escalation prompts route to a human; entry prompts route up a tier', () => {
    expect(requireProfile('tenant_entry').systemPrompt).toMatch(/escalation agent/i)
    expect(requireProfile('tenant_escalation').systemPrompt).toMatch(/HUMAN admin/)
    expect(requireProfile('landlord_entry').systemPrompt).toMatch(/escalation agent/i)
    expect(requireProfile('landlord_escalation').systemPrompt).toMatch(/HUMAN admin/)
  })

  it('getProfile / requireProfile resolve by id', () => {
    expect(getProfile('tenant_entry')?.label).toBe('Tenant — Entry')
    expect(getProfile('nope')).toBeUndefined()
    expect(() => requireProfile('nope')).toThrow('Unknown agent profile: nope')
  })

  it('getEntryProfile returns the entry tier for an audience', () => {
    expect(getEntryProfile('tenant')?.id).toBe('tenant_entry')
    expect(getEntryProfile('landlord')?.id).toBe('landlord_entry')
  })
})

// ============================================================
// S617 (Nic) — a product on the other side of the platform is not
// "not relevant to you", it is not known.
//
// Retrieval already scopes what an agent can LOOK UP, but the model still knows
// the words, and the natural reply to "what is FlexVault?" is a helpful "that's
// a landlord product, not something on your side" — which confirms it exists
// and names whose it is. Nic: "I don't want it to acknowledge it and say that
// it's not relevant to them. I want it to say I don't have any knowledge about
// this."
// ============================================================
describe('anything on another side of the platform is unknown, not declined (S617)', () => {
  const withRule = AGENT_PROFILES.filter(p => p.systemPrompt.includes('OUTSIDE YOUR SIDE OF THE PLATFORM'))

  it('every profile carries the rule — a gap is a leak', () => {
    expect(withRule.length).toBe(AGENT_PROFILES.length)
  })

  it('covers more than product names — features, screens, prices, workflows', () => {
    for (const p of withRule) {
      expect(p.systemPrompt).toContain('any feature, screen, price, workflow or arrangement')
    }
  })

  it('tells renter-facing agents the landlord side is not theirs', () => {
    for (const p of AGENT_PROFILES.filter(p => p.audience === 'tenant')) {
      expect(p.systemPrompt).toContain('FlexVault')
      expect(p.systemPrompt).toContain('You serve renters')
    }
  })

  it('tells landlord-facing agents the renter side is not theirs', () => {
    for (const p of AGENT_PROFILES.filter(p => p.audience === 'landlord')) {
      expect(p.systemPrompt).toContain('FlexDeposit')
      expect(p.systemPrompt).toContain('FlexCredit')
      // FlexVault IS a landlord product — it must never be on THEIR unknown list.
      const block = p.systemPrompt.slice(p.systemPrompt.indexOf('OUTSIDE YOUR SIDE'))
      expect(block.split('\n').slice(0, 2).join('\n')).not.toContain('FlexVault')
    }
  })

  it('bans the ROBOT tell — reciting its own limits', () => {
    for (const p of withRule) {
      expect(p.systemPrompt).toContain("I don't have that in my knowledge base")
      expect(p.systemPrompt).toContain('outside my configured scope')
      expect(p.systemPrompt).toContain('Sounding like a machine reciting its limits')
    }
  })

  it('bans the GUARDING tell — a polite decline that confirms it exists', () => {
    for (const p of withRule) {
      expect(p.systemPrompt).toContain("I can't discuss that")
      expect(p.systemPrompt).toContain("that's a landlord feature")
      expect(p.systemPrompt).toContain('not relevant to your account')
      expect(p.systemPrompt).toContain('Sounding like you are guarding something')
    }
  })

  it('gives the agent something natural to actually say', () => {
    for (const p of withRule) {
      expect(p.systemPrompt).toContain("doesn't ring a bell")
      expect(p.systemPrompt).toContain('in your own voice, varied, brief, unbothered')
    }
  })

  it('holds the line if the person presses', () => {
    for (const p of withRule) expect(p.systemPrompt).toContain('If they press, stay unbothered and consistent')
  })

  it('does not route it to a human — there is nothing to escalate', () => {
    for (const p of withRule) expect(p.systemPrompt).toContain('Do NOT escalate it')
  })

  it('leaves the AI-honesty rule untouched — this is scope, not identity', () => {
    for (const p of AGENT_PROFILES) {
      if (p.audience === 'prospect' || p.audience === 'guest' || p.audience === 'visitor') continue
      expect(p.systemPrompt).toContain('NEVER claim to be a human')
    }
  })
})
