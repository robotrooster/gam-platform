/**
 * Sales / demo scheduling (S553 engine, generalized S596).
 *
 * ONE slot engine serves multiple scheduling windows via a `kind`
 * discriminator on both sales_call_availability (which windows) and
 * sales_call_slots (which booking). Live today: 'demo' — the marketing
 * "Book a demo" flow AND Lucy's in-chat booking tool draw from the same
 * window and land on the same calendar. Reserved: 'onboarding' — post-signup
 * landlord walkthroughs get their own window; scheduling built later.
 *
 * Slots are cadence-spaced starts inside a kind's weekly availability windows,
 * next 14 days, minus already-booked starts of ANY kind (a single rep can't be
 * in two calls at once — the partial unique index on (starts_at) WHERE
 * status='booked' enforces it; a lost race surfaces as "that time was just
 * taken").
 *
 * Demo booking rules (Nic, S596):
 *   - Window: Mon-Fri 1:00-4:00 PM America/Phoenix (seeded in availability).
 *   - Cadence 30 min → six starts/day (1:00 .. 3:30); each held as a 20-min
 *     event so there's a 10-min gap between calls.
 *   - Lead buffer 1 hour: a slot drops once it's under an hour away.
 *   - Once a window has already started today, its slots roll to the next
 *     occurrence — no same-window, same-day bookings ("book during the window
 *     → next day"). Awareness never depends on the calendar-feed refresh lag
 *     because every booking also fires an instant heads-up email.
 *   - Video calls get a unique Jitsi room (self-hosted when the stack is live;
 *     public Jitsi until then — JITSI_BASE_URL is the single switch).
 *
 * Timezone: availability windows are in the business timezone. GAM runs on
 * America/Phoenix (no DST), so the UTC offset is a constant; both are
 * env-tunable (SALES_CALL_TZ for display, SALES_CALL_UTC_OFFSET for slot math).
 */

import { randomUUID } from 'crypto'
import type { SalesBookingKind } from '@gam/shared'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { sendSalesCallReminder } from './email'
import { sendDemoBookingConfirmation, sendDemoBookingHeadsUp } from './email'

const TZ = () => process.env.SALES_CALL_TZ || 'America/Phoenix'
const UTC_OFFSET = () => process.env.SALES_CALL_UTC_OFFSET || '-07:00'
const WINDOW_DAYS = 14

/** Per-kind scheduling policy. stepMinutes = slot cadence; eventMinutes = held
 *  calendar-event length (< step leaves a gap between calls). */
interface KindConfig {
  stepMinutes: number
  eventMinutes: number
  minNoticeMs: number
  mode: 'video' | 'phone'
}
const KIND_CONFIG: Record<SalesBookingKind, KindConfig> = {
  demo:       { stepMinutes: 30, eventMinutes: 20, minNoticeMs: 60 * 60_000, mode: 'video' },
  onboarding: { stepMinutes: 30, eventMinutes: 30, minNoticeMs: 60 * 60_000, mode: 'video' },
}

const JITSI_BASE = () => (process.env.JITSI_BASE_URL || 'https://meet.jit.si').replace(/\/$/, '')

/** Unique, unguessable Jitsi room per booking. The room name IS the access
 *  control (open-by-name), so it must be random — never derive it from the
 *  prospect's name or the slot time. Flips to meet.goldassetmanagement.com by
 *  setting JITSI_BASE_URL; no code change. */
function generateMeetingUrl(kind: SalesBookingKind): string {
  const slug = randomUUID().replace(/-/g, '')
  const prefix = kind === 'onboarding' ? 'gam-onboarding' : 'gam-demo'
  return `${JITSI_BASE()}/${prefix}-${slug}`
}

/** A calendar date (YYYY-MM-DD) + weekday in the business timezone. */
function businessDate(d: Date): { ymd: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: weekdays.indexOf(get('weekday')),
  }
}

// Format a slot for humans. `tz` (IANA, e.g. 'America/New_York') lets the
// prospect-facing copy read in THEIR local time; owner-facing copy passes
// nothing → America/Phoenix. A bad/unknown tz falls back to Phoenix rather
// than throwing (Intl throws on invalid timeZone).
export function formatSlotForHumans(iso: string, tz?: string | null): string {
  const zone = tz || TZ()
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone, weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(iso))
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TZ(), weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(iso))
  }
}

/** Event length (minutes) for a booking kind — used for the DTEND on the
 *  prospect's .ics and the subscribe feed. */
export function eventMinutesFor(kind: SalesBookingKind): number {
  return (KIND_CONFIG[kind] ?? KIND_CONFIG.demo).eventMinutes
}

export interface SlotDay {
  date: string      // YYYY-MM-DD in the business tz
  dayLabel: string  // e.g. "Mon, Aug 11"
  slots: { startsAt: string; timeLabel: string }[]
}

/** Group slot ISO starts into business-tz days for the picker UI. */
export function groupSlotsByDay(isos: string[]): SlotDay[] {
  const tz = TZ()
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
  const timeLabel = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
  const map = new Map<string, SlotDay>()
  for (const iso of isos) {
    const d = new Date(iso)
    const date = dayKey.format(d)
    if (!map.has(date)) map.set(date, { date, dayLabel: dayLabel.format(d), slots: [] })
    map.get(date)!.slots.push({ startsAt: iso, timeLabel: timeLabel.format(d) })
  }
  return [...map.values()]
}

