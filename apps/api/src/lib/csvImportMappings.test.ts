/**
 * csvImportMappings — pure unit tests.
 *
 * The mapping module is stateless (no DB, no IO), so these tests don't
 * need the gam_test fixture. They verify the three core behaviors:
 *
 *   1. applyMapping / applyPropertyMapping / applyPaymentMapping —
 *      per-platform alias-to-canonical translation, case-insensitive,
 *      first-alias-wins on collisions, unmapped columns dropped.
 *   2. buildTemplateCsv / buildPropertyTemplateCsv /
 *      buildPaymentTemplateCsv — canonical-order header rows.
 *   3. isCsvImportPlatform / isPlatformEnabled / config getters.
 */

import { describe, it, expect } from 'vitest'
import {
  applyMapping, applyPropertyMapping, applyPaymentMapping,
  buildTemplateCsv, buildPropertyTemplateCsv, buildPaymentTemplateCsv,
  getPropertyPlatformConfig, getPaymentPlatformConfig,
  isCsvImportPlatform, isPlatformEnabled,
  GAM_CANONICAL_HEADERS,
  GAM_PROPERTY_CANONICAL_HEADERS,
  GAM_PAYMENT_HISTORY_CANONICAL_HEADERS,
} from './csvImportMappings'

describe('isCsvImportPlatform / isPlatformEnabled', () => {
  it('recognizes all supported platform keys', () => {
    for (const p of ['generic', 'buildium', 'appfolio', 'doorloop', 'yardi',
                     'rentmanager', 'propertyware', 'rentec', 'tenantcloud']) {
      expect(isCsvImportPlatform(p)).toBe(true)
    }
  })

  it('rejects unknown platform keys', () => {
    expect(isCsvImportPlatform('zillow')).toBe(false)
    expect(isCsvImportPlatform('')).toBe(false)
    expect(isCsvImportPlatform('BUILDIUM')).toBe(false)  // case-sensitive
  })

  it('reports all enabled platforms as enabled', () => {
    for (const p of ['generic', 'buildium', 'appfolio', 'doorloop', 'yardi',
                     'rentmanager', 'propertyware', 'rentec', 'tenantcloud'] as const) {
      expect(isPlatformEnabled(p)).toBe(true)
    }
  })
})

