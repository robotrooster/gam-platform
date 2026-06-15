import { useEffect, useState } from 'react'
import { apiGet, apiPost, openPdfInNewTab } from '../lib/api'
import { Modal } from '../components/Modal'
import { Plus, Trash, ChevronRight, ArrowLeft, Check, X, Printer } from 'lucide-react'

interface CustomerLite {
  id: string
  firstName: string
  lastName: string
  companyName: string | null
}

interface InvoiceRow {
  id: string
  invoiceNumber: string
  status: 'draft' | 'sent' | 'paid' | 'void'
  issueDate: string
  dueDate: string
  subtotal: string
  taxAmount: string
  totalAmount: string
  amountPaid: string
  sentAt: string | null
  paidAt: string | null
  voidedAt: string | null
  createdAt: string
  customerFirstName: string
  customerLastName: string
  customerCompanyName: string | null
}

interface InvoiceLine {
  id: string
  sortOrder: number
  description: string
  quantity: string
  unitPrice: string
  lineTotal: string
}

interface InvoiceDetail extends InvoiceRow {
  customerEmail: string | null
  notes: string | null
  internalNotes: string | null
  paymentMethod: string | null
  voidReason: string | null
  hostedPayUrl: string | null
  lines: InvoiceLine[]
  // S508 auto-charge audit
  autoChargeAttemptedAt: string | null
  autoChargeLastError: string | null
  sourceRecurringScheduleId: string | null
  stripePaymentIntentId: string | null
}

const STATUS_TONE: Record<InvoiceRow['status'], { bg: string; color: string; label: string }> = {
  draft: { bg: 'var(--bg-2)',   color: 'var(--text-2)', label: 'Draft' },
  sent:  { bg: 'rgba(245,158,11,.1)', color: 'var(--amber)', label: 'Sent' },
  paid:  { bg: 'rgba(34,197,94,.1)',  color: 'var(--green, #22c55e)', label: 'Paid' },
  void:  { bg: 'var(--bg-2)',   color: 'var(--text-3)', label: 'Void' },
}

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString()
}

export function InvoicesPage() {
  const [rows, setRows] = useState<InvoiceRow[]>([])
  const [customers, setCustomers] = useState<CustomerLite[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<InvoiceRow['status'] | ''>('')
  const [showCreate, setShowCreate] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const [list, cs] = await Promise.all([
        apiGet<InvoiceRow[]>(`/business-invoices${statusFilter ? `?status=${statusFilter}` : ''}`),
        apiGet<CustomerLite[]>('/business-customers'),
      ])
      setRows(list)
      setCustomers(cs)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load invoices')
    } finally { setLoading(false) }
  }

  useEffect(() => { reload() }, [statusFilter])

  if (selectedId) {
    return <InvoiceDetailView id={selectedId}
      onBack={() => setSelectedId(null)}
      onChange={() => reload()} />
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>
            Invoices
          </h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Bill customers for services rendered. Mark paid when cash/check arrives;
            online payment lands in the next update.
          </div>
        </div>
        <button onClick={() => setShowCreate(true)}
          disabled={customers.length === 0}
          style={primaryBtnStyle}>
          <Plus size={14} /> New invoice
        </button>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      {customers.length === 0 && (
        <div style={emptyStyle}>
          Add a <strong style={{ color: 'var(--gold)' }}>customer</strong> first
          — invoices attach to a customer.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Filter</span>
        {(['', 'draft', 'sent', 'paid', 'void'] as const).map(s => (
          <button key={s || 'all'} onClick={() => setStatusFilter(s)}
            style={{
              padding: '6px 12px',
              background: statusFilter === s ? 'var(--gold-bg)' : 'var(--bg-2)',
              color: statusFilter === s ? 'var(--gold)' : 'var(--text-1)',
              border: `1px solid ${statusFilter === s ? 'var(--gold)' : 'var(--border-1)'}`,
              borderRadius: 6,
              fontSize: 12,
              cursor: 'pointer',
              textTransform: 'capitalize' as const,
            }}>
            {s || 'all'}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-2)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={emptyStyle}>
          {statusFilter ? `No ${statusFilter} invoices.` : 'No invoices yet.'}
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Number</th>
              <th style={thStyle}>Customer</th>
              <th style={thStyle}>Issued</th>
              <th style={thStyle}>Due</th>
              <th style={thStyle}>Total</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}
                onClick={() => setSelectedId(r.id)}
                style={{ borderBottom: '1px solid var(--border-0)', cursor: 'pointer' }}>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }}>
                  {r.invoiceNumber}
                </td>
                <td style={tdStyle}>
                  {r.customerCompanyName
                    ? r.customerCompanyName
                    : `${r.customerFirstName} ${r.customerLastName}`}
                </td>
                <td style={tdStyle}>{fmtDate(r.issueDate)}</td>
                <td style={tdStyle}>{fmtDate(r.dueDate)}</td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{fmtMoney(r.totalAmount)}</td>
                <td style={tdStyle}>
                  <span style={{
                    display: 'inline-block', padding: '3px 10px', borderRadius: 6,
                    fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                    background: STATUS_TONE[r.status].bg,
                    color: STATUS_TONE[r.status].color,
                  }}>{STATUS_TONE[r.status].label}</span>
                </td>
                <td style={tdStyle}><ChevronRight size={14} color="var(--text-3)" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <CreateInvoiceModal
          customers={customers}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); reload() }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Detail view
