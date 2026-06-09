/**
 * State landlord/tenant law compliance-warning engine (S442).
 * DB mocked — pure lookup + comparison, no legal logic in code.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../db', () => ({ query: vi.fn() }))

import { query } from '../db'
import { getApplicableActs, checkAgainstStatute, buildDisclaimer } from './stateLaw'

const mockQuery = query as unknown as ReturnType<typeof vi.fn>

beforeEach(() => { vi.clearAllMocks() })

describe('getApplicableActs', () => {
  it('uppercases the state and matches the unit type against unit_types', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 'a1', act_name: 'AZ Residential Act' }])
    const acts = await getApplicableActs('az', 'rv_spot')
    expect(mockQuery.mock.calls[0][1]).toEqual(['AZ', 'rv_spot'])
    expect(acts).toHaveLength(1)
  })

  it('returns empty for a bad state or missing unit type without hitting the DB', async () => {
    expect(await getApplicableActs('Arizona', 'rv_spot')).toEqual([])
    expect(await getApplicableActs('AZ', '')).toEqual([])
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('checkAgainstStatute (objective factual mismatch, not legal advice)', () => {
  it('flags a value ABOVE a max figure, stated factually + hedged + cited', async () => {
    mockQuery.mockResolvedValueOnce([{
      topic: 'late_fee', rule_kind: 'max', threshold_numeric: '5', threshold_unit: 'dollars per day',
      summary: 'cap $5/day', statute_citation: 'A.R.S. § 33-2105', source_url: 'u', source_date: '2026-06-09',
    }])
    const f = await checkAgainstStatute('AZ', 'late_fee', 100)
    expect(f).not.toBeNull()
    expect(f!.message).toMatch(/above the 5 dollars per day/i)
    expect(f!.message).toMatch(/factual comparison, not legal advice/i)
    expect(f!.citation).toBe('A.R.S. § 33-2105')
  })

  it('flags a value BELOW a min figure', async () => {
    mockQuery.mockResolvedValueOnce([{
      topic: 'entry_notice_hours', rule_kind: 'min', threshold_numeric: '48', threshold_unit: 'hours',
      summary: '', statute_citation: 'A.R.S. § 33-1343', source_url: 'u', source_date: '2026-06-09',
    }])
    const f = await checkAgainstStatute('AZ', 'entry_notice_hours', 12)
    expect(f!.message).toMatch(/below the 48 hours/i)
  })

  it('returns null when the value is within the figure', async () => {
    mockQuery.mockResolvedValueOnce([{
      topic: 'deposit_max_months', rule_kind: 'max', threshold_numeric: '2', threshold_unit: 'months of rent',
      summary: '', statute_citation: 'x', source_url: null, source_date: '2026-06-09',
    }])
    expect(await checkAgainstStatute('AZ', 'deposit_max_months', 1)).toBeNull()
  })

  it('returns null for a non-directional (info) rule and for an uncatalogued topic — no false flags', async () => {
    mockQuery.mockResolvedValueOnce([{ topic: 'late_fee', rule_kind: 'info', threshold_numeric: '5', threshold_unit: 'x', summary: '', statute_citation: null, source_url: null, source_date: '2026-06-09' }])
    expect(await checkAgainstStatute('AZ', 'late_fee', 100)).toBeNull()
    mockQuery.mockResolvedValueOnce([]) // uncatalogued
    expect(await checkAgainstStatute('NV', 'late_fee', 100)).toBeNull()
  })
})

describe('buildDisclaimer (no-guidance posture)', () => {
  it('tells the user to compare it themselves, seek newer law, consult an attorney — dated, no guidance', () => {
    const d = buildDisclaimer('2026-06-09')
    expect(d).toMatch(/as of 2026-06-09/i)
    expect(d).toMatch(/not legal advice/i)
    expect(d).toMatch(/no opinion on whether you comply/i)
    expect(d).toMatch(/compare it to what you/i)
    expect(d).toMatch(/newer version/i)
    expect(d).toMatch(/attorney/i)
  })
})
