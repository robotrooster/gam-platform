/**
 * 10/19 (Nic) — A LEASE DATE IS PICKED, NOT TYPED.
 *
 *   "make it so that box can only be a calendar date pick and not possible to
 *    be typed in by hand. That way we're looking at eliminating the possibility
 *    of making mistakes, because eventually I'd like to be able to trust
 *    somebody else to fill out leases. And so we need it to handhold as much as
 *    possible."
 *
 * Two things this is deliberately NOT, and why:
 *
 *  - The browser's own date box. S652 (Blu): "the browser's own date box closed
 *    the editor on every part he changed — month, then day, then year, three
 *    trips in." A native <input type="date"> inside the signing editor commits
 *    on every segment, and the editor closes under him mid-date. Picking a day
 *    here only REPORTS the date; the editor it sits in stays open until Save,
 *    which is the entire reason the native box was taken out in the first
 *    place.
 *
 *  - TypedDateInput (the three typed boxes that replaced the native box). Those
 *    are boxes you type into, which is the thing being taken away. The tenant
 *    page keeps them — its own copy, apps/tenant/src/components/TypedDateInput.tsx
 *    — because the one date a tenant types is a birthdate, and nobody browses
 *    back forty years to a birthdate. This app's copy was deleted with this
 *    change: it had nothing importing it.
 *
 * So there is no input element anywhere in here. A month grid, arrows for the
 * month and the year, and the finished date read back in words underneath — a
 * mis-clicked day is invisible as a number and obvious as a sentence, the same
 * reason TypedDateInput reads its date back.
 *
 * It emits an ISO 'YYYY-MM-DD' string, the same contract TypedDateInput and
 * <input type="date"> had, so the caller's handling is unchanged.
 */
import { useEffect, useState } from 'react'

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Days in a month, honoring leap years — so February never shows a 30th. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Which weekday the 1st falls on, 0 = Sunday. Read at UTC so no zone shifts it. */
function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
}

/** 'Thursday, October 15, 2026' — the picked date, said out loud. */
export function dateInWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  if (!m) return ''
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]
  return `${weekday}, ${MONTH_NAMES[mo - 1]} ${d}, ${y}`
}

export function LeaseDateCalendar({
  value, onChange,
}: {
  /** ISO 'YYYY-MM-DD', or '' when nothing is picked yet. */
  value: string
  onChange: (iso: string) => void
}) {
  const picked = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '')
  // The month on screen starts wherever the date already is; with no date yet,
  // this month — a lease being written is nearly always written near its start.
  const today = new Date()
  const [shown, setShown] = useState<{ y: number; m: number }>(() => picked
    ? { y: Number(picked[1]), m: Number(picked[2]) }
    : { y: today.getFullYear(), m: today.getMonth() + 1 })

  // Follow a date handed in from outside (a different field opening in the same
  // editor, or a value the page derived). Never fights a click: a day picked
  // here is always inside the month already on screen.
  useEffect(() => {
    const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '')
    if (!p) return
    const y = Number(p[1]), m = Number(p[2])
    setShown(s => (s.y === y && s.m === m ? s : { y, m }))
  }, [value])

  const step = (months: number) => setShown(s => {
    const total = s.y * 12 + (s.m - 1) + months
    return { y: Math.floor(total / 12), m: (total % 12) + 1 }
  })

  const total = daysInMonth(shown.y, shown.m)
  const lead = firstWeekday(shown.y, shown.m)
  // Whole weeks, so the grid does not change height as the month changes and
  // the day under the cursor is not a moving target.
  const cells: Array<number | null> = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  const isoFor = (day: number) =>
    `${shown.y}-${String(shown.m).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  const arrow = (text: string, aria: string, months: number) => (
    <button type="button" aria-label={aria} onClick={() => step(months)}
      style={{ padding: '4px 9px', borderRadius: 7, border: '1px solid #e5e7eb', background: 'white',
               color: '#555', cursor: 'pointer', fontSize: '.8rem', lineHeight: 1.2 }}>
      {text}
    </button>
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {arrow('«', 'Previous year', -12)}
          {arrow('‹', 'Previous month', -1)}
        </div>
        <div style={{ fontWeight: 700, color: '#1a1a1a', fontSize: '.88rem' }}>
          {MONTH_NAMES[shown.m - 1]} {shown.y}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {arrow('›', 'Next month', 1)}
          {arrow('»', 'Next year', 12)}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
        {WEEKDAY_INITIALS.map((w, i) => (
          <div key={i} style={{ textAlign: 'center', fontSize: '.64rem', fontWeight: 700, color: '#bbb',
                                textTransform: 'uppercase' as const, letterSpacing: '.04em', paddingBottom: 2 }}>{w}</div>
        ))}
        {cells.map((day, i) => {
          if (day == null) return <div key={`blank-${i}`}/>
          const iso = isoFor(day)
          const isPicked = iso === value
          return (
            <button key={iso} type="button" data-day={iso} aria-label={dateInWords(iso)}
              aria-pressed={isPicked}
              onClick={() => onChange(iso)}
              style={{
                padding: '7px 0', borderRadius: 7, cursor: 'pointer', fontSize: '.84rem',
                border: `1.5px solid ${isPicked ? '#c9a227' : '#e5e7eb'}`,
                background: isPicked ? '#c9a227' : 'white',
                color: isPicked ? 'white' : '#1a1a1a',
                fontWeight: isPicked ? 800 : 500,
              }}>
              {day}
            </button>
          )
        })}
      </div>

      {/* Read the date back in words. A day clicked one square off is invisible
          as a number and unmissable as a sentence. */}
      <div style={{ fontSize: '.72rem', color: value ? '#7c8899' : '#4a5568', marginTop: 7 }}>
        {value
          ? dateInWords(value)
          : 'Click a day. Use the arrows for another month or year.'}
      </div>
    </div>
  )
}
