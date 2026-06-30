import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { api, apiGet, apiPatch } from '../lib/api'
import { Check, DollarSign, X, ShieldCheck } from 'lucide-react'
import { LAUNCH_HIDDEN } from '../components/layout/Layout'
import { useAuth } from '../context/AuthContext'

interface LinkedPmCompany {
  id: string
  name: string
  businessEmail: string | null
  status: string
  propertyCount: number
}

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
    () => apiPatch('/landlords/me', {
      maintApprovalThreshold: Number(threshold),
    }),
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
  const thresholdChanged = me && (
    Number(me.maintApprovalThreshold || 500) !== thresholdNum
  )

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

          {/* Security / 2FA */}
          <SecurityCard />

          {/* Billing */}
          <div className="card">
            <div className="card-header"><span className="card-title">Billing</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Platform Fee</div>
                <div style={{ fontSize: '.88rem', color: 'var(--text-0)', fontWeight: 600 }}>$2 / occupied unit / mo</div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>Billed monthly · deducted from your payouts</div>
              </div>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Bank Account</div>
                <div>
                  {me?.bankAccountReady
                    ? <span className="badge badge-green">Ready</span>
                    : <span className="badge badge-amber">Not configured</span>}
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

          {/* Default PM Company (S157) — S512: hidden at launch with the
              PM-company surface (PM Invitations not in the launch trio). */}
          {!LAUNCH_HIDDEN.has('/pm-invitations') && (
            <DefaultPmCompanyCard
              currentDefaultId={me?.defaultPmCompanyId ?? null}
              onChange={() => qc.invalidateQueries('landlord-me')}
            />
          )}

          {/* Notifications placeholder */}
          <div className="card">
            <div className="card-header"><span className="card-title">Notifications</span></div>
            <div style={{ color: 'var(--text-3)', fontSize: '.88rem', marginTop: 12 }}>
              See <a href="/notification-prefs">Notification Preferences</a> in the sidebar.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Two-factor authentication surface. Optional-with-prompts for the
// landlord role: enable routes to the full enrollment page; disable
// posts the password to /auth/totp/disable.
function SecurityCard() {
  const { user, refresh } = useAuth()
  const navigate = useNavigate()
  const [showConfirm, setShowConfirm] = useState(false)
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')
  const [success, setSuccess] = useState('')

  const enabled = !!user?.totpEnabled

  const onDisable = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setErr('')
    try {
      await api.post('/auth/totp/disable', { password })
      await refresh()
      setShowConfirm(false); setPassword('')
      setSuccess('Two-factor disabled.')
    } catch (ex: any) {
      setErr(ex.response?.data?.error || 'Could not disable 2FA. Check your password.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">Two-Factor Authentication</span></div>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 9,
            background: enabled ? 'var(--green-bg)' : 'var(--amber-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem'
          }}>
            {enabled ? '✅' : '⚠️'}
          </div>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-0)', fontSize: '.95rem' }}>
              {enabled ? 'Enabled' : 'Not enabled'}
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
              {enabled
                ? 'You are prompted for a 6-digit code on every sign-in.'
                : 'Protect your account with an authenticator-app code at sign-in.'}
            </div>
          </div>
        </div>

        {success && (
          <div className="alert alert-success" style={{ marginBottom: 12 }}>{success}</div>
        )}

        {!enabled && (
          <button className="btn btn-primary" onClick={() => navigate('/totp/enroll')}>
            <ShieldCheck size={15} /> Enable two-factor
          </button>
        )}

        {enabled && !showConfirm && (
          <button className="btn btn-danger" onClick={() => { setShowConfirm(true); setSuccess('') }}>
            Disable two-factor
          </button>
        )}

        {enabled && showConfirm && (
          <form onSubmit={onDisable} style={{ marginTop: 8, padding: 14, background: 'var(--bg-1)', border: '1px solid var(--border-1)', borderRadius: 8 }}>
            <div style={{ fontSize: '.82rem', color: 'var(--text-1)', marginBottom: 10, lineHeight: 1.5 }}>
              Confirm your password to disable 2FA. After disable, any saved recovery codes are invalidated.
            </div>
            <div className="form-group" style={{ maxWidth: 320 }}>
              <label className="form-label">Password</label>
              <input
                className="form-input"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoFocus
                required
              />
            </div>
            {err && <div className="alert alert-danger" style={{ marginBottom: 10 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-danger" type="submit" disabled={submitting || !password}>
                {submitting ? <span className="spinner" /> : 'Disable two-factor'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => { setShowConfirm(false); setPassword(''); setErr('') }} disabled={submitting}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function DefaultPmCompanyCard({
  currentDefaultId, onChange,
}: {
  currentDefaultId: string | null
  onChange: () => void
}) {
  const linkedQ = useQuery<LinkedPmCompany[]>(
    'linked-pm-companies',
    () => apiGet<LinkedPmCompany[]>('/landlords/me/linked-pm-companies'),
  )
  const [pendingId, setPendingId] = useState<string>('')

  const setMut = useMutation(
    (pmCompanyId: string | null) => apiPatch('/landlords/me/default-pm-company', { pmCompanyId }),
    { onSuccess: () => { setPendingId(''); onChange() } },
  )

  const linked = linkedQ.data ?? []
  const currentName = currentDefaultId
    ? linked.find(c => c.id === currentDefaultId)?.name ?? '— unlinked PM —'
    : null

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">Default PM Company</span></div>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
          When set, this PM company becomes the proposed manager for any
          new property you add — you can override per-property at creation
          time. Only PM companies currently managing at least one of your
          properties can be set as the default.
        </div>

        {currentDefaultId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Current default:</div>
            <div style={{ fontWeight: 600, color: 'var(--gold)' }}>{currentName}</div>
            <button className="btn btn-ghost btn-sm"
                    disabled={setMut.isLoading}
                    onClick={() => setMut.mutate(null)}>
              <X size={11} style={{ marginRight: 4 }} /> Clear
            </button>
          </div>
        )}

        {linked.length === 0 ? (
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', fontStyle: 'italic' }}>
            No PM companies are currently managing your properties. Send an invitation from <a href="/pm-invitations">PM Invitations</a> to link one.
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 480 }}>
            <select className="input" value={pendingId}
                    onChange={e => setPendingId(e.target.value)}
                    style={{ flex: 1 }}>
              <option value="">— select a PM to set as default —</option>
              {linked.filter(c => c.id !== currentDefaultId).map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.propertyCount} {c.propertyCount === 1 ? 'property' : 'properties'}
                </option>
              ))}
            </select>
            <button className="btn btn-primary"
                    disabled={!pendingId || setMut.isLoading}
                    onClick={() => setMut.mutate(pendingId)}>
              {setMut.isLoading ? '…' : 'Set Default'}
            </button>
          </div>
        )}

        {setMut.isError && (
          <div style={{ fontSize: '.74rem', color: 'var(--red)', marginTop: 8 }}>
            {(setMut.error as any)?.response?.data?.error?.message || 'Save failed.'}
          </div>
        )}
      </div>
    </div>
  )
}

