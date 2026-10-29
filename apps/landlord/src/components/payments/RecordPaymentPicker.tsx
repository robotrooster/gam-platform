import { useState } from 'react'
import type { OpenMonthRow } from '@gam/shared'
import { payerChoices } from './openMonth'

/**
 * RECORD PAYMENT at the top of the Payments page (10/13, Nic: "payments first.
 * with a way to log the payments"). Who is paying? — this property's
 * households, in the page's order, narrowed by a name or space typed. It opens
 * the one way a payment is logged by hand (decisions #29's desk window, or a
 * payment posted ahead when nothing the desk takes is open); nothing here
 * records anything itself. A space in eviction mode is listed with the reason
 * and nothing to press (10/13, Nic: "we have eviction mode that blocks
 * payments").
 */
export function RecordPaymentPicker({ rows, onClose, onRecord, onAhead }: {
  rows: readonly OpenMonthRow[]
  onClose: () => void
  /** Something the desk takes is open: the desk window, on that row's charge. */
  onRecord: (row: OpenMonthRow) => void
  /** Nothing the desk takes is open: post a payment ahead. */
  onAhead: (row: OpenMonthRow) => void
}) {
  const [q, setQ] = useState('')
  const shown = payerChoices(rows, q)
  return (
    <div className="modal-overlay">
      <div className="modal cd-window" role="dialog" aria-label="Record payment">
        <div className="cd-head">
          <div className="modal-title cd-title">Record payment</div>
          <div className="cd-sub">Who is paying? Type a name or a space.</div>
        </div>
        <div className="cd-window-body">
          <input className="form-input" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Name or space…" />
          {shown.length > 0 ? (
            <div className="cd-picker-results">
              {shown.map(h => {
                const who = (
                  <span>
                    <div>{h.name}</div>
                    <div className="cd-picker-meta">{h.space ?? '—'}</div>
                  </span>
                )
                if (h.kind === 'blocked') {
                  return (
                    <div key={h.key} className="cd-picker-item cd-picker-info" role="note">
                      {who}
                      <span className="cd-picker-note">{h.note}</span>
                    </div>
                  )
                }
                return (
                  <button key={h.key} type="button" className="cd-picker-item"
                    onClick={() => (h.kind === 'record' ? onRecord(h.row) : onAhead(h.row))}>
                    {who}
                    {h.kind === 'record' ? (
                      <span className="cd-picker-owes">{h.side}</span>
                    ) : (
                      <span className="cd-picker-side">
                        {h.note && <span className="cd-picker-note">{h.note}.</span>}
                        <span className="cd-picker-meta">{h.side}</span>
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="cd-muted">Nobody here matches that.</div>
          )}
        </div>
        <div className="cd-actions cd-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
