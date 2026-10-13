/**
 * S652 (Nic): GAM's reader desk. A landlord asks for a card reader from the
 * register; here it gets ordered in Stripe's shop — pre-registered to the
 * property's Terminal location on the row — and the Stripe order, serial and
 * tracking are written down. Payments start the 1st of the month after it
 * ships (10/5). The reader closes its own row: it turns up at the location
 * (shipped) and Stripe sees it switched on (registered) — no typed serial.
 *
 * 10/12 (Nic): "331.73 after tax and shipping. 299 base. those orders are going
 * to need to be tracked because shipping will vary." Every order shows what
 * the landlord is charged, what the reader actually cost GAM (base, tax,
 * shipping — or tax and shipping as one figure), and the markup between them.
 * The cost is typed here from the shop receipt, can be changed until the
 * reader ships (after that only the same total split differently), and every
 * entry is kept. "COST FIRST": the plan's pieces repay GAM's cost first and the
 * markup lands in the last piece(s) — each piece's split is shown, with what
 * has been billed, collected, and booked as GAM's earnings.
 */
import React from 'react'
import type { AxiosInstance } from 'axios'
import { useQuery, useQueryClient } from 'react-query'
import {
  formatCurrency, READER_ORDER_STATUSES, READER_ORDER_STATUS_LABEL, READER_ORDER_COST_SOURCE_LABEL,
  readerCostTotal, type ReaderOrderStatus, type ReaderOrderCostSource,
} from '@gam/shared'

const money = (n: number | null | undefined) => (n == null ? '—' : formatCurrency(n))
const day = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString() : '')

/** A typed dollar figure: '' is blank, anything else must be a number ≥ 0. */
const amount = (s: string | undefined): number | null | 'bad' => {
  const t = (s ?? '').replace(/[$,\s]/g, '')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 'bad'
}

interface CostDraft { base: string; split: boolean; tax: string; shipping: string; together: string; note: string }
/** What the typed figures come to, or why they cannot be saved. */
type Typed = { body: any; total: number } | { error: string } | null

function draftFrom(o: any): CostDraft {
  const s = (n: number | null | undefined) => (n == null ? '' : Number(n).toFixed(2))
  return {
    base: s(o.costBasePrice), split: o.costTaxAndShipping == null && (o.costTax != null || o.costShipping != null || o.costTotal == null),
    tax: s(o.costTax), shipping: s(o.costShipping), together: s(o.costTaxAndShipping), note: '',
  }
}

