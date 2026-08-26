// S624 — what time is it at this property?
//
// Every property carried the column default `America/Phoenix`, because that is
// where the first ones were. The first out-of-state signup (an RV property in
// Hendersonville, North Carolina) landed on Arizona time — three hours wrong,
// and the late-fee engine runs on `NOW() AT TIME ZONE p.timezone`.
//
// ONE ZONE PER STATE, DELIBERATELY (Nic, S624).
//
// Fifteen states straddle a boundary, and an earlier cut of this file resolved
// them by ZIP — panhandles, El Paso, east Tennessee, the Navajo Nation. Nic
// killed it: "if it's only detecting when late fees go on and stuff like that,
// like, who's really likely to pay at midnight? It can be off by an hour. It's
// not a big deal. We'll address it in the future if it gets to that point where
// it's a real problem."
//
// He is right, and the arithmetic says so. Grace periods are measured in DAYS.
// An hour of drift only changes an outcome for a tenant paying within sixty
// minutes of local midnight on the last day of grace — and the error, when it
// happens, runs in the tenant's favour on a single day's fee. Against that: a
// ZIP table for fifteen states, wrong at the edges anyway (the boundary follows
// counties, not postal ranges), going stale silently, and prompting landlords to
// confirm something they neither know nor care about.
//
// So: state in, zone out. A landlord who is genuinely in the wrong hour sets it
// themselves, and `timezone_source = 'manual'` keeps that from ever being
// overwritten. That is the escape hatch, and it is the whole mechanism this
// needs until the problem is real.

/** The default every property used to get, regardless of where it was. */
export const FALLBACK_TIMEZONE = 'America/Phoenix'

/**
 * One IANA zone per state.
 *
 * For the fifteen states that split, this is the zone covering most of the
 * state's population — so the common case is right and the exception is a
 * landlord ticking a box.
 */
const STATE_TIMEZONE: Record<string, string> = {
  // Eastern
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York',
  GA: 'America/New_York', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', NH: 'America/New_York', NJ: 'America/New_York',
  NY: 'America/New_York', NC: 'America/New_York', OH: 'America/New_York',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  VT: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  // Split, resolved to the majority zone:
  FL: 'America/New_York',                 // panhandle is Central
  KY: 'America/New_York',                 // western Kentucky is Central
  MI: 'America/Detroit',                  // four western UP counties are Central
  IN: 'America/Indiana/Indianapolis',     // two corners are Central

  // Central
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago',
  IA: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', OK: 'America/Chicago',
  WI: 'America/Chicago',
  // Split, resolved to the majority zone:
  TX: 'America/Chicago',                  // El Paso and Hudspeth are Mountain
  TN: 'America/Chicago',                  // east Tennessee is Eastern
  KS: 'America/Chicago',                  // four western counties are Mountain
  NE: 'America/Chicago',                  // panhandle is Mountain
  ND: 'America/Chicago',                  // southwest is Mountain
  SD: 'America/Chicago',                  // west river is Mountain

  // Mountain
  CO: 'America/Denver', MT: 'America/Denver', NM: 'America/Denver',
  UT: 'America/Denver', WY: 'America/Denver',
  ID: 'America/Boise',                    // northern panhandle is Pacific
  // Arizona keeps Mountain Standard year-round. The Navajo Nation observes DST
  // and is therefore an hour out in summer; that is a box they tick.
  AZ: 'America/Phoenix',

  // Pacific and beyond
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  OR: 'America/Los_Angeles',              // Malheur County is Mountain
  NV: 'America/Los_Angeles',              // West Wendover is Mountain
  AK: 'America/Anchorage',                // far western Aleutians are Adak
  HI: 'Pacific/Honolulu',

  // Territories seen in US address forms.
  PR: 'America/Puerto_Rico', VI: 'America/St_Thomas', GU: 'Pacific/Guam',
}

/**
 * Resolve the IANA timezone for a property from its state.
 *
 * Never throws and never returns null: an unrecognised state falls back to the
 * old default, because a property with no clock at all is worse than one an hour
 * out. The landlord can always set it.
 */
export function timezoneForState(state: string | null | undefined): string {
  return STATE_TIMEZONE[String(state || '').trim().toUpperCase()] ?? FALLBACK_TIMEZONE
}

/** Human label for a zone, so no screen ever prints a raw IANA string. */
export function labelFor(timezone: string): string {
  return TIMEZONE_LABELS[timezone] ?? timezone.split('/').pop()!.replace(/_/g, ' ')
}

export const TIMEZONE_LABELS: Record<string, string> = {
  'America/New_York': 'Eastern time',
  'America/Detroit': 'Eastern time',
  'America/Indiana/Indianapolis': 'Eastern time',
  'America/Chicago': 'Central time',
  'America/Denver': 'Mountain time',
  'America/Boise': 'Mountain time',
  'America/Phoenix': 'Arizona time (no daylight saving)',
  'America/Los_Angeles': 'Pacific time',
  'America/Anchorage': 'Alaska time',
  'America/Adak': 'Hawaii–Aleutian time',
  'Pacific/Honolulu': 'Hawaii time (no daylight saving)',
  'America/Puerto_Rico': 'Atlantic time',
  'America/St_Thomas': 'Atlantic time',
  'Pacific/Guam': 'Chamorro time',
}

/** Every zone a landlord may pick, for the override dropdown. */
export const SELECTABLE_TIMEZONES = Object.keys(TIMEZONE_LABELS)
