import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch, apiDelete, openPdfInNewTab } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { Modal } from '../components/Modal'
import {
  Plus, ChevronRight, ArrowLeft, Send, Check, X as XIcon,
  Receipt, Wrench, Trash2, Car, AlertTriangle, Search, Printer,
} from 'lucide-react'

type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired'

interface QuoteSummary {
  id: string
  quoteNumber: string
  status: QuoteStatus
  subtotal: string
  discountAmount: string
  taxAmount: string
  totalAmount: string
  expiresAt: string | null
  sentAt: string | null
  acceptedAt: string | null
  declinedAt: string | null
  invoiceId: string | null
  workOrderId: string | null
  customerId: string
  vehicleId: string | null
  createdAt: string
  customerFirstName: string | null
  customerLastName: string | null
  customerCompanyName: string | null
}

interface QuoteLine {
  id: string
  lineType: 'labor' | 'part' | 'fee' | 'generic'
  itemId: string | null
  description: string
  quantity: string
  unitPrice: string
  taxRate: string
  lineSubtotal: string
  lineTax: string
  lineTotal: string
  sortOrder: number
}

interface QuoteDetail extends QuoteSummary {
  intakeDescription: string | null
  notes: string | null
  internalNotes: string | null
  declineReason: string | null
  customerEmail: string | null
  customerPhone: string | null
  vehicleYear: number | null
  vehicleMake: string | null
  vehicleModel: string | null
  vehicleVin: string | null
  discountCode: string | null
  lines: QuoteLine[]
}

interface Customer {
  id: string
  firstName: string | null
  lastName: string | null
  companyName: string | null
}

interface Vehicle {
  id: string
  customerId: string
  vin: string | null
  licensePlate: string | null
  year: number | null
  make: string | null
  model: string | null
}

interface InventoryItem {
  id: string
  name: string
  sku: string | null
  sellPrice: string
  stockQty: number
}

