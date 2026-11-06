/**
 * 10/29 (Nic): "scan or type. we want flexibility."
 *
 * A desk licence reader is a USB device that behaves as a keyboard — it types
 * the barcode's whole payload into the focused box and presses Enter. So the
 * scan and the typing arrive in the same field, and this is what tells them
 * apart and reads the one that is a licence.
 */
import { describe, it, expect } from 'vitest'
import { parseIdScan, normalizedIdNumber } from '@gam/shared'

/** A US licence payload as a reader delivers it, line breaks and all. */
const US = [
  '@', '\u001e', 'ANSI 636026080102DL00410288ZA03290015DLDAQD1234567',
  'DCSWISENER', 'DACDALE', 'DADJAMES',
  'DBB03141979', 'DBA03142028',
  'DAG1200 W GURLEY ST', 'DAIPRESCOTT', 'DAJAZ', 'DAK863010000',
  'DCGUSA',
].join('\n')

describe('reading a scanned licence', () => {
  it('reads the person off a US licence', () => {
    const r = parseIdScan(US)!
    expect(r).toMatchObject({
      idNumber: 'D1234567', lastName: 'WISENER', firstName: 'DALE',
      issuingState: 'AZ', issuingCountry: 'US',
      city: 'PRESCOTT', street: '1200 W GURLEY ST',
    })
    // US dates are MMDDYYYY — 03141979 is the 14th of March, not the 3rd.
    expect(r.dateOfBirth).toBe('1979-03-14')
    expect(r.expiryDate).toBe('2028-03-14')
  })

  it('reads a Canadian licence, whose dates are the other way round', () => {
    const CA = ['@', 'ANSI 636012040002DL00410278ZC03190008DLDAQ1234-5678',
      'DCSTREMBLAY', 'DACMARIE', 'DBB19790314', 'DAJBC', 'DCGCAN'].join('\n')
    const r = parseIdScan(CA)!
    // 19790314 can only be YYYYMMDD — no month is 1979.
    expect(r.dateOfBirth).toBe('1979-03-14')
    expect(r.issuingCountry).toBe('CA')
    expect(r.issuingState).toBe('BC')
  })

  it('still reads a payload whose line breaks the reader stripped', () => {
    const r = parseIdScan(US.replace(/\n/g, ''))!
    expect(r.lastName).toBe('WISENER')
    expect(r.dateOfBirth).toBe('1979-03-14')
  })

  /**
   * This is how the desk form tells a scan from somebody typing: a person's
   * name is not an AAMVA payload, so it comes back null and the form treats
   * the box as plain typing.
   */
  it('says no to anything that is not a licence', () => {
    expect(parseIdScan('Dale Wisener')).toBeNull()
    expect(parseIdScan('')).toBeNull()
    expect(parseIdScan('D1234567')).toBeNull()
    // A header with nothing identifying behind it is a failed read, not a
    // person with no name.
    expect(parseIdScan('@\nANSI 636026080102DL\nDAU070 IN\nDAYBRO')).toBeNull()
  })

  it('ignores a date that cannot be one', () => {
    const r = parseIdScan(US.replace('DBB03141979', 'DBB99999999'))!
    expect(r.dateOfBirth).toBeUndefined()
    expect(r.idNumber).toBe('D1234567')   // the rest of the read still stands
  })

  /**
   * Two records of one licence have to meet however they were entered — a
   * scan gives 'D1234567', a person types 'd1234567' or 'D-1234567'.
   */
  it('compares licence numbers however they were written', () => {
    expect(normalizedIdNumber('D1234567')).toBe('D1234567')
    expect(normalizedIdNumber(' d-123 4567 ')).toBe('D1234567')
    expect(normalizedIdNumber('123')).toBeNull()      // too short to identify
    expect(normalizedIdNumber(null)).toBeNull()
  })
})
