/**
 * Tool: log_expense (landlord ACTION, confirm-first). S626.
 *
 * Nic: "the agent is to act as a personal assistant for the user. Anything that
 * I could get on and do as a landlord, I should be able to communicate to the
 * agent and have the agent do it for me... If I don't know where a certain
 * feature is maybe hidden inside different submenus, the agent can access that
 * information for me."
 *
 * Recording a cost is the clearest case of that. It lives at Financials →
 * Expenses behind a control called "Log an expense", and a landlord who has just
 * paid a plumber in cash should be able to say so in chat rather than go and
 * find the screen. It is also the other half of the P&L problem: GAM sees every
 * dollar in and almost none of the dollars out, so a landlord's profit reads
 * high until these are entered, and the easier they are to enter the truer the
 * number gets.
 *
 * Goes through createLandlordExpense — the SAME service the route calls, so the
 * ownership checks on the unit and the property are the route's own. A tool that
 * writes its own INSERT around a service is a tool that will drift from it.
 */
import { EXPENSE_CATEGORIES } from '@gam/shared'
import { query } from '../../../db'
import { createLandlordExpense } from '../../landlordExpenses'
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'
import { resolveActorCompany, COMPANY_PARAM } from './companyScope'

/** "the Oak Street roof" — a landlord names places, never ids. */
// S634: matches a spoken place across every company the ACCOUNT owns, and
// carries back the owning company so the expense is filed against it.
async function resolvePlace(landlordIds: string[], place: string) {
  const needle = place.trim()
  if (!needle) return { propertyId: null, unitId: null, matched: null as string | null }
  const units = await query<any>(
    `SELECT u.id, u.unit_number, u.property_id, u.landlord_id, p.name AS property_name
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = ANY($1::uuid[]) AND u.retired_at IS NULL
        AND (u.unit_number ILIKE '%' || $2 || '%' OR p.name ILIKE '%' || $2 || '%')
      ORDER BY (u.unit_number ILIKE $2) DESC
      LIMIT 6`, [landlordIds, needle])
  const exactUnit = units.find((u: any) => String(u.unit_number ?? '').toLowerCase() === needle.toLowerCase())
  if (exactUnit) {
    return { propertyId: exactUnit.property_id, unitId: exactUnit.id, landlordId: exactUnit.landlord_id, matched: `${exactUnit.property_name} ${exactUnit.unit_number}` }
  }
  const props = await query<any>(
    `SELECT id, name, landlord_id FROM properties WHERE landlord_id = ANY($1::uuid[]) AND name ILIKE '%' || $2 || '%' LIMIT 6`,
    [landlordIds, needle])
  if (props.length === 1) return { propertyId: props[0].id, unitId: null, landlordId: props[0].landlord_id, matched: props[0].name }
  if (props.length > 1) return { propertyId: null, unitId: null, matched: null, ambiguous: props.map((p: any) => p.name) } as any
  if (units.length === 1) return { propertyId: units[0].property_id, unitId: units[0].id, landlordId: units[0].landlord_id, matched: `${units[0].property_name} ${units[0].unit_number}` }
  return { propertyId: null, unitId: null, matched: null, notFound: true } as any
}

