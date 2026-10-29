import { useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { RentRollStayLine } from '@gam/shared'
import { money } from '../../lib/creditDesk'
import './rentroll.css'

/** The Stays card's head: "6 stays" — how many stays the lines add up. */
export function staysMeta(stays: readonly Pick<RentRollStayLine, 'stays'>[]): string {
  const n = stays.reduce((t, s) => t + s.stays, 0)
  return `${n} stay${n === 1 ? '' : 's'}`
}

/**
 * THE STAYS, UNDER THE ROWS — NEVER IN A SITE'S SPOT.
 *
 * 10/13 (Nic): "show stays as an aggregate by line items. eg 22 nights paid
 * for via pos and 1 week paid for via pos … dont put these stays in the spot
 * put them below with expandable notes. 4 nights in 15 and 8 nights in 18
 * etc." — one line per kind of line item and how it was paid for, the money
 * beside it only when the server sent it (the front desk gets the counts
 * alone), each line opening to its notes per site.
 *
 * 10/21 (Nic): "maybe at the bottom is where we have stays, like underneath
 * the sites, but above the register sales and pay links. Have it be stays
 * where it's tracking … this is how many individual nights we sold, this is
 * how many weeks we sold, or combination thereof … We don't want it to be in
 * the rent roll, making it longer" — so the Payments page shows this same card
 * under its sites. One card, both pages, so the two never drift.
 *
 * Every figure is the server's (services/rentRoll rentRollStays); this card
 * adds nothing up but the head's count of stays.
 */
export function StaysCard({ stays, style }: {
  stays: readonly RentRollStayLine[]
  /** The page's dimming while a new range loads (the Rent Roll page's). */
  style?: CSSProperties
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (key: string) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  if (!stays.length) return null
  return (
    <div className="card rrh-stays" style={style} data-section="stays">
      <div className="rrh-stays-head">
        Stays
        <span className="rrh-folder-meta">{staysMeta(stays)}</span>
      </div>
      <ul className="rrh-stays-list">
        {stays.map(s => {
          const shown = open.has(s.key)
          return (
            <li key={s.key} className="rrh-stay" data-line={s.key}>
              <button type="button" className="rrh-stay-head" aria-expanded={shown} onClick={() => toggle(s.key)}>
                {shown ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="rrh-stay-label">{s.label}</span>
                {s.paid !== undefined && <span className="rrh-stay-paid">{money(s.paid)}</span>}
              </button>
              {shown && (
                <ul className="rrh-stay-notes">
                  {s.sites.map(x => <li key={x.space ?? ''}>{x.label}</li>)}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
