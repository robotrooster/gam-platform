/**
 * 10/12 (Nic) — EXTRA HOURS: hours a work trader works beyond what the trade
 * needs.
 *
 *   "He may be doing more work than what the work trade covers. And instead of
 *    giving him credit ahead for his rent, it may be compensation on top of the
 *    rent... a way to track an hourly rate for additional hours so that the
 *    landlord can supplement a check through payroll or 1099."
 *
 * The landlord picks per agreement: bank them toward future months, or pay them
 * at an hourly rate by payroll (W-2) or a contractor payment (1099). Paid extra
 * hours are paid "Both" ways (Nic): by hand (Mark paid) or through GAM Books.
 *
 * The tenant sees banked extra hours as HOURS ONLY, and paid extra hours with
 * their rate and amount ("6 extra hours × $15 = $90"). The trade hours never
 * carry a rate for the tenant — the server enforces that (S643); nothing here
 * prices a trade hour.
 */
import { useState } from 'react'
import { useMutation } from 'react-query'
import {
  WORK_TRADE_EXTRA_HOURS_MODES, WORK_TRADE_EXTRA_HOURS_MODE_LABEL, WORK_TRADE_EXTRA_PAY_METHODS,
  WORK_TRADE_EXTRA_PAY_METHOD_LABEL, WORK_TRADE_EXTRA_HOURS_NOTICE, WORK_TRADE_EXTRA_PAYABLE_STATUS_LABEL,
  WORK_TRADE_EXTRA_PAID_HOW, WORK_TRADE_EXTRA_PAID_HOW_LABEL, BOOKS_COST_PLACES, BOOKS_COST_PLACE_LABEL,
  type WorkTradeExtraHoursMode, type WorkTradeExtraPayMethod, type WorkTradeExtraPaidHow, type BooksCostPlace,
} from '@gam/shared'
import type { PanelApi } from './WorkTradePanel'

