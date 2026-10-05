import { describe, it, expect } from 'vitest'
import {
  earnsRent, rentRollVariance, rentPayers, expectedRent, splitBeside, loadErrorText, localToday, PAID_AHEAD_COUNTED_NOTE,
  companyChoiceState, companyName,
} from './booksMoney'

describe('rent roll: only spaces that owe rent carry a variance', () => {
  const units = [
    { status: 'active', rentAmount: 500, collectedMtd: 450 },
    { status: 'delinquent', rentAmount: 400, collectedMtd: 0 },
    { status: 'owner_use', rentAmount: 600, collectedMtd: 0 },
    { status: 'utility_service', rentAmount: 0, collectedMtd: 35 },
    { status: 'vacant', rentAmount: 300, collectedMtd: 0 },
  ]

  it('an owner-use space and a utility service point owe no rent and show no variance', () => {
    expect(earnsRent(units[2])).toBe(false)
    expect(earnsRent(units[3])).toBe(false)
    expect(rentRollVariance(units[2])).toBeNull()
    expect(rentRollVariance(units[3])).toBeNull()
  })

  it('a vacant space owes nothing either', () => {
    expect(rentRollVariance(units[4])).toBeNull()
  })

  it('a renting space shows what came in less its rent, to the cent', () => {
    expect(rentRollVariance(units[0])).toBe(-50)
    expect(rentRollVariance(units[1])).toBe(-400)
    expect(rentRollVariance({ status: 'active', rentAmount: '460.10', collectedMtd: '460.15' })).toBe(0.05)
  })

  it('expected rent and the payer count leave the same spaces out, so the rows add up to the total', () => {
    expect(rentPayers(units).length).toBe(2)
    expect(expectedRent(units)).toBe(900)
    const rowVariances = units.map(rentRollVariance).filter((v): v is number => v != null)
    const collectedByPayers = rentPayers(units).reduce((s, u) => s + Number(u.collectedMtd), 0)
    expect(rowVariances.reduce((s, v) => s + v, 0)).toBe(collectedByPayers - expectedRent(units))
  })
})

describe('GAM P&L figures: what became of the bills vs beside the total', () => {
  const beside = [
    { key: 'collectedSoFar', label: 'Collected so far', amount: 900 },
    { key: 'clearing', label: 'Still clearing', amount: 50 },
    { key: 'stillOwed', label: 'Still owed', amount: 50 },
    { key: 'workTrade', label: 'Covered by work trade', amount: 300 },
    { key: 'depositsHeld', label: 'Deposits received (held)', amount: 500 },
  ]

  it('Money billed: collected so far, clearing and still owed are the bills\' outcome, in that order — never beside', () => {
    const { outcome, aside } = splitBeside(beside, 'billed')
    expect(outcome.map(o => o.key)).toEqual(['collectedSoFar', 'clearing', 'stillOwed'])
    expect(aside.map(a => a.key)).toEqual(['workTrade', 'depositsHeld'])
    expect(outcome.reduce((s, o) => s + o.amount, 0)).toBe(1000)
  })

  it('Money received: every figure is beside the total; there is no bills\' outcome', () => {
    const { outcome, aside, onHand } = splitBeside(beside, 'received')
    expect(outcome).toEqual([])
    expect(aside).toHaveLength(beside.length)
    expect(onHand).toBeNull()
  })

  it('nothing to split is nothing either way', () => {
    expect(splitBeside(null, 'billed')).toEqual({ outcome: [], aside: [], onHand: null })
    expect(splitBeside(undefined, 'received')).toEqual({ outcome: [], aside: [], onHand: null })
  })
})

describe('GAM P&L: paid-ahead money is never "beside the total" under Money received (§0.0, Todd)', () => {
  // Todd's September: Rent $460 + Paid ahead for later bills $460 = $920; the
  // $460 for October is still on hand at Sep 30.
  const toddBeside = [
    { key: 'clearing', label: 'Still clearing', amount: 25 },
    { key: 'paidAheadUnused', label: 'Paid ahead, not used yet', amount: 460 },
  ]

  it('Todd\'s September: the $460 paid ahead, not used yet, is not listed beside the $920 total — it is shown as counted', () => {
    const { aside, onHand } = splitBeside(toddBeside, 'received')
    expect(aside.map(a => a.key)).toEqual(['clearing'])
    expect(onHand).toEqual({ key: 'paidAheadUnused', label: 'Paid ahead, not used yet', amount: 460 })
    expect(PAID_AHEAD_COUNTED_NOTE).toBe('counted on the day it arrived; $0 again when it pays a bill')
  })

  it('Money billed: paid-ahead money on hand stays beside the total (no bill it pays is in it yet)', () => {
    const { aside, onHand } = splitBeside(toddBeside, 'billed')
    expect(aside.map(a => a.key)).toEqual(['paidAheadUnused'])
    expect(onHand).toBeNull()
  })

  it('a zero paid-ahead figure shows no counted line', () => {
    expect(splitBeside([{ key: 'paidAheadUnused', label: 'Paid ahead, not used yet', amount: 0 }], 'received').onHand).toBeNull()
  })
})

