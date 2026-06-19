import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiDelete, openPdfInNewTab } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { AttachmentList } from '../components/AttachmentList'
import { Modal } from '../components/Modal'
import {
  Plus, ChevronRight, ArrowLeft, Search, Wrench, Trash2,
  Receipt, AlertTriangle, Car, Printer, Play, Square, Clock,
} from 'lucide-react'

type WorkOrderStatus = 'open' | 'in_progress' | 'awaiting_parts' | 'completed' | 'cancelled'

interface WorkOrderSummary {
  id: string
  woNumber: string
  status: WorkOrderStatus
  complaint: string | null
  laborSubtotal: string
  partsSubtotal: string
  taxAmount: string
  totalAmount: string
  customerId: string
  customerFirstName: string | null
  customerLastName: string | null
  customerCompanyName: string | null
  vehicleId: string | null
  vehicleYear: number | null
  vehicleMake: string | null
  vehicleModel: string | null
  vehicleLicensePlate: string | null
  invoiceId: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdAt: string
}

interface WorkOrderLine {
  id: string
  lineType: 'labor' | 'part' | 'fee'
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

interface TimeEntry {
  id: string
  userId: string
  techFirstName: string | null
  techLastName: string | null
  startedAt: string
  endedAt: string | null
  durationMinutes: number | null
  note: string | null
  billedAt: string | null
}

interface WorkOrderDetail extends WorkOrderSummary {
  intakeMileage: number | null
  closeoutMileage: number | null
  closeoutNotes: string | null
  cancelReason: string | null
  customerPhone: string | null
  customerEmail: string | null
  vehicleVin: string | null
  appointmentId: string | null
  assignedToUserId: string | null
  lines: WorkOrderLine[]
  timeEntries: TimeEntry[]
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

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function customerLabel(c: Pick<WorkOrderSummary,
  'customerCompanyName' | 'customerFirstName' | 'customerLastName'>): string {
  if (c.customerCompanyName) return c.customerCompanyName
  const n = `${c.customerFirstName ?? ''} ${c.customerLastName ?? ''}`.trim()
  return n || 'Unnamed'
}

function vehicleLabel(v: Pick<WorkOrderSummary,
  'vehicleYear' | 'vehicleMake' | 'vehicleModel' | 'vehicleLicensePlate'>): string | null {
  const ymm = [v.vehicleYear, v.vehicleMake, v.vehicleModel].filter(Boolean).join(' ')
  if (!ymm && !v.vehicleLicensePlate) return null
  return ymm || `Plate ${v.vehicleLicensePlate}`
}

const STATUS_LABEL: Record<WorkOrderStatus, { label: string; color: string }> = {
  open:            { label: 'Open',            color: 'var(--text-1)' },
  in_progress:     { label: 'In progress',     color: 'var(--gold)' },
  awaiting_parts:  { label: 'Awaiting parts',  color: 'var(--amber)' },
  completed:       { label: 'Completed',       color: 'var(--green, #22c55e)' },
  cancelled:       { label: 'Cancelled',       color: 'var(--text-3)' },
}

const VALID_NEXT: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  open:           ['in_progress', 'awaiting_parts', 'completed', 'cancelled'],
  in_progress:    ['open', 'awaiting_parts', 'completed', 'cancelled'],
  awaiting_parts: ['open', 'in_progress', 'completed', 'cancelled'],
  completed:      [],
  cancelled:      [],
}

// ─────────────────────────────────────────────────────────────────
//  Top-level page
// ─────────────────────────────────────────────────────────────────

export function WorkOrdersPage() {
  const [list, setList] = useState<WorkOrderSummary[]>([])
  const [statusFilter, setStatusFilter] = useState<WorkOrderStatus | 'all'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const rows = await apiGet<WorkOrderSummary[]>(
        statusFilter === 'all'
          ? '/business-work-orders'
          : `/business-work-orders?status=${statusFilter}`)
      setList(rows)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [statusFilter])