// ─────────────────────────────────────────────────────────────────

function InvoiceDetailView({
  id, onBack, onChange,
}: { id: string; onBack: () => void; onChange: () => void }) {
  const [inv, setInv] = useState<InvoiceDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [actioning, setActioning] = useState(false)
  const [showMarkPaid, setShowMarkPaid] = useState(false)
  const [showVoid, setShowVoid] = useState(false)

  const reload = async () => {
    try {
      const d = await apiGet<InvoiceDetail>(`/business-invoices/${id}`)
      setInv(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load invoice')
    }
  }
  useEffect(() => { reload() }, [id])

  const onSend = async () => {
    setActioning(true); setErr(null)
    try {
      await apiPost(`/business-invoices/${id}/send`)
      await reload()
      onChange()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Send failed')
    } finally { setActioning(false) }
  }

  if (!inv) {
    return (
      <div>
        <button onClick={onBack} style={ghostBtn}><ArrowLeft size={14} /> Back</button>
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ color: 'var(--text-2)', marginTop: 16 }}>Loading…</div>
      </div>
    )
  }

  const tone = STATUS_TONE[inv.status]
  const customerName = inv.customerCompanyName
    ? inv.customerCompanyName
    : `${inv.customerFirstName} ${inv.customerLastName}`

  return (
    <div>
      <button onClick={onBack} style={ghostBtn}>
        <ArrowLeft size={14} /> Back to invoices
      </button>

      {err && <div style={{ ...errStyle, marginTop: 16 }}>{err}</div>}

      <div style={{
        marginTop: 16, padding: 24,
        background: 'var(--bg-1)', border: '1px solid var(--border-0)',
        borderRadius: 12,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: 'var(--text-0)' }}>
              {inv.invoiceNumber}
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 4 }}>
              {customerName}
              {inv.customerEmail && ` · ${inv.customerEmail}`}
            </div>
          </div>
          <span style={{
            padding: '6px 14px', borderRadius: 6,
            fontSize: 12, fontWeight: 700, letterSpacing: 0.5,
            background: tone.bg, color: tone.color,
          }}>{tone.label}</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
          <Field label="Issued" value={fmtDate(inv.issueDate)} />
          <Field label="Due"    value={fmtDate(inv.dueDate)} />
          <Field label="Total"  value={fmtMoney(inv.totalAmount)} accent />
        </div>

        {/* S508: auto-charge banner */}
        {inv.status === 'paid' && inv.autoChargeAttemptedAt && !inv.autoChargeLastError && (
          <div style={{
            padding: 12, marginBottom: 16,
            background: 'rgba(34,197,94,.06)',
            border: '1px solid rgba(34,197,94,.4)',
            borderRadius: 8, fontSize: 13, color: 'var(--text-1)',
          }}>
            <strong style={{ color: 'var(--green, #22c55e)' }}>✓ Auto-paid</strong> via saved card on {fmtDate(inv.autoChargeAttemptedAt)}. No customer action required.
          </div>
        )}
        {inv.status !== 'paid' && inv.autoChargeLastError && (
          <div style={{
            padding: 12, marginBottom: 16,
            background: 'rgba(239,68,68,.06)',
            border: '1px solid rgba(239,68,68,.4)',
            borderRadius: 8, fontSize: 13, color: 'var(--text-1)',
          }}>
            <strong style={{ color: 'var(--red, #ef4444)' }}>Auto-charge failed</strong> ({fmtDate(inv.autoChargeAttemptedAt)}). The customer has been emailed a checkout link to update their card.
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, fontFamily: 'var(--font-mono)' as const }}>
              {inv.autoChargeLastError}
            </div>
          </div>
        )}

        {inv.notes && (
          <div style={{
            padding: 12, marginBottom: 16,
            background: 'var(--bg-2)', borderRadius: 8,
            fontSize: 13, color: 'var(--text-1)',
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
              Notes (customer-visible)
            </div>
            {inv.notes}
          </div>
        )}

        {/* S494: hosted-pay URL when invoice has been sent with Stripe Connect */}
        {inv.status === 'sent' && inv.hostedPayUrl && (
          <PayLinkCard url={inv.hostedPayUrl} />
        )}

        {/* Lines */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={{ ...thStyle, textAlign: 'left' as const }}>Description</th>
              <th style={{ ...thStyle, textAlign: 'right' as const }}>Qty</th>
              <th style={{ ...thStyle, textAlign: 'right' as const }}>Price</th>
              <th style={{ ...thStyle, textAlign: 'right' as const }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map(l => (
              <tr key={l.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                <td style={tdStyle}>{l.description}</td>
                <td style={{ ...tdStyle, textAlign: 'right' as const }}>{l.quantity}</td>
                <td style={{ ...tdStyle, textAlign: 'right' as const, fontFamily: 'var(--font-mono)' }}>
                  {fmtMoney(l.unitPrice)}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right' as const, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {fmtMoney(l.lineTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, fontSize: 14 }}>
          <div style={{ textAlign: 'right' as const }}>
            <div style={{ color: 'var(--text-3)', marginBottom: 4 }}>Subtotal</div>
            <div style={{ color: 'var(--text-3)', marginBottom: 4 }}>Tax</div>
            <div style={{ color: 'var(--text-0)', fontWeight: 700 }}>Total</div>
          </div>
          <div style={{ textAlign: 'right' as const, fontFamily: 'var(--font-mono)' }}>
            <div style={{ marginBottom: 4 }}>{fmtMoney(inv.subtotal)}</div>
            <div style={{ marginBottom: 4 }}>{fmtMoney(inv.taxAmount)}</div>
            <div style={{ color: 'var(--gold)', fontWeight: 700 }}>{fmtMoney(inv.totalAmount)}</div>
          </div>
        </div>

        {inv.status === 'paid' && (
          <div style={{
            marginTop: 20, padding: 12,
            background: 'rgba(34,197,94,.06)', border: '1px solid rgba(34,197,94,.3)',
            borderRadius: 8, fontSize: 13, color: 'var(--text-1)',
          }}>
            <Check size={14} style={{ color: 'var(--green, #22c55e)', marginRight: 6, verticalAlign: 'middle' }} />
            Paid {fmtDate(inv.paidAt)}
            {inv.paymentMethod && ` via ${inv.paymentMethod}`} · {fmtMoney(inv.amountPaid)}
          </div>
        )}
        {inv.status === 'void' && (
          <div style={{
            marginTop: 20, padding: 12,
            background: 'var(--bg-2)', border: '1px solid var(--border-1)',
            borderRadius: 8, fontSize: 13, color: 'var(--text-2)',
          }}>
            <X size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Voided {fmtDate(inv.voidedAt)}{inv.voidReason && ` — ${inv.voidReason}`}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={() => openPdfInNewTab(`/business-invoices/${id}/pdf`)}
            style={ghostActionBtnStyle}>
            <Printer size={14} /> Print
          </button>
          {inv.status === 'draft' && (
            <button onClick={onSend} disabled={actioning} style={primaryBtnStyle}>
              Send invoice
            </button>
          )}
          {(inv.status === 'draft' || inv.status === 'sent') && (
            <button onClick={() => setShowMarkPaid(true)} style={successBtnStyle}>
              <Check size={14} /> Mark paid
            </button>
          )}
          {(inv.status === 'draft' || inv.status === 'sent') && (
            <button onClick={() => setShowVoid(true)} style={dangerBtnStyle}>
              <Trash size={14} /> Void
            </button>
          )}
        </div>
      </div>

      {showMarkPaid && (
        <MarkPaidModal invoiceId={id}
          defaultAmount={Number(inv.totalAmount)}
          onClose={() => setShowMarkPaid(false)}
          onSuccess={() => { setShowMarkPaid(false); reload(); onChange() }} />
      )}
      {showVoid && (
        <VoidModal invoiceId={id}
          onClose={() => setShowVoid(false)}
          onSuccess={() => { setShowVoid(false); reload(); onChange() }} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Create modal
// ─────────────────────────────────────────────────────────────────

function CreateInvoiceModal({
  customers, onClose, onCreated,
}: {
  customers: CustomerLite[]
  onClose: () => void
  onCreated: () => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const dueDefault = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const [form, setForm] = useState({
    customerId: customers[0]?.id ?? '',
    issueDate: today,
    dueDate: dueDefault,
    taxAmount: '0',
    notes: '',
    lines: [{ description: '', quantity: '1', unitPrice: '' }],
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const subtotal = form.lines.reduce((acc, l) => {
    const q = parseFloat(l.quantity) || 0
    const p = parseFloat(l.unitPrice) || 0
    return acc + (q * p)
  }, 0)
  const tax = parseFloat(form.taxAmount) || 0
  const total = subtotal + tax

  const updLine = (i: number, key: 'description' | 'quantity' | 'unitPrice', val: string) => {
    const next = [...form.lines]
    next[i] = { ...next[i], [key]: val }
    setForm({ ...form, lines: next })
  }

  const addLine = () => {
    setForm({ ...form, lines: [...form.lines, { description: '', quantity: '1', unitPrice: '' }] })
  }
  const rmLine = (i: number) => {
    if (form.lines.length === 1) return
    setForm({ ...form, lines: form.lines.filter((_, idx) => idx !== i) })
  }

  const onSubmit = async () => {
    setErr(null)
    if (!form.customerId) { setErr('Pick a customer'); return }
    const cleanLines = form.lines
      .map(l => ({
        description: l.description.trim(),
        quantity: parseFloat(l.quantity),
        unitPrice: parseFloat(l.unitPrice),
      }))
      .filter(l => l.description && Number.isFinite(l.quantity) && Number.isFinite(l.unitPrice))
    if (cleanLines.length === 0) { setErr('Add at least one line item'); return }

    setSaving(true)
    try {
      await apiPost('/business-invoices', {
        customerId: form.customerId,
        issueDate: form.issueDate,
        dueDate:   form.dueDate,
        taxAmount: tax,
        notes:     form.notes || undefined,
        lines:     cleanLines,
      })
      onCreated()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Create failed')
    } finally { setSaving(false) }
  }

  return (
    <Modal
      title="New invoice"
      onClose={onClose}
      width={680}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={onSubmit} disabled={saving} style={primaryBtnStyle}>
            {saving ? 'Creating…' : 'Create as draft'}
          </button>
        </>
      }
    >
      {err && <div style={errStyle}>{err}</div>}
      <label style={labelStyle}>Customer</label>
      <select value={form.customerId}
        onChange={e => setForm({ ...form, customerId: e.target.value })}
        style={inputStyle}>
        {customers.map(c => (
          <option key={c.id} value={c.id}>
            {c.companyName
              ? `${c.companyName} (${c.firstName} ${c.lastName})`
              : `${c.firstName} ${c.lastName}`}
          </option>
        ))}
      </select>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Issue date</label>
          <input type="date" value={form.issueDate}
            onChange={e => setForm({ ...form, issueDate: e.target.value })}
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Due date</label>
          <input type="date" value={form.dueDate}
            onChange={e => setForm({ ...form, dueDate: e.target.value })}
            style={inputStyle} />
        </div>
      </div>

      <label style={labelStyle}>Line items</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {form.lines.map((l, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '2fr 80px 110px 120px 32px',
            gap: 6, alignItems: 'center',
          }}>
            <input placeholder="Description"
              value={l.description}
              onChange={e => updLine(i, 'description', e.target.value)}
              style={inputStyle} />
            <input placeholder="Qty"
              value={l.quantity}
              onChange={e => updLine(i, 'quantity', e.target.value)}
              type="number" step="0.5" min="0"
              style={inputStyle} />
            <input placeholder="Unit price"
              value={l.unitPrice}
              onChange={e => updLine(i, 'unitPrice', e.target.value)}
              type="number" step="0.01" min="0"
              style={inputStyle} />
            <div style={{
              padding: '10px 8px', fontSize: 13, fontFamily: 'var(--font-mono)',
              color: 'var(--text-1)', textAlign: 'right' as const,
            }}>
              {fmtMoney((parseFloat(l.quantity) || 0) * (parseFloat(l.unitPrice) || 0))}
            </div>
            <button onClick={() => rmLine(i)}
              disabled={form.lines.length === 1}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-3)', padding: 4,
              }}>
              <X size={14} />
            </button>
          </div>
        ))}
        <button type="button" onClick={addLine} style={{
          ...ghostBtn, alignSelf: 'flex-start', marginTop: 4,
        }}>
          <Plus size={12} /> Add line
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <div>
          <label style={labelStyle}>Tax</label>
          <input value={form.taxAmount}
            onChange={e => setForm({ ...form, taxAmount: e.target.value })}
            type="number" step="0.01" min="0"
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Total</label>
          <div style={{
            padding: '10px 12px',
            background: 'var(--bg-2)',
            border: '1px solid var(--border-1)', borderRadius: 8,
            color: 'var(--gold)', fontWeight: 700,
            fontFamily: 'var(--font-mono)',
          }}>
            {fmtMoney(total)}
          </div>
        </div>
      </div>

      <label style={labelStyle}>Notes for customer (optional)</label>
      <textarea value={form.notes}
        onChange={e => setForm({ ...form, notes: e.target.value })}
        rows={3}
        style={{ ...inputStyle, fontFamily: 'var(--font-body)', resize: 'vertical' as const }} />
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Mark-paid + Void modals
// ─────────────────────────────────────────────────────────────────

function MarkPaidModal({
  invoiceId, defaultAmount, onClose, onSuccess,
}: {
  invoiceId: string
  defaultAmount: number
  onClose: () => void
  onSuccess: () => void
}) {
  const [method, setMethod] = useState<'cash' | 'check' | 'ach' | 'card' | 'other'>('cash')
  const [amount, setAmount] = useState(String(defaultAmount.toFixed(2)))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setSaving(true); setErr(null)
    try {
      await apiPost(`/business-invoices/${invoiceId}/mark-paid`, {
        paymentMethod: method,
        amount:        parseFloat(amount),
      })
      onSuccess()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Mark paid failed')
    } finally { setSaving(false) }
  }

  return (
    <Modal
      title="Mark invoice paid"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={saving} style={successBtnStyle}>
            {saving ? 'Saving…' : 'Mark paid'}
          </button>
        </>
      }
    >
      {err && <div style={errStyle}>{err}</div>}
      <label style={labelStyle}>Payment method</label>
      <select value={method}
        onChange={e => setMethod(e.target.value as any)}
        style={inputStyle}>
        <option value="cash">Cash</option>
        <option value="check">Check</option>
        <option value="ach">ACH transfer</option>
        <option value="card">Card</option>
        <option value="other">Other</option>
      </select>

      <label style={labelStyle}>Amount</label>
      <input value={amount}
        onChange={e => setAmount(e.target.value)}
        type="number" step="0.01" min="0"
        style={inputStyle} />
    </Modal>
  )
}

function VoidModal({
  invoiceId, onClose, onSuccess,
}: {
  invoiceId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!reason.trim()) { setErr('Reason required'); return }
    setSaving(true); setErr(null)
    try {
      await apiPost(`/business-invoices/${invoiceId}/void`, { reason: reason.trim() })
      onSuccess()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Void failed')
    } finally { setSaving(false) }
  }

  return (
    <Modal
      title="Void invoice"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={saving} style={dangerBtnStyle}>
            {saving ? 'Voiding…' : 'Void invoice'}
          </button>
        </>
      }
    >
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
        Voiding cancels the invoice. It won't be deleted — it stays on
        record with the reason you provide.
      </div>
      <label style={labelStyle}>Reason</label>
      <input value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Wrong customer / duplicate / etc."
        style={inputStyle} />
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────

function PayLinkCard({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* fall through silently */ }
  }
  return (
    <div style={{
      padding: 14, marginBottom: 16,
      background: 'rgba(34,197,94,.06)',
      border: '1px solid rgba(34,197,94,.3)',
      borderRadius: 8,
    }}>
      <div style={{
        fontSize: 11, color: 'var(--green, #22c55e)',
        textTransform: 'uppercase' as const, letterSpacing: 1,
        fontWeight: 700, marginBottom: 8,
      }}>
        Hosted payment link
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 10 }}>
        Send this link to your customer. They can pay by card or ACH on Stripe's secure
        page; funds settle to your Connect account.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="text"
          value={url}
          readOnly
          onClick={e => (e.target as HTMLInputElement).select()}
          style={{
            flex: 1, padding: '10px 12px',
            background: 'var(--bg-2)', color: 'var(--text-0)',
            border: '1px solid var(--border-1)', borderRadius: 6,
            fontSize: 12, fontFamily: 'var(--font-mono)',
          }}
        />
        <button onClick={copy}
          style={{
            padding: '10px 14px',
            background: copied ? 'var(--green, #22c55e)' : 'var(--gold)',
            color: 'var(--bg-0)',
            border: 'none', borderRadius: 6,
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
            whiteSpace: 'nowrap' as const,
          }}>
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{
        fontSize: 16, fontWeight: 700,
        color: accent ? 'var(--gold)' : 'var(--text-0)',
      }}>{value}</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Styles
// ─────────────────────────────────────────────────────────────────

const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden',
}
const thStyle: React.CSSProperties = {
  textAlign: 'left' as const, padding: '12px 16px',
  fontSize: 12, color: 'var(--text-2)',
  textTransform: 'uppercase' as const,
  letterSpacing: 1, background: 'var(--bg-2)',
  fontWeight: 600,
}
const tdStyle: React.CSSProperties = {
  padding: '14px 16px', fontSize: 14, color: 'var(--text-1)',
}
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box' as const,
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 13, fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
const successBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'rgba(34,197,94,.12)', color: 'var(--green, #22c55e)',
  border: '1px solid var(--green, #22c55e)', borderRadius: 8,
  fontSize: 13, fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
const ghostActionBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 13, fontWeight: 500,
  cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const dangerBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'rgba(239,68,68,.08)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red, #ef4444)', borderRadius: 8,
  fontSize: 13, fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
const errStyle: React.CSSProperties = {
  marginBottom: 12, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red-dim, #ef4444)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14,
  marginBottom: 16,
}
