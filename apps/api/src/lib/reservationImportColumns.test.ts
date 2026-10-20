/**
 * 10/20 — READING SOMEBODY ELSE'S SCHEDULE EXPORT.
 *
 * Nic's file is not a GAM template, so this is where the generosity lives: the
 * column names other park systems use, and the four or five shapes a date comes
 * out in. Pinned on its own because getting a date wrong by a month is a guest
 * turning up to a space that is sold.
 */
import { describe, it, expect } from 'vitest'
import {
  applyReservationMapping, buildReservationTemplateCsv, dateIsAmbiguous, guestNameFrom,
  meansPaidWithoutAnAmount, migrationKey, parseMoney, parseNights, parseStayDate,
} from './reservationImportColumns'

describe('column names', () => {
  it('reads the words other park systems use', () => {
    const [row] = applyReservationMapping([{
      'Reservation #': 'RES-1041',
      'Guest': 'Dale Carter',
      'E-mail': 'dale@example.com',
      'Cell Phone': '520-555-0110',
      'Space #': 'RV 14',
      'Arrive': '2027-03-06',
      'Depart': '2027-03-13',
      '# Nights': '7',
      'Grand Total': '286.75',
      'Deposit Paid': '28.68',
      'Park': 'Mountain View RV Park',
      'Special Requests': 'Pull-through if possible',
    }])
    expect(row).toMatchObject({
      external_ref: 'RES-1041', guest_name: 'Dale Carter', email: 'dale@example.com',
      phone: '520-555-0110', unit_number: 'RV 14', check_in: '2027-03-06',
      check_out: '2027-03-13', nights: '7', total_amount: '286.75',
      deposit_paid: '28.68', property_name: 'Mountain View RV Park',
      notes: 'Pull-through if possible',
    })
    expect(row._extra).toBeUndefined()
  })

  it('keeps a column it does not understand instead of dropping it', () => {
    const [row] = applyReservationMapping([{ Guest: 'Dale', Arrive: '3/6/27', 'Rig Length': '38 ft' }])
    expect(row._extra).toEqual({ 'Rig Length': '38 ft' })
  })

  it('drops the vendor noise nobody needs', () => {
    const [row] = applyReservationMapping([{ Guest: 'Dale', Status: 'Confirmed', 'Created On': '2026-11-02' }])
    expect(row._extra).toBeUndefined()
  })

  it('never reads "Balance Due" as the stay total — it is what is LEFT', () => {
    // The arrival ticket is raised off the total; reading the remainder as the
    // whole would understate every prepaid reservation in the file.
    const [row] = applyReservationMapping([{ Guest: 'Dale', 'Balance Due': '258.07' }])
    expect(row.total_amount).toBeUndefined()
  })

  it('takes the first recognized column when an export has two for one thing', () => {
    const [row] = applyReservationMapping([{ Site: 'RV 14', 'Assigned Site': 'RV 03' }])
    expect(row.unit_number).toBe('RV 14')
  })
})

describe('dates', () => {
  it('reads every shape an export comes out in', () => {
    for (const [raw, expected] of [
      ['2027-03-06', '2027-03-06'],
      ['2027/03/06', '2027-03-06'],
      ['2027-03-06T00:00:00Z', '2027-03-06'],
      ['03/06/2027', '2027-03-06'],
      ['3/6/2027', '2027-03-06'],
      ['3-6-27', '2027-03-06'],
      ['03.06.2027', '2027-03-06'],
      ['Mar 6, 2027', '2027-03-06'],
      ['March 6 2027', '2027-03-06'],
      ['6 Mar 2027', '2027-03-06'],
      ['6th March 2027', '2027-03-06'],
      ['46452', '2027-03-06'],          // a file re-saved by Excel
    ] as const) {
      expect(parseStayDate(raw), `${raw}`).toBe(expected)
    }
  })

  it('refuses what it cannot read rather than guessing', () => {
    for (const raw of ['', '   ', 'next Tuesday', 'Mar 6', '2027-13-01', '2027-02-30', '99999', 'RES-1041']) {
      expect(parseStayDate(raw), `${raw}`).toBeNull()
    }
  })

  it('says when it had to choose American order', () => {
    expect(dateIsAmbiguous('03/06/2027')).toBe(true)
    expect(dateIsAmbiguous('03/16/2027')).toBe(false)     // only one reading
    expect(dateIsAmbiguous('2027-03-06')).toBe(false)
    expect(dateIsAmbiguous('06/06/2027')).toBe(false)     // same either way
  })
})

