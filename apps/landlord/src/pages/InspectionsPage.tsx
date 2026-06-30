import { useMemo, useState } from 'react'
import { useQuery } from 'react-query'
import { Link } from 'react-router-dom'
import { ClipboardCheck, Plus, CheckCircle2 } from 'lucide-react'
import { apiGet } from '../lib/api'
import type { InspectionType } from '@gam/shared'

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

export function InspectionsPage() {
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')

  const { data = [], isLoading } = useQuery<InspectionRow[]>(
    'inspections',
    () => apiGet<InspectionRow[]>('/inspections'),
  )

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
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/inspections/new?walkthrough=1" className="btn btn-secondary">
            Start guided walkthrough
          </Link>
          <Link to="/inspections/new" className="btn btn-primary">
            <Plus size={15} /> New Inspection
          </Link>
        </div>
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
              <option value="tenant_signed">Tenant signed</option>
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
                  <td><span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{r.status.replace('_', ' ')}</span></td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '.78rem' }}>{r.unitId.slice(0, 8)}…</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '.78rem' }}>{r.tenantId?.slice(0, 8) ?? '—'}…</td>
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
        Move-out inspections compare against the linked move-in. Both
        parties must sign before finalize. Finalize fires the
        condition-match (or damage-documented) credit-ledger event.
      </div>
    </div>
  )
}

function fmtDate(ts: string | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
