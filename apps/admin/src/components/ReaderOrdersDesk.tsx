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
 * The cost is typed here from the shop receipt and every entry is kept.
 * "COST FIRST": the plan's pieces repay GAM's cost first and the markup lands
 * in the last piece(s) — each piece's split is shown, with what has been
 * billed, collected, and booked as GAM's earnings.
 *
 * 10/13 (Nic): "record each reader as a GAM expense (loss if cost > charge);
 * allow dated cost corrections; flag missing cost in the morning admin email."
 * The cost is GAM's expense on the day GAM bought the reader, shown here with
 * its date; a reader that cost more than the landlord is charged shows as a
 * LOSS. A correction (a refund, extra shipping) is a new entry dated the day it
 * applies from; the old figure stays on record, and each payment carries the
 * markup under the figure in force the day it was billed. Every row GAM's book
 * holds for the reader is listed. A loss, and what a correction changes in a
 * payment already billed, are shown as NOT IN GAM'S BOOK: how a reader's
 * expense goes into GAM's book is an open question to Nic, so neither is
 * booked yet.
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
/** A signed amount: "+$5.00" / "−$5.00". */
const signed = (n: number) => (Math.abs(n) < 0.005 ? money(0) : n > 0 ? `+${money(n)}` : `−${money(-n)}`)
/** 10/13: GAM's calendar (Arizona), as 'YYYY-MM-DD' — the server's dates are on it too. */
const gamDay = (d: Date | string = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' })
/** A 'YYYY-MM-DD' calendar day, shown as the browser shows dates — no clock involved. */
const calDay = (ymd: string | null | undefined) => {
  if (!ymd) return ''
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString()
}

/** A typed dollar figure: '' is blank, anything else must be a number ≥ 0. */
const amount = (s: string | undefined): number | null | 'bad' => {
  const t = (s ?? '').replace(/[$,\s]/g, '')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 'bad'
}

interface CostDraft { base: string; split: boolean; tax: string; shipping: string; together: string; note: string; on: string }
/** What the typed figures come to, or why they cannot be saved. */
type Typed = { body: any; total: number } | { error: string } | null

function draftFrom(o: any): CostDraft {
  const s = (n: number | null | undefined) => (n == null ? '' : Number(n).toFixed(2))
  return {
    base: s(o.costBasePrice), split: o.costTaxAndShipping == null && (o.costTax != null || o.costShipping != null || o.costTotal == null),
    tax: s(o.costTax), shipping: s(o.costShipping), together: s(o.costTaxAndShipping), note: '',
    // 10/13: the first figure is dated the day GAM bought the reader (ordered
    // from Stripe); a correction, the day it applies from — today unless changed.
    on: o.costTotal == null && o.orderedAt ? gamDay(o.orderedAt) : gamDay(),
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.on)) return { error: 'Pick the date it applies from.' }
    const body = { basePrice: base, tax, shipping, taxAndShipping: together, note: c.note.trim() || null, effectiveOn: c.on }
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

  // 10/13 (review): every reader GAM bought — a cancelled one too, once GAM
  // ordered it — so the expense and GAM's book here match the ledger and the
  // morning email (services/readerOrders READER_BOUGHT_SQL).
  const all = orders as any[]
  const bought = (o: any) => ['ordered', 'shipped', 'delivered', 'registered'].includes(o.status)
    || (o.status === 'cancelled' && !!(o.orderedAt || o.shippedAt || o.deliveredAt || o.registeredAt))
  const known = all.filter(o => o.costTotal != null)
  // The plan figures (charged, markup, loss) are for plans still running or paid off.
  const plans = known.filter(o => o.status !== 'cancelled')
  const cancelledKnown = known.filter(o => o.status === 'cancelled')
  const sum = (xs: any[], k: string) => Math.round(xs.reduce((a, o) => a + Number(o[k] || 0) * 100, 0)) / 100
  const missing = all.filter(o => o.costTotal == null && bought(o)).length
  // 10/13: markup and losses apart — a loss never hides inside a markup total.
  const markups = Math.round(plans.reduce((a, o) => a + Math.max(0, Number(o.markup || 0)) * 100, 0)) / 100
  const losses = Math.round(plans.reduce((a, o) => a + Number(o.loss || 0) * 100, 0)) / 100
  const notBooked = sum(known, 'notBooked')

  return (
    <div>
      <div className="ph"><div><h1 className="pt">Reader Orders</h1><p className="ps">Card readers landlords asked for — order in Stripe's shop, pre-registered to the location shown, shipped to the address shown — and what each one cost GAM</p></div></div>
      {msg && <div style={{ fontSize: '.8rem', color: 'var(--t2)', marginBottom: 8 }}>{msg}</div>}
      {/* 10/12 (review): the strip shows whenever an order is missing its cost,
          even when no order has one yet — the figures only once one does. */}
      {(known.length > 0 || missing > 0) && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: '.82rem' }}>
          {known.length > 0 && <>
            <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>Charged to landlords</div><div className="mono" style={{ fontWeight: 700 }}>{money(sum(plans, 'charged'))}</div></div>
            <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>What the readers cost GAM (GAM's expense)</div><div className="mono" style={{ fontWeight: 700 }}>{money(sum(known, 'costTotal'))}</div></div>
            <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>Repaid by landlords so far</div><div className="mono" style={{ fontWeight: 700 }}>{money(sum(known, 'costRecovered'))}</div></div>
            <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>Markup (GAM's earnings)</div><div className="mono" style={{ fontWeight: 700, color: 'var(--green)' }}>{money(markups)}</div></div>
            {losses > 0 && <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>Losses (cost more than charged)</div><div className="mono" style={{ fontWeight: 700, color: 'var(--red)' }}>−{money(losses)}</div></div>}
            <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>In GAM's book so far</div><div className="mono" style={{ fontWeight: 700 }}>{money(sum(known, 'bookedTotal'))}</div></div>
            {Math.abs(notBooked) >= 0.005 && <div><div style={{ color: 'var(--t3)', fontSize: '.72rem' }}>Not in GAM's book (losses, corrections)</div><div className="mono" style={{ fontWeight: 700, color: 'var(--amber)' }}>{signed(notBooked)}</div></div>}
          </>}
          {cancelledKnown.length > 0 && <div style={{ color: 'var(--t3)', alignSelf: 'center', fontSize: '.74rem' }}>
            GAM's expense, repaid and GAM's book include {cancelledKnown.length} reader{cancelledKnown.length === 1 ? '' : 's'} cancelled after GAM bought {cancelledKnown.length === 1 ? 'it' : 'them'} ({money(sum(cancelledKnown, 'billed'))} billed before cancelling); charged and markup are for the plans still running or paid off.
          </div>}
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
                            <div>GAM's cost <span className="mono">{money(o.costTotal)}</span>{o.costEffectiveOn && <span style={{ color: 'var(--t3)' }}> · {calDay(o.costEffectiveOn)}</span>}</div>
                            {/* 10/13 (Nic): "record each reader as a GAM expense (loss if cost > charge)". */}
                            {Number(o.loss || 0) > 0
                              ? <div style={{ color: 'var(--red)', fontWeight: 600 }}>Loss <span className="mono">−{money(o.loss)}</span></div>
                              : <div>Markup <span className="mono" style={{ color: 'var(--green)', fontWeight: 600 }}>{money(o.markup)}</span></div>}
                            {Math.abs(Number(o.notBooked || 0)) >= 0.005 && <div style={{ color: 'var(--amber)', fontSize: '.74rem' }}>Not in GAM's book <span className="mono">{signed(Number(o.notBooked))}</span></div>}
                          </>}
                      {/* A cancelled plan stops billing (raiseDueInstallments). */}
                      {o.status === 'cancelled' && Number(o.billed || 0) > 0 && <div style={{ color: 'var(--t3)', fontSize: '.74rem' }}>Cancelled — <span className="mono">{money(o.billed)}</span> billed; the rest is not billed</div>}
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
  const isCorrection = o.costTotal != null
  const isLoss = total != null && total - Number(o.charged) > 0.004
  const changesBilled = isCorrection && (o.pieces || []).some((p: any) => p.billed)
  // 10/13: what the reader comes to and is not in GAM's book (the server's
  // not_booked) — the loss, and the rest: what a correction changed in
  // payments already billed.
  const notBooked = Number(o.notBooked || 0)
  const loss = Number(o.loss || 0)
  const corrected = Math.round((notBooked + loss) * 100) / 100
  const earliest = (o.costHistory || [])[0]?.effectiveOn || gamDay(o.createdAt)
  const today = gamDay()
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) 1fr', gap: 24, padding: '8px 4px' }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: '.86rem', marginBottom: 6 }}>{isCorrection ? 'Correct what this reader cost GAM' : 'What this reader cost GAM'}</div>
        {/* 10/13 (Nic): "allow dated cost corrections" — the old figure stays on record, the new one applies from its date. */}
        {isCorrection && <div style={{ fontSize: '.74rem', color: 'var(--t2)', marginBottom: 8 }}>
          A correction (a refund, extra shipping) applies from the date you pick: {money(o.costTotal)} stays on record for the days before it, and a payment billed on or after it carries the markup under the new figure. Anything already in GAM's book stays as it was. Fixing a typo? Give it the date of the figure it fixes.
        </div>}
        <label style={{ display: 'block', fontSize: '.74rem', color: 'var(--t3)', marginBottom: 8 }}>{isCorrection ? 'Applies from' : 'Date GAM bought it'}
          <input type="date" className="inp mono" style={{ width: '100%', fontSize: '.82rem', marginTop: 2 }}
            min={earliest} max={today} value={cost.on} onChange={e => set('on', e.target.value)} />
        </label>
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
            ? (Number(o.charged) - total < 0
                ? <>Total cost <strong className="mono">{money(total)}</strong> · <strong style={{ color: 'var(--red)' }}>a loss of <span className="mono">{money(Math.round((total - Number(o.charged)) * 100) / 100)}</span></strong> on {money(o.charged)} charged</>
                : <>Total cost <strong className="mono">{money(total)}</strong> · markup <strong className="mono" style={{ color: 'var(--green)' }}>{money(Math.round((Number(o.charged) - total) * 100) / 100)}</strong> on {money(o.charged)} charged</>)
            : <span style={{ color: 'var(--t3)' }}>Type the receipt to see the markup</span>}
          {total != null && <div style={{ fontSize: '.74rem', color: 'var(--t3)' }}>
            {isLoss
              ? "A loss is shown here and on the desk, not booked in GAM's book."
              : "The markup is booked in GAM's book on the day each payment carrying it is billed."}
            {changesBilled && " What this changes in a payment already billed is shown, not booked."}
            {(isLoss || changesBilled) && " How a reader's expense, a loss and a correction go into GAM's book is still an open question."}
          </div>}
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
            <thead><tr><th>Applies from</th><th>Typed</th><th>By</th><th>Base</th><th>Tax</th><th>Shipping</th><th>Tax + shipping</th><th>Total</th><th>Note</th></tr></thead>
            <tbody>
              {(o.costHistory as any[]).map((h: any, i: number) => (
                <tr key={h.id} style={{ opacity: i === 0 ? 1 : 0.7 }}>
                  <td style={{ whiteSpace: 'nowrap' }}>{calDay(h.effectiveOn)}{i === 0 && <span style={{ color: 'var(--gold)', marginLeft: 6 }}>current</span>}</td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--t3)' }}>{day(h.enteredAt)}</td>
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
        {/* 10/13: the reader in GAM's own book — the markup its payments carry — and what is not in it. */}
        <div style={{ fontWeight: 700, fontSize: '.86rem', margin: '12px 0 6px' }}>In GAM's book</div>
        {(o.book || []).length === 0
          ? <div style={{ fontSize: '.74rem', color: 'var(--t3)' }}>Nothing yet — the markup is booked when the payment carrying it is billed{o.costTotal == null ? ', once the cost is entered' : ''}.</div>
          : <table className="tbl" style={{ fontSize: '.74rem' }}>
              <thead><tr><th>Date</th><th>What</th><th>Amount</th></tr></thead>
              <tbody>
                {(o.book as any[]).map((b: any) => (
                  <tr key={b.id} style={{ opacity: b.voided ? 0.6 : 1 }}>
                    <td style={{ whiteSpace: 'nowrap' }}>{day(b.at)}</td>
                    <td>Markup in payment {b.n} of {o.installments}{b.voided ? ' (payment voided — the markup is still in the book)' : ''}</td>
                    <td className="mono" style={{ color: b.amount < 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{signed(b.amount)}</td>
                  </tr>
                ))}
                <tr><td></td><td style={{ fontWeight: 600 }}>Holds now</td><td className="mono" style={{ fontWeight: 700 }}>{money(o.bookedTotal)}</td></tr>
              </tbody>
            </table>}
        {Math.abs(notBooked) >= 0.005 && <div style={{ fontSize: '.74rem', color: 'var(--amber)', marginTop: 6 }}>
          Not in GAM's book: <span className="mono">{signed(notBooked)}</span> — {[
            loss > 0 ? `the ${money(loss)} loss` : null,
            Math.abs(corrected) >= 0.005 ? `${signed(corrected)} a cost correction changed in payments already billed` : null,
          ].filter(Boolean).join(', and ')}. How a reader's expense, a loss and a correction go into GAM's book is still an open question, so none of it is booked yet.
        </div>}
      </div>
    </div>
  )
}