describe('money and nights', () => {
  it('reads a figure however the file wrote it', () => {
    expect(parseMoney('$286.75')).toBe(286.75)
    expect(parseMoney('1,234.50')).toBe(1234.5)
    expect(parseMoney('(45.00)')).toBe(-45)
    expect(parseMoney('269')).toBe(269)
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('-')).toBeNull()
  })

  it('tells an empty cell from one it could not read', () => {
    // The difference between a warning and a blocker when the cell is a deposit.
    expect(parseMoney(null)).toBeNull()
    expect(parseMoney('about $300')).toBeUndefined()
  })

  it('knows "Paid: Y" means paid without saying how much', () => {
    for (const raw of ['Y', 'yes', 'TRUE', 'Paid', 'x']) expect(meansPaidWithoutAnAmount(raw)).toBe(true)
    for (const raw of ['28.68', '', 'no', 'N']) expect(meansPaidWithoutAnAmount(raw)).toBe(false)
  })

  it('reads a night count, and refuses a broken one', () => {
    expect(parseNights('7')).toBe(7)
    expect(parseNights('')).toBeNull()
    expect(parseNights('a week')).toBeUndefined()
    expect(parseNights('0')).toBeUndefined()
  })
})

describe('the guest\'s name', () => {
  it('turns a surname-first export round', () => {
    expect(guestNameFrom({ guest_name: 'Carter, Dale' })).toBe('Dale Carter')
    expect(guestNameFrom({ guest_name: 'Dale Carter' })).toBe('Dale Carter')
    expect(guestNameFrom({ guest_name: '  Dale   Carter ' })).toBe('Dale Carter')
  })

  it('joins split columns when that is all there is', () => {
    expect(guestNameFrom({ first_name: 'Dale', last_name: 'Carter' })).toBe('Dale Carter')
    expect(guestNameFrom({ first_name: 'Dale' })).toBe('Dale')
    expect(guestNameFrom({})).toBe('')
  })
})

describe('recognizing the same reservation twice', () => {
  const at = { propertyId: 'p1', guestName: 'Dale Carter', checkIn: '2027-03-06', checkOut: '2027-03-13' }

  it('uses the old system\'s own number when the file carries one', () => {
    expect(migrationKey({ ...at, externalRef: 'RES-1041' }))
      .toBe(migrationKey({ ...at, externalRef: 'res-1041', guestName: 'D. Carter' }))
  })

  it('falls back to the guest and their nights at that park', () => {
    expect(migrationKey(at)).toBe(migrationKey({ ...at, guestName: 'dale  carter' }))
    expect(migrationKey(at)).not.toBe(migrationKey({ ...at, checkIn: '2027-03-07' }))
  })

  it('never matches across two parks', () => {
    expect(migrationKey({ ...at, externalRef: 'RES-1041' }))
      .not.toBe(migrationKey({ ...at, propertyId: 'p2', externalRef: 'RES-1041' }))
  })
})

describe('the template', () => {
  it('is a header row and one filled-in example', () => {
    const lines = buildReservationTemplateCsv().trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0].split(',')).toContain('check_in')
    // The example has to survive its own importer.
    const [row] = applyReservationMapping([Object.fromEntries(
      lines[0].split(',').map((h, i) => [h, lines[1].split(',')[i]]))])
    expect(parseStayDate(row.check_in)).toBe('2027-03-06')
    expect(parseMoney(row.total_amount)).toBe(286.75)
  })
})
