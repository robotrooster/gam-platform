import { Fragment, useState } from 'react'
import { useQuery } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { PropertySelect } from '../components/ListControls'

// Front-desk "who owes" view. Read-only list of tenants with an unpaid balance
// + contact info, so a front-counter person knows who to call. Data from
// GET /balances (unpaid invoice balances, per the platform's outstanding def).
interface Owed {
  tenantId: string | null
  // S649: an open emailed pay link (someone with no lease, or a one-off bill)
  payLinkId?: string | null
  payLink?: { label: string; items: Array<{ name: string; qty: number; price: number }> } | null
  firstName: string | null
  lastName: string | null
  phone: string | null
  email: string | null
  unitNumber: string | null
  propertyId: string | null
  propertyIds?: string[]
  propertyName: string | null
  balance: string
  openInvoices: number
  oldestDueDate: string | null
  // S648: one line per person; each space they rent, with what it owes after
  // their credit (spent once, oldest bill first).
  spaces?: Array<{ leaseId: string | null; unitNumber: string | null; propertyId: string | null
    propertyName: string | null; balance: number; creditApplied: number; openInvoices: number }>
}

// S649: what an open pay link is for, with the two ways to chase it.
function PayLinkBreakdown({ id, link }: { id: string; link?: Owed['payLink'] }) {
  const [msg, setMsg] = useState<string | null>(null)
  const resend = async () => {
    try { await apiPost(`/pos/pay-links/${id}/resend`, {}); setMsg('Sent again.') }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Could not send it again.') }
  }
  return (
    <div style={{ padding: '10px 16px 14px 32px' }}>
      <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginBottom: 6 }}>{link?.label}</div>
      {(link?.items || []).map((it, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.8rem', maxWidth: 420 }}>
          <span>{it.name}{Number(it.qty) !== 1 ? ` × ${it.qty}` : ''}</span>
          <span className="mono">{fmt(Number(it.price) * Number(it.qty))}</span>
        </div>
      ))}
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '6px 0 10px' }}>Card fee is added when they pay by card.</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" onClick={resend}>Send again</button>
        {msg && <span style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>{msg}</span>}
      </div>
    </div>
  )
}

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