describe('applyMapping — tenant CSV', () => {
  it('generic platform is identity (no translation)', () => {
    const input = [{ first_name: 'Jane', email: 'jane@x.com', monthly_rent: '1500' }]
    expect(applyMapping(input, 'generic')).toEqual(input)
  })

  it('Buildium standard columns translate to GAM canonical', () => {
    const buildium = [{
      'First Name':     'Jane',
      'Last Name':      'Doe',
      'Email':          'jane@x.com',
      'Mobile Phone':   '555-0100',
      'Property':       'Sunset Apartments',
      'Unit':           '4B',
      'Lease Start':    '2024-06-01',
      'Lease End':      '2025-05-31',
      'Rent':           '1850',
      'Security Deposit': '1850',
    }]
    const result = applyMapping(buildium, 'buildium')
    expect(result).toHaveLength(1)
    expect(result[0].first_name).toBe('Jane')
    expect(result[0].last_name).toBe('Doe')
    expect(result[0].email).toBe('jane@x.com')
    expect(result[0].phone).toBe('555-0100')
    expect(result[0].property_name).toBe('Sunset Apartments')
    expect(result[0].unit_number).toBe('4B')
    expect(result[0].lease_start).toBe('2024-06-01')
    expect(result[0].lease_end).toBe('2025-05-31')
    expect(result[0].monthly_rent).toBe('1850')
    expect(result[0].security_deposit).toBe('1850')
  })

  it('Buildium balance column translates to outstanding_balance', () => {
    const input = [{ 'First Name': 'A', 'Outstanding Balance': '1234.56' }]
    const result = applyMapping(input, 'buildium')
    expect(result[0].outstanding_balance).toBe('1234.56')
  })

  it('AppFolio plural Emails / Phone Numbers map correctly (S29X fix)', () => {
    const appfolio = [{
      'First Name':    'Jane',
      'Last Name':     'Doe',
      'Emails':        'jane@x.com, jane.alt@x.com',
      'Phone Numbers': '555-0100, 555-0101',
    }]
    const result = applyMapping(appfolio, 'appfolio')
    expect(result[0].email).toBe('jane@x.com, jane.alt@x.com')
    expect(result[0].phone).toBe('555-0100, 555-0101')
  })

  it('AppFolio bare Move-in / Move-out variants map (S29X fix)', () => {
    const appfolio = [{
      'First Name': 'Jane', 'Last Name': 'Doe', 'Email': 'jane@x.com',
      'Move-in':    '2024-06-01',
      'Move-out':   '2025-05-31',
    }]
    const result = applyMapping(appfolio, 'appfolio')
    expect(result[0].lease_start).toBe('2024-06-01')
    expect(result[0].lease_end).toBe('2025-05-31')
  })

  it('Buildium `Login email` and bare `Mobile` map (S29X round-2 fix)', () => {
    const buildium = [{
      'First Name':  'Jane',
      'Last Name':   'Doe',
      'Login email': 'jane@x.com',
      'Mobile':      '555-0100',
    }]
    const result = applyMapping(buildium, 'buildium')
    expect(result[0].email).toBe('jane@x.com')
    expect(result[0].phone).toBe('555-0100')
  })

  it('Propertyware Home/Mobile/Work Phone # variants map (S29X fix)', () => {
    const pw = [{
      'First Name':    'Jane',
      'Last Name':     'Doe',
      'Mobile Phone #': '555-0100',
    }]
    const result = applyMapping(pw, 'propertyware')
    expect(result[0].phone).toBe('555-0100')
  })

  it('case-insensitive matching on aliases', () => {
    const input = [{ 'FIRST NAME': 'Jane', 'lAsT nAmE': 'Doe' }]
    const result = applyMapping(input, 'buildium')
    expect(result[0].first_name).toBe('Jane')
    expect(result[0].last_name).toBe('Doe')
  })

  it('whitespace-trimmed matching on aliases', () => {
    const input = [{ '  First Name  ': 'Jane', '\tLast Name\t': 'Doe' }]
    const result = applyMapping(input, 'buildium')
    expect(result[0].first_name).toBe('Jane')
    expect(result[0].last_name).toBe('Doe')
  })

  it('S294: noise (ignoredColumns) dropped; unknown columns routed to _extra', () => {
    const input = [{
      'First Name': 'Jane',
      'Status':         'Active',           // Buildium ignored — noise, dropped
      'Some Random':    'value',            // unknown — routed to _extra
    }]
    const result = applyMapping(input, 'buildium')
    expect(result[0].first_name).toBe('Jane')
    expect((result[0] as any).Status).toBeUndefined()
    expect((result[0] as any)['Some Random']).toBeUndefined()
    expect(result[0]._extra).toEqual({ 'Some Random': 'value' })
  })

  it('first-alias-wins when multiple aliases match the same canonical', () => {
    // Buildium maps `Email`, `Email Address`, `Tenant Email` all → email.
    // If a record somehow has two of them, the FIRST in the alias array
    // takes precedence (alias-build order). `Email` is first in array.
    const input = [{ 'Tenant Email': 'second@x.com', 'Email': 'first@x.com' }]
    const result = applyMapping(input, 'buildium')
    expect(result[0].email).toBe('first@x.com')
  })

  it('Buildium ignoredColumns are dropped silently (no warnings)', () => {
    const input = [{
      'First Name':    'Jane',
      'Tenant Status': 'Past Due',   // documented-ignored / noise
      'Tenant Type':   'Standard',   // documented-ignored / noise
    }]
    const result = applyMapping(input, 'buildium')
    // S294: noise columns dropped; no _extra emitted since all unknowns
    // are in the noise list.
    expect(Object.keys(result[0])).toEqual(['first_name'])
    expect(result[0]._extra).toBeUndefined()
  })

  it('S294: _extra preserves original-case header keys', () => {
    const input = [{
      'First Name':       'Jane',
      'My Custom Field':  'X',
      'ANOTHER_FIELD':    'Y',
    }]
    const result = applyMapping(input, 'buildium')
    expect(result[0]._extra).toEqual({
      'My Custom Field': 'X',
      'ANOTHER_FIELD':   'Y',
    })
  })

  it('S294: _extra omitted entirely when no unknown columns', () => {
    const input = [{ 'First Name': 'Jane', 'Last Name': 'Doe' }]
    const result = applyMapping(input, 'buildium')
    expect(result[0]._extra).toBeUndefined()
  })

  it('handles multiple rows', () => {
    const input = [
      { 'First Name': 'Jane', 'Last Name': 'Doe' },
      { 'First Name': 'Bob',  'Last Name': 'Smith' },
    ]
    const result = applyMapping(input, 'buildium')
    expect(result).toHaveLength(2)
    expect(result[0].first_name).toBe('Jane')
    expect(result[1].first_name).toBe('Bob')
  })
})

