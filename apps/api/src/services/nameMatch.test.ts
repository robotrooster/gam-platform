/**
 * The name rule, in Nic's own examples and in the ones that must NOT match.
 */
import { describe, it, expect } from 'vitest'
import {
  nameAgreement, firstNamesAgree, nameWords, normalizedEmail, normalizedPhone, NICKNAMES,
} from './nameMatch'

describe('the three Nic named himself', () => {
  it('Nick Rhodes is Nicholas Rhodes', () => {
    expect(nameAgreement('Nick Rhodes', 'Nicholas Rhodes')).toBe('same')
    expect(nameAgreement('Nicholas Rhodes', 'Nick Rhodes')).toBe('same')
  })
  it('Richard is Dick', () => {
    expect(nameAgreement('Dick Pruitt', 'Richard Pruitt')).toBe('same')
  })
  it('William is Bob', () => {
    expect(nameAgreement('Bob Mattoon', 'William Mattoon')).toBe('same')
  })
})

describe('the ways a name gets typed on an informal invoice', () => {
  it('a shortening needs no list — Nic/Nicholas, Steph/Stephanie, Rob/Robert', () => {
    expect(firstNamesAgree('nic', 'nicholas')).toBe(true)
    expect(firstNamesAgree('steph', 'stephanie')).toBe(true)
    expect(firstNamesAgree('rob', 'robert')).toBe(true)
  })
  it('a middle name, a title and a suffix are not the name', () => {
    expect(nameAgreement('Mr. Dale P. Pruitt, Jr.', 'dale pruitt')).toBe('same')
    expect(nameWords("Mr. Dale P. O'Brien III")).toEqual(['dale', 'p', 'obrien'])
  })
  it('case, accents, hyphens and extra spaces do not matter', () => {
    expect(nameAgreement('  DALE   PRUITT ', 'Dale Pruitt')).toBe('same')
    expect(nameAgreement('José Ruiz', 'jose ruiz')).toBe('same')
    expect(nameAgreement('Mary-Anne Smith-Jones', 'maryanne smithjones')).toBe('same')
  })
})

describe('what a person at GAM has to look at — never guessed either way', () => {
  it('an initial for a first name', () => {
    expect(nameAgreement('D Pruitt', 'Dale Pruitt')).toBe('unsure')
    expect(nameAgreement('D. Pruitt', 'Dale Pruitt')).toBe('unsure')
  })
  it('one name against two', () => {
    expect(nameAgreement('Pruitt', 'Dale Pruitt')).toBe('unsure')
    expect(nameAgreement('Dale', 'Dale Pruitt')).toBe('unsure')
  })
  it('the same family name with a different first name — a brother, a son', () => {
    // They share the address and the phone. A human decides.
    expect(nameAgreement('Wayne Pruitt', 'Dale Pruitt')).toBe('unsure')
  })
  it('the same first name with a different family name — a marriage', () => {
    expect(nameAgreement('Dale Pruitt', 'Dale Mattoon')).toBe('unsure')
  })
})

describe('what is simply not the same person', () => {
  it('two names with nothing in common', () => {
    expect(nameAgreement('Dale Pruitt', 'Ann Reed')).toBe('different')
  })
  it('an empty name on either side', () => {
    expect(nameAgreement('', 'Dale Pruitt')).toBe('different')
    expect(nameAgreement('Dale Pruitt', null)).toBe('different')
    expect(nameAgreement(null, undefined)).toBe('different')
  })
  it('a name that is only digits or punctuation', () => {
    expect(nameAgreement('—', 'Dale Pruitt')).toBe('different')
    expect(nameAgreement('12345', 'Dale Pruitt')).toBe('different')
  })
  it('two short names that merely start alike', () => {
    // "Jo" is its own name, not a shortening of Joseph, so the three-letter
    // floor matters.
    expect(firstNamesAgree('jo', 'joseph')).toBe(false)
    expect(firstNamesAgree('a', 'andrew')).toBe(false)
    expect(nameAgreement('Jan Pruitt', 'Janet Pruitt')).toBe('same')   // three letters, a real shortening
    expect(nameAgreement('Jo Pruitt', 'Joseph Pruitt')).toBe('unsure') // same family name, decide by hand
  })
})

describe('the answer never moves', () => {
  it('the same two names give the same answer however many times they are asked', () => {
    for (let i = 0; i < 500; i++) {
      expect(nameAgreement('Nick Rhodes', 'Nicholas Rhodes')).toBe('same')
      expect(nameAgreement('Wayne Pruitt', 'Dale Pruitt')).toBe('unsure')
      expect(nameAgreement('Dale Pruitt', 'Ann Reed')).toBe('different')
    }
  })
  it('agreement reads the same both ways round', () => {
    const pairs: [string, string][] = [
      ['Nick Rhodes', 'Nicholas Rhodes'], ['D Pruitt', 'Dale Pruitt'],
      ['Pruitt', 'Dale Pruitt'], ['Dale Pruitt', 'Ann Reed'], ['Bob Mattoon', 'William Mattoon'],
    ]
    for (const [a, b] of pairs) expect(nameAgreement(a, b), `${a} / ${b}`).toBe(nameAgreement(b, a))
  })
})

describe('the nickname list itself', () => {
  it('is all lower case, with no name listed twice on one line', () => {
    for (const group of NICKNAMES) {
      expect(group.join(' ')).toBe(group.join(' ').toLowerCase())
      expect(new Set(group).size, group.join('/')).toBe(group.length)
      expect(group.length).toBeGreaterThan(1)
    }
  })
})

describe('an email and a phone are compared one way', () => {
  it('an email is trimmed and lower-cased', () => {
    expect(normalizedEmail('  Dale@T.DEV ')).toBe('dale@t.dev')
    expect(normalizedEmail('not-an-email')).toBeNull()
    expect(normalizedEmail(null)).toBeNull()
  })
  it('a phone is its last ten digits, however it was written', () => {
    for (const p of ['6025559999', '602-555-9999', '(602) 555-9999', '+1 602 555 9999', '1-602-555-9999']) {
      expect(normalizedPhone(p), p).toBe('6025559999')
    }
    expect(normalizedPhone('555-9999')).toBeNull()
    expect(normalizedPhone('')).toBeNull()
  })
})
