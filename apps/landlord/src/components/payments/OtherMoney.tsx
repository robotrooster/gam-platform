import { useState } from 'react'
import type { OpenMonthOtherMoney, OpenMonthTotals } from '@gam/shared'
import { money, dayWord } from '../../lib/creditDesk'
import { otherMoneyMeta, otherMoneyWho } from './openMonth'

// ── THE REST OF THE MONEY THAT CAME IN (10/13, Nic) ─────────────────────────
//
//   "the payments page ... should show all money coming in."
//
// The bills are the rows, a stay's money is its guest's row; what is left is
// the register's and the pay links' money that is no household's bill and no
// stay's — propane to a walk-in, an emailed pay link to someone with no lease
// or stay here — and what went back on it at the register this month
// (GET /balances/rent-roll/open-month `otherMoney`). One folder under the
// month, closed until opened, like the Rent Roll's "Moved out, still owes";
// each line its day, what it was for, who paid, how, and the amount. The
// count, and the sums when the server sent them (decisions #25), ride on its
// head. Nothing here is a desk action: it is money already in.
export function OtherMoneyFolder({ lines, month, totals }: {
  lines: readonly OpenMonthOtherMoney[]
  /** 'YYYY-MM': the open month. */
  month: string
  /** The page's sums (only for a viewer the grand-total rule admits). */
  totals?: Pick<OpenMonthTotals, 'otherIn' | 'otherRefunded'>
}) {
  const [open, setOpen] = useState(false)
  if (!lines.length) return null
  const year = month.slice(0, 4)
  return (
    <div className="card pay-other" data-section="other-money">
      <button type="button" className="pay-other-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="pay-caret">{open ? '▾' : '▸'}</span>
        Register sales and pay links
        <span className="pay-other-meta">{otherMoneyMeta(lines, totals)}</span>
      </button>
      {open && (
        <ul className="pay-other-list">
          {lines.map(l => (
            <li key={`${l.kind}:${l.id}`} className="pay-other-line" data-line={l.kind}>
              <span className="day">{dayWord(l.day, year)}</span>
              <span className="pay-other-for">
                {l.forLabel}
                <span className="pay-sub">{otherMoneyWho(l)} · {l.methodLabel}</span>
              </span>
              <span className={`num${l.kind === 'refund' ? ' cd-timing-late' : ''}`}>
                {l.kind === 'refund' ? '−' : ''}{money(l.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
