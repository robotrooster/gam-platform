/**
 * S626 — CAN THE AGENT DO WHAT THE PERSON CAN DO?
 *
 * Nic: "we want the agent to be able to take any action that can be taken...
 * The agent can do anything as if it was a personal assistant in our software.
 * It cannot do anything that is not relevant to our software."
 *
 * That is a measurable claim, so this measures it. Every mutating endpoint on
 * the API is an action somebody can take; the question is which of them the
 * agent can take too.
 *
 * Three things are deliberately NOT counted as gaps:
 *   - credentials and card entry, which Claude must never handle at all;
 *   - other portals (business, POS, admin, public booking sites) and shelved
 *     features, which are siloed by directive — a landlord agent reaching into
 *     the business portal would be the bug;
 *   - read endpoints, which are a separate axis (see routeCoverage.test.ts).
 *
 * The number is a RATCHET. It may fall. It may not rise.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const ROUTES = join(__dirname, '../../routes')
const MUTATING = /^\s*\w+Router\.(post|patch|put|delete)\(\s*'([^']+)'/gm

/** Another portal, or a feature deliberately switched off. Not a gap. */
const SILOED = new Set([
  'admin', 'adminOps', 'businesses', 'businessCustomers', 'businessInventory',
  'businessPos', 'businessQuotes', 'businessUsers', 'businessWorkOrders',
  'businessAttachments', 'pos', 'pm', 'platform', 'routes', 'depots',
  'dumpLocations', 'vehicles', 'terminal', 'propane', 'publicPropertyBooking',
  'publicBooking', 'publicCustomerPortal', 'publicCardUpdate',
  'propertyBookingAdmin', 'subleases', 'subleaseInvitations', 'telemetry',
  'stripeWebhook', 'webhooks',
])

/** Claude must never do these, whatever the user asks. */
const FORBIDDEN = new Set(['auth', 'totp', 'emailOtp', 'stripe'])

function endpointsByArea() {
  const by: Record<string, number> = {}
  for (const fn of readdirSync(ROUTES)) {
    if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
    const area = fn.slice(0, -3)
    const src = readFileSync(join(ROUTES, fn), 'utf8')
    const n = [...src.matchAll(MUTATING)].length
    if (n) by[area] = n
  }
  return by
}

describe('action parity — what a person can do, the agent should be able to do', () => {
  const by = endpointsByArea()
  const reachable = Object.entries(by)
    .filter(([a]) => !SILOED.has(a) && !FORBIDDEN.has(a))
    .reduce((s, [, n]) => s + n, 0)

  it('the surface is roughly the size we think it is', () => {
    // A large move either way means routes were added or the silo list rotted.
    expect(reachable).toBeGreaterThan(250)
    expect(reachable).toBeLessThan(450)
  })

  it('nothing from another portal has crept into a landlord or tenant agent', async () => {
    // The directive that matters most: a landlord agent must never reach the
    // business portal, the admin surface, or the POS.
    const { AGENT_PROFILES } = await import('./profiles')
    const { getTool } = await import('./tools')
    for (const p of AGENT_PROFILES as any[]) {
      if (p.audience !== 'landlord' && p.audience !== 'tenant') continue
      for (const name of p.toolNames ?? []) {
        const t = getTool(name)
        expect(t, `${p.id} carries unknown tool ${name}`).toBeTruthy()
        // Every tool a profile holds must declare that audience.
        expect(t!.audiences, `${name} on ${p.id}`).toContain(p.audience)
      }
    }
  })

  it('credentials and card entry are not agent actions and never become one', async () => {
    const { getTool } = await import('./tools')
    const { AGENT_PROFILES } = await import('./profiles')
    const banned = /password|otp|two_factor|totp|card_number|payment_method_token|reset_credential/i
    for (const p of AGENT_PROFILES as any[]) {
      for (const name of p.toolNames ?? []) {
        expect(banned.test(name), `${name} looks like a credential action`).toBe(false)
        const t = getTool(name)
        if (t) expect(banned.test(JSON.stringify(t.parameters ?? {})), `${name} params`).toBe(false)
      }
    }
  })

  it('the write gap does not grow — a ratchet, lower it as tools land', async () => {
    const { AGENT_PROFILES } = await import('./profiles')
    // Keep this in step with new action verbs — a write tool the regex does not
    // recognise silently lowers the count and weakens the ratchet, which is how
    // this test would quietly stop protecting anything.
    const WRITE = /^(file|log|submit|request|respond|draft|book|capture|create|update|set|record|report|send|cancel|pay|add|remove|approve|assign|decide|flag|mark|message|post|reject|schedule|decline|resolve|bill|invite|close|apply|renew|terminate|upload|charge|void|categorize|ignore|acknowledge|offer|serve|hibernate|resume|retire|accept|revoke|reconcile|seed|issue|clock|complete|deny|withdraw|give|rename|archive|waive|nudge|answer|dismiss|register|change|explain|clear|start|finalize|renumber|activate|delete|generate|hold|sync|disconnect|reschedule|copy|confirm)_/
    const writes = new Set<string>()
    for (const p of AGENT_PROFILES as any[]) {
      if (p.audience !== 'landlord' && p.audience !== 'tenant') continue
      for (const n of p.toolNames ?? []) if (WRITE.test(n)) writes.add(n)
    }
    // S626: 26 when the audit was written, 41 after the dispatch landed and the
    // manifest was expanded. S628: 198 — landlord settings and entities, PM
    // delegation, properties with their fee and late-fee policy, the books,
    // one-off charges and credits, the maintenance side of the business,
    // inviting a tenant, what a unit actually is, the lease and its deposit
    // return, the tenant paying their rent, drawing a lease up, the monthly
    // utility cycle, the bank feed's deposit queue, amenities, and entry notices.
    // Raise as capability lands; never lower.
    expect(writes.size).toBeGreaterThanOrEqual(198)
  })
})
