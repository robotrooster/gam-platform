/**
 * State landlord/tenant law catalog lookup + comparison engine (S442).
 * DB mocked — pure lookup + comparison, no legal logic in code.
 *
 * 10/20 (Nic): the WARNINGS are hidden behind one platform flag
 * (STATE_LAW_WARNINGS_FEATURE). Default here is hidden, exactly as in
 * production — the suites below that exercise the comparison turn the switch
 * on first, and the switch's own suite proves it both ways.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../db', () => ({ query: vi.fn(), queryOne: vi.fn() }))

import { query, queryOne } from '../db'
import {
  getApplicableActs, checkAgainstStatute, checkLeaseAgainstStateLaw,
  buildDisclaimer, detectStubbedCategory, stateLawWarningsEnabled,
  STATE_LAW_WARNINGS_FEATURE,
} from './stateLaw'

const mockQuery = query as unknown as ReturnType<typeof vi.fn>
const mockQueryOne = queryOne as unknown as ReturnType<typeof vi.fn>

/** The system_features row that turns the warnings back on. */
const switchOn = () => mockQueryOne.mockResolvedValue({ enabled: true })
/** No row at all — how production reads today. */
const switchMissing = () => mockQueryOne.mockResolvedValue(undefined)

beforeEach(() => { vi.clearAllMocks(); switchMissing() })

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

describe('detectStubbedCategory (broad real-estate areas not yet ingested)', () => {
  it('flags clearly zoning / sale-disclosure questions', () => {
    expect(detectStubbedCategory('what is the setback for a zoning variance')).toBe('land_use_zoning')
    expect(detectStubbedCategory('property condition disclosure when selling')).toBe('environmental_disclosure')
  })
  it('does NOT stub property tax (it is being ingested for a near-term feature)', () => {
    expect(detectStubbedCategory('how do I grieve my property tax assessment')).toBeNull()
    expect(detectStubbedCategory('property tax exemption for seniors')).toBeNull()
  })
  it('does NOT hijack genuine landlord/tenant questions', () => {
    expect(detectStubbedCategory('warranty of habitability')).toBeNull()
    expect(detectStubbedCategory('can my landlord keep my security deposit')).toBeNull()
    expect(detectStubbedCategory('evicting a tenant for non-payment of rent')).toBeNull()
    // lead paint as a habitability issue (no "disclosure") stays L/T
    expect(detectStubbedCategory('there is lead paint in my apartment')).toBeNull()
  })
})

describe('checkAgainstStatute (objective factual mismatch, not legal advice)', () => {
  // The comparison itself, with the warning switch deliberately turned on.
  beforeEach(() => { switchOn() })

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

  it('returns null for a non-directional (info) rule and for an uncataloged topic — no false flags', async () => {
    mockQuery.mockResolvedValueOnce([{ topic: 'late_fee', rule_kind: 'info', threshold_numeric: '5', threshold_unit: 'x', summary: '', statute_citation: null, source_url: null, source_date: '2026-06-09' }])
    expect(await checkAgainstStatute('AZ', 'late_fee', 100)).toBeNull()
    mockQuery.mockResolvedValueOnce([]) // uncataloged
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

describe('the state-law warning switch (10/20 — hidden, not deleted)', () => {
  it('is OFF when no system_features row exists — how production reads today', async () => {
    switchMissing()
    expect(await stateLawWarningsEnabled()).toBe(false)
    expect(mockQueryOne.mock.calls[0][1]).toEqual([STATE_LAW_WARNINGS_FEATURE])
  })

  it('hidden: checkAgainstStatute gives no flag and never opens the catalog', async () => {
    switchMissing()
    expect(await checkAgainstStatute('AZ', 'late_fee', 100)).toBeNull()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('hidden: the lease composer returns no warnings and never opens the catalog', async () => {
    switchMissing()
    const flags = await checkLeaseAgainstStateLaw({
      stateCode: 'AZ', rentAmount: 1000, securityDepositAmount: 3000,
      lateFeeInitialAmount: 25, lateFeeInitialType: 'percent_of_rent', lateFeeGraceDays: 0,
    })
    expect(flags).toEqual([])
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('flipped ON: the same deposit flags again, so nothing was demolished', async () => {
    switchOn()
    mockQuery.mockResolvedValue([{
      topic: 'deposit_max_months', rule_kind: 'max', threshold_numeric: '1.5',
      threshold_unit: 'months of rent', summary: 'cap 1.5 months',
      statute_citation: 'A.R.S. § 33-1321', source_url: 'u', source_date: '2026-06-09',
    }])
    const flags = await checkLeaseAgainstStateLaw({
      stateCode: 'AZ', rentAmount: 1000, securityDepositAmount: 3000,
    })
    expect(flags).toHaveLength(1)
    expect(flags[0].topic).toBe('deposit_max_months')
    expect(flags[0].message).toMatch(/above the 1\.5 months of rent/i)
    expect(flags[0].disclaimer).toMatch(/not legal advice/i)
  })

  it('a row that is explicitly disabled stays hidden', async () => {
    mockQueryOne.mockResolvedValue({ enabled: false })
    expect(await stateLawWarningsEnabled()).toBe(false)
    expect(await checkAgainstStatute('AZ', 'late_fee', 100)).toBeNull()
  })

  it('a DB failure reading the switch reads as hidden, never as a warning', async () => {
    mockQueryOne.mockRejectedValue(new Error('db down'))
    expect(await stateLawWarningsEnabled()).toBe(false)
    expect(await checkAgainstStatute('AZ', 'late_fee', 100)).toBeNull()
    expect(await checkLeaseAgainstStateLaw({
      stateCode: 'AZ', rentAmount: 1000, securityDepositAmount: 9000,
    })).toEqual([])
  })

  it('a lease with no state still costs no query at all', async () => {
    switchMissing()
    expect(await checkLeaseAgainstStateLaw({ stateCode: null, rentAmount: 1000 })).toEqual([])
    expect(mockQueryOne).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
