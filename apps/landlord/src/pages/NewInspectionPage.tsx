import { useState, useEffect } from 'react'
import { useQuery, useMutation } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { ClipboardCheck, ArrowLeft, Sparkles } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { openAssistant } from '../components/ChatWidget'

type Unit = { id: string; unitNumber: string; propertyId: string; propertyName: string; tenantId?: string | null }
type Tenant = { id: string; firstName: string; lastName: string }
type Lease = { id: string; unitId: string; startDate: string; status: string }

export function NewInspectionPage() {
  const navigate = useNavigate()
  const [unitId, setUnitId] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [leaseId, setLeaseId] = useState('')
  const [type, setType] = useState<'move_in' | 'move_out' | 'periodic' | 'turnover'>('move_in')
  const [comparisonId, setComparisonId] = useState('')
  const [scheduledFor, setScheduledFor] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: units = [] } = useQuery<Unit[]>('units-for-inspection', () => apiGet<Unit[]>('/units'))
  const { data: tenants = [] } = useQuery<Tenant[]>('tenants-for-inspection', () => apiGet<Tenant[]>('/tenants'))
  const { data: leases = [] } = useQuery<Lease[]>('leases-for-inspection', () => apiGet<Lease[]>('/leases'))
  const { data: priorMoveIns = [] } = useQuery<any[]>(
    ['inspections-prior', unitId],
    () => unitId ? apiGet<any[]>(`/inspections?unitId=${unitId}`) : Promise.resolve([]),
    { enabled: type === 'move_out' && !!unitId },
  )

  // #24: picking a unit auto-fills its active lease + primary tenant from the
  // unit's current tenancy (v_unit_occupancy on /units, active lease on /leases).
  // The landlord can still override either dropdown. autoFilled drives the hint.
  const [autoFilled, setAutoFilled] = useState(false)
  useEffect(() => {
    if (!unitId) { setAutoFilled(false); return }
    const u = (units as Unit[]).find(x => x.id === unitId)
    const unitLeases = (leases as Lease[]).filter(l => l.unitId === unitId)
    const pickLease = unitLeases.find(l => l.status === 'active') || unitLeases[0]
    setTenantId(u?.tenantId || '')
    setLeaseId(pickLease?.id || '')
    setAutoFilled(!!(u?.tenantId || pickLease))
  }, [unitId, units, leases])

  const createMut = useMutation(
    (body: any) => apiPost<{ id: string }>('/inspections', body),
    {
      onSuccess: (res) => {
        navigate(`/inspections/${res.data.id}`)
      },
      onError: (e: any) => {
        setError(e?.response?.data?.error || 'Failed to create')
      },
    },
  )

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!unitId) { setError('Pick a unit'); return }
    createMut.mutate({
      unitId,
      leaseId: leaseId || undefined,
      tenantId: tenantId || undefined,
      inspectionType: type,
      comparisonInspectionId: type === 'move_out' && comparisonId ? comparisonId : undefined,
      scheduledFor: scheduledFor || undefined,
      notes: notes || undefined,
    })
  }

  const eligibleMoveIns = (priorMoveIns as any[]).filter(p =>
    p.inspectionType === 'move_in' && p.status === 'finalized',
  )

  const tenantList = tenants as Tenant[]
  const leaseList = (leases as Lease[]).filter(l => !unitId || l.unitId === unitId)
  const unitList = units as Unit[]

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/inspections')} style={{ marginBottom: 8 }}>
            <ArrowLeft size={14} /> Inspections
          </button>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ClipboardCheck size={22} /> New Inspection
          </h1>
        </div>
      </div>

      {/* Agent-guided walkthrough offer. Fill it in manually, or let the
          assistant create + walk you through documenting each item. */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, borderColor: 'var(--gold)' }}>
        <Sparkles size={18} style={{ color: 'var(--gold)', flexShrink: 0 }} />
        <div style={{ flex: 1, fontSize: '.85rem' }}>
          Prefer to do this hands-free? The assistant can run this walkthrough — creating the inspection and recording each item's condition as you go.
        </div>
        <button type="button" className="btn btn-secondary btn-sm"
          onClick={() => openAssistant("I'd like to run a unit walkthrough with your help — can you create the inspection and guide me through documenting each item's condition?")}>
          Automate with assistant
        </button>
      </div>

      <form onSubmit={onSubmit} className="card" style={{ padding: 24 }}>
        {error && (
          <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 8, padding: 12, color: 'var(--red)', marginBottom: 16 }}>
            {error}
          </div>
        )}

        <Field label="Inspection type">
          <select value={type} onChange={e => setType(e.target.value as any)} className="input" required>
            <option value="move_in">Move-in</option>
            <option value="move_out">Move-out</option>
            <option value="turnover">Turnover (clean/repair between tenancies)</option>
            <option value="periodic">Periodic</option>
          </select>
        </Field>

        <Field label="Unit">
          <select value={unitId} onChange={e => setUnitId(e.target.value)} className="input" required>
            <option value="">— pick a unit —</option>
            {unitList.map(u => (
              <option key={u.id} value={u.id}>{u.unitNumber} — {u.propertyName}</option>
            ))}
          </select>
        </Field>

        <Field label="Tenant (optional for periodic)">
          <select value={tenantId} onChange={e => setTenantId(e.target.value)} className="input">
            <option value="">— none —</option>
            {tenantList.map(t => (
              <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>
            ))}
          </select>
          {autoFilled && (
            <div style={{ fontSize: '.72rem', color: 'var(--gold)', marginTop: 4 }}>
              Auto-filled from the unit's current tenancy — change if needed.
            </div>
          )}
        </Field>

        <Field label="Lease (optional)">
          <select value={leaseId} onChange={e => setLeaseId(e.target.value)} className="input">
            <option value="">— none —</option>
            {leaseList.map(l => (
              <option key={l.id} value={l.id}>{l.id.slice(0, 8)}… ({l.status}, started {l.startDate})</option>
            ))}
          </select>
        </Field>

        {type === 'move_out' && (
          <Field label="Compare against move-in">
            <select value={comparisonId} onChange={e => setComparisonId(e.target.value)} className="input">
              <option value="">— skip comparison —</option>
              {eligibleMoveIns.map(p => (
                <option key={p.id} value={p.id}>{p.id.slice(0, 8)}… (finalized {fmtDate(p.finalizedAt)})</option>
              ))}
            </select>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>
              When set, the move-out finalize will compare per-item conditions and
              emit either condition-matches or damage-documented to the tenant's
              credit ledger.
            </div>
          </Field>
        )}

        <Field label="Scheduled for (optional)">
          <input
            type="datetime-local"
            value={scheduledFor}
            onChange={e => setScheduledFor(e.target.value)}
            className="input"
          />
        </Field>

        <Field label="Notes">
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className="input"
            rows={3}
            placeholder="Internal notes (optional)"
          />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/inspections')}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={createMut.isLoading}>
            {createMut.isLoading ? 'Creating…' : 'Create Inspection'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function fmtDate(ts: string | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