const label: React.CSSProperties = { fontSize: '.64rem', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 6 }
const small: React.CSSProperties = { fontSize: '.72rem', color: 'var(--text-3)', lineHeight: 1.5 }
const money = (n: any) => `$${Number(n || 0).toFixed(2)}`
const hoursText = (n: any) => `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${Number(n) === 1 ? 'hour' : 'hours'}`
const monthText = (ym: string | null | undefined) => ym
  ? new Date(ym.slice(0, 10) + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '—'
const errText = (e: any, fallback: string) => e?.response?.data?.error || e?.message || fallback

/** The landlord's setting: "When they work more hours than the agreement needs". */
export function ExtraHoursSetting({ agreement, api, onSaved, notify }: {
  agreement: any
  api: PanelApi
  onSaved: () => void
  notify?: (msg: string, kind?: 'error') => void
}) {
  const stored: WorkTradeExtraHoursMode = agreement.extraHoursMode === 'pay' ? 'pay' : 'bank'
  const [mode, setMode] = useState<WorkTradeExtraHoursMode>(stored)
  const [rate, setRate] = useState<string>(agreement.extraHoursRate != null ? String(Number(agreement.extraHoursRate)) : '')
  const [method, setMethod] = useState<WorkTradeExtraPayMethod | ''>(agreement.extraHoursPayMethod ?? '')
  const save = useMutation(
    () => api.patch(`/work-trade/${agreement.id}`, mode === 'pay'
      ? { extraHours: 'pay', extraHoursRate: Number(rate), extraHoursPayMethod: method }
      : { extraHours: 'bank' }),
    { onSuccess: () => { onSaved(); notify?.('Saved') },
      onError: (e: any) => notify?.(errText(e, 'Could not save that'), 'error') })
  const rateOk = Number(rate) > 0 && Number(rate) <= 1000
  const dirty = mode !== stored
    || (mode === 'pay' && (Number(rate) !== Number(agreement.extraHoursRate ?? 0) || method !== (agreement.extraHoursPayMethod ?? '')))
  const canSave = dirty && (mode === 'bank' || (rateOk && !!method))
  const tracks = agreement.tracksHours !== false

  return (
    <div>
      <div style={label}>When they work more hours than the agreement needs</div>
      {!tracks && <div style={{ ...small, marginBottom: 6 }}>
        This agreement does not track hours, so there are no extra hours to bank or pay.</div>}
      <div style={{ display: 'grid', gap: 6, opacity: tracks ? 1 : .5 }}>
        {WORK_TRADE_EXTRA_HOURS_MODES.map(m => (
          <label key={m} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: tracks ? 'pointer' : 'default' }}>
            <input type="radio" name={`extra-${agreement.id}`} checked={mode === m} disabled={!tracks}
              onChange={() => setMode(m)} style={{ marginTop: 3 }} />
            <div style={{ fontSize: '.8rem', color: 'var(--text-0)' }}>{WORK_TRADE_EXTRA_HOURS_MODE_LABEL[m]}</div>
          </label>
        ))}
      </div>
      {mode === 'pay' && tracks && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8, paddingLeft: 22 }}>
          <div>
            <label style={{ fontSize: '.72rem', color: 'var(--text-2)', display: 'block', marginBottom: 3 }}>Hourly rate for extra hours</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text-2)' }}>$</span>
              <input className="input" type="number" min={0.01} max={1000} step="0.01" inputMode="decimal"
                style={{ width: 110, padding: '5px 8px', textAlign: 'right' }}
                value={rate} onChange={e => setRate(e.target.value)} />
              <span style={small}>per hour</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-2)', marginBottom: 3 }}>How they are paid</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
              {WORK_TRADE_EXTRA_PAY_METHODS.map(pm => (
                <label key={pm} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.78rem', cursor: 'pointer' }}>
                  <input type="radio" name={`extra-method-${agreement.id}`} checked={method === pm} onChange={() => setMethod(pm)} />
                  {WORK_TRADE_EXTRA_PAY_METHOD_LABEL[pm]}
                </label>
              ))}
            </div>
          </div>
          <div style={{ ...small, color: 'var(--text-2)' }}>{WORK_TRADE_EXTRA_HOURS_NOTICE}</div>
        </div>
      )}
      {mode === 'bank' && tracks && (
        <div style={{ ...small, marginTop: 6, paddingLeft: 22 }}>
          Extra hours count toward later months, including any they fall short in.</div>
      )}
      {dirty && tracks && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <button className="btn btn-primary btn-sm" disabled={!canSave || save.isLoading} onClick={() => save.mutate()}>
            {save.isLoading ? '…' : 'Save'}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => {
            setMode(stored); setRate(agreement.extraHoursRate != null ? String(Number(agreement.extraHoursRate)) : '')
            setMethod(agreement.extraHoursPayMethod ?? '')
          }}>Cancel</button>
        </div>
      )}
    </div>
  )
}

/**
 * Paid extra hours with both ways to pay them. `showWho` names the person and
 * unit (the Work Trade page's list across everyone); the agreement window
 * leaves it off.
 */