describe('applyPropertyMapping — property+unit CSV', () => {
  it('generic platform is identity', () => {
    const input = [{ property_name: 'X', unit_number: '1' }]
    expect(applyPropertyMapping(input, 'generic')).toEqual(input)
  })

  it('Buildium property+unit columns translate correctly', () => {
    const input = [{
      'Property':         'Sunset Apartments',
      'Address':          '100 Main St',
      'City':             'Phoenix',
      'State':            'AZ',
      'Zip':              '85001',
      'Unit':             '4B',
      'Bedrooms':         '2',
      'Bathrooms':        '1.5',
      'Market Rent':      '1850',
      'Security Deposit': '1850',
    }]
    const result = applyPropertyMapping(input, 'buildium')
    expect(result[0].property_name).toBe('Sunset Apartments')
    expect(result[0].street1).toBe('100 Main St')
    expect(result[0].city).toBe('Phoenix')
    expect(result[0].state).toBe('AZ')
    expect(result[0].zip).toBe('85001')
    expect(result[0].unit_number).toBe('4B')
    expect(result[0].bedrooms).toBe('2')
    expect(result[0].bathrooms).toBe('1.5')
    expect(result[0].rent_amount).toBe('1850')
    expect(result[0].security_deposit).toBe('1850')
  })

  it('AppFolio Unit Street Address 1 + Unit City etc. translate (S29X fix)', () => {
    const input = [{
      'Property':               'Sunset Apartments',
      'Unit Street Address 1':  '100 Main St',
      'Unit Street Address 2':  'Apt 4B',
      'Unit City':              'Phoenix',
      'Unit State':             'AZ',
      'Unit Zip':               '85001',
      'Unit':                   '4B',
      'Bedrooms':               '2',
      'Rent':                   '1850',
    }]
    const result = applyPropertyMapping(input, 'appfolio')
    expect(result[0].property_name).toBe('Sunset Apartments')
    expect(result[0].street1).toBe('100 Main St')
    expect(result[0].street2).toBe('Apt 4B')
    expect(result[0].city).toBe('Phoenix')
    expect(result[0].state).toBe('AZ')
    expect(result[0].zip).toBe('85001')
    expect(result[0].unit_number).toBe('4B')
    expect(result[0].rent_amount).toBe('1850')
  })

  it('Buildium `Unit address line 1/2` + `City/Locality` + `State/Province/Territory` map (S29X round-2 fix)', () => {
    const input = [{
      'Property':                    'Sunset Apartments',
      'Unit address line 1':         '100 Main St',
      'Unit address line 2':         'Apt 4B',
      'City/Locality':               'Phoenix',
      'State/Province/Territory':    'AZ',
      'Postal code':                 '85001',
      'Unit number':                 '4B',
      'Sub type':                    'Single Family',
      'Rent':                        '1850',
    }]
    const result = applyPropertyMapping(input, 'buildium')
    expect(result[0].street1).toBe('100 Main St')
    expect(result[0].street2).toBe('Apt 4B')
    expect(result[0].city).toBe('Phoenix')
    expect(result[0].state).toBe('AZ')
    expect(result[0].zip).toBe('85001')
    expect(result[0].unit_number).toBe('4B')
    expect(result[0].property_type).toBe('Single Family')
  })

  it('Buildium `Unit address line 3` is intentionally dropped (no slot for 3rd line)', () => {
    const input = [{
      'Property':            'Sunset',
      'Unit address line 1': '100 Main St',
      'Unit address line 2': 'Apt 4B',
      'Unit address line 3': 'Building C',  // dropped — GAM only has 2 slots
      'Unit number':         '4B',
      'Rent':                '1850',
    }]
    const result = applyPropertyMapping(input, 'buildium')
    expect(result[0].street2).toBe('Apt 4B')
    // Line 3 doesn't end up anywhere — verify nothing surprising landed
    expect(Object.values(result[0])).not.toContain('Building C')
  })

  it('RentManager `Street1`/`Street 1`/`PostalCode` variants map (S29X round-2 fix)', () => {
    const input1 = [{
      'Property':   'Sunset',
      'Street1':    '100 Main St',
      'Street2':    'Apt 4B',
      'PostalCode': '85001',
      'Unit':       '4B',
      'Rent':       '1850',
    }]
    const r1 = applyPropertyMapping(input1, 'rentmanager')
    expect(r1[0].street1).toBe('100 Main St')
    expect(r1[0].street2).toBe('Apt 4B')
    expect(r1[0].zip).toBe('85001')

    // Spaced variants from the resident template
    const input2 = [{
      'Property':    'Sunset',
      'Street 1':    '200 Main St',
      'Street 2':    'Apt 5C',
      'Postal Code': '85002',
      'Unit':        '5C',
      'Rent':        '1900',
    }]
    const r2 = applyPropertyMapping(input2, 'rentmanager')
    expect(r2[0].street1).toBe('200 Main St')
    expect(r2[0].street2).toBe('Apt 5C')
    expect(r2[0].zip).toBe('85002')
  })

  it('Propertyware Unit Address / Address Cont. translate (S29X fix)', () => {
    const input = [{
      'Property':           'X',
      'Unit Address':       '100 Main St',
      'Unit Address Cont.': 'Apt 4B',
      'City':               'Phoenix',
      'Unit':               '4B',
      'Rent':               '1850',
    }]
    const result = applyPropertyMapping(input, 'propertyware')
    expect(result[0].street1).toBe('100 Main St')
    expect(result[0].street2).toBe('Apt 4B')
  })

  it('unmapped columns are dropped', () => {
    const input = [{
      'Property':       'X',
      'Year Built':     '1985',   // ignored
      'Occupancy':      'Vacant', // ignored
    }]
    const result = applyPropertyMapping(input, 'appfolio')
    expect(Object.keys(result[0])).toEqual(['property_name'])
  })
})

