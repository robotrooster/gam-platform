import { useId, useState } from 'react'
import type { RentRollStatusColor, RentRollRowStatus } from '@gam/shared'
import { money, monthTitle } from '../../lib/creditDesk'
import './rentroll.css'

/**
 * 10/13 (Nic), the gold underline on the onboarding month's stamp: "KEEP it,
 * and give it a label" — hover or tap says what it means.
 */
export const ONBOARDING_STAMP_WORDS = 'First month on GAM'

/**
 * 10/13 (Nic) — ONE COLORED PILL that says a month in words: green "Paid",
 * orange "Paid late +5" (days past grace), yellow "Partial", red "Owes +3",
 * gray "Due Oct 1" / "Vacant". The server decides the status, its words and
 * its color (packages/shared rentRoll: RENT_ROLL_STATUS_LABEL, rentRollStatusText,
 * RENT_ROLL_STATUS_COLOR); this only shows them. A month with no bill is a
 * quiet dash ("No bill" on hover), never a pill — the Rent Roll was "too
 * cluttered", and the old letter codes ("O+7") were cryptic.
 */
export function StatusStamp({ status, label, color, title, onboarding }: {
  status: RentRollRowStatus
  label: string
  color: RentRollStatusColor
  /** What it says on hover or tap (the month, the money); defaults to the words. */
  title?: string
  /** The household's first month on GAM (good news only): a gold underline, labeled (OnboardingStamp). */
  onboarding?: boolean
}) {
  if (status === 'none') {
    return <span className="rrs empty" title={title ?? label} aria-label={title ?? label}>—</span>
  }
  if (onboarding) return <OnboardingStamp label={label} color={color} title={title} />
  return (
    <span className={`rrs ${color}`} title={title ?? label} aria-label={title ?? undefined}>{label}</span>
  )
}

/**
 * The onboarding month's stamp: the same pill with its gold underline, and a
 * label — "First month on GAM" — over it while a mouse is on it, or after a tap
 * (a tap again, Escape or moving on closes it), the month's words under it.
 * One label, never the browser's own hover box beside it as well.
 */
function OnboardingStamp({ label, color, title }: { label: string; color: RentRollStatusColor; title?: string }) {
  const [hover, setHover] = useState(false)
  const [tapped, setTapped] = useState(false)
  const tipId = useId()
  const shown = hover || tapped
  // The month's own words, without the onboarding note the label now says first.
  const detail = (title ?? '').replace(/ · first month on GAM$/i, '')
  return (
    <span className="rrs-onb" onPointerEnter={e => { if (e.pointerType === 'mouse') setHover(true) }}
      onPointerLeave={() => setHover(false)}>
      <button type="button" className={`rrs ${color} onboarding`}
        aria-label={`${title ?? label}${/first month on GAM/i.test(title ?? '') ? '' : ` · ${ONBOARDING_STAMP_WORDS}`}`}
        aria-expanded={tapped} aria-describedby={shown ? tipId : undefined}
        onClick={e => { e.stopPropagation(); setTapped(t => !t) }}
        onKeyDown={e => { if (e.key === 'Escape') setTapped(false) }}
        onBlur={() => setTapped(false)}>
        {label}
      </button>
      {shown && (
        <span id={tipId} role="tooltip" className="rrs-tip">
          <strong>{ONBOARDING_STAMP_WORDS}</strong>
          {detail && detail !== label && <span className="rrs-tip-sub">{detail}</span>}
        </span>
      )}
    </span>
  )
}

/** A month's stamp on hover: "October 2026: Paid late +5 · invoiced $577.47 · paid $577.47". */
export function monthStampTitle(s: {
  month: string; statusLabel: string; invoiced: number; paid: number; credit?: number; workTrade: number; owed: number; onboarding?: boolean
}): string {
  const bits = [`${monthTitle(s.month)}: ${s.statusLabel}`]
  if (s.invoiced > 0 || s.paid > 0) bits.push(`invoiced ${money(s.invoiced)}`, `paid ${money(s.paid)}`)
  if ((s.credit ?? 0) > 0) bits.push(`incl. ${money(s.credit!)} account credit`)
  if (s.workTrade > 0) bits.push(`work trade ${money(s.workTrade)}`)
  if (s.owed > 0) bits.push(`owed ${money(s.owed)}`)
  if (s.onboarding) bits.push('first month on GAM')
  return bits.join(' · ')
}
