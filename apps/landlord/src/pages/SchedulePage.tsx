import { useState, useRef, useEffect, useMemo, useLayoutEffect } from 'react'
import { useUrlTab } from '../lib/useUrlTab'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Search, FileSignature, CheckCircle2, AlertTriangle, MessageSquare, Check, X, QrCode, Copy, Mail, Ban } from 'lucide-react'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { UNIT_TYPES, UNIT_TYPE_LABEL, humanize, priceStay, stayLowerRateWords, stayNightsBetween, addStayDays, addCalendarMonths, rvSiteFactsLabel, RV_SITE_LAYOUTS, RV_SITE_LAYOUT_LABEL, isSiteLayoutMismatch, RV_AMP_SERVICES, RV_AMP_SERVICE_LABEL, isAmpServiceMismatch, isRigTooLongForSite, MAX_RIG_LENGTH_FT, BOOKING_CHANGE_REQUEST_TYPE_LABEL, type BookingChangeRequestType, BOOKING_STATUSES, BOOKING_STATUS_LABEL, BOOKING_SOURCES, BOOKING_SOURCE_LABEL, stayHoldWords, stayDepositAsk, type BookingStatus, type BookingSource, camelizeKeys, STAY_TERMS, STAY_TERMS_LABEL, type StayTerms, longCalendarDate, typingPhone } from '@gam/shared'
import { toast, appConfirm, appPrompt, appChoose } from '../components/dialogs'
import { pastEndChoices, pastEndQuestion } from '../lib/earlyCheckOut'
import { RequiredPropertySelect, usePropertyScope } from '../components/ListControls'
import { OutOfOrderModal } from './OutOfOrderModal'
import { EarlyCheckOutModal } from '../components/EarlyCheckOutModal'
import { WorkTradeTermsFields, defaultWorkTradeTerms, workTradeTermsPayload, workTradeTermsFrom, workTradeLine, workTradeEditPayload, type WorkTradeTerms } from '../components/WorkTradeTermsFields'
import { ReturningGuestChoice, useReturningGuestOffer, RETURNING_GUEST_WORDS, RETURNING_GUEST_DETAIL, type ReturningOffer } from '../components/ReturningGuestChoice'
import { NeverMovedInBody, type NeverMovedInPreview, refreshAfterLeaseClose } from './LeasesPage'
import { ReservationImportModal, MIGRATED_DOOR_LABEL, stayLockWords } from './ReservationImport'
import { sentence } from '../lib/meterReadToast'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

// S547: the public site is the per-property storefront — path-slug in dev,
// {slug}.gam.biz subdomain in prod (mirrors the API's STOREFRONT_URL_TEMPLATE).
// S574: explicit env override wins; else localhost → dev path, any real host →
// prod subdomain, so the link is right in prod without a build-time env var.
const STOREFRONT_TEMPLATE = (import.meta as any).env?.VITE_STOREFRONT_URL_TEMPLATE
  || (typeof location !== 'undefined' && /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)
        ? 'http://localhost:3015/{slug}'
        : 'https://{slug}.gam.biz')
const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

// S535 pattern (see UnitDetailPage): authed photo files can't ride an <img>
// tag — fetch with the Bearer token, render via a blob object-URL.
function AuthThumb({ url, h = 90 }: { url: string; h?: number }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    const token = localStorage.getItem('gam_token') || ''
    fetch(`${API_URL}/api${url}`, { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.ok ? r.blob() : null)
      .then(b => {
        if (!b || cancelled) return
        objectUrl = URL.createObjectURL(b)
        setSrc(objectUrl)
      })
      .catch(() => {})
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url])
  if (!src) return <div style={{ width: '100%', height: h, background: 'var(--bg-2)', borderRadius: 8 }} />
  return <img src={src} alt="" style={{ width: '100%', height: h, objectFit: 'cover', borderRadius: 8, display: 'block' }} />
}

const UNIT_TYPE_LABELS: Record<string,string> = {
  residential:'🏠 Residential', rv_spot:'🚐 RV Spot', storage:'📦 Storage',
  parking:'🅿️ Parking', short_term_cabin:'🏕️ Short-Term Cabin'
}
const LEASE_TYPE_LABELS: Record<string,string> = {
  nightly:'Nightly', weekly:'Weekly', month_to_month:'Month-to-Month', long_term:'Long Term'
}
const TYPE_COLORS: Record<string,string> = {
  residential:'var(--blue)', rv_spot:'var(--green)', storage:'var(--amber)',
  parking:'var(--text-3)', short_term_cabin:'var(--gold)'
}
const STATUS_COLORS: Record<string,string> = {
  confirmed:'badge-green', pending:'badge-amber', cancelled:'badge-red', checked_in:'badge-blue'
}

function getDaysInRange(from: string, to: string) {
  const days = []
  const cur = new Date(from + 'T12:00:00')
  const end = new Date(to + 'T12:00:00')
  while (cur <= end) {
    days.push(cur.toISOString().split('T')[0])
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

// Date-only "YYYY-MM-DD". Bookings/leases come back as full ISO timestamps
// (check_in = "2026-06-20T00:00:00.000Z"); slicing keeps the date math (which
// appends T12:00:00) from producing an Invalid Date.
const dayOnly = (s: any) => String(s ?? '').slice(0, 10)
// A reservation's status in the schedule's own words (packages/shared).
const bookingStatusWords = (s: string) => BOOKING_STATUS_LABEL[s as BookingStatus] ?? humanize(s)
// The sticky Unit column. ONE width, used by the header cell, the table, the
// floating names and the keyboard pan — it was written as a bare 180/184 in
// five places. 200 since S652: at 180 "RV 08" wrapped under the "RV" while
// "RV 11" (narrower digits) did not, so two sites looked different for no reason.
const UNIT_COL_W = 200
// Where a floating reservation name pins: just inside the timeline's left edge.
const STICKY_LEFT = 4

// W-22: which unit types rent by the stay (rates/min-stay/bookability apply).
// Storage + commercial rent by lease only.
const STAY_CAPABLE_TYPES = ['rv_spot', 'apartment', 'single_family', 'mobile_home', 'residential']
// W-24: amenity chip presets per unit type; anything custom via "Add your own".
const AMENITY_PRESETS: Record<string, string[]> = {
  rv_spot: ['Water hookup', 'Sewer hookup', 'Electric 30A', 'Electric 50A', 'WiFi', 'Cable TV', 'Picnic table', 'Fire pit', 'Shade', 'Concrete pad'],
  apartment: ['WiFi', 'Washer/Dryer', 'Dishwasher', 'A/C', 'Heating', 'Parking', 'Balcony', 'Furnished', 'Pets allowed'],
  single_family: ['WiFi', 'Washer/Dryer', 'Dishwasher', 'A/C', 'Heating', 'Garage', 'Yard', 'Furnished', 'Pets allowed'],
  mobile_home: ['WiFi', 'Washer/Dryer', 'A/C', 'Heating', 'Parking', 'Furnished', 'Pets allowed', 'Deck'],
  storage: ['Climate controlled', 'Drive-up access', '24/7 access', 'Lighting', 'Power outlet'],
  commercial: ['Restroom', 'HVAC', 'Signage', 'Parking', 'Loading dock', 'ADA accessible'],
  default: ['WiFi', 'Parking', 'A/C', 'Heating'],
}

function addDays(dateStr: string, days: number) {
  const d = new Date(dayOnly(dateStr) + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

// ── Ported from BookingsPage (reservations table + change requests) ──
type ResvBooking = {
  id: string
  unitId: string
  unitNumber: string
  unitType: string
  propertyName: string
  requiresBookingAcknowledgment: boolean
  guestName: string | null
  guestEmail: string | null
  guestPhone: string | null
  leaseType: string
  checkIn: string
  checkOut: string
  nights: number
  totalAmount: string | number | null
  platformFee: string | number | null
  status: string
  source: string
  notes: string | null
  acknowledgmentSignedAt: string | null
  createdAt: string
}

type ChangeRequest = {
  id: string
  bookingId: string
  requestType: BookingChangeRequestType
  details: string | null
  status: string
  guestName: string | null
  checkIn: string
  checkOut: string
  unitNumber: string | null
  propertyName: string | null
  createdAt: string
}

const RESV_STATUS_BADGE: Record<string, string> = {
  confirmed: 'badge-blue',
  checked_in: 'badge-green',
  checked_out: 'badge-muted',
  cancelled: 'badge-muted',
  no_show: 'badge-red',
}

// Date-only strings render at noon to dodge TZ off-by-one.
/**
 * 10/18 (review) — WHAT A LINK HANDED BACK ACTUALLY ASKS FOR.
 *
 * A reservation can have more than one pay link out, and they ask for
 * different money: the link that created the stay (its whole price), an "Add a
 * month" link, the arrival-day balance, and its deposit link. The window names
 * the link and its amount so nobody reads "$286.08" down the phone as a $57
 * deposit. Empty when the server did not say (the reservation form's own send).
 */
const linkAsksFor = (l: { label?: string | null; amount?: number | null }): string => {
  if (!l.label && l.amount == null) return ''
  if (l.amount == null) return ` — “${l.label}”`
  if (!l.label) return ` for ${fmt(l.amount)}`
  return ` — “${l.label}”, ${fmt(l.amount)}`
}

const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—'
  try { return new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  catch { return d }
}

// Guest stay-assistant access (S501 track). Shows the per-booking stay link +
// QR the host displays/prints on-site, can re-email it to the guest, and can
// revoke all access. Issuing mints a fresh reusable token bound to this one
// booking; revoke kills every outstanding link for it. (Ported from BookingsPage.)
type IssuedAccess = { url: string; qrDataUrl: string; expiresAt: string; emailed: boolean }

function GuestAccessModal({ booking, onClose }: { booking: ResvBooking; onClose: () => void }) {
  const base = `/units/${booking.unitId}/bookings/${booking.id}/guest-access`
  const [issued, setIssued] = useState<IssuedAccess | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoked, setRevoked] = useState<number | null>(null)

  // Issue (or re-issue) the link + QR. sendEmail re-issues and emails the guest.
  const issueMut = useMutation(
    (sendEmail: boolean) => apiPost<IssuedAccess>(base, { sendEmail }),
    {
      onSuccess: (res) => {
        setIssued(res.data)
        setRevoked(null)
        setCopied(false)
      },
    },
  )

  const revokeMut = useMutation(
    () => apiDelete<{ revoked: number }>(base),
    {
      onSuccess: (res) => {
        setRevoked(res.data.revoked)
        setIssued(null)
      },
    },
  )

  const copyLink = () => {
    if (!issued) return
    navigator.clipboard?.writeText(issued.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }).catch(() => {})
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 440, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <QrCode size={18} style={{ color: 'var(--gold)' }} /> Stay link
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 16 }}>
          {booking.guestName || 'Guest'} · {booking.propertyName} Unit {booking.unitNumber} · {fmtDate(booking.checkIn)}–{fmtDate(booking.checkOut)}
        </div>

        {!issued && revoked == null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: '.84rem', color: 'var(--text-1)' }}>
              Generate the guest's stay-assistant link and a QR code to show or print on-site.
              The guest chats with no account; the link works for the whole stay.
            </p>
            <button className="btn" disabled={issueMut.isLoading} onClick={() => issueMut.mutate(false)}>
              {issueMut.isLoading ? 'Generating…' : 'Generate stay link'}
            </button>
          </div>
        )}

        {issued && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <img src={issued.qrDataUrl} alt="Stay link QR code" width={200} height={200} style={{ borderRadius: 10, background: '#fff', padding: 8 }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Link</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" readOnly value={issued.url} onFocus={e => e.currentTarget.select()} style={{ fontSize: '.78rem' }} />
                <button className="btn btn-ghost btn-sm" onClick={copyLink} title="Copy link" style={{ flexShrink: 0 }}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>
              Expires {new Date(issued.expiresAt).toLocaleDateString()}{issued.emailed ? ' · emailed to guest' : ''}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {booking.guestEmail && (
                <button className="btn btn-ghost btn-sm" disabled={issueMut.isLoading} onClick={() => issueMut.mutate(true)}>
                  <Mail size={13} /> Email to guest
                </button>
              )}
              <button
                className="btn btn-ghost btn-sm"
                disabled={revokeMut.isLoading}
                onClick={() => revokeMut.mutate()}
                style={{ color: 'var(--red)', marginLeft: 'auto' }}
              >
                <Ban size={13} /> Revoke access
              </button>
            </div>
          </div>
        )}

        {revoked != null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: '.84rem', color: 'var(--text-1)' }}>
              {revoked > 0
                ? `Access revoked. ${revoked} link${revoked === 1 ? '' : 's'} no longer work.`
                : 'No active links to revoke.'}
            </p>
            <button className="btn btn-ghost btn-sm" disabled={issueMut.isLoading} onClick={() => issueMut.mutate(false)} style={{ alignSelf: 'flex-start' }}>
              Generate a new link
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 10/18 (Nic) — WHAT A BAR'S COLOR SAYS, AND WHAT IT STILL LETS YOU DRAG.
 *
 * "I want the color to be yellow when they're not checked in and green when
 * they're checked in. And they can stay blue when they have a lease. And when
 * they are checked out, you know, the blue ones are locked. You can't adjust
 * the dates on them because they're tied to the lease. But the stays that are
 * green, once they've been here and gone and they're checked out, those also
 * need to be locked. So I can't move it around. I can't change the dates
 * accidentally. It's that reservation becomes locked as part of the history."
 *
 * Until today every stay on the calendar painted the same green whatever its
 * status, so a site nobody has arrived at looked exactly like a site with
 * somebody living on it — and a stay that ended last spring could still be
 * dragged onto new dates by a stray mouse. One reading of the booking now
 * decides both things, so they can never disagree: the color it paints, and
 * whether its dates are still the calendar's to change.
 *
 * Locked means the BOARD will not move it: a finished stay does not drag, has
 * no edge grips, and right-click opens its window instead of dropping into the
 * date editor. That is the accident Nic named — "I can't change the dates
 * accidentally" — and it is all the lock covers.
 *
 * 10/18 (review): what it deliberately does NOT do is take away the deliberate
 * correction. Open the stay and Edit is still there, because the desk that
 * typed Sep 30 for an Oct 1 arrival sold and priced a night nobody stayed, and
 * no other screen in the portal can put that right (the check-out screen never
 * asks for a date on a stay that has already checked out). The server knows the
 * difference: it reprices a re-dated checked-out stay and refuses the edit in
 * words once a refund has gone out. Clicking a locked bar still opens its
 * window — reading a stay is never the thing we take away.
 */
export type ScheduleBarKind = 'lease' | 'reserved' | 'reserved_part_paid' | 'reserved_paid_full' | 'checked_in' | 'checked_out' | 'no_show'

/**
 * 10/24 (Nic) — HAS THIS ONE PAID ME, OR HAVEN'T THEY.
 *
 *   "Does the color shift to a reservation that's made and secured with a
 *    deposit? ... I don't know what, more of a purplish color that won't be too
 *    close to anything."
 *
 * Every un-arrived reservation was one amber, paid or not, and the money was
 * readable in exactly one place: inside the reservation's own window, after you
 * clicked it. So the only way to know who still owed for a site was to open
 * every bar on the board one at a time.
 *
 * Money in hand is any of the three ways it arrives: the deposit cleared, the
 * whole balance cleared, or they paid at the register on the way in (a walk-in
 * carries a register sale and no deposit row at all). Any one of them means the
 * site is secured, so any one of them turns the bar purple.
 *
 * Amber stays the one that has NOT paid, deliberately: amber already means
 * "deal with this" everywhere else in GAM, so the bar that still owes money is
 * the one that catches the eye across a 100-space board.
 */
export function stayIsSecured(booking: any): boolean {
  return !!(booking?.depositPaidAt || booking?.balancePaidAt || booking?.posTransactionId)
}

/**
 * 10/24 (Nic) — PAID IN FULL IS ITS OWN COLOUR, AND WHY IT EARNS ONE.
 *
 * I argued a third shade did not change anything at the counter, because a
 * part-paid and a fully-paid reservation both mean "do not give this site
 * away". Nic:
 *
 *   "Both paid in part or paid in full means we can't give the spot away, but
 *    it does add a distinction that changes what we do at the counter. We don't
 *    take money at the counter if they're paid in full."
 *
 * That is the whole point: the fill tells the desk whether to reach for the
 * card reader when somebody walks up. Nothing else on the board says it, and
 * the difference between $15 down on a three-night stay and the whole thing
 * paid is exactly what a clerk needs before they start asking for money.
 *
 * balance_paid_at is the column that MEANS the balance is settled — a register
 * sale for a stay sets it alongside balance_billed_at (routes/pos), and so does
 * a pay link that covers the rest. So it is the one thing read here; a deposit
 * or a register id without it is money in hand with more still owed.
 */
export function stayIsPaidInFull(booking: any): boolean {
  return !!booking?.balancePaidAt
}

export function scheduleBarKind(booking: any): ScheduleBarKind {
  // A lease row is the one that carries a start date (the schedule's leases
  // come from the lease, stays come from the booking).
  if (booking?.isLease || booking?.startDate) return 'lease'
  const status = booking?.status as BookingStatus | undefined
  if (status === 'checked_in') return 'checked_in'
  if (status === 'checked_out') return 'checked_out'
  if (status === 'no_show') return 'no_show'
  // Tentative and confirmed are the same thing to the eye: booked, nobody has
  // arrived. (Canceled stays never reach the calendar at all.) What DOES show
  // is whether the money came in — see stayIsSecured above.
  if (stayIsPaidInFull(booking)) return 'reserved_paid_full'
  return stayIsSecured(booking) ? 'reserved_part_paid' : 'reserved'
}

export const SCHEDULE_BAR_COLOR: Record<ScheduleBarKind, string> = {
  lease: 'var(--blue)',
  reserved: 'var(--amber)',
  // 10/24 (Nic): secured by money. Purple was the one direction with open space
  // in BOTH themes — a yellow bright enough to read apart from amber on dark
  // has to darken to roughly #ca8a04 on light, which is brand gold (#c9a227) to
  // the eye. #a855f7 is already GAM's purple in Books, so the platform is not
  // growing a sixth hue, and it is lighter as well as a different hue from the
  // blue lease bar it sits beside. Both values in SCHEDULE_BAR_THEME_CSS below.
  reserved_part_paid: 'var(--sched-fill-reserved-paid)',
  // 10/24 (Nic): "I don't know if paid in full would be like a lime green type
  // of color or something, slime green, like that Nickelodeon slime color."
  //
  // #a4d233 measured against every other fill before it was picked: 38.8 deltaE
  // from the checked-in green on the dark theme and 51.8 on the light, 40.8 from
  // the brand gold — against a 25 threshold, where the green pair Nic could not
  // tell apart measured 14.9. It is the ONE fill besides the lease bar that does
  // not flip with the theme: bright with near-black ink reads at 9.3:1 on both,
  // and every darker lime that could carry white ink landed ~23 from the
  // checked-in green, which is the collision this board already learned to fear.
  reserved_paid_full: '#a4d233',
  checked_in: 'var(--green)',
  // 10/18 (review) — WHY FINISHED HISTORY DOES NOT JUST REUSE --green-dim.
  //
  // These two fills are the only ones that share a hue with a LIVE state, so
  // they are the two that have to be told apart by lightness alone. --green-dim
  // and --red-dim are dark-theme values the light theme never redefines, while
  // --green does: on light it darkens to a forest green that lands a hair away
  // from --green-dim (1.40:1 — barely a shade apart). So a site somebody is
  // living on and a stay that ended last spring painted the same dark green for
  // every landlord on light mode, and the difference Nic asked for was gone.
  //
  // Finished history now fades TOWARD THE PAGE in whichever theme is on: darker
  // on the dark theme, paler on the light one. Same stay, visibly over, either
  // way. Both values ship in SCHEDULE_BAR_THEME_CSS below, and the test resolves
  // them to real colors off globals.css rather than trusting the token names.
  checked_out: 'var(--sched-fill-checked-out)',
  // History too, and it must never read as a live green stay.
  no_show: 'var(--sched-fill-no-show)',
}

/**
 * Name color that stays readable on each of those backgrounds.
 *
 * Only the lease bar is the same color in both themes — blue stays dark, so it
 * keeps light ink. Every other fill flips. Yellow and bright green are light
 * fills on the dark theme and darken on the light one (amber to a deep orange,
 * green to a forest green), so they want near-black ink on dark and white on
 * light. The two finished fills flip the other way — dark on dark, pale on
 * light — so their ink flips with them. All four read it from
 * SCHEDULE_BAR_THEME_CSS below, so the theme switch carries the ink instead of
 * a second copy of this table.
 */
export const SCHEDULE_BAR_TEXT: Record<ScheduleBarKind, string> = {
  lease: '#e6ecff',
  reserved: 'var(--sched-ink-reserved)',
  reserved_part_paid: 'var(--sched-ink-reserved-paid)',
  // Dark ink on a bright fill, in both themes — see the fill above.
  reserved_paid_full: '#17210a',
  checked_in: 'var(--sched-ink-checked-in)',
  checked_out: 'var(--sched-ink-checked-out)',
  no_show: 'var(--sched-ink-no-show)',
}

/** The floating name's drop shadow — light behind dark ink, dark behind light. */
export const SCHEDULE_BAR_SHADOW: Record<ScheduleBarKind, string> = {
  lease: '0 1px 2px rgba(0,0,0,.6)',
  reserved: 'var(--sched-shadow-reserved)',
  reserved_part_paid: 'var(--sched-shadow-reserved-paid)',
  reserved_paid_full: '0 1px 2px rgba(255,255,255,.55)',
  checked_in: 'var(--sched-shadow-checked-in)',
  checked_out: 'var(--sched-shadow-checked-out)',
  no_show: 'var(--sched-shadow-no-show)',
}

/**
 * The half of the bar palette that has to flip with the theme, as the timeline
 * ships it.
 *
 * Two things live here. The ink (and its drop shadow) for every fill that is
 * light in one theme and dark in the other. And the two FINISHED fills, because
 * "faded" is not one color: on the dark theme a finished stay fades DOWN toward
 * the page, on the light theme it fades UP toward the white. The dark values are
 * the palette tokens we already had; only the light ones are new.
 */
export const SCHEDULE_BAR_THEME_CSS = `
:root{
  --sched-ink-reserved:#1a1200;
  --sched-ink-checked-in:#07210f;
  --sched-fill-reserved-paid:#a855f7;
  --sched-ink-reserved-paid:#1b0a2e;
  --sched-shadow-reserved-paid:0 1px 2px rgba(255,255,255,.55);
  --sched-shadow-reserved:0 1px 2px rgba(255,255,255,.6);
  --sched-shadow-checked-in:0 1px 2px rgba(255,255,255,.55);
  --sched-fill-checked-out:var(--green-dim);
  --sched-ink-checked-out:#eafbf0;
  --sched-shadow-checked-out:0 1px 2px rgba(0,0,0,.6);
  --sched-fill-no-show:var(--red-dim);
  --sched-ink-no-show:#ffecec;
  --sched-shadow-no-show:0 1px 2px rgba(0,0,0,.6);
}
:root[data-theme="light"]{
  --sched-ink-reserved:#ffffff;
  --sched-ink-checked-in:#ffffff;
  --sched-fill-reserved-paid:#7e22ce;
  --sched-ink-reserved-paid:#ffffff;
  --sched-shadow-reserved-paid:0 1px 2px rgba(0,0,0,.5);
  --sched-shadow-reserved:0 1px 2px rgba(0,0,0,.5);
  --sched-shadow-checked-in:0 1px 2px rgba(0,0,0,.5);
  --sched-fill-checked-out:#8ec4a3;
  --sched-ink-checked-out:#0b2a16;
  --sched-shadow-checked-out:0 1px 2px rgba(255,255,255,.55);
  --sched-fill-no-show:#dca0a0;
  --sched-ink-no-show:#3a0d0d;
  --sched-shadow-no-show:0 1px 2px rgba(255,255,255,.55);
}`

/**
 * 10/24 (Nic) — WHO IS IT FOR, WITHOUT TYPING THEM OUT AGAIN.
 *
 *   "If somebody's making a reservation that has been here before, we need a way
 *    to have it just select a previous person instead of typing out their full
 *    name. Like if I'm typing the name William maybe it pre-populates from a
 *    drop-down list of any other Williams in the system, and I can just click
 *    the right one. Or maybe start with the phone number and if they've been
 *    here before, it pre-populates them."
 *
 * The four guest fields, with the platform's people search behind the name and
 * phone boxes. Typing two characters in any of them lists matches; clicking one
 * fills all four and the dropdown goes away.
 *
 * WHERE THE PEOPLE COME FROM. GET /pos/people — the same search the register's
 * History tab uses, not a second one: this property's residents, every register
 * customer in the account's book, and (10/2, settled) everybody else on GAM by
 * part of a name or a whole phone number. A person from another company comes
 * back as a name and their phone only (10/24, Nic: "they are all customers of
 * GAM. So sharing that information between landlords when it's just a name and
 * phone number and no other sensitive information is okay") — never their
 * company, site, lease, balance, payment history or ids.
 *
 * NOTHING IS WRITTEN BY PICKING. A reservation keeps the guest's name, email and
 * phone on the booking itself, so a pick only FILLS THE BOXES — it creates no
 * customer record and links no accounts. Whatever the clerk does next is still
 * the clerk's to change.
 *
 * ONE COPY. These fields were written out twice — once in the waitlist block and
 * once under "Who is it for" — so a change to either drifted from the other.
 */
function GuestFields(props: {
  propertyId: string | null | undefined
  first: string; last: string; email: string; phone: string
  setFirst: (v: string) => void
  setLast: (v: string) => void
  setEmail: (v: string) => void
  setPhone: (v: string) => void
}) {
  const { propertyId } = props
  // Which box is being typed in, and what is in it. One dropdown, under that box.
  const [lookingIn, setLookingIn] = useState<'first' | 'last' | 'phone' | null>(null)
  const [typed, setTyped] = useState('')
  const [debounced, setDebounced] = useState('')
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(typed), 250)
    return () => clearTimeout(t)
  }, [typed])

  // The server wants two characters and refuses over 120; it also limits how
  // often one person may look outside their own company. Asking only once the
  // typing settles keeps a name like "William" to one search, not seven.
  const term = debounced.trim()
  const askable = !!propertyId && term.length >= 2 && term.length <= 120 && !dismissed
  const { data: found, isFetching } = useQuery(
    ['guest-lookup', propertyId, term],
    () => apiGet(`/pos/people?propertyId=${propertyId}&q=${encodeURIComponent(term)}`),
    { enabled: askable, keepPreviousData: true, staleTime: 30_000 },
  )
  const hits: any[] = askable && Array.isArray(found?.data) ? found!.data : []

  const take = (h: any) => {
    props.setFirst(String(h.firstName ?? '').trim())
    props.setLast(String(h.lastName ?? '').trim())
    // Only overwrite what the pick actually knows — a clerk who already typed an
    // email for somebody whose record has none does not lose it.
    if (h.email) props.setEmail(String(h.email))
    if (h.phone) props.setPhone(typingPhone(String(h.phone)))
    setLookingIn(null); setTyped(''); setDebounced(''); setDismissed(true)
  }

  // A box the clerk is typing in drives the search; changing anything by hand
  // after a pick starts a fresh one.
  const watch = (which: 'first' | 'last' | 'phone', v: string) => {
    setLookingIn(which); setTyped(v); setDismissed(false)
  }

  const Found = () => (
    <div style={{position:'absolute',top:'calc(100% + 4px)',left:0,right:0,zIndex:30,minWidth:240,maxHeight:260,overflowY:'auto',
                 background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:8,boxShadow:'0 10px 30px rgba(0,0,0,.45)'}}>
      {hits.map((h) => (
        <button key={h.key} type="button" onClick={() => take(h)}
          style={{display:'block',width:'100%',textAlign:'left',padding:'8px 10px',background:'transparent',
                  border:'none',borderBottom:'1px solid var(--border-1)',cursor:'pointer',color:'var(--text-0)'}}>
          <div style={{fontSize:'.8rem',fontWeight:600}}>{h.name}</div>
          {h.hint && <div style={{fontSize:'.7rem',color:'var(--text-3)',marginTop:1}}>{h.hint}</div>}
        </button>
      ))}
      <button type="button" onClick={() => { setLookingIn(null); setDismissed(true) }}
        style={{display:'block',width:'100%',textAlign:'left',padding:'7px 10px',background:'transparent',border:'none',
                cursor:'pointer',color:'var(--text-3)',fontSize:'.7rem'}}>
        Nobody here — keep what I typed
      </button>
    </div>
  )

  const box = (which: 'first' | 'last' | 'phone', el: any) => (
    <div style={{position:'relative'}}>
      {el}
      {lookingIn === which && hits.length > 0 && <Found />}
    </div>
  )

  return (
    <>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        {box('first',
          <input className="form-input" placeholder="First name" style={{width:'100%'}}
            value={props.first}
            onChange={e => { props.setFirst(e.target.value); watch('first', e.target.value) }} />)}
        {box('last',
          <input className="form-input" placeholder="Last name" style={{width:'100%'}}
            value={props.last}
            onChange={e => { props.setLast(e.target.value); watch('last', e.target.value) }} />)}
        <input className="form-input" type="email" placeholder="Email" style={{width:'100%'}}
          value={props.email} onChange={e => props.setEmail(e.target.value)} />
        {box('phone',
          // 10/24 (Nic): "I don't want to have to type dashes or parentheses on
          // everything." typingPhone is the platform's one formatter — digits in,
          // (520) 903-8134 out, and an eleventh digit will not go in.
          <input className="form-input" type="tel" placeholder="Phone" style={{width:'100%'}}
            value={props.phone}
            onChange={e => { const v = typingPhone(e.target.value); props.setPhone(v); watch('phone', v) }} />)}
      </div>
      {/* Said once, under the boxes, so the desk knows the list is there without
          a dropdown having to appear to tell them. */}
      <div style={{fontSize:'.68rem',color:'var(--text-3)',marginTop:5}}>
        {isFetching && askable
          ? 'Looking…'
          : 'Been here before? Start typing their phone number or name and pick them from the list.'}
      </div>
    </>
  )
}

/** One floating name, pinned over its bar (S575) — see nameOverlays. */
type NameOverlay = {
  key: string; left: number; top: number; height: number; width: number
  label: string; kind: ScheduleBarKind; locked: boolean
}

/**
 * Locked = the dates are no longer the calendar's to change.
 *
 * 10/24: this list was written out twice — here and again in nameOverlays for
 * the floating name's padlock — so adding a bar kind meant finding both. One
 * list now, read by both. A SECURED reservation is deliberately NOT on it: the
 * money being in hand does not settle the dates, and a paid guest who calls to
 * move a day still gets moved (see stayIsSecured).
 */
export const LOCKED_BAR_KINDS: readonly ScheduleBarKind[] = ['lease', 'checked_out', 'no_show']

export function isScheduleBarLocked(booking: any): boolean {
  return LOCKED_BAR_KINDS.includes(scheduleBarKind(booking))
}

/**
 * 10/20 (Nic, his own catch) — THE SITE IS LOCKED EVEN THOUGH THE DATES ARE NOT.
 *
 *   "They may have already gotten a confirmation on a space number. Our system
 *    with compression and expansion is going to kind of screw that up if they
 *    think they're locked to a specific site already."
 *
 * A pinned stay is a different kind of locked from the one above. Its DATES are
 * still the calendar's to change — a snowbird adds a month all the time — so it
 * is not isScheduleBarLocked and its bar still drags. What is not the board's to
 * change is its SPACE, because a space number is already in the guest's hands.
 * So a cross-site drop asks first (commitDrag) and the server refuses an
 * unconfirmed one outright (routes/units, code 'locked_site').
 */
export function isScheduleBarSiteLocked(booking: any): boolean {
  return scheduleBarKind(booking) !== 'lease' && booking?.lockedToUnit === true
}

/**
 * 10/20 (Nic) — WHAT THE PANEL SAYS ABOUT A STAY SOMEBODY MOVED BY HAND.
 *
 * A stay moved off a promised space is still pinned, but nobody promised the
 * space it is on now, so the import's two reasons no longer describe it (the
 * booking PATCH rewrites the stored reason the moment the move goes through —
 * see migration 20261022140000). These are the words for that third reason;
 * they live here because this screen is the only place that causes it, and the
 * fact they have to carry is the one the desk needs: there is a stale space
 * number out there, and somebody may still have to say so.
 */
export const SITE_MOVED_BY_HAND_REASON = 'moved_off_promised_site'
export const SITE_MOVED_BY_HAND_WORDS =
  'Moved here by hand, off the space they were promised — the space in their confirmation is no longer theirs'
export const scheduleStayLockWords = (lockReason: string | null | undefined): string =>
  lockReason === SITE_MOVED_BY_HAND_REASON ? SITE_MOVED_BY_HAND_WORDS : stayLockWords(lockReason)

// ── 10/20 (Nic, his own catch): MOVING A STAY OFF THE SPACE IT WAS PROMISED ──
//
//   "They may have already gotten a confirmation on a space number. Our system
//    with compression and expansion is going to kind of screw that up if they
//    think they're locked to a specific site already."
//
// Every move GAM makes itself refuses a pinned stay. A person may move one —
// the guest agreed on the phone, the site flooded, the rig is too long — but
// never quietly, because the cost of quiet is a rig pulling in to find somebody
// parked on the space in its confirmation.
/** Why the stay is pinned, in the clause the question reads out. */
const LOCK_HELD_BECAUSE: Record<string, string> = {
  promised_before_gam: 'was promised this space before GAM, in the old system',
  promised_at_the_counter: 'was promised this space at the desk',
  [SITE_MOVED_BY_HAND_REASON]: 'was already moved here by hand, off the space they were promised',
}
/** A lock with no reason recorded: somebody ticked the box (S547's snowbird). */
const LOCK_HELD_FALLBACK = 'is pinned to this space by hand'

/**
 * The question asked before a person drags a pinned stay to another space.
 *
 * The server refuses an unconfirmed move (409 'locked_site') and sends these
 * same words back, so a page that loaded before the stay was pinned gets the
 * question too — the screen is not the guard. Asking here as well means a drag
 * the screen can already see coming is answered in one press, not two.
 *
 * Three things, because all three decide whether a rig arrives at the right
 * space: which number is in the guest's hand, where they are going, and
 * whether GAM can tell them it changed.
 */
export function promisedSiteWords(b: any, toUnitNumber: string): string {
  const who = (b?.guestName || '').trim() || 'This guest'
  const from = b?.unitNumber || 'their site'
  const tell = (b?.guestEmail || '').trim()
    ? `We will email them that their site is now ${toUnitNumber}.`
    : 'We have no email address for them, so somebody has to call them — GAM cannot tell them.'
  return `${who} ${LOCK_HELD_BECAUSE[b?.lockReason as string] || LOCK_HELD_FALLBACK}, so ${from} is the number they have. `
    + `Moving them to ${toUnitNumber} means ${from} is no longer theirs. ${tell}`
}

