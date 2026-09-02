/**
 * S633 — TYPE THE DATE. DON'T SCROLL TO IT.
 *
 * Reported live, mid-application, by an applicant on Chrome for Android
 * (Samsung). Nic: "he's had to click on it twelve times just to scroll back
 * through a year. There was no way to just type in a date."
 *
 * The field was `<input type="date">`. On a desktop that is fine — Chrome
 * renders typeable MM/DD/YYYY segments. On Android Chrome the same element
 * opens the Material calendar instead, which starts at today and pages by
 * MONTH. A 1962 birthday is roughly 770 taps on the back-arrow. The year label
 * is tappable, but nothing on screen says so, and an applicant who has already
 * handed over their SSN is not in a mood to go looking.
 *
 * A birthday is the one date nobody browses to. You already know it; you just
 * need somewhere to put it. So this is three numeric boxes — month, day, year —
 * with no picker at all: eight keystrokes on the number pad that Android raises
 * for `inputMode="numeric"`, and the same eight on a desktop keyboard.
 *
 * Details that matter, because this sits in the middle of a paid screening flow
 * where an abandoned form is a lost applicant:
 *
 *  - It advances by itself. Two digits of month jump to day, two of day jump to
 *    year, so the whole date is one uninterrupted run of digits.
 *  - Backspace at the start of an empty box steps BACK a box. Auto-advance
 *    without that is a trap: correcting a typo means reaching for the screen.
 *  - Pasting "07/14/1962" (or an ISO date) into any box fills all three. People
 *    paste from their notes app.
 *  - It reads the finished date back in words — "14 July 1962 · age 63" — right
 *    under the boxes. A transposed 1926 for 1962 is invisible as digits and
 *    obvious as a sentence, and the age is the number the 18+ rule turns on.
 *  - A single-digit month or day is padded on blur, so "7" becomes "07" rather
 *    than silently failing to parse.
 *
 * It emits an ISO `YYYY-MM-DD` string, or '' while the date is incomplete or
 * impossible — the same contract `<input type="date">` had, so callers keep
 * their existing validation.
 *
 * The only date a tenant actually types on a lease is a birthdate — the signing
 * date is derived from document completion, not filled in — so this is built for
 * that one job and carries no picker, no shortcuts, and no modes.
 */
import { useRef, useState, useEffect } from 'react'

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** Days in a month, honouring leap years — so 31 February can't be accepted. */
function daysInMonth(month: number, year: number): number {
  if (month < 1 || month > 12) return 31
  return new Date(Date.UTC(year || 2000, month, 0)).getUTCDate()
}

/** Whole years elapsed. Used for the read-back and by the caller's 18+ gate. */
export function ageOn(iso: string, on = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  let age = on.getFullYear() - y
  const hadBirthday = on.getMonth() + 1 > mo || (on.getMonth() + 1 === mo && on.getDate() >= d)
  if (!hadBirthday) age -= 1
  return age
}

