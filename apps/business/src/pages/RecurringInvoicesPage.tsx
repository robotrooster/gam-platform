import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Modal } from '../components/Modal'
import {
  Plus, ChevronRight, ArrowLeft, Pause, Play, X as XIcon, Zap,
  Calendar, Repeat, Trash2,
} from 'lucide-react'

type Frequency = 'weekly' | 'monthly'
type SchedStatus = 'active' | 'paused' | 'ended'

interface ScheduleSummary {
  id: string
  name: string
  frequency: Frequency
  dayOfMonth: number | null
  dayOfWeek: number | null
  startDate: string
  endDate: string | null
  nextDueDate: string
  autoSend: boolean
  paymentTermsDays: number
  status: SchedStatus
  createdInvoiceCount: number
  lastInvoiceId: string | null
  lastGeneratedAt: string | null
  customerId: string
  customerFirstName: string | null
  customerLastName: string | null
  customerCompanyName: string | null
  cycleAmount: string
}

interface ScheduleLine {
  id?: string
  description: string
  quantity: string | number
  unitPrice: string | number
  sortOrder?: number
}

interface ScheduleDetail extends ScheduleSummary {
  customerEmail: string | null
  notes: string | null
  internalNotes: string | null
  lines: ScheduleLine[]
}

interface Customer {
  id: string
  firstName: string | null
  lastName: string | null
  companyName: string | null
}

const DOW_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function customerLabel(r: Pick<ScheduleSummary, 'customerCompanyName' | 'customerFirstName' | 'customerLastName'>): string {
  if (r.customerCompanyName) return r.customerCompanyName
  return `${r.customerFirstName ?? ''} ${r.customerLastName ?? ''}`.trim() || 'Unnamed'
}

function cadenceLabel(s: ScheduleSummary): string {
  if (s.frequency === 'monthly') {
    return `Monthly on the ${ordinal(s.dayOfMonth ?? 1)}`
  }
  return `Weekly on ${DOW_LABEL[s.dayOfWeek ?? 0]}`
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`
  const last = n % 10
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`
}

const STATUS_COLOR: Record<SchedStatus, string> = {
  active: 'var(--green, #22c55e)',
  paused: 'var(--amber)',
  ended:  'var(--text-3)',
}

// ─────────────────────────────────────────────────────────────────
//  Page
// ─────────────────────────────────────────────────────────────────