/** Every bookable slot start (UTC ISO) for a kind, soonest first. */
export async function listAvailableSlots(kind: SalesBookingKind = 'demo'): Promise<string[]> {
  const cfg = KIND_CONFIG[kind] ?? KIND_CONFIG.demo
  const windows = await query<{ weekday: number; start_time: string; end_time: string }>(
    `SELECT weekday, start_time, end_time FROM sales_call_availability
      WHERE active AND kind = $1 ORDER BY weekday, start_time`,
    [kind]
  )
  if (windows.length === 0) return []

  const now = Date.now()
  const earliest = new Date(now + cfg.minNoticeMs)
  const horizon = new Date(now + WINDOW_DAYS * 86_400_000)
  // Exclude ALL booked starts (any kind) — one rep, one calendar.
  const booked = await query<{ starts_at: string }>(
    `SELECT starts_at FROM sales_call_slots
      WHERE status = 'booked' AND starts_at BETWEEN now() AND $1`,
    [horizon.toISOString()]
  )
  const taken = new Set(booked.map((b) => new Date(b.starts_at).getTime()))

  const slots: string[] = []
  for (let day = 0; day <= WINDOW_DAYS; day++) {
    const { ymd, weekday } = businessDate(new Date(now + day * 86_400_000))
    for (const w of windows.filter((x) => x.weekday === weekday)) {
      // Nic's rule: once a window has started (today), its slots roll to the
      // next occurrence — no same-window same-day bookings.
      const windowStart = new Date(`${ymd}T${w.start_time}${UTC_OFFSET()}`)
      if (windowStart.getTime() <= now) continue
      // times come back as 'HH:MM:SS'
      const [sh, sm] = w.start_time.split(':').map(Number)
      const [eh, em] = w.end_time.split(':').map(Number)
      for (let mins = sh * 60 + sm; mins + cfg.stepMinutes <= eh * 60 + em; mins += cfg.stepMinutes) {
        const hh = String(Math.floor(mins / 60)).padStart(2, '0')
        const mm = String(mins % 60).padStart(2, '0')
        const start = new Date(`${ymd}T${hh}:${mm}:00${UTC_OFFSET()}`)
        if (start < earliest || start > horizon || taken.has(start.getTime())) continue
        slots.push(start.toISOString())
      }
    }
  }
  return [...new Set(slots)].sort()
}

export interface BookCallInput {
  startsAt: string
  kind?: SalesBookingKind
  mode?: 'video' | 'phone'
  name: string
  email: string
  phone?: string | null
  /** the sales-chat conversation id, when booked through Lucy — links the
   *  slot to the captured lead */
  conversationId?: string | null
  notes?: string | null
  /** the prospect's IANA timezone (browser-detected) — prospect-facing copy
   *  reads in their local time; owner-facing copy stays Arizona */
  timezone?: string | null
  // Demo survey (all optional; captured into the lead for pre-call prep).
  propertyTypes?: string[]
  unitRange?: string | null
  painPoints?: string[]
  lookingFor?: string | null
}

export interface BookCallResult {
  ok: true
  slotId: string
  startsAt: string
  when: string
  meetingUrl: string | null
}

