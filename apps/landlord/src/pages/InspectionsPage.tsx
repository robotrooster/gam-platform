import { useMemo, useState } from 'react'
import { useQuery } from 'react-query'
import { Link } from 'react-router-dom'
import { ClipboardCheck, Plus, CheckCircle2 } from 'lucide-react'
import { apiGet } from '../lib/api'
import { usePerms } from '../lib/permissions'
import type { InspectionType } from '@gam/shared'
import { humanize } from '@gam/shared'

type InspectionRow = {
  id: string
  unitId: string
  leaseId: string | null
  tenantId: string | null
  landlordId: string
  inspectionType: InspectionType
  status: 'draft' | 'tenant_signed' | 'landlord_signed' | 'finalized' | 'disputed' | 'cancelled'
  comparisonInspectionId: string | null
  scheduledFor: string | null
  finalizedAt: string | null
  createdAt: string
  flaggedSuspiciousAt: string | null
  followupInspectionId: string | null
  unitNumber: string | null
  propertyName: string | null
  tenantFirstName: string | null
  tenantLastName: string | null
}

const STATUS_BADGE: Record<string, string> = {
  draft:           'badge-muted',
  tenant_signed:   'badge-amber',
  landlord_signed: 'badge-amber',
  finalized:       'badge-green',
  disputed:        'badge-red',
  cancelled:       'badge-muted',
}

const TYPE_LABEL: Record<InspectionType, string> = {
  move_in:  'Move-in',
  move_out: 'Move-out',
  periodic: 'Periodic',
  turnover: 'Turnover',
}

// S550: on a periodic, 'tenant_signed' means the tenant SUBMITTED their
// self-directed walkthrough — no signature exists (signing is move-in only).
export function inspectionStatusLabel(type: string, status: string): string {
  if (type === 'periodic' && status === 'tenant_signed') return 'Submitted for review'
  return humanize(status)
}

export function InspectionsPage() {
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')

  const { data = [], isLoading } = useQuery<InspectionRow[]>(
    'inspections',
    () => apiGet<InspectionRow[]>('/inspections'),
  )

  const { can } = usePerms()

  const filtered = useMemo(() => {
    return (data as InspectionRow[]).filter(r => {
      if (typeFilter && r.inspectionType !== typeFilter) return false
      if (statusFilter && r.status !== statusFilter) return false
      return true
    })
  }, [data, typeFilter, statusFilter])

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ClipboardCheck size={22} /> Inspections
          </h1>
          <div className="page-sub">Move-in, move-out, turnover, and periodic unit inspections</div>
        </div>
        {/* W-41: ONE entry point — the old "guided walkthrough" button led
            to the same form (?walkthrough=1 was never read); the assistant
            offer lives inside the form. */}
        {can('inspections.create') && (
          <Link to="/inspections/new" className="btn btn-primary">
            <Plus size={15} /> New Inspection
          </Link>
        )}
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Type</label>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="input" style={{ minWidth: 140 }}>
              <option value="">All types</option>
              <option value="move_in">Move-in</option>
              <option value="move_out">Move-out</option>
              <option value="periodic">Periodic</option>
              <option value="turnover">Turnover</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Status</label>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="input" style={{ minWidth: 160 }}>
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="tenant_signed">Tenant signed / Submitted</option>
              <option value="landlord_signed">Both signed</option>
              <option value="finalized">Finalized</option>
              <option value="disputed">Disputed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
            No inspections yet. Create one for a move-in or move-out.
          </div>
        ) : (
          <table className="data-table" style={{ width: '100%', minWidth: 800 }}>
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>Unit</th>
                <th>Tenant</th>
                <th>Scheduled</th>
                <th>Finalized</th>
                <th>Comparison</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id}>
                  <td><strong>{TYPE_LABEL[r.inspectionType] || r.inspectionType}</strong></td>
                  <td>
                    {r.flaggedSuspiciousAt
                      ? <span className="badge badge-red">Flagged suspicious</span>
                      : <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{inspectionStatusLabel(r.inspectionType, r.status)}</span>}
                  </td>
                  <td>
                    {r.unitNumber ?? '—'}
                    {r.propertyName && <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}> · {r.propertyName}</span>}
                  </td>
                  <td>{[r.tenantFirstName, r.tenantLastName].filter(Boolean).join(' ') || '—'}</td>
                  <td>{fmtDate(r.scheduledFor)}</td>
                  <td>{fmtDate(r.finalizedAt)}</td>
                  <td>{r.comparisonInspectionId ? <CheckCircle2 size={14} style={{ color: 'var(--green)' }} /> : '—'}</td>
                  <td><Link to={`/inspections/${r.id}`} className="btn btn-ghost btn-sm">Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ marginTop: 16, fontSize: '.78rem', color: 'var(--text-3)' }}>
        Move-out inspections compare against the linked move-in. The tenant
        signs move-in inspections only — everything else finalizes on the
        landlord signature. Finalize fires the condition-match (or
        damage-documented) credit-ledger event.
      </div>
    </div>
  )
}

function fmtDate(ts: string | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
