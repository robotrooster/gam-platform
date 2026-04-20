import { useState, useEffect } from 'react'
import { useQuery } from 'react-query'
import { useSearchParams } from 'react-router-dom'
import { apiGet } from '../lib/api'
import { Plus, AlertTriangle } from 'lucide-react'
import { LeaseFormModal } from './LeaseFormModal'

const fmt = (n: any) => n != null
  ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '—'

const STATUS_MAP: Record<string, string> = {
  active: 'badge-green',
  expired: 'badge-red',
  pending: 'badge-amber',
  terminated: 'badge-muted',
}

const LEASE_TYPE_LABELS: Record<string, string> = {
  month_to_month: 'Month-to-month',
  fixed_term: 'Fixed term',
  nightly: 'Nightly',
  weekly: 'Weekly',
  nnn_commercial: 'NNN Commercial',
}

export function LeasesPage() {
  const { data: leases = [], isLoading } = useQuery<any[]>('leases', () => apiGet('/leases'))
  const [modalOpen, setModalOpen] = useState(false)
  const [editingLeaseId, setEditingLeaseId] = useState<string | undefined>(undefined)
  const [searchParams, setSearchParams] = useSearchParams()

  // Deep-link: ?open=<leaseId> opens the edit modal directly
  useEffect(() => {
    const openId = searchParams.get('open')
    if (openId && !modalOpen) {
      setEditingLeaseId(openId)
      setModalOpen(true)
    }
  }, [searchParams])

  const openCreate = () => {
    setEditingLeaseId(undefined)
    setModalOpen(true)
  }
  const openEdit = (id: string) => {
    setEditingLeaseId(id)
    setModalOpen(true)
  }
  const closeModal = () => {
    setModalOpen(false)
    setEditingLeaseId(undefined)
    if (searchParams.get('open')) {
      searchParams.delete('open')
      setSearchParams(searchParams, { replace: true })
    }
  }

  const needsReviewCount = (leases as any[]).filter(l => l.needsReview).length

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Leases</h1>
          <p className="page-subtitle">Active and historical lease agreements</p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          <Plus size={14} /> Add Lease
        </button>
      </div>

      {needsReviewCount > 0 && (
        <div style={{
          background: 'rgba(245,158,11,.08)',
          border: '1px solid var(--amber)',
          borderRadius: 10,
          padding: '10px 14px',
          marginBottom: 14,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          fontSize: '.82rem',
          color: 'var(--text-1)',
        }}>
          <AlertTriangle size={16} style={{ color: 'var(--amber)', flexShrink: 0 }} />
          <div>
            <strong style={{ color: 'var(--amber)' }}>{needsReviewCount} lease{needsReviewCount === 1 ? '' : 's'} need review.</strong>
            {' '}These were imported with default values. Click a row to review and confirm.
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Unit</th>
                <th>Tenant</th>
                <th>Type</th>
                <th>Start</th>
                <th>End</th>
                <th>Rent</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(leases as any[]).length ? (leases as any[]).map((l: any) => {
                const tenantName = [l.tenantFirst, l.tenantLast].filter(Boolean).join(' ') || '—'
                return (
                  <tr
                    key={l.id}
                    onClick={() => openEdit(l.id)}
                    style={{ cursor: 'pointer' }}
                    className="row-clickable"
                  >
                    <td className="mono">{l.unitNumber || '—'}</td>
                    <td>
                      {tenantName}
                      {l.needsReview && (
                        <span
                          title="Needs review"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            marginLeft: 8,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'rgba(245,158,11,.12)',
                            color: 'var(--amber)',
                            fontSize: '.65rem',
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '.04em',
                          }}
                        >
                          <AlertTriangle size={9} />
                          Review
                        </span>
                      )}
                    </td>
                    <td style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
                      {LEASE_TYPE_LABELS[l.leaseType] || l.leaseType || '—'}
                    </td>
                    <td className="mono">{l.startDate ? new Date(l.startDate).toLocaleDateString() : '—'}</td>
                    <td className="mono">
                      {l.endDate
                        ? new Date(l.endDate).toLocaleDateString()
                        : <span style={{ color: 'var(--text-3)' }}>MTM</span>}
                    </td>
                    <td className="mono" style={{ color: 'var(--text-0)' }}>{fmt(l.rentAmount)}</td>
                    <td>
                      <span className={'badge ' + (STATUS_MAP[l.status] || 'badge-muted')}>
                        {l.status?.replace('_', ' ') || '—'}
                      </span>
                    </td>
                  </tr>
                )
              }) : (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>
                    No leases found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {modalOpen && (
        <LeaseFormModal
          onClose={closeModal}
          leaseId={editingLeaseId}
        />
      )}
    </div>
  )
}