export function TypedDateInput({
  value, onChange, invalid, inputStyle, id,
}: {
  /** ISO 'YYYY-MM-DD', or '' when unset. */
  value: string
  onChange: (iso: string) => void
  /** Caller's validation verdict (e.g. under 18) — borders the boxes red. */
  invalid?: boolean
  /** The host form's input style, so this matches whatever it is dropped into. */
  inputStyle?: React.CSSProperties
  id?: string
}) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const [mm, setMm] = useState(parts ? parts[2] : '')
  const [dd, setDd] = useState(parts ? parts[3] : '')
  const [yyyy, setYyyy] = useState(parts ? parts[1] : '')

  // S636 (Nic, EMERGENCY): re-sync when the caller hands us a DIFFERENT date.
  //
  // The three boxes were seeded once at mount, so a single instance reused
  // across several date fields carried the previous field's digits into the
  // next — and the emit effect below then wrote '' back over an answer the
  // signer had already given. Callers should key per field (the sign page now
  // does); this makes losing an answer impossible even when they do not.
  //
  // Only when `value` disagrees with what the boxes currently represent, so it
  // never fights the user mid-type: our own emissions always match.
  useEffect(() => {
    const shown = mm.length === 2 && dd.length === 2 && yyyy.length === 4
      ? `${yyyy}-${mm}-${dd}` : ''
    if (value === shown) return
    const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    setMm(p ? p[2] : ''); setDd(p ? p[3] : ''); setYyyy(p ? p[1] : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const dayRef = useRef<HTMLInputElement>(null)
  const yearRef = useRef<HTMLInputElement>(null)
  const monthRef = useRef<HTMLInputElement>(null)

  // A complete, real date emits ISO; anything else emits '' so the caller's
  // "have they answered yet" check stays a simple truthiness test. Impossible
  // dates (31 February, month 13) never leave here as a value.
  useEffect(() => {
    const m = Number(mm), d = Number(dd), y = Number(yyyy)
    const complete = mm.length === 2 && dd.length === 2 && yyyy.length === 4
    const real = complete && m >= 1 && m <= 12 && y >= 1900 && d >= 1 && d <= daysInMonth(m, y)
    const iso = real ? `${yyyy}-${mm}-${dd}` : ''
    if (iso !== value) onChange(iso)
    // `value` is deliberately out of the dep list: this effect OWNS the outward
    // value, and re-running on our own emission would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mm, dd, yyyy])

  /** Pasting a whole date into any box fills all three. */
  function absorbPaste(text: string): boolean {
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim())
    const us = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(text.trim())
    if (!iso && !us) return false
    const [y, m, d] = iso
      ? [iso[1], iso[2], iso[3]]
      : [us![3], us![1], us![2]]
    setMm(m.padStart(2, '0')); setDd(d.padStart(2, '0')); setYyyy(y)
    return true
  }

  function box(
    which: 'mm' | 'dd' | 'yyyy',
    val: string,
    set: (s: string) => void,
    len: number,
    placeholder: string,
    label: string,
    ref: React.RefObject<HTMLInputElement>,
    next?: React.RefObject<HTMLInputElement>,
    prev?: React.RefObject<HTMLInputElement>,
  ) {
    return (
      <div style={{ flex: which === 'yyyy' ? '0 0 5.5rem' : '0 0 3.6rem' }}>
        <input
          id={which === 'mm' ? id : undefined}
          ref={ref}
          // The number PAD, not a number SPINNER: type=number on Android shows
          // stepper arrows and silently accepts 'e' and '-'.
          type="text"
          inputMode="numeric"
          autoComplete={which === 'mm' ? 'bday-month' : which === 'dd' ? 'bday-day' : 'bday-year'}
          aria-label={label}
          placeholder={placeholder}
          maxLength={len}
          value={val}
          style={{
            ...inputStyle,
            textAlign: 'center',
            letterSpacing: '.08em',
            borderColor: invalid ? '#ef4444' : (inputStyle as any)?.borderColor,
          }}
          onPaste={e => {
            if (absorbPaste(e.clipboardData.getData('text'))) {
              e.preventDefault()
              yearRef.current?.focus()
            }
          }}
          onChange={e => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, len)
            set(digits)
            // Move on once this box is full — the date becomes one run of
            // digits rather than three separate reaches for the screen.
            if (digits.length === len && next) next.current?.focus()
          }}
          onKeyDown={e => {
            // Auto-advance without a way back is a trap: correcting a typo
            // would mean tapping the previous box by hand.
            if (e.key === 'Backspace' && val === '' && prev) {
              e.preventDefault()
              prev.current?.focus()
            }
          }}
          onBlur={() => {
            // "7" is a perfectly reasonable thing to type for July.
            if (which !== 'yyyy' && val.length === 1) set(val.padStart(2, '0'))
          }}
        />
      </div>
    )
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const age = iso ? ageOn(value) : null

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {box('mm', mm, setMm, 2, 'MM', 'Birth month', monthRef, dayRef)}
        <span style={{ color: '#4a5568', fontSize: '.85rem' }}>/</span>
        {box('dd', dd, setDd, 2, 'DD', 'Birth day', dayRef, yearRef, monthRef)}
        <span style={{ color: '#4a5568', fontSize: '.85rem' }}>/</span>
        {box('yyyy', yyyy, setYyyy, 4, 'YYYY', 'Birth year', yearRef, undefined, dayRef)}
      </div>
      {/* Read the date back in words. 1926 typed for 1962 is invisible as
          digits and unmissable as a sentence, and the age is the number any
          18+ rule turns on. */}
      <div style={{ fontSize: '.7rem', color: iso ? '#7c8899' : '#4a5568', marginTop: 5 }}>
        {iso && age != null
          ? `${Number(iso[3])} ${MONTH_NAMES[Number(iso[2]) - 1]} ${iso[1]} · age ${age}`
          : 'Type it — month, day, year.'}
      </div>
    </div>
  )
}
