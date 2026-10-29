/**
 * The three-point rule (Nic, 10/25): "It has to have at least three matching
 * data points of information." The cost of getting this wrong is somebody's
 * bill, or their card, on a stranger's account — so the cases that must NOT
 * match are tested as hard as the ones that must.
 */
import { describe, it, expect } from 'vitest'
import {
  isSamePerson, countMatchPoints, matchingPoints, hasEnoughPointsToMatch,
  normalizePhone, normalizeName, normalizeEmail, matchPointsSentence,
  CUSTOMER_MATCH_POINTS_REQUIRED,
} from './customerMatch'

describe('three agreeing points make one person', () => {
  it('first name + last name + phone is the common case', () => {
    const a = { firstName: 'Dominic', lastName: 'Gonzalez', phone: '(928) 555-0100' }
    const b = { firstName: 'dominic', lastName: 'GONZALEZ', phone: '9285550100' }
    expect(matchingPoints(a, b)).toEqual(['first_name', 'last_name', 'phone'])
    expect(isSamePerson(a, b)).toBe(true)
  })

  it('name + email is three points too', () => {
    const a = { firstName: 'Lisa', lastName: 'Scheeler', email: 'Lisa@Example.com ' }
    const b = { firstName: 'lisa', lastName: 'scheeler', email: 'lisa@example.com' }
    expect(isSamePerson(a, b)).toBe(true)
  })

  it('a shared payment method counts as a point', () => {
    // Nic: "it could be a payment method saved on file."
    const a = { firstName: 'Myria', lastName: 'Skinner', paymentMethodRef: 'cus_123' }
    const b = { firstName: 'myria', lastName: 'skinner', paymentMethodRef: 'cus_123' }
    expect(matchingPoints(a, b)).toEqual(['first_name', 'last_name', 'payment_method'])
    expect(isSamePerson(a, b)).toBe(true)
  })

  it('the US country code never makes two numbers different', () => {
    expect(normalizePhone('+1 928-555-0100')).toBe('9285550100')
    expect(normalizePhone('19285550100')).toBe('9285550100')
    expect(normalizePhone('(928) 555-0100')).toBe('9285550100')
  })

  it('case and stray spacing never decide a person', () => {
    expect(normalizeName('  Jolyn   Whitfield ')).toBe('jolyn whitfield')
    expect(normalizeEmail('  LISA@Example.COM ')).toBe('lisa@example.com')
  })
})

describe('what must never be treated as the same person', () => {
  it('two points is not enough, however common the name', () => {
    const a = { firstName: 'Mike', lastName: 'Smith', phone: '9285550100' }
    const b = { firstName: 'Mike', lastName: 'Smith', phone: '9285559999' }
    expect(countMatchPoints(a, b)).toBe(2)
    expect(isSamePerson(a, b)).toBe(false)
  })

  it('a blank is never a match — two records with no phone do not agree on phone', () => {
    const a = { firstName: 'Kim', lastName: 'Bowman', phone: null, email: null }
    const b = { firstName: 'Kim', lastName: 'Bowman', phone: '', email: '  ' }
    expect(matchingPoints(a, b)).toEqual(['first_name', 'last_name'])
    expect(isSamePerson(a, b)).toBe(false)
  })

  it('a short or junk phone is not a point', () => {
    expect(normalizePhone('555')).toBe('')
    expect(normalizePhone('n/a')).toBe('')
    const a = { firstName: 'Troy', lastName: 'Street', phone: '555' }
    const b = { firstName: 'Troy', lastName: 'Street', phone: '555' }
    expect(isSamePerson(a, b)).toBe(false)
  })

  it('the same phone on two different people is not a person', () => {
    // A household landline, or a number handed down. Two points at most.
    const a = { firstName: 'Susie', lastName: 'McCoy', phone: '9285550100' }
    const b = { firstName: 'Nathan', lastName: 'Mitchell', phone: '9285550100' }
    expect(countMatchPoints(a, b)).toBe(1)
    expect(isSamePerson(a, b)).toBe(false)
  })

  it('a record with fewer than three points of its own can never be matched', () => {
    // 749 register rows exist; the ones holding only a first name identify
    // nobody and must not be merged into anybody.
    expect(hasEnoughPointsToMatch({ firstName: 'Mike' })).toBe(false)
    expect(hasEnoughPointsToMatch({ firstName: 'Mike', lastName: 'Smith' })).toBe(false)
    expect(hasEnoughPointsToMatch({ firstName: 'Mike', lastName: 'Smith', phone: '9285550100' })).toBe(true)
  })
})

describe('the rule is stated once', () => {
  it('three is the number', () => {
    expect(CUSTOMER_MATCH_POINTS_REQUIRED).toBe(3)
  })
  it('says in plain words what agreed', () => {
    expect(matchPointsSentence(['first_name', 'last_name', 'phone']))
      .toBe('first name, last name and phone')
    expect(matchPointsSentence(['payment_method'])).toBe('a saved payment method')
  })
})
