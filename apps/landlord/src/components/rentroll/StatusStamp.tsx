import type { RentRollStatusColor, RentRollRowStatus } from '@gam/shared'
import { money, monthTitle } from '../../lib/creditDesk'
import './rentroll.css'

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
  /** The household's first month on GAM (good news only): a gold underline. */
  onboarding?: boolean
}) {
  if (status === 'none') {
    return <span className="rrs empty" title={title ?? label} aria-label={title ?? label}>—</span>
  }
  return (
    <span className={`rrs ${color}${onboarding ? ' onboarding' : ''}`} title={title ?? label} aria-label={title ?? undefined}>{label}</span>
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
