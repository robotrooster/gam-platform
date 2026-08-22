/**
 * S616 (Nic) — what a unit may be rented for, and who decides.
 *
 * "Creating any sort of unit where they bring their own item, like a camp spot
 *  or an RV spot or a hotel room — those should all have short term stays by
 *  default. Anything that's designed to be lived in longer is longer term by
 *  default: mobile homes, apartments, single family homes. An operator has to
 *  go in and manually toggle that those units are available for short term
 *  stays... It should never be on by default except for RV sites, camping
 *  sites. Storage should not be short term, nightly, whatever. It's by the
 *  month lease."
 */
import { describe, it, expect } from 'vitest';
import { leaseTypesForUnitType, isShortStayByNature } from './index';

const short = (t: string, enabled = false) =>
  leaseTypesForUnitType(t, enabled).includes('nightly');

describe('short-stay by nature (S616)', () => {
  it('a site you bring your own rig to is nightly from day one', () => {
    expect(short('rv_spot')).toBe(true);
    expect(short('campsite')).toBe(true);
  });

  it('a hotel room is the stay', () => {
    expect(short('hotel_room')).toBe(true);
  });

  // S577, unchanged: a day's parking, a visiting boat, an event lot.
  it('parking, boat slips and land lots keep their short stays', () => {
    expect(short('parking')).toBe(true);
    expect(short('boat_slip')).toBe(true);
    expect(short('land_lot')).toBe(true);
  });
});

describe('somewhere a person LIVES is long-term until told otherwise (S616)', () => {
  // This is the bug that started it: all eight of Oak Park's mobile home spaces
  // were created bookable by the night because the create path said "nightly
  // unless short-stay-LOCKED", and only storage is locked.
  it('mobile homes, apartments, houses and commercial default to long-term', () => {
    for (const t of ['mobile_home', 'apartment', 'single_family', 'commercial']) {
      expect(short(t)).toBe(false);
      expect(leaseTypesForUnitType(t)).toEqual(['month_to_month', 'long_term']);
    }
  });

  it('but an operator CAN open them — they just have to say so', () => {
    for (const t of ['mobile_home', 'apartment', 'single_family', 'commercial']) {
      expect(short(t, true)).toBe(true);
      // Opting in ADDS short stays; it never removes the long-term option.
      expect(leaseTypesForUnitType(t, true)).toContain('month_to_month');
    }
  });

  it('none of them are short-stay by nature', () => {
    for (const t of ['mobile_home', 'apartment', 'single_family', 'commercial']) {
      expect(isShortStayByNature(t)).toBe(false);
    }
  });
});

describe('storage is by the month, whatever anyone toggles (S616)', () => {
  it('is never nightly, even opted in', () => {
    expect(short('storage')).toBe(false);
    expect(short('storage', true)).toBe(false);
    expect(leaseTypesForUnitType('storage', true)).toEqual(['month_to_month', 'long_term']);
  });
});

describe('an unknown type gets the conservative answer', () => {
  it('never the permissive one', () => {
    expect(short('something_new')).toBe(false);
    expect(leaseTypesForUnitType('something_new')).toEqual(['month_to_month', 'long_term']);
  });
});
