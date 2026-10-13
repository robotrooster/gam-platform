// 10/13 (Nic) — the Payments page's small decisions (components/payments/openMonth).
import { describe, it, expect } from 'vitest'
import type { OpenMonthRow, RentRollProperty } from '@gam/shared'
import { propertyToShow, openProperties, householdName, reportPath, rowTakesPayment, paidWords, earlierWords, owesHere, payerChoices } from './openMonth'

const property = (over: Partial<RentRollProperty> = {}): RentRollProperty => ({
  propertyId: 'p-oak', name: 'Oak Park', spaces: 29, owned: true, ...over,
})
const row = (over: Partial<OpenMonthRow> = {}): OpenMonthRow => ({
  key: 'lease:L4', unitId: 'u4', space: 'MH 04', leaseId: 'L4', householdId: 't-glenda',
  residents: [{ tenantId: 't-glenda', name: 'Glenda Moss', primary: true }], occupant: null, movedOut: false,
  invoiced: 460, lateFees: 0, paid: 200, clearing: 0, credit: 0, workTrade: 0, owed: 260, owedEarlier: 0,
  methods: ['Cash'], status: 'partial', statusLabel: 'Partial', statusColor: 'yellow', daysPastGrace: 0,
  dueDate: '2026-10-01', workTradeOnly: false, evictionMode: false, delinquent: false, recordWith: 'chg1',
  payments: [], charges: [], ...over,
})

describe('which property the page shows', () => {
  it('the one picked; else the only one with an open month; else it asks', () => {
    const sold = property({ propertyId: 'p-sold', name: 'Sold Acres', owned: false })
    expect(propertyToShow('p-mv', [property()])).toBe('p-mv')
    expect(propertyToShow(null, [property(), sold])).toBe('p-oak')
    expect(propertyToShow(null, [property(), property({ propertyId: 'p-mv', name: 'Mountain View' })])).toBeNull()
    expect(propertyToShow(null, [sold])).toBeNull()
    expect(propertyToShow(null, undefined)).toBeNull()
  })
  it('offers only properties with an open month, by name', () => {
    expect(openProperties([property(), property({ propertyId: 'p-mv', name: 'Mountain View' }), property({ propertyId: 'x', name: 'A', owned: false })])
      .map(p => p.name)).toEqual(['Mountain View', 'Oak Park'])
  })
})

describe('a row', () => {
  it('names the household, primary first', () => {
    expect(householdName(row({ residents: [{ tenantId: 'a', name: 'Russ Fuller', primary: true }, { tenantId: 'b', name: 'Ann Fuller', primary: false }] })))
      .toBe('Russ Fuller & Ann Fuller')
    expect(householdName(row({ residents: [] }))).toBe('No tenant on file')
  })
  it('opens the report for its lease; an empty space has none', () => {
    expect(reportPath(row())).toBe('/tenants/t-glenda/report?leaseId=L4')
    expect(reportPath(row({ leaseId: null }))).toBe('/tenants/t-glenda/report')
    expect(reportPath(row({ householdId: null }))).toBeNull()
  })
  it('takes a payment only while it owes here, for someone who takes payments, never in eviction mode', () => {
    expect(rowTakesPayment(row(), true)).toBe(true)
    expect(rowTakesPayment(row(), false)).toBe(false)
    // 10/13 (Nic): "outstanding balances are always at the top" — an earlier month's balance is owed here too.
    expect(rowTakesPayment(row({ owed: 0, owedEarlier: 50 }), true)).toBe(true)
    expect(rowTakesPayment(row({ owed: 0, owedEarlier: 0 }), true)).toBe(false)
    expect(rowTakesPayment(row({ recordWith: null }), true)).toBe(false)
    expect(rowTakesPayment(row({ evictionMode: true }), true)).toBe(false)
    expect(rowTakesPayment(row({ status: 'occupied', householdId: null }), true)).toBe(false)
  })
  it('owes here: this month or earlier', () => {
    expect(owesHere({ owed: 0, owedEarlier: 0 })).toBe(false)
    expect(owesHere({ owed: 0.01, owedEarlier: 0 })).toBe(true)
    expect(owesHere({ owed: 0, owedEarlier: 120 })).toBe(true)
  })
  it('reads work trade as the Rent Roll does: its value beside Paid', () => {
    expect(paidWords({ paid: 0, workTrade: 460 })).toEqual({ amount: null, workTrade: '$460.00 work trade' })
    expect(paidWords({ paid: 200, workTrade: 260 })).toEqual({ amount: '$200.00', workTrade: '+ $260.00 work trade' })
    expect(paidWords({ paid: 0, workTrade: 0 })).toEqual({ amount: null, workTrade: null })
  })
  it('says what is still owed on earlier months under this month\'s Owed', () => {
    expect(earlierWords({ owed: 260, owedEarlier: 120 })).toBe('+ $120.00 from earlier months')
    expect(earlierWords({ owed: 0, owedEarlier: 120 })).toBe('$120.00 from earlier months')
    expect(earlierWords({ owed: 260, owedEarlier: 0 })).toBeNull()
  })
})

describe('Record payment at the top: who can pay, and how', () => {
  it('desk window when something the desk takes is open; posting ahead otherwise; eviction mode blocked; empty spaces left out', () => {
    const rows = [
      row(),
      row({ key: 'b', space: 'MH 05', householdId: 't-ed', residents: [{ tenantId: 't-ed', name: 'Ed Price', primary: true }], evictionMode: true, recordWith: null }),
      row({ key: 'c', space: 'MH 06', householdId: 't-gam', residents: [{ tenantId: 't-gam', name: 'Ivy Cole', primary: true }], recordWith: null, owed: 15 }),
      row({ key: 'd', space: 'MH 08', householdId: 't-ok', residents: [{ tenantId: 't-ok', name: 'Al Ross', primary: true }], recordWith: null, owed: 0 }),
      row({ key: 'vacant:u9', space: 'MH 09', householdId: null, residents: [], status: 'vacant', recordWith: null, owed: 0 }),
      row({ key: 'space:u3', space: 'MH 03', householdId: null, residents: [], status: 'occupied', statusLabel: 'Owner Use', recordWith: null, owed: 0 }),
    ]
    expect(payerChoices(rows, '').map(c => [c.name, c.kind, c.side, c.note ?? ''])).toEqual([
      ['Glenda Moss', 'record', 'owes $260.00', ''],
      ['Ed Price', 'blocked', '', 'Eviction mode — payments blocked'],
      ['Ivy Cole', 'ahead', 'Post a payment ahead', 'owes $15.00 that is not taken at the desk — it is paid online'],
      ['Al Ross', 'ahead', 'nothing owed — paying ahead', ''],
    ])
  })
  it('narrows by a name or a space typed', () => {
    const rows = [row(), row({ key: 'b', space: 'RV 12', residents: [{ tenantId: 'x', name: 'Mo Reyes', primary: true }] })]
    expect(payerChoices(rows, 'rv 1').map(c => c.name)).toEqual(['Mo Reyes'])
    expect(payerChoices(rows, 'GLENDA').map(c => c.name)).toEqual(['Glenda Moss'])
  })
})
