import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { UserPlus, AlertTriangle, DollarSign, FileText, X } from 'lucide-react'
import { LEASE_TYPE_LABEL, LeaseStatus } from '@gam/shared'
import { LeaseFormModal } from './LeaseFormModal'

const fmt = (n: any) => n != null
  ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '—'

const STATUS_MAP: Record<LeaseStatus, string> = {
  pending:    'badge-amber',
  active:     'badge-green',
  expired:    'badge-red',
  terminated: 'badge-muted',
}

export function LeasesPage() {
  const { data: leases = [], isLoading } = useQuery<any[]>('leases', () => apiGet('/leases'))
  const [modalOpen, setModalOpen] = useState(false)
  const [editingLeaseId, setEditingLeaseId] = useState<string | undefined>(undefined)
  // S181 / A2: bill-fee modal state. Holds the lease object to bill against,
  // or null when the modal is closed.
  const [billFeeLease, setBillFeeLease] = useState<any | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  // Deep-link: ?open=<leaseId> opens the edit modal directly
  useEffect(() => {
    const openId = searchParams.get('open')
    if (openId && !modalOpen) {
      setEditingLeaseId(openId)
      setModalOpen(true)
    }
  }, [searchParams])

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
        <Link to="/tenant-onboarding" className="btn btn-primary" style={{ textDecoration: 'none' }}>
          <UserPlus size={14} /> Start Tenant Onboarding
        </Link>
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

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : (
          <table className="data-table" style={{ minWidth: 920 }}>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Tenant</th>
                <th>Type</th>
                <th>Start</th>
                <th>End</th>
                <th>Rent</th>
                <th>Status</th>
                <th></th>
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
                      {LEASE_TYPE_LABEL[l.leaseType as keyof typeof LEASE_TYPE_LABEL] || l.leaseType || '—'}
                    </td>
                    <td className="mono">{l.startDate ? new Date(l.startDate).toLocaleDateString() : '—'}</td>
                    <td className="mono">
                      {l.endDate
                        ? new Date(l.endDate).toLocaleDateString()
                        : <span style={{ color: 'var(--text-3)' }}>MTM</span>}
                    </td>
                    <td className="mono" style={{ color: 'var(--text-0)' }}>{fmt(l.rentAmount)}</td>
                    <td>
                      <span className={'badge ' + (STATUS_MAP[l.status as LeaseStatus] || 'badge-muted')}>
                        {l.status?.replace('_', ' ') || '—'}
                      </span>
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {l.status === 'active' && (
                          <button
                            className="btn btn-ghost btn-sm"
                            title="Bill the tenant a one-off fee on this lease"
                            onClick={() => setBillFeeLease(l)}
                            style={{ padding: '3px 8px' }}
                          >
                            <FileText size={12} /> Bill fee
                          </button>
                        )}
                        {(l.status === 'active' || l.status === 'expired' || l.status === 'terminated') && (
                          <button
                            className="btn btn-ghost btn-sm"
                            title="Process move-out / deposit return"
                            onClick={() => navigate(`/leases/${l.id}/deposit-return`)}
                            style={{ padding: '3px 8px' }}
                          >
                            <DollarSign size={12} /> Move-out
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              }) : (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>
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

      {billFeeLease && (
        <BillFeeModal
          lease={billFeeLease}
          onClose={() => setBillFeeLease(null)}
        />
      )}
    </div>
  )
}

// S181 / A2: landlord-triggered one-off fee billing.
// Posts to /api/leases/:id/bill-fee (S180). Per the S177 walkthrough
// "platform provides capability not execution" — this is just a
// surface for the existing backend endpoint. The created payments row
// flows through the standard /payments tenant Pay Now UI.
function BillFeeModal({ lease, onClose }: { lease: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [feeType, setFeeType] = useState<'early_termination_fee' | 'other_fee'>('other_fee')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const mut = useMutation(
    (body: { feeType: string; amount: number; description?: string; dueDate?: string }) =>
      apiPost(`/leases/${lease.id}/bill-fee`, body),
    {
      onSuccess: () => {
        setError(null)
        setSuccess('Fee billed. Tenant will see it on their Payments page.')
        qc.invalidateQueries('leases')
        setTimeout(onClose, 1200)
      },
      onError: (e: any) => {
        setSuccess(null)
        setError(e?.response?.data?.error?.message || e?.response?.data?.error || 'Could not bill fee')
      },
    },
  )

  const submit = () => {
    setError(null)
    const amt = parseFloat(amount)
    if (!isFinite(amt) || amt <= 0) {
      setError('Amount must be a positive number')
      return
    }
    mut.mutate({
      feeType,
      amount:      amt,
      description: description.trim() || undefined,
      dueDate:     dueDate || undefined,
    })
  }

  return (
    <div
      onClick={onClose}
      style={{
        position:       'fixed',
        inset:          0,
        background:     'rgba(0,0,0,.6)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        zIndex:         100,
        padding:        16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="card"
        style={{ width: '100%', maxWidth: 460, padding: 22 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Bill a fee</h3>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 14 }}>
          Lease for {lease.tenantName ?? 'tenant'} — Unit {lease.unitNumber ?? '—'}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
            Fee type
          </label>
          <select
            value={feeType}
            onChange={e => setFeeType(e.target.value as any)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', color: 'var(--text-0)' }}
          >
            <option value="other_fee">Other fee</option>
            <option value="early_termination_fee">Early termination fee</option>
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
            Amount (USD)
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="500.00"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
            Description (optional)
          </label>
          <input
            type="text"
            maxLength={500}
            placeholder="What is this fee for?"
            value={description}
            onChange={e => setDescription(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
            Due date (optional — defaults to today)
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' }}
          />
        </div>

        {error && (
          <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', color: 'var(--red)', fontSize: '.78rem' }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.25)', color: 'var(--green)', fontSize: '.78rem' }}>
            {success}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={mut.isLoading || !!success || !amount}
            onClick={submit}
          >
            {mut.isLoading ? 'Billing…' : success ? '✓ Billed' : 'Bill fee'}
          </button>
        </div>
        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.5 }}>
          The tenant will see this on their Payments page as a pending charge. If unpaid at move-out it sweeps into the deposit deduction automatically.
        </div>
      </div>
    </div>
  )
}
