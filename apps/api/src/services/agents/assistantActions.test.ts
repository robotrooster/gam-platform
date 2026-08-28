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