export function ExtraHoursPayables({ rows, api, onChanged, notify, showWho = false, emptyText }: {
  rows: any[]
  api: PanelApi
  onChanged: () => void
  notify?: (msg: string, kind?: 'error') => void
  showWho?: boolean
  emptyText?: string
}) {
  // 10/12: the browser's own calendar day. toISOString() is UTC, so after 5 pm
  // in Arizona "Mark paid" opened on tomorrow and the server refused its own
  // default ("cannot be in the future").
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  // 10/14 (Nic): "ask where it goes every time (split, property or unit), like
  // other expenses." Where the cost goes and how it was paid start blank —
  // nothing is chosen for the person (10/13: "they pick as the expense happens").
  type Paying = { id: string; paidOn: string; paidHow: WorkTradeExtraPaidHow | ''; note: string
    costPlace: BooksCostPlace | ''; propertyId: string; unitId: string }
  const [paying, setPaying] = useState<Paying | null>(null)
  const [places, setPlaces] = useState<{ id: string; name: string; units: { id: string; unitNumber: string }[] }[]>([])
  const placeChosen = (p: Paying) => p.costPlace === 'split_by_units' || (p.costPlace === 'property' && !!p.propertyId)
    || (p.costPlace === 'unit' && !!p.unitId)
  const startPaying = (id: string) => {
    setPaying({ id, paidOn: today, paidHow: '', note: '', costPlace: '', propertyId: '', unitId: '' })
    setPlaces([])
    Promise.resolve(api.get(`/work-trade/extra-hours/${id}/cost-places`))
      .then((d: any) => setPlaces(d?.properties ?? []))
      .catch((e: any) => notify?.(errText(e, 'Could not load your properties'), 'error'))
  }
  const markPaid = useMutation(
    (p: Paying) =>
      api.post(`/work-trade/extra-hours/${p.id}/mark-paid`, {
        paidOn: p.paidOn, paidHow: p.paidHow, note: p.note.trim() || undefined,
        costPlace: p.costPlace || null,
        propertyId: p.costPlace === 'property' || p.costPlace === 'unit' ? p.propertyId || null : null,
        unitId: p.costPlace === 'unit' ? p.unitId || null : null,
      }),
    // 10/12 (Nic): money out is one record — Mark paid also records the pay as
    // a paid expense under "Work trade labor" (routes/workTrade mark-paid).
    { onSuccess: () => { setPaying(null); onChanged(); notify?.('Marked paid, and recorded on Expenses under Work trade labor') },
      onError: (e: any) => notify?.(errText(e, 'Could not mark that paid'), 'error') })
  const sendToBooks = useMutation(
    (id: string) => api.post(`/work-trade/extra-hours/${id}/send-to-books`, {}),
    { onSuccess: () => { onChanged(); notify?.('Sent to GAM Books') },
      onError: (e: any) => notify?.(errText(e, 'Could not send that to GAM Books'), 'error') })

  if (!rows.length) return emptyText ? <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>{emptyText}</div> : null
  return (
    <div>
      {rows.map(r => (
        <div key={r.id} style={{ padding: '9px 0', borderTop: '1px solid var(--border-0, var(--b1))' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              {showWho && (
                <div style={{ fontWeight: 600, fontSize: '.84rem', color: 'var(--text-0)' }}>
                  {[r.tenantFirst, r.tenantLast].filter(Boolean).join(' ') || 'Work trader'}
                  <span style={{ fontWeight: 400, color: 'var(--text-3)', fontSize: '.74rem' }}> · Unit {r.unitNumber} · {r.propertyName}</span>
                </div>
              )}
              <div style={{ fontSize: '.82rem', color: 'var(--text-1)' }}>
                {monthText(r.periodMonth)}: {hoursText(r.hours)} × {money(r.rate)} = <b>{money(r.amount)}</b>
              </div>
              <div style={small}>
                {WORK_TRADE_EXTRA_PAY_METHOD_LABEL[r.payMethod as WorkTradeExtraPayMethod] ?? 'Pay method not set'}
                {' · '}{WORK_TRADE_EXTRA_PAYABLE_STATUS_LABEL[r.status as keyof typeof WORK_TRADE_EXTRA_PAYABLE_STATUS_LABEL] ?? 'Not paid yet'}
                {r.status === 'paid' && r.paidOn ? ` ${new Date(r.paidOn + 'T12:00:00').toLocaleDateString()}` : ''}
                {/* 10/12 (Nic, ledger P7): paid in GAM Books (a payroll run or a
                    contractor bill) says so in its note; by hand, by check or cash. */}
                {r.status === 'paid' && r.paidHow && (WORK_TRADE_EXTRA_PAID_HOW as readonly string[]).includes(r.paidHow)
                  ? ` by ${WORK_TRADE_EXTRA_PAID_HOW_LABEL[r.paidHow as WorkTradeExtraPaidHow].toLowerCase()}` : ''}
                {r.paidNote ? ` — ${r.paidNote}` : ''}
              </div>
            </div>
            {r.status !== 'paid' && paying?.id !== r.id && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" disabled={markPaid.isLoading}
                  onClick={() => startPaying(r.id)}>Mark paid</button>
                {r.status === 'unpaid' && (
                  <button className="btn btn-primary btn-sm" disabled={sendToBooks.isLoading}
                    onClick={() => sendToBooks.mutate(r.id)}>Send to GAM Books</button>
                )}
              </div>
            )}
          </div>
          {paying && paying.id === r.id && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginTop: 8 }}>
              <label style={{ fontSize: '.7rem', color: 'var(--text-2)' }}>Paid on
                <input className="input" type="date" max={today} value={paying.paidOn} style={{ width: '100%', marginTop: 2 }}
                  onChange={e => setPaying({ ...paying, paidOn: e.target.value })} />
              </label>
              <div style={{ fontSize: '.7rem', color: 'var(--text-2)' }}>Paid by
                <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
                  {WORK_TRADE_EXTRA_PAID_HOW.map(h => (
                    <label key={h} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '.78rem', color: 'var(--text-1)', cursor: 'pointer' }}>
                      <input type="radio" name={`paid-how-${r.id}`} checked={paying.paidHow === h} onChange={() => setPaying({ ...paying, paidHow: h })} />
                      {WORK_TRADE_EXTRA_PAID_HOW_LABEL[h]}
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ fontSize: '.7rem', color: 'var(--text-2)', gridColumn: '1 / -1' }}>Where the cost goes
                <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
                  {BOOKS_COST_PLACES.map(p => (
                    <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '.78rem', color: 'var(--text-1)', cursor: 'pointer' }}>
                      <input type="radio" name={`cost-place-${r.id}`} checked={paying.costPlace === p}
                        onChange={() => setPaying({ ...paying, costPlace: p, propertyId: p === 'split_by_units' ? '' : paying.propertyId, unitId: p === 'unit' ? paying.unitId : '' })} />
                      {BOOKS_COST_PLACE_LABEL[p]}
                    </label>
                  ))}
                </div>
                {(paying.costPlace === 'property' || paying.costPlace === 'unit') && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    <select className="input" value={paying.propertyId} style={{ flex: '1 1 160px' }}
                      onChange={e => setPaying({ ...paying, propertyId: e.target.value, unitId: '' })}>
                      <option value="">Choose the property</option>
                      {places.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    {paying.costPlace === 'unit' && (
                      <select className="input" value={paying.unitId} disabled={!paying.propertyId} style={{ flex: '1 1 120px' }}
                        onChange={e => setPaying({ ...paying, unitId: e.target.value })}>
                        <option value="">Choose the unit</option>
                        {(places.find(p => p.id === paying.propertyId)?.units ?? []).map(u => <option key={u.id} value={u.id}>Unit {u.unitNumber}</option>)}
                      </select>
                    )}
                  </div>
                )}
              </div>
              <label style={{ fontSize: '.7rem', color: 'var(--text-2)', gridColumn: '1 / -1' }}>Note (optional)
                <input className="input" placeholder="e.g. check #1042" value={paying.note} style={{ width: '100%', marginTop: 2 }}
                  onChange={e => setPaying({ ...paying, note: e.target.value })} />
              </label>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6 }}>
                <button className="btn btn-primary btn-sm" disabled={markPaid.isLoading || !paying.paidOn || !paying.paidHow || !placeChosen(paying)}
                  onClick={() => markPaid.mutate(paying)}>{markPaid.isLoading ? '…' : `Mark ${money(r.amount)} paid`}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setPaying(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * What the tenant (and the landlord, in the same window) sees of the extra
 * hours the month closes recorded: banked ones as hours, paid ones with their
 * rate and amount. `extra` is the standing's `extraHours`.
 */
export function ExtraHoursRecord({ extra, side, only }: {
  extra: any
  side: 'landlord' | 'tenant'
  /** Show only banked or only paid entries (the landlord lists paid ones with their buttons). */
  only?: 'banked' | 'paid'
}) {
  const recent: any[] = (extra?.recent ?? []).filter((e: any) => !only || e.how === only)
  if (!recent.length) return null
  const paidWords = side === 'tenant' ? 'paid separately by your landlord' : 'paid separately'
  return (
    <div>
      {recent.map((e, i) => (
        <div key={`${e.periodMonth}-${e.how}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', fontSize: '.8rem', color: 'var(--text-1)', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 200px' }}>
            {hoursText(e.hours)} in {monthText(e.periodMonth).split(' ')[0]}
            {e.how === 'paid' && e.rate != null
              ? <> × {money(e.rate)} = <b>{money(e.amount)}</b> — {paidWords}</>
              : <> — banked toward future months</>}
          </span>
          {e.how === 'paid' && (
            <span className="badge" style={{ fontSize: '.62rem' }}>{e.status === 'paid' ? 'Paid' : 'Not paid yet'}</span>
          )}
        </div>
      ))}
    </div>
  )
}
