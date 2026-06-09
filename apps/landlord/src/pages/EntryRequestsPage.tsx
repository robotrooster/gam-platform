import { useMemo, useState } from 'react'
import { useQuery } from 'react-query'
import { Link } from 'react-router-dom'
import { DoorOpen, Plus } from 'lucide-react'
import { apiGet } from '../lib/api'

type Row = {
  id: string
  unitId: string
  tenantId: string
  landlordId: string
  reason: string
  reasonCategory: string
  status: 'pending' | 'granted' | 'denied' | 'completed' | 'breached' | 'cancelled'
  noticeGivenAt: string
  proposedEntryWindowStart: string
  proposedEntryWindowEnd: string
  entryActualAt: string | null
  noticeWindowHours: number
  createdAt: string
}

const STATUS_BADGE: Record<string, string> = {
  pending:   'badge-amber',
  granted:   'badge-blue',
  denied:    'badge-muted',
  completed: 'badge-green',
  breached:  'badge-red',
  cancelled: 'badge-muted',
}

export function EntryRequestsPage() {
  const [statusFilter, setStatusFilter] = useState('')
  const { data = [], isLoading } = useQuery<Row[]>(
    'entry-requests',
    () => apiGet<Row[]>('/entry-requests'),
  )
  const filtered = useMemo(
    () => (data as Row[]).filter(r => !statusFilter || r.status === statusFilter),
    [data, statusFilter],
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <DoorOpen size={22} /> Entry Requests
          </h1>
          <div className="page-sub">
            Notice-of-entry workflow. Granted within window + within proposed
            time = landlord-side credit. Outside window or no grant = breach.
          </div>
        </div>
        <Link to="/entry-requests/new" className="btn btn-primary">
          <Plus size={15} /> New Request
        </Link>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Status</label>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="input"
          style={{ minWidth: 180 }}
        >
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="granted">Granted</option>
          <option value="denied">Denied</option>
          <option value="completed">Completed</option>
          <option value="breached">Breached</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
            No entry requests yet.
          </div>
        ) : (
          <table className="data-table" style={{ width: '100%', minWidth: 760 }}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Reason</th>
                <th>Category</th>
                <th>Window</th>
                <th>Notice</th>
                <th>Entered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id}>
                  <td><span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{r.status}</span></td>
                  <td style={{ color: 'var(--text-0)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.reason}</td>
                  <td>{r.reasonCategory}</td>
                  <td style={{ fontSize: '.78rem' }}>
                    {fmtDateTime(r.proposedEntryWindowStart)} → {fmtDateTime(r.proposedEntryWindowEnd)}
                  </td>
                  <td style={{ color: r.noticeWindowHours < 24 ? 'var(--amber)' : 'var(--text-2)' }}>
                    {r.noticeWindowHours}h
                  </td>
                  <td>{fmtDateTime(r.entryActualAt) || '—'}</td>
                  <td><Link to={`/entry-requests/${r.id}`} className="btn btn-ghost btn-sm">Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function fmtDateTime(ts: string | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}
