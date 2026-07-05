// W-28 (S529): the read-only lease view. Replaces opening LeaseFormModal in
// disabled mode ("everything renders as grayed-out typeable fields — looks
// like a broken form"). Per lease-is-law this presents what the signed
// document says as INFORMATION — parties, term, rent, deposit, fees — with a
// link to the full lease PDF (the W-29 /view route). Editing happens only
// through the proper flows (renewal, bill-fee, termination), never here.
// The editable path (needs-review import confirm) still uses LeaseFormModal.
import { useQuery } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { FileText, X } from 'lucide-react'
import { apiGet } from '../lib/api'

const fmtMoney = (n: any) =>
  n != null && n !== '' ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'
const fmtDay = (s: any) =>
  s ? new Date(String(s).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null

const LEASE_TYPE_LABEL: Record<string, string> = {
  fixed_term: 'Fixed term', month_to_month: 'Month-to-month', weekly: 'Weekly', nightly: 'Nightly', long_term: 'Long term',
}
const FEE_TIMING_LABEL: Record<string, string> = {
  move_in: 'due at move-in', monthly_ongoing: 'monthly', move_out: 'at move-out', other: 'as billed',
}
const feeLabel = (t: string) => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
const ordinal = (n: number) => {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`
}

export function LeaseOverviewModal({ leaseId, onClose }: { leaseId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const { data: lease, isLoading } = useQuery(['lease-overview', leaseId], () => apiGet<any>(`/leases/${leaseId}`))

  const tenants: any[] = lease?.tenants || []
  const fees: any[] = (lease?.fees || []).filter((f: any) => f.feeType !== 'security_deposit')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ marginBottom: 0 }}>
            Lease · {lease ? `${lease.unitNumber} — ${lease.propertyName}` : '…'}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>

        {isLoading || !lease ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
        ) : (
          <div style={{ padding: '4px 24px 24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 16px', fontSize: '.86rem' }}>
              <div style={{ color: 'var(--text-3)' }}>Status</div>
              <div style={{ textTransform: 'capitalize' }}>{String(lease.status || '').replace(/_/g, ' ')}</div>

              <div style={{ color: 'var(--text-3)' }}>{tenants.length === 1 ? 'Tenant' : 'Tenants'}</div>
              <div>
                {tenants.length ? tenants.map((t: any) => (
                  <div key={t.id || t.tenantId}>
                    {`${t.firstName || ''} ${t.lastName || ''}`.trim() || '—'}
                    {t.email && <span style={{ color: 'var(--text-3)' }}> · {t.email}</span>}
                    {t.isPrimary && <span style={{ color: 'var(--gold)', fontSize: '.7rem', marginLeft: 6 }}>PRIMARY</span>}
                  </div>
                )) : '—'}
              </div>

              <div style={{ color: 'var(--text-3)' }}>Term</div>
              <div>
                {fmtDay(lease.startDate)} → {lease.endDate ? fmtDay(lease.endDate) : 'ongoing'}
                <span style={{ color: 'var(--text-3)' }}> · {LEASE_TYPE_LABEL[lease.leaseType] || lease.leaseType}</span>
                {lease.autoRenew && <span style={{ color: 'var(--text-3)' }}> · auto-renews</span>}
              </div>

              <div style={{ color: 'var(--text-3)' }}>Rent</div>
              <div>
                <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{fmtMoney(lease.rentAmount)}/mo</span>
                <span style={{ color: 'var(--text-3)' }}> · due on the {ordinal(lease.rentDueDay)}</span>
              </div>

              <div style={{ color: 'var(--text-3)' }}>Deposit</div>
              <div>{fmtMoney(lease.securityDeposit)}</div>

              {lease.lateFeeEnabled && (
                <>
                  <div style={{ color: 'var(--text-3)' }}>Late fee</div>
                  <div>
                    {lease.lateFeeInitialType === 'percent'
                      ? `${Number(lease.lateFeeInitialAmount)}% of rent`
                      : fmtMoney(lease.lateFeeInitialAmount)}
                    <span style={{ color: 'var(--text-3)' }}> after {lease.lateFeeGraceDays ?? 0} day grace</span>
                  </div>
                </>
              )}

              {fees.length > 0 && (
                <>
                  <div style={{ color: 'var(--text-3)' }}>Fees</div>
                  <div>
                    {fees.map((f: any) => (
                      <div key={f.id}>
                        {feeLabel(f.feeType)} — {fmtMoney(f.amount)}
                        <span style={{ color: 'var(--text-3)' }}> ({FEE_TIMING_LABEL[f.dueTiming] || f.dueTiming}{f.isRefundable ? ', refundable' : ''})</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div style={{ color: 'var(--text-3)' }}>Notice</div>
              <div>{lease.noticeDaysRequired} days required to end</div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => navigate(`/view?src=${encodeURIComponent(`/leases/${lease.id}/pdf`)}&title=${encodeURIComponent(`Lease — ${lease.unitNumber || ''}`)}`)}
              >
                <FileText size={14} /> View Full Lease
              </button>
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