const STATUS_LABEL: Record<QuoteStatus, { label: string; color: string }> = {
  draft:    { label: 'Draft',    color: 'var(--text-2)' },
  sent:     { label: 'Sent',     color: 'var(--gold)' },
  accepted: { label: 'Accepted', color: 'var(--green, #22c55e)' },
  declined: { label: 'Declined', color: 'var(--red, #ef4444)' },
  expired:  { label: 'Expired',  color: 'var(--text-3)' },
}

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function fmtDateOnly(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function customerLabel(r: Pick<QuoteSummary, 'customerCompanyName' | 'customerFirstName' | 'customerLastName'>): string {
  if (r.customerCompanyName) return r.customerCompanyName
  return `${r.customerFirstName ?? ''} ${r.customerLastName ?? ''}`.trim() || 'Unnamed'
}

// ─────────────────────────────────────────────────────────────────
//  Page
// ─────────────────────────────────────────────────────────────────

export function QuotesPage() {
  const [list, setList] = useState<QuoteSummary[]>([])
  const [statusFilter, setStatusFilter] = useState<QuoteStatus | 'all'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const rows = await apiGet<QuoteSummary[]>(
        statusFilter === 'all'
          ? '/business-quotes'
          : `/business-quotes?status=${statusFilter}`)
      setList(rows)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [statusFilter])

  if (selectedId) {
    return <Detail id={selectedId} onBack={() => { setSelectedId(null); reload() }} />
  }

  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: 16,
      }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>
            Quotes & estimates
          </h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Send a price proposal before work begins. On approval, convert to an invoice or a work order.
          </div>
        </div>
        <button onClick={() => setShowCreate(true)} style={primaryBtnStyle}>
          <Plus size={14} /> New quote
        </button>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--bg-2)', borderRadius: 10, marginBottom: 16, width: 'fit-content' }}>
        {(['all', 'draft', 'sent', 'accepted', 'declined', 'expired'] as const).map(s => (
          <button key={s}
            onClick={() => setStatusFilter(s)}
            style={statusFilter === s ? pillActive : pill}>
            {s === 'all' ? 'All' : STATUS_LABEL[s].label}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div style={emptyStyle}>
          {statusFilter === 'all'
            ? 'No quotes yet. Create one to send a price proposal to a customer.'
            : 'No quotes in this status.'}
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Quote #</th>
              <th style={thStyle}>Customer</th>
              <th style={thStyle}>Created</th>
              <th style={thStyle}>Expires</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Total</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {list.map(q => (
              <tr key={q.id}
                onClick={() => setSelectedId(q.id)}
                style={{ borderBottom: '1px solid var(--border-0)', cursor: 'pointer' }}>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, color: 'var(--text-0)' }}>
                  {q.quoteNumber}
                </td>
                <td style={tdStyle}>{customerLabel(q)}</td>
                <td style={tdStyle}>{fmtDateOnly(q.createdAt)}</td>
                <td style={tdStyle}>
                  {q.expiresAt ? fmtDateOnly(q.expiresAt) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                </td>
                <td style={tdStyle}><StatusBadge status={q.status} /></td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontWeight: 600 }}>
                  {fmtMoney(q.totalAmount)}
                </td>
                <td style={tdStyle}><ChevronRight size={14} color="var(--text-3)" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); setSelectedId(id) }} />
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: QuoteStatus }) {
  const { label, color } = STATUS_LABEL[status]
  return (
    <span style={{
      padding: '3px 8px', fontSize: 11, fontWeight: 700,
      textTransform: 'uppercase' as const, letterSpacing: 0.5,
      border: `1px solid ${color}`, color, borderRadius: 4,
    }}>{label}</span>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Create modal
// ─────────────────────────────────────────────────────────────────

function CreateModal({
  onClose, onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [vehiclesAvailable, setVehiclesAvailable] = useState(true)
  const [form, setForm] = useState({
    customerId: '', vehicleId: '',
    intakeDescription: '', notes: '',
  })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiGet<Customer[]>('/business-customers').then(setCustomers).catch(() => {})
  }, [])

  useEffect(() => {
    if (!form.customerId) { setVehicles([]); return }
    apiGet<Vehicle[]>(`/business-vehicles?customerId=${form.customerId}`)
      .then(rows => { setVehicles(rows); setVehiclesAvailable(true) })
      .catch(() => { setVehicles([]); setVehiclesAvailable(false) })
  }, [form.customerId])

  const submit = async () => {
    setErr(null)
    if (!form.customerId) { setErr('Pick a customer'); return }
    setBusy(true)
    try {
      const payload: any = {
        customerId: form.customerId,
        intakeDescription: form.intakeDescription.trim() || null,
        notes: form.notes.trim() || null,
      }
      if (form.vehicleId) payload.vehicleId = form.vehicleId
      const r = await apiPost<{ id: string }>('/business-quotes', payload)
      onCreated(r.data.id)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Create failed')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="New quote" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy} style={primaryBtnStyle}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      <label style={labelStyle}>Customer</label>
      <select value={form.customerId}
        onChange={e => setForm({ ...form, customerId: e.target.value, vehicleId: '' })}
        style={inputStyle}>
        <option value="">Pick a customer…</option>
        {customers.map(c => (
          <option key={c.id} value={c.id}>
            {c.companyName || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Unnamed'}
          </option>
        ))}
      </select>

      {vehiclesAvailable && (
        <>
          <label style={labelStyle}>Vehicle (optional)</label>
          <select value={form.vehicleId}
            onChange={e => setForm({ ...form, vehicleId: e.target.value })}
            disabled={!form.customerId}
            style={inputStyle}>
            <option value="">
              {!form.customerId ? 'Pick a customer first' : vehicles.length === 0 ? 'No vehicles on file' : '— None —'}
            </option>
            {vehicles.map(v => (
              <option key={v.id} value={v.id}>
                {[v.year, v.make, v.model].filter(Boolean).join(' ') || v.licensePlate || v.vin || 'Unidentified'}
              </option>
            ))}
          </select>
        </>
      )}

      <label style={labelStyle}>Customer-facing description (shown in the email)</label>
      <textarea value={form.intakeDescription}
        onChange={e => setForm({ ...form, intakeDescription: e.target.value })}
        rows={2}
        placeholder="What service is being quoted?"
        style={{ ...inputStyle, fontFamily: 'var(--font-body)' as const, resize: 'vertical' as const }} />

      <label style={labelStyle}>Notes (optional, shown on the quote)</label>
      <textarea value={form.notes}
        onChange={e => setForm({ ...form, notes: e.target.value })}
        rows={2}
        style={{ ...inputStyle, fontFamily: 'var(--font-body)' as const, resize: 'vertical' as const }} />
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Detail view
// ─────────────────────────────────────────────────────────────────

function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const { business } = useAuth()
  const discountsEnabled = (business?.enabledFeatures ?? []).includes('discounts')
  const [q, setQ] = useState<QuoteDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [discountInput, setDiscountInput] = useState('')
  const [discountBusy, setDiscountBusy] = useState(false)
  const [showAddLine, setShowAddLine] = useState(false)
  const [showSend, setShowSend] = useState(false)
  const [showDecline, setShowDecline] = useState(false)
  const [showConvInv, setShowConvInv] = useState(false)
  const [showConvWO, setShowConvWO] = useState(false)

  const reload = async () => {
    setErr(null)
    try {
      const d = await apiGet<QuoteDetail>(`/business-quotes/${id}`)
      setQ(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [id])

  const accept = async () => {
    setErr(null)
    try {
      await apiPost(`/business-quotes/${id}/accept`)
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Accept failed')
    }
  }
  const removeLine = async (lineId: string) => {
    if (!window.confirm('Remove this line?')) return
    setErr(null)
    try {
      await apiDelete(`/business-quotes/${id}/lines/${lineId}`)
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Remove failed')
    }
  }
  const applyDiscount = async (code: string | null) => {
    setErr(null)
    setDiscountBusy(true)
    try {
      await apiPatch(`/business-quotes/${id}/discount`, { code })
      setDiscountInput('')
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not apply discount')
    } finally {
      setDiscountBusy(false)
    }
  }

  if (!q) return (
    <div>
      <button onClick={onBack} style={ghostBtn}><ArrowLeft size={14} /> Back</button>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ marginTop: 16, color: 'var(--text-2)' }}>Loading…</div>
    </div>
  )

  const isDraft = q.status === 'draft'
  const ymm = [q.vehicleYear, q.vehicleMake, q.vehicleModel].filter(Boolean).join(' ')

  return (
    <div>
      <button onClick={onBack} style={ghostBtn}><ArrowLeft size={14} /> Back to quotes</button>
      {err && <div style={{ ...errStyle, marginTop: 16 }}>{err}</div>}

      <div style={{
        marginTop: 16, padding: 24,
        background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, margin: 0 }}>
              {q.quoteNumber}
            </h1>
            <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 13, color: 'var(--text-2)' }}>
              <span>{fmtDate(q.createdAt)}</span>
              <span>·</span>
              <span><strong style={{ color: 'var(--text-0)' }}>{customerLabel(q)}</strong></span>
              {ymm && <><span>·</span><span><Car size={10} style={{ verticalAlign: 'middle', marginRight: 4 }} />{ymm}</span></>}
            </div>
            {q.customerEmail && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{q.customerEmail}</div>
            )}
          </div>
          <StatusBadge status={q.status} />
        </div>

        {/* Actions row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' as const }}>
          <button onClick={() => openPdfInNewTab(`/business-quotes/${id}/pdf`)}
            style={ghostBtn}>
            <Printer size={12} /> Print
          </button>
          {isDraft && (
            <button onClick={() => setShowSend(true)}
              disabled={q.lines.length === 0}
              style={{ ...primaryBtnStyle, opacity: q.lines.length === 0 ? 0.5 : 1 }}>
              <Send size={12} /> Send to customer
            </button>
          )}
          {q.status === 'sent' && (
            <>
              <button onClick={accept} style={primaryBtnStyle}>
                <Check size={12} /> Customer accepted
              </button>
              <button onClick={() => setShowDecline(true)} style={ghostBtn}>
                <XIcon size={12} /> Customer declined
              </button>
            </>
          )}
          {q.status === 'accepted' && !q.invoiceId && (
            <button onClick={() => setShowConvInv(true)} style={primaryBtnStyle}>
              <Receipt size={12} /> Convert to invoice
            </button>
          )}
          {q.status === 'accepted' && !q.workOrderId && (
            <button onClick={() => setShowConvWO(true)} style={ghostBtn}>
              <Wrench size={12} /> Convert to work order
            </button>
          )}
          {q.invoiceId && (
            <span style={{
              padding: '8px 14px',
              background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.4)',
              borderRadius: 8, fontSize: 13, color: 'var(--green, #22c55e)',
              display: 'inline-flex' as const, alignItems: 'center', gap: 6,
            }}>
              <Receipt size={12} /> Invoiced
            </span>
          )}
          {q.workOrderId && (
            <span style={{
              padding: '8px 14px',
              background: 'rgba(212,175,55,.08)', border: '1px solid rgba(212,175,55,.4)',
              borderRadius: 8, fontSize: 13, color: 'var(--gold)',
              display: 'inline-flex' as const, alignItems: 'center', gap: 6,
            }}>
              <Wrench size={12} /> Converted to WO
            </span>
          )}
        </div>

        {(q.intakeDescription || q.expiresAt) && (
          <div style={{ padding: 14, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 16 }}>
            {q.intakeDescription && (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 4 }}>
                  Description
                </div>
                <div style={{ fontSize: 14, color: 'var(--text-1)', whiteSpace: 'pre-wrap' as const, marginBottom: q.expiresAt ? 10 : 0 }}>
                  {q.intakeDescription}
                </div>
              </>
            )}
            {q.expiresAt && (
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                Expires: <strong style={{ color: 'var(--text-0)' }}>{fmtDateOnly(q.expiresAt)}</strong>
              </div>
            )}
          </div>
        )}

        {q.status === 'declined' && q.declineReason && (
          <div style={{
            padding: 12, marginBottom: 16,
            background: 'rgba(239,68,68,.06)',
            border: '1px solid rgba(239,68,68,.4)',
            borderRadius: 8, fontSize: 13, color: 'var(--text-1)',
          }}>
            <strong>Decline reason:</strong> {q.declineReason}
          </div>
        )}

        {/* Lines */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h2 style={{ fontSize: 14, color: 'var(--text-2)', textTransform: 'uppercase' as const, letterSpacing: 1, margin: 0 }}>
            Lines
          </h2>
          {isDraft && (
            <button onClick={() => setShowAddLine(true)} style={ghostBtn}>
              <Plus size={12} /> Add line
            </button>
          )}
        </div>

        {q.lines.length === 0 ? (
          <div style={{ ...emptyStyle, marginBottom: 16 }}>No lines yet. Add labor, parts, or fees to build the estimate.</div>
        ) : (
          <table style={{ ...tableStyle, marginBottom: 16 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Description</th>
                <th style={thStyle}>Qty</th>
                <th style={thStyle}>Unit</th>
                <th style={thStyle}>Subtotal</th>
                <th style={thStyle}>Tax</th>
                <th style={thStyle}>Total</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {q.lines.map(ln => (
                <tr key={ln.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                  <td style={{ ...tdStyle, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                    {ln.lineType}
                  </td>
                  <td style={tdStyle}>{ln.description}</td>
                  <td style={tdStyle}>{Number(ln.quantity)}{ln.lineType === 'labor' ? ' hr' : ''}</td>
                  <td style={tdStyle}>{fmtMoney(ln.unitPrice)}</td>
                  <td style={tdStyle}>{fmtMoney(ln.lineSubtotal)}</td>
                  <td style={tdStyle}>{fmtMoney(ln.lineTax)}</td>
                  <td style={{ ...tdStyle, fontWeight: 600, fontFamily: 'var(--font-mono)' as const }}>
                    {fmtMoney(ln.lineTotal)}
                  </td>
                  <td style={tdStyle}>
                    {isDraft && (
                      <button onClick={() => removeLine(ln.id)}
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 2 }}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Totals */}
        <div style={{ padding: 14, background: 'var(--bg-2)', borderRadius: 8 }}>
          <Row label="Subtotal" value={fmtMoney(q.subtotal)} />
          {Number(q.discountAmount) > 0 && (
            <Row
              label={q.discountCode ? `Discount (${q.discountCode})` : 'Discount'}
              value={`-${fmtMoney(q.discountAmount)}`}
            />
          )}
          <Row label="Tax"      value={fmtMoney(q.taxAmount)} />
          <Row label="Total"    value={fmtMoney(q.totalAmount)} big />
        </div>

        {/* Discount code control — draft only, when the Discounts feature is on */}
        {isDraft && discountsEnabled && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
            {Number(q.discountAmount) > 0 ? (
              <>
                <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
                  Discount code <strong style={{ color: 'var(--text-1)' }}>{q.discountCode}</strong> applied
                </span>
                <button
                  onClick={() => applyDiscount(null)}
                  disabled={discountBusy}
                  style={ghostBtn}
                >
                  Remove
                </button>
              </>
            ) : (
              <>
                <input
                  value={discountInput}
                  onChange={e => setDiscountInput(e.target.value.toUpperCase())}
                  placeholder="Discount code"
                  style={{ ...inputStyle, maxWidth: 200, margin: 0 }}
                  onKeyDown={e => { if (e.key === 'Enter' && discountInput.trim()) applyDiscount(discountInput.trim()) }}
                />
                <button
                  onClick={() => applyDiscount(discountInput.trim())}
                  disabled={discountBusy || !discountInput.trim()}
                  style={{ ...ghostBtn, opacity: discountBusy || !discountInput.trim() ? 0.5 : 1 }}
                >
                  Apply
                </button>
              </>
            )}
          </div>
        )}

        {q.internalNotes && (
          <div style={{
            marginTop: 16, padding: 14,
            background: 'rgba(212,175,55,.04)',
            border: '1px dashed rgba(212,175,55,.4)',
            borderRadius: 8,
            fontSize: 13, color: 'var(--text-2)',
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 4 }}>
              Internal notes (not shown to customer)
            </div>
            <div style={{ color: 'var(--text-1)', whiteSpace: 'pre-wrap' as const }}>{q.internalNotes}</div>
          </div>
        )}
      </div>

      {showAddLine && (
        <AddLineModal quoteId={id}
          onClose={() => setShowAddLine(false)}
          onSaved={() => { setShowAddLine(false); reload() }} />
      )}
      {showSend && (
        <SendModal quoteId={id} customerEmail={q.customerEmail}
          onClose={() => setShowSend(false)}
          onSent={() => { setShowSend(false); reload() }} />
      )}
      {showDecline && (
        <DeclineModal quoteId={id}
          onClose={() => setShowDecline(false)}
          onSaved={() => { setShowDecline(false); reload() }} />
      )}
      {showConvInv && (
        <ConvertInvoiceModal quoteId={id}
          onClose={() => setShowConvInv(false)}
          onDone={() => { setShowConvInv(false); reload() }} />
      )}
      {showConvWO && (
        <ConvertWOModal quoteId={id}
          onClose={() => setShowConvWO(false)}
          onDone={() => { setShowConvWO(false); reload() }} />
      )}
    </div>
  )
}

function Row({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div style={{
      display: 'flex' as const, justifyContent: 'space-between',
      padding: '4px 0',
      fontSize: big ? 18 : 13,
      fontWeight: big ? 700 : 500,
      color: big ? 'var(--gold)' : 'var(--text-1)',
    }}>
      <span>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)' as const }}>{value}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Add-line modal
// ─────────────────────────────────────────────────────────────────

function AddLineModal({
  quoteId, onClose, onSaved,
}: {
  quoteId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [type, setType] = useState<'labor' | 'part' | 'fee' | 'generic'>('labor')
  const [laborDesc, setLaborDesc] = useState('')
  const [hours, setHours] = useState('1')
  const [rate, setRate] = useState('100')
  const [laborTax, setLaborTax] = useState('0')
  const [items, setItems] = useState<InventoryItem[]>([])
  const [itemSearch, setItemSearch] = useState('')
  const [itemId, setItemId] = useState('')
  const [qty, setQty] = useState('1')
  const [overridePrice, setOverridePrice] = useState('')
  const [feeDesc, setFeeDesc] = useState('')
  const [feeAmount, setFeeAmount] = useState('0')
  const [feeTax, setFeeTax] = useState('0')
  const [genericDesc, setGenericDesc] = useState('')
  const [genericQty, setGenericQty] = useState('1')
  const [genericPrice, setGenericPrice] = useState('0')
  const [genericTax, setGenericTax] = useState('0')
  // S504: shared per-line discount, applies to whichever line type is active.
  const [discType, setDiscType] = useState<'none' | 'percent' | 'fixed'>('none')
  const [discValue, setDiscValue] = useState('')

  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const withLineDiscount = (payload: any) => {
    if (discType !== 'none' && Number(discValue) > 0) {
      payload.discountType = discType
      payload.discountValue = Number(discValue)
    }
    return payload
  }

  useEffect(() => {
    if (type !== 'part') return
    const url = itemSearch.trim()
      ? `/business-inventory/items?q=${encodeURIComponent(itemSearch.trim())}`
      : '/business-inventory/items'
    apiGet<InventoryItem[]>(url).then(setItems).catch(() => setItems([]))
  }, [type, itemSearch])

  const submit = async () => {
    setErr(null)
    let payload: any
    if (type === 'labor') {
      if (!laborDesc.trim()) { setErr('Description required'); return }
      payload = {
        lineType: 'labor', description: laborDesc.trim(),
        hours: Number(hours) || 0, hourlyRate: Number(rate) || 0,
        taxRate: (Number(laborTax) || 0) / 100,
      }
    } else if (type === 'fee') {
      if (!feeDesc.trim()) { setErr('Description required'); return }
      payload = {
        lineType: 'fee', description: feeDesc.trim(),
        amount: Number(feeAmount) || 0,
        taxRate: (Number(feeTax) || 0) / 100,
      }
    } else if (type === 'generic') {
      if (!genericDesc.trim()) { setErr('Description required'); return }
      payload = {
        lineType: 'generic', description: genericDesc.trim(),
        quantity: Number(genericQty) || 0, unitPrice: Number(genericPrice) || 0,
        taxRate: (Number(genericTax) || 0) / 100,
      }
    } else {
      if (!itemId) { setErr('Pick an item'); return }
      payload = { lineType: 'part', itemId, quantity: Number(qty) || 0 }
      if (overridePrice.trim()) payload.unitPrice = Number(overridePrice)
    }
    if (discType !== 'none' && !(Number(discValue) > 0)) { setErr('Enter a discount amount or set discount to None'); return }
    if (discType === 'percent' && Number(discValue) > 100) { setErr('Percent discount cannot exceed 100'); return }
    withLineDiscount(payload)
    setBusy(true)
    try {
      await apiPost(`/business-quotes/${quoteId}/lines`, payload)
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Add failed')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Add line" onClose={onClose} width={520}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy} style={primaryBtnStyle}>
            {busy ? 'Adding…' : 'Add line'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--bg-2)', borderRadius: 10, marginBottom: 16 }}>
        {(['labor', 'part', 'fee', 'generic'] as const).map(t => (
          <button key={t}
            onClick={() => setType(t)}
            style={{
              flex: 1, padding: '8px 14px',
              background: type === t ? 'var(--bg-1)' : 'transparent',
              color: type === t ? 'var(--gold)' : 'var(--text-2)',
              border: 'none', borderRadius: 6,
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
              textTransform: 'capitalize' as const,
            }}>
            {t}
          </button>
        ))}
      </div>

      {type === 'labor' && (
        <>
          <label style={labelStyle}>Description</label>
          <input value={laborDesc} onChange={e => setLaborDesc(e.target.value)}
            placeholder="Diagnostic / brake pad replacement / etc."
            style={inputStyle} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Hours</label>
              <input type="number" step="0.25" min="0.25" value={hours}
                onChange={e => setHours(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Rate / hr</label>
              <input type="number" step="0.01" min="0" value={rate}
                onChange={e => setRate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Tax %</label>
              <input type="number" step="0.01" min="0" value={laborTax}
                onChange={e => setLaborTax(e.target.value)} style={inputStyle} />
            </div>
          </div>
        </>
      )}

      {type === 'part' && (
        <>
          <label style={labelStyle}>Search inventory</label>
          <div style={{ position: 'relative', marginBottom: 8 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
            <input value={itemSearch} onChange={e => setItemSearch(e.target.value)}
              placeholder="Search name or SKU…"
              style={{ ...inputStyle, paddingLeft: 32, marginTop: 0 }} />
          </div>
          <div style={{
            maxHeight: 200, overflowY: 'auto' as const,
            border: '1px solid var(--border-1)', borderRadius: 8,
            background: 'var(--bg-2)',
          }}>
            {items.length === 0 ? (
              <div style={{ padding: 16, fontSize: 13, color: 'var(--text-3)', textAlign: 'center' as const }}>
                {itemSearch ? 'No items match.' : 'No inventory items yet.'}
              </div>
            ) : items.map(it => (
              <button key={it.id}
                onClick={() => setItemId(it.id)}
                style={{
                  display: 'flex' as const, justifyContent: 'space-between',
                  alignItems: 'center', width: '100%',
                  padding: '10px 14px',
                  background: itemId === it.id ? 'rgba(212,175,55,.10)' : 'transparent',
                  border: 'none', borderBottom: '1px solid var(--border-0)',
                  color: 'var(--text-0)', fontSize: 13,
                  cursor: 'pointer', textAlign: 'left' as const,
                }}>
                <div>
                  <div>{it.name}</div>
                  {it.sku && <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' as const }}>{it.sku}</div>}
                </div>
                <div style={{ textAlign: 'right' as const, fontSize: 11 }}>
                  <div style={{ color: 'var(--gold)' }}>{fmtMoney(it.sellPrice)}</div>
                  <div style={{ color: 'var(--text-3)' }}>{it.stockQty} on hand</div>
                </div>
              </button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            <div>
              <label style={labelStyle}>Quantity</label>
              <input type="number" min="1" value={qty}
                onChange={e => setQty(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Override price (optional)</label>
              <input type="number" step="0.01" min="0"
                value={overridePrice}
                onChange={e => setOverridePrice(e.target.value)}
                placeholder="Use item price"
                style={inputStyle} />
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)' }}>
            Quoting parts does not decrement stock — that only happens when you convert the quote to a work order.
          </div>
        </>
      )}

      {type === 'fee' && (
        <>
          <label style={labelStyle}>Description</label>
          <input value={feeDesc} onChange={e => setFeeDesc(e.target.value)}
            placeholder="Shop fee / disposal / pickup / etc."
            style={inputStyle} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Amount</label>
              <input type="number" step="0.01" min="0" value={feeAmount}
                onChange={e => setFeeAmount(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Tax %</label>
              <input type="number" step="0.01" min="0" value={feeTax}
                onChange={e => setFeeTax(e.target.value)} style={inputStyle} />
            </div>
          </div>
        </>
      )}

      {type === 'generic' && (
        <>
          <label style={labelStyle}>Description</label>
          <input value={genericDesc} onChange={e => setGenericDesc(e.target.value)}
            placeholder="Anything — service bundle, custom item, etc."
            style={inputStyle} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Qty</label>
              <input type="number" step="0.01" min="0.01" value={genericQty}
                onChange={e => setGenericQty(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Unit price</label>
              <input type="number" step="0.01" min="0" value={genericPrice}
                onChange={e => setGenericPrice(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Tax %</label>
              <input type="number" step="0.01" min="0" value={genericTax}
                onChange={e => setGenericTax(e.target.value)} style={inputStyle} />
            </div>
          </div>
        </>
      )}

      <div style={{ borderTop: '1px solid var(--border-1)', marginTop: 16, paddingTop: 12 }}>
        <label style={labelStyle}>Line discount (optional)</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <select value={discType}
            onChange={e => setDiscType(e.target.value as 'none' | 'percent' | 'fixed')}
            style={inputStyle}>
            <option value="none">No discount</option>
            <option value="percent">Percent off (%)</option>
            <option value="fixed">Amount off ($)</option>
          </select>
          {discType !== 'none' && (
            <input type="number" step="0.01" min="0"
              max={discType === 'percent' ? 100 : undefined}
              value={discValue} onChange={e => setDiscValue(e.target.value)}
              placeholder={discType === 'percent' ? '10' : '25.00'}
              style={inputStyle} />
          )}
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
          Discounts this line off its gross (qty × price), pre-tax. A whole-quote
          discount code, if any, stacks on top.
        </div>
      </div>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Send / decline / convert modals
// ─────────────────────────────────────────────────────────────────

function SendModal({
  quoteId, customerEmail, onClose, onSent,
}: {
  quoteId: string
  customerEmail: string | null
  onClose: () => void
  onSent: () => void
}) {
  const [expiresInDays, setExpiresInDays] = useState('30')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null); setBusy(true)
    try {
      await apiPost(`/business-quotes/${quoteId}/send`, {
        expiresInDays: parseInt(expiresInDays, 10) || 30,
      })
      onSent()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Send failed')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Send quote to customer" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy} style={primaryBtnStyle}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      {!customerEmail ? (
        <div style={{
          padding: 12, marginBottom: 12,
          background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.4)',
          borderRadius: 8, fontSize: 12, color: 'var(--text-1)',
          display: 'flex', gap: 8, alignItems: 'start',
        }}>
          <AlertTriangle size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
          <span>This customer has no email on file. The quote will be marked sent so you can track it, but no email will go out — share by text or print yourself.</span>
        </div>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 16px 0' }}>
          Customer will receive a copy at <strong style={{ color: 'var(--text-0)' }}>{customerEmail}</strong> with all line items + total.
        </p>
      )}
      <label style={labelStyle}>Valid for (days)</label>
      <input type="number" min="1" max="365" value={expiresInDays}
        onChange={e => setExpiresInDays(e.target.value)}
        style={inputStyle} />
    </Modal>
  )
}

function DeclineModal({
  quoteId, onClose, onSaved,
}: {
  quoteId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async () => {
    setErr(null)
    if (!reason.trim()) { setErr('Reason required'); return }
    setBusy(true)
    try {
      await apiPost(`/business-quotes/${quoteId}/decline`, { reason: reason.trim() })
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Decline failed')
    } finally { setBusy(false) }
  }
  return (
    <Modal title="Customer declined" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy} style={primaryBtnStyle}>
            {busy ? 'Saving…' : 'Mark declined'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      <label style={labelStyle}>Reason</label>
      <input value={reason} onChange={e => setReason(e.target.value)}
        autoFocus placeholder="Too expensive / went with competitor / etc."
        style={inputStyle} />
    </Modal>
  )
}

function ConvertInvoiceModal({
  quoteId, onClose, onDone,
}: {
  quoteId: string
  onClose: () => void
  onDone: () => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const in30  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const [issueDate, setIssueDate] = useState(today)
  const [dueDate, setDueDate] = useState(in30)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async () => {
    setErr(null); setBusy(true)
    try {
      await apiPost(`/business-quotes/${quoteId}/convert-to-invoice`, { issueDate, dueDate })
      onDone()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Convert failed')
    } finally { setBusy(false) }
  }
  return (
    <Modal title="Convert quote to invoice" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy} style={primaryBtnStyle}>
            {busy ? 'Creating…' : 'Create invoice'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Issue date</label>
          <input type="date" value={issueDate}
            onChange={e => setIssueDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Due date</label>
          <input type="date" value={dueDate}
            onChange={e => setDueDate(e.target.value)} style={inputStyle} />
        </div>
      </div>
      <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-2)', borderRadius: 8, fontSize: 12, color: 'var(--text-2)' }}>
        Lines from the quote will copy into a draft invoice. You can edit and send it from the Invoices page.
      </div>
    </Modal>
  )
}

function ConvertWOModal({
  quoteId, onClose, onDone,
}: {
  quoteId: string
  onClose: () => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async () => {
    setErr(null); setBusy(true)
    try {
      await apiPost(`/business-quotes/${quoteId}/convert-to-work-order`)
      onDone()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Convert failed')
    } finally { setBusy(false) }
  }
  return (
    <Modal title="Convert quote to work order" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy} style={primaryBtnStyle}>
            {busy ? 'Creating…' : 'Create work order'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 8, fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
        Lines (labor + parts + fees) will copy into an <strong style={{ color: 'var(--text-0)' }}>open</strong> work order.
        <strong style={{ color: 'var(--text-0)' }}> Part lines will decrement inventory stock at this step</strong> — this is the first real commit.
      </div>
      <div style={{
        padding: 12,
        background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.4)',
        borderRadius: 8, fontSize: 12, color: 'var(--text-1)',
        display: 'flex', gap: 8, alignItems: 'start',
      }}>
        <AlertTriangle size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
        <span>If the inventory stock dropped below what the quote called for, the convert will fail and you'll need to either restock or remove that part line first.</span>
      </div>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Styles
// ─────────────────────────────────────────────────────────────────

const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden' as const,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left' as const, padding: '12px 16px',
  fontSize: 12, color: 'var(--text-2)',
  textTransform: 'uppercase' as const, letterSpacing: 1,
  background: 'var(--bg-2)', fontWeight: 600,
}
const tdStyle: React.CSSProperties = { padding: '12px 16px', fontSize: 14, color: 'var(--text-1)' }
const labelStyle: React.CSSProperties = {
  display: 'block' as const, fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box' as const,
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const pill: React.CSSProperties = {
  padding: '6px 12px',
  background: 'transparent', color: 'var(--text-2)',
  border: 'none', borderRadius: 6,
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
}
const pillActive: React.CSSProperties = {
  ...pill, background: 'var(--bg-1)', color: 'var(--gold)',
}
const errStyle: React.CSSProperties = {
  marginBottom: 12, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red-dim, #ef4444)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14, marginBottom: 16,
}
