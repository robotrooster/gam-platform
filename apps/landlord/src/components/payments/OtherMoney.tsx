import { useState } from 'react'
import type { OpenMonthOtherMoney, OpenMonthTotals } from '@gam/shared'
import { money, dayWord } from '../../lib/creditDesk'
import { otherMoneyMeta, otherMoneyWho, saleOpens, salePartDetail, cardFeeWords } from './openMonth'

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
//
// 10/13 (Nic), round 3: "Pay links / register sales that name a space go ON
// that space's row … only money with no space stays in the folder." A sale
// naming a space is on that row (OpenMonthRow.otherMoney), opened from the row
// in the same lines (OtherMoneyLines); the folder keeps the rest, and its sums
// are its own (folderIn / folderRefunded).
export function OtherMoneyFolder({ lines, month, totals }: {
  lines: readonly OpenMonthOtherMoney[]
  /** 'YYYY-MM': the open month. */
  month: string
  /** The page's sums (only for a viewer the grand-total rule admits). */
  totals?: Pick<OpenMonthTotals, 'folderIn' | 'folderRefunded'>
}) {
  const [open, setOpen] = useState(false)
  if (!lines.length) return null
  return (
    <div className="card pay-other" data-section="other-money">
      <button type="button" className="pay-other-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="pay-caret">{open ? '▾' : '▸'}</span>
        Register sales and pay links
        <span className="pay-other-meta">{otherMoneyMeta(lines, totals)}</span>
      </button>
      {open && <OtherMoneyLines lines={lines} month={month} />}
    </div>
  )
}

/**
 * The lines themselves: day, what it was for, who paid and how, the amount (a
 * refund as −). 10/13 (Nic): "When Andres Razo paid by card online for his
 * stay ... it looks like that charge is just for electric. It's not ... not
 * clickable to show an expanded breakdown" — a sale opens (its caret) to its
 * breakdown (SaleParts), one sale at a time or several; a refund has none, its
 * caret's place kept so every day lines up.
 */
export function OtherMoneyLines({ lines, month }: {
  lines: readonly OpenMonthOtherMoney[]
  /** 'YYYY-MM': the open month. */
  month: string
}) {
  const year = month.slice(0, 4)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (key: string) => setOpen(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  return (
    <ul className="pay-other-list">
      {lines.map(l => {
        const key = `${l.kind}:${l.id}`
        const opens = saleOpens(l)
        const shown = opens && open.has(key)
        const cells = (
          <>
            <span className="pay-caret" aria-hidden="true">{opens ? (shown ? '▾' : '▸') : ''}</span>
            <span className="day">{dayWord(l.day, year)}</span>
            <span className="pay-other-for">
              {l.forLabel}
              <span className="pay-sub">{otherMoneyWho(l)} · {l.methodLabel}</span>
            </span>
            <span className={`num${l.kind === 'refund' ? ' cd-timing-late' : ''}`}>
              {l.kind === 'refund' ? '−' : ''}{money(l.amount)}
            </span>
          </>
        )
        return (
          <li key={key} className="pay-other-line" data-line={l.kind}>
            {opens ? (
              <button type="button" className="pay-other-row pay-other-opens" aria-expanded={shown}
                title={shown ? 'Hide what it paid for' : 'Show what it paid for, part by part'}
                onClick={() => toggle(key)}>
                {cells}
              </button>
            ) : <div className="pay-other-row">{cells}</div>}
            {shown && <SaleParts line={l} />}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * A sale's breakdown (OpenMonthOtherMoney.parts — the server's, from the sale's
 * own line items): each part, what it is and how many, and its amount; what
 * comes off as −; the parts' sum, the money on the line; and the card fee the
 * payer paid on top, apart (never in it).
 */
export function SaleParts({ line }: { line: OpenMonthOtherMoney }) {
  const fee = cardFeeWords(line)
  return (
    <div className="pay-parts" data-block="sale-parts">
      <table className="pay-lines">
        <tbody>
          {(line.parts ?? []).map((p, i) => {
            const detail = salePartDetail(p)
            return (
              <tr key={`${p.kind}:${i}`} data-part={p.kind}>
                <td>{p.label}{detail && <span className="pay-sub">{detail}</span>}</td>
                <td className="num">{money(p.amount)}</td>
              </tr>
            )
          })}
          <tr data-part="total" className="pay-parts-total">
            <td>In all</td>
            <td className="num">{money(line.amount)}</td>
          </tr>
          {fee && (
            <tr data-part="card-fee" className="pay-parts-fee">
              <td>{fee}</td>
              <td className="num">{money(line.cardFee)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