describe('Books dates default to the viewer\'s calendar day, never the UTC date', () => {
  it('at 8 pm on Oct 3 in Arizona, today is Oct 3 (UTC already says Oct 4)', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/Phoenix'
    try {
      const now = new Date('2026-10-04T03:00:00Z')
      expect(now.toISOString().slice(0, 10)).toBe('2026-10-04')
      expect(localToday(now)).toBe('2026-10-03')
    } finally { process.env.TZ = tz }
  })

  it('on Dec 31 at 8 pm in Arizona, a report "through today" ends that year', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/Phoenix'
    try {
      expect(localToday(new Date('2027-01-01T03:00:00Z'))).toBe('2026-12-31')
    } finally { process.env.TZ = tz }
  })
})

describe('a screen that cannot load says why, once, with the right next step', () => {
  const axiosError = (status: number, error?: string) => ({ response: { status, data: error ? { error } : {} } })

  it('a refusal or a request to choose is shown alone — "try again" never helps there', () => {
    expect(loadErrorText(axiosError(403, 'The owner statement covers the whole company. Ask the owner for it.'), 'Could not load.'))
      .toBe('The owner statement covers the whole company. Ask the owner for it.')
    expect(loadErrorText(axiosError(400, "You own more than one company. Choose which company's books to open."), 'Could not load.'))
      .not.toMatch(/Try again/)
  })

  it('a server failure or a dropped connection says to try again', () => {
    expect(loadErrorText(axiosError(500, 'Internal error'), 'Could not load the rent roll.')).toBe('Could not load the rent roll. Try again in a moment.')
    expect(loadErrorText(axiosError(503, 'Books is restarting.'), 'Could not load the rent roll.')).toBe('Books is restarting. Try again in a moment.')
    expect(loadErrorText(new Error('Network Error'), 'Could not load the rent roll.')).toBe('Could not load the rent roll. Try again in a moment.')
  })

  it('a server crash never shows its insides (a database message)', () => {
    expect(loadErrorText(axiosError(500, 'column r.buyer_accepted_at does not exist'), 'Could not load the P&L.'))
      .toBe('Could not load the P&L. Try again in a moment.')
  })

  it('too many requests (the rate limit answers 429 in plain text) says to try again in the screen\'s own words', () => {
    const limited = { message: 'Request failed with status code 429', response: { status: 429, data: 'Too many requests, please try again later.' } }
    expect(loadErrorText(limited, 'Could not load the rent roll.')).toBe('Could not load the rent roll. Try again in a moment.')
  })

  it('a 4xx with no message falls back to the screen\'s own words', () => {
    expect(loadErrorText(axiosError(404), 'Could not load the rent roll.')).toBe('Could not load the rent roll.')
  })
})

describe('which company\'s books a landlord account opens', () => {
  const two = [{ landlordId: 'a', businessName: 'Alpha LLC' }, { landlordId: 'b', businessName: null, propertyNames: 'Mountain View RV' }]

  it('several companies and none chosen: asked, never defaulted', () => {
    expect(companyChoiceState(two, null)).toEqual({ mustChoose: true, staleChoice: false, showSwitcher: true })
  })

  it('a chosen company of the account opens, and the switcher stays', () => {
    expect(companyChoiceState(two, 'b')).toEqual({ mustChoose: false, staleChoice: false, showSwitcher: true })
  })

  it('a remembered company that is not the account\'s is forgotten and asked again', () => {
    expect(companyChoiceState(two, 'someone-elses')).toEqual({ mustChoose: true, staleChoice: true, showSwitcher: true })
  })

  it('one company needs no choice and no switcher', () => {
    expect(companyChoiceState([two[0]], null)).toEqual({ mustChoose: false, staleChoice: false, showSwitcher: false })
    expect(companyChoiceState([two[0]], 'gone').staleChoice).toBe(true)
  })

  it('a company is named by its business name, else its parks, never an id', () => {
    expect(companyName(two[0], 0)).toBe('Alpha LLC')
    expect(companyName(two[1], 1)).toBe('Mountain View RV')
    expect(companyName({ landlordId: 'c' }, 2)).toBe('Company 3')
  })
})