export const logExpense: AgentTool = {
  name: 'log_expense',
  description:
    'Record a cost the landlord paid — a repair, a bill, insurance, supplies — so it lands on their ' +
    'profit-and-loss. This is the same thing as Financials → Expenses → "Log an expense" in the portal. ' +
    'Use when they TELL you about a cost: "paid the plumber $340 for Apt 101", "insurance was $1,200 ' +
    'this month".\\n' +
    'CONFIRM FIRST. Read back the amount, the category, what it was for and which property or unit it ' +
    'belongs to, and get an explicit yes before calling. This writes to their books.\\n' +
    '`place` takes a property or unit in their own words ("Oak Street", "Apt 101") — never ask for an ' +
    'id. Leave it out only for a cost that belongs to the whole portfolio. If the date is not given, ' +
    'today is correct; do not invent a different one.\\n' +
    `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}. Pick the closest and say which you used; ` +
    'use "other" only when nothing fits. There is no receipt upload from chat — if they have one, tell ' +
    'them to attach it on the Expenses page.',
  parameters: {
    type: 'object',
    properties: {
      ...COMPANY_PARAM,
      amount: { type: 'number', description: 'What they paid, in dollars.' },
      category: { type: 'string', description: `One of: ${EXPENSE_CATEGORIES.join(', ')}` },
      description: { type: 'string', description: 'What it was for, in their words. e.g. "replaced the water heater"' },
      vendor: { type: 'string', description: 'Who was paid, if they said.' },
      place: { type: 'string', description: 'Property or unit in their words — "Oak Street", "Apt 101". Omit for a portfolio-wide cost.' },
      expenseDate: { type: 'string', description: 'YYYY-MM-DD. Today if they did not say.' },
    },
    required: ['amount', 'category', 'expenseDate'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const amount = Number(args.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: 'How much was it? An expense needs an amount above zero.' }
    }
    const category = String(args.category ?? '').trim().toLowerCase()
    if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) {
      return {
        ok: false,
        error: `"${args.category}" is not one of the expense categories.`,
        allowedCategories: EXPENSE_CATEGORIES,
        tellThem: 'Pick the closest one and tell them which you used.',
      }
    }
    const expenseDate = String(args.expenseDate ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) {
      return { ok: false, error: 'expenseDate must be YYYY-MM-DD. Use today unless they gave a date.' }
    }

    let propertyId: string | null = null
    let unitId: string | null = null
    let matched: string | null = null
    // S634: the expense is filed against the company that owns the place it was
    // spent on. Portfolio-level (no place named) falls back to the account's
    // only company, and asks when it owns several — an expense in the wrong
    // company's books is a wrong P&L and a wrong tax return.
    let expenseLandlordId: string | null = null
    if (args.place != null && String(args.place).trim()) {
      const r: any = await resolvePlace(actorLandlordIds(actor), String(args.place))
      if (r.ambiguous) {
        return {
          ok: false, needsNarrowing: true, error: `"${args.place}" matches more than one property.`,
          options: r.ambiguous, tellThem: 'Ask which one they meant, then call again.',
        }
      }
      if (r.notFound) {
        return {
          ok: false, error: `Nothing in their portfolio matches "${args.place}".`,
          tellThem: 'Ask which property or unit it belongs to — do not guess, and do not file it against the portfolio instead without saying so.',
        }
      }
      propertyId = r.propertyId; unitId = r.unitId; matched = r.matched
      expenseLandlordId = r.landlordId ?? null
    }
    if (!expenseLandlordId) {
      const company = await resolveActorCompany(actor, (args as any).company)
      if (!company.ok) return { ok: false, error: company.error }
      expenseLandlordId = company.landlordId
    }

    // The service does the ownership checks — a unit or property that is not
    // theirs is rejected there, which is exactly where the portal rejects it.
    const row: any = await createLandlordExpense({
      landlordId: expenseLandlordId,
      createdBy: (actor as any).userId,
      propertyId, unitId, category, amount,
      description: args.description != null ? String(args.description).slice(0, 500) : null,
      vendor: args.vendor != null ? String(args.vendor).slice(0, 160) : null,
      expenseDate,
      isCommon: !unitId && !!propertyId,
      utilityType: null,
    } as any)

    return {
      ok: true,
      logged: true,
      expenseId: row?.id,
      amount, category, expenseDate,
      appliedTo: matched ?? 'the whole portfolio',
      note:
        'Recorded. Tell them it is on their books and will show on the profit-and-loss under ' +
        `"${category}". If they have a receipt, it attaches on the Expenses page — not from here.`,
    }
  },
}
