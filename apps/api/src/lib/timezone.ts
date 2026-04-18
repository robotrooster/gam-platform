// State → IANA timezone. Default for activation scheduling.
// For states with multiple zones (IN, TN, KY, ND, SD, NE, KS, TX, FL, MI, OR, ID),
// we pick the majority zone. Edge counties will be slightly off; good enough for
// activation scheduling (not used for anything legally sensitive).

const STATE_TZ: Record<string,string> = {
  AL: 'America/Chicago',     AK: 'America/Anchorage',   AZ: 'America/Phoenix',
  AR: 'America/Chicago',     CA: 'America/Los_Angeles', CO: 'America/Denver',
  CT: 'America/New_York',    DE: 'America/New_York',    DC: 'America/New_York',
  FL: 'America/New_York',    GA: 'America/New_York',    HI: 'Pacific/Honolulu',
  ID: 'America/Boise',       IL: 'America/Chicago',     IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',     KS: 'America/Chicago',     KY: 'America/New_York',
  LA: 'America/Chicago',     ME: 'America/New_York',    MD: 'America/New_York',
  MA: 'America/New_York',    MI: 'America/Detroit',     MN: 'America/Chicago',
  MS: 'America/Chicago',     MO: 'America/Chicago',     MT: 'America/Denver',
  NE: 'America/Chicago',     NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York',    NM: 'America/Denver',      NY: 'America/New_York',
  NC: 'America/New_York',    ND: 'America/Chicago',     OH: 'America/New_York',
  OK: 'America/Chicago',     OR: 'America/Los_Angeles', PA: 'America/New_York',
  RI: 'America/New_York',    SC: 'America/New_York',    SD: 'America/Chicago',
  TN: 'America/Chicago',     TX: 'America/Chicago',     UT: 'America/Denver',
  VT: 'America/New_York',    VA: 'America/New_York',    WA: 'America/Los_Angeles',
  WV: 'America/New_York',    WI: 'America/Chicago',     WY: 'America/Denver',
  PR: 'America/Puerto_Rico', VI: 'America/St_Thomas',
  GU: 'Pacific/Guam',        AS: 'Pacific/Pago_Pago',   MP: 'Pacific/Saipan',
}

export function tzForState(state: string): string {
  const s = (state || '').toUpperCase().trim()
  return STATE_TZ[s] || 'America/Phoenix'  // safe default for GAM's Arizona-centric base
}

// Convenience: is `whenUtc` in the past relative to the property's local time?
// Since Date.prototype.getTime() is absolute UTC, and we store scheduled_activation_at
// in UTC, a plain now >= when comparison is correct regardless of tz.
// The tz lookup matters for DISPLAYING the time to the landlord and for the UI to
// compose the correct UTC instant from landlord's picked local date+time.
export function localDateTimeToUtc(localISO: string, tz: string): Date {
  // localISO is like "2026-05-01T09:00:00" (no tz suffix). We interpret it as local-to-tz.
  // Node's built-in Intl handles tz offsets cleanly.
  const d = new Date(localISO)
  if (isNaN(d.getTime())) return new Date(NaN)
  // Get the offset of this local moment in the target tz
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
  const parts = fmt.formatToParts(d).find(p => p.type === 'timeZoneName')?.value || 'GMT+00:00'
  const m = parts.match(/GMT([+-])(\d{1,2}):?(\d{2})?/)
  if (!m) return d
  const sign = m[1] === '-' ? -1 : 1
  const hours = parseInt(m[2], 10)
  const mins  = parseInt(m[3] || '0', 10)
  const offsetMin = sign * (hours * 60 + mins)
  // localISO reads as if UTC; subtract the tz offset to get true UTC
  const asUTC = new Date(localISO + 'Z')
  return new Date(asUTC.getTime() - offsetMin * 60 * 1000)
}