export function SchedulePage() {
  const qc = useQueryClient()
  const { can } = usePerms()
  const today = new Date().toISOString().split('T')[0]
  const [view, setView] = useUrlTab('view', 'timeline', ['timeline','list','units','history','reservations','requests','booking_page'] as const)
  // Perpetual calendar (S576): the window starts ~1 month back, ~5 months
  // forward, but the forward horizon EXTENDS on demand — infinite forward
  // scroll appends days as you near the right edge, and the Jump-to-date
  // control extends the window to reach any future date (e.g. next winter's
  // reservations during busy season). No more hard ~5-month wall. Day columns
  // size to fit roughly a month in the viewport (colW); the load scrolls to
  // today so the coming month is what you see first.
  const [fromDate, setFromDate] = useState(addDays(today, -31))
  const [toDate, setToDate] = useState(addDays(today, 151))
  // Guards + pending scroll target for the perpetual-calendar extends.
  const extendingRef = useRef(false)
  const [pendingScrollDate, setPendingScrollDate] = useState<string | null>(null)
  const [jumpDate, setJumpDate] = useState('')
  // Fixed, compact day-column width: a normal window shows ~a month across,
  // a wide display shows more. (A measured fit-to-viewport mis-read the full
  // display width on large monitors and over-widened columns.)
  const colW = 30
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [bookingModal, setBookingModal] = useState<{show:boolean; unit:any; prefillDate?:string}>({show:false, unit:null})
  const [typeModal, setTypeModal] = useState<{show:boolean; unit:any}>({show:false, unit:null})
  const [newBooking, setNewBooking] = useState({ guestName:'', guestEmail:'', guestPhone:'', leaseType:'nightly', checkIn:'', checkOut:'', totalAmount:'', notes:'' })
  // Per-unit "+ Book" modal guest name (S526: split first/last like the
  // New Reservation flow; the two modals never open at the same time).
  const [bookFirst, setBookFirst] = useState('')
  const [bookLast, setBookLast]   = useState('')
  const [typeForm, setTypeForm] = useState<any>({})
  const [customAmenity, setCustomAmenity] = useState('')
  const [newResvOpen, setNewResvOpen] = useState(false)
  // 10/20: the "Bring in reservations" door (./ReservationImport).
  const [importOpen, setImportOpen] = useState(false)
  const [detailBooking, setDetailBooking] = useState<any>(null)
  // 10/5 (Nic, R2): lease or no lease — asked when a save makes a stay 30+
  // nights in a row. The answer rides on the same save, sent again.
  const [termsAsk, setTermsAsk] = useState<{ question: string; resend: (t: StayTerms) => void } | null>(null)
  const termsAnswer = useRef<StayTerms | null>(null)
  // The answer the last save carried, kept so a save asked a second thing (how
  // the background check is paid, below) is sent again with it.
  const lastTerms = useRef<StayTerms | null>(null)
  // 10/5 (Nic, A2): a stay that needs the background check's fee can't be
  // confirmed straight onto the schedule — the desk picks how it is paid: a pay
  // link emailed to the guest, or the register. The pick rides on the same save.
  const [feeRoute, setFeeRoute] = useState<{ message: string; canSendLink: boolean; returning: ReturningOffer | null; resend: (m: 'link' | 'register' | 'returning') => void } | null>(null)
  const payRouteAnswer = useRef<'link' | 'register' | 'returning' | null>(null)
  // 10/17 (Nic): which of the two the save that just went out actually asked
  // for, so a save that comes back with neither a link nor a ticket is reported
  // as a failure instead of looking like a quiet success (sayPayRouteDone).
  const sentPayRoute = useRef<'link' | 'register' | null>(null)
  // 10/5 (Nic, R9): a check-in refused because the background check isn't
  // back and decided yet — shown in its own window, with no override.
  const [screeningWait, setScreeningWait] = useState<{ message: string; waitingOn: string } | null>(null)
  // 10/5 (Nic, R6): the stay a month is being added to.
  const [addMonthFor, setAddMonthFor] = useState<any | null>(null)
  // Final fix (fix pass 1, decisions #53): the stay whose Cancel reservation
  // confirm is open (it reads, fresh, what canceling it changes).
  const [cancelFor, setCancelFor] = useState<any>(null)
  // Edit mode for an existing reservation (the detail panel). null = view-only.
  const [editForm, setEditForm] = useState<{guestName:string; guestEmail:string; guestPhone:string; checkIn:string; checkOut:string; unitId:string; notes:string; requiredSiteLayout:string; requiredAmpService:string; rigLengthFt:number|null; avoid:string} | null>(null)
  const [editError, setEditError] = useState('')
  const [resvError, setResvError] = useState('')
  const [resvFirst, setResvFirst] = useState('')
  const [resvLast, setResvLast] = useState('')
  // Optional RV requirements for a new reservation: site layout (back-in vs
  // pull-through) + electrical service (30/50 amp). When set, mismatched units
  // are flagged (warn, not blocked).
  const [resvLayout, setResvLayout] = useState<string>('none')
  // S653 (Nic): "they didn't like the spot they were in last year... an
  // avoidance type situation." Typed as site numbers the way the customer says
  // them; matched to units at the property the stay lands on.
  const [resvAvoid, setResvAvoid] = useState('')
  // S652: the counter's flow is a conversation, so the screen only reveals the
  // next thing once the previous one is settled — availability after dates,
  // names after a site. None of it is persisted; backing out drops all three.
  const [showAvail, setShowAvail] = useState(false)
  const [pickedUnit, setPickedUnit] = useState<any | null>(null)
  const [lockSite, setLockSite] = useState(false)
  const [payMode, setPayMode] = useState<'link' | 'register'>('link')
  // 10/17 (Nic) — THE PER-SITE "+ Book" FORM'S OWN ANSWER, AND ITS OWN DEFAULT.
  //
  // "when I go to add a reservation, it won't generate a pay link from doing
  // the reservation." That form sent no pay route at all, so it could never
  // produce a link or a ticket. But sending no route is also a real third
  // outcome and the one it has always had: confirmed on the spot, outranking
  // unpaid holds, because the money is being handled outside this form (they
  // are paying now, they already paid, it is comped, it is an owner's block).
  // So the choice is added and 'none' is the default — nobody's reservation
  // silently changes behavior, and nobody emails a caller by accident.
  //
  // Deliberately NOT the New Reservation flow's `payMode` above: that form has
  // only the two money exits and always has; sharing one piece of state made
  // closing one form reach into the other.
  const [bookPayMode, setBookPayMode] = useState<'none' | 'link' | 'register'>('none')
  // 10/17 (Nic): "when I go to add a reservation, it won't generate a pay link
  // from doing the reservation." The link WAS being made; nothing on this screen
  // ever said so, and there was nowhere to read it. This holds the link a save
  // just produced, so the desk can read it to the caller still on the phone.
  // 10/18 (Nic): `emailedNow` false = the link was already out, so it is shown
  // again to read down the phone and the guest was NOT emailed a second time.
  // 10/18: what came back when a deposit was asked for — and, since a
  // reservation can already have a link out that asks for OTHER money (the one
  // that created it, an "Add a month" link, the arrival-day balance), WHICH
  // link this is and what it asks for. The window says it in words rather than
  // calling every URL "the deposit link".
  const [resvLink, setResvLink] = useState<{
    url: string; emailedTo: string | null; guest: string
    /** An email went out on this press. */
    emailedNow?: boolean
    /** The link is made and payable, but the email did not go out. */
    emailFailed?: boolean
    /** False = this is another link already out for the reservation, not its deposit link. */
    isDeposit?: boolean
    label?: string | null
    amount?: number | null
    neverExpires?: boolean
    /**
     * 10/24 (Nic): this window opened straight off MAKING the reservation, so
     * it carries no link to copy — the desk's next move is the next guest, not
     * a URL. Opened by asking a reservation that already exists for its deposit
     * link, it is false and the link is handed over.
     */
    justBooked?: boolean
  } | null>(null)
  // 10/6 (Nic): "Returning guest — they've stayed with us before" (no
  // background check) and "Work trade" on the new-reservation form.
  const [resvReturning, setResvReturning] = useState(false)
  const [resvWorkTrade, setResvWorkTrade] = useState(false)
  const [resvWt, setResvWt] = useState<WorkTradeTerms>(defaultWorkTradeTerms)
  // …and on the reservation edit.
  const [editReturning, setEditReturning] = useState(false)
  const [editWorkTrade, setEditWorkTrade] = useState(false)
  const [editWt, setEditWt] = useState<WorkTradeTerms>(defaultWorkTradeTerms)
  // The returning-guest choice as the server offers it for the stay being
  // made or edited (needs a check? may this desk use it? allowance left?).
  const resvOffer = useReturningGuestOffer({
    unitId: pickedUnit?.id, checkIn: newBooking.checkIn, checkOut: newBooking.checkOut, email: newBooking.guestEmail,
    enabled: newResvOpen && !!pickedUnit,
  })
  const editOffer = useReturningGuestOffer({
    unitId: editForm?.unitId, checkIn: editForm?.checkIn ?? '', checkOut: editForm?.checkOut ?? '', email: editForm?.guestEmail,
    bookingId: detailBooking?.id ?? null,
    enabled: !!editForm && !!detailBooking && !detailBooking.isLease && !detailBooking.returningGuestAt,
  })
  const [resvAmp, setResvAmp] = useState<string>('none')
  // 10/24 (Nic): "I'm trying to make a reservation right now where somebody's got
  // a 37 foot camper. They can't go in the small sites, right?" How long their
  // rig is, as a string so the box can be empty (= they did not say).
  const [resvRig, setResvRig] = useState<string>('')
  const [selectedCell, setSelectedCell] = useState<{unitId:string; date:string}|null>(null)
  // Booking-guest access: the link a no-account guest uses to reach their
  // stay assistant. Generated on demand per booking.
  const [guestAccess, setGuestAccess] = useState<{
    show:boolean; booking:any; loading:boolean; error:string|null;
    data:{url:string; expiresAt:string; emailed?:boolean}|null; emailing:boolean
  }>({show:false, booking:null, loading:false, error:null, data:null, emailing:false})
  // S652 (Nic): "scrolling up and down on the schedule really fast... the
  // overlay is overlapping the site numbers... it makes it look like it's
  // lagging really bad."
  //
  // The site column used to be PINNED over the timeline (position:sticky), in
  // the same scrolling box as the bars. A browser draws a pinned column as its
  // own layer and draws it separately from what scrolls beneath — so on a fast
  // scroll the bars of a newly-revealed row could be on screen a moment before
  // the column that was supposed to cover them. Stacking order (tried twice)
  // cannot fix that; it is about WHEN each piece gets drawn, not which is on top.
  //
  // So the column is no longer on top of anything. It sits BESIDE the timeline:
  //   vScrollRef ......... scrolls up/down, and carries the site column and the
  //                        timeline together, natively
  //   scrollContainerRef . the timeline only; scrolls sideways
  // A bar lives inside the timeline box and that box ends where the site column
  // begins. There is nothing for it to overlap.
  const vScrollRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const headerStripRef = useRef<HTMLDivElement>(null)
  const legendRef = useRef<HTMLDivElement>(null)

  // ── Reservations tab (ported from BookingsPage) ──
  // Separate filter state from the timeline's `search` (which jumps the
  // calendar) — this drives the server-side /bookings query.
  const [linkBooking, setLinkBooking] = useState<ResvBooking | null>(null)
  const [resvSearch, setResvSearch] = useState('')
  const [resvStatus, setResvStatus] = useState('')
  const [resvSource, setResvSource] = useState('')
  const [resvFrom, setResvFrom] = useState('')
  const [resvTo, setResvTo] = useState('')

  // ── Booking Page tab (ported from BookingSitesPage) ──
  // Public per-property booking page config: slug, welcome text, stay rates,
  // short-term tax %, deposit %, publish toggle. Prefixed bp* to avoid clashing
  // with SchedulePage's existing reservation state.
  const [bpPropId, setBpPropId] = useState('')
  const [bpCfg, setBpCfg] = useState<any>(null)
  const [bpMsg, setBpMsg] = useState('')
  const [bpErr, setBpErr] = useState('')
  const [bpSaving, setBpSaving] = useState(false)


  useEffect(() => {
    const container = scrollContainerRef.current, vbox = vScrollRef.current
    if (!selectedCell || !container || !vbox) return
    const cell = container.querySelector(
      `[data-unit="${selectedCell.unitId}"][data-date="${selectedCell.date}"]`
    ) as HTMLElement
    if (!cell) return
    const row = cell.closest('tr') as HTMLElement
    if (!row) return

    // Up/down is the outer box, whose content starts with the date header.
    const headerHeight = headerRef.current?.offsetHeight || 36
    const rowTop = headerHeight + row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    if (rowTop < vbox.scrollTop + headerHeight) {
      vbox.scrollTop = row.offsetTop
    } else if (rowBottom > vbox.scrollTop + vbox.clientHeight) {
      vbox.scrollTop = rowBottom - vbox.clientHeight
    }

    // Sideways is the timeline, which no longer has a column in front of it.
    const cellLeft = cell.offsetLeft
    const cellRight = cellLeft + cell.offsetWidth
    if (cellLeft < container.scrollLeft) {
      container.scrollLeft = cellLeft - 4
    } else if (cellRight > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = cellRight - container.clientWidth + 4
    }
  }, [selectedCell])

  // Drag state
  // Native HTML5 drag (move + edge-resize). `dragInfo` holds the active drag's
  // booking + mode + grab offset; `dragTargetRef` mirrors the live preview range
  // so drop commits without reading state. Grab offset keeps the grabbed day
  // under the cursor (fixes the first-day jump / off-by-one).
  const dragInfo = useRef<null | { booking:any; mode:'move'|'resize-start'|'resize-end'; grabOffset:number }>(null)
  const dragTargetRef = useRef<{unitId:string; checkIn:string; checkOut:string} | null>(null)
  const [preview, setPreview] = useState<{unitId:string; checkIn:string; checkOut:string; mismatch:boolean}|null>(null)
  const [dragging, setDragging] = useState<string|null>(null)

  // S639 (Nic, DIRECTIVE): "Master schedule needs to be scoped to a property,
  // not having all the different properties on one schedule." Spot numbers
  // repeat across parks, so a merged timeline stacks several identically
  // labeled rows — unreadable, and a way to book the wrong space. The park is
  // picked once and remembered (shared with the Units page), and the fetch
  // itself is scoped so a big account never pulls the whole portfolio.
  const { data: allProperties = [] } = useQuery<any[]>(
    'properties', () => apiGet('/properties'), { staleTime: 60000 })
  const schedulePropertyOptions = allProperties.map((p: any) => ({ id: p.id, name: p.name }))
  const [schedulePropertyId, setSchedulePropertyId] =
    usePropertyScope('gam.scope.property', schedulePropertyOptions)

  const { data: schedule, isLoading } = useQuery(
    ['schedule', fromDate, toDate, filterType, schedulePropertyId],
    () => apiGet(`/units/schedule/master?from=${fromDate}&to=${toDate}${filterType!=='all'?'&unitType='+filterType:''}&propertyId=${schedulePropertyId}`),
    // keepPreviousData: when the perpetual-calendar window extends (from/to
    // change → new query key), keep showing the current grid instead of
    // flashing the "Loading schedule…" state and losing scroll position. The
    // appended day columns pop in when the wider fetch resolves.
    { staleTime: 30000, keepPreviousData: true, enabled: !!schedulePropertyId }
  )

  // ── 10/24 (Nic): A MARK ON THE BARS OF PEOPLE WORTH ASKING ───────────────
  //
  // He asked for "both" surfaces and then the front desk too. Here it is a mark
  // on the bar itself, because the schedule is where somebody is deciding who
  // goes where, and a stay that might end is a site that might open.
  //
  // Empty unless a park is down to 3 or fewer usable short-stay sites
  // (services/stayFollowUps), so nothing is drawn on an ordinary day — this
  // board only just got readable and must not grow permanent decoration.
  const { data: followUpsRaw } = useQuery<any[]>(
    'stay-followups', () => apiGet<any[]>('/landlords/me/stay-followups'),
    { staleTime: 60_000, keepPreviousData: true })
  // Null-safe: a refused or empty read draws nothing rather than throwing.
  const askIfStaying = useMemo(() => {
    const list: any[] = Array.isArray(followUpsRaw) ? followUpsRaw : []
    return new Set(list.map(f => String(f.tenantId ?? '')).filter(Boolean))
  }, [followUpsRaw])

  const { data: history = [] } = useQuery(
    'schedule-history',
    () => apiGet('/units/schedule/history?limit=150'),
    { enabled: view === 'history', staleTime: 15000 }
  )

  // W-19 (S529): filter-first unit list for the edit-reservation panel — only
  // units the server would actually accept: free for the edited dates (the
  // booking itself excluded) AND matching the stay's RV requirements. Same
  // shared predicate the 409 guards enforce (/units/available).
  const editAvailQuery = editForm && detailBooking && !detailBooking.isLease
    && editForm.checkIn && editForm.checkOut && editForm.checkOut > editForm.checkIn
    ? `/units/available?${new URLSearchParams({
        checkIn: editForm.checkIn, checkOut: editForm.checkOut,
        excludeBookingId: detailBooking.id,
        requiredSiteLayout: editForm.requiredSiteLayout || 'none',
        requiredAmpService: editForm.requiredAmpService || 'none',
        // 10/24: a stay being moved keeps its rig, so the sites offered for the
        // move are only the ones it fits on.
        ...(editForm.rigLengthFt ? { rigLengthFt: String(editForm.rigLengthFt) } : {}),
      })}`
    : null
  const { data: editAvailableUnits } = useQuery(
    ['units-available', editAvailQuery],
    () => apiGet<any[]>(editAvailQuery!),
    { enabled: !!editAvailQuery, keepPreviousData: true, staleTime: 15000 }
  )

  // ── Reservations tab data + mutations (ported from BookingsPage) ──
  const resvQueryString = useMemo(() => {
    const p: string[] = []
    if (resvStatus) p.push(`status=${encodeURIComponent(resvStatus)}`)
    if (resvSource) p.push(`source=${encodeURIComponent(resvSource)}`)
    if (resvFrom) p.push(`from=${encodeURIComponent(resvFrom)}`)
    if (resvTo) p.push(`to=${encodeURIComponent(resvTo)}`)
    if (resvSearch) p.push(`q=${encodeURIComponent(resvSearch)}`)
    return p.length ? `?${p.join('&')}` : ''
  }, [resvStatus, resvSource, resvFrom, resvTo, resvSearch])

  const { data: resvList = [], isLoading: resvLoading } = useQuery<ResvBooking[]>(
    ['bookings', resvQueryString],
    () => apiGet<ResvBooking[]>(`/bookings${resvQueryString}`),
    { enabled: view === 'reservations', staleTime: 30000 },
  )

  // S191: acknowledge a booking (mark guest signed property rules).
  const ackMut = useMutation(
    (booking: ResvBooking) =>
      apiPatch(`/units/${booking.unitId}/bookings/${booking.id}/acknowledge`),
    { onSuccess: () => qc.invalidateQueries(['bookings']) },
  )

  // Guest-agent change requests (S501 track): open stay-change asks recorded
  // by the guest agent. The host approves/declines here; approving is an
  // acknowledgment, not an automatic booking edit.
  const { data: changeRequests = [] } = useQuery<ChangeRequest[]>(
    ['booking-change-requests'],
    () => apiGet<ChangeRequest[]>('/bookings/change-requests'),
    // Endpoint is perm-gated (S526): don't fire it for a user who only holds
    // bookings.view — they'd 403 while on the Reservations tab.
    { enabled: (view === 'reservations' || view === 'requests') && can('bookings.change_requests'), staleTime: 30000 },
  )
  const resolveMut = useMutation(
    ({ id, status }: { id: string; status: 'approved' | 'declined' }) =>
      apiPatch(`/bookings/change-requests/${id}`, { status }),
    { onSuccess: () => qc.invalidateQueries(['booking-change-requests']) },
  )

  // ── Booking Page tab data (ported from BookingSitesPage) ──
  const { data: bpProperties = [] } = useQuery<any[]>(
    'properties',
    () => apiGet('/properties'),
    { enabled: view === 'booking_page', staleTime: 30000 },
  )
  // Default to the first property once loaded.
  useEffect(() => { if (!bpPropId && bpProperties.length) setBpPropId(bpProperties[0].id) }, [bpProperties])
  // Load the selected property's booking-site config.
  useEffect(() => {
    if (!bpPropId) return
    setBpMsg(''); setBpErr('')
    apiGet(`/properties/${bpPropId}/booking-config`)
      // S550: prefill a blank slug with the server's suggestion —
      // name + city ("oak-park-yarnell"), street number on collision.
      .then((cfg: any) => setBpCfg(cfg?.slug || !cfg?.suggestedSlug ? cfg : { ...cfg, slug: cfg.suggestedSlug }))
      .catch(() => setBpCfg(null))
  }, [bpPropId])
  const saveBookingConfig = async () => {
    setBpSaving(true); setBpMsg(''); setBpErr('')
    try {
      const num = (v: any) => (v === '' || v == null ? null : Number(v))
      const updated = await apiPatch(`/properties/${bpPropId}/booking-config`, {
        slug: bpCfg.slug || null,
        enabled: bpCfg.enabled,
        intro: bpCfg.intro || null,
        depositPct: Number(bpCfg.depositPct),
        monthlyDeposit: num(bpCfg.monthlyDeposit),
        utilitiesBilled: bpCfg.utilitiesBilled !== false,
        officePhone: bpCfg.officePhone?.trim() || null,
        officeEmail: bpCfg.officeEmail?.trim() || null,
        officeHours: bpCfg.officeHours?.trim() || null,
        nightlyRate: num(bpCfg.nightlyRate),
        weeklyRate: num(bpCfg.weeklyRate),
        monthlyRate: num(bpCfg.monthlyRate),
      })
      setBpCfg(updated)
      setBpMsg('Saved.')
    } catch (e: any) {
      setBpErr(e?.response?.data?.error || e.message || 'Could not save')
    }
    setBpSaving(false)
  }
  const bpPublicUrl = bpCfg?.slug ? STOREFRONT_TEMPLATE.replace('{slug}', bpCfg.slug) : null

  // ── S547: property-website content (photos + FAQs) ──
  const { data: bpPhotos = [] } = useQuery<any[]>(
    ['site-photos', bpPropId],
    () => apiGet(`/properties/${bpPropId}/site-photos`),
    { enabled: view === 'booking_page' && !!bpPropId },
  )
  const { data: bpFaqs = [] } = useQuery<any[]>(
    ['property-faqs', bpPropId],
    () => apiGet(`/properties/${bpPropId}/faqs`),
    { enabled: view === 'booking_page' && !!bpPropId },
  )
  const [bpFaqDraft, setBpFaqDraft] = useState({ question: '', answer: '' })
  const [bpUploading, setBpUploading] = useState(false)
  const uploadSitePhotos = async (files: FileList | null) => {
    if (!files?.length || !bpPropId) return
    setBpUploading(true); setBpErr('')
    try {
      const fd = new FormData()
      Array.from(files).forEach(f => fd.append('photos', f))
      await apiPost(`/properties/${bpPropId}/site-photos`, fd)
      qc.invalidateQueries(['site-photos', bpPropId])
    } catch (e: any) {
      setBpErr(e?.response?.data?.error || 'Upload failed')
    }
    setBpUploading(false)
  }
  const deleteSitePhoto = async (photoId: string) => {
    if (!await appConfirm('Remove this photo from the website?')) return
    await apiDelete(`/properties/${bpPropId}/site-photos/${photoId}`)
    qc.invalidateQueries(['site-photos', bpPropId])
  }
  const captionSitePhoto = async (photoId: string, current: string | null) => {
    const caption = await appPrompt('Photo caption (blank to clear):', { defaultValue: current || '' })
    if (caption === null) return
    await apiPatch(`/properties/${bpPropId}/site-photos/${photoId}`, { caption: caption || null })
    qc.invalidateQueries(['site-photos', bpPropId])
  }
  const addFaq = async () => {
    if (!bpFaqDraft.question.trim() || !bpFaqDraft.answer.trim()) return
    await apiPost(`/properties/${bpPropId}/faqs`, { question: bpFaqDraft.question.trim(), answer: bpFaqDraft.answer.trim() })
    setBpFaqDraft({ question: '', answer: '' })
    qc.invalidateQueries(['property-faqs', bpPropId])
  }
  const editFaq = async (f: any) => {
    const question = await appPrompt('Question:', { defaultValue: f.question })
    if (question === null) return
    const answer = await appPrompt('Answer:', { defaultValue: f.answer })
    if (answer === null) return
    if (!question.trim() || !answer.trim()) return
    await apiPatch(`/properties/${bpPropId}/faqs/${f.id}`, { question: question.trim(), answer: answer.trim() })
    qc.invalidateQueries(['property-faqs', bpPropId])
  }
  const deleteFaq = async (faqId: string) => {
    if (!await appConfirm('Delete this FAQ?')) return
    await apiDelete(`/properties/${bpPropId}/faqs/${faqId}`)
    qc.invalidateQueries(['property-faqs', bpPropId])
  }

  const resvTotalAmount = resvList.reduce((s, b) => s + (parseFloat(String(b.totalAmount || 0)) || 0), 0)

  // S191: which bookings still need a property-rules acknowledgment (toggle on,
  // not yet signed, and not a closed/cancelled state — no point chasing acks there).
  const needsAckResv = (b: ResvBooking) =>
    b.requiresBookingAcknowledgment
    && !b.acknowledgmentSignedAt
    && b.status !== 'cancelled'
    && b.status !== 'checked_out'
    && b.status !== 'no_show'
  const pendingAckCount = resvList.filter(needsAckResv).length

  const units: any[] = schedule?.units || []
  // The property's work-trade hours setting, for the picker's placeholder.
  const wtPropertyId = (resvWorkTrade && pickedUnit?.propertyId)
    || (editWorkTrade && units.find((u: any) => u.id === editForm?.unitId)?.propertyId) || null
  const { data: wtTarget } = useQuery<any>(['wt-target', wtPropertyId],
    () => apiGet(`/work-trade/property/${wtPropertyId}/target`),
    { enabled: !!wtPropertyId && can('work_trade.manage'), staleTime: 60_000, retry: false })


  const bookings: any[] = schedule?.bookings || []
  const leases: any[] = schedule?.leases || []
  // S649: out-of-order windows — blocked time on a site (ends_on exclusive).
  const outOfOrder: any[] = schedule?.outOfOrder || []
  const oooFor = (unitId: string, date: string) =>
    outOfOrder.find((o: any) => o.unitId === unitId && date >= o.startsOn && (!o.endsOn || date < o.endsOn))
  const oooOverlaps = (unitId: string, ci: string, co: string) =>
    outOfOrder.some((o: any) => o.unitId === unitId && o.startsOn < co && (!o.endsOn || o.endsOn > ci))
  // S652 (Nic): "when you mark it back in service, have it still show that."
  // Outages that are over — drawn, never blocking.
  const outOfOrderHistory: any[] = schedule?.outOfOrderHistory || []
  const oooPastFor = (unitId: string, date: string) =>
    outOfOrderHistory.find((o: any) => o.unitId === unitId && date >= o.startsOn && date < o.endedOn)
  const [oooUnit, setOooUnit] = useState<any | null>(null)
  // 10/4 (decisions #38): the Check out window — opened from a stay, or from
  // the owner's to-do / notification (?checkout=<booking>&unit=<site>).
  const [checkOutFor, setCheckOutFor] = useState<{ unitId: string; bookingId: string } | null>(null)
  // 10/22 (Nic): the day a leased resident is leaving, so the site stops being
  // blocked out indefinitely and can take reservations after it.
  const [leaveDateFor, setLeaveDateFor] = useState<any>(null)
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const sp = new URLSearchParams(location.search)
    const b = sp.get('checkout'), u = sp.get('unit')
    if (b && u) setCheckOutFor({ unitId: u, bookingId: b })
    // 10/5: the landlord's "Long stay — no lease" notice opens the stay itself
    // (?booking=<stay>&unit=<site>), wherever it sits on the calendar.
    const open = sp.get('booking')
    if (open && u) {
      apiGet<any[]>(`/units/${u}/bookings`).then((rows) => {
        const hit = (rows || []).find((r: any) => r.id === open)
        if (hit) setDetailBooking({ ...hit, checkIn: dayOnly(hit.checkIn), checkOut: dayOnly(hit.checkOut) })
        else toast.error('That reservation is no longer on the schedule.')
      }).catch(() => toast.error('That reservation could not be opened.'))
    }
  }, [location.search])
  const days = getDaysInRange(fromDate, toDate)

  // S526 (Nic): the create form is contact + dates ONLY. No total input (the
  // backend prices authoritatively from unit/property rates — nobody pays on
  // this screen), no fee, no lease-type dropdown: the billing type is implied
  // by stay length (≥30 monthly, ≥7 weekly, else nightly), clamped to the
  // unit's allowed list.
  // 10/24 (Nic) — THE RESERVATION WINDOW DOES NOT CLOSE BY ACCIDENT.
  //
  //   "I want to make it where I can't click off of that window unless I click
  //    confirm or abandon the reservation. Clicking anywhere else on the screen
  //    on GAM's website should not close out of that pop-up window. That way I
  //    can't accidentally undo a middle of a reservation with an accidental
  //    button push."
  //
  // The backdrop used to close it, and closing wipes every field — so one stray
  // click half way through typing a guest in threw the lot away with nothing
  // asked and nothing kept. Nothing had been written to the server (the form
  // only exists in the browser until Create), so the cost was never a bad
  // record; it was the typing, which is the thing the desk actually spends.
  //
  // Now: the backdrop does nothing at all, and the ✕ asks first — but only when
  // there is something to lose. An untouched form closes on one click, because
  // making somebody confirm away a blank form teaches them to click through
  // the prompt that matters.
  const bookingFormDirty = () =>
    !!(bookFirst.trim() || bookLast.trim() || newBooking.guestEmail.trim() || newBooking.guestPhone.trim()
       || newBooking.checkIn || newBooking.checkOut || newBooking.totalAmount.trim() || newBooking.notes.trim())
  const [abandonAsk, setAbandonAsk] = useState(false)
  const askCloseBookModal = () => { if (bookingFormDirty()) setAbandonAsk(true); else closeBookModal() }
  const closeBookModal = () => {
    setAbandonAsk(false)
    setBookingModal({show:false,unit:null})
    // 10/17: back to "no money here", which is what this form has always done.
    setBookPayMode('none')
    setBookFirst(''); setBookLast('')
    setNewBooking({ guestName:'', guestEmail:'', guestPhone:'', leaseType:'nightly', checkIn:'', checkOut:'', totalAmount:'', notes:'' })
  }
  // 10/5 (Nic, R2): "it's the front counter person that's clicking lease or no
  // lease." A save that makes a stay 30+ nights in a row is refused with
  // 'stay_terms_needed' until the desk answers; the answer then goes with the
  // same save, sent again (withTerms takes it once).
  const withTerms = () => {
    const t = termsAnswer.current
    termsAnswer.current = null
    lastTerms.current = t
    return t ? { stayTerms: t } : {}
  }
  const askTermsIf = (e: any, resend: () => void): boolean => {
    const body = e?.response?.data
    if (e?.response?.status !== 409 || body?.code !== 'stay_terms_needed') return false
    setTermsAsk({ question: body.error, resend: (t) => { termsAnswer.current = t; setTermsAsk(null); resend() } })
    return true
  }
  // A2: the pay route picked in the window below, taken once by the next save.
  const withPayRoute = (fallback: 'link' | 'register' | null) => {
    const m = payRouteAnswer.current ?? fallback
    payRouteAnswer.current = null
    // 10/6 (Nic): the third choice — no background check, so nothing to pay for it.
    if (m === 'returning') {
      sentPayRoute.current = fallback
      return { returningGuest: true, ...(fallback ? { sendDepositLink: fallback === 'link', payAtRegister: fallback === 'register' } : {}) }
    }
    sentPayRoute.current = m === 'link' || m === 'register' ? m : null
    return m ? { sendDepositLink: m === 'link', payAtRegister: m === 'register' } : {}
  }
  const askFeeRouteIf = (e: any, resend: () => void): boolean => {
    const body = e?.response?.data
    if (e?.response?.status !== 409 || body?.code !== 'screening_fee_route_needed') return false
    const terms = lastTerms.current
    setFeeRoute({
      message: body.error, canSendLink: !!body.canSendLink, returning: body.returning ?? null,
      resend: (m) => { payRouteAnswer.current = m; termsAnswer.current = terms; setFeeRoute(null); resend() },
    })
    return true
  }
  // What a new stay needs, said once it is saved — the server's own figures.
  const sayStaySaved = (stay: any) => {
    if (!stay) return
    if (stay.terms === 'lease' && stay.leaseId) toast('Lease chosen — a draft lease is waiting on the Leases page.')
    if (stay.screening === 'fee_due' && stay.screeningFee != null) {
      // M3: a change that made the stay need the check emails a pay link for its fee.
      if (stay.screeningFeeLink) {
        toast(`This stay is now more than three weeks, so check-in waits for a background check. `
          + `A pay link for its ${fmt(stay.screeningFee)} fee was emailed to ${stay.emailedTo || 'the guest'}.`)
      } else {
        toast(stay.screeningFeeUncollected
          ? `This stay needs a background check before check-in. Its ${fmt(stay.screeningFee)} fee has not been sent to the guest — add their email, or ring it up at the register.`
          : `This stay needs a background check before check-in. Its ${fmt(stay.screeningFee)} fee is on the stay's payment.`)
      }
    } else if (stay.screening === 'on_file') {
      toast('This stay needs a background check before check-in — the guest already has one on file.')
    } else if (stay.screening === 'returning') {
      toast('Returning guest — no background check needed for this stay.')
    }
    if (stay.workTrade?.rentTraded) toast('Work trade — the site is covered, so there is nothing to pay for it.')
  }
  // 10/17 (Nic) — SAY WHAT THE SAVE ACTUALLY DID WITH THE MONEY.
  //
  // "when I go to add a reservation, it won't generate a pay link from doing the
  // reservation... So we have some important things to address there before the
  // schedule starts getting convoluted."
  //
  // The link and the register ticket were both being created and this screen
  // threw the answer away: it closed the form, refreshed the calendar, and the
  // desk had no way to tell a sent link from a failed one. Worse, the server
  // deliberately does NOT roll a reservation back when the hand-off fails (the
  // site is held and somebody has been told they have it), so a silent failure
  // left a held site, no link and nobody aware of it.
  //
  // `asked` is the route the desk picked, so a save that came back with neither
  // a link nor a ticket is reported as the failure it is, in words that say what
  // IS true: the reservation stands, the site is held, the money part did not
  // happen.
  const sayPayRouteDone = (data: any, asked: 'link' | 'register' | null) => {
    const guest = data?.guestName || 'the guest'
    if (data?.depositLink?.url) {
      // 10/18 (review): the server says whether the guest really got the email.
      setResvLink({
        url: data.depositLink.url, emailedTo: data?.guestEmail || null, guest,
        isDeposit: true, neverExpires: true,
        emailedNow: data.depositLink.emailed !== false,
        emailFailed: data.depositLink.emailed === false,
        // 10/24 (Nic): straight off making the reservation. No link on screen
        // here — see the window below.
        justBooked: true,
      })
      return
    }
    if (data?.registerTicketId) {
      toast(`A ticket for ${guest} is waiting at the register — ringing it up confirms this reservation.`)
      return
    }
    // Nothing to collect is not a failure: this park takes no deposit on a stay
    // like this, so there was never a link to send.
    if (asked === 'link' && data?.stay?.depositNothingOwed) {
      toast(`${guest} owes no deposit on this stay, so no link was sent — the site is held for them.`)
      return
    }
    // Both of these name something that exists today. 10/18: the schedule now
    // HAS a send of its own — "Ask for the deposit" on the reservation — so a
    // link that did not go out is a button away instead of a trip to the
    // register.
    if (asked === 'link') {
      toast.error(`The reservation is on the schedule and the site is held, but no deposit link went out to ${guest}. `
        + 'Open the reservation and press "Ask for the deposit", or take it at the register.')
    } else if (asked === 'register') {
      toast.error(`The reservation is on the schedule and the site is held, but no register ticket was made for ${guest}. `
        + 'Ring the stay up at the register with the site and the dates.')
    }
  }
  const createBookingMut = useMutation(
    () => {
      const nights = Math.round((new Date(newBooking.checkOut+'T12:00:00').getTime() - new Date(newBooking.checkIn+'T12:00:00').getTime())/86400000)
      let leaseType = nights >= 30 ? 'month_to_month' : nights >= 7 ? 'weekly' : 'nightly'
      const allowed = bookingModal.unit?.leaseTypesAllowed
      if (allowed?.length && !allowed.includes(leaseType)) leaseType = allowed[0]
      return apiPost(`/units/${bookingModal.unit?.id}/bookings`, {
        guestName: `${bookFirst.trim()} ${bookLast.trim()}`.trim(),
        guestEmail: newBooking.guestEmail.trim(),
        guestPhone: newBooking.guestPhone.trim(),
        leaseType, checkIn: newBooking.checkIn, checkOut: newBooking.checkOut,
        source: 'direct',
        ...withTerms(),
        // 10/17 (Nic): "when I go to add a reservation, it won't generate a pay
        // link from doing the reservation." THIS is the reservation he means —
        // the per-site "+ Book" button. It passed no pay route at all, so the
        // stay went straight to confirmed with no link and no ticket, and the
        // only way either flag ever reached the server was as a side effect of
        // the background-check question (which only a 22+ night stay asks). Now
        // the desk is asked, and 'none' keeps what this form always did.
        ...withPayRoute(bookPayMode === 'none' ? null : bookPayMode),
      })
    },
    {
      onSuccess: (r: any) => { qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history'); sayStaySaved(r?.data?.stay); sayPayRouteDone(r?.data, sentPayRoute.current); closeBookModal() },
      onError: (e: any) => {
        if (askTermsIf(e, () => createBookingMut.mutate())) return
        if (askFeeRouteIf(e, () => createBookingMut.mutate())) return
        toast.error(e?.response?.data?.error || 'Could not create the reservation.')
      },
    }
  )

  // "New Reservation" flow: dates → contact → pick an available unit (the pick
  // completes it). The per-unit "+ Book" buttons keep their own unit context
  // via bookingModal.
  // 10/6 (Nic): nights are check-out − check-in, the same count the server
  // keeps ("leaving on the 5th" from the 30th is five nights, not six).
  const resvNights = (() => {
    const { checkIn, checkOut } = newBooking
    if (!checkIn || !checkOut || checkOut <= checkIn) return 0
    return stayNightsBetween(checkIn, checkOut)
  })()
  // The booking's lease type names its length (the server keeps it); the
  // PRICE is not tiered by it (below).
  const resvType = resvNights >= 30 ? 'month_to_month' : resvNights >= 7 ? 'weekly' : 'nightly'
  // 10/6 (Nic): "It should be charging them the price, the configuration
  // that's going to be the cheapest option for them." The shared priceStay —
  // the cheapest whole months, weeks and nights that cover the stay, at the
  // UNIT's rate with the PROPERTY rate as the fallback, plus short-term tax —
  // the same function POST /units/:id/bookings, the booking site, a pay link
  // and the register price with.
  const stayPriceForUnit = (u: any) => priceStay(
    { nightly: u.nightlyRate ?? u.propertyNightlyRate,
      weekly:  u.weeklyRate  ?? u.propertyWeeklyRate,
      monthly: u.monthlyRate ?? u.propertyMonthlyRate },
    Number(u.propertyTaxRate || 0),
    newBooking.checkIn,
    resvNights,
  )
  const resvGuestName = `${resvFirst.trim()} ${resvLast.trim()}`.trim()
  // S652 (Nic): "When I back out and it's not a completed reservation, it just
  // abandons everything... It doesn't save all that stuff as a drafted state.
  // It's more like a browser than anything else." Nothing was written to the
  // database on the way here, so there is nothing to unwind — only screen state
  // to drop, and all of it goes.
  const closeNewResv = () => {
    setNewResvOpen(false); setResvError(''); setResvFirst(''); setResvLast(''); setResvLayout('none'); setResvAmp('none'); setResvRig(''); setResvAvoid('')
    setShowAvail(false); setPickedUnit(null); setLockSite(false); setPayMode('link')
    setResvReturning(false); setResvWorkTrade(false); setResvWt(defaultWorkTradeTerms())
    setNewBooking({ guestName:'', guestEmail:'', guestPhone:'', leaseType:'nightly', checkIn:'', checkOut:'', totalAmount:'', notes:'' })
  }
  // Combined RV-requirement mismatch reasons for a unit (layout + amp). Empty =
  // compatible. Used by the new-reservation cards, drag-move, and edit panel so
  // one guardrail covers both constraints with a single warning/confirm.
  const rvMismatchReasons = (reqLayout: any, reqAmp: any, u: any, rigFt?: any): string[] => {
    const r: string[] = []
    if (isSiteLayoutMismatch(reqLayout, u?.rvSiteLayout))
      r.push(`needs ${RV_SITE_LAYOUT_LABEL[reqLayout as keyof typeof RV_SITE_LAYOUT_LABEL]}, unit is ${RV_SITE_LAYOUT_LABEL[(u?.rvSiteLayout||'none') as keyof typeof RV_SITE_LAYOUT_LABEL]}`)
    if (isAmpServiceMismatch(reqAmp, u?.rvAmpService))
      r.push(`needs ${RV_AMP_SERVICE_LABEL[reqAmp as keyof typeof RV_AMP_SERVICE_LABEL]}, unit is ${RV_AMP_SERVICE_LABEL[(u?.rvAmpService||'none') as keyof typeof RV_AMP_SERVICE_LABEL]}`)
    // 10/24 (Nic): said in feet, because that is the thing the clerk has to
    // repeat to the guest — "that spot is 30 foot, your rig is 37".
    if (isRigTooLongForSite(rigFt, u?.rvMaxRigLengthFt))
      r.push(`rig is ${Number(rigFt)} ft, this site takes ${Number(u?.rvMaxRigLengthFt)} ft`)
    return r
  }
  // Picking a unit submits the reservation with the stay total computed for it.
  const createResvMut = useMutation(
    (u: any) => apiPost(`/units/${u.id}/bookings`, {
      guestName:resvGuestName,
      guestEmail:newBooking.guestEmail.trim() || null,
      guestPhone:newBooking.guestPhone.trim() || null,
      leaseType:resvType, checkIn:newBooking.checkIn, checkOut:newBooking.checkOut,
      nightlyRate:(u.nightlyRate ?? u.propertyNightlyRate)!=null?Number(u.nightlyRate ?? u.propertyNightlyRate):null,
      weeklyRate:(u.weeklyRate ?? u.propertyWeeklyRate)!=null?Number(u.weeklyRate ?? u.propertyWeeklyRate):null,
      totalAmount:stayPriceForUnit(u).total, source:'direct',
      requiredSiteLayout: resvLayout,
      requiredAmpService: resvAmp,
      rigLengthFt: resvRig.trim() === '' ? null : Number(resvRig),
      // S652: movable unless the counter promised them that exact space.
      lockedToUnit: lockSite,
      // S653: the sites they asked not to have, at the property this stay is at.
      avoidedUnitIds: avoidedIdsAt(u.propertyId),
      // Nic's two exits. A deposit link is right for somebody who rang in
      // February about March, and absurd for a man standing at the desk with
      // his rig idling outside — he pays at the till, three feet away.
      // 10/6: a work trade covering rent has nothing to pay for the site — the
      // reservation is confirmed now (a check's fee, if due, asks how).
      ...withPayRoute(resvWorkTrade && resvWt.coveredCharges.includes('rent') ? null : payMode),
      ...withTerms(),
      ...(resvReturning ? { returningGuest: true } : {}),
      ...(resvWorkTrade ? { workTrade: workTradeTermsPayload(resvWt) } : {}),
    }),
    {
      onSuccess: (r: any) => { qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history'); sayStaySaved(r?.data?.stay); sayPayRouteDone(r?.data, sentPayRoute.current); closeNewResv() },
      onError: (e: any, u: any) => {
        if (askTermsIf(e, () => createResvMut.mutate(u))) return
        if (askFeeRouteIf(e, () => createResvMut.mutate(u))) return
        setResvError(e?.response?.data?.error || e?.message || 'Could not create the reservation')
      },
    }
  )
  // All units full for the dates → add the guest to a property-wide waitlist
  // (one per distinct property among the units). Promoted on the next opening.
  const waitlistMut = useMutation(
    async () => {
      const propIds = Array.from(new Set(units.map((u: any) => u.propertyId).filter(Boolean)))
      for (const pid of propIds) {
        await apiPost(`/properties/${pid}/waitlist`, {
          guestName: resvGuestName,
          guestEmail: newBooking.guestEmail.trim(),
          guestPhone: newBooking.guestPhone.trim() || null,
          checkIn: newBooking.checkIn, checkOut: newBooking.checkOut,
        })
      }
    },
    { onSuccess: () => { setResvError(''); closeNewResv() }, onError: (e: any) => setResvError(e?.message || 'Could not add to the waitlist') }
  )

  const updateTypeMut = useMutation(
    () => apiPatch(`/units/${typeModal.unit?.id}/type`, typeForm),
    { onSuccess: () => { qc.invalidateQueries('schedule'); setTypeModal({show:false,unit:null}) } }
  )

  // 10/3: a reservation as a save hands it back (camelized), laid over the open
  // stay. The schedule's own rows are the same columns (b.*), so the whole row
  // goes over; the site's number and park come from the site list.
  const mergeLatestStay = (prev: any, b: any) => {
    const site = units.find((u: any) => u.id === b?.unitId)
    return {
      ...prev, ...b,
      checkIn: b?.checkIn ? dayOnly(b.checkIn) : prev.checkIn,
      checkOut: b?.checkOut ? dayOnly(b.checkOut) : prev.checkOut,
      unitNumber: site?.unitNumber ?? prev.unitNumber,
      propertyName: site?.propertyName ?? prev.propertyName,
    }
  }
  // 10/3 (staff screens self-heal): a save refused because somebody else
  // changed the stay a moment before (409 'reservation_changed'). The schedule
  // and its history are fetched again, the open stay shows the stay as it is
  // now (the refusal carries it), an open Edit form is filled again from it so
  // a second save can't write over the other change, and the refusal's words
  // are shown once. True when that is what happened.
  const takeLatestIfChanged = (e: any, opts: { inForm?: boolean } = {}): boolean => {
    const body = e?.response?.data
    if (e?.response?.status !== 409 || body?.code !== 'reservation_changed') return false
    qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history')
    const latest = body?.data ? camelizeKeys(body.data) as any : null
    const words = body?.error || 'This reservation was just changed by someone else, so your change was not saved.'
    if (latest?.id) {
      setDetailBooking((prev: any) => prev && prev.id === latest.id ? mergeLatestStay(prev, latest) : prev)
    }
    if (opts.inForm) {
      if (latest?.id) startEdit(mergeLatestStay(detailBooking ?? {}, latest))
      setEditError(words)
    } else {
      toast.error(words)
    }
    return true
  }
  const saveError = (e: any, fallback: string) => e?.response?.data?.error || fallback
  // 10/6 (Nic): a site the guest asked not to have. The schedule's own moves
  // skip it; a person moving them there is asked first — "She asked not to be
  // on RV 14. Move her there anyway?" — and the move is sent again, confirmed.
  const askAvoidedIf = (e: any, resend: () => void): boolean => {
    const body = e?.response?.data
    if (e?.response?.status !== 409 || body?.code !== 'avoided_site') return false
    appConfirm(body.error, { confirmLabel: 'Move them there' }).then(ok => { if (ok) resend() })
    return true
  }
  const avoidedWords = (b: any, unitNumber: string) =>
    `${(b?.guestName || '').trim() || 'This guest'} asked not to be on ${unitNumber}.`
  // The same question when the server is the one that asked it — a page that
  // loaded before the stay was pinned, or an Edit that changed the site.
  const askLockedIf = (e: any, resend: () => void): boolean => {
    const body = e?.response?.data
    if (e?.response?.status !== 409 || body?.code !== 'locked_site') return false
    appConfirm(body.error, { confirmLabel: 'Move them there' }).then(ok => { if (ok) resend() })
    return true
  }
  // 10/12 (Nic, G6): a shorter stay past rent a payment was tried on — the
  // landlord chooses here, at the moment: take those charges off (anything
  // paid on them goes back to the guest as credit), or keep them owed. The
  // change is sent again with the answer; Cancel saves nothing.
  // 10/13 evening (Nic): "Take those charges off" is for "anyone who can schedule
  // reservations and take payments" (and the owner) — the server sends only the answers this person may
  // give (and says why when "Take those charges off" is not one of them).
  const askShortenedIf = (e: any, resend: (choice: string) => void): boolean => {
    const body = e?.response?.data
    if (e?.response?.status !== 409 || body?.code !== 'stay_shortened_attempted') return false
    // Only the answers the server offered; "Keep them owed" always (lib/earlyCheckOut).
    appChoose(pastEndQuestion(body.error, body.voidRefused), {
      title: 'Rent a payment was tried on',
      choices: pastEndChoices(body?.choices),
    }).then(choice => { if (choice) resend(choice) })
    return true
  }

  const moveBookingMut = useMutation(
    (payload: {bookingId:string; unitId:string; checkIn:string; checkOut:string; overrideAvoided?: boolean; overrideLocked?: boolean; pastEndAttempted?: string}) =>
      apiPatch(`/units/${payload.unitId}/bookings/${payload.bookingId}`, {
        unitId: payload.unitId, checkIn: payload.checkIn, checkOut: payload.checkOut, ...withTerms(),
        ...(payload.overrideAvoided ? { overrideAvoided: true } : {}),
        // 10/20 (Nic): confirmed after "… so RV 14 is the number they have" (askLockedIf).
        ...(payload.overrideLocked ? { overrideLocked: true } : {}),
        ...(payload.pastEndAttempted ? { pastEndAttempted: payload.pastEndAttempted } : {}),
      }),
    {
      // 10/5 (M3): a drag that made the stay need a background check says what was sent.
      onSuccess: (r: any) => {
        qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history')
        sayStaySaved(r?.stay)
        // 10/20 (Nic): a pinned stay moved by hand — whether the guest has
        // been told their space number changed, or a call is owed.
        if (r?.siteMoved) toast(r.siteMoved)
      },
      onError: (e: any, payload) => {
        if (takeLatestIfChanged(e)) return
        if (askTermsIf(e, () => moveBookingMut.mutate(payload))) return
        if (askLockedIf(e, () => moveBookingMut.mutate({ ...payload, overrideLocked: true }))) return
        if (askAvoidedIf(e, () => moveBookingMut.mutate({ ...payload, overrideAvoided: true }))) return
        if (askShortenedIf(e, (choice) => moveBookingMut.mutate({ ...payload, pastEndAttempted: choice }))) return
        toast.error(saveError(e, 'Cannot move reservation — date conflict on that unit.'))
      }
    }
  )

  // Final fix (fix pass 1, decisions #53): Cancel reservation no longer sends
  // a bare {status:'cancelled'} after a one-line "Cancel this reservation?".
  // It opens CancelReservationModal (below), which reads fresh what the cancel
  // changes — the lease drafted with the stay, the people on it by name, the
  // move-in bill it zeroes, what stays owed — and sends the total it showed.

  // S559: front-desk check-in. Blocked server-side when the previous guest's
  // submeter hasn't been read (same-day turnover) — the 409 carries the
  // pending meters so we fold the blind closing read into check-in, then
  // retry. A landlord may override for a broken meter.
  const [checkInPrompt, setCheckInPrompt] = useState<{ booking: any; meters: any[]; canOverride: boolean } | null>(null)
  const [checkInBusy, setCheckInBusy] = useState(false)
  const doCheckIn = (b: any, override = false) =>
    apiPatch(`/units/${b.unitId}/bookings/${b.id}`, { status: 'checked_in', ...(override ? { overrideMeterRead: true } : {}) })
  // 10/5 (Nic, R9): a stay of more than three weeks checks in only once its
  // background check is back and decided. The refusal is shown as it is, in
  // its own window — there is no override.
  const screeningWaitIf = (e: any): boolean => {
    const data = e?.response?.data
    if (e?.response?.status !== 409 || data?.code !== 'screening_pending') return false
    setScreeningWait({ message: data.error, waitingOn: data.waitingOn })
    qc.invalidateQueries('schedule')
    return true
  }
  const checkInMut = useMutation((b: any) => doCheckIn(b), {
    onSuccess: () => { qc.invalidateQueries('schedule'); toast('Guest checked in'); setDetailBooking(null) },
    onError: (e: any) => {
      if (takeLatestIfChanged(e)) return
      if (screeningWaitIf(e)) return
      const data = e?.response?.data
      if (data?.code === 'meter_read_due') { setCheckInPrompt({ booking: detailBooking, meters: data.meters || [], canOverride: !!data.canOverride }); return }
      toast.error(data?.error || 'Could not check the guest in.')
    },
  })
  const submitCheckInReads = async (values: Record<string, string>) => {
    if (!checkInPrompt) return
    setCheckInBusy(true)
    try {
      // 10/20: keep what the answer says about each read. A closing read taken
      // at check-in can come back billing nothing — the cycle was already billed
      // off the monthly run, or the figure is one the landlord has to look at
      // first — and this screen discarded that and said "Read recorded" either
      // way. ONE line for the whole check-in, not one per meter.
      const notes: string[] = []
      for (const m of checkInPrompt.meters) {
        const r: any = await apiPost(`/utility/meters/${m.meterId}/reads`, { readingValue: Number(values[m.meterId]), reason: m.reason, ...(m.leaseId ? { leaseId: m.leaseId } : {}) })
        const note = r?.data?.billingNote
        if (note && !notes.includes(note)) notes.push(note)
      }
      await doCheckIn(checkInPrompt.booking)
      qc.invalidateQueries('schedule')
      toast(notes.length
        ? `Read recorded — guest checked in. ${notes.map(sentence).join(' ')}`
        : 'Read recorded — guest checked in')
      setCheckInPrompt(null); setDetailBooking(null)
    } catch (e: any) {
      if (takeLatestIfChanged(e)) { setCheckInPrompt(null); return }
      if (screeningWaitIf(e)) { setCheckInPrompt(null); return }
      toast.error(e?.response?.data?.error || 'Could not complete check-in.')
    }
    finally { setCheckInBusy(false) }
  }
  const overrideCheckIn = async () => {
    if (!checkInPrompt) return
    setCheckInBusy(true)
    try {
      await doCheckIn(checkInPrompt.booking, true)
      qc.invalidateQueries('schedule')
      toast('Checked in — meter read still due')
      setCheckInPrompt(null); setDetailBooking(null)
    } catch (e: any) {
      if (takeLatestIfChanged(e)) { setCheckInPrompt(null); return }
      if (screeningWaitIf(e)) { setCheckInPrompt(null); return }
      toast.error(e?.response?.data?.error || 'Could not check in.')
    }
    finally { setCheckInBusy(false) }
  }

  // 10/18 (Nic) — ASK A RESERVATION THAT IS ALREADY ON THE BOARD FOR ITS DEPOSIT.
  //
  //   "yeah, let's add a button so that we can collect deposits from people
  //    that haven't done it for their stays."
  //
  // A deposit link could only ever go out at the one moment a reservation was
  // made, so the phone calls and the soft holds had no way to be asked
  // afterwards — and an unpaid reservation is the one a paying guest can take.
  // Same server path as the reservation form, so there is one deposit figure
  // and one link.
  //
  // Pressing it again hands back the link that is already out instead of
  // emailing the guest twice, and the window below says which happened.
  const askDepositMut = useMutation(
    (b: any) => apiPost(`/units/${b.unitId}/bookings/${b.id}/deposit-link`, {}),
    {
      onSuccess: (r: any, b: any) => {
        qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history')
        const sent = r?.data
        if (!sent?.link?.url) {
          toast.error('The deposit link did not come back — take the deposit at the register.')
          return
        }
        setResvLink({
          // 10/24 (Nic): asked FOR from a reservation that already exists —
          // somebody went looking for this link, so this is the one window that
          // hands it over.
          justBooked: false,
          url: sent.link.url,
          emailedTo: sent.sentTo || b?.guestEmail || null,
          guest: sent.guestName || b?.guestName || 'the guest',
          emailedNow: sent.emailedNow !== false,
          emailFailed: sent.emailFailed === true,
          // 10/18 (review): the server says whether what came back IS this
          // reservation's deposit link, so a link for the whole stay is never
          // read down the phone as the deposit.
          isDeposit: sent.link.isDeposit !== false,
          label: sent.link.label ?? null,
          amount: sent.link.amount ?? null,
          neverExpires: sent.link.neverExpires !== false,
        })
        // Out of the way, so the link is the thing on screen.
        setDetailBooking(null)
      },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not send the deposit link.'),
    }
  )

  // S547: snowbird lock toggle — pins the stay to its site, exempt from the
  // compressor / relocation / extend-fallback movers.
  const lockBookingMut = useMutation(
    (b: any) => apiPatch(`/units/${b.unitId}/bookings/${b.id}`, { lockedToUnit: !b.lockedToUnit }),
    {
      onSuccess: (updated: any, b: any) => {
        qc.invalidateQueries('schedule')
        setDetailBooking((prev: any) => prev ? { ...prev, lockedToUnit: updated?.lockedToUnit ?? !b.lockedToUnit } : prev)
        toast(updated?.lockedToUnit ?? !b.lockedToUnit ? 'Locked to its site — automatic scheduling will not move this stay.' : 'Unlocked — automatic scheduling may re-site this stay again.')
      },
      onError: (e: any) => { if (!takeLatestIfChanged(e)) toast.error(saveError(e, 'Could not update the site lock.')) },
    }
  )

  // 10/5 (Nic, R2/R4): a stay with no lease can be offered one later — the
  // same month-to-month draft a lease chosen at booking makes. It waits on the
  // Leases page for the landlord to review and send for signature.
  const offerLease = async (d: any) => {
    const ok = await appConfirm(
      'Draft a lease for this stay? It is month-to-month with no end date, so it holds the site for as long as '
      + 'they stay. The draft waits on your Leases page to be reviewed and sent for signature.',
      { title: 'Offer a lease', confirmLabel: 'Draft the lease' })
    if (!ok) return
    try {
      const r: any = await apiPost(`/units/${d.unitId}/bookings/${d.id}/offer-lease`)
      qc.invalidateQueries('schedule'); qc.invalidateQueries('leases')
      setDetailBooking((prev: any) => prev && prev.id === d.id ? { ...prev, stayLeaseId: r?.data?.leaseId, stayTerms: 'lease' } : prev)
      toast('Draft lease ready on the Leases page.')
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'The lease could not be drafted.')
    }
  }

  // Edit an existing reservation (guest contact, dates, unit, notes). The
  // backend reprices on a date/unit change and COALESCEs unchanged fields.
  const editBookingMut = useMutation(
    (vars: {orig:any; form:NonNullable<typeof editForm>; overrideAvoided?: boolean; overrideLocked?: boolean; pastEndAttempted?: string}) =>
      apiPatch(`/units/${vars.orig.unitId}/bookings/${vars.orig.id}`, {
        guestName: vars.form.guestName.trim() || null,
        guestEmail: vars.form.guestEmail.trim() || null,
        guestPhone: vars.form.guestPhone.trim() || null,
        checkIn: vars.form.checkIn,
        checkOut: vars.form.checkOut,
        unitId: vars.form.unitId,
        notes: vars.form.notes.trim() || null,
        requiredSiteLayout: vars.form.requiredSiteLayout,
        requiredAmpService: vars.form.requiredAmpService,
        rigLengthFt: vars.form.rigLengthFt,
        // S653: typed numbers → ids at the stay's property; [] clears the list.
        avoidedUnitIds: (() => {
          const toks = vars.form.avoid.split(/[,;\n]|\band\b/i).map(t => t.trim().toLowerCase().replace(/\s+/g, '')).filter(Boolean)
          const propId = units.find((u:any)=>u.id===vars.form.unitId)?.propertyId
          return units.filter((u:any)=>u.propertyId===propId && toks.includes(String(u.unitNumber||'').toLowerCase().replace(/\s+/g,''))).map((u:any)=>u.id)
        })(),
        ...withTerms(),
        // 10/6: confirmed after "They asked not to be on …" (askAvoidedIf).
        ...(vars.overrideAvoided ? { overrideAvoided: true } : {}),
        // 10/20 (Nic): confirmed after "… so RV 14 is the number they have" (askLockedIf).
        ...(vars.overrideLocked ? { overrideLocked: true } : {}),
        // 10/12 (G6): the landlord's answer for rent a payment was tried on (askShortenedIf).
        ...(vars.pastEndAttempted ? { pastEndAttempted: vars.pastEndAttempted } : {}),
        // 10/6 (Nic): returning guest, and the stay's work trade — ticked,
        // changed, or taken off (null). Left out when nothing about it changed.
        ...(editReturning && !vars.orig.returningGuestAt ? { returningGuest: true } : {}),
        // 10/6 (review): only a desk that may change work trades sends it, and
        // only when the tick or the terms changed — a desk without that
        // permission can still save a traded reservation's notes and dates.
        ...workTradeEditPayload({ canManage: can('work_trade.manage'), ticked: editWorkTrade, terms: editWt, original: vars.orig.workTrade }),
      }),
    {
      onSuccess: (resp:any) => {
        qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history')
        // apiPatch returns the already-unwrapped booking (r.data.data), and the
        // global middleware + axios interceptor camelize every key — so `resp`
        // IS the booking and its fields are camelCase (matches lockBookingMut).
        const b = resp
        setDetailBooking((prev:any)=> prev && b?.id ? mergeLatestStay(prev, b) : prev)
        setEditForm(null); setEditError('')
        // 10/5: what the longer stay needs (M3: the check's pay link, when one was emailed).
        sayStaySaved(b?.stay)
        // 10/6 (review): a returning guest's check fee that had already gone out came off.
        if (b?.returningFeeNote) toast(b.returningFeeNote)
        // 10/20 (Nic): the Edit form changes the site too, so it says the same
        // thing a drag does about a pinned stay that just moved.
        if (b?.siteMoved) toast(b.siteMoved)
      },
      onError: (e:any, vars) => {
        if (takeLatestIfChanged(e, { inForm: true })) return
        if (askTermsIf(e, () => editBookingMut.mutate(vars))) return
        if (askLockedIf(e, () => editBookingMut.mutate({ ...vars, overrideLocked: true }))) return
        if (askAvoidedIf(e, () => editBookingMut.mutate({ ...vars, overrideAvoided: true }))) return
        if (askShortenedIf(e, (choice) => editBookingMut.mutate({ ...vars, pastEndAttempted: choice }))) return
        setEditError(e?.response?.data?.error || e?.message || 'Could not save changes.')
      },
    }
  )
  const startEdit = (d:any) => {
    setEditError('')
    setEditForm({
      guestName: d.guestName || '', guestEmail: d.guestEmail || '', guestPhone: d.guestPhone || '',
      // dayOnly: d.checkIn/checkOut arrive as full ISO timestamps (S526 rule) —
      // raw they leave the type="date" inputs blank and fail the
      // /units/available date validation.
      checkIn: dayOnly(d.checkIn), checkOut: dayOnly(d.checkOut), unitId: d.unitId, notes: d.notes || '',
      requiredSiteLayout: d.requiredSiteLayout || 'none',
      requiredAmpService: d.requiredAmpService || 'none',
      rigLengthFt: d.rigLengthFt ?? null,
      avoid: (d.avoidedUnitIds || []).map((id:string)=>unitNumberOf(id)).filter(Boolean).join(', '),
    })
    setEditReturning(false)
    setEditWorkTrade(!!d.workTrade)
    setEditWt(d.workTrade ? workTradeTermsFrom(d.workTrade) : defaultWorkTradeTerms())
  }

  // The stay link is auto-emailed when a reservation is created; this is for
  // grabbing it to text/share manually. (No QR — a remote guest just taps a link.)
  const copyStayLink = async (b: any) => {
    let url = ''
    try {
      const resp = await apiPost<{ url: string }>(`/units/${b.unitId}/bookings/${b.id}/guest-access`, { delivery: 'qr' })
      url = resp.data.url
    } catch { toast.error('Could not generate the stay link.'); return }
    // Clipboard API is blocked outside https/localhost (and some Safari modes);
    // fall back to a prompt the user can copy from.
    try {
      await navigator.clipboard.writeText(url)
      toast('Stay link copied: ' + url)
    } catch {
      await appPrompt('Copy the stay link to text or email the guest:', { title: 'Stay link', defaultValue: url })
    }
  }

  const openGuestAccess = async (b: any) => {
    setGuestAccess({show:true, booking:b, loading:true, error:null, data:null, emailing:false})
    try {
      const resp = await apiPost<{url:string; expiresAt:string; emailed?:boolean}>(
        `/units/${b.unitId}/bookings/${b.id}/guest-access`, { delivery:'qr' })
      setGuestAccess(s => ({...s, loading:false, data: resp.data}))
    } catch (e:any) {
      setGuestAccess(s => ({...s, loading:false, error: e?.message || 'Could not generate the guest link.'}))
    }
  }
  const emailGuestAccess = async () => {
    const b = guestAccess.booking
    if (!b) return
    setGuestAccess(s => ({...s, emailing:true, error:null}))
    try {
      const resp = await apiPost<{url:string; expiresAt:string; emailed?:boolean}>(
        `/units/${b.unitId}/bookings/${b.id}/guest-access`, { delivery:'email', sendEmail:true })
      setGuestAccess(s => ({...s, emailing:false, data: resp.data}))
    } catch (e:any) {
      setGuestAccess(s => ({...s, emailing:false, error: e?.message || 'Could not email the guest link.'}))
    }
  }

  // NOTE: check_in/check_out/start_date/end_date come back as full ISO
  // timestamps ("2026-07-21T07:00:00.000Z"), so every date comparison must run
  // on the day-only slice — a raw `"2026-07-21" >= "2026-07-21T07:.."` is false
  // (prefix) and shifts every bar one day. dayOnly() normalizes both sides.
  const getBookingForDate = (unitId: string, date: string) => {
    return bookings.find(b => b.unitId === unitId && date >= dayOnly(b.checkIn) && date < dayOnly(b.checkOut)) ||
           leases.find(l => l.unitId === unitId && date >= dayOnly(l.startDate) && (!l.endDate || date <= dayOnly(l.endDate)))
  }

  const filteredUnits = filterType === 'all' ? units : units.filter(u => u.unitType === filterType)

  // ── S575 (Nic): floating reservation names ──────────────────────────────────
  // One name per reservation, pinned to the timeline's left edge and lining up in
  // a column, instead of the old repeat-every-21-days in-bar label. A per-cell
  // <td> label can't stay put across a multi-day span (it un-sticks the moment
  // its one-day cell scrolls off), so the names live in a separate overlay layer:
  // each reservation gets an absolutely-placed box the width of its bar, and the
  // name inside uses `position:sticky; left:STICKY_LEFT`. CSS itself pins the name
  // at the left edge while the reservation is under the scroll line, then — as the
  // reservation's right edge closes in — pushes it left so it slides off contained
  // within its own bar (Nic's end-of-reservation case). The layer is
  // pointer-events:none, so every drag/resize/click on the bars underneath is
  // untouched. UNIT_COL_W matches the sticky Unit column; STICKY_LEFT is the pin.
  // Per-row geometry (offsetTop + height). Rows AREN'T a uniform height — unit
  // cells with more content run taller (e.g. 85px vs 72px) — so assuming a fixed
  // row height drifts lower-row names a full row high. Measure each row's actual
  // offsetTop instead. tr.offsetTop is relative to the table, which sits at the
  // scroll container's content origin, so it maps straight to the overlay layer.
  // Re-measured only when the row set changes; horizontal scroll doesn't affect it.
  const [rowGeom, setRowGeom] = useState<{ top: number; h: number }[]>([])
  useLayoutEffect(() => {
    const tbody = scrollContainerRef.current?.querySelector('tbody')
    if (!tbody) return
    const measure = () => {
      const rows = tbody.querySelectorAll('tr')
      if (!rows.length) return
      const g = Array.from(rows).map(r => ({ top: (r as HTMLElement).offsetTop, h: (r as HTMLElement).offsetHeight }))
      setRowGeom(prev => (prev.length === g.length && prev.every((p, i) => p.top === g[i].top && p.h === g[i].h)) ? prev : g)
    }
    measure()
    // Re-measure on ANY change to row layout — a property-name edit that re-wraps,
    // a window resize that reflows the wrap, a late web-font swap — not just the
    // row-count/filter changes the deps below catch. Keeps the floating names
    // pinned to their rows no matter what changed the height. (Read-only + an
    // equality guard, so it can't feed back into a resize loop.)
    const ro = new ResizeObserver(measure)
    ro.observe(tbody)
    return () => ro.disconnect()
  }, [filteredUnits.length, days.length, isLoading, view])

  const nameOverlays = useMemo(() => {
    if (view !== 'timeline' || !days.length || !rowGeom.length) return [] as NameOverlay[]
    const dFirst = days[0], dLast = days[days.length - 1]
    const out: NameOverlay[] = []
    filteredUnits.forEach((unit: any, rowIdx: number) => {
      const rg = rowGeom[rowIdx]
      if (!rg) return
      const add = (id: string, startRaw: string, endRaw: string | null, kind: ScheduleBarKind, label: string) => {
        const isLease = kind === 'lease'
        const start = dayOnly(startRaw)
        // Booking check-out is EXCLUSIVE (last night = checkout − 1); lease end is
        // INCLUSIVE — mirror the bar-painting convention so labels align exactly.
        const lastDay = isLease
          ? (endRaw ? dayOnly(endRaw) : dLast)
          : (endRaw ? addDays(dayOnly(endRaw), -1) : dLast)
        if (lastDay < dFirst || start > dLast) return          // fully outside the window
        const sIdx = start <= dFirst ? 0 : days.indexOf(start)
        const eIdx = lastDay >= dLast ? days.length - 1 : days.indexOf(lastDay)
        if (sIdx < 0 || eIdx < 0 || eIdx < sIdx) return
        out.push({
          key: id,
          left: sIdx * colW,
          top: rg.top,
          height: rg.h,
          width: (eIdx - sIdx + 1) * colW,
          label, kind,
          // 10/18 (Nic): the lock marker is not a lease marker — a checked-out
          // stay and a no-show wear it too, because their dates are just as
          // settled as a lease's.
          locked: LOCKED_BAR_KINDS.includes(kind),
        })
      }
      bookings.forEach((b: any) => { if (b.unitId === unit.id) add(b.id, b.checkIn, b.checkOut, scheduleBarKind(b), b.guestName || 'Guest') })
      leases.forEach((l: any) => {
        if (l.unitId !== unit.id) return
        const nm = (l.guestName || [l.firstName, l.lastName].filter(Boolean).join(' ')).trim() || 'Tenant'
        add(l.id, l.startDate, l.endDate, 'lease', nm)
      })
    })
    return out
  }, [filteredUnits, bookings, leases, days, colW, rowGeom, view])

  // ── S575 (Nic): custom horizontal scrollbar ─────────────────────────────────
  // macOS overlay scrollbars are invisible until you scroll — a Magic Mouse / plain
  // mouse user has no sideways-drag handle. This is an ALWAYS-VISIBLE track + thumb
  // strip that sits just above the legend and stays in sync with the grid's
  // horizontal scroll (both ways: trackpad scroll moves the thumb; dragging the
  // thumb scrolls the grid). thumb width/left are % of the full scrollWidth, so the
  // track maps 1:1 to the scrollable range.
  const hbarTrackRef = useRef<HTMLDivElement>(null)
  // S652 (Nic): "when I scroll up or down really fast... it overlays those blue
  // lines or the red lines straight across the RV site... it slightly renders in
  // front of the RV spot until it realizes it needs to be behind it."
  //
  // The thumb's position used to live in React state, and it was set on EVERY
  // scroll event — so every frame of a scroll re-rendered this whole page, all
  // ~100 rows × every day column. The browser kept scrolling while that render
  // was still running, and for those frames it had moved the bars but not yet
  // re-pinned the Unit column over them. Now a scroll moves the thumb directly
  // and renders nothing; state holds only whether the bar is shown at all.
  const hbarThumbRef = useRef<HTMLDivElement>(null)
  const hbarPos = useRef({ thumbPct: 100, leftPct: 0 })
  const [hbar, setHbar] = useState({ show: false })
  const updateHbar = () => {
    const c = scrollContainerRef.current
    if (!c) return
    const { scrollWidth, clientWidth, scrollLeft } = c
    const show = scrollWidth > clientWidth + 1
    hbarPos.current = {
      thumbPct: show ? Math.max(5, (clientWidth / scrollWidth) * 100) : 100,
      leftPct:  show ? (scrollLeft / scrollWidth) * 100 : 0,
    }
    // The date header is outside the timeline box (it has to stay put when the
    // page scrolls up and down), so it is slid sideways to match.
    if (headerStripRef.current) headerStripRef.current.style.transform = `translate3d(${-scrollLeft}px,0,0)`
    const thumb = hbarThumbRef.current
    if (thumb) {
      thumb.style.left = `${hbarPos.current.leftPct}%`
      thumb.style.width = `${hbarPos.current.thumbPct}%`
    }
    setHbar(prev => prev.show === show ? prev : { show })
  }
  useEffect(() => {
    updateHbar()
    const onResize = () => updateHbar()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.length, filteredUnits.length, view, isLoading, rowGeom.length])
  // A sideways swipe over the site column or the date header still moves the
  // timeline — the pointer being a few pixels left of it shouldn't matter.
  const forwardSidewaysWheel = (e: React.WheelEvent) => {
    const r = scrollContainerRef.current
    if (!r || r.contains(e.target as Node)) return
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) r.scrollLeft += e.deltaX
  }
  // Drag the thumb: map thumb travel across the track to the full scrollWidth.
  const dragHbar = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    const c = scrollContainerRef.current, track = hbarTrackRef.current
    if (!c || !track) return
    const startX = e.clientX, startScroll = c.scrollLeft, trackW = track.clientWidth || 1
    const move = (ev: MouseEvent) => { c.scrollLeft = startScroll + ((ev.clientX - startX) / trackW) * c.scrollWidth; updateHbar() }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  // Click anywhere on the track: jump so the view centers on that point.
  const jumpHbar = (e: React.MouseEvent) => {
    const c = scrollContainerRef.current, track = hbarTrackRef.current
    if (!c || !track) return
    const rect = track.getBoundingClientRect()
    c.scrollLeft = ((e.clientX - rect.left) / (rect.width || 1)) * c.scrollWidth - c.clientWidth / 2
    updateHbar()
  }

  // Units a staff reservation can take for the entered dates: only units set up
  // for short-term stays (is_bookable) that are free of an overlapping booking
  // or lease. Units not configured for bookings (e.g. long-term apartments)
  // don't appear — enable a unit via its ⚙ Configure.
  const ci = newBooking.checkIn, co = newBooking.checkOut
  const datesValid = !!ci && !!co && co > ci
  // S652 (Nic): "there's no timer for deposit link but if it's not paid and
  // someone else pays it boots them as unconfirmed when there's no other
  // spaces." So a site somebody is holding WITHOUT a deposit is not free — but
  // it is not off the table either. It is offered last, and only when the park
  // has nothing else, which is exactly what "when there's no other spaces"
  // says. Taking one moves the holder to an equivalent site, or, if the park
  // really is full, costs them the reservation and earns somebody a phone call.
  const overlapsStay = (b: any) => dayOnly(b.checkIn) < co && dayOnly(b.checkOut) > ci
  const bookableFor = (u: any) => {
    if (!u.isBookable) return false
    const leaseConflict = leases.some((l: any) => l.unitId === u.id && dayOnly(l.startDate) < co && (!l.endDate || dayOnly(l.endDate) > ci))
    return !leaseConflict && !oooOverlaps(u.id, ci, co)
  }
  const blockingBookings = (u: any) => bookings.filter((b: any) =>
    b.unitId === u.id && b.status !== 'cancelled' && overlapsStay(b))
  // S653: "RV 12, RV 14" → the units at any listed property whose number
  // matches. Ids are resolved per property at submit time (numbers repeat).
  const avoidTokens = resvAvoid.split(/[,;\n]|\band\b/i).map(t => t.trim().toLowerCase().replace(/\s+/g, '')).filter(Boolean)
  const isAvoided = (u: any) => avoidTokens.includes(String(u.unitNumber || '').toLowerCase().replace(/\s+/g, ''))
  const avoidedIdsAt = (propertyId: string) => units.filter((u: any) => u.propertyId === propertyId && isAvoided(u)).map((u: any) => u.id)
  const freeUnits = !datesValid ? [] : units.filter((u: any) =>
    bookableFor(u) && blockingBookings(u).length === 0 && !isAvoided(u))
  // Blocked ONLY by holds nobody has paid for.
  const heldUnpaidUnits = !datesValid ? [] : units.filter((u: any) => {
    if (!bookableFor(u) || isAvoided(u)) return false
    const blockers = blockingBookings(u)
    return blockers.length > 0
      && blockers.every((b: any) => b.status === 'tentative' && !b.depositPaidAt)
  })

  // Reservation search — match guest/tenant name, unit number, guest email or
  // phone, or a date (check-in/out, lease term) across bookings + active leases;
  // each result jumps the timeline to that stay.
  const unitNumberOf = (id: string) => units.find((u: any) => u.id === id)?.unitNumber || ''
  const searchQuery = search.trim().toLowerCase()
  const searchResults = searchQuery.length < 2 ? [] : ([
    ...bookings.map((b: any) => ({
      id: b.id, kind: 'booking', label: b.guestName || 'Guest',
      sub: `Unit ${unitNumberOf(b.unitId)} · ${b.checkIn} → ${b.checkOut}`,
      hay: `${b.guestName || ''} ${unitNumberOf(b.unitId)} ${b.guestEmail || ''} ${b.guestPhone || ''} ${b.checkIn || ''} ${b.checkOut || ''}`.toLowerCase(),
      unitId: b.unitId, date: b.checkIn,
    })),
    ...leases.map((l: any) => ({
      id: l.id, kind: 'lease', label: `${l.firstName || ''} ${l.lastName || ''}`.trim() || 'Tenant',
      sub: `Unit ${unitNumberOf(l.unitId)} · lease`,
      hay: `${l.firstName || ''} ${l.lastName || ''} ${unitNumberOf(l.unitId)} ${l.startDate || ''} ${l.endDate || ''}`.toLowerCase(),
      unitId: l.unitId, date: l.startDate,
    })),
  ].filter(r => r.hay.includes(searchQuery)).slice(0, 10))

  const jumpToReservation = (r: any) => {
    setSearch('')
    setView('timeline')
    if (filterType !== 'all') setFilterType('all')   // don't hide the matched unit
    setSelectedCell({ unitId: r.unitId, date: r.date })
    setTimeout(() => {
      const c = scrollContainerRef.current
      if (!c) return
      const idx = days.indexOf(r.date)
      if (idx >= 0) c.scrollLeft = Math.max(0, idx * colW - colW * 2)
    }, 60)
  }

  const openTypeModal = (unit: any) => {
    setTypeForm({
      unitType: unit.unitType || 'residential',
      nightlyRate: unit.nightlyRate || '',
      weeklyRate: unit.weeklyRate || '',
      monthlyRate: unit.monthlyRate || '',
      minStayNights: unit.minStayNights || 1,
      checkInTime: unit.checkInTime?.slice(0,5) || '15:00',
      checkOutTime: unit.checkOutTime?.slice(0,5) || '11:00',
      amenities: unit.amenities || [],   // W-24: text[] end to end (the old comma-string broke the text[] save)
      unitDescription: unit.unitDescription || '',
      isBookable: unit.isBookable || false,
      rvSiteLayout: unit.rvSiteLayout || 'none',
      rvAmpService: unit.rvAmpService || 'none',
      dwellingOwnership: unit.dwellingOwnership || (unit.unitType === 'rv_spot' ? 'tenant' : 'landlord'),
    })
    setCustomAmenity('')
    setTypeModal({show:true, unit})
  }

  const openBookingModal = (unit: any, prefillDate?: string) => {
    setBookFirst(''); setBookLast('')
    setNewBooking({
      guestName:'', guestEmail:'', guestPhone:'', totalAmount:'', notes:'',
      leaseType: unit.leaseTypesAllowed?.[0] || 'nightly',
      checkIn: prefillDate || '',
      checkOut: prefillDate ? addDays(prefillDate, 1) : '',
    })
    setBookingModal({show:true, unit, prefillDate})
  }

  // ── DRAG (native HTML5 drag-and-drop) ──
  const daysBetween = (a:string,b:string) =>
    Math.round((new Date(dayOnly(b)+'T12:00:00').getTime() - new Date(dayOnly(a)+'T12:00:00').getTime()) / 86400000)

  // Validate + commit a finished drag (move or resize). Same gates as before:
  // same-unit date change skips bookable/lease-type checks; cross-unit move
  // warns (not blocks) on RV layout/amp mismatch. Backend reprices.
  const commitDrag = (b:any, tUnitId:string, newCheckIn:string, newCheckOut:string) => {
    if (newCheckOut <= newCheckIn) return
    if (dayOnly(b.checkIn) === newCheckIn && dayOnly(b.checkOut) === newCheckOut && b.unitId === tUnitId) return
    const targetUnit = units.find(u => u.id === tUnitId)
    if (!targetUnit) return
    const sameUnit = b.unitId === tUnitId
    if (!sameUnit && !targetUnit.isBookable) { toast.error('That unit isn’t set up for bookings.'); return }
    if (!sameUnit && targetUnit.leaseTypesAllowed?.length && !targetUnit.leaseTypesAllowed.includes(b.leaseType)) {
      toast.error(`That unit does not allow ${(LEASE_TYPE_LABELS[b.leaseType] || humanize(b.leaseType)).toLowerCase()} bookings.`); return
    }
    const rangeDays = getDaysInRange(newCheckIn, addDays(newCheckOut, -1))
    const hasBookingConflict = bookings.some(existing =>
      existing.id !== b.id && existing.unitId === tUnitId &&
      rangeDays.some(d => d >= dayOnly(existing.checkIn) && d < dayOnly(existing.checkOut)))
    const hasLeaseConflict = leases.some(l =>
      l.unitId === tUnitId && rangeDays.some(d => d >= dayOnly(l.startDate) && (!l.endDate || d <= dayOnly(l.endDate))))
    if (hasBookingConflict || hasLeaseConflict) { toast.error('That unit is already occupied for those dates.'); return }
    if (oooOverlaps(tUnitId, newCheckIn, newCheckOut)) { toast.error('That site is out of order for those dates.'); return }
    // 10/6 (Nic): a site the guest asked not to have is a plain question, never a quiet move.
    const avoided = !sameUnit && ((b.avoidedUnitIds || []) as string[]).includes(tUnitId)
    // 10/20 (Nic, his own catch): and neither is a space the guest was already
    // promised. The server refuses this move without overrideLocked, so the
    // question is asked here rather than sending a drag out to be rejected.
    const siteLocked = !sameUnit && isScheduleBarSiteLocked(b)
    const doMove = () => moveBookingMut.mutate({ bookingId: b.id, unitId: tUnitId, checkIn: newCheckIn, checkOut: newCheckOut,
      ...(avoided ? { overrideAvoided: true } : {}),
      ...(siteLocked ? { overrideLocked: true } : {}) })
    const mismatchReasons = sameUnit ? [] : rvMismatchReasons(b.requiredSiteLayout, b.requiredAmpService, targetUnit)
    // Everything the person pressing needs to know, in the order it matters:
    // the promised space first (a rig arrives at the wrong one), then the space
    // they asked not to have, then whether the site even fits the rig.
    const lockedAsk = siteLocked ? promisedSiteWords(b, targetUnit.unitNumber) : ''
    if (mismatchReasons.length) {
      const asks = [lockedAsk, avoided ? avoidedWords(b, targetUnit.unitNumber) : ''].filter(Boolean)
      appConfirm(`${asks.length ? `${asks.join('\n\n')}\n\n` : ''}Unit ${targetUnit.unitNumber} doesn't match this reservation:\n· ${mismatchReasons.join('\n· ')}\n\nMove ${avoided || siteLocked ? 'them there' : 'it'} anyway?`, { confirmLabel: avoided || siteLocked ? 'Move them there' : 'Move it' }).then(ok => { if (ok) doMove() })
    } else if (siteLocked) {
      appConfirm(`${lockedAsk}${avoided ? `\n\n${avoidedWords(b, targetUnit.unitNumber)}` : ''}\n\nMove them there anyway?`, { confirmLabel: 'Move them there' }).then(ok => { if (ok) doMove() })
    } else if (avoided) {
      appConfirm(`${avoidedWords(b, targetUnit.unitNumber)} Move them there anyway?`, { confirmLabel: 'Move them there' }).then(ok => { if (ok) doMove() })
    } else {
      doMove()
    }
  }

  // Begin a drag. `grabbedDate` = the day-cell the drag started on, so a MOVE
  // keeps that day under the cursor (subtract grabOffset on drop) instead of
  // snapping check-in to the drop cell — fixes the "first day jumps" / off-by-one.
  const onDragStart = (e: React.DragEvent, bk: any, grabbedDate: string, mode: 'move'|'resize-start'|'resize-end') => {
    // Leases are read-only, and so is a stay that is already history (10/18).
    if (isScheduleBarLocked(bk)) { e.preventDefault(); return }
    if (mode !== 'move') e.stopPropagation()         // edge grip → resize, not move
    dragInfo.current = { booking: bk, mode, grabOffset: mode === 'move' ? daysBetween(bk.checkIn, grabbedDate) : 0 }
    dragTargetRef.current = null
    setDragging(bk.id)
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', bk.id) } catch {}
  }
  // Hovering a cell resolves the target range (move = grab-relative; resize =
  // the grabbed edge follows the cursor) and drives the preview highlight.
  const onDragOver = (e: React.DragEvent, hoverUnitId: string, hoverDate: string) => {
    const di = dragInfo.current; if (!di) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const b = di.booking
    const bCheckIn = dayOnly(b.checkIn), bCheckOut = dayOnly(b.checkOut)
    const nights = b.nights || Math.max(1, daysBetween(bCheckIn, bCheckOut))
    let unitId = hoverUnitId, ci = bCheckIn, co = bCheckOut
    if (di.mode === 'move') {
      unitId = hoverUnitId
      ci = addDays(hoverDate, -di.grabOffset)
      co = addDays(ci, nights)
    } else if (di.mode === 'resize-end') {
      unitId = b.unitId; co = addDays(hoverDate, 1); if (co <= ci) co = addDays(ci, 1)
    } else {
      unitId = b.unitId; ci = hoverDate; if (ci >= co) ci = addDays(co, -1)
    }
    const t = dragTargetRef.current
    if (t && t.unitId === unitId && t.checkIn === ci && t.checkOut === co) return
    const u = units.find(x => x.id === unitId)
    const mismatch = di.mode === 'move' && !!u && u.id !== b.unitId &&
      rvMismatchReasons(b.requiredSiteLayout, b.requiredAmpService, u).length > 0
    dragTargetRef.current = { unitId, checkIn: ci, checkOut: co }
    setPreview({ unitId, checkIn: ci, checkOut: co, mismatch })
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const di = dragInfo.current, t = dragTargetRef.current
    dragInfo.current = null; dragTargetRef.current = null
    setPreview(null); setDragging(null)
    if (di && t) commitDrag(di.booking, t.unitId, t.checkIn, t.checkOut)
  }
  const onDragEnd = () => {
    dragInfo.current = null; dragTargetRef.current = null
    setPreview(null); setDragging(null)
  }

  // Scroll the timeline so today's column sits just after the sticky unit
  // column — i.e. the coming month is what you see, with past to the left.
  const scrollToToday = () => {
    const c = scrollContainerRef.current
    if (!c) return
    const idx = days.indexOf(today)
    c.scrollLeft = idx > 0 ? idx * colW : 0
  }

  // On first paint of the timeline, jump to today.
  useEffect(() => {
    if (isLoading || view !== 'timeline') return
    const t = setTimeout(scrollToToday, 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, view, colW])

  // ── Perpetual calendar (S576) ──
  // Clear the extend guard once the wider window's data has landed (days grew),
  // so the next near-edge scroll can extend again.
  useEffect(() => { extendingRef.current = false }, [toDate, schedule])

  // Infinite forward scroll: as the timeline nears its right edge, push the
  // forward horizon out. New key → refetch (keepPreviousData keeps the grid up),
  // days array grows, columns append to the right (scrollLeft unaffected).
  const maybeExtendForward = () => {
    const c = scrollContainerRef.current
    if (!c || extendingRef.current) return
    if (c.scrollLeft + c.clientWidth >= c.scrollWidth - colW * 6) {
      extendingRef.current = true
      setToDate(t => addDays(t, 120))
    }
  }

  // Jump-to-date: extend the window to cover the target (past or future) and
  // scroll to it. If it's already in range, scrolls immediately; otherwise the
  // pending-scroll effect fires once the extended fetch resolves.
  const jumpToDate = (d: string) => {
    if (!d) return
    if (d > toDate) setToDate(addDays(d, 21))
    else if (d < fromDate) setFromDate(addDays(d, -7))
    setPendingScrollDate(d)
  }

  // Scroll to a pending jump target once the day column exists. Re-runs as
  // `days` grows from an extend, so a far-future jump lands after its refetch.
  useEffect(() => {
    if (!pendingScrollDate || view !== 'timeline') return
    const c = scrollContainerRef.current
    if (!c) return
    const idx = days.indexOf(pendingScrollDate)
    if (idx < 0) return // wait for the extended window to include it
    c.scrollLeft = Math.max(0, idx * colW - colW * 2)
    updateHbar()
    setPendingScrollDate(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScrollDate, fromDate, toDate, view, colW])

  // Per-user tab gating: staff see only the sub-tabs they hold; owners see all.
  const SCHEDULE_TABS = ([
    { key: 'timeline',     perm: 'schedule.tab.timeline', label: 'Timeline' },
    { key: 'list',         perm: 'schedule.tab.list', label: 'List' },
    { key: 'units',        perm: 'schedule.tab.units', label: 'Units' },
    { key: 'history',      perm: 'schedule.tab.history', label: 'History' },
    { key: 'reservations', perm: 'bookings.view', label: 'Reservations' },
    { key: 'requests',     perm: 'bookings.change_requests', label: 'Requests' },
    // Booking-site editor moved to its own discoverable page (BookingSitePage,
    // nav "Booking Site", route /booking-sites) in S602. The bp* state/handlers
    // + the `view==='booking_page'` block below are now dormant (this tab is the
    // only thing that set that view) — safe to delete in a focused cleanup pass.
  ] as { key: string; perm: string; label?: string }[]).filter(t => can(t.perm))
  // If the active view isn't visible to this user, snap to their first tab.
  const visibleTabKeys = SCHEDULE_TABS.map(t => t.key).join(',')
  useEffect(() => {
    if (SCHEDULE_TABS.length && !SCHEDULE_TABS.some(t => t.key === view)) setView(SCHEDULE_TABS[0].key as any)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabKeys])

  return (
    // S575: on the timeline sub-view the page fills the content region and only the
    // unit grid scrolls (toolbar + legend stay put). height:100% resolves against
    // .page-content (now a definite-height flex child of the fixed shell). Other
    // sub-views keep auto height and scroll normally inside .page-content.
    <div style={view==='timeline'
      ? {minWidth:0,overflow:'hidden',height:'100%',display:'flex',flexDirection:'column'}
      : {minWidth:0,overflow:'hidden'}}>
      {/* ── COMPACT TOOLBAR ── */}
      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:12,flexWrap:'wrap',flexShrink:0}}>
        {/* View toggle */}
        {SCHEDULE_TABS.map(({ key: v, label }) => (
          <button key={v} className={`tab-btn ${view===v?'active':''}`} onClick={()=>setView(v as any)} style={{fontSize:'.78rem'}}>{label ?? v}</button>
        ))}

        {/* Reservation search */}
        <div style={{position:'relative'}}>
          <input
            value={search}
            onChange={e=>setSearch(e.target.value)}
            placeholder="🔍 Find guest or unit…"
            style={{fontSize:'.76rem',padding:'5px 9px',width:190,background:'var(--bg-3)',border:'1px solid var(--border-1)',borderRadius:6,color:'var(--text-1)'}}
          />
          {search.trim().length>=2 && (
            <div style={{position:'absolute',top:'calc(100% + 4px)',left:0,zIndex:30,minWidth:240,maxHeight:300,overflowY:'auto',background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:8,boxShadow:'0 10px 30px rgba(0,0,0,.45)'}}>
              {searchResults.length===0 ? (
                <div style={{padding:'10px 12px',fontSize:'.74rem',color:'var(--text-3)'}}>No matches</div>
              ) : searchResults.map(r => (
                <div key={r.kind+r.id} onClick={()=>jumpToReservation(r)}
                  style={{padding:'7px 11px',cursor:'pointer',borderBottom:'1px solid var(--border-1)'}}
                  onMouseDown={e=>e.preventDefault()}>
                  <div style={{fontSize:'.8rem',fontWeight:600,display:'flex',justifyContent:'space-between',gap:8}}>
                    <span>{r.label}</span>
                    <span style={{fontSize:'.6rem',color:r.kind==='lease'?'var(--blue)':'var(--green)',fontWeight:700}}>{r.kind==='lease'?'LEASE':'STAY'}</span>
                  </div>
                  <div style={{fontSize:'.68rem',color:'var(--text-3)'}}>{r.sub}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {view==='timeline' && <>
          <div style={{width:1,height:20,background:'var(--border-1)',margin:'0 4px'}} />
          {/* Jump-to-date (S576): extend the window to any future date and scroll
              there — the perpetual-calendar reach for booking next season. Today
              re-centers, and sits right next to Go for one clean nav cluster. */}
          <div style={{display:'flex',alignItems:'center',gap:5,flexWrap:'nowrap'}}>
            <input
              type="date"
              value={jumpDate}
              min={fromDate}
              onChange={e => setJumpDate(e.target.value)}
              title="Jump to a date"
              style={{fontSize:'.72rem',padding:'4px 7px',background:'var(--bg-3)',border:'1px solid var(--border-1)',borderRadius:6,color:'var(--text-1)'}}
            />
            <button className="btn btn-ghost btn-sm" disabled={!jumpDate}
              onClick={() => jumpToDate(jumpDate)}
              style={{fontWeight:600,color: jumpDate ? 'var(--gold)' : 'var(--text-3)'}}>Go</button>
            <button className="btn btn-ghost btn-sm" onClick={scrollToToday} style={{fontWeight:600,color:'var(--gold)'}}>Today</button>
          </div>
          <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>← scroll for past · future →</span>
        </>}

        {/* Unit-type filter chips removed (S: crowded the toolbar). filterType
            stays 'all' so all units show; landlords still set unit type at
            creation. */}

        {/* Stats + New Reservation */}
        <div style={{marginLeft:'auto',display:'flex',gap:8,alignItems:'center'}}>
          <RequiredPropertySelect value={schedulePropertyId} onChange={setSchedulePropertyId}
            properties={schedulePropertyOptions} />
          <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>{filteredUnits.length} units · {bookings.length} reservations</span>
          {/* 10/20 (Nic): the reservations that ALREADY EXIST — the old system's
              schedule first, then the ones out of his text threads. Its own
              door, beside this one, because nothing about it is a new
              reservation: the guest has been told, may have paid, and may have
              been promised a space. Nobody is emailed by it. */}
          {can('schedule.create_reservation') && schedulePropertyId && (
            <button className="btn btn-primary btn-sm" onClick={()=>setImportOpen(true)}>Bring in reservations</button>
          )}
          {can('schedule.create_reservation') && <button className="btn btn-primary btn-sm" onClick={()=>setNewResvOpen(true)}>+ New Reservation</button>}
        </div>
      </div>

      {/* S639: no park chosen — offer the parks, never a merged timeline. */}
      {!schedulePropertyId && (
        <div style={{padding:'32px 24px'}}>
          <div style={{color:'var(--text-2)',fontSize:'.85rem',marginBottom:14}}>
            Pick a property to see its schedule. Spot and unit numbers repeat across
            properties, so each property keeps its own schedule.
          </div>
          <div style={{display:'flex',flexWrap:'wrap',gap:10}}>
            {schedulePropertyOptions
              .slice()
              .sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''))
              .map((p: any) => (
                <button key={p.id} className="btn btn-primary"
                  onClick={() => setSchedulePropertyId(p.id)}>{p.name}</button>
              ))}
          </div>
        </div>
      )}

      {schedulePropertyId && isLoading && <div style={{padding:48,textAlign:'center',color:'var(--text-3)'}}>Loading schedule...</div>}

      {/* ── TIMELINE VIEW ── */}
      {schedulePropertyId && !isLoading && view==='timeline' && (
        <div style={{display:'flex',flexDirection:'column',minWidth:0,flex:1,minHeight:0}}>
        {/* S575: the old JS row-snap (round scrollTop to a fixed 72px) was removed —
            it rounded DOWN below max-scroll at the bottom (cutting off the last row)
            and re-fired on every momentum tick, fighting the fling with a repeated
            3-second bounce. Native scrolling reaches the bottom and stops cleanly;
            overscrollBehavior:contain keeps a fling from chaining to the page. */}
        {/* S575: hide the NATIVE scrollbars — scrolling still works (swipe/wheel),
            but the macOS overlay bar that flashed on swipe was doubling up with the
            custom bar below. Our own draggable bar is the only visible one now. */}
        <style>{`
          .schedule-scroll::-webkit-scrollbar{display:none;}
          .schedule-scroll{scrollbar-width:none;-ms-overflow-style:none;}
        `}</style>
        <div
          ref={vScrollRef}
          className="card schedule-scroll"
          onWheel={forwardSidewaysWheel}
          style={{padding:0,position:'relative',overflowX:'hidden',overflowY:'auto',overscrollBehavior:'contain',flex:1,minHeight:0,marginBottom:0,borderRadius:'12px 12px 0 0'}}
        >
          {/* Date header — pinned to the top of the up/down box. */}
          <div ref={headerRef} style={{position:'sticky',top:0,zIndex:3,display:'flex',background:'var(--bg-3)',borderBottom:'1px solid var(--border-1)'}}>
            <div style={{width:UNIT_COL_W,flexShrink:0,boxSizing:'border-box',padding:'8px 12px',textAlign:'left',fontSize:'.72rem',color:'var(--text-3)',fontWeight:600}}>Unit</div>
            <div style={{flex:1,minWidth:0,overflow:'hidden'}}>
              <div ref={headerStripRef} style={{display:'flex',width:days.length*colW,willChange:'transform'}}>
                {days.map(d => (
                  <div key={d} style={{boxSizing:'border-box',width:colW,flexShrink:0,padding:'6px 2px',fontSize:'.6rem',color:d===today?'var(--gold)':'var(--text-3)',fontWeight:d===today?700:400,textAlign:'center',borderLeft:'1px solid var(--border-1)',display:'flex',alignItems:'center',justifyContent:'center'}}>
                    {new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'numeric',day:'numeric'})}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'flex-start'}}>
          {/* Site column — beside the timeline, never over it. Each row takes the
              measured height of its timeline row so the two can't drift. */}
          <div style={{width:UNIT_COL_W,flexShrink:0,background:'var(--bg-2)'}}>
            {filteredUnits.map((unit, rowIdx) => (
              <div key={unit.id} style={{height:rowGeom[rowIdx]?.h ?? 56,boxSizing:'border-box',padding:'6px 12px',borderBottom:'1px solid var(--border-1)',overflow:'hidden',display:'flex',alignItems:'center'}}>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,height:44,overflow:'hidden',width:'100%'}}>
                      {/* S652 (Nic): "RV sites 11 and 17 display the number next to the
                          RV moniker, and all the other RV sites display the number
                          underneath... I want consistency." One line, always. */}
                      <div style={{flexShrink:0}}>
                        <div style={{fontWeight:700,fontSize:'.86rem',whiteSpace:'nowrap',color:TYPE_COLORS[unit.unitType]||'var(--text-0)'}} title={`${UNIT_TYPE_LABELS[unit.unitType]||humanize(unit.unitType)} · ${unit.propertyName}`}>{unit.unitNumber}</div>
                      </div>
                      <div style={{display:'flex',gap:4,flexShrink:0}}>
                        {unit.isBookable && can('schedule.create_reservation') && <button className="btn btn-ghost btn-sm" style={{fontSize:'.65rem',padding:'2px 6px'}} onClick={()=>openBookingModal(unit)}>+ Book</button>}
                        {can('schedule.configure_unit') && <button className="btn btn-ghost btn-sm" title="Set up this space" style={{fontSize:'.65rem',padding:'2px 6px'}} onClick={()=>openTypeModal(unit)}>⚙</button>}
                        {/* S652 (Nic): "the button should flip on a site that's marked
                            out of order." Out today → the button puts it back. */}
                        {can('schedule.configure_unit') && (oooFor(unit.id, today)
                          ? <button className="btn btn-primary btn-sm" title="Out of order — put it back in service" style={{fontSize:'.65rem',padding:'2px 6px'}} onClick={()=>setOooUnit(unit)}>↺</button>
                          : <button className="btn btn-ghost btn-sm" title="Mark out of order" style={{fontSize:'.65rem',padding:'2px 6px'}} onClick={()=>setOooUnit(unit)}>⛔</button>)}
                      </div>
                    </div>
              </div>
            ))}
          </div>
          <div
            ref={scrollContainerRef}
            className="schedule-scroll"
            onScroll={() => { updateHbar(); maybeExtendForward() }}
            style={{flex:1,minWidth:0,position:'relative',overflowX:'auto',overflowY:'hidden',overscrollBehaviorX:'contain'}}
          >
          <table
            style={{borderCollapse:'collapse',tableLayout:'fixed',width:days.length*colW}}
            tabIndex={0}
            onKeyDown={e => {
              if (!selectedCell) return
              const unitIdx = filteredUnits.findIndex(u => u.id === selectedCell.unitId)
              const dayIdx = days.findIndex(d => d === selectedCell.date)
              if (e.key === 'ArrowRight') { e.preventDefault(); if (dayIdx < days.length-1) setSelectedCell({unitId: selectedCell.unitId, date: days[dayIdx+1]}) }
              if (e.key === 'ArrowLeft')  { e.preventDefault(); if (dayIdx > 0) setSelectedCell({unitId: selectedCell.unitId, date: days[dayIdx-1]}) }
              if (e.key === 'ArrowDown')  { e.preventDefault(); if (unitIdx < filteredUnits.length-1) setSelectedCell({unitId: filteredUnits[unitIdx+1].id, date: selectedCell.date}) }
              if (e.key === 'ArrowUp')    { e.preventDefault(); if (unitIdx > 0) setSelectedCell({unitId: filteredUnits[unitIdx-1].id, date: selectedCell.date}) }
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                const unit = filteredUnits.find(u => u.id === selectedCell.unitId)
                const booked = getBookingForDate(selectedCell.unitId, selectedCell.date)
                if (unit && unit.isBookable && !booked) openBookingModal(unit, selectedCell.date)
              }
              if (e.key === 'Escape') setSelectedCell(null)
            }}
          >
            <tbody>
              {/* S575: every row is a UNIFORM 88px. The only thing that made rows vary
                  was the sticky Unit cell's content — bookable units carry a "+ Book"
                  button, and a long property name used to wrap unbounded (a 4-line name
                  made a 118px row). We clamp the property name to 2 lines (full name on
                  hover) and hard-cap the cell content to a fixed height with
                  overflow:hidden, so nothing can push the row taller and nothing is
                  truly hidden. */}
              {filteredUnits.map(unit => (
                <tr key={unit.id} style={{height:56}}>
                  {days.map(d => {
                    const booking = getBookingForDate(unit.id, d)
                    const isBooked = !!booking
                    const isLease = !!(booking && booking.startDate)
                    // 10/18 (Nic): one reading of the booking decides the bar's
                    // color AND whether its dates can still be dragged — see
                    // scheduleBarKind above. Finished history locks like a lease.
                    const barKind = booking ? scheduleBarKind(booking) : 'reserved'
                    const barLocked = !!booking && isScheduleBarLocked(booking)
                    // 10/20 (Nic): pinned to its space. Its dates still drag —
                    // that is why this is not barLocked — but dropping it on
                    // another site asks first (commitDrag).
                    const barSiteLocked = !!booking && isScheduleBarSiteLocked(booking)
                    const isStart = booking && (dayOnly(booking.checkIn) === d || dayOnly(booking.startDate) === d)
                    // Last cell of this reservation within the grid, so the bar
                    // rounds only at its true ends. S527 W-21: conventions differ —
                    // check-out is EXCLUSIVE (last painted night = checkOut-1) but
                    // lease end_date is INCLUSIVE (bar paints through endDate), so
                    // leases round ON endDate, not one day early.
                    const isEnd = booking && (
                      (booking.checkOut && addDays(d,1) === dayOnly(booking.checkOut)) ||
                      (booking.endDate && d === dayOnly(booking.endDate)) ||
                      d === days[days.length-1]
                    )
                    const isDragTarget = !!(preview && preview.unitId === unit.id && d >= preview.checkIn && d < preview.checkOut)
                    const isPreviewStart = isDragTarget && d === preview!.checkIn
                    const isGhostCell = !!(dragging && booking?.id === dragging)
                    // The standalone gold preview block renders only on cells that DON'T
                    // hold the dragged bar; the dragged bar's own cells stay mounted (so
                    // the native drag isn't cancelled) and get tinted gold instead — that
                    // shows the overlap with the original position without unmounting it.
                    const showPreviewBlock = isDragTarget && !isGhostCell

                    // S574 (Nic): repeat the guest name every 7 days across the bar
                    // (a 6-month stay was blank after its start cell) and mark which
                    // cells carry a label. Label cells get zIndex 2 (below the sticky
                    // Unit column at 3, above plain bar cells at 1) so the name paints
                    // OVER following day-cells instead of behind them — long stays whose
                    // true start is off-screen previously labeled a zIndex-1 cell that
                    // later cells painted over ("see-through" name).
                    const barStart = booking ? dayOnly(booking.checkIn || booking.startDate) : ''
                    const dayIndex = booking && barStart
                      ? Math.round((new Date(d + 'T00:00:00').getTime() - new Date(barStart + 'T00:00:00').getTime()) / 86400000)
                      : 0
                    // S574: repeat interval widened 7→21 (7 was too frequent for
                    // longer names). NOTE (Nic): the better end-state is a single
                    // name that FLOATS pinned to the visible left edge per reservation
                    // (so a full park's names line up in a column) — that's a
                    // sticky-overlay rendering change, tracked separately.
                    const showsLabel = !!booking
                      && (isStart || d === days[0] || (dayIndex > 0 && dayIndex % 21 === 0))
                      && (!isGhostCell || isDragTarget)

                    return (
                      <td
                        key={d}
                        data-unit={unit.id}
                        data-date={d}
                        style={{borderBottom:'1px solid var(--border-1)',borderLeft:'1px solid var(--border-1)',padding:'6px 0',textAlign:'center',width:colW,minWidth:colW,maxWidth:colW,
                          // 10/18 (Nic): amber is now what an un-arrived stay paints
                          // at rest, so a drop that does not fit the stay's
                          // requirements warns in RED — the two can never be read as
                          // each other. The gold valid-target tint is unchanged.
                          background: isDragTarget ? (preview?.mismatch ? 'rgba(239,68,68,.16)' : 'rgba(201,162,39,.18)') : d===today ? 'rgba(201,162,39,.04)' : '',
                          outline: selectedCell?.unitId===unit.id && selectedCell?.date===d ? '2px solid var(--gold)' : isDragTarget ? `2px solid ${preview?.mismatch?'var(--red)':'var(--gold)'}` : 'none',
                          outlineOffset: '-2px',
                          cursor: isBooked && !barLocked ? 'grab' : unit.isBookable && !isBooked ? 'pointer' : 'default'
                        }}
                        onDragOver={e => onDragOver(e, unit.id, d)}
                        onDrop={onDrop}
                        onClick={e => {
                          setSelectedCell({unitId: unit.id, date: d})
                          ;(e.currentTarget.closest('table') as HTMLElement)?.focus()
                        }}
                        onDoubleClick={() => {
                          if (!isBooked && unit.isBookable && !oooFor(unit.id, d)) openBookingModal(unit, d)
                        }}
                      >
                        {showPreviewBlock ? (
                          <div style={{background: preview?.mismatch ? 'var(--red)' : 'var(--gold)',borderRadius:3,height:24,opacity:.7,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'.6rem',color:'#000',fontWeight:700}}>
                            {isPreviewStart ? (dragInfo.current?.booking?.guestName || '↔').slice(0,8) : ''}
                          </div>
                        ) : isBooked ? (
                          (() => {
                            // S200: ack-needed badge — booking on a property with
                            // requires_booking_acknowledgment ON and no
                            // acknowledgment_signed_at timestamp yet, on an active
                            // (not cancelled / checked_out / no_show) booking.
                            //
                            // S312: response-interceptor camelizes the keys, so the
                            // frontend reads camelCase here. The master-schedule
                            // endpoint (GET /units/schedule/master) joins properties
                            // and surfaces requires_booking_acknowledgment, so the
                            // badge renders correctly on this page.
                            const needsAck =
                              !isLease
                              && booking.requiresBookingAcknowledgment === true
                              && !booking.acknowledgmentSignedAt
                              && booking.status !== 'cancelled'
                              && booking.status !== 'checked_out'
                              && booking.status !== 'no_show'
                            const bk = { ...booking, unitId: unit.id, unitNumber: unit.unitNumber, propertyName: unit.propertyName, isLease }
                            return (
                              <div
                                // 10/18: the bar says which reservation it belongs to and what
                                // kind of bar it is, so the color/lock rules can be read off
                                // the page (and tested) instead of guessed from a style string.
                                data-bar-id={booking.id}
                                data-bar-kind={barKind}
                                data-bar-locked={barLocked ? 'true' : 'false'}
                                // 10/20 (Nic): the space is pinned even when
                                // the dates are not, so the board says which
                                // bars a cross-site drop will stop to ask about.
                                data-bar-site-locked={barSiteLocked ? 'true' : 'false'}
                                // 10/3 (fix pass 2): moving or stretching a stay is an edit. A desk
                                // person who may only check guests in or out does not get a bar
                                // that drags only to be refused.
                                draggable={!barLocked && can('schedule.edit_reservation')}
                                onDragStart={e => {
                                  // Mode from grab position: the outer ~10px of a start/end
                                  // cell resizes that edge; anywhere else moves the stay.
                                  // (One draggable element — nested draggable grips were
                                  // unreliable, the browser kept choosing the parent.)
                                  const w = (e.currentTarget as HTMLElement).offsetWidth || colW
                                  const x = e.nativeEvent.offsetX
                                  const mode: 'move'|'resize-start'|'resize-end' =
                                    (isStart && x <= 10) ? 'resize-start'
                                    : (isEnd && x >= w - 10) ? 'resize-end'
                                    : 'move'
                                  onDragStart(e, bk, d, mode)
                                }}
                                onDragEnd={onDragEnd}
                                onClick={e => { e.stopPropagation(); setDetailBooking(bk) }}
                                onContextMenu={e => {
                                  // S559 (Nic): right-click a reservation to jump straight into
                                  // edit. Leases edit on the Leases page — just open their detail.
                                  // 10/18 (Nic): a checked-out stay or a no-show is history, so
                                  // right-click opens its window and stops there — correcting
                                  // its dates is the deliberate Edit press inside that window,
                                  // not a shortcut the mouse can land on.
                                  e.preventDefault(); e.stopPropagation()
                                  setDetailBooking(bk)
                                  if (!barLocked && can('schedule.edit_reservation')) startEdit(bk)
                                }}
                                style={{
                                  // The dragged bar's cells that fall in the new target
                                  // range tint gold (preview of the overlap with the
                                  // original); cells outside the new range dim (ghost).
                                  background: (!barLocked && isGhostCell && isDragTarget)
                                    ? (preview?.mismatch ? 'var(--red)' : 'var(--gold)')
                                    : SCHEDULE_BAR_COLOR[barKind],
                                  // Round only at the reservation's true ends so adjacent
                                  // day-cells merge into one continuous bar (no beading).
                                  borderRadius:`${isStart?6:0}px ${isEnd?6:0}px ${isEnd?6:0}px ${isStart?6:0}px`,
                                  height:26,
                                  display:'flex', alignItems:'center', justifyContent:'flex-start',
                                  // S527 W-17: names readable at a glance.
                                  fontSize:'.72rem', fontWeight:700, color: (isGhostCell && isDragTarget) ? '#000' : SCHEDULE_BAR_TEXT[barKind], overflow:'visible',
                                  whiteSpace:'nowrap', paddingLeft: isStart?7:0,
                                  opacity: (isGhostCell && !isDragTarget) ? 0.2 : 0.92,
                                  cursor: barLocked ? 'default' : 'grab',
                                  position:'relative', zIndex: showsLabel?2:1,
                                  // 10/18 (Nic): "it's almost highlighted like you have it
                                  // clicked on." The acknowledgment-pending border was drawn
                                  // on EVERY day cell of the bar — a yellow rectangle around
                                  // every square, which reads as a selection outline. The dot
                                  // at the bar's start is the whole signal now.
                                  border: 'none',
                                  userSelect: 'none',
                                }}
                                title={
                                  (booking.guestName || booking.firstName || 'Tenant')
                                  + (needsAck ? ' — Property-rules acknowledgment pending' : '')
                                }
                              >
                                {/* S575: the resting name now lives in the floating-name
                                    overlay (one pinned name per reservation), so the bar itself
                                    carries no text — just the colored block + ack dot + grips. */}
                                {needsAck && isStart && (
                                  <span
                                    style={{
                                      position:'absolute',
                                      top:-4, right:-4,
                                      // 10/18 (review): an un-arrived stay is now amber itself,
                                      // so the dot needs a dark ring to stay visible on top of
                                      // it — and the dot GREW to pay for the ring. Everything in
                                      // this app is border-box, so a 2px ring eats 4px out of an
                                      // 8px dot and leaves a 4px amber core: a WEAKER pending
                                      // signal than before, on the green and blue bars that were
                                      // never part of the complaint. 10px keeps the 6px core it
                                      // always had and adds the ring on the outside.
                                      width:10, height:10,
                                      borderRadius:'50%',
                                      background:'var(--amber)',
                                      border:'2px solid var(--bg-1)',
                                    }}
                                  />
                                )}
                                {/* ── 10/24 (Nic): "ASK THEM IF THEY'RE STAYING" ──────────
                                    A hollow ring at the bar's start when this person's
                                    STATED stay is nearly up and the park is nearly full
                                    (services/stayFollowUps decides both; with room to
                                    spare the list is empty and nothing is drawn). Hollow,
                                    and only at the start, so it reads as a question
                                    rather than competing with the solid amber
                                    acknowledgment dot beside it. */}
                                {isStart && askIfStaying.has(String(booking.tenantId ?? '')) && (
                                  <span
                                    title={`${booking.guestName || [booking.firstName, booking.lastName].filter(Boolean).join(' ') || 'They'} said how long when they applied and it is nearly up — ask whether they are staying on. Their answer changes nothing on the lease.`}
                                    style={{
                                      position:'absolute',
                                      bottom:-4, right:-4,
                                      width:10, height:10,
                                      borderRadius:'50%',
                                      background:'transparent',
                                      border:'2px solid var(--bg-1)',
                                      boxShadow:'0 0 0 2px var(--amber, #d9a441)',
                                    }}
                                  />
                                )}
                                {/* Edge grips — drag to extend/shorten the stay by its edge
                                    (left = check-in, right = check-out). Reservations that are
                                    not yet history; a locked bar shows no grips at all. */}
                                {/* Visual resize-handle cues only — the bar's own onDragStart
                                    reads the grab position to choose resize vs move, so these
                                    must not intercept the pointer. */}
                                {!barLocked && isStart && (
                                  <span aria-hidden
                                    title="Drag this edge to change check-in"
                                    style={{position:'absolute', left:0, top:0, bottom:0, width:10, cursor:'ew-resize', borderRadius:'6px 0 0 6px', background:'rgba(0,0,0,.3)', pointerEvents:'none'}}
                                  />
                                )}
                                {!barLocked && isEnd && (
                                  <span aria-hidden
                                    title="Drag this edge to change check-out"
                                    style={{position:'absolute', right:0, top:0, bottom:0, width:10, cursor:'ew-resize', borderRadius:'0 6px 6px 0', background:'rgba(0,0,0,.3)', pointerEvents:'none'}}
                                  />
                                )}
                              </div>
                            )
                          })()
                        ) : (
                          oooFor(unit.id, d) ? (
                            // S649: out of order — striped, never a place to drop a stay
                            <div title={`Out of order${oooFor(unit.id, d)?.reason ? ` — ${oooFor(unit.id, d)?.reason}` : ''}`}
                              style={{height:24, borderRadius:3, opacity:.55,
                                background:'repeating-linear-gradient(45deg, var(--red) 0 4px, transparent 4px 9px)'}} />
                          ) : oooPastFor(unit.id, d) ? (
                            // S652: an outage that is over — same hazard stripe, faded,
                            // so the calendar keeps the record of how long it was down.
                            (() => { const h = oooPastFor(unit.id, d); return (
                              <div title={`Was out of order ${fmtDate(h.startsOn)} – ${fmtDate(h.endedOn)} (${Number(h.daysOut) < 1 ? 'less than a day' : `${h.daysOut} day${Number(h.daysOut) === 1 ? '' : 's'}`})${h.reason ? ` — ${h.reason}` : ''}`}
                                style={{height:24, borderRadius:3, opacity:.22,
                                  background:'repeating-linear-gradient(45deg, var(--red) 0 4px, transparent 4px 9px)'}} />
                            ) })()
                          ) : (
                          <div
                            style={{height:24, background: unit.isBookable ? 'transparent' : 'var(--bg-3)', borderRadius:3, opacity:.3}}
                          />
                          )
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
              {filteredUnits.length===0 && (
                <tr><td colSpan={days.length} style={{textAlign:'left',padding:48,color:'var(--text-3)'}}>No units found.</td></tr>
              )}
            </tbody>
          </table>
          {/* S575: floating-name overlay (see the nameOverlays comment). Sits above
              the bars, inside the timeline box — a name sliding left is cut off at
              the box's edge, where the site column begins. */}
          <div aria-hidden style={{position:'absolute',top:0,left:0,zIndex:2,pointerEvents:'none'}}>
            {nameOverlays.filter(o => o.key !== dragging).map(o => (
              <div key={o.key} style={{position:'absolute',left:o.left,top:o.top,width:o.width,height:o.height,display:'flex',alignItems:'center',pointerEvents:'none'}}>
                <div data-testid={`bar-name-${o.key}`} data-kind={o.kind} style={{position:'sticky',left:STICKY_LEFT,maxWidth:o.width,boxSizing:'border-box',padding:'0 6px',fontSize:'.72rem',fontWeight:700,lineHeight:1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',color:SCHEDULE_BAR_TEXT[o.kind],textShadow:SCHEDULE_BAR_SHADOW[o.kind]}}>
                  {o.locked ? '🔒 ' : ''}{o.label}
                </div>
              </div>
            ))}
          </div>
          </div>
          </div>
        </div>
        {/* S575: always-visible horizontal scrollbar hovering just above the legend
            — for mouse users who can't swipe sideways (see updateHbar/dragHbar). */}
        <style>{`.hbar-thumb:hover{background:var(--gold)!important;} .hbar-thumb:active{background:var(--gold)!important;cursor:grabbing!important;}`}</style>
        {/* 10/18: the halves of the bar palette that invert between the dark
            and light themes — the ink on a yellow or bright-green bar, and the
            faded fill a finished stay paints. See SCHEDULE_BAR_THEME_CSS. */}
        <style>{SCHEDULE_BAR_THEME_CSS}</style>
        {hbar.show && (
          <div
            ref={hbarTrackRef}
            onMouseDown={jumpHbar}
            title="Drag to scroll the timeline sideways"
            style={{position:'relative',height:16,background:'var(--bg-3)',borderTop:'1px solid var(--border-1)',cursor:'pointer',flexShrink:0}}
          >
            <div
              ref={hbarThumbRef}
              onMouseDown={dragHbar}
              className="hbar-thumb"
              style={{position:'absolute',top:3,bottom:3,left:`${hbarPos.current.leftPct}%`,width:`${hbarPos.current.thumbPct}%`,minWidth:32,background:'var(--text-3)',borderRadius:5,cursor:'grab'}}
            />
          </div>
        )}
        <div ref={legendRef} style={{padding:'10px 14px 14px',fontSize:'.72rem',color:'var(--text-3)',display:'flex',flexWrap:'wrap',gap:16,borderTop:'1px solid var(--border-1)',background:'var(--bg-2)',borderRadius:'0 0 12px 12px',flexShrink:0}}>
          {/* 10/18 (Nic): the colors mean something now, so the strip says what.
              Status wording comes from the shared labels — never a raw enum. */}
          <span><span style={{display:'inline-block',width:12,height:12,background:'var(--blue)',borderRadius:2,marginRight:4}}/>🔒 Lease (managed on Leases page)</span>
          {/* 10/18 (review): yellow is EVERY stay nobody has arrived at, and a
              tentative hold is yellow too — an unpaid hold a paying guest is
              allowed to take. Naming the amber swatch "Confirmed" told the desk
              a soft hold was locked in, and a clerk reading the board would
              turn away a walk-in who would have paid for that site. It names
              both statuses instead, so the color claims nothing the bar does
              not say. 10/24 (Nic) answered that call: the money splits the amber
              in two, so amber is now the un-arrived stay that has NOT paid and
              purple is the one that has. The wording follows the fills. */}
          <span><span style={{display:'inline-block',width:12,height:12,background:'var(--amber)',borderRadius:2,marginRight:4}}/>Booked, nothing paid yet ({BOOKING_STATUS_LABEL.tentative} or {BOOKING_STATUS_LABEL.confirmed})</span>
          {/* Reads the same theme-aware fill the bar does, so the strip cannot
              drift from the board it explains. */}
          <span><span style={{display:'inline-block',width:12,height:12,background:SCHEDULE_BAR_COLOR.reserved_part_paid,borderRadius:2,marginRight:4}}/>Deposit in — balance still due at arrival</span>  // wire-ok: a schedule bar-kind key on a shared map, not a field off an API response
          {/* 10/24 (Nic): the one the desk acts on — "we don't take money at the
              counter if they're paid in full." */}
          <span><span style={{display:'inline-block',width:12,height:12,background:SCHEDULE_BAR_COLOR.reserved_paid_full,borderRadius:2,marginRight:4}}/>Paid in full — take no money at the counter</span>  // wire-ok: a schedule bar-kind key on a shared map, not a field off an API response
          <span><span style={{display:'inline-block',width:12,height:12,background:'var(--green)',borderRadius:2,marginRight:4}}/>{BOOKING_STATUS_LABEL.checked_in}</span>  // wire-ok: a booking-status key on a shared map, not a field off an API response
          {/* The two faded swatches read the same theme-aware fill the bars do,
              so the strip can never drift from the board it explains. */}
          <span><span style={{display:'inline-block',width:12,height:12,background:SCHEDULE_BAR_COLOR.checked_out,borderRadius:2,marginRight:4}}/>🔒 {BOOKING_STATUS_LABEL.checked_out}</span>  // wire-ok: a booking-status key on a shared map, not a field off an API response
          <span><span style={{display:'inline-block',width:12,height:12,background:SCHEDULE_BAR_COLOR.no_show,borderRadius:2,marginRight:4}}/>🔒 {BOOKING_STATUS_LABEL.no_show}</span>  // wire-ok: a booking-status key on a shared map, not a field off an API response
          <span><span style={{display:'inline-block',width:12,height:12,background:'var(--gold)',borderRadius:2,opacity:.3,marginRight:4}}/>Today</span>
          <span><span style={{display:'inline-block',width:12,height:12,borderRadius:2,opacity:.6,marginRight:4,background:'repeating-linear-gradient(45deg, var(--red) 0 3px, transparent 3px 6px)'}}/>Out of order (faded = was out, now back)</span>
          <span><span style={{display:'inline-block',width:10,height:10,borderRadius:'50%',background:'var(--amber)',border:'2px solid var(--bg-1)',marginRight:4,verticalAlign:'middle'}}/>Ack pending</span>
          {/* 10/24 (Nic): only appears when a park is nearly full, so the strip
              explains it rather than leaving an unexplained ring on a bar. */}
          <span><span style={{display:'inline-block',width:10,height:10,borderRadius:'50%',background:'transparent',border:'2px solid var(--bg-1)',boxShadow:'0 0 0 2px var(--amber, #d9a441)',marginRight:5,marginLeft:2,verticalAlign:'middle'}}/>Ask if they are staying</span>
          {/* 10/18 (review): say where a locked bar's dates CAN be changed —
              "keeps its dates" read as "nothing can change them," and a desk
              with a wrong arrival day on a finished stay needs the one place
              that still corrects it. */}
          <span>· Double-click empty cell to book · Drag block to move · Drag an edge to extend/shorten · A 🔒 bar won't drag — open it and press Edit to correct its dates</span>
        </div>
        </div>
      )}

      {/* ── LIST VIEW ── */}
      {schedulePropertyId && !isLoading && view==='list' && (() => {
        // S527 W-23: next incoming at the top; longer-term / already-arrived
        // below a divider. (Dates dayOnly-sliced per the ISO-timestamp rule —
        // the old rows built Invalid Dates.)
        const todayStr = today
        const live = bookings.filter(b => !['cancelled','no_show'].includes(b.status))
        const arriving = live
          .filter(b => dayOnly(b.checkIn) > todayStr && b.status !== 'checked_out')
          .sort((a, b) => dayOnly(a.checkIn).localeCompare(dayOnly(b.checkIn)))
        const inHouse = live
          .filter(b => dayOnly(b.checkIn) <= todayStr && dayOnly(b.checkOut) > todayStr && b.status !== 'checked_out')
          .sort((a, b) => dayOnly(a.checkOut).localeCompare(dayOnly(b.checkOut)))
        const past = bookings.filter(b => !arriving.includes(b) && !inHouse.includes(b))
        const divider = (label: string) => (
          <div style={{display:'flex',alignItems:'center',gap:10,margin:'6px 0 -2px'}}>
            <span style={{fontSize:'.7rem',fontWeight:700,color:'var(--text-3)',textTransform:'uppercase',letterSpacing:'.08em'}}>{label}</span>
            <div style={{flex:1,height:1,background:'var(--border-0)'}} />
          </div>
        )
        const bookingCard = (b: any) => (
          <div key={b.id} className="card" style={{display:'flex',alignItems:'center',gap:16}}>
            <div style={{width:4,background:'var(--green)',borderRadius:2,alignSelf:'stretch'}} />
            <div style={{flex:1}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                <span style={{fontWeight:600,fontSize:'.88rem'}}>{b.unitNumber}</span>
                <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>{b.propertyName}</span>
                <span className="badge badge-green" style={{fontSize:'.65rem'}}>{LEASE_TYPE_LABELS[b.leaseType] || humanize(b.leaseType)}</span>
                <span className={`badge ${STATUS_COLORS[b.status]||'badge-muted'}`} style={{fontSize:'.65rem'}}>{bookingStatusWords(b.status)}</span>
              </div>
              <div style={{fontSize:'.82rem',color:'var(--text-2)'}}>
                {b.guestName||'Guest'} · {new Date(dayOnly(b.checkIn)+'T12:00:00').toLocaleDateString()} — {new Date(dayOnly(b.checkOut)+'T12:00:00').toLocaleDateString()} ({b.nights} nights)
              </div>
              {b.guestEmail && <div style={{fontSize:'.75rem',color:'var(--text-3)'}}>{b.guestEmail} · {b.guestPhone||''}</div>}
            </div>
            <div style={{textAlign:'right',display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}}>
              <div style={{fontWeight:700,color:'var(--gold)'}}>{fmt(b.totalAmount)}</div>
              {can('guest_access') && !['cancelled','checked_out','no_show'].includes(b.status) && (
                <button className="btn btn-ghost btn-sm" style={{fontSize:'.68rem',padding:'3px 8px',whiteSpace:'nowrap'}}
                  onClick={()=>openGuestAccess(b)}>Guest link</button>
              )}
            </div>
          </div>
        )
        return (
        <div style={{display:'grid',gap:12}}>
          {bookings.length===0 && leases.length===0 && <div className="card" style={{textAlign:'center',padding:48,color:'var(--text-3)'}}>No bookings or leases in this date range.</div>}
          {arriving.length > 0 && divider(`Arriving soon (${arriving.length})`)}
          {arriving.map(bookingCard)}
          {(inHouse.length > 0 || leases.length > 0) && divider(`Currently here (${inHouse.length + leases.length})`)}
          {inHouse.map(bookingCard)}
          {leases.map(l => (
            <div key={l.id} className="card" style={{display:'flex',alignItems:'center',gap:16}}>
              <div style={{width:4,background:'var(--blue)',borderRadius:2,alignSelf:'stretch'}} />
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                  <span style={{fontWeight:600,fontSize:'.88rem'}}>{l.unitNumber}</span>
                  <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>{l.propertyName}</span>
                  <span className="badge badge-blue" style={{fontSize:'.65rem'}}>lease</span>
                </div>
                <div style={{fontSize:'.82rem',color:'var(--text-2)'}}>
                  {l.firstName} {l.lastName} · {new Date(dayOnly(l.startDate)+'T12:00:00').toLocaleDateString()} — {l.endDate ? new Date(dayOnly(l.endDate)+'T12:00:00').toLocaleDateString() : 'ongoing'}
                </div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontWeight:700,color:'var(--gold)'}}>{fmt(l.rentAmount)}/mo</div>
              </div>
            </div>
          ))}
          {past.length > 0 && divider(`Past / canceled (${past.length})`)}
          {past.map(bookingCard)}
        </div>
        )
      })()}

      {/* ── UNITS VIEW ── */}
      {schedulePropertyId && !isLoading && view==='units' && (
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12}}>
          {filteredUnits.map(unit => (
            <div key={unit.id} className="card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
                <div>
                  <div style={{fontWeight:700,fontSize:'.95rem'}}>{unit.unitNumber}</div>
                  <div style={{fontSize:'.72rem',color:TYPE_COLORS[unit.unitType]||'var(--text-3)',marginTop:2}}>{UNIT_TYPE_LABELS[unit.unitType]||humanize(unit.unitType)}</div>
                  <div style={{fontSize:'.7rem',color:'var(--text-3)'}}>{unit.propertyName}</div>
                </div>
                <div style={{display:'flex',gap:4,flexDirection:'column',alignItems:'flex-end'}}>
                  <span className={`badge ${unit.status==='active'?'badge-green':unit.status==='vacant'?'badge-muted':'badge-amber'}`}>{humanize(unit.status)}</span>
                  {unit.isBookable && <span className="badge badge-green" style={{fontSize:'.6rem'}}>Bookable</span>}
                </div>
              </div>
              <div style={{fontSize:'.78rem',display:'grid',gap:3,marginBottom:10}}>
                {unit.nightlyRate && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Nightly</span><span style={{color:'var(--gold)',fontWeight:600}}>{fmt(unit.nightlyRate)}</span></div>}
                {unit.weeklyRate && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Weekly</span><span style={{color:'var(--gold)',fontWeight:600}}>{fmt(unit.weeklyRate)}</span></div>}
                {unit.rentAmount && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Monthly</span><span style={{fontWeight:600}}>{fmt(unit.rentAmount)}</span></div>}
                {unit.tenantFirst && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Tenant</span><span>{unit.tenantFirst} {unit.tenantLast}</span></div>}
              </div>
              {unit.leaseTypesAllowed?.length > 0 && (
                <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:10}}>
                  {unit.leaseTypesAllowed.map((lt:string) => (
                    <span key={lt} style={{fontSize:'.62rem',background:'var(--bg-3)',border:'1px solid var(--border-1)',borderRadius:3,padding:'1px 5px',color:'var(--text-3)'}}>{LEASE_TYPE_LABELS[lt]||humanize(lt)}</span>
                  ))}
                </div>
              )}
              {unit.unitDescription && <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:10,lineHeight:1.5}}>{unit.unitDescription}</div>}
              <div style={{display:'flex',gap:6}}>
                {can('schedule.configure_unit') && <button className="btn btn-ghost btn-sm" style={{flex:1}} onClick={()=>openTypeModal(unit)}>⚙ Configure</button>}
                {unit.isBookable && can('schedule.create_reservation') && <button className="btn btn-primary btn-sm" style={{flex:1}} onClick={()=>openBookingModal(unit)}>+ Book</button>}
              </div>
            </div>
          ))}
          {filteredUnits.length===0 && <div style={{gridColumn:'1/-1',textAlign:'center',padding:48,color:'var(--text-3)'}}>No units found.</div>}
        </div>
      )}

      {/* ── HISTORY VIEW ── reservation change log */}
      {view==='history' && (
        <div className="card" style={{padding:0,maxHeight:'calc(100vh - 200px)',overflowY:'auto'}}>
          <div style={{padding:'10px 16px',borderBottom:'1px solid var(--border-1)',fontWeight:600,fontSize:'.82rem'}}>Reservation change history</div>
          {history.length===0 ? (
            <div style={{padding:48,textAlign:'center',color:'var(--text-3)'}}>No reservation changes yet.</div>
          ) : history.map((e:any) => {
            const COLORS:Record<string,string> = { created:'var(--green)', moved:'var(--blue)', dates_changed:'var(--gold)', status_changed:'var(--amber)', cancelled:'var(--red)' }
            const LABELS:Record<string,string> = { created:'Created', moved:'Moved', dates_changed:'Dates', status_changed:'Status', cancelled:'Canceled' }
            return (
              <div key={e.id} style={{display:'flex',gap:12,alignItems:'center',padding:'9px 16px',borderBottom:'1px solid var(--border-1)'}}>
                <span style={{fontSize:'.6rem',fontWeight:700,color:'#fff',background:COLORS[e.eventType]||'var(--text-3)',borderRadius:4,padding:'2px 7px',minWidth:64,textAlign:'center'}}>{LABELS[e.eventType]||e.eventType}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:'.82rem'}}>{e.summary}</div>
                  <div style={{fontSize:'.68rem',color:'var(--text-3)'}}>
                    Unit {e.unitNumber} · {e.propertyName}
                    {e.actorFirst ? ` · by ${e.actorFirst} ${e.actorLast||''}` : ''}
                  </div>
                </div>
                <span style={{fontSize:'.68rem',color:'var(--text-3)',whiteSpace:'nowrap'}}>{new Date(e.createdAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* ── RESERVATIONS VIEW ── filterable flat table (ported from Bookings) */}
      {view==='reservations' && (
        <div>
          {/* Filters */}
          <div className="card" style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Search guest</label>
                <div style={{ position: 'relative' }}>
                  <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                  <input value={resvSearch} onChange={e => setResvSearch(e.target.value)} placeholder="name or email" className="input" style={{ paddingLeft: 32 }} />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Status</label>
                <select value={resvStatus} onChange={e => setResvStatus(e.target.value)} className="input">
                  <option value="">All</option>
                  {BOOKING_STATUSES.map(st => <option key={st} value={st}>{BOOKING_STATUS_LABEL[st]}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Source</label>
                {/* 10/17 (Nic): every door, not only the travel sites. This
                    offered Direct and four booking sites, so a stay rung at the
                    register, taken on the park's own booking site, or held by
                    an emailed link showed in the list but could not be filtered
                    for (BOOKING_SOURCES). */}
                <select value={resvSource} onChange={e => setResvSource(e.target.value)} className="input">
                  <option value="">All</option>
                  {BOOKING_SOURCES.map(s => <option key={s} value={s}>{BOOKING_SOURCE_LABEL[s]}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>From</label>
                <input type="date" value={resvFrom} onChange={e => setResvFrom(e.target.value)} className="input" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>To</label>
                <input type="date" value={resvTo} onChange={e => setResvTo(e.target.value)} className="input" />
              </div>
            </div>
          </div>

          {pendingAckCount > 0 && (
            <div
              className="card"
              style={{
                padding: '10px 14px', marginBottom: 12,
                background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.3)',
                display: 'flex', alignItems: 'center', gap: 10,
              }}
            >
              <AlertTriangle size={16} style={{ color: 'var(--amber)' }} />
              <span style={{ fontSize: '.85rem', color: 'var(--text-1)' }}>
                <strong>{pendingAckCount}</strong> reservation{pendingAckCount === 1 ? '' : 's'} need{pendingAckCount === 1 ? 's' : ''} property-rules acknowledgment.
                Click <FileSignature size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> on each row after collecting the guest's signature.
              </span>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, padding: '0 4px' }}>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{resvList.length} reservations</div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
              Total revenue: <strong style={{ color: 'var(--text-0)' }}>{fmt(resvTotalAmount)}</strong>
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            {resvLoading ? (
              <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
            ) : resvList.length === 0 ? (
              <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
                No reservations match the filters.
              </div>
            ) : (
              <table className="data-table" style={{ minWidth: 1000 }}>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Guest</th>
                    <th>Unit</th>
                    <th>Check-in</th>
                    <th>Nights</th>
                    <th>Total</th>
                    <th>Source</th>
                    <th>Ack</th>
                    <th>Stay Link</th>
                  </tr>
                </thead>
                <tbody>
                  {resvList.map(b => (
                    <tr key={b.id}>
                      <td><span className={`badge ${RESV_STATUS_BADGE[b.status] || 'badge-muted'}`}>{bookingStatusWords(b.status)}</span></td>
                      <td>
                        <div style={{ color: 'var(--text-0)', fontWeight: 600 }}>{b.guestName || '—'}</div>
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{b.guestEmail || ''}</div>
                      </td>
                      <td>
                        <div style={{ color: 'var(--text-0)' }}>{b.unitNumber}</div>
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{b.propertyName}</div>
                      </td>
                      <td className="mono" style={{ fontSize: '.78rem' }}>
                        {new Date(b.checkIn).toLocaleDateString()}
                        <div style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>→ {new Date(b.checkOut).toLocaleDateString()}</div>
                      </td>
                      <td className="mono">{b.nights}</td>
                      <td className="mono" style={{ color: 'var(--text-0)' }}>{fmt(b.totalAmount)}</td>
                      <td>
                        <span style={{ fontSize: '.72rem', color: 'var(--text-2)' }}>
                          {/* The column is not constrained, so an imported
                              stay can carry a word GAM does not know. */}
                          {BOOKING_SOURCE_LABEL[b.source as BookingSource] ?? humanize(b.source)}
                        </span>
                      </td>
                      <td>
                        {!b.requiresBookingAcknowledgment ? (
                          <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>—</span>
                        ) : b.acknowledgmentSignedAt ? (
                          <span
                            title={`Acknowledged ${new Date(b.acknowledgmentSignedAt).toLocaleString()}`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--green)', fontSize: '.72rem' }}
                          >
                            <CheckCircle2 size={13} /> Acknowledged
                          </span>
                        ) : needsAckResv(b) && can('bookings.acknowledge') ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => ackMut.mutate(b)}
                            disabled={ackMut.isLoading}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--amber)' }}
                            title="Mark this reservation as having a signed property-rules acknowledgment"
                          >
                            <FileSignature size={12} />
                            Acknowledge
                          </button>
                        ) : (
                          <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>n/a</span>
                        )}
                      </td>
                      <td>
                        {can('guest_access') && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setLinkBooking(b)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            title="Show the guest stay-assistant link and QR, or revoke access"
                          >
                            <QrCode size={12} /> Stay link
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {linkBooking && (
            <GuestAccessModal booking={linkBooking} onClose={() => setLinkBooking(null)} />
          )}
        </div>
      )}

      {/* ── REQUESTS VIEW ── guest change-requests (ported from Bookings) */}
      {view==='requests' && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <MessageSquare size={16} style={{ color: 'var(--gold)' }} />
            <strong style={{ fontSize: '.9rem' }}>Guest requests</strong>
            {changeRequests.length > 0 && <span className="badge badge-blue" style={{ marginLeft: 2 }}>{changeRequests.length}</span>}
          </div>
          {changeRequests.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: '.84rem' }}>No open guest requests.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {changeRequests.map(cr => (
                <div
                  key={cr.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 12, flexWrap: 'wrap',
                    padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8,
                    background: 'var(--bg-1)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span className="badge badge-blue">{BOOKING_CHANGE_REQUEST_TYPE_LABEL[cr.requestType]}</span>
                      <strong style={{ fontSize: '.88rem' }}>{cr.guestName || 'Guest'}</strong>
                      <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                        {cr.propertyName || '—'}{cr.unitNumber ? ` · Unit ${cr.unitNumber}` : ''}
                        {' · '}{fmtDate(cr.checkIn)}–{fmtDate(cr.checkOut)}
                      </span>
                    </div>
                    {cr.details && (
                      <div style={{ fontSize: '.82rem', color: 'var(--text-1)', marginTop: 4 }}>{cr.details}</div>
                    )}
                  </div>
                  {can('bookings.resolve_change_request') && (
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <button
                        className="btn btn-sm"
                        disabled={resolveMut.isLoading}
                        onClick={() => resolveMut.mutate({ id: cr.id, status: 'approved' })}
                      >
                        <Check size={13} /> Approve
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={resolveMut.isLoading}
                        onClick={() => resolveMut.mutate({ id: cr.id, status: 'declined' })}
                      >
                        <X size={13} /> Decline
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── BOOKING PAGE VIEW ── public per-property booking-site config (ported from BookingSitesPage) */}
      {view==='booking_page' && (
        <div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: '.9rem', fontWeight: 700 }}>Booking Page</div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Public per-property booking pages — guests book short stays and pay a deposit</div>
          </div>

          <div className="card" style={{ padding: 16, maxWidth: 560 }}>
            <label className="form-label">Property</label>
            <select className="input" value={bpPropId} onChange={e => setBpPropId(e.target.value)} style={{ marginBottom: 16 }}>
              {bpProperties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>

            {!bpCfg ? <div style={{ color: 'var(--text-3)' }}>Loading…</div> : (
              <>
                <label className="form-label">Booking address (slug)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <input className="input" value={bpCfg.slug || ''} placeholder="oak-park-yarnell"
                    onChange={e => setBpCfg((c: any) => ({ ...c, slug: e.target.value.toLowerCase() }))} style={{ flex: 1 }} />
                </div>
                <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 14 }}>
                  Lowercase letters, numbers, hyphens. Your site: {bpPublicUrl
                    ? <a href={bpPublicUrl} target="_blank" rel="noreferrer">{bpPublicUrl}</a>
                    : '— set a slug first'}
                </div>

                <label className="form-label">Welcome text (optional)</label>
                <textarea className="input" rows={3} value={bpCfg.intro || ''}
                  onChange={e => setBpCfg((c: any) => ({ ...c, intro: e.target.value }))} style={{ marginBottom: 14, resize: 'vertical' }} />

                <div style={{ borderTop: '1px solid var(--border-1)', margin: '6px 0 14px' }} />
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Stay rates</div>
                <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 10 }}>
                  Used for every reservation at this property (Master Schedule + booking site). The rate tier
                  follows the length of stay — under 7 nights nightly, 7–29 weekly, 30+ monthly — prorated for
                  odd lengths.
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
                  <div>
                    <label className="form-label">Nightly ($)</label>
                    <input className="input" type="number" min={0} value={bpCfg.nightlyRate ?? ''} placeholder="—"
                      onChange={e => setBpCfg((c: any) => ({ ...c, nightlyRate: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">Weekly ($)</label>
                    <input className="input" type="number" min={0} value={bpCfg.weeklyRate ?? ''} placeholder="—"
                      onChange={e => setBpCfg((c: any) => ({ ...c, weeklyRate: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">Monthly ($)</label>
                    <input className="input" type="number" min={0} value={bpCfg.monthlyRate ?? ''} placeholder="—"
                      onChange={e => setBpCfg((c: any) => ({ ...c, monthlyRate: e.target.value }))} />
                  </div>
                </div>

                <label className="form-label">Short-term lodging tax (applied to stays under 30 nights; 30+ is tax-exempt)</label>
                {/* 10/17 (Nic, one home for a tax rate): this was an editable box, and it was
                    the one that actually priced a stay — it sat at 6.35% for three weeks after
                    the company's own tax list was changed to 6.6%. It is a figure now, not a
                    box: it follows the tax ticked "charged on a stay here" in the register's
                    Taxes screen, so the two can never disagree again. */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>{Number(bpCfg.shortTermTaxRate ?? 0).toFixed(2)}%</div>
                  <div style={{ fontSize: '.78rem', color: 'var(--text-3)', lineHeight: 1.5, maxWidth: 520 }}>
                    {(bpCfg.shortTermTaxNames || []).length
                      ? `From ${(bpCfg.shortTermTaxNames || []).join(' + ')} in your list of taxes. Change the rate there and every stay here is priced with it — the booking site, a pay link and the front desk.`
                      : 'No tax is charged on stays here yet. Add one on the Taxes screen and tick "Charged on a stay here", and this figure follows it.'}
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border-1)', margin: '6px 0 14px' }} />
                <label className="form-label">Deposit for short stays (% of stay total — stays under 30 nights)</label>
                <input className="input" type="number" min={0} max={100} value={bpCfg.depositPct}
                  onChange={e => setBpCfg((c: any) => ({ ...c, depositPct: e.target.value }))} style={{ marginBottom: 14, maxWidth: 140 }} />

                <label className="form-label">Deposit for monthly stays ($ flat — 30+ nights)</label>
                <input className="input" type="number" min={0} value={bpCfg.monthlyDeposit ?? ''} placeholder="150"
                  onChange={e => setBpCfg((c: any) => ({ ...c, monthlyDeposit: e.target.value }))} style={{ marginBottom: 4, maxWidth: 140 }} />
                <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 16 }}>
                  Blank = $150 default. Always capped at one month's rent — long-term guests never owe more than a month up front.
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
                  <input type="checkbox" checked={bpCfg.utilitiesBilled !== false} onChange={e => setBpCfg((c: any) => ({ ...c, utilitiesBilled: e.target.checked }))} />
                  <span>Utilities billed back on monthly stays (quote shows "plus utilities")</span>
                </label>

                <div style={{ borderTop: '1px solid var(--border-1)', margin: '6px 0 14px' }} />
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Contact page</div>
                <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 10 }}>
                  Shown on the website's Contact page with the property address and the message form.
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                  <div>
                    <label className="form-label">Office phone</label>
                    <input className="input" value={bpCfg.officePhone ?? ''} placeholder="(555) 555-0100"
                      onChange={e => setBpCfg((c: any) => ({ ...c, officePhone: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">Office email</label>
                    <input className="input" type="email" value={bpCfg.officeEmail ?? ''} placeholder="office@yourpark.com"
                      onChange={e => setBpCfg((c: any) => ({ ...c, officeEmail: e.target.value }))} />
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>Replies from residents and guests to our emails come here too.</div>
                  </div>
                </div>
                <label className="form-label">Office hours</label>
                <textarea className="input" rows={3} value={bpCfg.officeHours ?? ''}
                  placeholder={'Mon–Fri 9am–5pm\nSat 10am–2pm\nClosed Sunday'}
                  onChange={e => setBpCfg((c: any) => ({ ...c, officeHours: e.target.value }))} style={{ marginBottom: 16, resize: 'vertical' }} />

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!bpCfg.enabled} onChange={e => setBpCfg((c: any) => ({ ...c, enabled: e.target.checked }))} />
                  <span><b>Publish</b> this booking site (live to the public)</span>
                </label>

                {can('booking_sites.edit') && <button className="btn" disabled={bpSaving} onClick={saveBookingConfig}>{bpSaving ? 'Saving…' : 'Save'}</button>}
                {bpMsg && <span style={{ color: 'var(--green)', marginLeft: 12 }}>{bpMsg}</span>}
                {bpErr && <span style={{ color: 'var(--red,#ff6b81)', marginLeft: 12 }}>{bpErr}</span>}
              </>
            )}
          </div>

          {/* ── S547: website photos ── */}
          {bpCfg && (
            <div className="card" style={{ padding: 16, maxWidth: 560, marginTop: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Website photos</div>
              <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 12 }}>
                Shown in the Gallery and on the home page of this property’s website. JPEG/PNG/WebP, up to 10 MB each.
              </div>
              {can('booking_sites.edit') && (
                <label className="btn" style={{ display: 'inline-block', marginBottom: 12, cursor: 'pointer' }}>
                  {bpUploading ? 'Uploading…' : 'Add photos'}
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden
                    disabled={bpUploading}
                    onChange={e => { uploadSitePhotos(e.target.files); e.target.value = '' }} />
                </label>
              )}
              {bpPhotos.length === 0 ? (
                <div style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>No photos yet.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                  {bpPhotos.map((ph: any) => (
                    <div key={ph.id}>
                      <AuthThumb url={`/properties/${bpPropId}/site-photos/${ph.id}/file`} />
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '4px 0', minHeight: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ph.caption || '—'}</div>
                      {can('booking_sites.edit') && (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => captionSitePhoto(ph.id, ph.caption)}>Caption</button>
                          <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => deleteSitePhoto(ph.id)}>Remove</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── S547: website FAQs ── */}
          {bpCfg && (
            <div className="card" style={{ padding: 16, maxWidth: 560, marginTop: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Website FAQ</div>
              <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 12 }}>
                Questions guests ask before booking — office hours, pets, rig limits, cancellation policy.
              </div>
              {bpFaqs.map((f: any) => (
                <div key={f.id} style={{ borderTop: '1px solid var(--border-1)', padding: '10px 0' }}>
                  <div style={{ fontWeight: 600, fontSize: '.88rem' }}>{f.question}</div>
                  <div style={{ color: 'var(--text-3)', fontSize: '.84rem', whiteSpace: 'pre-wrap', margin: '4px 0 6px' }}>{f.answer}</div>
                  {can('booking_sites.edit') && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => editFaq(f)}>Edit</button>
                      <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => deleteFaq(f.id)}>Delete</button>
                    </div>
                  )}
                </div>
              ))}
              {bpFaqs.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: '.85rem', marginBottom: 10 }}>No FAQs yet.</div>}
              {can('booking_sites.edit') && (
                <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 12, marginTop: 6 }}>
                  <label className="form-label">Question</label>
                  <input className="input" value={bpFaqDraft.question}
                    onChange={e => setBpFaqDraft(d => ({ ...d, question: e.target.value }))} style={{ marginBottom: 8 }} />
                  <label className="form-label">Answer</label>
                  <textarea className="input" rows={3} value={bpFaqDraft.answer}
                    onChange={e => setBpFaqDraft(d => ({ ...d, answer: e.target.value }))} style={{ marginBottom: 10, resize: 'vertical' }} />
                  <button className="btn" disabled={!bpFaqDraft.question.trim() || !bpFaqDraft.answer.trim()} onClick={addFaq}>Add FAQ</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── RESERVATION DETAIL ── click a bar to view */}
      {oooUnit && <OutOfOrderModal unit={oooUnit} onClose={() => setOooUnit(null)} />}
      {leaveDateFor && (
        <LeaseLeaveDateModal lease={leaveDateFor}
          onClose={()=>setLeaveDateFor(null)}
          onSaved={()=>{ setLeaveDateFor(null); setDetailBooking(null); qc.invalidateQueries('schedule'); qc.invalidateQueries('leases') }} />
      )}
      {checkOutFor && (
        <EarlyCheckOutModal unitId={checkOutFor.unitId} bookingId={checkOutFor.bookingId}
          onClose={() => {
            setCheckOutFor(null)
            try {
              const url = new URL(window.location.href)
              if (url.searchParams.has('checkout')) {
                url.searchParams.delete('checkout'); url.searchParams.delete('unit')
                window.history.replaceState(null, '', url.toString())
              }
            } catch { /* nothing to tidy */ }
          }} />
      )}
      {detailBooking && (() => {
        const d = detailBooking
        const isLease = !!d.isLease
        // S527 W-18: dates arrive as full ISO timestamps — dayOnly-slice BEFORE
        // any display or math (the old `new Date(iso + 'T12:00:00')` built an
        // Invalid Date and rendered "NaN nights").
        const start = dayOnly(isLease ? d.startDate : d.checkIn)
        const end = (isLease ? d.endDate : d.checkOut) ? dayOnly(isLease ? d.endDate : d.checkOut) : null
        const nights = (start && end) ? Math.max(0, Math.round((new Date(end+'T12:00:00').getTime()-new Date(start+'T12:00:00').getTime())/86400000)) : (d.nights||0)
        const fmtDay = (s: string | null) => s ? new Date(s+'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null
        const name = isLease ? `${d.firstName||''} ${d.lastName||''}`.trim() : (d.guestName || 'Guest')
        // W-18: payment state — paid in full, deposit-only (show balance), or unpaid.
        const total = d.totalAmount != null ? Number(d.totalAmount) : null
        const depositPaid = !isLease && !!d.depositPaidAt && d.depositAmount != null ? Number(d.depositAmount) : null
        const closeDetail = () => {
          setDetailBooking(null); setEditForm(null); setEditError('')
          // 10/5: a stay opened from a notice (?booking=&unit=) does not open again on the next visit.
          try {
            const url = new URL(window.location.href)
            if (url.searchParams.has('booking')) {
              url.searchParams.delete('booking'); url.searchParams.delete('unit')
              window.history.replaceState(null, '', url.toString())
            }
          } catch { /* nothing to tidy */ }
        }
        const isEditing = !isLease && !!editForm
        // Live re-price preview while editing (unit rate → property default).
        const eu = isEditing ? units.find((u:any)=>u.id===editForm!.unitId) : null
        const eNights = isEditing && editForm!.checkIn && editForm!.checkOut && editForm!.checkOut>editForm!.checkIn
          ? stayNightsBetween(editForm!.checkIn, editForm!.checkOut) : 0
        // 10/6: the one price every door charges (shared priceStay).
        const ePrice = eu && eNights > 0 ? priceStay(
          { nightly: eu.nightlyRate ?? eu.propertyNightlyRate, weekly: eu.weeklyRate ?? eu.propertyWeeklyRate, monthly: eu.monthlyRate ?? eu.propertyMonthlyRate },
          Number(eu.propertyTaxRate || 0), editForm!.checkIn, eNights) : null
        const editValid = isEditing && eNights > 0 && !!editForm!.guestName.trim()
        // W-19: filter-first — options are the server's available+compatible
        // list; the current unit always stays so the selection can't vanish
        // (the mismatch warning below covers it if it no longer qualifies).
        const availIds = editAvailableUnits ? new Set((editAvailableUnits as any[]).filter((u:any)=>u.isBookable).map((u:any)=>u.id)) : null
        const unitOptions = units.filter((u:any)=> (availIds ? availIds.has(u.id) : u.isBookable) || u.id===editForm?.unitId)
        const editReasons = isEditing ? rvMismatchReasons(editForm!.requiredSiteLayout, editForm!.requiredAmpService, eu, editForm!.rigLengthFt) : []
        return (
        <div className="modal-overlay" onClick={closeDetail}>
          <div className="modal" style={{maxWidth:440}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{isEditing ? 'Edit reservation' : (isLease ? 'Lease' : 'Reservation')} · {name||'—'}</span>
              <button className="btn btn-ghost btn-sm" onClick={closeDetail}>✕</button>
            </div>
            <div style={{padding:'4px 24px 24px'}}>
              {isEditing ? (
                <div style={{display:'grid',gap:12}}>
                  <div>
                    <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Unit</div>
                    <select className="form-input" style={{width:'100%'}} value={editForm!.unitId} onChange={e=>setEditForm(s=>s&&({...s,unitId:e.target.value}))}>
                      {unitOptions.map((u:any)=><option key={u.id} value={u.id}>{u.unitNumber} · {u.propertyName}{u.rvSiteLayout && u.rvSiteLayout!=='none' ? ` (${RV_SITE_LAYOUT_LABEL[u.rvSiteLayout as keyof typeof RV_SITE_LAYOUT_LABEL]})` : ''}{u.id!==d.unitId && ((d.avoidedUnitIds||[]) as string[]).includes(u.id) ? ' — they asked not to be here' : ''}</option>)}
                    </select>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                    <div>
                      <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Required site layout</div>
                      <select className="form-input" style={{width:'100%'}} value={editForm!.requiredSiteLayout} onChange={e=>setEditForm(s=>s&&({...s,requiredSiteLayout:e.target.value}))}>
                        {RV_SITE_LAYOUTS.map(l=><option key={l} value={l}>{l==='none'?'No preference':RV_SITE_LAYOUT_LABEL[l]}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Required amp service</div>
                      <select className="form-input" style={{width:'100%'}} value={editForm!.requiredAmpService} onChange={e=>setEditForm(s=>s&&({...s,requiredAmpService:e.target.value}))}>
                        {RV_AMP_SERVICES.filter(a=>a!=='both').map(a=><option key={a} value={a}>{a==='none'?'No preference':RV_AMP_SERVICE_LABEL[a]}</option>)}
                      </select>
                    </div>
                    <div>
                      {/* 10/24 (Nic): correctable here, because a rig gets
                          measured wrong at the counter and the number decides
                          every later move the schedule may make for this stay. */}
                      <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Rig length (feet)</div>
                      <input className="form-input" type="number" min={1} max={MAX_RIG_LENGTH_FT} style={{width:'100%'}}
                        placeholder="not given"
                        value={editForm!.rigLengthFt ?? ''}
                        onChange={e=>setEditForm(s=>s&&({...s,rigLengthFt: e.target.value===''?null:Number(e.target.value)}))} />
                    </div>
                  </div>
                  {editReasons.length>0 && <div style={{fontSize:'.7rem',color:'var(--amber)'}}>⚠ Unit {eu?.unitNumber}: {editReasons.join('; ')}. You can still save.</div>}
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Sites to avoid</div>
                    <input className="form-input" style={{width:'100%'}} placeholder="e.g. RV 12, RV 14" value={editForm!.avoid} onChange={e=>setEditForm(s=>s&&({...s,avoid:e.target.value}))} /></div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                    <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Check-in</div><input className="form-input" type="date" style={{width:'100%'}} value={editForm!.checkIn} onChange={e=>setEditForm(s=>s&&({...s,checkIn:e.target.value}))} /></div>
                    <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Check-out</div><input className="form-input" type="date" style={{width:'100%'}} value={editForm!.checkOut} onChange={e=>setEditForm(s=>s&&({...s,checkOut:e.target.value}))} /></div>
                  </div>
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Guest name</div><input className="form-input" style={{width:'100%'}} value={editForm!.guestName} onChange={e=>setEditForm(s=>s&&({...s,guestName:e.target.value}))} /></div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                    <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Email</div><input className="form-input" style={{width:'100%'}} value={editForm!.guestEmail} onChange={e=>setEditForm(s=>s&&({...s,guestEmail:e.target.value}))} /></div>
                    <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Phone</div><input className="form-input" type="tel" style={{width:'100%'}} value={editForm!.guestPhone} onChange={e=>setEditForm(s=>s&&({...s,guestPhone:typingPhone(e.target.value)}))} /></div>
                  </div>
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Notes</div><textarea className="form-input" style={{width:'100%',minHeight:54}} value={editForm!.notes} onChange={e=>setEditForm(s=>s&&({...s,notes:e.target.value}))} /></div>
                  {/* 10/6 (Nic): the stay's work trade — ticked, changed or taken off. */}
                  {can('work_trade.manage') && (
                    <div style={{padding:'10px 12px',border:'1px solid var(--border-1)',borderRadius:8,background:'var(--bg-2)'}}>
                      <label style={{display:'flex',alignItems:'center',gap:8,fontSize:'.8rem',fontWeight:600,color:'var(--text-0)',cursor:'pointer'}}>
                        <input type="checkbox" checked={editWorkTrade} onChange={e=>setEditWorkTrade(e.target.checked)} />
                        Work trade
                      </label>
                      {editWorkTrade && (
                        <div style={{marginTop:10}}>
                          <WorkTradeTermsFields value={editWt} onChange={setEditWt} propertyHours={wtTarget?.target ?? null} />
                        </div>
                      )}
                      {!editWorkTrade && d.workTrade && (
                        <div style={{fontSize:'.72rem',color:'var(--text-3)',marginTop:4}}>Saving ends their work trade.</div>
                      )}
                    </div>
                  )}
                  {/* 10/6 (Nic): a returning guest needs no background check. */}
                  {d.returningGuestAt
                    ? <div style={{fontSize:'.74rem',color:'var(--text-2)'}}>{RETURNING_GUEST_DETAIL}</div>
                    : editOffer.data?.screening === 'fee_due' && (
                      <ReturningGuestChoice offer={editOffer.data.returning} checked={editReturning}
                        onChange={setEditReturning} fee={editOffer.data.screeningFee} />
                    )}
                  {ePrice && <div style={{fontSize:'.78rem',color:'var(--text-3)'}}>{eNights} night{eNights===1?'':'s'} · new total <span style={{color:'var(--gold)',fontWeight:600}}>{editWorkTrade && editWt.coveredCharges.includes('rent') ? fmt(0) + ' — rent covered by work trade' : fmt(ePrice.total)}</span></div>}
                  {editError && <div style={{fontSize:'.76rem',color:'var(--red,#ff6b81)'}}>{editError}</div>}
                  <div style={{display:'flex',gap:8,marginTop:4}}>
                    <button className="btn btn-ghost btn-sm" onClick={()=>{setEditForm(null);setEditError('')}}>Cancel</button>
                    <button className="btn btn-primary btn-sm" style={{marginLeft:'auto'}} disabled={!editValid || editBookingMut.isLoading || (editWorkTrade && !editWt.coveredCharges.length)}
                      onClick={()=>editBookingMut.mutate({orig:d, form:editForm!})}>
                      {editBookingMut.isLoading?'Saving…':'Save changes'}
                    </button>
                  </div>
                </div>
              ) : (<>
              {/* S527 W-18/W-55: ONE window shape for every bar type — same
                  fields for leases and stays; clean day-only dates. */}
              <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'8px 14px',fontSize:'.84rem'}}>
                <div style={{color:'var(--text-3)'}}>Unit</div><div>{d.unitNumber} · {d.propertyName}</div>
                <div style={{color:'var(--text-3)'}}>{isLease?'Term':'Stay'}</div><div>{fmtDay(start)} → {end ? fmtDay(end) : 'ongoing'} {end ? <span style={{color:'var(--text-3)'}}>({nights} night{nights===1?'':'s'})</span> : null}</div>
                {(d.guestEmail || d.email) && <><div style={{color:'var(--text-3)'}}>Email</div><div>{d.guestEmail || d.email}</div></>}
                {(d.guestPhone || d.phone) && <><div style={{color:'var(--text-3)'}}>Phone</div><div>{d.guestPhone || d.phone}</div></>}
                {isLease && d.rentAmount != null && <><div style={{color:'var(--text-3)'}}>Rent</div><div style={{color:'var(--gold)',fontWeight:600}}>{fmt(d.rentAmount)}/mo</div></>}
                {!isLease && total != null && (
                  <><div style={{color:'var(--text-3)'}}>Payment</div>
                  <div>
                    {depositPaid != null ? (
                      <>Deposit <strong>{fmt(depositPaid)}</strong> paid · <span style={{color:'var(--amber)',fontWeight:600}}>balance due {fmt(Math.max(0, total - depositPaid))}</span></>
                    ) : (
                      <>Total <span style={{color:'var(--gold)',fontWeight:600}}>{fmt(total)}</span> <span style={{color:'var(--text-3)'}}>· no payment recorded</span></>
                    )}
                  </div></>
                )}
                <div style={{color:'var(--text-3)'}}>Status</div>
                <div>
                  {isLease ? humanize(d.status) : bookingStatusWords(d.status)}
                  {/* 10/17 (Nic): "reservations are only locked in with deposits.
                      still reserved without deposits but can be booted when space
                      is limited by other paying people." The badge said
                      "Tentative" and left the desk to infer the consequence; this
                      is the consequence, in a sentence. Not a third status — the
                      software already decides it by whether a deposit is paid. */}
                  {!isLease && stayHoldWords(d.status as BookingStatus, !!d.depositPaidAt) && (
                    <div style={{fontSize:'.74rem',color:d.depositPaidAt?'var(--text-3)':'var(--amber)',marginTop:2,lineHeight:1.45}}>
                      {stayHoldWords(d.status as BookingStatus, !!d.depositPaidAt)}
                    </div>
                  )}
                </div>
                {/* 10/20 (Nic): WHY THIS STAY CANNOT BE MOVED, where the desk
                    reads the stay. "They may have already gotten a confirmation
                    on a space number. Our system with compression and expansion
                    is going to kind of screw that up if they think they're
                    locked to a specific site already." A lock with no reason on
                    screen is a lock somebody unlocks to free up a space, and
                    then a guest who was promised 14 arrives to find a rig on
                    it. */}
                {/* 10/20 (Nic, his own catch): and never a reason that lies.
                    This read "Locked to RV 09 — Promised this space before GAM"
                    after somebody dragged Dale off RV 14 — a sentence about a
                    promise nobody made, with the one fact that mattered (the
                    number in his hand is wrong now) nowhere on the screen.
                    scheduleStayLockWords reads the reason the move itself
                    wrote. */}
                {!isLease && d.lockedToUnit && (
                  <><div style={{color:'var(--text-3)'}}>Locked to {d.unitNumber}</div>
                  <div data-testid="stay-lock-reason" style={{color:'var(--gold)',lineHeight:1.45}}>{scheduleStayLockWords(d.lockReason)}</div></>
                )}
                {/* Where this reservation came from, when it was not taken here.
                    The guest has already been told, so GAM does not confirm
                    them again (routes/bookings) — and the desk can see why no
                    confirmation has gone out. */}
                {!isLease && d.migratedDoor && (
                  <><div style={{color:'var(--text-3)'}}>Came from</div>
                  <div style={{lineHeight:1.45}}>
                    {MIGRATED_DOOR_LABEL[d.migratedDoor] ?? 'Brought in from somewhere else'}
                    {/* 10/20: what GAM has and has not sent this guest. This said
                        GAM had not emailed them while the morning-of site reveal
                        was emailing them a site number anyway; the reveal now
                        reads the same fact this line reports (jobs/scheduler
                        revealTodaysSites), so the two can no longer disagree. */}
                    {d.confirmationSentAt ? (
                      <div style={{fontSize:'.74rem',color:'var(--text-3)',marginTop:2}}>
                        We emailed them their confirmation on{' '}
                        {new Date(d.confirmationSentAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
                        {' '}— their site follows on the morning they arrive.
                      </div>
                    ) : (
                      <div style={{fontSize:'.74rem',color:'var(--text-3)',marginTop:2}}>
                        {d.toldOutsideGam ? 'Already told they have this reservation, so' : ''}
                        GAM has emailed them nothing — not even their site on the morning
                        they arrive — until somebody sends the confirmation.
                      </div>
                    )}
                    {d.depositOffPlatformMethod && (
                      <div style={{fontSize:'.74rem',color:'var(--text-3)',marginTop:2}}>
                        Their deposit was paid outside GAM — written down here, never processed by us.
                      </div>
                    )}
                  </div></>
                )}
                {/* 10/18 (Nic): the guest HAS been asked, so nobody asks them a
                    fourth time — and the desk can see the ask went out even
                    though the deposit has not landed. */}
                {!isLease && d.depositLinkSentAt && !d.depositPaidAt && (
                  <><div style={{color:'var(--text-3)'}}>Deposit link</div>
                  {/* The desk's own clock, with the hour: a second press
                      inside the hour never emails again, so "how long ago"
                      is the thing they need to read (the same shape as the
                      change-history rows above). */}
                  <div>Emailed to {d.guestEmail || 'the guest'} · {new Date(d.depositLinkSentAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</div></>
                )}
                {/* 10/5 (Nic, R2): lease or stay — the desk's answer for a stay of 30+ nights. */}
                {!isLease && (d.stayLeaseId || d.stayTerms) && (
                  <><div style={{color:'var(--text-3)'}}>Lease or stay</div>
                  <div>
                    {d.stayLeaseId || d.stayTerms === 'lease' ? STAY_TERMS_LABEL.lease : STAY_TERMS_LABEL[d.stayTerms as StayTerms]}
                    {d.stayLeaseId && (
                      <button className="btn btn-ghost btn-sm" style={{marginLeft:8,padding:'1px 8px',fontSize:'.7rem'}}
                        onClick={()=>navigate(`/leases?open=${d.stayLeaseId}`)}>Open the lease</button>
                    )}
                    {!d.stayLeaseId && d.stayTerms === 'stay' && d.checkOut && (
                      <div style={{fontSize:'.74rem',color:'var(--text-3)',marginTop:2}}>Held through {longCalendarDate(dayOnly(d.checkOut))} — after that the site can be booked by someone else.</div>
                    )}
                  </div></>
                )}
                {/* 10/6 (Nic): what the desk confirmed, and the stay's work trade. */}
                {!isLease && d.returningGuestAt && (
                  <><div style={{color:'var(--text-3)'}}>Background check</div><div>{RETURNING_GUEST_DETAIL}</div></>
                )}
                {!isLease && d.workTrade && (
                  <><div style={{color:'var(--text-3)'}}>Work trade</div><div>{workTradeLine(d.workTrade)}</div></>
                )}
                {/* 10/5 (Nic, R9): check-in waits on the background check. */}
                {!isLease && d.screeningBlock && (
                  <><div style={{color:'var(--text-3)'}}>Check-in</div>
                  <div style={{color:'var(--amber)'}}>{d.screeningBlock.message}</div></>
                )}
                {!isLease && (d.avoidedUnitIds||[]).length>0 && <><div style={{color:'var(--text-3)'}}>Avoids</div><div>{(d.avoidedUnitIds as string[]).map(id=>unitNumberOf(id)).filter(Boolean).join(', ')}</div></>}
                {d.notes && <><div style={{color:'var(--text-3)'}}>Notes</div><div>{d.notes}</div></>}
              </div>
              {isLease ? (
                /* 10/22 (Nic): "I need to be able to just click on it on the
                    reservation list and move to check them out. Clicking it only
                    pulls up a view only page... That should kind of pull up the
                    same menu on the leases."
                    And the reason it matters, in his words: "people with a lease
                    right now, it's blocked out indefinitely. But if somebody tells
                    me with notice, hey, I'm going to be leaving in about 2 weeks,
                    I should be able to edit that lease so that that spot can be
                    freed up for reservations, especially if we're in a busy season
                    with a tight window."
                    Checking out is NOT rebuilt here. The register's Checkout tab
                    already closes a lease (routes/pos due-out takes
                    kind: 'stay' | 'lease') and it is the only place that reads the
                    final meters, so this sends him there rather than growing a
                    second way to do the same thing badly. */
                <div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:18}}>
                  <button className="btn btn-ghost btn-sm" onClick={()=>navigate(`/leases?open=${d.id}`)}>
                    Open the lease
                  </button>
                  {can('leases.edit') && (
                    <button className="btn btn-primary btn-sm" onClick={()=>setLeaveDateFor(d)}>
                      {d.endDate ? 'Change the move-out date' : 'They gave notice'}
                    </button>
                  )}
                  {can('guests.check_out') && (
                    <button className="btn btn-primary btn-sm"
                      onClick={()=>navigate(`/pos?tab=checkout&property=${d.propertyId || ''}`)}>
                      Check out
                    </button>
                  )}
                </div>
              ) : (
                <div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:18}}>
                  {can('guest_access') && <button className="btn btn-ghost btn-sm" onClick={()=>copyStayLink(d)}>Copy stay link</button>}
                  {/* 10/18 (Nic): "that reservation becomes locked as part of the
                      history." Nic's words are about the dates not moving by
                      ACCIDENT — "I can't change the dates accidentally" — and
                      the bar itself delivers that now: a finished stay will not
                      drag, carries no edge grips, and right-click opens its
                      window instead of dropping into the date editor.
                      10/18 (review): Edit STAYS on a finished stay, because it
                      is the deliberate press and the only place its dates can be
                      put right. A desk that typed Sep 30 for an Oct 1 arrival
                      sold and priced six nights instead of five, and the
                      check-out screen cannot fix that — it never asks for a date
                      on a stay that has already checked out. The server treats
                      this as a deliberate re-date, reprices the stay to the new
                      length, and refuses it in words once a refund has gone out,
                      so nothing moves money quietly behind it. */}
                  {can('schedule.edit_reservation') && d.status!=='cancelled' && (
                    <button className="btn btn-ghost btn-sm"
                      title={isScheduleBarLocked(d)
                        ? 'This stay is history, so its dates never move on the board. '
                          + 'Change them here only to correct what was recorded — the stay is repriced to match.'
                        : undefined}
                      onClick={()=>startEdit(d)}>Edit</button>
                  )}
                  {/* 10/18 (Nic): "let's add a button so that we can collect
                      deposits from people that haven't done it for their
                      stays." Offered on exactly what the server will accept
                      (@gam/shared stayDepositAsk: still holding its site,
                      nobody's money on it, an email to send to), to whoever may
                      take a reservation AND take payments — the same pair a
                      shortened stay's charges ask for (10/14, Nic: "anyone who
                      can schedule reservations and take payments"). */}
                  {(can('schedule.create_reservation') || can('schedule.edit_reservation'))
                    && (can('take_payment') || can('pos.ring_sale'))
                    && stayDepositAsk(d) === 'ask' && (
                    <button className="btn btn-primary btn-sm" disabled={askDepositMut.isLoading}
                      /* 10/18 (review): "Show the deposit link" promised more
                         than the button does — a link the guest's card declined
                         on and the clerk closed is gone, and pressing it then
                         sends a fresh one. "Ask again" is true either way. */
                      title={d.depositLinkSentAt
                        ? 'Shows the link already out for this reservation to read out, or sends a fresh one if that link was closed. The guest is never emailed twice within the hour.'
                        : 'Email the guest a link for the deposit. Paid, it locks this reservation in so nobody can take the site.'}
                      onClick={()=>askDepositMut.mutate(d)}>
                      {askDepositMut.isLoading ? '…' : d.depositLinkSentAt ? 'Ask again' : 'Ask for the deposit'}
                    </button>
                  )}
                  {/* S559: front-desk check-in (guard prompts a closing read if the prior guest's meter is unread). */}
                  {can('guests.check_in') && ['tentative','confirmed'].includes(d.status) && (
                    <button className="btn btn-primary btn-sm" disabled={checkInMut.isLoading} onClick={()=>checkInMut.mutate(d)}>
                      {checkInMut.isLoading?'…':'Check in'}
                    </button>
                  )}
                  {/* 10/5 (Nic, R6): extend this same stay by a calendar month, rung up at the register. */}
                  {can('schedule.edit_reservation') && ['confirmed','checked_in'].includes(d.status)
                    && !d.stayLeaseId && d.stayTerms !== 'lease' && (
                    <button className="btn btn-primary btn-sm" onClick={()=>setAddMonthFor(d)}>Add a month</button>
                  )}
                  {/* 10/5 (Nic, R2/R4): a stay with no lease can be offered one. */}
                  {can('schedule.edit_reservation') && ['tentative','confirmed','checked_in'].includes(d.status)
                    && !d.stayLeaseId && d.stayTerms !== 'lease' && (
                    <button className="btn btn-primary btn-sm" onClick={()=>offerLease(d)}>Offer a lease</button>
                  )}
                  {/* 10/4 (decisions #38): check out — on the day or early — and settle the money. */}
                  {can('guests.check_out') && d.status === 'checked_in' && (
                    <button className="btn btn-primary btn-sm" onClick={()=>{ setCheckOutFor({ unitId: d.unitId, bookingId: d.id }); setDetailBooking(null) }}>
                      Check out
                    </button>
                  )}
                  {(can('guests.check_out') || can('pos.refund')) && d.status === 'checked_out' && d.moneyDecisionPending && (
                    <button className="btn btn-primary btn-sm" onClick={()=>{ setCheckOutFor({ unitId: d.unitId, bookingId: d.id }); setDetailBooking(null) }}>
                      Decide the money
                    </button>
                  )}
                  {/* 10/4 (#38): a card or bank refund on this early check-out did not go out — send it again. */}
                  {can('pos.refund') && d.status === 'checked_out' && !d.moneyDecisionPending && d.refundNeedsRetry && (
                    <button className="btn btn-primary btn-sm" onClick={()=>{ setCheckOutFor({ unitId: d.unitId, bookingId: d.id }); setDetailBooking(null) }}>
                      Try the refund again
                    </button>
                  )}
                  {/* S547: snowbird lock — pin the stay to this exact site, exempt from auto re-siting */}
                  {can('schedule.edit_reservation') && d.status!=='cancelled' && (
                    <button className="btn btn-ghost btn-sm"
                      style={d.lockedToUnit ? { color: 'var(--gold)', borderColor: 'var(--gold)' } : undefined}
                      disabled={lockBookingMut.isLoading}
                      title={d.lockedToUnit
                        ? 'Locked to this site — automatic scheduling will never move it. Click to unlock.'
                        : 'Lock this reservation to its site (e.g. a returning snowbird) — exempt from automatic re-siting.'}
                      onClick={()=>lockBookingMut.mutate(d)}>
                      {lockBookingMut.isLoading ? '…' : d.lockedToUnit ? '🔒 Locked to site' : 'Lock to site'}
                    </button>
                  )}
                  <CancelReservationButton booking={d} onCancel={()=>setCancelFor(d)} />
                </div>
              )}
              </>)}
            </div>
          </div>
        </div>
        )
      })()}

      {/* 10/20 (Nic): bringing in the old system's schedule, and the texted ones
          after it. It sends nothing; the schedule simply refetches when it is
          done so the new bars appear. */}
      {importOpen && schedulePropertyId && (
        <ReservationImportModal
          propertyId={schedulePropertyId}
          propertyName={schedulePropertyOptions.find((p: any) => p.id === schedulePropertyId)?.name || 'this park'}
          onClose={() => setImportOpen(false)}
          onDone={() => { qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history'); setImportOpen(false) }}
        />
      )}

      {cancelFor && (
        <CancelReservationModal booking={cancelFor}
          onClose={() => setCancelFor(null)}
          onDone={() => { setCancelFor(null); setDetailBooking(null) }} />
      )}

      {checkInPrompt && (
        <CheckInReadModal prompt={checkInPrompt} busy={checkInBusy}
          onRead={submitCheckInReads} onOverride={overrideCheckIn}
          onClose={()=>{ if (!checkInBusy) setCheckInPrompt(null) }} />
      )}

      {screeningWait && (
        <div className="modal-overlay" onClick={()=>setScreeningWait(null)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">Check-in is waiting on the background check</div>
            <div style={{ fontSize: '.84rem', color: 'var(--text-2)', margin: '10px 0 16px', lineHeight: 1.5 }}>{screeningWait.message}</div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={()=>setScreeningWait(null)}>Close</button>
              {can('tenants.run_background_check') && (
                <button className="btn btn-primary btn-sm" onClick={()=>{ setScreeningWait(null); navigate('/background') }}>Open Background Checks</button>
              )}
            </div>
          </div>
        </div>
      )}

      {addMonthFor && (
        <AddMonthModal booking={addMonthFor} onClose={()=>setAddMonthFor(null)}
          onDone={(r: any) => {
            setAddMonthFor(null); setDetailBooking(null)
            qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history')
            if (r?.extended === false) {
              qc.invalidateQueries('leases')
              toast('Lease chosen — a draft lease is waiting on the Leases page. No month was added; the lease bills each month.')
            } else {
              const to = r?.addedMonth?.newCheckOut
              toast(`A month added${to ? ` — check-out is now ${longCalendarDate(to)}` : ''}. It is on the stay's register ticket to be rung up.`)
            }
          }} />
      )}

      {/* ── NEW RESERVATION — dates → what's available → the space → who ──
          S652 (Nic), the flow in his words: "pick arrival AND end date → 'Show
          available' filters out anything not free for the whole stay → the
          counter tells the customer what IS available (30 amp, back-in,
          pull-through) → the customer chooses from what exists → THEN the
          counter picks the space → THEN name, phone, email → emailed a deposit
          pay link. Names come last, after the negotiation, not first."

          The old order asked for a name, an email and a phone number BEFORE it
          would show a single site — so the counter had to take a stranger's
          details to answer "have you got anything the first week of March".
          Nobody works that way, and the person on the phone has not agreed to
          anything yet.

          Nothing is saved until the last button. "When I back out and it's not
          a completed reservation, it just abandons everything... It's more like
          a browser than anything else." No draft, no held site, no row. */}
      {newResvOpen && (() => {
        const validEmail = /.+@.+\..+/.test(newBooking.guestEmail.trim())
        // 10/17 (Nic) — A PHONE NUMBER WAS NEVER NEEDED TO EMAIL A LINK.
        //
        // This gate also demanded a phone number, so a desk taking a
        // reservation over the phone from somebody who gives a name and an
        // email met a gold button that did nothing — no toast, no refusal, just
        // a dead button under a line of gray text. It is a third reason "I
        // cannot get either option to do anything": the save never left the
        // browser. The server asks for the email and nothing else (routes/units
        // wantsDeposit), and this now asks for exactly what the server does.
        const hasContact = !!resvFirst.trim() && !!resvLast.trim() && validEmail
        const offered = freeUnits.length ? freeUnits : heldUnpaidUnits
        const lastResort = freeUnits.length === 0 && heldUnpaidUnits.length > 0
        return (
        <div className="modal-overlay" onClick={closeNewResv}>
          <div className="modal" style={{maxWidth:560}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">New Reservation</span>
              <button className="btn btn-ghost btn-sm" onClick={closeNewResv}>✕</button>
            </div>
            <div style={{padding:'4px 24px 24px',display:'grid',gap:18}}>

              {/* 1 · Dates */}
              <div>
                <div style={{fontSize:'.72rem',fontWeight:700,color:'var(--gold)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>1 · Dates</div>
                {/* 10/6 (Nic): arrival, then Add a day / a week / a month, the
                    night count and the leaving day — StayDatesFields below. */}
                <StayDatesFields checkIn={newBooking.checkIn} checkOut={newBooking.checkOut}
                  onChange={(checkIn, checkOut) => { setShowAvail(false); setPickedUnit(null); setNewBooking(st => ({ ...st, checkIn, checkOut })) }} />

                {/* Optional: what the customer says they need, before the list
                    is drawn, so the counter is not reading out sites that will
                    not take their rig. */}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginTop:10}}>
                  <div>
                    <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Needs (optional)</div>
                    <select className="form-select" style={{width:'100%'}} value={resvLayout} onChange={e=>setResvLayout(e.target.value)}>
                      {RV_SITE_LAYOUTS.map(l=><option key={l} value={l}>{l==='none'?'Any layout':RV_SITE_LAYOUT_LABEL[l]}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>&nbsp;</div>
                    <select className="form-select" style={{width:'100%'}} value={resvAmp} onChange={e=>setResvAmp(e.target.value)}>
                      {RV_AMP_SERVICES.filter(a=>a!=='both').map(a=><option key={a} value={a}>{a==='none'?'Any service':RV_AMP_SERVICE_LABEL[a]}</option>)}
                    </select>
                  </div>
                  <div>
                    {/* 10/24 (Nic): how long their rig is. Sites too short for it
                        drop out of the list below, so the counter is never offered
                        a pad the trailer does not fit on — and because the length
                        is stored with the stay, the nightly compression will not
                        move them onto one later either. */}
                    <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Rig length (optional)</div>
                    <input className="form-input" type="number" min={1} max={MAX_RIG_LENGTH_FT}
                      style={{width:'100%'}} placeholder="feet, e.g. 37"
                      value={resvRig}
                      onChange={e=>{ setResvRig(e.target.value); setPickedUnit(null) }} />
                  </div>
                </div>

                <div style={{marginTop:10}}>
                  <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Sites to avoid (optional)</div>
                  <input className="form-input" style={{width:'100%'}} placeholder="e.g. RV 12, RV 14 — spots they don't want again"
                    value={resvAvoid} onChange={e=>{ setResvAvoid(e.target.value); setPickedUnit(null) }} />
                  {avoidTokens.length>0 && (
                    <div style={{fontSize:'.7rem',color:'var(--text-3)',marginTop:4}}>
                      {(() => { const hit = units.filter(isAvoided); return hit.length
                        ? `Left out: ${Array.from(new Set(hit.map((u:any)=>u.unitNumber))).join(', ')}`
                        : 'No site by that number here yet — check the spelling' })()}
                    </div>
                  )}
                </div>

                <button className="btn btn-primary" style={{width:'100%',marginTop:12}}
                        disabled={!datesValid}
                        onClick={()=>{ setPickedUnit(null); setResvError(''); setShowAvail(true) }}>
                  Show available
                </button>
              </div>

              {/* 2 · What is available — read out loud to the customer. */}
              {showAvail && datesValid && (
              <div>
                <div style={{fontSize:'.72rem',fontWeight:700,color:'var(--gold)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>
                  2 · What is available · {offered.length} for {newBooking.checkIn} → {newBooking.checkOut}
                </div>
                {lastResort && (
                  <div style={{fontSize:'.74rem',color:'var(--amber)',marginBottom:8,lineHeight:1.5}}>
                    Everything else is taken. These are held by reservations that have not paid a deposit —
                    taking one moves that guest to another site, or cancels them if there is nothing left.
                  </div>
                )}
                {offered.length === 0 ? (
                  <div style={{padding:'12px',background:'var(--bg-3)',borderRadius:8}}>
                    <div style={{fontSize:'.82rem',color:'var(--amber)',fontWeight:600,marginBottom:8}}>Nothing is free for those dates.</div>
                    <div style={{fontSize:'.76rem',color:'var(--text-3)',marginBottom:10}}>Take their details and put them on the waitlist — they get a 1-hour claim link the moment something opens.</div>
                    <div style={{marginBottom:10}}>
                      <GuestFields
                        propertyId={schedulePropertyId}
                        first={resvFirst} last={resvLast}
                        email={newBooking.guestEmail} phone={newBooking.guestPhone}
                        setFirst={setResvFirst} setLast={setResvLast}
                        setEmail={(v)=>setNewBooking(s=>({...s,guestEmail:v}))}
                        setPhone={(v)=>setNewBooking(s=>({...s,guestPhone:v}))} />
                    </div>
                    {!validEmail
                      ? <div style={{fontSize:'.74rem',color:'var(--amber)'}}>An email address is where the claim link goes.</div>
                      : <button className="btn btn-primary btn-sm" onClick={()=>{ setResvError(''); waitlistMut.mutate() }} disabled={waitlistMut.isLoading}>
                          {waitlistMut.isLoading?'Adding…':'Add to waitlist'}
                        </button>}
                  </div>
                ) : (
                  <div style={{display:'grid',gap:8,maxHeight:280,overflowY:'auto'}}>
                    {offered.map((u:any)=>{
                      const reasons = rvMismatchReasons(resvLayout, resvAmp, u, resvRig)
                      const mismatch = reasons.length > 0
                      const facts = u.unitType==='rv_spot' ? rvSiteFactsLabel(u) : ''
                      const price = stayPriceForUnit(u)
                      const isPicked = pickedUnit?.id === u.id
                      return (
                        <div key={u.id}
                          onClick={()=>{ setResvError(''); setPickedUnit(u) }}
                          style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,padding:'11px 14px',background:isPicked?'var(--bg-3)':'var(--bg-2)',border:`1px solid ${isPicked?'var(--gold)':mismatch?'var(--amber)':'var(--border-1)'}`,borderRadius:10,cursor:'pointer'}}>
                          <div>
                            <div style={{fontWeight:700,fontSize:'.9rem'}}>
                              {u.unitNumber}{facts ? ` · ${facts}` : ''}
                            </div>
                            <div style={{fontSize:'.72rem',color:TYPE_COLORS[u.unitType]||'var(--text-3)'}}>
                              {UNIT_TYPE_LABELS[u.unitType]||humanize(u.unitType)} · {u.propertyName}
                              {lastResort ? ' · held, unpaid' : ''}
                            </div>
                            {mismatch && <div style={{fontSize:'.68rem',color:'var(--amber)',marginTop:2}}>⚠ {reasons.join('; ')}</div>}
                          </div>
                          {/* S652 (Nic): the price IS shown here now. The counter
                              is quoting a stay out loud, and "what does it cost"
                              is the second thing anyone asks. It is the site's
                              own rate — the same number the booking site would
                              quote for these nights.
                              (memory: gam-register-price-is-its-own-thing) */}
                          <div style={{textAlign:'right'}}>
                            <div style={{fontWeight:700,fontSize:'.9rem',color:'var(--gold)'}}>{fmt(price.total)}</div>
                            <div style={{fontSize:'.68rem',color:'var(--text-3)'}}>{resvNights} night{resvNights===1?'':'s'}</div>
                            {/* 10/6 (Nic): six nights at the week's price, said so. */}
                            {stayLowerRateWords(price) && <div style={{fontSize:'.66rem',color:'var(--text-3)'}}>{stayLowerRateWords(price)}</div>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>)}

              {/* 3 · Who it is for — LAST, once there is something to agree to. */}
              {pickedUnit && (
              <div>
                <div style={{fontSize:'.72rem',fontWeight:700,color:'var(--gold)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>
                  3 · Who is it for · {pickedUnit.unitNumber}
                </div>
                <GuestFields
                  propertyId={pickedUnit.propertyId || schedulePropertyId}
                  first={resvFirst} last={resvLast}
                  email={newBooking.guestEmail} phone={newBooking.guestPhone}
                  setFirst={setResvFirst} setLast={setResvLast}
                  setEmail={(v)=>setNewBooking(s=>({...s,guestEmail:v}))}
                  setPhone={(v)=>setNewBooking(s=>({...s,guestPhone:v}))} />

                {/* S652 (Nic): movable by default. The nightly compression can
                    shuffle this stay onto an equivalent site to close gaps —
                    unless the counter promised them that exact space. */}
                <label style={{display:'flex',alignItems:'center',gap:8,marginTop:12,fontSize:'.78rem',color:'var(--text-2)',cursor:'pointer'}}>
                  <input type="checkbox" checked={lockSite} onChange={e=>setLockSite(e.target.checked)} />
                  Keep them on {pickedUnit.unitNumber} — do not let the schedule move them
                </label>

                {/* 10/6 (Nic): "Mark them as work trade. Boom." Covers
                    everything by default (untick any); monitored or trusted;
                    the hours are the property's setting. */}
                {can('work_trade.manage') && (
                  <div style={{marginTop:12,padding:'10px 12px',border:'1px solid var(--border-1)',borderRadius:8,background:'var(--bg-2)'}}>
                    <label style={{display:'flex',alignItems:'center',gap:8,fontSize:'.8rem',fontWeight:600,color:'var(--text-0)',cursor:'pointer'}}>
                      <input type="checkbox" checked={resvWorkTrade} onChange={e=>setResvWorkTrade(e.target.checked)} />
                      Work trade
                    </label>
                    {resvWorkTrade && (
                      <div style={{marginTop:10}}>
                        <WorkTradeTermsFields value={resvWt} onChange={setResvWt} propertyHours={wtTarget?.target ?? null} />
                      </div>
                    )}
                  </div>
                )}

                {/* 10/6 (Nic): a stay of more than three weeks needs a
                    background check — unless they've stayed here before. */}
                {resvOffer.data?.screening === 'fee_due' && (
                  <div style={{marginTop:12,display:'grid',gap:6}}>
                    <div style={{fontSize:'.74rem',color:'var(--text-2)',lineHeight:1.5}}>
                      This stay is {resvOffer.data.nights} nights in a row, so the guest needs a background check before check-in
                      {resvOffer.data.screeningFee != null ? <> — its {fmt(resvOffer.data.screeningFee)} fee is paid with the stay</> : null}.
                    </div>
                    <ReturningGuestChoice offer={resvOffer.data.returning} checked={resvReturning}
                      onChange={setResvReturning} fee={resvOffer.data.screeningFee} />
                  </div>
                )}
                {resvOffer.data?.screening === 'returning' && (
                  <div style={{marginTop:12,fontSize:'.74rem',color:'var(--text-2)'}}>{RETURNING_GUEST_DETAIL} — no background check for this stay.</div>
                )}

                {(() => {
                  // 10/6: a work trade covering rent — nothing to pay for the site.
                  const rentTraded = resvWorkTrade && resvWt.coveredCharges.includes('rent')
                  if (rentTraded) return (
                    <div style={{fontSize:'.74rem',color:'var(--text-2)',marginTop:12,lineHeight:1.5}}>
                      Rent is covered by the work trade, so there is nothing to pay for the site — the reservation is confirmed now.
                      {resvOffer.data?.screening === 'fee_due' && !resvReturning ? ' You will be asked how the background check is paid.' : ''}
                    </div>
                  )
                  return null
                })()}

                {/* S652 (Nic): "it needs to generate either a pay link from the
                    scheduling flow or send it to the point of sale for payment
                    there in person." Either way the site comes off the calendar
                    now — the sales inventory and the calendar inventory are the
                    same inventory. */}
                {!(resvWorkTrade && resvWt.coveredCharges.includes('rent')) && (
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginTop:14}}>
                  {([['link','Email a deposit link'],['register','Paying at the counter']] as const).map(([m,label])=>(
                    <button key={m} onClick={()=>setPayMode(m)}
                      style={{padding:'8px 4px',border:'1px solid '+(payMode===m?'var(--gold)':'var(--border-1)'),
                              background:payMode===m?'var(--gold-bg)':'var(--bg-2)',borderRadius:'var(--r-md)',
                              cursor:'pointer',fontSize:'.74rem',fontWeight:payMode===m?700:400,
                              color:payMode===m?'var(--gold)':'var(--text-2)'}}>{label}</button>
                  ))}
                </div>)}

                <button className="btn btn-primary" style={{width:'100%',marginTop:10}}
                        disabled={(payMode==='link' && !hasContact && !(resvWorkTrade && resvWt.coveredCharges.includes('rent')))
                          || !resvGuestName || createResvMut.isLoading
                          || (resvWorkTrade && (!resvWt.coveredCharges.length || !validEmail))}
                        onClick={async ()=>{
                          const reasons = rvMismatchReasons(resvLayout, resvAmp, pickedUnit, resvRig)
                          if (reasons.length && !(await appConfirm(`${pickedUnit.unitNumber} doesn't match:\n· ${reasons.join('\n· ')}\n\nReserve it anyway?`, { confirmLabel: 'Reserve it' }))) return
                          setResvError(''); createResvMut.mutate(pickedUnit)
                        }}>
                  {createResvMut.isLoading ? 'Holding the site…'
                   : resvWorkTrade && resvWt.coveredCharges.includes('rent') ? 'Reserve — work trade'
                   : payMode==='register' ? 'Hold it and send to the register'
                   : 'Reserve and email the deposit link'}
                </button>
                {resvWorkTrade && !validEmail &&
                  <div style={{fontSize:'.72rem',color:'var(--text-3)',marginTop:6}}>A work trade is made for the guest's own account, so it needs their email.</div>}
                {payMode==='link' && !hasContact && !(resvWorkTrade && resvWt.coveredCharges.includes('rent')) &&
                  <div style={{fontSize:'.72rem',color:'var(--text-3)',marginTop:6}}>A name and an email — the email is where the deposit link goes.</div>}
                {payMode==='register' && !resvGuestName &&
                  <div style={{fontSize:'.72rem',color:'var(--text-3)',marginTop:6}}>A name is enough when they are paying here.</div>}
                {!(resvWorkTrade && resvWt.coveredCharges.includes('rent')) &&
                <div style={{fontSize:'.72rem',color:'var(--text-3)',marginTop:6,lineHeight:1.5}}>
                  {payMode==='register'
                    ? 'The site comes off the board now and a ticket appears on the register. Ringing it up confirms this same reservation.'
                    : 'The site is held for them with no deadline. If it is still unpaid when the park fills up, they get moved to another site — or told, if there is nothing else.'}
                </div>}
              </div>)}

              {resvError && <div style={{fontSize:'.78rem',color:'var(--red,#ff6b81)'}}>{resvError}</div>}
            </div>
          </div>
        </div>
        )
      })()}

      {/* ── CONFIGURE UNIT TYPE MODAL ── */}
      {typeModal.show && (
        <div className="modal-overlay" onClick={()=>setTypeModal({show:false,unit:null})}>
          <div className="modal" style={{maxWidth:540}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Configure Unit — {typeModal.unit?.unitNumber}</span>
              <button className="btn btn-ghost btn-sm" onClick={()=>setTypeModal({show:false,unit:null})}>✕</button>
            </div>
            <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Unit Type</div>
                <select className="form-select" style={{width:'100%'}} value={typeForm.unitType} onChange={e=>setTypeForm((s:any)=>({...s,unitType:e.target.value}))}>
                  {UNIT_TYPES.map(t=><option key={t} value={t}>{UNIT_TYPE_LABELS[t] || UNIT_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
              {/* W-22: type-appropriate configuration — every field below is
                  gated by what the unit IS. Storage/commercial never rent by
                  the night: no rates, no stay knobs, no bookability. */}
              {typeForm.unitType==='rv_spot' && (
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <div>
                    <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>RV Site Layout</div>
                    <select className="form-select" style={{width:'100%'}} value={typeForm.rvSiteLayout||'none'} onChange={e=>setTypeForm((s:any)=>({...s,rvSiteLayout:e.target.value}))}>
                      {RV_SITE_LAYOUTS.map(l=><option key={l} value={l}>{RV_SITE_LAYOUT_LABEL[l]}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Electrical Service</div>
                    <select className="form-select" style={{width:'100%'}} value={typeForm.rvAmpService||'none'} onChange={e=>setTypeForm((s:any)=>({...s,rvAmpService:e.target.value}))}>
                      {RV_AMP_SERVICES.map(a=><option key={a} value={a}>{RV_AMP_SERVICE_LABEL[a]}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {(typeForm.unitType==='rv_spot' || typeForm.unitType==='mobile_home') && (
                <div>
                  {/* S550: drives the inspection checklist — site-only vs dwelling too */}
                  <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>{typeForm.unitType==='rv_spot' ? 'Who owns the RV?' : 'Who owns the home?'}</div>
                  <select className="form-select" style={{width:'100%'}} value={typeForm.dwellingOwnership||'landlord'} onChange={e=>setTypeForm((s:any)=>({...s,dwellingOwnership:e.target.value}))}>
                    <option value="tenant">Tenant-owned (space rent only — inspect the site, not their dwelling)</option>
                    <option value="landlord">Park-owned rental (inspect the site and the dwelling)</option>
                  </select>
                </div>
              )}
              {STAY_CAPABLE_TYPES.includes(typeForm.unitType) ? (
                <>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Nightly Rate</div><input className="form-input" type="number" style={{width:'100%'}} placeholder="0.00" value={typeForm.nightlyRate} onChange={e=>setTypeForm((s:any)=>({...s,nightlyRate:e.target.value}))} /></div>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Weekly Rate</div><input className="form-input" type="number" style={{width:'100%'}} placeholder="0.00" value={typeForm.weeklyRate} onChange={e=>setTypeForm((s:any)=>({...s,weeklyRate:e.target.value}))} /></div>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Monthly Rate</div><input className="form-input" type="number" style={{width:'100%'}} placeholder="0.00" value={typeForm.monthlyRate} onChange={e=>setTypeForm((s:any)=>({...s,monthlyRate:e.target.value}))} /></div>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Min Stay (nights)</div><input className="form-input" type="number" style={{width:'100%'}} value={typeForm.minStayNights} onChange={e=>setTypeForm((s:any)=>({...s,minStayNights:Number(e.target.value)}))} /></div>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-in Time</div><input className="form-input" type="time" style={{width:'100%'}} value={typeForm.checkInTime} onChange={e=>setTypeForm((s:any)=>({...s,checkInTime:e.target.value}))} /></div>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-out Time</div><input className="form-input" type="time" style={{width:'100%'}} value={typeForm.checkOutTime} onChange={e=>setTypeForm((s:any)=>({...s,checkOutTime:e.target.value}))} /></div>
                  </div>
                </>
              ) : (
                <div style={{fontSize:'.76rem',color:'var(--text-3)',background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:8,padding:'10px 12px'}}>
                  {UNIT_TYPE_LABELS[typeForm.unitType] || humanize(typeForm.unitType) || 'This unit type'} rents by lease only — no nightly or weekly configuration applies. Rent and deposit are set on the unit itself.
                </div>
              )}
              {/* W-24: amenities are toggle chips (per unit type), with a
                  small add-your-own affordance for anything custom. */}
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:6}}>Amenities</div>
                <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                  {Array.from(new Set([...(AMENITY_PRESETS[typeForm.unitType] || AMENITY_PRESETS.default), ...(typeForm.amenities||[])])).map((a:string)=>{
                    const on = (typeForm.amenities||[]).includes(a)
                    return (
                      <button key={a} type="button"
                        onClick={()=>setTypeForm((s:any)=>({...s,amenities: on ? s.amenities.filter((x:string)=>x!==a) : [...(s.amenities||[]), a]}))}
                        style={{fontSize:'.72rem',padding:'4px 10px',borderRadius:14,cursor:'pointer',
                          border:`1px solid ${on?'var(--gold)':'var(--border-1)'}`,
                          background:on?'var(--gold-bg)':'var(--bg-2)',
                          color:on?'var(--gold)':'var(--text-2)'}}>
                        {on?'✓ ':''}{a}
                      </button>
                    )
                  })}
                </div>
                <div style={{display:'flex',gap:6,marginTop:8}}>
                  <input className="form-input" style={{flex:1,fontSize:'.78rem'}} placeholder="Add your own…" value={customAmenity}
                    onChange={e=>setCustomAmenity(e.target.value)}
                    onKeyDown={e=>{ if(e.key==='Enter' && customAmenity.trim()){ setTypeForm((s:any)=>({...s,amenities:[...new Set([...(s.amenities||[]), customAmenity.trim()])]})); setCustomAmenity('') } }} />
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!customAmenity.trim()}
                    onClick={()=>{ setTypeForm((s:any)=>({...s,amenities:[...new Set([...(s.amenities||[]), customAmenity.trim()])]})); setCustomAmenity('') }}>Add</button>
                </div>
              </div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Description</div><textarea className="form-input" style={{width:'100%',minHeight:70,resize:'vertical'}} placeholder="Pull-through site, full hookups..." value={typeForm.unitDescription} onChange={e=>setTypeForm((s:any)=>({...s,unitDescription:e.target.value}))} /></div>
              {STAY_CAPABLE_TYPES.includes(typeForm.unitType) && (
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <input type="checkbox" id="ib" checked={typeForm.isBookable} onChange={e=>setTypeForm((s:any)=>({...s,isBookable:e.target.checked}))} />
                  <label htmlFor="ib" style={{fontSize:'.82rem'}}>Allow short-term reservations on this unit</label>
                </div>
              )}
              <button className="btn btn-primary" onClick={()=>updateTypeMut.mutate()} disabled={updateTypeMut.isLoading}>
                {updateTypeMut.isLoading?'Saving...':'Save Configuration'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── NEW BOOKING MODAL (per-unit + Book) ──
          S526 (Nic): contact + dates only. No total (they don't pay here — the
          backend prices from the unit/property rates), no fee, no lease-type
          dropdown (implied by stay length). */}
      {bookingModal.show && (() => {
        const bkNights = (newBooking.checkIn && newBooking.checkOut && newBooking.checkOut > newBooking.checkIn)
          ? stayNightsBetween(newBooking.checkIn, newBooking.checkOut)
          : 0
        const bkEmailValid = /.+@.+\..+/.test(newBooking.guestEmail.trim())
        // 10/17 (Nic): a name is enough for somebody standing at the desk — the
        // same rule the New Reservation flow already uses. An emailed deposit
        // link needs the email it goes to (the server will not send one
        // without it, and used to confirm the stay silently instead).
        // A phone number is not needed to email anybody a link, and demanding
        // one here left the button dead with no explanation.
        const bkReady = bkNights > 0 && !!bookFirst.trim() && !!bookLast.trim()
          && (bookPayMode !== 'link' || bkEmailValid)
        // 10/24 (Nic): the overlay has NO onClick — clicking anywhere outside
        // this window does nothing at all. Confirm or abandon are the only ways
        // out of a reservation half typed.
        return (
        <div className="modal-overlay">
          <div className="modal" style={{maxWidth:480}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">New Reservation — {bookingModal.unit?.unitNumber}</span>
              <button className="btn btn-ghost btn-sm" onClick={askCloseBookModal}>✕</button>
            </div>
            <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>First name</div><input className="form-input" style={{width:'100%'}} value={bookFirst} onChange={e=>setBookFirst(e.target.value)} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Last name</div><input className="form-input" style={{width:'100%'}} value={bookLast} onChange={e=>setBookLast(e.target.value)} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Email</div><input className="form-input" type="email" style={{width:'100%'}} value={newBooking.guestEmail} onChange={e=>setNewBooking(s=>({...s,guestEmail:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Phone</div><input className="form-input" type="tel" style={{width:'100%'}} value={newBooking.guestPhone} onChange={e=>setNewBooking(s=>({...s,guestPhone:typingPhone(e.target.value)}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-in</div><input className="form-input" type="date" style={{width:'100%'}} value={newBooking.checkIn} onChange={e=>setNewBooking(s=>({...s,checkIn:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-out</div><input className="form-input" type="date" style={{width:'100%'}} value={newBooking.checkOut} onChange={e=>setNewBooking(s=>({...s,checkOut:e.target.value}))} /></div>
              </div>
              {bkNights > 0 && (() => {
                // 10/6 (Nic): the one price every door charges for these nights.
                const u = bookingModal.unit
                const p = u ? priceStay(
                  { nightly: u.nightlyRate ?? u.propertyNightlyRate, weekly: u.weeklyRate ?? u.propertyWeeklyRate, monthly: u.monthlyRate ?? u.propertyMonthlyRate },
                  Number(u.propertyTaxRate || 0), newBooking.checkIn, bkNights) : null
                const lower = p ? stayLowerRateWords(p) : null
                return (
                  <div style={{fontSize:'.72rem',color:'var(--text-3)'}}>
                    {bkNights} night{bkNights===1?'':'s'} — leaving {leavingDayLabel(newBooking.checkOut)}
                    {p && p.total > 0 ? <> · {fmt(p.total)}{lower ? ` (${lower})` : ''}</> : null}
                  </div>
                )
              })()}
              {/* 10/17 (Nic): the money, asked here instead of assumed. Three
                  real outcomes, and the first is what this button has always
                  done — so an answer has to be given for anything to be sent,
                  and nothing changes for a desk that just wants it on the
                  board. */}
              <div style={{fontSize:'.75rem',color:'var(--text-3)'}}>The deposit</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
                {([['none','Nothing to collect'],['link','Email a deposit link'],['register','Paying at the counter']] as const).map(([m,label])=>(
                  <button key={m} onClick={()=>setBookPayMode(m)}
                    style={{padding:'8px 4px',border:'1px solid '+(bookPayMode===m?'var(--gold)':'var(--border-1)'),
                            background:bookPayMode===m?'var(--gold-bg)':'var(--bg-2)',borderRadius:'var(--r-md)',
                            cursor:'pointer',fontSize:'.74rem',fontWeight:bookPayMode===m?700:400,
                            color:bookPayMode===m?'var(--gold)':'var(--text-2)'}}>{label}</button>
                ))}
              </div>
              {abandonAsk && (
                <div style={{padding:'10px 12px',borderRadius:8,background:'rgba(245,158,11,.08)',
                             border:'1px solid rgba(245,158,11,.3)',marginBottom:10}}>
                  <div style={{fontSize:'.82rem',color:'var(--text-1)',lineHeight:1.5,marginBottom:10}}>
                    Abandon this reservation? Nothing has been saved and nothing is held — what you have typed
                    is lost and the site stays free.
                  </div>
                  <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                    <button className="btn btn-ghost btn-sm" onClick={()=>setAbandonAsk(false)}>Keep editing</button>
                    <button className="btn btn-primary btn-sm" onClick={closeBookModal}>Abandon it</button>
                  </div>
                </div>
              )}
              <button className="btn btn-primary" onClick={()=>createBookingMut.mutate()} disabled={!bkReady||createBookingMut.isLoading}>
                {createBookingMut.isLoading ? (bookPayMode==='none'?'Creating...':'Holding the site…')
                  : bookPayMode==='register' ? 'Hold it and send to the register'
                  : bookPayMode==='link' ? 'Reserve and email the deposit link'
                  : 'Create Reservation'}
              </button>
              <div style={{fontSize:'.72rem',color:'var(--text-3)',lineHeight:1.5}}>
                {bookPayMode==='register'
                  ? 'The site comes off the board now and a ticket appears on the register. Ringing it up confirms this same reservation.'
                  : bookPayMode==='link'
                  ? 'The site is held for them with no deadline. If it is still unpaid when the park fills up, they get moved to another site — or told, if there is nothing else.'
                  : 'Nothing is sent and nothing is asked for — the reservation is confirmed and the site is theirs. Use this when they are paying now, have already paid, or the site is not being sold.'}
              </div>
            </div>
          </div>
        </div>
        )
      })()}

      {/* Guest access — link the guest opens to reach their stay assistant */}
      {guestAccess.show && (
        <div className="modal-overlay" onClick={()=>setGuestAccess(s=>({...s,show:false}))}>
          <div className="modal" style={{maxWidth:420}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Guest stay assistant</span>
              <button className="btn btn-ghost btn-sm" onClick={()=>setGuestAccess(s=>({...s,show:false}))}>✕</button>
            </div>
            <div style={{padding:16}}>
              <div style={{fontSize:'.8rem',color:'var(--text-3)',marginBottom:12}}>
                {guestAccess.booking?.guestName||'Your guest'} can open this link to ask about their stay and request things like a late checkout. No account needed — it works through checkout.
              </div>
              {guestAccess.loading && <div style={{textAlign:'center',padding:24,color:'var(--text-3)'}}>Generating…</div>}
              {guestAccess.error && <div style={{color:'var(--red)',fontSize:'.82rem',padding:'8px 0'}}>{guestAccess.error}</div>}
              {guestAccess.data && (
                <>
                  <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:10}}>
                    <input readOnly value={guestAccess.data.url}
                      style={{flex:1,fontSize:'.72rem',padding:'6px 8px',background:'var(--bg-1)',border:'1px solid var(--border-1)',borderRadius:6,color:'var(--text-2)'}}
                      onFocus={e=>e.currentTarget.select()} />
                    <button className="btn btn-ghost btn-sm" onClick={()=>navigator.clipboard?.writeText(guestAccess.data!.url)}>Copy</button>
                  </div>
                  <div style={{fontSize:'.7rem',color:'var(--text-3)',marginBottom:12}}>
                    Link expires {new Date(guestAccess.data.expiresAt).toLocaleDateString()}. Keep it private — anyone with it can see this reservation.
                  </div>
                  {guestAccess.booking?.guestEmail && (
                    guestAccess.data.emailed
                      ? <div style={{fontSize:'.78rem',color:'var(--green)'}}>✓ Emailed to {guestAccess.booking.guestEmail}</div>
                      : <button className="btn btn-secondary btn-sm" style={{width:'100%'}} disabled={guestAccess.emailing}
                          onClick={emailGuestAccess}>{guestAccess.emailing?'Sending…':`Email link to ${guestAccess.booking.guestEmail}`}</button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 10/17 (Nic): the deposit link the reservation just produced. It is
          emailed on its own, but the desk is usually still on the phone with
          the person it was made for, so the URL is here to read out or paste
          into a text. */}
      {resvLink && (
        <div className="modal-overlay" onClick={()=>setResvLink(null)}>
          <div className="modal" style={{maxWidth:440}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                {resvLink.isDeposit === false ? 'A link is already out'
                  : resvLink.emailFailed ? 'Deposit link made'
                  : resvLink.emailedNow === false ? 'Deposit link'
                  : 'Deposit link sent'}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={()=>setResvLink(null)}>✕</button>
            </div>
            <div style={{padding:'0 20px 20px'}}>
              <div style={{fontSize:'.82rem',color:'var(--text-2)',marginBottom:12,lineHeight:1.5}}>
                {/* 10/18 (Nic): pressed a second time, the same link comes back
                    and the guest is NOT emailed again — said plainly, or the
                    desk thinks the first send failed and keeps pressing.
                    10/18 (review): and what the link ASKS FOR is named, because
                    a reservation can already have a link out for other money —
                    the whole stay, a month added to it, the arrival-day balance
                    — and reading one of those out as "the deposit" quotes the
                    guest the wrong number. */}
                {resvLink.isDeposit === false
                  ? <>There is already a link out for this reservation{linkAsksFor(resvLink)}, so nothing was emailed. Read that one out, or close it on the Pay Links screen and ask again.</>
                  : resvLink.emailFailed
                    ? <>The link is made{linkAsksFor(resvLink)} and {resvLink.guest} can pay it, but we could not email it. Read it out or copy it below — or send it again from the Pay Links screen.</>
                    : resvLink.emailedNow === false
                      ? <>Already emailed to <b>{resvLink.emailedTo || 'the guest'}</b>, so we did not email again — this is the same link{linkAsksFor(resvLink)}. The site is held for {resvLink.guest} until they pay it.</>
                      : resvLink.emailedTo
                        ? <>Emailed to <b>{resvLink.emailedTo}</b>{linkAsksFor(resvLink)}. The site is held for {resvLink.guest} until they pay it.</>
                        : <>The site is held for {resvLink.guest} until this is paid.</>}
              </div>
              {/* 10/24 (Nic) — NO LINK ON THE WINDOW THAT JUST MADE A BOOKING.
                    "if the email didn't go through, like, how am I going to
                     show them the link? If they were here, I would just send
                     them the pay link or use the point of sale... the
                     reservation just needs to be completed and move on. If they
                     end up not getting the link, then we can access it from the
                     reservation."
                  The desk has just taken a booking and the next thing it does is
                  the next guest. A URL to copy is only any use to somebody who
                  went looking for it, and that door already exists: open the
                  reservation and ask for the deposit again, which hands back the
                  same link rather than emailing twice. So the link shows there
                  and not here. */}
              {!resvLink.justBooked && (
                <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:10}}>
                  <input readOnly value={resvLink.url}
                    style={{flex:1,fontSize:'.72rem',padding:'6px 8px',background:'var(--bg-1)',border:'1px solid var(--border-1)',borderRadius:6,color:'var(--text-2)'}}
                    onFocus={e=>e.currentTarget.select()} />
                  <button className="btn btn-primary btn-sm" onClick={()=>{navigator.clipboard?.writeText(resvLink.url); toast('Link copied.')}}>Copy</button>
                </div>
              )}
              <div style={{fontSize:'.72rem',color:'var(--text-3)',lineHeight:1.5}}>
                {/* 10/18 (review): a deposit link never expires, but a link the
                    register sent does — so this does not promise otherwise
                    about a link handed back from there. */}
                {resvLink.neverExpires === false
                  ? <>This link was sent from the register, so it stops working on its own date — the Pay Links screen shows what is still out. Until it is paid, a guest who pays can take this site.</>
                  : <>The link never expires. Until it is paid, a guest who pays can take this site — the reservation is only locked in once the deposit lands.</>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 10/5: the questions a save can come back with — drawn last, so they
          open above the reservation form that sent the save. */}
      {termsAsk && (
        <StayTermsModal question={termsAsk.question} onChoose={termsAsk.resend} onClose={()=>setTermsAsk(null)} />
      )}

      {feeRoute && (
        <div className="modal-overlay" onClick={()=>setFeeRoute(null)}>
          <div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">How will the background check be paid?</div>
            <div style={{ fontSize: '.84rem', color: 'var(--text-2)', margin: '10px 0 16px', lineHeight: 1.5 }}>{feeRoute.message}</div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={()=>setFeeRoute(null)}>Cancel</button>
              {feeRoute.canSendLink && (
                <button className="btn btn-primary btn-sm" onClick={()=>feeRoute.resend('link')}>Email a pay link</button>
              )}
              <button className="btn btn-primary btn-sm" onClick={()=>feeRoute.resend('register')}>Send to the register</button>
              {/* 10/6 (Nic): the third choice — owner or a manager only (the server says whether it is offered). */}
              {feeRoute.returning?.available && (
                <button className="btn btn-primary btn-sm" onClick={()=>feeRoute.resend('returning')}>{RETURNING_GUEST_WORDS}</button>
              )}
            </div>
            {feeRoute.returning && !feeRoute.returning.available && (
              <div style={{ marginTop: 10, fontSize: '.74rem', color: 'var(--text-3)', opacity: .7, lineHeight: 1.5 }}>
                <b style={{ color: 'var(--text-1)' }}>{RETURNING_GUEST_WORDS}</b> — {feeRoute.returning.message}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The stays Cancel reservation is never offered on:
 *   - canceled — nothing left to cancel;
 *   - checked out — the stay happened; it stays on the schedule as its record
 *     (final fix, fix pass 1);
 *   - checked in — the guest is on the site; the next step is Check out
 *     (fix pass 2, review);
 *   - no-show — the no-show already freed the site, so there is nothing else
 *     to do (fix pass 3, review; the cancel-check says the same in words).
 */
export const CANCEL_HIDDEN_STATUSES: readonly string[] = ['cancelled', 'checked_out', 'checked_in', 'no_show']

/**
 * 10/6 (Nic): "If I pick a start date, I want some buttons that say add a day,
 * add a week, add a month... And then it will give you the total number of
 * nights. And automatically input the leaving date to match... if I click four
 * times on the button to add a day, it would change the leaving date to be four
 * days after the start of the reservation." People get overnight stays wrong —
 * leaving on the 5th from the 30th is five nights, not six — so the count is
 * shown in plain words beside the leaving day.
 *
 * Each press lengthens the stay from the leaving day already there (from the
 * arrival when there is none): one night, seven nights, or one calendar month
 * (Oct 4 → Nov 4). No take-away buttons (Nic): a wrong press is fixed by picking
 * the leaving day by hand, which still works and keeps the count in step.
 * Nights are check-out − check-in, the count the server keeps.
 */
export function lengthenStay(checkIn: string, checkOut: string, by: 'day' | 'week' | 'month'): string | null {
  if (!checkIn) return null
  const from = checkOut && checkOut > checkIn ? checkOut : checkIn
  if (by === 'month') {
    // Months count from the arrival, as the price does (priceStay): a stay
    // already whole months long gets the next whole month from the arrival, so
    // a 31st arrival goes Feb 28 → Mar 31, never Feb 28 → Mar 28 (three nights
    // short of the two months it is charged).
    if (from > checkIn) {
      for (let k = 1; k <= 240; k++) {
        const at = addCalendarMonths(checkIn, k)
        if (at === from) return addCalendarMonths(checkIn, k + 1)
        if (at > from) break
      }
    }
    return addCalendarMonths(from, 1)
  }
  return addStayDays(from, by === 'week' ? 7 : 1)
}
/** "Wed, Oct 10" */
export const leavingDayLabel = (ymd: string) =>
  new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

export function StayDatesFields({ checkIn, checkOut, onChange }: {
  checkIn: string; checkOut: string; onChange: (checkIn: string, checkOut: string) => void
}) {
  const valid = !!checkIn && !!checkOut && checkOut > checkIn
  const nights = valid ? stayNightsBetween(checkIn, checkOut) : 0
  const add = (by: 'day' | 'week' | 'month') => {
    const to = lengthenStay(checkIn, checkOut, by)
    if (to) onChange(checkIn, to)
  }
  return (
    <>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Arriving</div>
          <input className="form-input" type="date" aria-label="Arriving" style={{width:'100%'}} value={checkIn}
                 onChange={e=>onChange(e.target.value, checkOut)} /></div>
        <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Leaving</div>
          <input className="form-input" type="date" aria-label="Leaving" style={{width:'100%'}} min={checkIn || undefined} value={checkOut}
                 onChange={e=>onChange(checkIn, e.target.value)} /></div>
      </div>
      <div style={{display:'flex',gap:8,marginTop:8,flexWrap:'wrap'}}>
        <button type="button" className="btn btn-primary btn-sm" disabled={!checkIn} onClick={()=>add('day')}>Add a day</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!checkIn} onClick={()=>add('week')}>Add a week</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!checkIn} onClick={()=>add('month')}>Add a month</button>
      </div>
      {/* 10/24 (Nic) — THE SPACE FOR THIS LINE IS ALWAYS THERE, EVEN EMPTY.
            "the text that pops up under it saying 5 nights leaving Tuesday,
             November, whatever, that resizes the window... If I have to add 2
             days, I click add a day twice. I have to click once and then move
             the mouse ever so slightly and click it again. And that just bugs
             the shit out of me."
          The line appears BELOW the buttons, so it never pushed them down — the
          window grew, and a centred dialog that grows moves up by half of what
          it gained, sliding the buttons out from under the pointer between two
          clicks of Add a day. So the row keeps its height whether the line is
          in it or not, and the window stops changing size.
          The line itself is still absent until the dates make sense; only the
          room it will take is reserved. */}
      <div style={{marginTop:8,minHeight:'1.3rem'}}>
        {valid && (
          <div data-testid="resv-nights" style={{fontSize:'.86rem',fontWeight:700,color:'var(--text-1)'}}>
            {nights} night{nights===1?'':'s'} — leaving {leavingDayLabel(checkOut)}
          </div>
        )}
      </div>
    </>
  )
}

/**
 * The detail panel's Cancel reservation button (opens CancelReservationModal),
 * shown only to someone who may cancel reservations and only on a stay that
 * can still be canceled.
 */
export function CancelReservationButton({ booking, onCancel }: { booking: { status: string }; onCancel: () => void }) {
  const { can } = usePerms()
  if (!can('schedule.edit_reservation') || CANCEL_HIDDEN_STATUSES.includes(booking.status)) return null
  return (
    <button className="btn btn-sm" style={{marginLeft:'auto',color:'var(--red,#ff6b81)',borderColor:'var(--red,#ff6b81)'}}
      onClick={onCancel}>
      Cancel reservation
    </button>
  )
}

/** What GET /units/:id/bookings/:bookingId/cancel-check answers (camelCased). */
type CancelCheck = {
  booking: { id: string; unitId: string; guestName: string | null; status: string; checkIn: string; checkOut: string }
  applies: boolean
  words: string | null
  leases: Array<NeverMovedInPreview & { leaseId: string }>
  total: number
  keptTotal: number
  needsTotal: boolean
}

/** "Oct 4, 2026" from a calendar day — never moved by a time zone. */
const cancelDay = (ymd: string | null | undefined) => ymd
  ? new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : ''

/**
 * Final fix (fix pass 1, decisions #53): the Cancel reservation confirm. "Never
 * runs blind: Cancel reservation on the Schedule opens the same confirm,
 * showing fresh figures and names, before anything is zeroed."
 *
 * It reads, fresh when it opens, what canceling the stay changes: each lease
 * drafted with it, the people on it by name, the move-in bill lines zeroed and
 * the lines that stay owed (the Leases page's never-moved-in body, one copy) —
 * or the words the cancel would be refused in, with only Close. The gold
 * button sends the total it showed; a refusal or a 409 (something changed) is
 * said once and the window reads again in place. On success a toast says what
 * happened and the Schedule, the Leases page and the dashboard read again.
 */
export function CancelReservationModal({ booking, onClose, onDone }: { booking: any; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const check = useQuery<CancelCheck>(
    ['cancel-check', booking.id],
    () => apiGet<CancelCheck>(`/units/${booking.unitId}/bookings/${booking.id}/cancel-check`),
    { staleTime: 0, cacheTime: 0, retry: false, refetchOnWindowFocus: false },
  )
  const cancel = useMutation(
    // Fix pass 2 (review): the total the window showed ALWAYS goes with the
    // press — $0 when its read found no lease. A lease drafted with the stay
    // after the read is then answered "changed since you opened this" (and
    // read again here), never "use Cancel reservation on the Schedule" inside
    // the very window that is Cancel reservation.
    // The number of drafted leases it showed goes too, so one drafted since
    // (even with nothing to zero) is never ended unseen.
    (v: { total: number; leases: number }) => apiPatch<any>(`/units/${booking.unitId}/bookings/${booking.id}`,
      { status: 'cancelled', expectedNeverMovedInTotal: v.total, expectedNeverMovedInLeases: v.leases }),
    {
      onSuccess: (data: any) => {
        // The Schedule, the Leases page, the dashboard and its to-dos, and the
        // Payments ledger read again — pages not on screen too.
        refreshAfterLeaseClose(qc)
        toast(data?.leaseClosed ? `Reservation canceled. ${data.leaseClosed}` : 'Reservation canceled.')
        onDone()
      },
      onError: (e: any) => {
        setError(e?.response?.data?.error || 'The reservation could not be canceled. Nothing changed. Try again.')
        // Read it again in place — what the cancel changes now, or why it can't.
        qc.invalidateQueries('schedule')
        check.refetch()
      },
    },
  )
  const d = check.data
  const guest = d?.booking.guestName || booking.guestName || 'This guest'
  const dates = d ? `${cancelDay(d.booking.checkIn)} – ${cancelDay(d.booking.checkOut)}` : `${cancelDay(booking.checkIn)} – ${cancelDay(booking.checkOut)}`
  // Each error once: a refusal the fresh read now shows is not repeated above it.
  const shownError = error && error !== d?.words && !check.isError ? error : null
  const close = () => { if (!cancel.isLoading) onClose() }
  const names = (l: CancelCheck['leases'][number]) => {
    const n = (l.household?.tenantNames ?? []).filter(Boolean)
    const people = n.length === 0 ? 'Nobody is on this lease yet'
      : n.length === 1 ? n[0] : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
    const space = [l.household?.unitNumber, l.household?.propertyName].filter(Boolean).join(', ')
    return `Lease drafted with this stay: ${people}${space ? ` — ${space}` : ''}`
  }
  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" role="dialog" aria-label="Cancel reservation" style={{ maxWidth: 540 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ marginBottom: 0 }}>Cancel reservation</span>
          <button className="btn btn-ghost btn-sm" aria-label="Close" disabled={cancel.isLoading} onClick={close}><X size={14} /></button>
        </div>
        <div data-testid="cancel-who" style={{ fontSize: '.84rem', color: 'var(--text-1)', marginBottom: 10 }}>
          {guest}<span style={{ color: 'var(--text-3)' }}> — {dates}</span>
        </div>
        {shownError && (
          <div role="alert" style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)', fontSize: '.78rem' }}>{shownError}</div>
        )}
        {check.isLoading ? (
          <div style={{ fontSize: '.84rem', color: 'var(--text-3)', padding: '8px 0' }}>Reading what canceling this changes…</div>
        ) : check.isError || !d ? (
          // Fix pass 2 (review): the error once, with its next step — Read again.
          <div role="alert" style={{ fontSize: '.84rem', color: 'var(--red)', padding: '8px 0' }}>
            {(check.error as any)?.response?.data?.error || 'What canceling this changes could not be read, so nothing was changed. Press Read again.'}
          </div>
        ) : !d.applies ? (
          <div data-testid="cancel-refusal" style={{ fontSize: '.84rem', color: 'var(--text-1)', lineHeight: 1.5, padding: '4px 0 8px' }}>{d.words}</div>
        ) : d.leases.length === 0 ? (
          <div data-testid="cancel-plain" style={{ fontSize: '.84rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
            The reservation comes off the Schedule and the site is free for those nights.
          </div>
        ) : (
          <div>
            {d.leases.map(l => (
              <div key={l.leaseId} data-testid="cancel-lease" style={{ marginBottom: 10 }}>
                <div data-testid="cancel-lease-who" style={{ fontSize: '.84rem', color: 'var(--text-1)', marginBottom: 6 }}>{names(l)}</div>
                <NeverMovedInBody d={l} ended={false} />
              </div>
            ))}
            <div style={{ fontSize: '.84rem', color: 'var(--text-2)' }}>The reservation comes off the Schedule too.</div>
          </div>
        )}
        <div className="modal-footer" style={{ display: 'flex', gap: 8 }}>
          {/* Fix pass 3 (review): Read again is the next step and the only
              action while the read has failed, so it is the gold button. */}
          {check.isError && (
            <button className="btn btn-primary" disabled={check.isFetching} onClick={() => { setError(null); check.refetch() }}>
              {check.isFetching ? 'Reading…' : 'Read again'}
            </button>
          )}
          <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} disabled={cancel.isLoading} onClick={close}>{d && !d.applies ? 'Close' : 'Keep the reservation'}</button>
          {d?.applies && (
            <button className="btn btn-primary" disabled={cancel.isLoading || check.isFetching}
              onClick={() => { setError(null); cancel.mutate({ total: d.total, leases: d.leases.length }) }}>
              {cancel.isLoading ? 'Canceling…' : d.total > 0 ? `Cancel reservation — ${fmt(d.total)} no longer owed` : 'Cancel reservation'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// S559: closing-read prompt folded into front-desk check-in. When the guard
// blocks check-in because the previous guest's submeter is unread, the desk
// enters the blind closing read(s) here and check-in proceeds. A landlord may
// override for a broken/unreadable meter (read stays on the to-do).
function CheckInReadModal({ prompt, busy, onRead, onOverride, onClose }: {
  prompt: { booking: any; meters: any[]; canOverride: boolean }
  busy: boolean
  onRead: (values: Record<string, string>) => void
  onOverride: () => void
  onClose: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const allFilled = prompt.meters.every((m: any) => /^\d+$/.test(values[m.meterId] ?? ''))
  const many = prompt.meters.length > 1
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Closing read required</div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
          The previous guest's meter{many ? "s haven't" : " hasn't"} been read on this spot. Enter the closing read{many ? 's' : ''} to check the new guest in — it keeps the two stays' usage from smearing together.
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {prompt.meters.map((m: any) => (
            <div key={m.meterId}>
              <span style={{ fontSize: '.75rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>{m.meterLabel} ({m.utilityType})</span>
              <input className="form-input mono" inputMode="numeric" autoComplete="off"
                value={values[m.meterId] ?? ''}
                onChange={e => setValues(v => ({ ...v, [m.meterId]: e.target.value.replace(/\D/g, '') }))}
                placeholder="closing read" style={{ width: '100%', letterSpacing: '.1em' }} />
            </div>
          ))}
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, gap: 8 }}>
          {prompt.canOverride
            ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onOverride}>Meter broken — check in anyway</button>
            : <span />}
          <button className="btn btn-primary" disabled={!allFilled || busy} onClick={() => onRead(values)}>
            {busy ? '…' : 'Record & check in'}
          </button>
        </div>
      </div>
    </div>
  )
}

// 10/5 (Nic, R2): "does this person get a lease or just a stay?" Asked of the
// front counter when a save makes a guest's stay 30+ nights in a row (back-to-
// back stays add up). The question's words are the server's (stayTermsQuestion).
// Either way the landlord is told; a lease is drafted for them to review.
function StayTermsModal({ question, onChoose, onClose }: {
  question: string
  onChoose: (t: StayTerms) => void
  onClose: () => void
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Lease or stay?</div>
        <div style={{ fontSize: '.84rem', color: 'var(--text-2)', margin: '10px 0 16px', lineHeight: 1.5 }}>{question}</div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          {STAY_TERMS.map(t => (
            <button key={t} className="btn btn-primary btn-sm" onClick={() => onChoose(t)}>{STAY_TERMS_LABEL[t]}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

// 10/5 (Nic, R6): Add a month — the guest's current stay runs one calendar
// month longer, priced at the site's monthly rate on its own, and the month is
// put on the stay's register ticket to be rung up. Every figure shown is the
// server's quote (GET .../add-month). A stay that reaches 30 nights asks lease
// or stay first; a lease chosen here drafts the lease instead of adding the
// month. A stay that reaches three weeks carries the background check's fee
// on the same ticket when nothing is on file.
function AddMonthModal({ booking, onClose, onDone }: {
  booking: any
  onClose: () => void
  onDone: (result: any) => void
}) {
  const [quote, setQuote] = useState<any>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // 10/6 (Nic): "Returning guest — they've stayed with us before" — no check, no fee.
  const [returning, setReturning] = useState(false)
  useEffect(() => {
    let live = true
    apiGet(`/units/${booking.unitId}/bookings/${booking.id}/add-month`)
      .then((q) => { if (live) setQuote(q) })
      .catch((e: any) => { if (live) setErr(e?.response?.data?.error || 'The month could not be priced.') })
    return () => { live = false }
  }, [booking.id, booking.unitId])
  const send = async (stayTerms?: StayTerms) => {
    setBusy(true); setErr('')
    try {
      const r: any = await apiPost(`/units/${booking.unitId}/bookings/${booking.id}/add-month`,
        { ...(stayTerms ? { stayTerms } : {}), ...(returning ? { returningGuest: true } : {}) })
      onDone(r?.data)
    } catch (e: any) {
      const body = e?.response?.data
      if (body?.code === 'stay_terms_needed') setQuote((q: any) => q ? { ...q, leaseChoice: 'needed', question: body.error } : q)
      else setErr(body?.error || 'The month could not be added.')
    } finally { setBusy(false) }
  }
  const asking = quote?.leaseChoice === 'needed'
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onClose() }}>
      <div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Add a month · {booking.guestName || 'Guest'}</div>
        {!quote && !err && <div style={{ fontSize: '.84rem', color: 'var(--text-3)', margin: '12px 0' }}>Pricing the month…</div>}
        {quote && (
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 14px', fontSize: '.84rem', margin: '12px 0' }}>
            <div style={{ color: 'var(--text-3)' }}>Check-out</div>
            <div>{longCalendarDate(quote.fromCheckOut)} → <strong>{longCalendarDate(quote.newCheckOut)}</strong> <span style={{ color: 'var(--text-3)' }}>({quote.addedNights} nights added)</span></div>
            <div style={{ color: 'var(--text-3)' }}>The month</div>
            <div style={{ color: 'var(--gold)', fontWeight: 600 }}>{fmt(quote.monthPrice)}</div>
            {quote.screeningFee != null && !returning && (<>
              <div style={{ color: 'var(--text-3)' }}>Background check</div>
              <div>{fmt(quote.screeningFee)} <span style={{ color: 'var(--text-3)' }}>— the stay is now more than three weeks and nothing is on file, so the check's fee goes on the same ticket.</span></div>
            </>)}
            {quote.screening === 'returning' && (<>
              <div style={{ color: 'var(--text-3)' }}>Background check</div>
              <div>{RETURNING_GUEST_DETAIL}</div>
            </>)}
            <div style={{ color: 'var(--text-3)' }}>Paid</div>
            <div>{Number(quote.monthPrice) > 0 ? 'At the register — the month goes on the stay\'s ticket.' : 'Nothing to pay — rent is covered by their work trade.'}</div>
          </div>
        )}
        {quote?.screeningFee != null && quote?.returning && (
          <div style={{ marginBottom: 10 }}>
            <ReturningGuestChoice offer={quote.returning} checked={returning} onChange={setReturning} fee={quote.screeningFee} />
          </div>
        )}
        {asking && (
          <div style={{ fontSize: '.84rem', color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 8 }}>
            {quote.question}
            {quote.heldThrough && <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginTop: 6 }}>With a stay, the guest is told: “{quote.heldThrough}”</div>}
          </div>
        )}
        {err && <div style={{ fontSize: '.78rem', color: 'var(--red,#ff6b81)', marginBottom: 8 }}>{err}</div>}
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>Cancel</button>
          {quote && asking && STAY_TERMS.map(t => (
            <button key={t} className="btn btn-primary btn-sm" disabled={busy} onClick={() => send(t)}>
              {t === 'lease' ? 'Lease (draft it instead)' : `${STAY_TERMS_LABEL[t]} — add the month`}
            </button>
          ))}
          {quote && !asking && (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => send()}>{busy ? 'Adding…' : 'Add the month'}</button>
          )}
        </div>
      </div>
    </div>
  )
}


/**
 * 10/22 (Nic) — THEY TOLD YOU THEY ARE LEAVING.
 *
 *   "people with a lease right now, it's blocked out indefinitely. But if
 *    somebody tells me with notice, hey, I'm going to be leaving in about 2
 *    weeks, I should be able to edit that lease so that that spot can be freed
 *    up for reservations, especially if we're in a busy season with a tight
 *    window."
 *
 * The whole value is the site becoming bookable from the day after they go. An
 * open-ended lease paints across the board forever, so a busy-season week that
 * is actually free reads as taken.
 *
 * It sets the END DATE and nothing else. It does not end the tenancy, move
 * anybody out, settle any money or read a meter — the register's Checkout tab
 * does all of that, and it is the only place that reads the final meters. This
 * is a date on a lease, which is exactly what giving notice is.
 */
function LeaseLeaveDateModal({ lease, onClose, onSaved }: {
  lease: any
  onClose: () => void
  onSaved: () => void
}) {
  const existing = lease.endDate ? dayOnly(lease.endDate) : ''
  const [date, setDate] = useState<string>(existing || '')
  const [err, setErr] = useState('')
  const start = lease.startDate ? dayOnly(lease.startDate) : null
  const who = `${lease.firstName || ''} ${lease.lastName || ''}`.trim() || 'This resident'

  const save = useMutation(
    (endDate: string | null) => apiPatch(`/leases/${lease.id}`, { endDate }),
    {
      onSuccess: onSaved,
      onError: (e: any) => setErr(e?.message || 'That did not save — try again in a moment.'),
    })

  const tooEarly = !!(date && start && date < start)

  /* 10/22 (Nic) — WHAT THE MONEY DOES, SHOWN BEFORE ANYTHING IS SAVED.
     "if they used more than half the month, we're not going to prorate them. We
     would just either wash the electric or other utilities. And if they are
     leaving before half the paid for time, then we could prorate a refund back
     to their payment method on file."
     Worked out for the day TYPED IN THIS BOX, not for today — which is the
     whole point of being able to set a day that has already passed. */
  const { data: money } = useQuery<any>(
    ['departure-money', lease.id, date],
    () => apiGet(`/leases/${lease.id}/departure-money?leftOn=${date}`),
    { enabled: !!date && !tooEarly })

  const adjust = useMutation(
    () => apiPost(`/leases/${lease.id}/departure-money/adjust`, { leftOn: date }),
    { onSuccess: onSaved, onError: (e: any) => setErr(e?.message || 'That did not save — try again.') })

  const fmt = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  /* Three shapes, and each says what will happen rather than naming a rule:
     an unpaid month that can be re-priced here, a paid month with money to go
     back, and the wash. */
  /* 10/22 (Nic): the halfway point decides the WASH and nothing else — "that's
     just one factor for the wash on electric, but that's not a factor for
     whether or not there's a refund at all." So the figure to hand back is
     shown whenever there IS one, including on a departure that washes. */
  const canAdjust = money && money.which !== 'nothing' && money.unpaid > 0 && money.paid === 0
  const owesThemMoney = money?.canRefund === true

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{maxWidth:460}} onClick={e=>e.stopPropagation()}>
        <div className="modal-title">Last day · {who}</div>
        <div style={{fontSize:'.82rem',color:'var(--text-3)',marginBottom:14}}>
          The last day they are on site {lease.unitNumber ? `${lease.unitNumber}` : 'this site'}.
          It opens for reservations the day after. A day that has already passed is fine —
          somebody who drove out on Sunday is settled as Sunday.
        </div>
        <input type="date" className="form-input" value={date}
          min={start || undefined}
          onChange={e=>{ setDate(e.target.value); setErr('') }} />
        {tooEarly && (
          <div style={{color:'var(--amber)',fontSize:'.78rem',marginTop:8}}>
            That is before they moved in{start ? ` on ${start}` : ''}.
          </div>
        )}
        {money && money.which !== 'nothing' && !tooEarly && (
          <div style={{marginTop:14,padding:'10px 12px',borderRadius:8,background:'var(--surface-2)',
                       fontSize:'.8rem',lineHeight:1.5,color:'var(--text-2)'}}>
            <div style={{color:'var(--text-1)',fontWeight:600,marginBottom:4}}>
              {money.nightsUsed} of {money.daysInPeriod} nights used
            </div>
            {money.which === 'wash' ? (
              <>
                <div>{money.why}</div>
                {money.canRefund && (
                  <div style={{marginTop:6,color:'var(--gold)'}}>
                    {fmt(money.refundDue)} can still go back to them if you want it to — a refund
                    turns the wash off, so their final utility would bill as usual.
                  </div>
                )}
              </>
            ) : (
              <>
                <div>
                  Their {money.nightsUsed} nights come to {fmt(money.worth)}
                  {money.lodgingTax > 0 && <> plus {fmt(money.lodgingTax)} lodging tax — {fmt(money.repricedTotal)}</>}
                  {money.plan && <> ({money.plan})</>}.
                </div>
                {owesThemMoney && (
                  <div style={{marginTop:6,color:'var(--gold)'}}>
                    {fmt(money.paid)} was paid, so {fmt(money.refundDue)} can go back to them —
                    your call. Send it from their Payments page.
                  </div>
                )}
                {money.paid > 0 && !owesThemMoney && money.whyNoRefund && (
                  <div style={{marginTop:6}}>{money.whyNoRefund}</div>
                )}
                {canAdjust && (
                  <div style={{marginTop:6}}>
                    Their bill of {fmt(money.unpaid)} becomes {fmt(money.repricedTotal)},
                    and the late fees on it come off.
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {err && <div style={{color:'var(--red)',fontSize:'.78rem',marginTop:8}}>{err}</div>}
        <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:18,flexWrap:'wrap'}}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          {existing && (
            <button className="btn btn-ghost btn-sm" disabled={save.isLoading}
              onClick={()=>save.mutate(null)}>
              They are staying after all
            </button>
          )}
          <button className="btn btn-primary btn-sm"
            disabled={!date || tooEarly || save.isLoading}
            onClick={()=>save.mutate(date)}>
            {save.isLoading ? 'Saving…' : 'Save'}
          </button>
          {canAdjust && (
            <button className="btn btn-primary btn-sm" disabled={adjust.isLoading || save.isLoading}
              onClick={()=>{ save.mutate(date); adjust.mutate() }}>
              {adjust.isLoading ? 'Adjusting…' : `Save and adjust the bill to ${fmt(money.repricedTotal)}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
