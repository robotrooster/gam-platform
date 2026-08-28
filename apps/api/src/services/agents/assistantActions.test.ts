/**
 * S626 — the agent as a secretary, not a search box.
 *
 * Nic: "the agent is to act as a personal assistant for the user. Anything that
 * I could get on and do as a landlord, I should be able to communicate to the
 * agent and have the agent do it for me... If I don't know where a certain
 * feature is maybe hidden inside different submenus, the agent can access that
 * information for me."
 *
 * The gap was measured, not guessed: the landlord agent held 17 write tools
 * against hundreds of mutating endpoints, and the tenant agent could not touch
 * the Surveys page at all — the page whose classic use is the renewal-intent
 * questionnaire Nic named.
 */
import { describe, it, expect } from 'vitest'
import { EXPENSE_CATEGORIES } from '@gam/shared'
import { getTool, getToolsForProfile } from './tools'
import { requireProfile } from './profiles'
import { routePlan } from './toolRouting'

describe('a tenant can answer a survey by talking', () => {
  it('both tools exist and are tenant-only', () => {
    for (const n of ['get_my_surveys', 'submit_survey_response']) {
      const t = getTool(n)
      expect(t, n).toBeTruthy()
      expect(t!.audiences).toEqual(['tenant'])
    }
  })

  it('the tenant profile actually holds them — a tool nobody carries never runs', () => {
    const names = getToolsForProfile(requireProfile('tenant_entry')).map((t) => t.name)
    expect(names).toContain('get_my_surveys')
    expect(names).toContain('submit_survey_response')
  })

  it('reaches the survey from how a tenant actually says it', () => {
    const TOOLS = ['get_my_surveys', 'get_my_landlord_renewal_tendency', 'get_my_lease']
    const t = (m: string) => routePlan(m, 'tenant' as any, TOOLS).tools
    // Nobody says "survey" — they say this.
    expect(t('am I supposed to say if I am staying?')).toContain('get_my_surveys')
    expect(t('do I have any surveys?')).toContain('get_my_surveys')
    expect(t('what is that form my landlord sent')).toContain('get_my_surveys')
  })

  it('submitting demands the survey and the answers — it cannot half-send', () => {
    const t = getTool('submit_survey_response')!
    expect((t.parameters as any).required).toEqual(['surveyId', 'answers'])
    // One shot only, so the description has to say so.
    expect(t.description).toMatch(/only be answered once|CONFIRM FIRST/i)
  })
})

describe('a landlord can record a cost by talking', () => {
  it('log_expense exists, is landlord-only, and the profile carries it', () => {
    const t = getTool('log_expense')
    expect(t).toBeTruthy()
    expect(t!.audiences).toEqual(['landlord'])
    expect(getToolsForProfile(requireProfile('landlord_entry')).map((x) => x.name)).toContain('log_expense')
  })

  it('needs an amount, a category and a date — never a uuid from the landlord', () => {
    const p = getTool('log_expense')!.parameters as any
    expect(p.required).toEqual(['amount', 'category', 'expenseDate'])
    // The whole point: they name the place in their own words.
    expect(p.properties.place.description).toMatch(/own words|Apt|Oak/i)
    expect(JSON.stringify(p)).not.toMatch(/uuid/i)
  })

  it('offers the real categories rather than letting the model invent one', () => {
    const d = getTool('log_expense')!.description
    for (const c of ['maintenance', 'insurance', 'property_tax', 'other']) {
      expect(d, c).toContain(c)
    }
    expect(EXPENSE_CATEGORIES).toContain('repairs')
  })

  it('says it writes to the books and must be confirmed first', () => {
    expect(getTool('log_expense')!.description).toMatch(/CONFIRM FIRST/)
    expect(getTool('log_expense')!.description).toMatch(/writes to their books/i)
  })
})

describe('the silo holds', () => {
  it('a tenant cannot reach a landlord action, and vice versa', () => {
    const tenant = getToolsForProfile(requireProfile('tenant_entry')).map((t) => t.name)
    const landlord = getToolsForProfile(requireProfile('landlord_entry')).map((t) => t.name)
    expect(tenant).not.toContain('log_expense')
    expect(landlord).not.toContain('submit_survey_response')
    expect(landlord).not.toContain('get_my_surveys')
  })
})

describe("a tenant can send their landlord a message — Nic's own example", () => {
  it('exists, is tenant-only, and the profile carries it', () => {
    const t = getTool('message_my_landlord')
    expect(t).toBeTruthy()
    expect(t!.audiences).toEqual(['tenant'])
    expect(getToolsForProfile(requireProfile('tenant_entry')).map((x) => x.name))
      .toContain('message_my_landlord')
  })

  it('refuses the things that have a real tool, and names it', async () => {
    const t = getTool('message_my_landlord')!
    const ACTOR = { userId: 'u', role: 'tenant', profileId: 't1' } as any
    for (const [msg, expected] of [
      ['the kitchen sink is leaking again', 'file_maintenance_request'],
      ['my neighbour upstairs plays loud music every night', 'log_complaint'],
      ['I want to renew for another year', 'request_lease_renewal'],
    ] as const) {
      const r: any = await t.execute({ message: msg }, ACTOR)
      expect(r.ok, msg).toBe(false)
      expect(r.useInstead, msg).toBe(expected)
      // It must not quietly send anyway and claim success.
      expect(r.sent).toBeUndefined()
    }
  })

  it('lets through what genuinely has nowhere else to go', async () => {
    // Nic's example verbatim. Reaches the DB lookup rather than being bounced,
    // which is the branch under test — no lease in this context, so it stops
    // there and must NOT claim it sent anything.
    const t = getTool('message_my_landlord')!
    const r: any = await t.execute(
      { message: 'I want to upgrade to a three bedroom when you have one available' },
      { userId: 'u', role: 'tenant', profileId: '00000000-0000-0000-0000-000000000000' } as any,
    )
    expect(r.wrongTool).toBeUndefined()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no active lease/i)
    expect(r.error).toMatch(/do NOT tell them it was sent/i)
  })

  it('says plainly that it is one-way', () => {
    expect(getTool('message_my_landlord')!.description).toMatch(/ONE-WAY/i)
    expect(getTool('message_my_landlord')!.description).toMatch(/CONFIRM FIRST/)
  })

  it('the landlord cannot use it, and the tenant cannot use the landlord side', () => {
    const landlord = getToolsForProfile(requireProfile('landlord_entry')).map((t) => t.name)
    const tenant = getToolsForProfile(requireProfile('tenant_entry')).map((t) => t.name)
    expect(landlord).not.toContain('message_my_landlord')
    expect(tenant).not.toContain('message_tenant')
  })
})

