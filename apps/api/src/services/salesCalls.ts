/**
 * Sales-call scheduling (S553) — the Portfolio Specialist call funnel.
 *
 * One shared service used by the public booking route AND Lucy's booking
 * tool (S552 pattern: both paths identical). Slots are 30-minute starts
 * inside the Specialist's weekly availability windows, next 14 days,
 * minimum 2h notice, minus already-booked starts. Booking is race-safe via
 * the partial unique index on (starts_at) WHERE status='booked' — a lost
 * race surfaces as "that time was just taken".
 *
 * Timezone: availability windows are in the business timezone. GAM runs on
 * America/Phoenix (no DST), so the UTC offset is a constant; both are
 * env-tunable (SALES_CALL_TZ for display, SALES_CALL_UTC_OFFSET for slot
 * math) if that ever changes.
 */

import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { sendSalesCallConfirmation, sendSalesCallReminder } from './email'

const TZ = () => process.env.SALES_CALL_TZ || 'America/Phoenix'
const UTC_OFFSET = () => process.env.SALES_CALL_UTC_OFFSET || '-07:00'
const SLOT_MINUTES = 30
const MIN_NOTICE_MS = 2 * 3600_000
const WINDOW_DAYS = 14

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

export function formatSlotForHumans(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ(), weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso))
}

/** Every bookable slot start (UTC ISO), soonest first. */
export async function listAvailableSlots(): Promise<string[]> {
  const windows = await query<{ weekday: number; start_time: string; end_time: string }>(
    `SELECT weekday, start_time, end_time FROM sales_call_availability WHERE active ORDER BY weekday, start_time`
  )
  if (windows.length === 0) return []

  const earliest = new Date(Date.now() + MIN_NOTICE_MS)
  const horizon = new Date(Date.now() + WINDOW_DAYS * 86_400_000)
  const booked = await query<{ starts_at: string }>(
    `SELECT starts_at FROM sales_call_slots
      WHERE status = 'booked' AND starts_at BETWEEN now() AND $1`,
    [horizon.toISOString()]
  )
  const taken = new Set(booked.map((b) => new Date(b.starts_at).getTime()))

  const slots: string[] = []
  for (let day = 0; day <= WINDOW_DAYS; day++) {
    const { ymd, weekday } = businessDate(new Date(Date.now() + day * 86_400_000))
    for (const w of windows.filter((x) => x.weekday === weekday)) {
      // times come back as 'HH:MM:SS'
      const [sh, sm] = w.start_time.split(':').map(Number)
      const [eh, em] = w.end_time.split(':').map(Number)
      for (let mins = sh * 60 + sm; mins + SLOT_MINUTES <= eh * 60 + em; mins += SLOT_MINUTES) {
        const hh = String(Math.floor(mins / 60)).padStart(2, '0')
        const mm = String(mins % 60).padStart(2, '0')
        const start = new Date(`${ymd}T${hh}:${mm}:00${UTC_OFFSET()}`)
        if (start < earliest || start > horizon || taken.has(start.getTime())) continue
        slots.push(start.toISOString())
      }
    }
  }
  return slots.sort()
}

export interface BookCallInput {
  startsAt: string
  mode: 'video' | 'phone'
  name: string
  email: string
  phone?: string | null
  /** the sales-chat conversation id, when booked through Lucy — links the
   *  slot to the captured lead */
  conversationId?: string | null
  notes?: string | null
}

export async function bookSalesCall(input: BookCallInput): Promise<
  { ok: true; slotId: string; startsAt: string; when: string } | { ok: false; error: string }
> {
  const startsAt = new Date(input.startsAt)
  if (isNaN(startsAt.getTime())) return { ok: false, error: 'That is not a valid time.' }
  const available = await listAvailableSlots()
  if (!available.includes(startsAt.toISOString()))
    return { ok: false, error: 'That time is not available — pick one of the offered slots.' }

  // Link (or create) the lead: by conversation first, then most-recent by
  // email, else a fresh lead so the call always has a lead card.
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
      `INSERT INTO sales_leads (conversation_id, name, email, phone, notes, status)
       VALUES ($1, $2, $3, $4, $5, 'qualified') RETURNING id`,
      [input.conversationId ?? null, input.name, input.email, input.phone ?? null, input.notes ?? null])
    leadId = created?.id ?? null
  } else {
    await query(`UPDATE sales_leads SET status = 'qualified', updated_at = now() WHERE id = $1 AND status = 'new'`, [leadId])
  }

  let slotId: string
  try {
    const ins = await queryOne<{ id: string }>(
      `INSERT INTO sales_call_slots (lead_id, starts_at, mode, prospect_name, prospect_email, prospect_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [leadId, startsAt.toISOString(), input.mode, input.name, input.email, input.phone ?? null, input.notes ?? null])
    slotId = ins!.id
  } catch (e: any) {
    if (e?.code === '23505') return { ok: false, error: 'That time was just taken — pick another slot.' }
    throw e
  }

  const when = formatSlotForHumans(startsAt.toISOString())
  await sendSalesCallConfirmation({
    to: input.email, name: input.name, when, mode: input.mode,
  }).catch((err) => logger.error({ err, slotId }, '[sales-call] confirmation email failed'))
  try {
    await query(
      `INSERT INTO admin_notifications (severity, category, title, body, context)
       VALUES ('info', 'sales_call', $1, $2, $3::jsonb)`,
      [
        `Sales call booked: ${input.name}`,
        `${when} · ${input.mode} · ${input.email}`,
        JSON.stringify({ slotId, leadId, startsAt: startsAt.toISOString(), mode: input.mode }),
      ])
  } catch (e) {
    logger.error({ err: e, slotId }, '[sales-call] admin notify failed')
  }
  return { ok: true, slotId, startsAt: startsAt.toISOString(), when }
}

/** Cron: remind prospects ~1h ahead. Idempotent via reminded_at. */
export async function sendDueCallReminders(): Promise<{ sent: number }> {
  const due = await query<any>(
    `SELECT id, prospect_name, prospect_email, mode, starts_at
       FROM sales_call_slots
      WHERE status = 'booked' AND reminded_at IS NULL
        AND starts_at BETWEEN now() AND now() + interval '65 minutes'`
  )
  let sent = 0
  for (const s of due) {
    if (s.prospect_email) {
      await sendSalesCallReminder({
        to: s.prospect_email, name: s.prospect_name ?? '',
        when: formatSlotForHumans(s.starts_at), mode: s.mode,
      }).catch((err) => logger.error({ err, slotId: s.id }, '[sales-call] reminder email failed'))
    }
    await query(`UPDATE sales_call_slots SET reminded_at = now(), updated_at = now() WHERE id = $1`, [s.id])
    sent++
  }
  return { sent }
}
