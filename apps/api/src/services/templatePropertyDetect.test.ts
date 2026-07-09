import { describe, it, expect } from 'vitest'
import { matchPropertiesInText } from './templatePropertyDetect'

const PROPS = [
  { id: 'p1', name: 'Oak Street Apartments', street1: '412 Oak Street' },
  { id: 'p2', name: 'Sunset Palms RV Resort', street1: '9800 W Desert Sky Rd' },
  { id: 'p3', name: 'Maple Court', street1: null },
]

describe('S535 template property detection', () => {
  it('matches by street address (strongest signal), punctuation-insensitive', () => {
    const hit = matchPropertiesInText(
      'RESIDENTIAL LEASE for the premises at 412 Oak Street, Phoenix, AZ 85004 between the parties', PROPS)
    expect(hit).toEqual({ propertyId: 'p1', propertyName: 'Oak Street Apartments', matchedOn: 'address' })
  })

  it('matches by property name when no address appears', () => {
    const hit = matchPropertiesInText(
      'Welcome to Sunset Palms RV Resort. This agreement covers space rental terms.', PROPS)
    expect(hit?.propertyId).toBe('p2')
    expect(hit?.matchedOn).toBe('name')
  })

  it('two matching properties = ambiguous = no lock suggestion', () => {
    const hit = matchPropertiesInText(
      'Applies at Oak Street Apartments and Sunset Palms RV Resort locations.', PROPS)
    expect(hit).toBeNull()
  })

  it('no match / short fragments → null', () => {
    expect(matchPropertiesInText('Generic lease agreement with no property identifiers.', PROPS)).toBeNull()
    expect(matchPropertiesInText('Oak', PROPS)).toBeNull()
  })
})
