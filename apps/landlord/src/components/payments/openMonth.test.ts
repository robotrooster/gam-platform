// 10/13 (Nic) — the Payments page's small decisions (components/payments/openMonth).
import { describe, it, expect } from 'vitest'
import type { OpenMonthRow, RentRollProperty } from '@gam/shared'
import {
  propertyToShow, openProperties, householdName, reportPath, rowTakesPayment, paidWords, earlierWords, owesHere, payerChoices,
  rowName, rowOpens, stayRefundWords, otherMoneyMeta, otherMoneyWho,
} from './openMonth'

const property = (over: Partial<RentRollProperty> = {}): RentRollProperty => ({
  propertyId: 'p-oak', name: 'Oak Park', spaces: 29, owned: true, ...over,
})
const row = (over: Partial<OpenMonthRow> = {}): OpenMonthRow => ({
  key: 'lease:L4', unitId: 'u4', space: 'MH 04', leaseId: 'L4', householdId: 't-glenda',
  residents: [{ tenantId: 't-glenda', name: 'Glenda Moss', primary: true }], occupant: null, movedOut: false,
  invoiced: 460, lateFees: 0, paid: 200, clearing: 0, credit: 0, workTrade: 0, owed: 260, owedEarlier: 0,
  methods: ['Cash'], status: 'partial', statusLabel: 'Partial', statusColor: 'yellow', daysPastGrace: 0,
  dueDate: '2026-10-01', workTradeOnly: false, evictionMode: false, delinquent: false, recordWith: 'chg1',
  payments: [], charges: [], stay: null, ...over,
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

// 10/13 (Nic): "the payments page ... should show all money coming in" — a stay guest's row.
describe('a stay guest\'s row', () => {
  const stay = (over: Partial<OpenMonthRow> = {}) => row({
    key: 'stay:b1', leaseId: null, householdId: null, residents: [], occupant: 'Rhea Register', status: 'stay',
    statusLabel: 'Checked in', statusColor: 'gray', invoiced: 0, owed: 0, paid: 589, recordWith: null,
    stay: { bookingId: 'b1', checkIn: '2026-10-04', checkOut: '2026-11-04', nights: 31, statusLabel: 'Checked in', refunded: 0, refunds: [] },
    ...over,
  })
  it('is named for its guest, opens, and takes no payment', () => {
    expect(rowName(stay())).toBe('Rhea Register')
    expect(rowName(stay({ occupant: null }))).toBe('Stay guest')
    expect(rowOpens(stay())).toBe(true)
    expect(rowTakesPayment(stay(), true)).toBe(false)
    expect(reportPath(stay())).toBeNull()
    expect(payerChoices([stay()], '')).toEqual([])
  })
  it('says what went back to the guest this month, only when something did', () => {
    expect(stayRefundWords(stay())).toBeNull()
    expect(stayRefundWords(stay({ stay: { ...stay().stay!, refunded: 100 } }))).toBe('$100.00 refunded')
    expect(stayRefundWords(row())).toBeNull()
  })
  it('a household is its residents; a space alone names its occupant or nobody, and does not open', () => {
    expect(rowName(row())).toBe('Glenda Moss')
    expect(rowName(row({ status: 'vacant', residents: [], occupant: null }))).toBeNull()
    expect(rowName(row({ status: 'occupied', residents: [], occupant: 'Owner' }))).toBe('Owner')
    expect(rowOpens(row({ status: 'vacant' }))).toBe(false)
    expect(rowOpens(row({ status: 'occupied' }))).toBe(false)
    expect(rowOpens(row())).toBe(true)
  })
})

// 10/13 (Nic): "the payments page ... should show all money coming in."
describe('the register\'s and pay links\' money (its folder\'s head)', () => {
  it('how many sales and refunds; the sums only when the server sent them', () => {
    const sale = { kind: 'sale' as const }
    const refund = { kind: 'refund' as const }
    expect(otherMoneyMeta([sale])).toBe('1 sale')
    expect(otherMoneyMeta([sale, sale, refund])).toBe('2 sales · 1 refund')
    expect(otherMoneyMeta([sale, sale], { otherIn: 776.09, otherRefunded: 0 })).toBe('2 sales · $776.09')
    expect(otherMoneyMeta([sale, refund, refund], { otherIn: 23.92, otherRefunded: 7 })).toBe('1 sale · 2 refunds · $23.92 · $7.00 refunded')
  })
  it('who paid: the name, else that nobody was named', () => {
    expect(otherMoneyWho({ who: 'Andres Razo' })).toBe('Andres Razo')
    expect(otherMoneyWho({ who: null })).toBe('No name given')
    expect(otherMoneyWho({ who: '  ' })).toBe('No name given')
  })
})
