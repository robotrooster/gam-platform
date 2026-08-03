/**
 * S573 — inspection master-catalog resolver (buildInspectionChecklist).
 * One master catalog filtered by the unit's real facts (type / bed-bath /
 * living-areas / ownership / multi-level / ADA / feature toggles). Nothing is
 * ever "N/A" — absent features/rooms = absent items.
 */
import { describe, it, expect } from 'vitest'
import { buildInspectionChecklist, resolveUnitFeatures } from '@gam/shared'

const areas = (input: Parameters<typeof buildInspectionChecklist>[0]) =>
  buildInspectionChecklist(input).map(a => a.area)
const itemsIn = (input: Parameters<typeof buildInspectionChecklist>[0], area: string) =>
  (buildInspectionChecklist(input).find(a => a.area === area)?.items ?? []) as string[]
const allItems = (input: Parameters<typeof buildInspectionChecklist>[0]) =>
  buildInspectionChecklist(input).flatMap(a => a.items as string[])

describe('resolveUnitFeatures — presets', () => {
  it('defaults range+fridge+blinds ON, dishwasher OFF for a dwelling', () => {
    const f = resolveUnitFeatures('single_family', {})
    expect(f.provides_range).toBe(true)
    expect(f.provides_refrigerator).toBe(true)
    expect(f.provides_blinds).toBe(true)
    expect(f.provides_dishwasher).toBe(false)
  })
  it('a stored value overrides the preset', () => {
    expect(resolveUnitFeatures('single_family', { provides_range: false }).provides_range).toBe(false)
    expect(resolveUnitFeatures('apartment', { provides_dishwasher: true }).provides_dishwasher).toBe(true)
  })
})

describe('buildInspectionChecklist — feature gating (no N/A)', () => {
  it('kitchen appliances appear only when their feature is on', () => {
    const base = itemsIn({ unitType: 'apartment', bedrooms: 1 }, 'Kitchen')
    expect(base).toContain('Range / oven')            // preset on
    expect(base).not.toContain('Dishwasher')          // preset off
    const withDish = itemsIn({ unitType: 'apartment', bedrooms: 1, features: { provides_dishwasher: true } }, 'Kitchen')
    expect(withDish).toContain('Dishwasher')
  })
  it('ceiling fan only when toggled on', () => {
    expect(itemsIn({ unitType: 'single_family', bedrooms: 1 }, 'Bedroom 1')).not.toContain('Ceiling fan')
    expect(itemsIn({ unitType: 'single_family', bedrooms: 1, features: { ceiling_fans: true } }, 'Bedroom 1')).toContain('Ceiling fan')
  })
  it('back door defaults ON for houses, OFF for apartments', () => {
    expect(itemsIn({ unitType: 'single_family', bedrooms: 1 }, 'Entry & doors')).toContain('Back / rear door')
    expect(itemsIn({ unitType: 'apartment', bedrooms: 1 }, 'Entry & doors')).not.toContain('Back / rear door')
  })
})

describe('buildInspectionChecklist — counts', () => {
  it('sizes bedrooms and never invents one', () => {
    const a = areas({ unitType: 'apartment', bedrooms: 2, bathrooms: 1 })
    expect(a).toEqual(expect.arrayContaining(['Bedroom 1', 'Bedroom 2']))
    expect(a).not.toContain('Bedroom 3')
  })
  it('repeats living areas by count', () => {
    expect(areas({ unitType: 'single_family', bedrooms: 3, livingAreas: 2 })).toEqual(
      expect.arrayContaining(['Living area 1', 'Living area 2']))
    expect(areas({ unitType: 'single_family', bedrooms: 3, livingAreas: 1 })).toContain('Living / dining')
  })
  it('half bath drops the tub/shower', () => {
    expect(itemsIn({ unitType: 'apartment', bedrooms: 1, bathrooms: 1.5 }, 'Bathroom 2 (half)')).not.toContain('Tub / shower')
    expect(itemsIn({ unitType: 'apartment', bedrooms: 1, bathrooms: 1.5 }, 'Bathroom 1')).toContain('Tub / shower')
  })
})

describe('buildInspectionChecklist — placement / type', () => {
  it('single-family gets grounds; apartment gets common areas', () => {
    const sf = areas({ unitType: 'single_family', bedrooms: 3 })
    expect(sf).toEqual(expect.arrayContaining(['Exterior & structure', 'Yard & grounds']))
    expect(sf).not.toContain('Entry & common areas')
    const apt = areas({ unitType: 'apartment', bedrooms: 2 })
    expect(apt).toContain('Entry & common areas')
    expect(apt).not.toContain('Yard & grounds')
  })
  it('stairs items appear in Hallways & stairs only when multi-level', () => {
    expect(itemsIn({ unitType: 'single_family', bedrooms: 3, isMultiLevel: true }, 'Hallways & stairs')).toContain('Staircase & treads')
    expect(itemsIn({ unitType: 'single_family', bedrooms: 3 }, 'Hallways & stairs')).not.toContain('Staircase & treads')
  })
  it('ADA adds an Accessibility area', () => {
    expect(areas({ unitType: 'apartment', bedrooms: 1, isAdaAccessible: true })).toContain('Accessibility')
    expect(areas({ unitType: 'apartment', bedrooms: 1 })).not.toContain('Accessibility')
  })
})

describe('buildInspectionChecklist — ownership & non-dwelling types', () => {
  it('tenant-owned mobile home = grounds only, never interior', () => {
    const a = areas({ unitType: 'mobile_home', dwellingOwnership: 'tenant' })
    expect(a).toEqual(expect.arrayContaining(['Exterior & structure', 'Yard & grounds', 'Handover']))
    expect(a).not.toContain('Kitchen')
    expect(a.some(x => x.startsWith('Bedroom'))).toBe(false)
  })
  it('RV site always has pedestal/water/sewer/weeds; table only if park-provided', () => {
    const site = itemsIn({ unitType: 'rv_spot', dwellingOwnership: 'tenant' }, 'RV site')
    expect(site).toEqual(expect.arrayContaining(['Electric pedestal / hookup', 'Water connection / spigot', 'Sewer connection', 'Weeds / vegetation']))
    expect(site).not.toContain('Picnic table')
    const withTable = itemsIn({ unitType: 'rv_spot', dwellingOwnership: 'tenant', features: { park_picnic_table: true } }, 'RV site')
    expect(withTable).toContain('Picnic table')
  })
  it('park-owned RV adds the rig areas', () => {
    expect(areas({ unitType: 'rv_spot', dwellingOwnership: 'landlord' })).toEqual(expect.arrayContaining(['RV site', 'RV interior']))
  })
  it('storage is a short empty/latch list', () => {
    expect(allItems({ unitType: 'storage' })).toEqual(expect.arrayContaining(['Unit empty / cleared', 'Latch / locking mechanism']))
  })
})
