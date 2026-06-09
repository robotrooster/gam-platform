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

  it('scopes knowledge per audience (tenant/landlord + shared)', () => {
    expect(requireProfile('tenant_entry').knowledgeScopes).toEqual(['tenant', 'shared'])
    expect(requireProfile('tenant_escalation').knowledgeScopes).toEqual(['tenant', 'shared'])
    expect(requireProfile('landlord_entry').knowledgeScopes).toEqual(['landlord', 'shared'])
    expect(requireProfile('landlord_escalation').knowledgeScopes).toEqual(['landlord', 'shared'])
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
    expect(sales.toolNames).toEqual(['capture_lead'])
    expect(sales.systemPrompt).toContain('Jordan')
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
