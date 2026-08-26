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

// ── S622: a signed document must never fail to become a lease ───────
//
// Found by driving a real signing run end to end on production: everyone
// signed, the document completed, and the lease INSERT threw
// leases_lease_type_check — because a radio's options are the words the LEASE
// prints ("FIXED TERM", "MONTH-TO-MONTH TERM") and they were written into a
// CHECK-constrained column verbatim. The document is the wrong place to demand
// machine values; the lease says what it says.
import { normaliseLeaseType, normaliseAutoRenewMode, autoRenewFromElection, WRITABLE_LEASE_COLUMN_SPECS, FEE_ROW_SPECS } from './index'

const LEASE_TYPE_ALLOWED = ['month_to_month', 'fixed_term', 'nnn_commercial']
const MODE_ALLOWED = ['extend_same_term', 'convert_to_month_to_month']

describe('S622 lease-type normalisation', () => {
  it('accepts the wording Oak Park’s lease actually prints', () => {
    expect(normaliseLeaseType('FIXED TERM')).toBe('fixed_term')
    expect(normaliseLeaseType('MONTH-TO-MONTH TERM')).toBe('month_to_month')
  })

  it('handles the ways other leases phrase it', () => {
    expect(normaliseLeaseType('Month to Month')).toBe('month_to_month')
    expect(normaliseLeaseType('month–to–month tenancy')).toBe('month_to_month')
    expect(normaliseLeaseType('Fixed term')).toBe('fixed_term')
    expect(normaliseLeaseType('NNN Commercial')).toBe('nnn_commercial')
  })

  it('NEVER produces a value the column would refuse', () => {
    for (const junk of ['', '   ', 'anything at all', 'Option 1', null, undefined])
      expect(LEASE_TYPE_ALLOWED).toContain(normaliseLeaseType(junk as any))
  })

  it('the parser itself cannot emit an illegal lease_type', () => {
    for (const raw of ['FIXED TERM', 'MONTH-TO-MONTH TERM', 'nonsense', ''])
      expect(LEASE_TYPE_ALLOWED).toContain(
        (WRITABLE_LEASE_COLUMN_SPECS as any).lease_type.parse({ lease_type: raw, end_date: '2027-08-31' }).lease_type)
  })
})

describe('S622 end-of-term election', () => {
  it('“Must vacate” means the lease does NOT renew', () => {
    expect(autoRenewFromElection('Must vacate the Premises')).toBe(false)
    const out = (WRITABLE_LEASE_COLUMN_SPECS as any).auto_renew.parse({ auto_renew_mode: 'Must vacate the Premises' })
    expect(out.auto_renew).toBe(false)
  })

  it('“May continue…month-to-month” means it does, and says how', () => {
    expect(autoRenewFromElection('May continue to rent the Premises under a month-to-month')).toBe(true)
    const ar = (WRITABLE_LEASE_COLUMN_SPECS as any).auto_renew.parse({ auto_renew_mode: 'May continue to rent the Premises under a month-to-month' })
    expect(ar.auto_renew).toBe(true)
    const m = (WRITABLE_LEASE_COLUMN_SPECS as any).auto_renew_mode.parse({ auto_renew_mode: 'May continue to rent the Premises under a month-to-month' })
    expect(m.auto_renew_mode).toBe('convert_to_month_to_month')
  })

  it('never emits a mode the column would refuse, and none at all when it does not renew', () => {
    for (const raw of ['Must vacate the Premises', 'anything', ''])
      {
        const m = (WRITABLE_LEASE_COLUMN_SPECS as any).auto_renew_mode.parse({ auto_renew_mode: raw }).auto_renew_mode
        if (m !== null) expect(MODE_ALLOWED).toContain(m)
      }
    expect(normaliseAutoRenewMode('extend for another year')).toBe('extend_same_term')
  })
})

// ── S622: "N/A" is what the system ASKS FOR on a fee that does not apply ──
//
// The landlord's signing pass requires every value-bearing tagged field and
// tells them "N/A" and "0" are valid for ones that don't apply (S535). That
// string then reached lease_fees.amount — numeric(12,2) — and the INSERT threw
// `invalid input syntax for type numeric: "N/A"` AFTER everyone had signed.
// Found by driving a real signing run: a template with pet fields, and no pets.
describe('S622 money on a signed document', () => {
  const feeRow = (tag: string, raw: string) =>
    (FEE_ROW_SPECS as any)[tag].parse({ [tag]: raw })

  it('a fee marked N/A becomes NO FEE, not a broken row', () => {
    for (const raw of ['N/A', 'n/a', 'None', 'none', '-', '--', '', '  ', '0', '0.00'])
      expect(feeRow('pet_deposit', raw), `"${raw}" should mean no fee`).toBeNull()
  })

  it('a real fee still bills, currency formatting and all', () => {
    expect(feeRow('pet_deposit', '500')?.amount).toBe('500')
    expect(feeRow('pet_fee', '$250.00')?.amount).toBe('250')
    expect(feeRow('last_month_rent', '$1,125.50')?.amount).toBe('1125.5')
  })

  it('every fee type survives an N/A without producing a row', () => {
    for (const tag of Object.keys(FEE_ROW_SPECS as any))
      expect((FEE_ROW_SPECS as any)[tag].parse({ [tag]: 'N/A' }), tag).toBeNull()
  })

  it('rent that is not an amount fails LOUDLY, not as a database error', () => {
    const parse = (WRITABLE_LEASE_COLUMN_SPECS as any).rent_amount.parse
    expect(() => parse({ rent_amount: 'N/A' })).toThrow(/Invalid rent_amount/)
    expect(parse({ rent_amount: '$1,250.00' }).rent_amount).toBe('1250')
  })
})