  if (selectedId) {
    return <Detail id={selectedId}
      onBack={() => { setSelectedId(null); reload() }} />
  }

  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: 16,
      }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>
            Work orders
          </h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Track jobs through intake, repair, and closeout. Convert to an invoice when ready.
          </div>
        </div>
        <button onClick={() => setShowCreate(true)} style={primaryBtnStyle}>
          <Plus size={14} /> New work order
        </button>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--bg-2)', borderRadius: 10, marginBottom: 16, width: 'fit-content' }}>
        {(['all', 'open', 'in_progress', 'awaiting_parts', 'completed', 'cancelled'] as const).map(s => (
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
            ? 'No work orders yet. Create one to get started.'
            : 'No work orders in this status.'}
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>WO #</th>
              <th style={thStyle}>Customer / Vehicle</th>
              <th style={thStyle}>Complaint</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Total</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {list.map(w => (
              <tr key={w.id}
                onClick={() => setSelectedId(w.id)}
                style={{ borderBottom: '1px solid var(--border-0)', cursor: 'pointer' }}>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, color: 'var(--text-0)' }}>
                  {w.woNumber}
                </td>
                <td style={tdStyle}>
                  <strong style={{ color: 'var(--text-0)' }}>{customerLabel(w)}</strong>
                  {vehicleLabel(w) && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                      <Car size={10} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                      {vehicleLabel(w)}
                    </div>
                  )}
                </td>
                <td style={{ ...tdStyle, fontSize: 12, color: 'var(--text-2)' }}>
                  {w.complaint
                    ? (w.complaint.length > 60 ? w.complaint.slice(0, 60) + '…' : w.complaint)
                    : <span style={{ color: 'var(--text-3)' }}>—</span>}
                </td>
                <td style={tdStyle}><StatusBadge status={w.status} /></td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontWeight: 600 }}>
                  {fmtMoney(w.totalAmount)}
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

