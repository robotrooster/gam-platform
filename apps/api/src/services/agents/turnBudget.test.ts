/**
 * turnBudget (S553) — cap decisions, Nic's landlord formula with its
 * tenant-budget floor, and the dark-by-default auto-hide. DB mocked; the
 * unproductive-turn SQL predicate itself is exercised live by the
 * analytics endpoint (same string via unproductiveTurnSql).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('../../db', () => ({ query: vi.fn(), queryOne: vi.fn() }))

import { query, queryOne } from '../../db'
import { checkTurnBudget, isAssistantHidden, getBudgetConfig, unproductiveTurnSql } from './turnBudget'

const mockQuery = query as unknown as ReturnType<typeof vi.fn>
const mockQueryOne = queryOne as unknown as ReturnType<typeof vi.fn>

describe('checkTurnBudget', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { delete process.env.AGENT_ABUSE_AUTOHIDE })

  it('non-tenant/landlord audiences are never budgeted', async () => {
    expect(await checkTurnBudget('prospect', 'u', 'p')).toEqual({ allowed: true })
    expect(await checkTurnBudget('guest', 'u', 'p')).toEqual({ allowed: true })
    expect(mockQueryOne).not.toHaveBeenCalled()
  })

  it('tenant under both caps is admitted', async () => {
    mockQueryOne.mockResolvedValueOnce({ total: 10, unproductive: 2 })
    expect(await checkTurnBudget('tenant', 'u', 't')).toEqual({ allowed: true })
  })

  it('tenant at the off-topic cap is refused (default 5)', async () => {
    mockQueryOne.mockResolvedValueOnce({ total: 10, unproductive: 5 })
    expect(await checkTurnBudget('tenant', 'u', 't')).toEqual({ allowed: false, reason: 'daily_unproductive' })
  })

  it('tenant at the daily total cap is refused (default 60)', async () => {
    mockQueryOne.mockResolvedValueOnce({ total: 60, unproductive: 0 })
    expect(await checkTurnBudget('tenant', 'u', 't')).toEqual({ allowed: false, reason: 'daily_total' })
  })

  it('landlord cap scales with occupied units — 32 units → 240/day (7.5/unit)', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ total: 239, unproductive: 0 }) // today's counts
      .mockResolvedValueOnce({ n: 32 })                       // occupied units
    expect(await checkTurnBudget('landlord', 'u', 'L')).toEqual({ allowed: true })

    mockQueryOne
      .mockResolvedValueOnce({ total: 240, unproductive: 0 })
      .mockResolvedValueOnce({ n: 32 })
    expect(await checkTurnBudget('landlord', 'u', 'L')).toEqual({ allowed: false, reason: 'daily_total' })
  })

  it('small/empty landlords get the tenant-budget floor, not the raw formula', async () => {
    // 2 units → formula 15, floor 60: 59 turns still admitted.
    mockQueryOne
      .mockResolvedValueOnce({ total: 59, unproductive: 0 })
      .mockResolvedValueOnce({ n: 2 })
    expect(await checkTurnBudget('landlord', 'u', 'L')).toEqual({ allowed: true })
    // 0 units (mid-onboarding) → still the full tenant budget.
    mockQueryOne
      .mockResolvedValueOnce({ total: 59, unproductive: 0 })
      .mockResolvedValueOnce({ n: 0 })
    expect(await checkTurnBudget('landlord', 'u', 'L')).toEqual({ allowed: true })
  })

  it('landlord off-topic cap is 10 regardless of portfolio size', async () => {
    mockQueryOne.mockResolvedValueOnce({ total: 30, unproductive: 10 })
    expect(await checkTurnBudget('landlord', 'u', 'L')).toEqual({ allowed: false, reason: 'daily_unproductive' })
  })
})

describe('isAssistantHidden', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { delete process.env.AGENT_ABUSE_AUTOHIDE })

  // S609: these were hardcoded to July 2026. The hide lasts a fixed number of
  // days AFTER the last offending day, so once the calendar moved past that
  // window the test failed on a date rather than on a change. Anchored to "now".
  const dayStr = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  const offendingWeek = [
    { day: dayStr(3), n: 5 },
    { day: dayStr(2), n: 6 },
    { day: dayStr(1), n: 9 },
  ]

  it('DARK by default — never hides, never queries', async () => {
    expect(await isAssistantHidden('u', 'tenant')).toBe(false)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('armed: hides after hitting the off-topic cap on 3 of trailing 7 days', async () => {
    process.env.AGENT_ABUSE_AUTOHIDE = '1'
    mockQuery.mockResolvedValueOnce(offendingWeek)
    expect(await isAssistantHidden('u', 'tenant')).toBe(true)
  })

  it('armed: 2 offending days is not enough', async () => {
    process.env.AGENT_ABUSE_AUTOHIDE = '1'
    mockQuery.mockResolvedValueOnce(offendingWeek.slice(0, 2))
    expect(await isAssistantHidden('u', 'tenant')).toBe(false)
  })
})

describe('unproductiveTurnSql', () => {
  it('prefixes every column when aliased and matches the unaliased shape', () => {
    const aliased = unproductiveTurnSql('l')
    for (const col of ['grounded', 'tool_invocation_count', 'escalated_to_human', 'outcome', 'user_message', 'metadata']) {
      expect(aliased).toContain(`l.${col}`)
    }
    expect(unproductiveTurnSql()).not.toContain('l.')
  })
})

describe('getBudgetConfig', () => {
  it('landlordPerUnit defaults to tenantDaily / 8 (Nic’s formula)', () => {
    const cfg = getBudgetConfig()
    expect(cfg.landlordPerUnit).toBeCloseTo(cfg.tenantDaily / 8)
  })
})