export async function bookSalesCall(
  input: BookCallInput
): Promise<BookCallResult | { ok: false; error: string }> {
  const kind = input.kind ?? 'demo'
  const cfg = KIND_CONFIG[kind] ?? KIND_CONFIG.demo
  const mode = input.mode ?? cfg.mode
  const startsAt = new Date(input.startsAt)
  if (isNaN(startsAt.getTime())) return { ok: false, error: 'That is not a valid time.' }
  // Re-validate availability + lead-time SERVER-SIDE — never trust the client.
  const available = await listAvailableSlots(kind)
  if (!available.includes(startsAt.toISOString()))
    return { ok: false, error: 'That time is not available — pick one of the offered slots.' }

  const lookingFor = input.lookingFor?.trim() || null
  const slotNotes = input.notes?.trim() || lookingFor
  const propertyType = input.propertyTypes?.length ? input.propertyTypes.join(', ') : null
  const surveyMeta: Record<string, unknown> = { booking_kind: kind }
  if (input.propertyTypes?.length) surveyMeta.property_types = input.propertyTypes
  if (input.painPoints?.length) surveyMeta.pain_points = input.painPoints
  if (input.unitRange) surveyMeta.unit_range = input.unitRange
  const source = kind === 'demo' ? 'demo_booking' : 'sales_agent'

  // Link (or create) the lead — by conversation first, then most-recent by
  // email, else a fresh lead so the booking always has a lead card. Survey
  // answers enrich the lead in every branch.
  let leadId: string | null = null
  if (input.conversationId) {
    const byConv = await queryOne<{ id: string }>(
      `SELECT id FROM sales_leads WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [input.conversationId])
    leadId = byConv?.id ?? null
  }
  if (!leadId) {
    const byEmail = await queryOne<{ id: string }>(
      `SELECT id FROM sales_leads WHERE lower(email) = lower($1) ORDER BY created_at DESC LIMIT 1`,
      [input.email])
    leadId = byEmail?.id ?? null
  }
  if (!leadId) {
    const created = await queryOne<{ id: string }>(
      `INSERT INTO sales_leads (conversation_id, name, email, phone, portfolio_size, property_type, notes, source, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'qualified', $9::jsonb) RETURNING id`,
      [input.conversationId ?? null, input.name, input.email, input.phone ?? null,
       input.unitRange ?? null, propertyType, lookingFor, source, JSON.stringify(surveyMeta)])
    leadId = created?.id ?? null
  } else {
    // Enrich without clobbering prior good data: COALESCE new-over-old, merge metadata.
    await query(
      `UPDATE sales_leads
          SET status = CASE WHEN status = 'new' THEN 'qualified' ELSE status END,
              portfolio_size = COALESCE($2, portfolio_size),
              property_type  = COALESCE($3, property_type),
              notes          = COALESCE($4, notes),
              metadata       = metadata || $5::jsonb,
              updated_at     = now()
        WHERE id = $1`,
      [leadId, input.unitRange ?? null, propertyType, lookingFor, JSON.stringify(surveyMeta)])
  }

  const meetingUrl = mode === 'video' ? generateMeetingUrl(kind) : null

  let slotId: string
  try {
    const ins = await queryOne<{ id: string }>(
      `INSERT INTO sales_call_slots
         (lead_id, starts_at, duration_minutes, kind, mode, prospect_name, prospect_email, prospect_phone, notes, meeting_url, prospect_timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [leadId, startsAt.toISOString(), cfg.eventMinutes, kind, mode,
       input.name, input.email, input.phone ?? null, slotNotes, meetingUrl, input.timezone ?? null])
    slotId = ins!.id
  } catch (e: any) {
    if (e?.code === '23505') return { ok: false, error: 'That time was just taken — pick another slot.' }
    throw e
  }

  // Owner-facing copy stays Arizona; prospect-facing copy reads in their tz.
  const whenOwner = formatSlotForHumans(startsAt.toISOString())
  const whenProspect = formatSlotForHumans(startsAt.toISOString(), input.timezone)

  // Prospect confirmation (with .ics + join link) — best-effort, never blocks.
  await sendDemoBookingConfirmation({
    to: input.email, name: input.name, when: whenProspect, slotId,
    startsAt: startsAt.toISOString(), durationMinutes: cfg.eventMinutes,
    meetingUrl, kind,
  }).catch((err) => logger.error({ err, slotId }, '[sales-call] confirmation email failed'))

  // Instant owner heads-up so awareness never waits on the calendar refresh.
  await sendDemoBookingHeadsUp({
    name: input.name, email: input.email, phone: input.phone ?? null, when: whenOwner,
    meetingUrl, kind, timezone: input.timezone ?? null,
    propertyTypes: input.propertyTypes ?? [], unitRange: input.unitRange ?? null,
    painPoints: input.painPoints ?? [], lookingFor,
  }).catch((err) => logger.error({ err, slotId }, '[sales-call] heads-up email failed'))

  // Durable admin record (admin portal Sales Calls list).
  try {
    await query(
      `INSERT INTO admin_notifications (severity, category, title, body, context)
       VALUES ('info', 'sales_call', $1, $2, $3::jsonb)`,
      [
        `Demo booked: ${input.name}`,
        `${whenOwner} · ${input.email}${input.unitRange ? ` · ${input.unitRange} units` : ''}`,
        JSON.stringify({ slotId, leadId, kind, startsAt: startsAt.toISOString(), mode, meetingUrl, prospectTimezone: input.timezone ?? null }),
      ])
  } catch (e) {
    logger.error({ err: e, slotId }, '[sales-call] admin notify failed')
  }
  // Return the prospect-local time — the modal's confirmation screen shows it.
  return { ok: true, slotId, startsAt: startsAt.toISOString(), when: whenProspect, meetingUrl }
}

/** Cron: remind prospects ~1h ahead. Idempotent via reminded_at. */
export async function sendDueCallReminders(): Promise<{ sent: number }> {
  const due = await query<any>(
    `SELECT id, prospect_name, prospect_email, mode, starts_at, prospect_timezone
       FROM sales_call_slots
      WHERE status = 'booked' AND reminded_at IS NULL
        AND starts_at BETWEEN now() AND now() + interval '65 minutes'`
  )
  let sent = 0
  for (const s of due) {
    if (s.prospect_email) {
      await sendSalesCallReminder({
        to: s.prospect_email, name: s.prospect_name ?? '',
        when: formatSlotForHumans(s.starts_at, s.prospect_timezone), mode: s.mode,
      }).catch((err) => logger.error({ err, slotId: s.id }, '[sales-call] reminder email failed'))
    }
    await query(`UPDATE sales_call_slots SET reminded_at = now(), updated_at = now() WHERE id = $1`, [s.id])
    sent++
  }
  return { sent }
}
