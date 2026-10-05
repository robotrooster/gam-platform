/**
 * S654 (Nic): "it'd be nice if they were all clickable so that the front desk
 * could really see… what the electric is, any late fees… right now on the
 * landlord side it just shows the total. If late fees weren't being correctly
 * applied, the landlord would have no way to see that."
 *
 * The three line-item views that the Outstanding Balances page has had since
 * S634/S649/S652, pulled out so the Front Desk can open the same breakdown
 * under a name. One place to render a balance's lines, however it is owed:
 *   - InvoiceBreakdown  — a resident's open invoices, every line labelled
 *   - PayLinkBreakdown  — an emailed pay link's items (adjust / send again)
 *   - TicketBreakdown   — a register ticket somebody walked away from
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'

export const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export type BreakdownTicket = { note: string | null; items: Array<{ name: string; qty: number; price: number }> } | null | undefined
export type BreakdownPayLink = { label: string; items: Array<{ name: string; qty: number; price: number }> } | null | undefined

export function TicketBreakdown({ ticket }: { ticket?: BreakdownTicket }) {
  return (
    <div style={{ padding: '10px 16px 14px 32px' }}>
      {ticket?.note && <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginBottom: 6 }}>{ticket.note}</div>}
      {(ticket?.items || []).map((it, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.8rem', maxWidth: 420 }}>
          <span>{it.name}{Number(it.qty) !== 1 ? ` × ${it.qty}` : ''}</span>
          <span className="mono">{fmtMoney(Number(it.price) * Number(it.qty))}</span>
        </div>
      ))}
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 8 }}>
        Settle it at the register: open the register, tap &ldquo;open tickets &amp; pay links&rdquo;, pick this one, take the payment.
      </div>
    </div>
  )
}

// S649: what an open pay link is for, with the two ways to chase it.
// S652 (Nic): "if we need to do last minute prorations or adjustments, the
// functionality of the front counter person needs to be there." Adjust changes
// the lines on the open link — a final electric read, a correction — and the
// person sees the new total at the same address.
//
// 10/3 (decisions #9, #23): a link for a RESERVATION (it carries a booking) is
// charged what the reservation owes for it now — the schedule may have
// repriced it, moved it, or taken a payment toward it since the link went out.
// So what it charges is read fresh from the register's own reading of it
// (GET /pos/tickets/:id?kind=pay_link) the moment the breakdown opens, never
// summed from the lines stored when it was sent. A reservation's nights, site
// and price change ONLY on the schedule (decisions #23, which replaced the
// shorten-the-stay control this screen had): its line here is read-only, and
// Adjust changes only the link's OTHER lines, if it has any — the
// reservation's own lines go back exactly as the link stores them.
type LinkLine = { id?: string | null; cat?: string; name: string; qty: number; price: number; tax?: number }
const lineId = (l: any) => (typeof l?.id === 'string' ? l.id.trim().toLowerCase() : '')
/** A stored line as the link's own routes take it back: no nulls where a value is optional. */
const asLine = (l: any): LinkLine => ({
  id: typeof l?.id === 'string' && l.id ? l.id : null, name: String(l?.name ?? ''),
  qty: Number(l?.qty) || 0, price: Number(l?.price) || 0, tax: Number(l?.tax) || 0,
  ...(typeof l?.cat === 'string' && l.cat ? { cat: l.cat } : {}),
})
const SCHEDULE_WORDS = 'To change the nights, change the reservation on the schedule — this link then charges what it owes.'

