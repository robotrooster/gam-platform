import { Fragment, useState } from 'react'
import { useQuery } from 'react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { TicketBreakdown, PayLinkBreakdown, InvoiceBreakdown } from '../components/BalanceBreakdowns'
import { apiGet } from '../lib/api'

// Front-desk "who owes" view. Read-only list of tenants with an unpaid balance
// + contact info, so a front-counter person knows who to call. Data from
// GET /balances (unpaid invoice balances, per the platform's outstanding def).
interface Owed {
  tenantId: string | null
  // S649: an open emailed pay link (someone with no lease, or a one-off bill)
  payLinkId?: string | null
  payLink?: { label: string; items: Array<{ name: string; qty: number; price: number }> } | null
  // S652: a register ticket nobody has settled yet.
  ticketId?: string | null
  ticket?: { note: string | null; items: Array<{ name: string; qty: number; price: number }> } | null
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

// S652 (Nic): a register ticket still open — settled at the register, from its
// "open tickets & pay links" list.
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
export function BalancesPage() {
  const { data: rows = [], isLoading } = useQuery<Owed[]>('outstanding-balances', () => apiGet('/balances'))
  // S634: which row is open. One at a time — this is a look-it-up-and-answer
  // surface, not a report.
  const [openRow, setOpenRow] = useState<string | null>(null)

  // S654 (Nic): "It needs to be the same kind of setup as the leases page where
  // each property is a folder and you can click to expand it… you don't select a
  // property on this page. You just expand the property you want to see." And
  // inside a folder, "alphabetical order for ease of access."
  //
  // Same shape as the Leases page (S652): one folder per property, closed until
  // opened, no dropdown — the folders ARE the filter. A person renting at two
  // properties appears under each with only what they owe THERE (S648), and
  // never has a credit counted twice: the per-space balances already carry it.
  const [openProps, setOpenProps] = useState<Set<string>>(() => new Set())
  const toggleProp = (id: string) => setOpenProps(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  type Folder = { id: string; name: string; rows: Owed[] }
  const folders = new Map<string, Folder>()
  const put = (id: string, name: string, r: Owed) => {
    const f = folders.get(id) ?? { id, name, rows: [] }
    f.rows.push(r)
    folders.set(id, f)
  }
  for (const r of rows as Owed[]) {
    if (r.spaces?.length) {
      const byProp = new Map<string, NonNullable<Owed['spaces']>>()
      for (const x of r.spaces) {
        const k = x.propertyId || ''
        byProp.set(k, [...(byProp.get(k) ?? []), x])
      }
      for (const [pid, here] of byProp) {
        const name = here[0]?.propertyName || r.propertyName || 'No property'
        put(pid, name, here.length === r.spaces.length ? r : {
          ...r, spaces: here,
          balance: here.reduce((t, x) => t + Number(x.balance), 0).toFixed(2),
          openInvoices: here.reduce((t, x) => t + x.openInvoices, 0),
          unitNumber: here.map(x => x.unitNumber).filter(Boolean).join(', '),
          propertyName: name,
        })
      }
    } else {
      put(r.propertyId || '', r.propertyName || 'No property', r)
    }
  }
  const groups = [...folders.values()].sort((a, b) => a.name.localeCompare(b.name))
  const sortKey = (r: Owed) => `${r.lastName || ''} ${r.firstName || ''}`.trim().toLowerCase() || '￿'
  for (const g of groups) g.rows.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  // A single-property account has nothing to fold — its one folder starts open.
  const singleFolder = groups.length === 1
  const folderTotal = (g: Folder) => g.rows.reduce((s, r) => s + Number(r.balance), 0)

  const total = (rows as Owed[]).reduce((s, r) => s + Number(r.balance), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Outstanding Balances</h1>
          <p className="page-subtitle">Who owes, how to reach them — open a property, then click a name for the charge breakdown</p>
        </div>
        {rows.length > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Total owed
            </div>
            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--gold)' }}>{fmt(total)}</div>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
          🎉 No outstanding balances — everyone's current.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Unit</th>
                <th style={{ textAlign: 'right' }}>Owed</th>
                <th>Oldest Due</th>
                <th>Contact</th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap(g => {
                const isOpen = singleFolder || openProps.has(g.id)
                const folder = (
                  <tr key={`folder-${g.id}`} onClick={() => toggleProp(g.id)} className="row-clickable"
                      style={{ cursor: 'pointer', background: 'var(--bg-2)' }}>
                    <td colSpan={5} style={{ fontWeight: 700, padding: '12px 16px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        {g.name}
                        <span style={{ fontWeight: 400, fontSize: '.78rem', color: 'var(--text-3)' }}>
                          {g.rows.length} {g.rows.length === 1 ? 'person owes' : 'people owe'} · <span style={{ color: 'var(--gold)' }}>{fmt(folderTotal(g))}</span>
                        </span>
                      </span>
                    </td>
                  </tr>
                )
                if (!isOpen) return [folder]
                return [folder, ...g.rows.map(r => {
                const od = daysOverdue(r.oldestDueDate)
                const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Tenant'
                const rowKey = `${g.id}:${r.payLinkId || r.ticketId || r.tenantId || ''}`

                const isOpen = openRow === rowKey
                return (
                  <Fragment key={rowKey}>
                  <tr onClick={() => setOpenRow(isOpen ? null : rowKey)}
                      style={{ cursor: 'pointer' }}
                      title="See what makes up this balance">
                    <td style={{ fontWeight: 500, paddingLeft: 32 }}>
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
                        <>{r.payLinkId ? 'Pay link' : r.ticketId ? 'Register ticket' : r.unitNumber ? `Unit ${r.unitNumber}` : '—'}</>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--gold)' }}>
                      {fmt(Number(r.balance))}
                      <div style={{ fontSize: '.68rem', color: 'var(--text-3)', fontWeight: 400 }}>
                        {r.payLinkId ? 'emailed pay link' : r.ticketId ? 'open register ticket' : `${r.openInvoices} invoice${r.openInvoices === 1 ? '' : 's'}`}
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
                          : r.ticketId
                            ? <TicketBreakdown ticket={r.ticket} />
                            : <InvoiceBreakdown tenantId={r.tenantId!} />}
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
    </div>
  )
}
