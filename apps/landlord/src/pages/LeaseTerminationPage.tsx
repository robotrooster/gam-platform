import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

type TerminationQuote = {
  feeAmount: number
  feeBasis: 'lease_specific' | 'landlord_default' | 'no_policy'
  rentAmount: number
  monthsRentMultiplier: number | null
  existingRequest: {
    id: string
    status: string
    feeAmount: string
    feeBasis: string
    requestedAt: string
    reason: string | null
    feePaidAt: string | null
    feeChargeFailed: boolean
    feeChargeFailureReason: string | null
    feeWaivedAt: string | null
    feeWaiverReason: string | null
    terminatedAt: string | null
  } | null
}

const fmt = (n: number | string) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function LeaseTerminationPage() {
  const { id: leaseId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [waiveReason, setWaiveReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const { data, isLoading } = useQuery<TerminationQuote>(
    ['termination-quote', leaseId],
    () => apiGet<TerminationQuote>(`/leases/${leaseId}/termination-quote`),
  )

  const waiveMut = useMutation(
    () => apiPost(`/leases/${leaseId}/waive-early-termination`, { reason: waiveReason || undefined }),
    {
      onSuccess: () => {
        setSuccess('Fee waived. Lease has been terminated.')
        qc.invalidateQueries(['termination-quote', leaseId])
        qc.invalidateQueries('leases')
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  if (isLoading || !data) return <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>

  const r = data.existingRequest
  const isPending = r && (r.status === 'requested' || r.status === 'failed')

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/leases')} style={{ marginBottom: 8 }}>
            <ArrowLeft size={14} /> Leases
          </button>
          <h1>Early Termination</h1>
          <div className="page-sub">
            Lease <span style={{ fontFamily: 'var(--font-mono)' }}>{leaseId?.slice(0, 8)}…</span>
          </div>
        </div>
      </div>

      {error && (
        <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(239,68,68,.08)', borderColor: 'rgba(239,68,68,.3)', color: 'var(--red)' }}>
          {error}
        </div>
      )}
      {success && (
        <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(34,197,94,.06)', borderColor: 'rgba(34,197,94,.25)', color: 'var(--green)' }}>
          {success}
        </div>
      )}

      {/* Policy summary */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
          Fee policy on this lease
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-0)' }}>
          {data.feeAmount > 0 ? fmt(data.feeAmount) : 'No fee'}
        </div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 4 }}>
          {data.feeBasis === 'lease_specific' && 'Specified in the signed lease (early_termination_fee).'}
          {data.feeBasis === 'landlord_default' && `Your default policy (${data.monthsRentMultiplier}× monthly rent of ${fmt(data.rentAmount)}).`}
          {data.feeBasis === 'no_policy' && 'No fee on file. Tenants can terminate without payment via the in-app flow.'}
        </div>
      </div>

      {/* Existing request */}
      {!r ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
          No termination request on this lease.
        </div>
      ) : (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span className={`badge ${
              r.status === 'fee_paid' || r.status === 'fee_waived' || r.status === 'terminated' ? 'badge-green' :
              r.status === 'requested' ? 'badge-amber' :
              r.status === 'failed' ? 'badge-red' :
              'badge-muted'
            }`}>{r.status.replace('_', ' ')}</span>
            <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
              requested {new Date(r.requestedAt).toLocaleString()}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, fontSize: '.85rem', marginBottom: 12 }}>
            <div style={{ color: 'var(--text-3)' }}>Fee</div>
            <div className="mono">{fmt(r.feeAmount)} ({r.feeBasis.replace('_', ' ')})</div>
            {r.reason && <>
              <div style={{ color: 'var(--text-3)' }}>Tenant reason</div>
              <div style={{ fontStyle: 'italic' }}>"{r.reason}"</div>
            </>}
            {r.feePaidAt && <>
              <div style={{ color: 'var(--text-3)' }}>Paid</div>
              <div className="mono" style={{ color: 'var(--green)' }}>{new Date(r.feePaidAt).toLocaleString()}</div>
            </>}
            {r.feeWaivedAt && <>
              <div style={{ color: 'var(--text-3)' }}>Waived</div>
              <div className="mono" style={{ color: 'var(--green)' }}>{new Date(r.feeWaivedAt).toLocaleString()}</div>
            </>}
            {r.feeWaiverReason && <>
              <div style={{ color: 'var(--text-3)' }}>Waiver reason</div>
              <div style={{ fontStyle: 'italic' }}>"{r.feeWaiverReason}"</div>
            </>}
            {r.feeChargeFailed && <>
              <div style={{ color: 'var(--text-3)' }}>Charge failure</div>
              <div style={{ color: 'var(--red)' }}>{r.feeChargeFailureReason || 'Unknown'}</div>
            </>}
            {r.terminatedAt && <>
              <div style={{ color: 'var(--text-3)' }}>Terminated</div>
              <div className="mono">{new Date(r.terminatedAt).toLocaleString()}</div>
            </>}
          </div>

          {/* Waive panel */}
          {isPending && (
            <div style={{ paddingTop: 14, borderTop: '1px solid var(--border-0)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <AlertTriangle size={16} style={{ color: 'var(--amber)' }} />
                <strong>Waive the fee?</strong>
              </div>
              <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12 }}>
                Waiving the {fmt(r.feeAmount)} fee terminates the lease immediately without charging the tenant.
                Use for good-faith cases (job relocation, mutual termination, hardship). Recorded with your name + reason.
              </div>
              <textarea
                value={waiveReason}
                onChange={e => setWaiveReason(e.target.value)}
                placeholder="Reason for waiver (visible in audit log + tenant record)"
                rows={2}
                className="input"
                style={{ width: '100%', marginBottom: 12 }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  className="btn btn-primary"
                  onClick={() => waiveMut.mutate()}
                  disabled={waiveMut.isLoading || !waiveReason.trim()}
                  title={!waiveReason.trim() ? 'Add a reason first' : 'Waive fee + terminate lease'}
                >
                  {waiveMut.isLoading ? 'Processing…' : 'Waive fee & terminate'}
                </button>
              </div>
            </div>
          )}

          {/* Read-only view for resolved requests */}
          {!isPending && (r.status === 'fee_paid' || r.status === 'fee_waived' || r.status === 'terminated') && (
            <div style={{ paddingTop: 14, borderTop: '1px solid var(--border-0)', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--green)' }}>
              <CheckCircle2 size={16} /> Lease terminated. Move-out workflow is separate (see <a href={`/leases/${leaseId}/deposit-return`} style={{ color: 'var(--gold)' }}>Deposit Return</a>).
            </div>
          )}
          {r.status === 'cancelled' && (
            <div style={{ paddingTop: 14, borderTop: '1px solid var(--border-0)', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)' }}>
              <X size={16} /> Tenant cancelled this request.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
