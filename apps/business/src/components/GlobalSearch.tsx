/**
 * S511 — global search bar.
 *
 * Sits in the Layout header. Debounced 200ms. Renders grouped results
 * in a floating dropdown beneath the input. Click navigates to the
 * relevant detail page.
 *
 * Cmd+K / Ctrl+K focuses the input from anywhere in the portal.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet } from '../lib/api'
import {
  Search, Users, Receipt, FileText, Wrench, CalendarDays, X, Car,
} from 'lucide-react'

interface CustomerHit {
  id: string
  firstName: string | null; lastName: string | null
  companyName: string | null
  email: string | null; phone: string | null
  city: string | null; state: string | null
}
interface InvoiceHit {
  id: string; invoiceNumber: string; status: string;
  totalAmount: string; issueDate: string; dueDate: string;
  customerFirstName: string | null; customerLastName: string | null;
  customerCompanyName: string | null
}
interface QuoteHit {
  id: string; quoteNumber: string; status: string;
  totalAmount: string;
  customerFirstName: string | null; customerLastName: string | null;
  customerCompanyName: string | null
}
interface WorkOrderHit {
  id: string; woNumber: string; status: string;
  complaint: string | null; totalAmount: string;
  customerFirstName: string | null; customerLastName: string | null;
  customerCompanyName: string | null
  vehicleYear: number | null; vehicleMake: string | null;
  vehicleModel: string | null; vehicleLicensePlate: string | null
}
interface AppointmentHit {
  id: string; serviceType: string; scheduledFor: string;
  durationMinutes: number; status: string;
  customerFirstName: string | null; customerLastName: string | null;
  customerCompanyName: string | null
}

interface SearchResults {
  query: string
  total: number
  results: {
    customers?:    CustomerHit[]
    invoices?:     InvoiceHit[]
    quotes?:       QuoteHit[]
    work_orders?:  WorkOrderHit[]
    appointments?: AppointmentHit[]
  }
}

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function fmtDateShort(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function customerLabel(r: {
  customerCompanyName?: string | null;
  customerFirstName?: string | null;
  customerLastName?: string | null;
}): string {
  if (r.customerCompanyName) return r.customerCompanyName
  return `${r.customerFirstName ?? ''} ${r.customerLastName ?? ''}`.trim() || 'Unnamed'
}

export function GlobalSearch() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()

  // Cmd+K / Ctrl+K focuses the input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
      if (e.key === 'Escape') {
        setOpen(false)
        inputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Outside-click closes.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [])

  // Debounced fetch.
  useEffect(() => {
    if (!q.trim()) {
      setResults(null); setLoading(false); return
    }
    const handle = setTimeout(async () => {
      setLoading(true)
      try {
        const r = await apiGet<SearchResults>(`/business-search?q=${encodeURIComponent(q.trim())}`)
        setResults(r)
      } catch {
        setResults(null)
      } finally { setLoading(false) }
    }, 200)
    return () => clearTimeout(handle)
  }, [q])

  const go = (path: string) => {
    setOpen(false)
    setQ('')
    setResults(null)
    navigate(path)
  }

  const isMac = useMemo(() => /Mac/i.test(navigator.platform), [])

  return (
    <div ref={containerRef} style={{ position: 'relative' as const, width: 360 }}>
      <div style={{ position: 'relative' as const }}>
        <Search size={14} style={{
          position: 'absolute' as const, left: 12, top: '50%',
          transform: 'translateY(-50%)', color: 'var(--text-3)',
          pointerEvents: 'none' as const,
        }} />
        <input
          ref={inputRef}
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder="Search customers, invoices, WOs…"
          style={{
            width: '100%',
            padding: '8px 70px 8px 34px',
            background: 'var(--bg-2)',
            color: 'var(--text-0)',
            border: '1px solid var(--border-1)',
            borderRadius: 8,
            fontSize: 13,
            boxSizing: 'border-box' as const,
            outline: 'none' as const,
          }} />
        {q ? (
          <button
            onClick={() => { setQ(''); setResults(null); inputRef.current?.focus() }}
            style={{
              position: 'absolute' as const, right: 8, top: '50%',
              transform: 'translateY(-50%)',
              background: 'transparent', border: 'none',
              color: 'var(--text-3)', cursor: 'pointer',
              padding: 4, display: 'inline-flex' as const, alignItems: 'center',
            }} title="Clear">
            <X size={12} />
          </button>
        ) : (
          <span style={{
            position: 'absolute' as const, right: 10, top: '50%',
            transform: 'translateY(-50%)',
            fontFamily: 'var(--font-mono)' as const,
            fontSize: 10, color: 'var(--text-3)',
            border: '1px solid var(--border-1)',
            borderRadius: 4, padding: '1px 5px',
          }}>{isMac ? '⌘K' : 'Ctrl K'}</span>
        )}
      </div>

      {open && q.trim() && (
        <div style={dropdownStyle}>
          {loading && !results && (
            <div style={emptyState}>Searching…</div>
          )}
          {results && results.total === 0 && (
            <div style={emptyState}>No matches for "<strong>{q}</strong>".</div>
          )}
          {results && results.total > 0 && (
            <>
              {results.results.customers && results.results.customers.length > 0 && (
                <Group title="Customers" icon={<Users size={11} />}>
                  {results.results.customers.map(c => (
                    <Result key={c.id} onClick={() => go(`/customers`)}>
                      <strong>{c.companyName || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Unnamed'}</strong>
                      <span style={metaStyle}>
                        {c.email}{c.email && c.phone && ' · '}{c.phone}
                        {(c.email || c.phone) && (c.city || c.state) && ' · '}
                        {c.city}{c.city && c.state && ', '}{c.state}
                      </span>
                    </Result>
                  ))}
                </Group>
              )}
              {results.results.invoices && results.results.invoices.length > 0 && (
                <Group title="Invoices" icon={<Receipt size={11} />}>
                  {results.results.invoices.map(i => (
                    <Result key={i.id} onClick={() => go(`/invoices`)}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <strong style={{ fontFamily: 'var(--font-mono)' as const, color: 'var(--gold)' }}>
                          {i.invoiceNumber}
                        </strong>
                        <span>{customerLabel(i)}</span>
                        <span style={statusPill(i.status)}>{i.status}</span>
                      </div>
                      <span style={metaStyle}>
                        {fmtMoney(i.totalAmount)} · Due {fmtDateShort(i.dueDate)}
                      </span>
                    </Result>
                  ))}
                </Group>
              )}
              {results.results.quotes && results.results.quotes.length > 0 && (
                <Group title="Quotes" icon={<FileText size={11} />}>
                  {results.results.quotes.map(qu => (
                    <Result key={qu.id} onClick={() => go(`/quotes`)}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <strong style={{ fontFamily: 'var(--font-mono)' as const, color: 'var(--gold)' }}>
                          {qu.quoteNumber}
                        </strong>
                        <span>{customerLabel(qu)}</span>
                        <span style={statusPill(qu.status)}>{qu.status}</span>
                      </div>
                      <span style={metaStyle}>{fmtMoney(qu.totalAmount)}</span>
                    </Result>
                  ))}
                </Group>
              )}
              {results.results.work_orders && results.results.work_orders.length > 0 && (
                <Group title="Work orders" icon={<Wrench size={11} />}>
                  {results.results.work_orders.map(w => {
                    const ymm = [w.vehicleYear, w.vehicleMake, w.vehicleModel].filter(Boolean).join(' ')
                    return (
                      <Result key={w.id} onClick={() => go(`/work-orders`)}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                          <strong style={{ fontFamily: 'var(--font-mono)' as const, color: 'var(--gold)' }}>
                            {w.woNumber}
                          </strong>
                          <span>{customerLabel(w)}</span>
                          <span style={statusPill(w.status)}>{w.status}</span>
                        </div>
                        <span style={metaStyle}>
                          {ymm && <><Car size={9} style={{ verticalAlign: 'middle', marginRight: 4 }} />{ymm} · </>}
                          {w.complaint
                            ? (w.complaint.length > 60 ? w.complaint.slice(0, 60) + '…' : w.complaint)
                            : `${fmtMoney(w.totalAmount)}`}
                        </span>
                      </Result>
                    )
                  })}
                </Group>
              )}
              {results.results.appointments && results.results.appointments.length > 0 && (
                <Group title="Appointments" icon={<CalendarDays size={11} />}>
                  {results.results.appointments.map(a => (
                    <Result key={a.id} onClick={() => go(`/appointments`)}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <span>{customerLabel(a)}</span>
                        <span style={statusPill(a.status)}>{a.status}</span>
                      </div>
                      <span style={metaStyle}>
                        {a.serviceType} · {new Date(a.scheduledFor).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {a.durationMinutes}m
                      </span>
                    </Result>
                  ))}
                </Group>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Group({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        padding: '8px 12px 4px',
        fontSize: 10, color: 'var(--text-3)',
        textTransform: 'uppercase' as const, letterSpacing: 1, fontWeight: 600,
        display: 'flex' as const, alignItems: 'center', gap: 5,
      }}>
        {icon} {title}
      </div>
      {children}
    </div>
  )
}

function Result({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block' as const, width: '100%',
        padding: '8px 12px',
        background: 'transparent', border: 'none',
        textAlign: 'left' as const,
        cursor: 'pointer',
        color: 'var(--text-1)',
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: 1.5,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-2)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      {children}
    </button>
  )
}

function statusPill(status: string): React.CSSProperties {
  const tone =
    status === 'paid' || status === 'accepted' || status === 'completed' ? 'var(--green, #22c55e)' :
    status === 'sent' || status === 'in_progress' || status === 'scheduled' ? 'var(--gold)' :
    status === 'void' || status === 'declined' || status === 'cancelled' ? 'var(--red, #ef4444)' :
    'var(--text-3)'
  return {
    padding: '1px 6px', fontSize: 9, fontWeight: 700,
    color: tone, border: `1px solid ${tone}`, borderRadius: 3,
    textTransform: 'uppercase' as const, letterSpacing: 0.4,
  }
}

const dropdownStyle: React.CSSProperties = {
  position: 'absolute' as const,
  top: 'calc(100% + 6px)',
  left: 0, right: 0,
  background: 'var(--bg-1)',
  border: '1px solid var(--border-1)',
  borderRadius: 10,
  maxHeight: 460,
  overflowY: 'auto' as const,
  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  zIndex: 1000,
}
const metaStyle: React.CSSProperties = {
  display: 'block' as const,
  fontSize: 11, color: 'var(--text-3)',
  marginTop: 2,
}
const emptyState: React.CSSProperties = {
  padding: 24, textAlign: 'center' as const,
  fontSize: 12, color: 'var(--text-3)',
}