export function ReaderOrdersDesk({ api }: { api: AxiosInstance }) {
  const qc = useQueryClient()
  const { data: orders = [], isLoading } = useQuery<any[]>('admin-reader-orders',
    () => api.get('/admin/reader-orders').then(r => r.data.data))
  const [draft, setDraft] = React.useState<Record<string, any>>({})
  const [busy, setBusy] = React.useState<string | null>(null)
  const [msg, setMsg] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState<string | null>(null)
  const [cost, setCost] = React.useState<CostDraft | null>(null)
  const [costErr, setCostErr] = React.useState<string | null>(null)

  const save = async (o: any) => {
    const d = draft[o.id] || {}
    setBusy(o.id); setMsg(null)
    try {
      await api.patch(`/admin/reader-orders/${o.id}`, {
        status: d.status ?? o.status, stripeHardwareOrderId: d.stripeHardwareOrderId ?? o.stripeHardwareOrderId ?? null,
        serial: d.serial ?? o.serial ?? null, trackingUrl: d.trackingUrl ?? o.trackingUrl ?? null,
      })
      setDraft(prev => { const n = { ...prev }; delete n[o.id]; return n })
      qc.invalidateQueries('admin-reader-orders'); setMsg('Saved')
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Could not save') } finally { setBusy(null) }
  }
  const field = (o: any, k: string, placeholder: string) => (
    <input className="inp" style={{ width: '100%', fontSize: '.78rem' }} placeholder={placeholder}
      value={draft[o.id]?.[k] ?? o[k] ?? ''} onChange={e => setDraft(prev => ({ ...prev, [o.id]: { ...(prev[o.id] || {}), [k]: e.target.value } }))} />
  )

  const toggle = (o: any) => {
    setCostErr(null)
    if (open === o.id) { setOpen(null); setCost(null); return }
    setOpen(o.id); setCost(draftFrom(o))
  }

  const typed = (c: CostDraft | null): Typed => {
    if (!c) return null
    const base = amount(c.base)
    const tax = c.split ? amount(c.tax) : null
    const shipping = c.split ? amount(c.shipping) : null
    const together = c.split ? null : amount(c.together)
    if (base === 'bad' || tax === 'bad' || shipping === 'bad' || together === 'bad') return { error: 'Type each amount in dollars, like 299.00.' }
    if (base == null) return { error: 'Type the base price from the receipt.' }
    const body = { basePrice: base, tax, shipping, taxAndShipping: together, note: c.note.trim() || null }
    return { body, total: readerCostTotal(body) }
  }

  const saveCost = async (o: any) => {
    const t = typed(cost)
    if (!t || 'error' in t) { setCostErr(t && 'error' in t ? t.error : 'Nothing to save'); return }
    setBusy(o.id); setCostErr(null); setMsg(null)
    try {
      await api.post(`/admin/reader-orders/${o.id}/cost`, t.body)
      await qc.invalidateQueries('admin-reader-orders')
      setOpen(null); setCost(null); setMsg(`Saved GAM's cost for ${o.propertyName}`)
    } catch (e: any) { setCostErr(e?.response?.data?.error || 'Could not save the cost') } finally { setBusy(null) }
  }

  // Every order GAM has placed or will place (not the cancelled requests).
  const live = (orders as any[]).filter(o => o.status !== 'cancelled')
  const known = live.filter(o => o.costTotal != null)
  const sum = (xs: any[], k: string) => Math.round(xs.reduce((a, o) => a + Number(o[k] || 0) * 100, 0)) / 100
  const missing = live.filter(o => o.costTotal == null && o.status !== 'requested').length

  return (
    <div>
      <div className="ph"><div><h1 className="pt">Reader Orders</h1><p className="ps">Card readers landlords asked for — order in Stripe's shop, pre-registered to the location shown, shipped to the address shown — and what each one cost GAM</p></div></div>
      {msg && <div style={{ fontSize: '.8rem', color: 'var(--t2)', marginBottom: 8 }}>{msg}</div>}
      {/* 10/12 (review): the strip shows whenever an order is missing its cost,
          even when no order has one yet — the figures only once one does. */}
      {(known.length > 0 || missing > 0) && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: '.82rem' }}>
          {known.length > 0 && <>
            <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>Charged to landlords</div><div className="mono" style={{ fontWeight: 700 }}>{money(sum(known, 'charged'))}</div></div>
            <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>What the readers cost GAM</div><div className="mono" style={{ fontWeight: 700 }}>{money(sum(known, 'costTotal'))}</div></div>
            <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>Markup (GAM's earnings)</div><div className="mono" style={{ fontWeight: 700, color: sum(known, 'markup') < 0 ? 'var(--red)' : 'var(--green)' }}>{money(sum(known, 'markup'))}</div></div>
            <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>Markup booked so far</div><div className="mono" style={{ fontWeight: 700 }}>{money(sum(known, 'markupBooked'))}</div></div>
          </>}
          {missing > 0 && <div style={{ color: 'var(--amber)', alignSelf: 'center' }}>{missing} order{missing === 1 ? '' : 's'} with no cost entered — open the order and type the receipt</div>}
        </div>
      )}
      {isLoading ? <div style={{ color: 'var(--t3)' }}>Loading…</div> : (orders as any[]).length === 0 ? (
        <div className="card" style={{ padding: 24, color: 'var(--t3)' }}>No reader requests yet.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 1250 }}>
            <thead><tr><th>Requested</th><th>Landlord · property</th><th>Ship to</th><th>Stripe location</th><th>Plan</th><th>Charged · cost · markup</th><th>Status</th><th>Stripe order</th><th>Serial</th><th>Tracking</th><th></th></tr></thead>
            <tbody>
              {(orders as any[]).map(o => (
                <React.Fragment key={o.id}>
                  <tr>
                    <td style={{ fontSize: '.78rem', whiteSpace: 'nowrap' }}>{day(o.createdAt)}</td>
                    <td style={{ fontSize: '.82rem' }}><div style={{ fontWeight: 600 }}>{o.businessName || o.landlordEmail}</div><div style={{ color: 'var(--t3)', fontSize: '.74rem' }}>{o.propertyName}</div></td>
                    <td style={{ fontSize: '.74rem', color: 'var(--t2)' }}>{o.shipName}{o.shipCompany ? ` · ${o.shipCompany}` : ''}<br />{o.shipLine1}{o.shipLine2 ? `, ${o.shipLine2}` : ''}<br />{o.shipCity}, {o.shipState} {o.shipZip}{o.shipPhone ? <><br />{o.shipPhone}</> : null}</td>
                    <td className="mono" style={{ fontSize: '.72rem', color: o.stripeTerminalLocationId ? 'var(--t2)' : 'var(--red)' }}>{o.stripeTerminalLocationId || 'no location — open the property'}</td>
                    <td style={{ fontSize: '.78rem', whiteSpace: 'nowrap' }}>{money(Number(o.price))} · {o.installments} × {money(Number(o.installmentAmount))}<br /><span style={{ color: 'var(--t3)' }}>{o.installmentsRaised} of {o.installments} billed</span></td>
                    <td style={{ fontSize: '.78rem', whiteSpace: 'nowrap' }}>
                      <div>Charged <span className="mono">{money(o.charged)}</span></div>
                      {o.costTotal == null
                        ? <div style={{ color: o.status === 'requested' || o.status === 'cancelled' ? 'var(--t3)' : 'var(--amber)' }}>GAM's cost not entered</div>
                        : <>
                            <div>GAM's cost <span className="mono">{money(o.costTotal)}</span></div>
                            <div>Markup <span className="mono" style={{ color: o.markup < 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{money(o.markup)}</span></div>
                          </>}
                      <button className={`btn ${open === o.id ? 'btn-ghost' : 'btn-primary'} btn-sm`} style={{ marginTop: 4 }} onClick={() => toggle(o)}>{open === o.id ? 'Close' : o.costTotal == null ? 'Enter cost' : 'Cost details'}</button>
                    </td>
                    <td>
                      <select className="inp" style={{ fontSize: '.78rem' }} value={draft[o.id]?.status ?? o.status}
                        onChange={e => setDraft(prev => ({ ...prev, [o.id]: { ...(prev[o.id] || {}), status: e.target.value } }))}>
                        {READER_ORDER_STATUSES.map(st => <option key={st} value={st}>{READER_ORDER_STATUS_LABEL[st as ReaderOrderStatus]}</option>)}
                      </select>
                    </td>
                    <td style={{ minWidth: 150 }}>{field(o, 'stripeHardwareOrderId', 'thor_…')}</td>
                    <td style={{ minWidth: 140 }}>{field(o, 'serial', 'serial number')}</td>
                    <td style={{ minWidth: 160 }}>{field(o, 'trackingUrl', 'tracking link')}</td>
                    <td><button className="btn btn-primary btn-sm" disabled={busy === o.id} onClick={() => save(o)}>{busy === o.id ? '…' : 'Save'}</button></td>
                  </tr>
                  {open === o.id && cost && (
                    <tr>
                      <td colSpan={11} style={{ background: 'var(--bg2, rgba(255,255,255,.02))' }}>
                        <CostPanel o={o} cost={cost} setCost={setCost} err={costErr} busy={busy === o.id}
                          preview={typed(cost)} onSave={() => saveCost(o)} onCancel={() => toggle(o)} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function CostPanel({ o, cost, setCost, err, busy, preview, onSave, onCancel }: {
  o: any; cost: CostDraft; setCost: (c: CostDraft) => void; err: string | null; busy: boolean
  preview: Typed; onSave: () => void; onCancel: () => void
}) {
  const set = (k: keyof CostDraft, v: any) => setCost({ ...cost, [k]: v })
  const box = (k: keyof CostDraft, label: string) => (
    <label style={{ display: 'block', fontSize: '.74rem', color: 'var(--t3)', marginBottom: 8 }}>{label}
      <input className="inp mono" style={{ width: '100%', fontSize: '.82rem', marginTop: 2 }} inputMode="decimal" placeholder="0.00"
        value={cost[k] as string} onChange={e => set(k, e.target.value)} />
    </label>
  )
  const total = preview && !('error' in preview) ? preview.total : null
  const changesTotal = o.costLocked && total != null && Math.round(total * 100) !== Math.round(Number(o.costTotal) * 100)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) 1fr', gap: 24, padding: '8px 4px' }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: '.86rem', marginBottom: 6 }}>What this reader cost GAM</div>
        {/* 10/12 (review): fixed once markup figured from it is booked as GAM's earnings, not the day it shipped. */}
        {o.costLocked && <div style={{ fontSize: '.74rem', color: 'var(--amber)', marginBottom: 8 }}>
          Its markup is already booked as GAM's earnings — the total is fixed at {money(o.costTotal)}. You can still split it into tax and shipping, but not change it.
        </div>}
        {box('base', 'Base price')}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '.76rem', color: 'var(--t2)', marginBottom: 8 }}>
          <input type="checkbox" checked={cost.split} onChange={e => set('split', e.target.checked)} />
          The receipt lists tax and shipping separately
        </label>
        {cost.split ? <>{box('tax', 'Tax')}{box('shipping', 'Shipping')}</> : box('together', 'Tax and shipping (together)')}
        <label style={{ display: 'block', fontSize: '.74rem', color: 'var(--t3)', marginBottom: 8 }}>Note (optional)
          <input className="inp" style={{ width: '100%', fontSize: '.82rem', marginTop: 2 }} placeholder="e.g. Stripe shop order thor_…"
            value={cost.note} onChange={e => set('note', e.target.value)} />
        </label>
        <div style={{ fontSize: '.8rem', marginBottom: 8 }}>
          {total != null
            ? <>Total cost <strong className="mono">{money(total)}</strong> · markup <strong className="mono" style={{ color: Number(o.charged) - total < 0 ? 'var(--red)' : 'var(--green)' }}>{money(Math.round((Number(o.charged) - total) * 100) / 100)}</strong> on {money(o.charged)} charged</>
            : <span style={{ color: 'var(--t3)' }}>Type the receipt to see the markup</span>}
          {changesTotal && <div style={{ color: 'var(--amber)', fontSize: '.74rem' }}>That comes to a different total — it will be refused.</div>}
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: '.76rem', marginBottom: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={onSave}>{busy ? '…' : 'Save cost'}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '.86rem', marginBottom: 6 }}>The plan, cost first</div>
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginBottom: 6 }}>
          The payments repay what the reader cost GAM first; the markup is in the last payment(s) and is the only part booked as GAM's earnings.
          {o.costTotal == null && ' Until the cost is entered, every dollar counts as cost.'}
        </div>
        <table className="tbl" style={{ fontSize: '.76rem', marginBottom: 12 }}>
          <thead><tr><th>Payment</th><th>Amount</th><th>GAM's cost</th><th>Markup</th><th>Billed</th><th>Collected</th><th>Markup booked</th></tr></thead>
          <tbody>
            {(o.pieces || []).map((p: any) => (
              <tr key={p.n}>
                <td>{p.n} of {o.installments}</td>
                <td className="mono">{money(p.amount)}</td>
                <td className="mono">{money(p.cost)}</td>
                <td className="mono" style={{ color: p.markup > 0 ? 'var(--green)' : 'var(--t3)' }}>{money(p.markup)}</td>
                <td>{p.voided ? 'Voided' : p.billed ? day(p.billedAt) : <span style={{ color: 'var(--t3)' }}>Not yet</span>}</td>
                <td className="mono">{p.billed ? money(p.collected) : '—'}</td>
                <td className="mono">{p.markupBooked ? money(p.markupBooked) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(o.costHistory || []).length > 0 && <>
          <div style={{ fontWeight: 700, fontSize: '.86rem', marginBottom: 6 }}>Every cost entry</div>
          <table className="tbl" style={{ fontSize: '.74rem' }}>
            <thead><tr><th>When</th><th>By</th><th>Base</th><th>Tax</th><th>Shipping</th><th>Tax + shipping</th><th>Total</th><th>Note</th></tr></thead>
            <tbody>
              {(o.costHistory as any[]).map((h: any, i: number) => (
                <tr key={h.id} style={{ opacity: i === 0 ? 1 : 0.7 }}>
                  <td style={{ whiteSpace: 'nowrap' }}>{day(h.enteredAt)}{i === 0 && <span style={{ color: 'var(--gold)', marginLeft: 6 }}>current</span>}</td>
                  <td>{h.enteredBy || h.enteredByEmail || READER_ORDER_COST_SOURCE_LABEL[h.source as ReaderOrderCostSource] || '—'}</td>
                  <td className="mono">{money(h.basePrice)}</td>
                  <td className="mono">{money(h.tax)}</td>
                  <td className="mono">{money(h.shipping)}</td>
                  <td className="mono">{money(h.taxAndShipping)}</td>
                  <td className="mono" style={{ fontWeight: 600 }}>{money(h.total)}</td>
                  <td style={{ color: 'var(--t2)' }}>{h.note || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>}
      </div>
    </div>
  )
}
