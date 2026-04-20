import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'
import { Check, DollarSign } from 'lucide-react'

const fmt = (n: any) => n != null
  ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '—'

export function SettingsPage() {
  const qc = useQueryClient()
  const { data: me, isLoading } = useQuery<any>('landlord-me', () => apiGet('/landlords/me'))

  const [threshold, setThreshold] = useState<string>('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (me) {
      setThreshold(me.maintApprovalThreshold != null ? String(me.maintApprovalThreshold) : '500')
    }
  }, [me])

  const saveMut = useMutation(
    () => apiPatch('/landlords/me', { maintApprovalThreshold: Number(threshold) }),
    {
      onSuccess: () => {
        qc.invalidateQueries('landlord-me')
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      }
    }
  )

  const thresholdNum = Number(threshold)
  const thresholdValid = !isNaN(thresholdNum) && thresholdNum >= 0
  const thresholdChanged = me && Number(me.maintApprovalThreshold || 500) !== thresholdNum

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Account and property configuration</p>
        </div>
      </div>

      {isLoading ? (
        <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>

          {/* Account */}
          <div className="card">
            <div className="card-header"><span className="card-title">Account</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Business Name</div>
                <div style={{ fontWeight: 500 }}>{me?.businessName || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>EIN</div>
                <div className="mono">{me?.ein || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Name</div>
                <div style={{ fontWeight: 500 }}>{[me?.firstName, me?.lastName].filter(Boolean).join(' ') || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Email</div>
                <div>{me?.email || '—'}</div>
              </div>
            </div>
          </div>

          {/* Billing */}
          <div className="card">
            <div className="card-header"><span className="card-title">Billing</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Volume Tier</div>
                <div><span className="badge badge-green">{me?.volumeTier || 'standard'}</span></div>
              </div>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Stripe Bank</div>
                <div>
                  {me?.stripeBankVerified
                    ? <span className="badge badge-green">Verified</span>
                    : <span className="badge badge-amber">Not Verified</span>}
                </div>
              </div>
            </div>
          </div>

          {/* Maintenance Approval */}
          <div className="card">
            <div className="card-header"><span className="card-title">Maintenance Approval</span></div>
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
                Set a cost threshold for maintenance requests. Any request with an estimated cost above this amount will be held in <strong style={{ color: 'var(--amber)' }}>Awaiting Approval</strong> status and require your explicit approval before being assigned to a contractor.
              </div>
              <div style={{ maxWidth: 280 }}>
                <label style={{
                  fontSize: '.72rem',
                  fontWeight: 600,
                  color: 'var(--text-3)',
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  display: 'block',
                  marginBottom: 5
                }}>
                  Approval Threshold
                </label>
                <div style={{ position: 'relative' }}>
                  <DollarSign size={14} style={{
                    position: 'absolute',
                    left: 11,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-3)'
                  }} />
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="10"
                    value={threshold}
                    onChange={e => setThreshold(e.target.value)}
                    placeholder="500"
                    style={{ width: '100%', paddingLeft: 30 }}
                  />
                </div>
                <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 6 }}>
                  Requests over {fmt(thresholdNum || 0)} will require approval.
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => saveMut.mutate()}
                  disabled={!thresholdValid || !thresholdChanged || saveMut.isLoading}
                >
                  {saveMut.isLoading ? <span className="spinner" /> : 'Save'}
                </button>
                {saved && (
                  <span style={{ fontSize: '.78rem', color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Check size={12} /> Saved
                  </span>
                )}
                {saveMut.isError && (
                  <span style={{ fontSize: '.78rem', color: 'var(--red)' }}>
                    Failed to save. Try again.
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Notifications placeholder */}
          <div className="card">
            <div className="card-header"><span className="card-title">Notifications</span></div>
            <div style={{ color: 'var(--text-3)', fontSize: '.88rem', marginTop: 12 }}>
              Notification preferences coming soon.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
