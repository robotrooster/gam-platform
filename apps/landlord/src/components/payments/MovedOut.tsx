import { useState } from 'react'
import type { OpenMonthMovedOut, OpenMonthTotals } from '@gam/shared'
import { money, dayWord, toCents } from '../../lib/creditDesk'
import { shortMonth } from '../../lib/paymentStamps'
import { householdName } from '../rentroll/PropertyPick'

// ── MOVED OUT, STILL OWES (10/14, Nic) ──────────────────────────────────────
//
//   "A checked-out guest still owing, nothing paid this month: show in the
//    moved-out section of Payments."
//
// One folder under the month, closed until opened, like the Rent Roll's
// "Moved out, still owes" (GET /balances/rent-roll/open-month
// `movedOutOwing`): every stay whose guest checked out still owing with
// nothing paid toward it this month (one paid toward this month is its own
// row, its Owed already said), and every household whose lease ended and who
// no longer lives here, still owing on earlier months. Each line its space,
// who, when they left and what for, and what is still owed; the count, and
// the sum when the server sent it (decisions #25), ride on its head. Nobody
// here is a row as well.
export function MovedOutFolder({ list, month, totals }: {
  list: readonly OpenMonthMovedOut[]
  /** 'YYYY-MM': the open month. */
  month: string
  /** The page's sums (only for a viewer the grand-total rule admits). */
  totals?: Pick<OpenMonthTotals, 'movedOutOwed'>
}) {
  const [open, setOpen] = useState(false)
  if (!list.length) return null
  const year = month.slice(0, 4)
  return (
    <div className="card pay-other" data-section="moved-out">
      <button type="button" className="pay-other-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="pay-caret">{open ? '▾' : '▸'}</span>
        Moved out, still owes
        <span className="pay-other-meta">{movedOutMeta(list, totals)}</span>
      </button>
      {open && (
        <ul className="pay-other-list">
          {list.map(m => (
            <li key={m.key} className="pay-other-line" data-line={m.kind}>
              <div className="pay-other-row">
                <span className="pay-caret" aria-hidden="true" />
                <span className="day">{m.space ?? '—'}</span>
                <span className="pay-other-for">
                  {movedOutWho(m)}
                  <span className="pay-sub">{movedOutDetail(m, year)}</span>
                </span>
                <span className="num cd-timing-late">{money(m.owed)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The folder's head: how many guests and households, and what they owe when the server sent the sum. */
export function movedOutMeta(list: readonly Pick<OpenMonthMovedOut, 'kind'>[], totals?: Pick<OpenMonthTotals, 'movedOutOwed'>): string {
  const stays = list.filter(m => m.kind === 'stay').length
  const households = list.length - stays
  const parts: string[] = []
  if (households > 0) parts.push(`${households} household${households === 1 ? '' : 's'}`)
  if (stays > 0) parts.push(`${stays} stay guest${stays === 1 ? '' : 's'}`)
  if (totals?.movedOutOwed !== undefined && toCents(totals.movedOutOwed) > 0) parts.push(`${money(totals.movedOutOwed)} owed`)
  return parts.join(' · ')
}

/** Who: a household's primary resident, a stay's guest. */
export function movedOutWho(m: Pick<OpenMonthMovedOut, 'kind' | 'residents' | 'guest'>): string {
  if (m.kind === 'stay') return m.guest?.trim() || 'Guest not named'
  return householdName(m.residents)
}

/**
 * When they left and what for: "Stay Sep 1 – Oct 1 · checked out Oct 1" for a
 * guest; "Lease ended Sep 30 · still owes for Sep 2026 $495.00" for a
 * household.
 */
export function movedOutDetail(m: Pick<OpenMonthMovedOut, 'kind' | 'leftOn' | 'stayDates' | 'months'>, year: string): string {
  if (m.kind === 'stay') {
    return [m.stayDates ? `Stay ${m.stayDates}` : 'Stay', m.leftOn ? `checked out ${dayWord(m.leftOn, year)}` : null]
      .filter(Boolean).join(' · ')
  }
  const owes = m.months.map(x => `${shortMonth(x.month)} ${x.month.slice(0, 4)} ${money(x.owed)}`).join(', ')
  return [m.leftOn ? `Lease ended ${dayWord(m.leftOn, year)}` : null, owes ? `still owes for ${owes}` : null]
    .filter(Boolean).join(' · ')
}
