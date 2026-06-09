/**
 * Tool: get_my_landlord_patterns (tenant read).
 *
 * Transparency for the tenant (Nic S442): summarizes how the tenant's OWN
 * landlord actually operates toward their unit — how often entries/inspections
 * happen, the time of day they're usually scheduled (in the property's local
 * time), and the typical advance notice — so the tenant can plan (e.g. take a
 * day off). It also flags OBJECTIVELY odd-hour entries (a midnight inspection)
 * factually. This is the tenant's own relationship data (entries into THEIR
 * unit), hard-scoped to actor.profileId — not private, not cross-tenant, not a
 * comparison to other landlords. No legal interpretation: an odd-hour flag
 * states the time + that entry laws commonly require "reasonable times," and
 * points the tenant to check their local law / consult an attorney.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface EntryRow {
  reason_category: string
  local_hour: number
  notice_window_hours: number | null
  ymd: string
  local_at: string
}

const ACTIVITY: Record<string, string> = {
  inspection: 'Inspections',
  maintenance: 'Maintenance visits',
  showing: 'Showings',
  emergency: 'Emergency entries',
  other: 'Other entries',
}

function fmtHour(h: number): string {
  const hr = ((Math.round(h) % 24) + 24) % 24
  const ap = hr < 12 ? 'am' : 'pm'
  const h12 = hr % 12 === 0 ? 12 : hr % 12
  return `${h12}${ap}`
}
function fmtInterval(days: number): string {
  if (days <= 0) return ''
  if (days <= 10) return `about every ${Math.round(days)} days`
  if (days <= 21) return 'about every couple of weeks'
  if (days <= 45) return 'about once a month'
  if (days <= 75) return 'about every 6 weeks'
  const months = Math.round(days / 30)
  if (months <= 11) return `about every ${months} months`
  const years = Math.max(1, Math.round(days / 365))
  return years === 1 ? 'about once a year' : `about every ${years} years`
}
function fmtNotice(hours: number): string {
  if (hours < 24) return `about ${Math.round(hours)} hours`
  const days = Math.round(hours / 24)
  return days <= 1 ? 'about a day' : `about ${days} days`
}

export const getMyLandlordPatterns: AgentTool = {
  name: 'get_my_landlord_patterns',
  description:
    'Summarize how the tenant’s own landlord usually operates — how often they enter or inspect, the ' +
    'time of day they typically schedule it, and how much notice they usually give — from this ' +
    'tenant’s own entry history, in the property’s local time. Use for “when does my landlord usually ' +
    'inspect?”, “how much notice do I usually get?”, or to help the tenant plan time off. Also flags ' +
    'any entry scheduled at an unusual hour. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    const rows = await query<EntryRow>(
      `SELECT er.reason_category,
              EXTRACT(HOUR FROM (er.proposed_entry_window_start AT TIME ZONE p.timezone))::int AS local_hour,
              er.notice_window_hours,
              to_char(er.proposed_entry_window_start AT TIME ZONE p.timezone, 'YYYY-MM-DD') AS ymd,
              to_char(er.proposed_entry_window_start AT TIME ZONE p.timezone, 'Mon DD, YYYY at HH12:MIam') AS local_at
         FROM unit_entry_requests er
         JOIN units u ON u.id = er.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE er.tenant_id = $1 AND er.proposed_entry_window_start IS NOT NULL
        ORDER BY er.proposed_entry_window_start`,
      [actor.profileId]
    )

    if (rows.length === 0) {
      return { ok: true, basedOnEntries: 0, note: 'No entries by your landlord are on record yet, so there’s no pattern to show.' }
    }

    // Per-category pattern.
    const byCat = new Map<string, EntryRow[]>()
    for (const r of rows) {
      const k = r.reason_category || 'other'
      if (!byCat.has(k)) byCat.set(k, [])
      byCat.get(k)!.push(r)
    }

    const patterns = [...byCat.entries()].map(([cat, list]) => {
      const hours = list.map((r) => r.local_hour).filter((h) => Number.isFinite(h))
      const notices = list.map((r) => r.notice_window_hours).filter((n): n is number => n != null)
      const dates = list.map((r) => Date.parse(r.ymd)).filter((d) => !Number.isNaN(d)).sort((a, b) => a - b)
      let howOften: string | undefined
      if (dates.length >= 2) {
        const spanDays = (dates[dates.length - 1] - dates[0]) / 86400000
        howOften = fmtInterval(spanDays / (dates.length - 1))
      }
      const usualTime = hours.length
        ? (Math.min(...hours) === Math.max(...hours) ? `around ${fmtHour(hours[0])}` : `${fmtHour(Math.min(...hours))}–${fmtHour(Math.max(...hours))}`)
        : undefined
      const usualNotice = notices.length ? fmtNotice(notices.reduce((a, b) => a + b, 0) / notices.length) : undefined
      return { activity: ACTIVITY[cat] ?? cat, count: list.length, howOften, usualTime, usualNotice }
    })

    // Objective odd-hour flags (before 8am or 8pm-or-later, local time).
    const flags = rows
      .filter((r) => Number.isFinite(r.local_hour) && (r.local_hour < 8 || r.local_hour >= 20))
      .map((r) => `An entry was scheduled for ${r.local_at} — outside typical daytime hours (8am–8pm). Entry laws commonly require entry at "reasonable times," so you may want to check your local law or ask your landlord about it.`)

    return {
      ok: true,
      basedOnEntries: rows.length,
      patterns,
      flags: flags.length ? flags : undefined,
      note: 'Based on your own entry history — this helps you anticipate, but your landlord may change their schedule. Times are in your property’s local time.',
    }
  },
}