function daysOverdue(due: string | null): number | null {
  if (!due) return null
  const d = new Date(due.slice(0, 10) + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.floor((today.getTime() - d.getTime()) / 86400000)
}

/**
 * S634 (Nic, DIRECTIVE): "these outstanding balances need to be clickable so I
 * can get into the invoice and actually view it... as a landlord, you need to be
 * able to explain that to a tenant."
 *
 * The list gave a number and nothing behind it. A resident at the counter asking
 * "what's this $217?" left the landlord with no way to answer from the product,
 * which is the one moment the number had to mean something.
 *
 * Every line, with its own note — the meter reads, the flat-rate multiplier, the
 * cycle a late-arriving utility belongs to — because that note IS the sentence
 * the landlord repeats back.
 */
function InvoiceBreakdown({ tenantId }: { tenantId: string }) {
  const { data: invoices = [], isLoading } = useQuery<any[]>(
    ['balance-invoices', tenantId], () => apiGet(`/balances/${tenantId}/invoices`))

  if (isLoading) return <div style={{ padding: '10px 14px', fontSize: '.78rem', color: 'var(--text-3)' }}>Loading invoices…</div>
  if (!invoices.length) return <div style={{ padding: '10px 14px', fontSize: '.78rem', color: 'var(--text-3)' }}>No open invoices.</div>

  const LABEL: Record<string, string> = {
    rent: 'Rent', utility: 'Utility', fee: 'Fee', deposit: 'Deposit',
    late_fee: 'Late fee', subscription: 'Subscription',
  }
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
              {fmt(Number(inv.balance))} owed
              {Number(inv.amountPaid) > 0 && (
                <span style={{ color: 'var(--text-3)', fontWeight: 400, marginLeft: 8 }}>
                  ({fmt(Number(inv.amountPaid))} paid of {fmt(Number(inv.totalAmount))})
                </span>
              )}
            </div>
          </div>
          <table className="data-table" style={{ width: '100%' }}>
            <tbody>
              {(inv.lines || []).map((l: any) => (
                <tr key={l.id}>
                  <td style={{ fontSize: '.78rem', width: 110, color: 'var(--text-2)' }}>
                    {LABEL[l.type] || l.type}
                  </td>
                  <td style={{ fontSize: '.78rem' }}>
                    {l.notes || l.entryDescription || '—'}
                    {l.status && l.status !== 'pending' && (
                      <span style={{ marginLeft: 8, fontSize: '.68rem', color: 'var(--text-3)' }}>· {l.status}</span>
                    )}
                  </td>
                  <td style={{ fontSize: '.78rem', textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {fmt(Number(l.amount))}
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
                    −{fmt(Number(inv.workTradeCreditAmount))}
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

export function BalancesPage() {
  const { data: rows = [], isLoading } = useQuery<Owed[]>('outstanding-balances', () => apiGet('/balances'))
  // S634: which row is open. One at a time — this is a look-it-up-and-answer
  // surface, not a report.
  const [openRow, setOpenRow] = useState<string | null>(null)

  // S637 (Nic, DIRECTIVE): "The outstanding balance page on the financials tab
  // does not let you sort by property. All pages that view information for more
  // than one property need to be sortable by property."
  //
  // The payload has carried propertyId all along; nothing ever offered it as a
  // control. Total follows the filter — a heading that keeps counting rows the
  // table is no longer showing is worse than no total.
  const [propertyId, setPropertyId] = useState('')
  const propertyOptions = (rows as Owed[]).flatMap(r => (r.spaces?.length
    ? r.spaces.map(x => ({ id: x.propertyId || '', name: x.propertyName || '' }))
    : [{ id: r.propertyId || '', name: r.propertyName || '' }]))
  // S648: filtered to one property, a person renting at two shows only what
  // they owe HERE.
  const shown = (rows as Owed[]).map(r => {
    if (propertyId === '' || !r.spaces?.length) return r
    const here = r.spaces.filter(x => x.propertyId === propertyId)
    if (here.length === r.spaces.length) return r
    return { ...r, spaces: here,
      balance: here.reduce((t, x) => t + Number(x.balance), 0).toFixed(2),
      openInvoices: here.reduce((t, x) => t + x.openInvoices, 0),
      unitNumber: here.map(x => x.unitNumber).filter(Boolean).join(', '),
      propertyName: here[0]?.propertyName ?? r.propertyName }
  }).filter(r => propertyId === '' || (r.spaces?.length
    ? r.spaces.length > 0 && Number(r.balance) > 0
    : r.propertyId === propertyId))

  const total = shown.reduce((s, r) => s + Number(r.balance), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Outstanding Balances</h1>
          <p className="page-subtitle">Who owes, how to reach them — click a row for the charge breakdown</p>
        </div>
        {shown.length > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Total owed{propertyId ? ' — this property' : ''}
            </div>
            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--gold)' }}>{fmt(total)}</div>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="filter-bar">
          <PropertySelect value={propertyId} onChange={setPropertyId} properties={propertyOptions} />
        </div>
      )}

      {isLoading ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : shown.length === 0 ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
          {rows.length === 0
            ? "🎉 No outstanding balances — everyone's current."
            : 'Nobody owes anything at this property.'}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Unit / Property</th>
                <th style={{ textAlign: 'right' }}>Owed</th>
                <th>Oldest Due</th>
                <th>Contact</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => {
                const od = daysOverdue(r.oldestDueDate)
                const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Tenant'
                const rowKey = r.payLinkId || r.tenantId || ''

                const isOpen = openRow === rowKey
                return (
                  <Fragment key={rowKey}>
                  <tr onClick={() => setOpenRow(isOpen ? null : rowKey)}
                      style={{ cursor: 'pointer' }}
                      title="See what makes up this balance">
                    <td style={{ fontWeight: 500 }}>
                      <span style={{ color: 'var(--text-3)', marginRight: 6, fontSize: '.7rem' }}>{isOpen ? '▾' : '▸'}</span>
                      {name}
                    </td>
                    <td style={{ fontSize: '.85rem', color: 'var(--text-2)' }}>
                      {(r.spaces?.length ?? 0) > 1 ? (
                        r.spaces!.map(x => (
                          <div key={(x.leaseId || '') + x.unitNumber}>
                            {x.unitNumber || '—'}
                            <span style={{ color: 'var(--text-3)' }}> · {fmt(Number(x.balance))}</span>
                            {x.creditApplied > 0 && (
                              <span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}> (after {fmt(x.creditApplied)} credit)</span>
                            )}
                          </div>
                        ))
                      ) : (
                        <>{r.payLinkId ? 'Pay link' : r.unitNumber ? `Unit ${r.unitNumber}` : '—'}</>
                      )}
                      {r.propertyName && <span style={{ color: 'var(--text-3)' }}> · {r.propertyName}</span>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--gold)' }}>
                      {fmt(Number(r.balance))}
                      <div style={{ fontSize: '.68rem', color: 'var(--text-3)', fontWeight: 400 }}>
                        {r.payLinkId ? 'emailed pay link' : `${r.openInvoices} invoice${r.openInvoices === 1 ? '' : 's'}`}
                      </div>
                    </td>
                    <td style={{ fontSize: '.82rem' }}>
                      {r.oldestDueDate ? new Date(r.oldestDueDate.slice(0, 10) + 'T00:00:00').toLocaleDateString() : '—'}
                      {od != null && od > 0 && (
                        <span style={{ marginLeft: 6, fontSize: '.68rem', fontWeight: 600, color: od > 30 ? 'var(--red, #ef4444)' : 'var(--amber, #d0a02a)' }}>
                          {od}d overdue
                        </span>
                      )}
                    </td>
                    <td style={{ fontSize: '.82rem' }}>
                      {r.phone && <div><a onClick={e => e.stopPropagation()} href={`tel:${r.phone}`} style={{ color: 'var(--gold)' }}>{r.phone}</a></div>}
                      {r.email && <div><a onClick={e => e.stopPropagation()} href={`mailto:${r.email}`} style={{ color: 'var(--text-2)' }}>{r.email}</a></div>}
                      {!r.phone && !r.email && <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={5} style={{ padding: 0, background: 'rgba(255,255,255,.015)' }}>
                        {r.payLinkId
                          ? <PayLinkBreakdown id={r.payLinkId} link={r.payLink} />
                          : <InvoiceBreakdown tenantId={r.tenantId!} />}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
