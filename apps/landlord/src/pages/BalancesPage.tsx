import { Fragment, useRef, useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { TicketBreakdown, PayLinkBreakdown, InvoiceBreakdown } from '../components/BalanceBreakdowns'
import { RecordPaymentWindow, PostPaymentForm } from '../components/RecordPaymentWindow'
import { api, apiGet } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { useAuth } from '../context/AuthContext'
import {
  money, creditBesideText, monthsOwedText, daysLateText, sliceByProperty, serverTotals, folderTotal,
  payerHits, matchPayerHits, type OutstandingRow, type OutstandingSlice, type RecordAnchor, type PickerLease,
} from '../lib/creditDesk'
import '../styles/credit-desk.css'

/**
 * OUTSTANDING BALANCES — who owes what, across every month, and where money is
 * taken (decisions #29, Nic 10/3).
 *
 *   "A household stays on it, with every unpaid month shown ('$X from
 *    August'), until it is paid. RECORD PAYMENT moves here: a button on each
 *    household row (opens the record-payment form already filled with that
 *    household and what it owes) plus ONE Record payment button at the top for
 *    anyone not on the list (paying ahead). A bank payment still clearing shows
 *    'Payment clearing' on the row, not owed and not late ... Work trade:
 *    charges covered by work trade are never owed and never shown as an amount
 *    — the household shows 'Work trade' for them and is never late."
 *
 * The FULL balance, with "credit available $X" beside it — never taken off it
 * (Nic, 10/2). How late is the server's count, honoring the grace period.
 *
 * Decisions #25: front desk and on-site staff never see a grand total. The
 * server sends totals (`meta.totals`) only to owners and property managers;
 * this page shows a total only when it was sent one and never adds rows up.
 *
 * S634 (Nic): every name opens what makes up the balance. S654 (Nic): one
 * folder per property, closed until opened; alphabetical inside.
 */
export function BalancesPage() {
  const qc = useQueryClient()
  const { can } = usePerms()
  const canTake = can('take_payment')
  const { data: res, isLoading, error, refetch, isFetching } = useQuery(
    ['outstanding-balances', 'with-clearing'],
    () => api.get('/balances?include=clearing').then(r => r.data as { data: OutstandingRow[]; meta?: unknown }),
    { refetchOnWindowFocus: true })
  const rows: OutstandingRow[] = res?.data ?? []
  const totals = serverTotals(res?.meta)

  // S634: which row is open. One at a time — a look-it-up-and-answer surface.
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [openProps, setOpenProps] = useState<Set<string>>(() => new Set())
  const toggleProp = (id: string) => setOpenProps(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  // The desk window, the "who is paying?" picker, and a payment posted ahead.
  const [recording, setRecording] = useState<{ anchorId: string; tenantId: string | null; name: string } | null>(null)
  const [picking, setPicking] = useState(false)
  const [posting, setPosting] = useState<{ tenantId: string; name: string } | null>(null)
  // One message at a time: the last thing that happened. What the desk window
  // recorded is said there first; it shows here once the window is closed.
  const [notice, setNotice] = useState<string | null>(null)
  const recorded = useRef<string | null>(null)

  type Folder = { id: string; name: string; slices: OutstandingSlice[] }
  const folders = new Map<string, Folder>()
  for (const s of sliceByProperty(rows)) {
    const f = folders.get(s.propertyId) ?? { id: s.propertyId, name: s.propertyName || 'No property', slices: [] }
    f.slices.push(s)
    folders.set(s.propertyId, f)
  }
  const groups = [...folders.values()].sort((a, b) => a.name.localeCompare(b.name))
  const sortKey = (s: OutstandingSlice) => `${s.row.lastName || ''} ${s.row.firstName || ''}`.trim().toLowerCase() || '￿'
  for (const g of groups) g.slices.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  const singleFolder = groups.length === 1
  const owing = rows.filter(r => r.status !== 'clearing')

  const openRecord = (s: OutstandingSlice, a: RecordAnchor) => {
    setNotice(null)
    // A new window starts with nothing recorded: an earlier window's words can
    // never surface when this one closes (fix round 2).
    recorded.current = null
    setRecording({ anchorId: a.paymentId, tenantId: s.row.tenantId, name: s.name })
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Outstanding Balances</h1>
          <p className="page-subtitle">Who owes, every unpaid month, and where you take a payment — open a property, then a name for the charges</p>
        </div>
        <div className="cd-page-actions">
          {totals && (
            <div className="cd-grand">
              <div className="cd-grand-label">Total owed</div>
              <div className="cd-grand-amount">{money(totals.owed)}</div>
              {totals.clearing > 0 && <div className="cd-grand-sub">+ {money(totals.clearing)} clearing</div>}
            </div>
          )}
          {canTake && (
            <button className="btn btn-primary" onClick={() => { setNotice(null); setPicking(true) }}>
              Record payment
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div className="alert alert-success cd-notice" role="status">
          <span>{notice}</span>
          <button className="btn btn-ghost btn-sm" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={13} /></button>
        </div>
      )}

      {isLoading ? (
        <div className="card cd-empty">Loading…</div>
      ) : error ? (
        <div className="card cd-empty">
          <div className="cd-msg">The balances could not be read.</div>
          <button className="btn btn-primary btn-sm" disabled={isFetching} onClick={() => refetch()}>{isFetching ? 'Reading…' : 'Read them again'}</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="card cd-empty">No outstanding balances — everyone is paid up.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Space</th>
                <th style={{ textAlign: 'right' }}>Owed</th>
                <th>Unpaid months</th>
                <th>Late</th>
                <th>Contact</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap(g => {
                const isOpen = singleFolder || openProps.has(g.id)
                const owes = g.slices.filter(s => s.status === 'owes').length
                const clearingOnly = g.slices.length - owes
                const total = folderTotal(totals, g.id)
                const folder = (
                  <tr key={`folder-${g.id}`} className="cd-folder" onClick={() => toggleProp(g.id)}>
                    <td colSpan={7}>
                      <span className="cd-folder-inner">
                        {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        {g.name}
                        <span className="cd-folder-meta">
                          {owes > 0 && `${owes} ${owes === 1 ? 'person owes' : 'people owe'}`}
                          {owes > 0 && clearingOnly > 0 && ' · '}
                          {clearingOnly > 0 && `${clearingOnly} payment${clearingOnly === 1 ? '' : 's'} clearing`}
                          {total !== null && <> · <span className="cd-folder-total">{money(total)}</span></>}
                        </span>
                      </span>
                    </td>
                  </tr>
                )
                if (!isOpen) return [folder]
                return [folder, ...g.slices.map(s => {
                  const r = s.row
                  const rowOpen = openRow === s.key
                  const late = daysLateText(s.daysLate)
                  const credit = creditBesideText(s.creditAvailable, s.creditOnAccount)
                  const months = monthsOwedText(s.months)
                  const anchorLabel = (a: RecordAnchor) => {
                    if (s.anchors.length < 2) return 'Record payment'
                    const units = (r.spaces ?? []).filter(x => x.landlordId === a.landlordId && x.balance > 0).map(x => x.unitNumber).filter(Boolean)
                    return `Record payment${units.length ? ` · ${units.join(', ')}` : ''}`
                  }
                  return (
                    <Fragment key={s.key}>
                      <tr className="cd-row" onClick={() => setOpenRow(rowOpen ? null : s.key)} title="See what makes up this balance">
                        <td className="cd-name">
                          <span className="cd-caret">{rowOpen ? '▾' : '▸'}</span>
                          {s.name}
                          {s.workTrade && <span className="badge badge-muted cd-tag">Work trade</span>}
                          {s.status === 'clearing' && <span className="badge badge-blue cd-tag">{r.statusLabel || 'Payment clearing'}</span>}
                        </td>
                        <td>
                          {r.payLinkId ? 'Pay link' : r.ticketId ? 'Register ticket' : s.unitNumber || '—'}
                        </td>
                        <td className="cd-owed">
                          {s.status === 'clearing' ? <span className="cd-owed-sub">Nothing owed</span> : money(s.balance)}
                          {s.clearing > 0 && (
                            <div className="cd-owed-sub">
                              {s.status === 'clearing' ? `${money(s.clearing)} payment clearing` : `+ ${money(s.clearing)} payment clearing`}
                            </div>
                          )}
                          {credit && s.status === 'owes' && <div className="cd-owed-credit">{credit}</div>}
                          {(r.payLinkId || r.ticketId) && (
                            <div className="cd-owed-sub">{r.payLinkId ? 'emailed pay link' : 'open register ticket'}</div>
                          )}
                        </td>
                        <td className="cd-months">{s.status === 'owes' ? (months ?? '—') : '—'}</td>
                        <td>{late ? <span className={`cd-late${s.daysLate > 30 ? ' long' : ''}`}>{late}</span> : null}</td>
                        <td className="cd-contact">
                          {r.phone && <div><a className="cd-phone" onClick={e => e.stopPropagation()} href={`tel:${r.phone}`}>{r.phone}</a></div>}
                          {r.email && <div><a onClick={e => e.stopPropagation()} href={`mailto:${r.email}`}>{r.email}</a></div>}
                          {!r.phone && !r.email && <span className="cd-line-meta">—</span>}
                        </td>
                        <td className="cd-record-cell">
                          {/* S641: only for someone who can finish it (Take payments). */}
                          {canTake && s.status === 'owes' && s.anchors.map(a => (
                            <button key={a.paymentId} className="btn btn-primary btn-sm"
                              onClick={e => { e.stopPropagation(); openRecord(s, a) }}>
                              {anchorLabel(a)}
                            </button>
                          ))}
                        </td>
                      </tr>
                      {rowOpen && (
                        <tr>
                          <td colSpan={7} className="cd-breakdown-cell">
                            {/* The link's own property: the register call that reads it and the
                                Adjust that changes it both name it (an account with two companies). */}
                            {r.payLinkId
                              ? <PayLinkBreakdown id={r.payLinkId} link={r.payLink as any} propertyId={r.propertyId} />
                              : r.ticketId
                                ? <TicketBreakdown ticket={r.ticket as any} />
                                : r.tenantId ? <InvoiceBreakdown tenantId={r.tenantId} /> : null}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })]
              })}
            </tbody>
          </table>
        </div>
      )}

      {recording && (
        <RecordPaymentWindow anchorPaymentId={recording.anchorId} tenantId={recording.tenantId} name={recording.name}
          onClose={() => {
            setRecording(null)
            if (recorded.current) { setNotice(recorded.current); recorded.current = null }
            qc.invalidateQueries('outstanding-balances')
          }}
          onRecorded={(m) => { recorded.current = m }} />
      )}
      {picking && (
        <WhoIsPaying owing={owing}
          onClose={() => setPicking(false)}
          onOwes={(s, a) => { setPicking(false); openRecord(s, a) }}
          onAhead={(p) => { setPicking(false); setPosting(p) }} />
      )}
      {posting && (
        <PostPaymentForm tenantId={posting.tenantId} name={posting.name}
          onClose={() => setPosting(null)}
          onChangePerson={() => { setPosting(null); setPicking(true) }}
          onPosted={(m) => { setPosting(null); setNotice(m) }} />
      )}
    </div>
  )
}

/**
 * Record payment at the top (decisions #29): "for anyone not on the list
 * (paying ahead)". Type a name or a space. Somebody who owes opens their
 * desk window, exactly as their row would; anybody else posts a payment ahead;
 * somebody whose only money owed is not taken at the desk is listed with the
 * reason (lib/creditDesk payerHits).
 */
function WhoIsPaying({ owing, onClose, onOwes, onAhead }: {
  owing: OutstandingRow[]
  onClose: () => void
  onOwes: (s: OutstandingSlice, a: RecordAnchor) => void
  onAhead: (p: { tenantId: string; name: string }) => void
}) {
  const { user } = useAuth()
  const [q, setQ] = useState('')
  const { data: leases = [], isLoading } = useQuery<PickerLease[]>('leases', () => apiGet<PickerLease[]>('/leases'), { staleTime: 60_000 })
  const term = q.trim().toLowerCase()
  // A staffer kept to some properties picks only from those (the server refuses the rest anyway).
  const scoped = user && !['landlord', 'admin', 'super_admin'].includes(user.role) && user.allProperties !== true && Array.isArray(user.propertyIds)
    ? new Set<string>(user.propertyIds) : null
  // Everyone on the list is found here too — someone whose only money owed is
  // not taken at the desk (a register ticket, GAM's charges, an eviction pause)
  // is shown with the reason, never left out.
  const shown = matchPayerHits(payerHits(owing, leases, scoped), q)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal cd-window" onClick={e => e.stopPropagation()}>
        <div className="cd-head">
          <div className="modal-title cd-title">Record payment</div>
          <div className="cd-sub">Who is paying? Type a name or a space.</div>
        </div>
        <div className="cd-window-body">
          <input className="form-input" autoFocus value={q} onChange={e => setQ(e.target.value)}
            placeholder="Name or space…" />
          {term.length >= 2 && (
            shown.length > 0 ? (
              <div className="cd-picker-results">
                {shown.map(h => {
                  const who = (
                    <span>
                      <div>{h.name}</div>
                      <div className="cd-picker-meta">{h.where || '—'}</div>
                    </span>
                  )
                  if (h.owes) {
                    const owes = h.owes
                    return (
                      <button key={h.key} type="button" className="cd-picker-item" onClick={() => onOwes(owes.slice, owes.anchor)}>
                        {who}
                        <span className="cd-picker-owes">owes {money(owes.amount)}</span>
                      </button>
                    )
                  }
                  if (h.aheadTenantId) {
                    const tenantId = h.aheadTenantId
                    return (
                      <button key={h.key} type="button" className="cd-picker-item" onClick={() => onAhead({ tenantId, name: h.name })}>
                        {who}
                        <span className="cd-picker-side">
                          {h.note && <span className="cd-picker-note">{h.note}.</span>}
                          <span className="cd-picker-meta">{h.note ? 'Post a payment ahead' : 'nothing owed — paying ahead'}</span>
                        </span>
                      </button>
                    )
                  }
                  // Nothing can be taken for them here: say why, and offer nothing to press.
                  return (
                    <div key={h.key} className="cd-picker-item cd-picker-info" role="note">
                      {who}
                      <span className="cd-picker-note">{h.note}</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="cd-muted">{isLoading ? 'Looking…' : 'Nobody on a lease here matches that.'}</div>
            )
          )}
        </div>
        <div className="cd-actions cd-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
