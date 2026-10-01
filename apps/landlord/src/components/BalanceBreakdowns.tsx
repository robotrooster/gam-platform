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
// the lines on the open link — a final electric read, the extra days somebody
// stayed — and the person sees the new total at the same address.
type LinkLine = { id?: string | null; cat?: string; name: string; qty: number; price: number; tax?: number }
export function PayLinkBreakdown({ id, link }: { id: string; link?: BreakdownPayLink }) {
  const qc = useQueryClient()
  const [msg, setMsg] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [lines, setLines] = useState<LinkLine[]>([])
  const [saving, setSaving] = useState(false)
  const resend = async () => {
    try { await apiPost(`/pos/pay-links/${id}/resend`, {}); setMsg('Sent again.') }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Could not send it again.') }
  }
  const startEdit = () => {
    setLines(((link?.items || []) as any[]).map(it => ({ ...it, qty: Number(it.qty), price: Number(it.price) })))
    setEditing(true); setMsg(null)
  }
  const total = lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.price) || 0), 0)
  const save = async () => {
    const clean = lines.filter(l => l.name.trim() && Number(l.qty) > 0)
    if (!clean.length) { setMsg('Keep at least one line.'); return }
    setSaving(true)
    try {
      await apiPatch(`/pos/pay-links/${id}`, { items: clean.map(l => ({ ...l, name: l.name.trim(), qty: Number(l.qty), price: Number(l.price) || 0, tax: Number(l.tax) || 0 })) })
      setEditing(false); setMsg('Updated — the same link now shows the new total.')
      qc.invalidateQueries('outstanding-balances')
    } catch (e: any) { setMsg(e?.response?.data?.error || e?.message || 'Could not update the link.') }
    finally { setSaving(false) }
  }
  const setLine = (i: number, patch: Partial<LinkLine>) => setLines(ls => ls.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  return (
    <div style={{ padding: '10px 16px 14px 32px' }}>
      <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginBottom: 6 }}>{link?.label}</div>
      {!editing ? (link?.items || []).map((it, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.8rem', maxWidth: 420 }}>
          <span>{it.name}{Number(it.qty) !== 1 ? ` × ${it.qty}` : ''}</span>
          <span className="mono">{fmtMoney(Number(it.price) * Number(it.qty))}</span>
        </div>
      )) : (
        <div style={{ display: 'grid', gap: 6, maxWidth: 560 }}>
          {lines.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px 90px 28px', gap: 6, alignItems: 'center' }}>
              <input className="input" value={l.name} onChange={e => setLine(i, { name: e.target.value })} placeholder="What it is" style={{ fontSize: '.8rem' }} />
              <input className="input mono" type="number" step="any" value={l.qty} onChange={e => setLine(i, { qty: Number(e.target.value) })} placeholder="qty" style={{ fontSize: '.8rem' }} />
              <input className="input mono" type="number" step="0.01" value={l.price} onChange={e => setLine(i, { price: Number(e.target.value) })} placeholder="each" style={{ fontSize: '.8rem' }} />
              <span className="mono" style={{ fontSize: '.8rem', textAlign: 'right' }}>{fmtMoney((Number(l.qty) || 0) * (Number(l.price) || 0))}</span>
              <button type="button" className="btn btn-ghost btn-sm" title="Remove this line" style={{ padding: '1px 6px' }} onClick={() => setLines(ls => ls.filter((_, idx) => idx !== i))}>✕</button>
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setLines(ls => [...ls, { id: null, name: '', qty: 1, price: 0, tax: 0 }])}>+ Add a line</button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.85rem', fontWeight: 700, borderTop: '1px solid var(--border-1)', paddingTop: 6 }}>
            <span>New total</span><span className="mono" style={{ color: 'var(--gold)' }}>{fmtMoney(total)}</span>
          </div>
        </div>
      )}
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '6px 0 10px' }}>Card fee is added when they pay by card. They can also settle it at the register from its open list.</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {editing ? (
          <>
            <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
            <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn btn-primary btn-sm" onClick={startEdit}>Adjust</button>
            <button className="btn btn-primary btn-sm" onClick={resend}>Send again</button>
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