export function PayLinkBreakdown({ id, link, propertyId: propertyIdProp }: { id: string; link?: BreakdownPayLink; propertyId?: string | null }) {
  const qc = useQueryClient()
  // The link's property: the caller's, else the balances row the link came
  // from (both screens that show this read the same 'outstanding-balances'
  // list). A register call names its property — that is how an account with
  // two companies says which register it means.
  const propertyId = propertyIdProp
    ?? ((qc.getQueryData<any[]>('outstanding-balances') || []).find((r: any) => r?.payLinkId === id)?.propertyId ?? null)
  const live = useQuery<any, any>(['pay-link-live', id, propertyId],
    () => apiGet(`/pos/tickets/${id}?kind=pay_link${propertyId ? `&propertyId=${propertyId}` : ''}`),
    { retry: false, refetchOnWindowFocus: true })
  const [msg, setMsg] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  // The lines being adjusted — on a reservation link, only its other lines.
  const [lines, setLines] = useState<LinkLine[]>([])
  // A reservation link being adjusted: the reservation's own lines exactly as
  // the link stores them, sent back untouched.
  const [kept, setKept] = useState<LinkLine[]>([])
  const [saving, setSaving] = useState(false)

  const liveItems: any[] | null = live.data ? (live.data.items || []) : null
  // The reservation's line as the register reads it (at what it owes now), and
  // the link's other lines.
  const reservationItems = (liveItems || []).filter((i: any) => i?.reservation)
  const otherItems = (liveItems || []).filter((i: any) => !i?.reservation)
  const holdsReservation = reservationItems.length > 0
  const reservationOwes = reservationItems.reduce((t: number, i: any) => t + (Number(i.qty) || 0) * (Number(i.price) || 0), 0)
  // Which stored lines are the reservation's: its stay line (by the stay's
  // item), or — a link for a deposit or balance, with no stay — its typed lines.
  const stayId = lineId(reservationItems.find((i: any) => lineId(i)))
  const isReservationLine = (l: any) => (stayId ? lineId(l) === stayId : !lineId(l))
  const forbidden = live.error?.response?.status === 403
  const errorWords = live.error && !forbidden
    ? (live.error?.response?.data?.error || live.error?.message || 'This link could not be read just now — open it again in a moment.')
    : null
  // Nothing to adjust on a link that is only its reservation.
  // Adjust and Send again use the register's own routes — without the register
  // permission (forbidden) neither would work, so neither is offered.
  const canAdjust = !errorWords && !forbidden && !live.isLoading && (!holdsReservation || otherItems.length > 0)

  const resend = async () => {
    try { await apiPost(`/pos/pay-links/${id}/resend`, {}); setMsg('Sent again.') }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Could not send it again.') }
  }
  const refresh = () => {
    qc.invalidateQueries('outstanding-balances')
    qc.invalidateQueries(['pay-link-live', id])
  }

  // The link exactly as it is stored now — read fresh at the moment of action.
  const storedLink = async (): Promise<any> => {
    if (!propertyId) throw new Error('This link’s property could not be found — open the list again, then press Adjust.')
    const rows = await apiGet<any[]>(`/pos/pay-links?propertyId=${propertyId}`)
    const row = (rows || []).find((r: any) => r?.id === id)
    if (!row || row.status !== 'open') throw new Error('That pay link was already paid or closed — open the list again to see what is still out.')
    return row
  }

  const startEdit = async () => {
    setMsg(null)
    if (holdsReservation) {
      try {
        const row = await storedLink()
        const items: any[] = Array.isArray(row.items) ? row.items : []
        const own = items.filter(isReservationLine)
        if (!own.length) throw new Error('This link’s reservation could not be found on it — open the list again, then press Adjust.')
        setKept(own.map(asLine))
        setLines(items.filter(l => !isReservationLine(l)).map(asLine))
        setEditing(true)
      } catch (e: any) {
        setMsg(e?.response?.data?.error || e?.message || 'Could not open this link to adjust — open the list again.')
      }
      return
    }
    setKept([])
    setLines(((liveItems ?? link?.items ?? []) as any[]).map(asLine))
    setEditing(true)
  }
  const cancelEdit = () => { setEditing(false); setKept([]); setMsg(null) }

  const linesTotal = lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.price) || 0), 0)
  const total = (kept.length ? reservationOwes : 0) + linesTotal
  const save = async () => {
    const clean = lines.filter(l => l.name.trim() && Number(l.qty) > 0)
      .map(l => ({ ...l, name: l.name.trim(), qty: Number(l.qty), price: Number(l.price) || 0, tax: Number(l.tax) || 0 }))
    if (!kept.length && !clean.length) { setMsg('Keep at least one line.'); return }
    setSaving(true)
    try {
      await apiPatch(`/pos/pay-links/${id}`, { items: [...kept, ...clean] })
      setEditing(false); setKept([]); setMsg('Updated — the same link now shows the new total.')
      refresh()
    } catch (e: any) { setMsg(e?.response?.data?.error || e?.message || 'Could not update the link.') }
    finally { setSaving(false) }
  }
  const setLine = (i: number, patch: Partial<LinkLine>) => setLines(ls => ls.map((l, idx) => idx === i ? { ...l, ...patch } : l))

  // What the link charges now: the register's fresh reading of it. Without the
  // register permission (or before it loads) the lines as sent are all there is.
  const shownItems: any[] = liveItems ?? (forbidden ? (link?.items || []) : [])
  const reservationRow = (it: any, i: number) => (
    <div key={`r${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '.8rem', maxWidth: 520 }}>
      <span>
        {it.name}{Number(it.qty) !== 1 ? ` × ${it.qty}` : ''}
        <span style={{ marginLeft: 6, fontSize: '.68rem', color: 'var(--text-3)' }}>· the reservation, at what it owes now</span>
      </span>
      <span className="mono">{fmtMoney(Number(it.price) * Number(it.qty))}</span>
    </div>
  )

  return (
    <div style={{ padding: '10px 16px 14px 32px' }}>
      <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginBottom: 6 }}>{live.data?.label ?? link?.label}</div>
      {live.isLoading && !editing && (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Reading what this link charges now…</div>
      )}
      {errorWords && !editing && (
        <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 6 }}>{errorWords}</div>
      )}
      {!editing ? (
        <>
          {shownItems.map((it: any, i: number) => it?.reservation ? reservationRow(it, i) : (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '.8rem', maxWidth: 520 }}>
              <span>{it.name}{Number(it.qty) !== 1 ? ` × ${it.qty}` : ''}</span>
              <span className="mono">{fmtMoney(Number(it.price) * Number(it.qty))}</span>
            </div>
          ))}
          {live.data && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.82rem', fontWeight: 700, maxWidth: 520,
                          borderTop: '1px solid var(--border-1)', marginTop: 4, paddingTop: 4 }}>
              <span>Charges now</span><span className="mono" style={{ color: 'var(--gold)' }}>{fmtMoney(Number(live.data.total) || 0)}</span>
            </div>
          )}
          {forbidden && (
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>
              These are the lines it was sent with. What it charges now shows at the register — someone with register access can adjust it or send it again.
            </div>
          )}
        </>
      ) : (
        <div style={{ display: 'grid', gap: 6, maxWidth: 560 }}>
          {kept.length > 0 && reservationItems.map(reservationRow)}
          {lines.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px 90px 28px', gap: 6, alignItems: 'center' }}>
              <input className="input" value={l.name} onChange={e => setLine(i, { name: e.target.value })} placeholder="What it is" style={{ fontSize: '.8rem' }} />
              <input className="input mono" type="number" step="any" min={0} value={l.qty} onChange={e => setLine(i, { qty: Number(e.target.value) })} placeholder="qty" style={{ fontSize: '.8rem' }} />
              <input className="input mono" type="number" step="0.01" min={0} value={l.price} onChange={e => setLine(i, { price: Number(e.target.value) })} placeholder="each" style={{ fontSize: '.8rem' }} />
              <span className="mono" style={{ fontSize: '.8rem', textAlign: 'right' }}>{fmtMoney((Number(l.qty) || 0) * (Number(l.price) || 0))}</span>
              <button type="button" className="btn btn-ghost btn-sm" title="Remove this line" style={{ padding: '1px 6px' }} onClick={() => setLines(ls => ls.filter((_, idx) => idx !== i))}>✕</button>
            </div>
          ))}
          {!kept.length && (
            <div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setLines(ls => [...ls, { id: null, name: '', qty: 1, price: 0, tax: 0 }])}>+ Add a line</button>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.85rem', fontWeight: 700, borderTop: '1px solid var(--border-1)', paddingTop: 6 }}>
            <span>New total</span><span className="mono" style={{ color: 'var(--gold)' }}>{fmtMoney(total)}</span>
          </div>
        </div>
      )}
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '6px 0 10px' }}>
        {holdsReservation ? `${SCHEDULE_WORDS} ` : ''}
        Card fee is added when they pay by card. They can also settle it at the register from its open list.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {editing ? (
          <>
            <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
            <button className="btn btn-ghost btn-sm" disabled={saving} onClick={cancelEdit}>Cancel</button>
          </>
        ) : (
          <>
            {canAdjust && (
              <button className="btn btn-primary btn-sm" onClick={() => void startEdit()}>
                {holdsReservation ? 'Adjust the other lines' : 'Adjust'}
              </button>
            )}
            {!errorWords && !forbidden && <button className="btn btn-primary btn-sm" onClick={resend}>Send again</button>}
          </>
        )}
        {msg && <span style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>{msg}</span>}
      </div>
    </div>
  )
}

const LINE_LABEL: Record<string, string> = {
  rent: 'Rent', utility: 'Utility', fee: 'Fee', deposit: 'Deposit',
  late_fee: 'Late fee', subscription: 'Subscription', home_payment: 'Home payment',
  carried_balance: 'Carried balance',
}

/** Every open invoice for one resident, every line labelled — rent, each
 *  utility with its meter note, fees, late fees — so a total is never a mystery. */
export function InvoiceBreakdown({ tenantId }: { tenantId: string }) {
  const { data: invoices = [], isLoading } = useQuery<any[]>(
    ['balance-invoices', tenantId], () => apiGet(`/balances/${tenantId}/invoices`))

  if (isLoading) return <div style={{ padding: '10px 14px', fontSize: '.78rem', color: 'var(--text-3)' }}>Loading invoices…</div>
  if (!invoices.length) return <div style={{ padding: '10px 14px', fontSize: '.78rem', color: 'var(--text-3)' }}>No open invoices.</div>

  return (
    <div style={{ padding: '4px 14px 14px', display: 'grid', gap: 12 }}>
      {invoices.map((inv: any) => (
        <div key={inv.id} style={{ border: '1px solid var(--border-1, rgba(255,255,255,.08))', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                        padding: '8px 12px', background: 'rgba(255,255,255,.02)', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: '.8rem', fontWeight: 700, color: 'var(--text-0)' }}>
              {inv.invoiceNumber}
              <span style={{ fontWeight: 400, color: 'var(--text-3)', marginLeft: 8 }}>
                due {new Date(String(inv.dueDate).slice(0, 10) + 'T00:00:00').toLocaleDateString()}
              </span>
            </div>
            <div style={{ fontSize: '.8rem', color: 'var(--gold)', fontWeight: 700 }}>
              {fmtMoney(Number(inv.balance))} owed
              {Number(inv.amountPaid) > 0 && (
                <span style={{ color: 'var(--text-3)', fontWeight: 400, marginLeft: 8 }}>
                  ({fmtMoney(Number(inv.amountPaid))} paid of {fmtMoney(Number(inv.totalAmount))})
                </span>
              )}
            </div>
          </div>
          <table className="data-table" style={{ width: '100%' }}>
            <tbody>
              {(inv.lines || []).map((l: any) => (
                <tr key={l.id}>
                  <td style={{ fontSize: '.78rem', width: 110, color: 'var(--text-2)' }}>
                    {LINE_LABEL[l.type] || l.type}
                  </td>
                  <td style={{ fontSize: '.78rem' }}>
                    {l.notes || l.entryDescription || '—'}
                    {l.status && l.status !== 'pending' && (
                      <span style={{ marginLeft: 8, fontSize: '.68rem', color: 'var(--text-3)' }}>· {l.status}</span>
                    )}
                  </td>
                  <td style={{ fontSize: '.78rem', textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {fmtMoney(Number(l.amount))}
                  </td>
                </tr>
              ))}
              {(inv.lines || []).length === 0 && (
                <tr><td colSpan={3} style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                  No line detail on this invoice.
                </td></tr>
              )}
              {Number(inv.workTradeCreditAmount) > 0 && (
                <tr>
                  <td style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>Work trade</td>
                  <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Credit applied against rent</td>
                  <td style={{ fontSize: '.78rem', textAlign: 'right', fontWeight: 600, color: 'var(--green, #22c55e)' }}>
                    −{fmtMoney(Number(inv.workTradeCreditAmount))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