export function RecurringInvoicesPage() {
  const [list, setList] = useState<ScheduleSummary[]>([])
  const [statusFilter, setStatusFilter] = useState<SchedStatus | 'all'>('active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const rows = await apiGet<ScheduleSummary[]>(
        statusFilter === 'all'
          ? '/business-recurring-invoices'
          : `/business-recurring-invoices?status=${statusFilter}`)
      setList(rows)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [statusFilter])

  if (selectedId) return <Detail id={selectedId} onBack={() => { setSelectedId(null); reload() }} />

  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: 16,
      }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>
            Recurring invoices
          </h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Auto-bill customers on a weekly or monthly cadence. Cron generates each cycle's invoice — auto-send if enabled.
          </div>
        </div>
        <button onClick={() => setShowCreate(true)} style={primaryBtnStyle}>
          <Plus size={14} /> New schedule
        </button>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--bg-2)', borderRadius: 10, marginBottom: 16, width: 'fit-content' }}>
        {(['active', 'paused', 'ended', 'all'] as const).map(s => (
          <button key={s}
            onClick={() => setStatusFilter(s)}
            style={statusFilter === s ? pillActive : pill}>
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div style={emptyStyle}>
          {statusFilter === 'all'
            ? 'No recurring schedules yet. Set one up to auto-bill a customer each cycle.'
            : `No ${statusFilter} schedules.`}
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Customer</th>
              <th style={thStyle}>Cadence</th>
              <th style={thStyle}>Next due</th>
              <th style={thStyle}>Cycle amount</th>
              <th style={thStyle}>Generated</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {list.map(s => (
              <tr key={s.id}
                onClick={() => setSelectedId(s.id)}
                style={{ borderBottom: '1px solid var(--border-0)', cursor: 'pointer' }}>
                <td style={tdStyle}>
                  <strong style={{ color: 'var(--text-0)' }}>{s.name}</strong>
                  {!s.autoSend && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                      Manual review (draft)
                    </div>
                  )}
                </td>
                <td style={tdStyle}>{customerLabel(s)}</td>
                <td style={{ ...tdStyle, fontSize: 12 }}>{cadenceLabel(s)}</td>
                <td style={tdStyle}>{fmtDate(s.nextDueDate)}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontWeight: 600 }}>
                  {fmtMoney(s.cycleAmount)}
                </td>
                <td style={tdStyle}>{s.createdInvoiceCount}</td>
                <td style={tdStyle}><StatusBadge status={s.status} /></td>
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

function StatusBadge({ status }: { status: SchedStatus }) {
  return (
    <span style={{
      padding: '3px 8px', fontSize: 11, fontWeight: 700,
      textTransform: 'uppercase' as const, letterSpacing: 0.5,
      border: `1px solid ${STATUS_COLOR[status]}`,
      color: STATUS_COLOR[status], borderRadius: 4,
    }}>{status}</span>
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
  const today = new Date().toISOString().slice(0, 10)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [form, setForm] = useState({
    customerId: '',
    name: '',
    frequency: 'monthly' as Frequency,
    dayOfMonth: '1',
    dayOfWeek: '1',  // Monday
    startDate: today,
    endDate: '',
    autoSend: true,
    paymentTermsDays: '30',
    notes: '',
  })
  const [lines, setLines] = useState<ScheduleLine[]>([
    { description: '', quantity: 1, unitPrice: 0 },
  ])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiGet<Customer[]>('/business-customers').then(setCustomers).catch(() => {})
  }, [])

  const cycleTotal = lines.reduce((s, l) =>
    s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0)

  const addLine = () => setLines(p => [...p, { description: '', quantity: 1, unitPrice: 0 }])
  const updateLine = (i: number, field: keyof ScheduleLine, value: any) =>
    setLines(p => p.map((l, idx) => idx === i ? { ...l, [field]: value } : l))
  const removeLine = (i: number) =>
    setLines(p => p.length === 1 ? p : p.filter((_, idx) => idx !== i))

  const submit = async () => {
    setErr(null)
    if (!form.customerId) { setErr('Pick a customer'); return }
    if (!form.name.trim()) { setErr('Name is required'); return }
    if (lines.some(l => !l.description.trim() || Number(l.quantity) <= 0)) {
      setErr('Every line needs a description and positive quantity'); return
    }
    setBusy(true)
    try {
      const payload: any = {
        customerId: form.customerId,
        name: form.name.trim(),
        frequency: form.frequency,
        startDate: form.startDate,
        endDate: form.endDate || null,
        autoSend: form.autoSend,
        paymentTermsDays: parseInt(form.paymentTermsDays, 10) || 30,
        notes: form.notes.trim() || null,
        lines: lines.map(l => ({
          description: String(l.description).trim(),
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
        })),
      }
      if (form.frequency === 'monthly') payload.dayOfMonth = parseInt(form.dayOfMonth, 10)
      else                              payload.dayOfWeek  = parseInt(form.dayOfWeek, 10)
      const r = await apiPost<{ id: string }>('/business-recurring-invoices', payload)
      onCreated(r.data.id)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Create failed')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="New recurring schedule" onClose={onClose} width={680}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy} style={primaryBtnStyle}>
            {busy ? 'Creating…' : 'Create schedule'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Customer</label>
          <select value={form.customerId} onChange={e => setForm({ ...form, customerId: e.target.value })}
            style={inputStyle}>
            <option value="">Pick a customer…</option>
            {customers.map(c => (
              <option key={c.id} value={c.id}>
                {c.companyName || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Unnamed'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Schedule name</label>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="Monthly lawn service" style={inputStyle} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Frequency</label>
          <select value={form.frequency}
            onChange={e => setForm({ ...form, frequency: e.target.value as Frequency })}
            style={inputStyle}>
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        {form.frequency === 'monthly' ? (
          <div>
            <label style={labelStyle}>Day of month (1–28)</label>
            <input type="number" min="1" max="28" value={form.dayOfMonth}
              onChange={e => setForm({ ...form, dayOfMonth: e.target.value })}
              style={inputStyle} />
          </div>
        ) : (
          <div>
            <label style={labelStyle}>Day of week</label>
            <select value={form.dayOfWeek}
              onChange={e => setForm({ ...form, dayOfWeek: e.target.value })}
              style={inputStyle}>
              {DOW_LABEL.map((label, idx) => (
                <option key={idx} value={idx}>{label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Start date</label>
          <input type="date" value={form.startDate}
            onChange={e => setForm({ ...form, startDate: e.target.value })}
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>End date (optional)</label>
          <input type="date" value={form.endDate}
            onChange={e => setForm({ ...form, endDate: e.target.value })}
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Payment terms (days)</label>
          <input type="number" min="1" max="365" value={form.paymentTermsDays}
            onChange={e => setForm({ ...form, paymentTermsDays: e.target.value })}
            style={inputStyle} />
        </div>
      </div>

      <label style={{
        display: 'flex' as const, alignItems: 'center', gap: 8,
        marginTop: 12, padding: 10,
        background: form.autoSend ? 'rgba(34,197,94,.06)' : 'var(--bg-2)',
        border: `1px solid ${form.autoSend ? 'rgba(34,197,94,.4)' : 'var(--border-1)'}`,
        borderRadius: 8, cursor: 'pointer', fontSize: 13,
      }}>
        <input type="checkbox" checked={form.autoSend}
          onChange={e => setForm({ ...form, autoSend: e.target.checked })} />
        <span style={{ color: 'var(--text-1)' }}>
          Auto-send the generated invoice to the customer each cycle
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>
          {form.autoSend ? 'auto-send' : 'manual review'}
        </span>
      </label>

      <label style={labelStyle}>Line items (template — copied to each invoice)</label>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
        {lines.map((line, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '3fr 1fr 1fr auto', gap: 8,
            alignItems: 'center',
          }}>
            <input value={line.description}
              onChange={e => updateLine(i, 'description', e.target.value)}
              placeholder="Description"
              style={{ ...inputStyle, marginTop: 0 }} />
            <input type="number" step="0.01" min="0.01"
              value={line.quantity}
              onChange={e => updateLine(i, 'quantity', e.target.value)}
              placeholder="Qty"
              style={{ ...inputStyle, marginTop: 0 }} />
            <input type="number" step="0.01" min="0"
              value={line.unitPrice}
              onChange={e => updateLine(i, 'unitPrice', e.target.value)}
              placeholder="Unit price"
              style={{ ...inputStyle, marginTop: 0 }} />
            <button onClick={() => removeLine(i)}
              disabled={lines.length === 1}
              style={{
                background: 'transparent', border: 'none',
                color: 'var(--text-3)', cursor: lines.length === 1 ? 'not-allowed' : 'pointer',
                opacity: lines.length === 1 ? 0.3 : 1,
                padding: 4,
              }}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <button onClick={addLine} style={{
        ...ghostBtn, marginTop: 8, padding: '6px 12px', fontSize: 12,
      }}>
        <Plus size={12} /> Add line
      </button>

      <div style={{
        marginTop: 16, padding: 12,
        background: 'var(--bg-2)', borderRadius: 8,
        display: 'flex', justifyContent: 'space-between' as const,
        fontSize: 14,
      }}>
        <span style={{ color: 'var(--text-2)' }}>Cycle total</span>
        <strong style={{ color: 'var(--gold)', fontFamily: 'var(--font-mono)' as const, fontSize: 16 }}>
          {fmtMoney(cycleTotal)}
        </strong>
      </div>

      <label style={labelStyle}>Notes (shown on the invoice — optional)</label>
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
  const [s, setS] = useState<ScheduleDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    setErr(null)
    try {
      const d = await apiGet<ScheduleDetail>(`/business-recurring-invoices/${id}`)
      setS(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [id])

  const action = async (path: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    setErr(null); setBusy(true)
    try {
      await apiPost(`/business-recurring-invoices/${id}/${path}`)
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || `${path} failed`)
    } finally { setBusy(false) }
  }

  const toggleAutoSend = async () => {
    if (!s) return
    try {
      await apiPatch(`/business-recurring-invoices/${id}`, { autoSend: !s.autoSend })
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Update failed')
    }
  }

  if (!s) return (
    <div>
      <button onClick={onBack} style={ghostBtn}><ArrowLeft size={14} /> Back</button>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ marginTop: 16, color: 'var(--text-2)' }}>Loading…</div>
    </div>
  )

  const cycleTotal = s.lines.reduce((a, l) =>
    a + Number(l.quantity) * Number(l.unitPrice), 0)

  return (
    <div>
      <button onClick={onBack} style={ghostBtn}>
        <ArrowLeft size={14} /> Back to schedules
      </button>
      {err && <div style={{ ...errStyle, marginTop: 16 }}>{err}</div>}

      <div style={{
        marginTop: 16, padding: 24,
        background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, margin: 0 }}>{s.name}</h1>
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 4 }}>
              {customerLabel(s)}{s.customerEmail && <> · {s.customerEmail}</>}
            </div>
          </div>
          <StatusBadge status={s.status} />
        </div>

        {/* Action row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' as const }}>
          {s.status === 'active' && (
            <>
              <button onClick={() => action('generate-now',
                  `Generate an invoice now? This will create ${s.autoSend ? 'and send' : 'a draft for'} an invoice for ${customerLabel(s)} immediately.`)}
                disabled={busy} style={primaryBtnStyle}>
                <Zap size={12} /> Generate now
              </button>
              <button onClick={() => action('pause')} disabled={busy} style={ghostBtn}>
                <Pause size={12} /> Pause
              </button>
            </>
          )}
          {s.status === 'paused' && (
            <button onClick={() => action('resume')} disabled={busy} style={primaryBtnStyle}>
              <Play size={12} /> Resume
            </button>
          )}
          {s.status !== 'ended' && (
            <button onClick={() => action('end',
                'End this schedule? It will stop generating new invoices. This is permanent.')}
              disabled={busy} style={ghostBtn}>
              <XIcon size={12} /> End schedule
            </button>
          )}
        </div>

        {/* Stats grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          <Stat label="Cadence" value={cadenceLabel(s)} icon={<Repeat size={14} />} />
          <Stat label="Next due" value={fmtDate(s.nextDueDate)} icon={<Calendar size={14} />} />
          <Stat label="Cycle amount" value={fmtMoney(cycleTotal)} accent />
          <Stat label="Generated" value={`${s.createdInvoiceCount} invoice${s.createdInvoiceCount === 1 ? '' : 's'}`} />
        </div>

        {/* Auto-send + terms */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <label style={{
            display: 'flex' as const, alignItems: 'center', gap: 8, padding: 10,
            background: s.autoSend ? 'rgba(34,197,94,.06)' : 'var(--bg-2)',
            border: `1px solid ${s.autoSend ? 'rgba(34,197,94,.4)' : 'var(--border-1)'}`,
            borderRadius: 8, fontSize: 13, cursor: s.status !== 'ended' ? 'pointer' : 'default',
            flex: 1,
          }}>
            <input type="checkbox" checked={s.autoSend}
              disabled={s.status === 'ended'}
              onChange={toggleAutoSend} />
            <span style={{ color: 'var(--text-1)' }}>
              Auto-send each cycle
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>
              {s.autoSend ? 'On' : 'Off — drafts only'}
            </span>
          </label>
          <div style={{
            padding: 10,
            background: 'var(--bg-2)', border: '1px solid var(--border-1)',
            borderRadius: 8, fontSize: 13, color: 'var(--text-2)',
            display: 'flex' as const, alignItems: 'center',
          }}>
            Payment terms: <strong style={{ color: 'var(--text-0)', marginLeft: 6 }}>
              {s.paymentTermsDays} days
            </strong>
          </div>
        </div>

        {s.lastGeneratedAt && (
          <div style={{
            padding: 12, marginBottom: 20,
            background: 'rgba(212,175,55,.04)',
            border: '1px solid rgba(212,175,55,.2)',
            borderRadius: 8, fontSize: 13, color: 'var(--text-2)',
          }}>
            Last invoice generated: <strong style={{ color: 'var(--text-0)' }}>{fmtDateTime(s.lastGeneratedAt)}</strong>
          </div>
        )}

        {/* Lines */}
        <h2 style={h2Style}>Line items (template)</h2>
        <table style={{ ...tableStyle, marginBottom: 16 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Description</th>
              <th style={thStyle}>Qty</th>
              <th style={thStyle}>Unit price</th>
              <th style={thStyle}>Line total</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map(ln => {
              const lt = Number(ln.quantity) * Number(ln.unitPrice)
              return (
                <tr key={ln.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                  <td style={tdStyle}>{ln.description}</td>
                  <td style={tdStyle}>{Number(ln.quantity)}</td>
                  <td style={tdStyle}>{fmtMoney(ln.unitPrice)}</td>
                  <td style={{ ...tdStyle, fontWeight: 600, fontFamily: 'var(--font-mono)' as const }}>
                    {fmtMoney(lt)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {s.notes && (
          <div style={{
            padding: 12, background: 'var(--bg-2)', borderRadius: 8,
            fontSize: 13, color: 'var(--text-1)',
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 4 }}>
              Customer-visible notes
            </div>
            {s.notes}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, icon, accent }: { label: string; value: string; icon?: React.ReactNode; accent?: boolean }) {
  return (
    <div style={{
      padding: 14, background: 'var(--bg-2)', borderRadius: 8,
    }}>
      <div style={{
        fontSize: 11, color: 'var(--text-3)',
        textTransform: 'uppercase' as const, letterSpacing: 1,
        marginBottom: 6,
        display: 'flex' as const, gap: 5, alignItems: 'center',
      }}>
        {icon} {label}
      </div>
      <div style={{
        fontSize: 14, fontWeight: 600,
        color: accent ? 'var(--gold)' : 'var(--text-0)',
      }}>
        {value}
      </div>
    </div>
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
const h2Style: React.CSSProperties = {
  fontSize: 14, color: 'var(--text-2)',
  textTransform: 'uppercase' as const, letterSpacing: 1,
  margin: '0 0 12px 0', fontWeight: 600,
}