describe('surveys are anonymous, and the agent must never promise otherwise', () => {
  // Nic's S577 decision, enforced server-side in routes/surveys.ts: "Anonymous
  // protects tenants from retaliation (landlord-tenant power dynamic)." A
  // survey can say fourteen of twenty are staying. It can never say which
  // fourteen — and a landlord only discovers that after the answers are in and
  // cannot be collected again.
  it('the create tool warns before sending, not after', () => {
    const d = getTool('create_and_send_survey')!.description
    expect(d).toMatch(/ANONYMOUS AND THAT CANNOT BE TURNED OFF/i)
    expect(d).toMatch(/never who said what/i)
    // And it points at what DOES answer "who is renewing".
    expect(d).toContain('get_lease_expirations')
  })

  it('the results tool refuses to imply a name could be found', () => {
    const d = getTool('get_survey_results')!.description
    expect(d).toMatch(/WITHOUT a name/i)
    expect(d).toMatch(/do not guess/i)
  })

  it('the results query never joins users — there is no name to leak', async () => {
    const src = String(getTool('get_survey_results')!.execute)
    expect(src).not.toMatch(/JOIN users/i)
  })

  it('is landlord-only, and tenants keep their own half', () => {
    for (const n of ['create_and_send_survey', 'get_survey_results']) {
      expect(getTool(n)!.audiences, n).toEqual(['landlord'])
    }
    const tenant = getToolsForProfile(requireProfile('tenant_entry')).map((t) => t.name)
    expect(tenant).not.toContain('create_and_send_survey')
    expect(tenant).not.toContain('get_survey_results')
  })

  it('a multiple-choice question without options is refused before anything is written', async () => {
    const r: any = await getTool('create_and_send_survey')!.execute(
      { property: 'x', title: 'T', questions: [{ prompt: 'Staying?', type: 'multiple_choice' }] },
      { userId: 'u', role: 'landlord', profileId: '00000000-0000-0000-0000-000000000000' } as any,
    )
    expect(r.ok).toBe(false)
    // Property resolution fails first for a nonexistent landlord, which is
    // itself the right order: never touch the survey tables for a property
    // that is not theirs.
    expect(r.error).toMatch(/matches|options/i)
  })
})

describe('renewal intent — the per-lease questionnaire, not the anonymous survey', () => {
  // Two different features that both get called "the survey":
  //   surveys.*            — anonymous, property-wide, general questions
  //   leases.tenant_renewal_intent — named, per-lease, on a legal clock
  // Conflating them is how a landlord gets told a survey can identify who is
  // renewing, and how a tenant's notice to leave goes nowhere.
  it('exists, is tenant-only, and the profile carries it', () => {
    const t = getTool('submit_renewal_intent')
    expect(t).toBeTruthy()
    expect(t!.audiences).toEqual(['tenant'])
    expect(getToolsForProfile(requireProfile('tenant_entry')).map((x) => x.name))
      .toContain('submit_renewal_intent')
  })

  it('takes only the three values the lease CHECK allows', async () => {
    const t = getTool('submit_renewal_intent')!
    const ACTOR = { userId: 'u', role: 'tenant', profileId: '00000000-0000-0000-0000-000000000000' } as any
    for (const bad of ['maybe', 'renew', 'YES please', '']) {
      const r: any = await t.execute({ intent: bad }, ACTOR)
      expect(r.ok, bad).toBe(false)
      expect(r.error, bad).toMatch(/yes.*no.*unsure/i)
    }
  })

  it('says out loud that "no" is written notice — the tenant must not learn that afterwards', () => {
    const d = getTool('submit_renewal_intent')!.description
    expect(d).toMatch(/WRITTEN NOTICE THAT THEY ARE LEAVING/i)
    expect(d).toMatch(/nothing renews automatically/i)
    expect(d).toMatch(/explicit yes/i)
  })

  it('is NOT anonymous, unlike the property survey', () => {
    expect(getTool('submit_renewal_intent')!.description).toMatch(/NOT anonymous/i)
    // And the anonymous one still says the opposite, so they cannot be confused.
    expect(getTool('create_and_send_survey')!.description).toMatch(/ANONYMOUS/i)
  })

  it('does not claim success when there is no active lease', async () => {
    const r: any = await getTool('submit_renewal_intent')!.execute(
      { intent: 'no' },
      { userId: 'u', role: 'tenant', profileId: '00000000-0000-0000-0000-000000000000' } as any)
    expect(r.ok).toBe(false)
    expect(r.recorded).toBeUndefined()
    expect(r.error).toMatch(/do NOT tell them it was recorded/i)
  })

  it('sends questions ABOUT renewing to the read tools instead', () => {
    expect(getTool('submit_renewal_intent')!.description)
      .toMatch(/get_my_landlord_renewal_tendency/)
  })
})
