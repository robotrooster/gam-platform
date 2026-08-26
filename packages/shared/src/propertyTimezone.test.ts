import { describe, it, expect } from 'vitest'
import { timezoneForState, labelFor, FALLBACK_TIMEZONE } from './propertyTimezone'

describe('a property gets its own state’s clock', () => {
  it('resolves the ordinary cases', () => {
    // The signup that started this: an RV property in Hendersonville, NC, which
    // had been sitting on Arizona time.
    expect(timezoneForState('NC')).toBe('America/New_York')
    expect(timezoneForState('CA')).toBe('America/Los_Angeles')
    expect(timezoneForState('AZ')).toBe('America/Phoenix')
    expect(timezoneForState('HI')).toBe('Pacific/Honolulu')
  })

  it('does not care how the state arrives', () => {
    expect(timezoneForState('nc')).toBe('America/New_York')
    expect(timezoneForState(' NC ')).toBe('America/New_York')
  })

  // Nic (S624): "just leave at one thing per state. It can be off by an hour.
  // It's not a big deal." A split state resolves to its majority zone — the
  // exception is a landlord ticking a box, not a ZIP table going stale.
  it('gives a split state its majority zone, and only that', () => {
    expect(timezoneForState('TX')).toBe('America/Chicago')   // not El Paso's Mountain
    expect(timezoneForState('TN')).toBe('America/Chicago')   // not Knoxville's Eastern
    expect(timezoneForState('FL')).toBe('America/New_York')  // not the panhandle's Central
    expect(timezoneForState('ID')).toBe('America/Boise')     // not the panhandle's Pacific
  })

  it('falls back rather than leaving a property with no clock', () => {
    expect(timezoneForState('ZZ')).toBe(FALLBACK_TIMEZONE)
    expect(timezoneForState(null)).toBe(FALLBACK_TIMEZONE)
    expect(timezoneForState('')).toBe(FALLBACK_TIMEZONE)
  })

  it('covers every state and territory an address form can produce', () => {
    const all = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID',
      'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE',
      'NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN',
      'TX','UT','VT','VA','WA','WV','WI','WY','PR','VI','GU']
    for (const st of all) {
      // No state may silently take the Arizona fallback — that is the bug this
      // whole thing exists to fix.
      expect(timezoneForState(st), `${st} has no timezone`).not.toBe(undefined)
      if (st !== 'AZ') {
        expect(timezoneForState(st), `${st} fell back to Arizona`).not.toBe(FALLBACK_TIMEZONE)
      }
    }
  })
})

describe('labels', () => {
  it('never makes a screen print a raw IANA string', () => {
    expect(labelFor('America/New_York')).toBe('Eastern time')
    expect(labelFor('America/Phoenix')).toContain('no daylight saving')
    expect(labelFor('America/Nowhere')).toBe('Nowhere')
  })
})