function StatusBadge({ status }: { status: WorkOrderStatus }) {
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
  const [customerId, setCustomerId] = useState('')
  const [vehicleId, setVehicleId] = useState('')
  const [intakeMileage, setIntakeMileage] = useState('')
  const [complaint, setComplaint] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiGet<Customer[]>('/business-customers').then(setCustomers).catch(() => {})
  }, [])

  useEffect(() => {
    if (!customerId) { setVehicles([]); setVehicleId(''); return }
    apiGet<Vehicle[]>(`/business-vehicles?customerId=${customerId}`)
      .then(setVehicles).catch(() => setVehicles([]))
  }, [customerId])

  const submit = async () => {
    setErr(null)
    if (!customerId) { setErr('Pick a customer'); return }
    setBusy(true)
    try {
      const payload: any = {
        customerId,
        complaint: complaint.trim() || null,
      }
      if (vehicleId)     payload.vehicleId     = vehicleId
      if (intakeMileage) payload.intakeMileage = parseInt(intakeMileage, 10) || 0
      const r = await apiPost<{ id: string }>('/business-work-orders', payload)
      onCreated(r.data.id)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Create failed')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="New work order" onClose={onClose}
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
      <select value={customerId} onChange={e => setCustomerId(e.target.value)} style={inputStyle}>
        <option value="">Pick a customer…</option>
        {customers.map(c => (
          <option key={c.id} value={c.id}>
            {c.companyName || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Unnamed'}
          </option>
        ))}
      </select>

      <label style={labelStyle}>Vehicle (optional)</label>
      <select value={vehicleId}
        onChange={e => setVehicleId(e.target.value)}
        disabled={!customerId}
        style={inputStyle}>
        <option value="">
          {!customerId ? 'Pick a customer first' : vehicles.length === 0 ? 'No vehicles on file' : '— None —'}
        </option>
        {vehicles.map(v => (
          <option key={v.id} value={v.id}>
            {[v.year, v.make, v.model].filter(Boolean).join(' ') || v.licensePlate || v.vin || 'Unidentified'}
          </option>
        ))}
      </select>

      <label style={labelStyle}>Intake mileage (optional)</label>
      <input type="number" min="0"
        value={intakeMileage}
        onChange={e => setIntakeMileage(e.target.value)}
        style={inputStyle} />

      <label style={labelStyle}>Customer complaint / service request</label>
      <textarea value={complaint}
        onChange={e => setComplaint(e.target.value)}
        rows={3}
        placeholder="What does the customer say is wrong, or what service did they request?"
        style={{ ...inputStyle, fontFamily: 'var(--font-body)' as const, resize: 'vertical' as const }} />
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Detail view
// ─────────────────────────────────────────────────────────────────

function Detail({
  id, onBack,
}: {
  id: string
  onBack: () => void
}) {
  const { user } = useAuth()
  const [wo, setWo] = useState<WorkOrderDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showAddLine, setShowAddLine] = useState(false)
  const [showCancel,  setShowCancel]  = useState(false)
  const [showComplete, setShowComplete] = useState(false)
  const [showConvert, setShowConvert] = useState(false)
  const [showBillTime, setShowBillTime] = useState(false)

  const reload = async () => {
    setErr(null)
    try {
      const d = await apiGet<WorkOrderDetail>(`/business-work-orders/${id}`)
      setWo(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [id])

  const transitionTo = async (toStatus: WorkOrderStatus, extra: Record<string, any> = {}) => {
    setErr(null)
    try {
      await apiPost(`/business-work-orders/${id}/transition`, { toStatus, ...extra })
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Transition failed')
    }
  }

  const removeLine = async (lineId: string) => {
    if (!window.confirm('Remove this line?')) return
    setErr(null)
    try {
      await apiDelete(`/business-work-orders/${id}/lines/${lineId}`)
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Remove failed')
    }
  }

  // S514: time tracking.
  const timeAction = async (path: string) => {
    setErr(null)
    try {
      await apiPost(`/business-work-orders/${id}/time/${path}`)
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Time action failed')
    }
  }
  const deleteTimeEntry = async (entryId: string) => {
    setErr(null)
    try {
      await apiDelete(`/business-work-orders/${id}/time/${entryId}`)
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to delete entry')
    }
  }

  if (!wo) return (
    <div>
      <button onClick={onBack} style={ghostBtn}><ArrowLeft size={14} /> Back</button>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ marginTop: 16, color: 'var(--text-2)' }}>Loading…</div>
    </div>
  )

  const isEditable = wo.status !== 'completed' && wo.status !== 'cancelled'
  const next = VALID_NEXT[wo.status]

  return (
    <div>
      <button onClick={onBack} style={ghostBtn}>
        <ArrowLeft size={14} /> Back to work orders
      </button>
      {err && <div style={{ ...errStyle, marginTop: 16 }}>{err}</div>}

      <div style={{
        marginTop: 16, padding: 24,
        background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12,
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'start',
          marginBottom: 20,
        }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, margin: 0 }}>
              {wo.woNumber}
            </h1>
            <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 13, color: 'var(--text-2)' }}>
              <span>{fmtDate(wo.createdAt)}</span>
              <span>·</span>
              <span><strong style={{ color: 'var(--text-0)' }}>{customerLabel(wo)}</strong></span>
              {vehicleLabel(wo) && <><span>·</span><span><Car size={10} style={{ verticalAlign: 'middle', marginRight: 4 }} />{vehicleLabel(wo)}</span></>}
              {wo.vehicleVin && (
                <><span>·</span><span style={{ fontFamily: 'var(--font-mono)' as const }}>VIN {wo.vehicleVin}</span></>
              )}
            </div>
          </div>
          <StatusBadge status={wo.status} />
        </div>

        {/* Actions row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <button onClick={() => openPdfInNewTab(`/business-work-orders/${id}/pdf`)}
            style={ghostBtn}>
            <Printer size={12} /> Print
          </button>
          {isEditable && next.includes('in_progress') && (
            <button onClick={() => transitionTo('in_progress')} style={ghostBtn}>
              Mark in progress
            </button>
          )}
          {isEditable && next.includes('awaiting_parts') && (
            <button onClick={() => transitionTo('awaiting_parts')} style={ghostBtn}>
              Awaiting parts
            </button>
          )}
          {isEditable && wo.status === 'awaiting_parts' && (
            <button onClick={() => transitionTo('in_progress')} style={ghostBtn}>
              Parts in — back to work
            </button>
          )}
          {isEditable && (
            <button onClick={() => setShowComplete(true)} style={primaryBtnStyle}>
              Mark complete
            </button>
          )}
          {wo.status === 'completed' && !wo.invoiceId && (
            <button onClick={() => setShowConvert(true)} style={primaryBtnStyle}>
              <Receipt size={12} /> Convert to invoice
            </button>
          )}
          {wo.status === 'completed' && wo.invoiceId && (
            <span style={{
              padding: '8px 14px',
              background: 'rgba(34,197,94,.08)',
              border: '1px solid rgba(34,197,94,.4)',
              borderRadius: 8, fontSize: 13, color: 'var(--green, #22c55e)',
              display: 'inline-flex' as const, alignItems: 'center', gap: 6,
            }}>
              <Receipt size={12} /> Invoiced
            </span>
          )}
          {isEditable && (
            <button onClick={() => setShowCancel(true)} style={ghostBtn}>
              Cancel WO
            </button>
          )}
        </div>

        {/* Intake info */}
        {(wo.complaint || wo.intakeMileage !== null) && (
          <div style={{ padding: 14, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 16 }}>
            {wo.intakeMileage !== null && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
                Intake mileage: <strong style={{ color: 'var(--text-0)', fontFamily: 'var(--font-mono)' as const }}>
                  {wo.intakeMileage.toLocaleString()}
                </strong>
              </div>
            )}
            {wo.complaint && (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 4 }}>
                  Complaint
                </div>
                <div style={{ fontSize: 14, color: 'var(--text-1)', whiteSpace: 'pre-wrap' as const }}>{wo.complaint}</div>
              </>
            )}
          </div>
        )}

        {wo.status === 'cancelled' && wo.cancelReason && (
          <div style={{
            padding: 12, marginBottom: 16,
            background: 'rgba(245,158,11,.06)',
            border: '1px solid rgba(245,158,11,.4)',
            borderRadius: 8, fontSize: 13, color: 'var(--text-1)',
          }}>
            <strong>Cancel reason:</strong> {wo.cancelReason}
          </div>
        )}

        {wo.status === 'completed' && (wo.closeoutMileage !== null || wo.closeoutNotes) && (
          <div style={{ padding: 14, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 4 }}>
              Closeout
            </div>
            {wo.closeoutMileage !== null && (
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>
                Mileage at closeout: <strong style={{ color: 'var(--text-0)', fontFamily: 'var(--font-mono)' as const }}>
                  {wo.closeoutMileage.toLocaleString()}
                </strong>
              </div>
            )}
            {wo.closeoutNotes && (
              <div style={{ fontSize: 14, color: 'var(--text-1)', whiteSpace: 'pre-wrap' as const }}>{wo.closeoutNotes}</div>
            )}
          </div>
        )}

        {/* Lines */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h2 style={{ fontSize: 14, color: 'var(--text-2)', textTransform: 'uppercase' as const, letterSpacing: 1, margin: 0 }}>
            Lines
          </h2>
          {isEditable && (
            <button onClick={() => setShowAddLine(true)} style={ghostBtn}>
              <Plus size={12} /> Add line
            </button>
          )}
        </div>

        {wo.lines.length === 0 ? (
          <div style={{ ...emptyStyle, marginBottom: 16 }}>No lines yet. Add labor or parts to start the job.</div>
        ) : (
          <table style={{ ...tableStyle, marginBottom: 16 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Description</th>
                <th style={thStyle}>Qty</th>
                <th style={thStyle}>Rate</th>
                <th style={thStyle}>Subtotal</th>
                <th style={thStyle}>Tax</th>
                <th style={thStyle}>Total</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {wo.lines.map(ln => (
                <tr key={ln.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                  <td style={{ ...tdStyle, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                    {ln.lineType === 'labor' ? <Wrench size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} /> : null}
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
                    {isEditable && (
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
          <Row label="Labor"  value={fmtMoney(wo.laborSubtotal)} />
          <Row label="Parts"  value={fmtMoney(wo.partsSubtotal)} />
          <Row label="Tax"    value={fmtMoney(wo.taxAmount)} />
          <Row label="Total"  value={fmtMoney(wo.totalAmount)} big />
        </div>

        {/* S514: time tracking */}
        <TimeSection
          wo={wo}
          currentUserId={user?.id ?? null}
          isEditable={isEditable}
          onStart={() => timeAction('start')}
          onStop={() => timeAction('stop')}
          onDelete={deleteTimeEntry}
          onBill={() => setShowBillTime(true)} />

        {/* S509: attachments */}
        <div style={{ marginTop: 24 }}>
          <AttachmentList entityType="work_order" entityId={id} canEdit={isEditable} />
        </div>
      </div>

      {showAddLine && (
        <AddLineModal workOrderId={id}
          onClose={() => setShowAddLine(false)}
          onSaved={() => { setShowAddLine(false); reload() }} />
      )}
      {showCancel && (
        <CancelModal
          onClose={() => setShowCancel(false)}
          onConfirm={(reason) => { setShowCancel(false); transitionTo('cancelled', { cancelReason: reason }) }} />
      )}
      {showComplete && (
        <CompleteModal
          intakeMileage={wo.intakeMileage}
          onClose={() => setShowComplete(false)}
          onConfirm={(extra) => { setShowComplete(false); transitionTo('completed', extra) }} />
      )}
      {showConvert && (
        <ConvertModal workOrderId={id}
          onClose={() => setShowConvert(false)}
          onDone={() => { setShowConvert(false); reload() }} />
      )}
      {showBillTime && (
        <BillTimeModal workOrderId={id}
          unbilledMinutes={wo.timeEntries
            .filter(t => t.endedAt && !t.billedAt)
            .reduce((a, t) => a + (t.durationMinutes ?? 0), 0)}
          onClose={() => setShowBillTime(false)}
          onDone={() => { setShowBillTime(false); reload() }} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  S514 — time-tracking section + bill modal
// ─────────────────────────────────────────────────────────────────

function fmtHrs(minutes: number): string {
  const h = minutes / 60
  return `${h.toFixed(2)} hr${h === 1 ? '' : 's'}`
}

function TimeSection({
  wo, currentUserId, isEditable, onStart, onStop, onDelete, onBill,
}: {
  wo: WorkOrderDetail
  currentUserId: string | null
  isEditable: boolean
  onStart: () => void
  onStop: () => void
  onDelete: (entryId: string) => void
  onBill: () => void
}) {
  const myRunning = wo.timeEntries.find(t => t.userId === currentUserId && !t.endedAt) ?? null
  const unbilledMinutes = wo.timeEntries
    .filter(t => t.endedAt && !t.billedAt)
    .reduce((a, t) => a + (t.durationMinutes ?? 0), 0)

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 16, color: 'var(--text-0)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Clock size={15} color="var(--gold)" /> Time tracking
        </h2>
        {isEditable && (
          myRunning ? (
            <button onClick={onStop} style={{ ...primaryBtnStyle, background: 'var(--red, #ef4444)', color: '#fff' }}>
              <Square size={12} /> Clock out
            </button>
          ) : (
            <button onClick={onStart} style={primaryBtnStyle}>
              <Play size={12} /> Clock in
            </button>
          )
        )}
      </div>

      {wo.timeEntries.length === 0 ? (
        <div style={{ ...emptyStyle, marginBottom: 0 }}>No time tracked yet. Clock in to start the labor timer.</div>
      ) : (
        <>
          <table style={tableStyle}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                <th style={thStyle}>Tech</th>
                <th style={thStyle}>Started</th>
                <th style={thStyle}>Duration</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {wo.timeEntries.map(t => {
                const running = !t.endedAt
                return (
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                    <td style={tdStyle}>{`${t.techFirstName ?? ''} ${t.techLastName ?? ''}`.trim() || '—'}</td>
                    <td style={tdStyle}>{fmtDate(t.startedAt)}</td>
                    <td style={tdStyle}>{running ? '—' : fmtHrs(t.durationMinutes ?? 0)}</td>
                    <td style={tdStyle}>
                      {running ? (
                        <span style={{ color: 'var(--gold)', fontWeight: 600 }}>Running…</span>
                      ) : t.billedAt ? (
                        <span style={{ color: 'var(--text-3)' }}>Billed</span>
                      ) : (
                        <span style={{ color: 'var(--green, #22c55e)' }}>Unbilled</span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' as const }}>
                      {isEditable && !t.billedAt && !running && (
                        <button onClick={() => onDelete(t.id)}
                          style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 2 }}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {isEditable && unbilledMinutes > 0 && (
            <div style={{
              marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: 12, background: 'var(--bg-2)', borderRadius: 8,
            }}>
              <span style={{ fontSize: 13, color: 'var(--text-1)' }}>
                <strong>{fmtHrs(unbilledMinutes)}</strong> tracked and not yet billed
              </span>
              <button onClick={onBill} style={primaryBtnStyle}>Bill as labor →</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function BillTimeModal({
  workOrderId, unbilledMinutes, onClose, onDone,
}: {
  workOrderId: string
  unbilledMinutes: number
  onClose: () => void
  onDone: () => void
}) {
  const [hourlyRate, setHourlyRate] = useState('')
  const [description, setDescription] = useState('')
  const [taxRate, setTaxRate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const hours = unbilledMinutes / 60
  const preview = hours * (parseFloat(hourlyRate) || 0)

  const submit = async () => {
    setErr(null)
    const rate = parseFloat(hourlyRate)
    if (isNaN(rate) || rate < 0) { setErr('Enter an hourly rate'); return }
    setSubmitting(true)
    try {
      const payload: any = { hourlyRate: rate }
      if (description.trim()) payload.description = description.trim()
      if (taxRate.trim()) payload.taxRate = (parseFloat(taxRate) || 0) / 100
      await apiPost(`/business-work-orders/${workOrderId}/time/bill`, payload)
      onDone()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to bill time')
    } finally { setSubmitting(false) }
  }

  return (
    <Modal title="Bill tracked time" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={primaryBtnStyle}>
            {submitting ? 'Billing…' : `Add labor line — ${fmtMoney(preview)}`}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 12, fontSize: 13, color: 'var(--text-1)' }}>
        Rolling <strong>{fmtHrs(unbilledMinutes)}</strong> of tracked time into a single labor line.
      </div>

      <label style={labelStyle}>Hourly rate</label>
      <input type="number" step="0.01" min={0} value={hourlyRate}
        onChange={e => setHourlyRate(e.target.value)} placeholder="100.00"
        style={{ ...inputStyle, fontFamily: 'var(--font-mono)' as const }} autoFocus />

      <label style={labelStyle}>Description (optional)</label>
      <input value={description} onChange={e => setDescription(e.target.value)}
        placeholder={`Labor — ${hours.toFixed(2)} hrs (tracked)`} style={inputStyle} />

      <label style={labelStyle}>Tax rate % (optional)</label>
      <input type="number" step="0.01" min={0} value={taxRate}
        onChange={e => setTaxRate(e.target.value)} placeholder="0" style={inputStyle} />
    </Modal>
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
//  Add-line modal (labor / part / fee tabs)
// ─────────────────────────────────────────────────────────────────

function AddLineModal({
  workOrderId, onClose, onSaved,
}: {
  workOrderId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [type, setType] = useState<'labor' | 'part' | 'fee'>('labor')
  // labor
  const [laborDesc, setLaborDesc] = useState('')
  const [hours, setHours] = useState('1')
  const [rate, setRate] = useState('100')
  const [laborTax, setLaborTax] = useState('0')
  // part
  const [items, setItems] = useState<InventoryItem[]>([])
  const [itemSearch, setItemSearch] = useState('')
  const [itemId, setItemId] = useState('')
  const [qty, setQty] = useState('1')
  const [overridePrice, setOverridePrice] = useState('')
  // fee
  const [feeDesc, setFeeDesc] = useState('')
  const [feeAmount, setFeeAmount] = useState('0')
  const [feeTax, setFeeTax] = useState('0')

  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
        lineType: 'labor',
        description: laborDesc.trim(),
        hours: Number(hours) || 0,
        hourlyRate: Number(rate) || 0,
        taxRate: (Number(laborTax) || 0) / 100,
      }
    } else if (type === 'fee') {
      if (!feeDesc.trim()) { setErr('Description required'); return }
      payload = {
        lineType: 'fee',
        description: feeDesc.trim(),
        amount: Number(feeAmount) || 0,
        taxRate: (Number(feeTax) || 0) / 100,
      }
    } else {
      if (!itemId) { setErr('Pick an item'); return }
      payload = {
        lineType: 'part',
        itemId,
        quantity: Number(qty) || 0,
      }
      if (overridePrice.trim()) payload.unitPrice = Number(overridePrice)
    }
    setBusy(true)
    try {
      await apiPost(`/business-work-orders/${workOrderId}/lines`, payload)
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
        {(['labor', 'part', 'fee'] as const).map(t => (
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
          <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-2)', borderRadius: 8, fontSize: 13, color: 'var(--text-2)' }}>
            Subtotal: <strong style={{ color: 'var(--gold)', fontFamily: 'var(--font-mono)' as const }}>
              {fmtMoney((Number(hours) || 0) * (Number(rate) || 0))}
            </strong>
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
                disabled={it.stockQty <= 0}
                style={{
                  display: 'flex' as const, justifyContent: 'space-between',
                  alignItems: 'center', width: '100%',
                  padding: '10px 14px',
                  background: itemId === it.id ? 'rgba(212,175,55,.10)' : 'transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--border-0)',
                  color: 'var(--text-0)', fontSize: 13,
                  cursor: it.stockQty <= 0 ? 'not-allowed' : 'pointer',
                  opacity: it.stockQty <= 0 ? 0.4 : 1,
                  textAlign: 'left' as const,
                }}>
                <div>
                  <div>{it.name}</div>
                  {it.sku && <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' as const }}>{it.sku}</div>}
                </div>
                <div style={{ textAlign: 'right' as const, fontSize: 11 }}>
                  <div style={{ color: 'var(--gold)' }}>{fmtMoney(it.sellPrice)}</div>
                  <div style={{ color: it.stockQty <= 0 ? 'var(--red, #ef4444)' : 'var(--text-3)' }}>
                    {it.stockQty <= 0 ? 'Out' : `${it.stockQty} on hand`}
                  </div>
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
        </>
      )}

      {type === 'fee' && (
        <>
          <label style={labelStyle}>Description</label>
          <input value={feeDesc} onChange={e => setFeeDesc(e.target.value)}
            placeholder="Shop fee / disposal / etc."
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
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Status transition modals
// ─────────────────────────────────────────────────────────────────

function CancelModal({
  onClose, onConfirm,
}: { onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <Modal title="Cancel work order" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Keep open</button>
          <button onClick={() => reason.trim() && onConfirm(reason.trim())}
            disabled={!reason.trim()} style={primaryBtnStyle}>
            Cancel WO
          </button>
        </>
      }>
      <div style={{
        padding: 12, marginBottom: 12,
        background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.4)',
        borderRadius: 8, fontSize: 12, color: 'var(--text-1)',
        display: 'flex', gap: 8, alignItems: 'start',
      }}>
        <AlertTriangle size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
        <span>Cancelling locks the work order. Stock isn't restored automatically — remove part lines first if you want stock back.</span>
      </div>
      <label style={labelStyle}>Reason</label>
      <input value={reason} onChange={e => setReason(e.target.value)}
        autoFocus placeholder="Customer pulled job / duplicate / etc."
        style={inputStyle} />
    </Modal>
  )
}

function CompleteModal({
  intakeMileage, onClose, onConfirm,
}: {
  intakeMileage: number | null
  onClose: () => void
  onConfirm: (extra: { closeoutMileage?: number; closeoutNotes?: string }) => void
}) {
  const [mileage, setMileage] = useState('')
  const [notes, setNotes] = useState('')
  return (
    <Modal title="Complete work order" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={() => onConfirm({
              closeoutMileage: mileage ? parseInt(mileage, 10) : undefined,
              closeoutNotes:   notes.trim() || undefined,
            })}
            style={primaryBtnStyle}>
            Mark complete
          </button>
        </>
      }>
      <label style={labelStyle}>Closeout mileage (optional)</label>
      <input type="number" min={intakeMileage ?? 0}
        value={mileage} onChange={e => setMileage(e.target.value)}
        placeholder={intakeMileage !== null ? `At intake: ${intakeMileage.toLocaleString()}` : ''}
        style={inputStyle} />

      <label style={labelStyle}>Closeout notes (optional)</label>
      <textarea value={notes} onChange={e => setNotes(e.target.value)}
        rows={3}
        placeholder="What was done, any followup recommended, etc."
        style={{ ...inputStyle, fontFamily: 'var(--font-body)' as const, resize: 'vertical' as const }} />
    </Modal>
  )
}

function ConvertModal({
  workOrderId, onClose, onDone,
}: {
  workOrderId: string
  onClose: () => void
  onDone: () => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const in30  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const [issueDate, setIssueDate] = useState(today)
  const [dueDate, setDueDate] = useState(in30)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null); setBusy(true)
    try {
      await apiPost(`/business-work-orders/${workOrderId}/convert-to-invoice`, {
        issueDate, dueDate, notes: notes.trim() || null,
      })
      onDone()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Convert failed')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Convert to invoice" onClose={onClose}
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
      <label style={labelStyle}>Invoice notes (optional)</label>
      <textarea value={notes} onChange={e => setNotes(e.target.value)}
        rows={2}
        placeholder="Thanks for your business / followup notes"
        style={{ ...inputStyle, fontFamily: 'var(--font-body)' as const, resize: 'vertical' as const }} />
      <div style={{
        marginTop: 12, padding: 10,
        background: 'var(--bg-2)', borderRadius: 8,
        fontSize: 12, color: 'var(--text-2)',
      }}>
        The invoice will be created as a draft. You can review and send it from the Invoices page.
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
const tdStyle: React.CSSProperties = {
  padding: '12px 16px', fontSize: 14, color: 'var(--text-1)',
}
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
  border: 'none', borderRadius: 8,
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
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
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14,
  marginBottom: 16,
}
