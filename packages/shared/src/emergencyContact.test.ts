/**
 * S640 — every one of these strings is a real emergency contact, copied out of
 * a signed lease at Mountain View or Oak Park. That is the point: the parser is
 * measured against what people actually wrote, not against what a form would
 * have made them write.
 */
import { describe, it, expect } from 'vitest'
import { parseEmergencyContact, formatPhone, namesLikelySamePerson } from './emergencyContact'

describe('S640 parsing what somebody wrote on a lease', () => {
  it('name then number', () => {
    const r = parseEmergencyContact('Leigh Fisher 520-903-8134')
    expect(r).toMatchObject({ name: 'Leigh Fisher', phone: '5209038134', quality: 'complete' })
  })

  it('number then name', () => {
    const r = parseEmergencyContact('502 330 3810 Joe Martínez ')
    expect(r).toMatchObject({ name: 'Joe Martínez', phone: '5023303810', quality: 'complete' })
  })

  it('spaces instead of dashes', () => {
    expect(parseEmergencyContact('Judy Platt 928 713 7544')).toMatchObject({
      name: 'Judy Platt', phone: '9287137544', quality: 'complete',
    })
  })

  it('no separators at all', () => {
    expect(parseEmergencyContact('Rick 4802904895')).toMatchObject({
      name: 'Rick', phone: '4802904895', quality: 'complete',
    })
  })

  // Nic's case: the one that needs a human or a cross-match to finish.
  it('a name and nothing else', () => {
    expect(parseEmergencyContact('Irma Fuentes')).toMatchObject({
      name: 'Irma Fuentes', phone: null, quality: 'name_only',
    })
  })

  it('a number with nobody attached to it', () => {
    expect(parseEmergencyContact('5208414602')).toMatchObject({
      name: null, phone: '5208414602', quality: 'phone_only',
    })
  })

  // "520-9002-009" is ten digits grouped oddly. It is a real number.
  it('keeps an oddly grouped ten-digit number', () => {
    expect(parseEmergencyContact(' Lois 520-9002-009')).toMatchObject({
      name: 'Lois', phone: '5209002009', quality: 'complete',
    })
  })

  it('a relationship with no person in it', () => {
    const r = parseEmergencyContact('Wife')
    expect(r.name).toBeNull()
    expect(r.relationship).toBe('Wife')
    expect(r.quality).toBe('unusable')
  })

  // Somebody wrote 911. It must never be stored as a number to dial.
  it.each(['NA', 'Na', 'n/a', '911', 'none', '-', ''])('refuses %j as a contact', (input) => {
    const r = parseEmergencyContact(input)
    expect(r.quality).toBe('unusable')
    expect(r.phone).toBeNull()
    expect(r.name).toBeNull()
  })

  it('always keeps the original text, whatever it made of it', () => {
    for (const s of ['Tara Starr 817-597-6359', 'NA', 'Wife', '5208414602']) {
      expect(parseEmergencyContact(s).raw).toBe(s)
    }
  })

  it('drops a leading country code', () => {
    expect(parseEmergencyContact('Sam Reyes 1-520-903-8134').phone).toBe('5209038134')
  })

  // A ZIP, a unit number, a year — none of these are phone numbers.
  it.each(['Anna 85001', 'Bob 2026', 'Cal 4'])('does not invent a phone from %j', (input) => {
    expect(parseEmergencyContact(input).phone).toBeNull()
  })
})

describe('S640 formatting', () => {
  it('formats ten digits for a human', () => {
    expect(formatPhone('5209038134')).toBe('(520) 903-8134')
  })
  it('leaves anything else alone rather than mangling it', () => {
    expect(formatPhone('12345')).toBe('12345')
    expect(formatPhone(null)).toBeNull()
  })
})

describe('S640 matching a contact to somebody already here', () => {
  it('matches on first and last, ignoring case and accents', () => {
    expect(namesLikelySamePerson('Irma Fuentes', 'irma fuentes')).toBe(true)
    expect(namesLikelySamePerson('Joe Martínez', 'Joe Martinez')).toBe(true)
  })

  // Strict on purpose: this offers somebody's phone number to staff as the
  // right one to call in an emergency. A loose match is worse than none.
  it('refuses a single name, or a different person', () => {
    expect(namesLikelySamePerson('Irma', 'Irma Fuentes')).toBe(false)
    expect(namesLikelySamePerson('Kevin Black', 'Kevin Blackwood')).toBe(false)
    expect(namesLikelySamePerson('Amy Robinson', 'Bret Robinson')).toBe(false)
  })
})
