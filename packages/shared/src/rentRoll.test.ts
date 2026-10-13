/**
 * 10/13 (Nic) — the Payments page and the Rent Roll: one colored status pill
 * ("I don't think we need to have the on time column at all … underneath paid,
 * it can show … paid late … +5 showing days past grace") and space-number
 * order ("in order of space number").
 */
import { describe, it, expect } from 'vitest'
import {
  rentRollStatusOf, rentRollStatusText, compareSpaces, isSpaceOnlyRow, RENT_ROLL_ROW_STATUSES, RENT_ROLL_STATUS_LABEL, RENT_ROLL_STATUS_COLOR,
} from './rentRoll'

describe('the status pill', () => {
  it('maps the payment-health stamp: a partial past grace with money still owed is red Owes +N', () => {
    expect(rentRollStatusOf('paid_on_time', 0)).toBe('paid')
    expect(rentRollStatusOf('paid_late', 5)).toBe('paid_late')
    expect(rentRollStatusOf('partial', 0)).toBe('partial')
    expect(rentRollStatusOf('partial', 3)).toBe('owes')
    expect(rentRollStatusOf('outstanding', 7)).toBe('owes')
    expect(rentRollStatusOf('due', 0)).toBe('due')
    expect(rentRollStatusOf(null, 0)).toBe('none')
  })
  it('says it in words with the days past grace', () => {
    expect(rentRollStatusText({ status: 'paid', daysPastGrace: 0 })).toBe('Paid')
    expect(rentRollStatusText({ status: 'paid_late', daysPastGrace: 5 })).toBe('Paid late +5')
    expect(rentRollStatusText({ status: 'owes', daysPastGrace: 3 })).toBe('Owes +3')
    expect(rentRollStatusText({ status: 'partial', daysPastGrace: 0 })).toBe('Partial')
    expect(rentRollStatusText({ status: 'due', daysPastGrace: 0, dueDate: '2026-10-01' })).toBe('Due Oct 1')
    expect(rentRollStatusText({ status: 'due', daysPastGrace: 0 })).toBe('Due')
    expect(rentRollStatusText({ status: 'vacant', daysPastGrace: 0 })).toBe('Vacant')
  })
  it('green paid, orange late, yellow partial, red owes, gray the rest — every status has words and a color', () => {
    expect([RENT_ROLL_STATUS_COLOR.paid, RENT_ROLL_STATUS_COLOR.paid_late, RENT_ROLL_STATUS_COLOR.partial, RENT_ROLL_STATUS_COLOR.owes])
      .toEqual(['green', 'orange', 'yellow', 'red'])
    for (const s of RENT_ROLL_ROW_STATUSES) {
      expect(RENT_ROLL_STATUS_LABEL[s]).toBeTruthy()
      expect(RENT_ROLL_STATUS_COLOR[s]).toBeTruthy()
    }
  })
})

// 10/13 review: Vacant is an EMPTY space; a space in use with nobody on a lease is never called Vacant.
describe('a row that is a space, not a household', () => {
  it('Vacant when empty, occupied when in use — both gray, both just the space', () => {
    expect(RENT_ROLL_STATUS_LABEL.occupied).not.toBe(RENT_ROLL_STATUS_LABEL.vacant)
    expect([RENT_ROLL_STATUS_COLOR.vacant, RENT_ROLL_STATUS_COLOR.occupied]).toEqual(['gray', 'gray'])
    expect(isSpaceOnlyRow({ status: 'vacant' })).toBe(true)
    expect(isSpaceOnlyRow({ status: 'occupied' })).toBe(true)
    for (const s of ['paid', 'paid_late', 'partial', 'owes', 'due', 'none'] as const) expect(isSpaceOnlyRow({ status: s })).toBe(false)
  })
})

describe('space-number order', () => {
  it('RV 2 before RV 10, MH 03 before MH 12; no space last', () => {
    const spaces = ['RV 10', null, 'RV 2', 'MH 12', 'RV 1', 'MH 03', 'rv 3']
    expect([...spaces].sort(compareSpaces)).toEqual(['MH 03', 'MH 12', 'RV 1', 'RV 2', 'rv 3', 'RV 10', null])
  })
})