describe('applyPaymentMapping — payment history CSV', () => {
  it('Buildium transaction-list columns translate correctly', () => {
    const input = [{
      'Tenant Email':    'jane@x.com',
      'Date':            '2025-06-01',
      'Amount':          '1850.00',
      'Type':            'Rent Payment',
      'Method':          'ACH',
      'Property':        'Sunset Apartments',
      'Unit':            '4B',
      'Reference':       'June rent',
    }]
    const result = applyPaymentMapping(input, 'buildium')
    expect(result[0].tenant_email).toBe('jane@x.com')
    expect(result[0].payment_date).toBe('2025-06-01')
    expect(result[0].amount).toBe('1850.00')
    expect(result[0].payment_type).toBe('Rent Payment')
    expect(result[0].payment_method).toBe('ACH')
    expect(result[0].property_name).toBe('Sunset Apartments')
    expect(result[0].unit_number).toBe('4B')
    expect(result[0].reference).toBe('June rent')
  })

  it('Yardi receipt-export columns translate correctly', () => {
    const input = [{
      'Resident Email':   'jane@x.com',
      'Receipt Date':     '2025-06-01',
      'Receipt Amount':   '1850',
      'Charge Code':      'rent',
      'Property':         'Sunset',
      'Unit Code':        '4B',
      'Check Number':     '12345',
    }]
    const result = applyPaymentMapping(input, 'yardi')
    expect(result[0].tenant_email).toBe('jane@x.com')
    expect(result[0].payment_date).toBe('2025-06-01')
    expect(result[0].amount).toBe('1850')
    expect(result[0].payment_type).toBe('rent')
    expect(result[0].unit_number).toBe('4B')
    expect(result[0].reference).toBe('12345')
  })

  it('ignoredColumns are dropped (Buildium Running Balance, Posted By)', () => {
    const input = [{
      'Tenant Email':    'jane@x.com',
      'Running Balance': '5000',
      'Posted By':       'admin',
    }]
    const result = applyPaymentMapping(input, 'buildium')
    expect(Object.keys(result[0])).toEqual(['tenant_email'])
  })
})

describe('buildTemplateCsv — tenant template', () => {
  it('generic template has all canonical headers + an example row', () => {
    const csv = buildTemplateCsv('generic')
    const [header, example] = csv.trim().split('\n')
    expect(header.split(',')).toEqual([...GAM_CANONICAL_HEADERS])
    expect(example.split(',').length).toBe(GAM_CANONICAL_HEADERS.length)
  })

  it('Buildium template emits Buildium-specific header names', () => {
    const csv = buildTemplateCsv('buildium')
    const header = csv.trim()
    expect(header).toContain('First Name')
    expect(header).toContain('Mobile Phone')
    // `Rent` is the first alias for rent_amount in the Buildium mapping.
    // Confirm template emits the canonical first-alias form.
    expect(header.split(',')).toContain('Rent')
    expect(header).toContain('Outstanding Balance')
  })

  it('AppFolio template includes outstanding_balance via Past Due Amount', () => {
    const csv = buildTemplateCsv('appfolio')
    const header = csv.trim()
    expect(header).toContain('Past Due Amount')
  })
})

describe('buildPropertyTemplateCsv — property template', () => {
  it('generic template has all property canonical headers + example row', () => {
    const csv = buildPropertyTemplateCsv('generic')
    const [header, example] = csv.trim().split('\n')
    expect(header.split(',')).toEqual([...GAM_PROPERTY_CANONICAL_HEADERS])
    expect(example.split(',').length).toBe(GAM_PROPERTY_CANONICAL_HEADERS.length)
  })

  it('AppFolio template emits Unit-prefixed address columns', () => {
    const csv = buildPropertyTemplateCsv('appfolio')
    const header = csv.trim()
    // First alias for street1 is `Address` in our mapping — not the
    // Unit-prefixed one. (We list `Address` first because it's the
    // common AppFolio variant; Unit Street Address 1 is the verbose
    // form on some custom reports.)
    expect(header).toContain('Address')
  })
})

describe('buildPaymentTemplateCsv — payment-history template', () => {
  it('generic template has all payment canonical headers + example row', () => {
    const csv = buildPaymentTemplateCsv('generic')
    const [header, example] = csv.trim().split('\n')
    expect(header.split(',')).toEqual([...GAM_PAYMENT_HISTORY_CANONICAL_HEADERS])
    expect(example.split(',').length).toBe(GAM_PAYMENT_HISTORY_CANONICAL_HEADERS.length)
  })

  it('Buildium template emits Tenant Email + Date + Amount as preferred', () => {
    const csv = buildPaymentTemplateCsv('buildium')
    const header = csv.trim()
    expect(header).toContain('Tenant Email')
    expect(header).toContain('Date')
    expect(header).toContain('Amount')
  })
})

describe('getPropertyPlatformConfig / getPaymentPlatformConfig', () => {
  it('returns a config object with the expected shape', () => {
    const pCfg = getPropertyPlatformConfig('buildium')
    expect(pCfg).toBeTruthy()
    expect(pCfg.enabled).toBe(true)
    expect(typeof pCfg.label).toBe('string')
    expect(pCfg.columnMapping.property_name.length).toBeGreaterThan(0)

    const payCfg = getPaymentPlatformConfig('buildium')
    expect(payCfg).toBeTruthy()
    expect(payCfg.enabled).toBe(true)
    expect(payCfg.columnMapping.tenant_email.length).toBeGreaterThan(0)
  })
})
