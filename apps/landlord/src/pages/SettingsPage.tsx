import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { api, apiGet, apiPatch } from '../lib/api'
import { Check, DollarSign, X } from 'lucide-react'
import { LAUNCH_HIDDEN } from '../components/layout/Layout'
import { useAuth } from '../context/AuthContext'
import { usePerms } from '../lib/permissions'
import { NotificationPrefsSection } from './NotificationPrefsPage'

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

// S553: owner-members of this landlord entity (multi-owner LLCs — Oak
// Park). Any owner can add a co-owner by email (they must already have a
// GAM landlord account); the founding owner can't be removed. Memberships
// take effect at the co-owner's next sign-in.
function OwnersSection() {
  const qc = useQueryClient()
  const { data: members = [], isLoading } = useQuery<any[]>('landlord-members', () => apiGet('/landlords/members'))
  const [email, setEmail] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const addMut = useMutation(() => api.post('/landlords/members', { email: email.trim() }).then(r => r.data), {
    onSuccess: () => { qc.invalidateQueries('landlord-members'); setEmail(''); setErr(null) },
    onError: (e: any) => setErr(e?.response?.data?.error?.message || e?.response?.data?.error || 'Could not add owner.'),
  })
  const rmMut = useMutation((id: string) => api.delete(`/landlords/members/${id}`).then(r => r.data), {
    onSuccess: () => qc.invalidateQueries('landlord-members'),
  })
  if (isLoading) return null
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>Owners</div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 12 }}>
        Co-owners see this entity's properties alongside their own portfolio. They need their own GAM landlord
        account first; changes apply the next time they sign in.
      </div>
      {members.map((m: any) => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-1, rgba(255,255,255,.06))' }}>
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-0)', fontWeight: 600 }}>
              {[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email}
              {m.isFounding && <span style={{ marginLeft: 8, fontSize: '.62rem', color: 'var(--gold)', fontWeight: 700 }}>FOUNDING</span>}
            </div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{m.email}</div>
          </div>
          {!m.isFounding && (
            <button className="btn btn-ghost btn-sm" onClick={() => rmMut.mutate(m.id)} disabled={rmMut.isLoading}>
              <X size={12} /> Remove
            </button>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="co-owner@email.com"
          style={{ flex: 1, background: 'var(--surface-1, rgba(255,255,255,.04))', border: '1px solid var(--border-1, rgba(255,255,255,.1))', borderRadius: 8, padding: '8px 10px', color: 'var(--text-0)', fontSize: '.8rem' }}
        />
        <button className="btn btn-primary btn-sm" disabled={!email.trim() || addMut.isLoading} onClick={() => addMut.mutate()}>
          Add owner
        </button>
      </div>
      {err && <div style={{ fontSize: '.72rem', color: '#ef4444', marginTop: 8 }}>{err}</div>}
    </div>
  )
}

export function SettingsPage() {
  const qc = useQueryClient()
  const { data: me, isLoading } = useQuery<any>('landlord-me', () => apiGet('/landlords/me'))

  const [threshold, setThreshold] = useState<string>('')
  const [depThreshold, setDepThreshold] = useState<string>('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (me) {
      setThreshold(me.maintApprovalThreshold != null ? String(me.maintApprovalThreshold) : '500')
      setDepThreshold(me.depositReturnApprovalThreshold != null ? String(me.depositReturnApprovalThreshold) : '500')
    }
  }, [me])

  const saveMut = useMutation(
    () => apiPatch('/landlords/me', {
      maintApprovalThreshold: Number(threshold),
      depositReturnApprovalThreshold: Number(depThreshold),
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('landlord-me')
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      }
    }
  )

  const { can } = usePerms()

  const thresholdNum = Number(threshold)
  const depThresholdNum = Number(depThreshold)
  const thresholdValid = !isNaN(thresholdNum) && thresholdNum >= 0
    && !isNaN(depThresholdNum) && depThresholdNum >= 0
  const thresholdChanged = me && (
    Number(me.maintApprovalThreshold || 500) !== thresholdNum
    || Number(me.depositReturnApprovalThreshold ?? 500) !== depThresholdNum
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Account and property configuration</p>
        </div>
      </div>

      <FeatureRequestCard />

      {isLoading ? (
        <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>

          {/* Account */}
          {can('settings.account_view') && (
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
          )}

          {/* Security / 2FA */}
          <SecurityCard />

          {/* Billing */}
          {can('settings.billing_view') && (
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
          )}

          {/* Maintenance Approval */}
          {can('settings.maintenance_approval') && (
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

              {/* S548: deposit-return approval threshold — staff finalize refunds
                  at/below this; larger refunds park for the landlord's approval. */}
              <div style={{ maxWidth: 280, marginTop: 18 }}>
                <label style={{
                  fontSize: '.72rem',
                  fontWeight: 600,
                  color: 'var(--text-3)',
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  display: 'block',
                  marginBottom: 5
                }}>
                  Deposit Return Approval Threshold
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
                    value={depThreshold}
                    onChange={e => setDepThreshold(e.target.value)}
                    placeholder="500"
                    style={{ width: '100%', paddingLeft: 30 }}
                  />
                </div>
                <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 6 }}>
                  Team members can finalize deposit refunds up to {fmt(depThresholdNum || 0)}; anything above waits for your approval. Set 0 to approve every refund yourself.
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
          )}

          {/* Default PM Company (S157) — S512: hidden at launch with the
              PM-company surface (PM Invitations not in the launch trio). */}
          {can('settings.default_pm_company') && !LAUNCH_HIDDEN.has('/pm-invitations') && (
            <DefaultPmCompanyCard
              currentDefaultId={me?.defaultPmCompanyId ?? null}
              onChange={() => qc.invalidateQueries('landlord-me')}
            />
          )}

          {/* S553: entity owner-members (multi-owner LLCs). */}
          <OwnersSection />

          {/* W-53 (S531): Notification Prefs merged in as a real section —
              the standalone nav item is gone. The section renders its own
              cards, so no wrapper card here. */}
          <NotificationPrefsSection />
        </div>
      )}
    </div>
  )
}

// Two-factor authentication surface. S574: email-code 2FA is MANDATORY for
// every landlord (enforced server-side at login), so this is a read-only status
// card — no enable/disable, no authenticator enrollment. The code always goes to
// the account's login email; changing that email changes the 2FA destination.
function SecurityCard() {
  const { user } = useAuth()

  // Legacy authenticator accounts (pre-S574) still verify via TOTP at login;
  // note it here so the surface reads truthfully. No new landlord can enroll one.
  const legacyTotp = !!user?.totpEnabled

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">Two-Factor Authentication</span></div>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 9,
            background: 'var(--green-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem'
          }}>
            🔒
          </div>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-0)', fontSize: '.95rem' }}>
              On — email code
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              {legacyTotp
                ? 'Every sign-in requires your authenticator-app code. New accounts use an emailed 6-digit code.'
                : `Every sign-in requires a 6-digit code sent to ${user?.email || 'your email'}. This protects your tenants' data and is always on.`}
            </div>
          </div>
        </div>
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


// ── FEATURE REQUEST (S571) ────────────────────────────────────────────────
// Landlords submit ideas the same way tenants do (POST /feature-requests); the
// GAM team reviews them in the admin portal. Input from both parties.
function FeatureRequestCard() {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    setSubmitting(true); setError('')
    try {
      await api.post('/feature-requests', { title: title.trim(), description: description.trim() })
      setDone(true)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not submit your request. Please try again.')
    }
    setSubmitting(false)
  }
  const reset = () => { setOpen(false); setTitle(''); setDescription(''); setError(''); setDone(false) }

  return (
    <div className="card" style={{ marginBottom: 16, background: 'rgba(59,130,246,.04)', border: '1px solid rgba(59,130,246,.2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>💡 Have a feature idea?</div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-3)', lineHeight: 1.5 }}>Suggest a new capability or improvement. Requests go directly to the GAM team.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>Submit request →</button>
      </div>

      {open && (
        <div className="modal-overlay" onClick={reset}>
          <div className="modal" style={{ maxWidth: 480, width: '95vw' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>💡 Suggest a feature</h3>
              <button className="btn btn-ghost btn-sm" onClick={reset} style={{ padding: 6 }}><X size={15} /></button>
            </div>
            {done ? (
              <>
                <p style={{ fontSize: '.85rem', color: 'var(--text-2)', margin: '4px 0 20px' }}>Thanks — your idea went to the GAM team. We read every one.</p>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" onClick={reset}>Done</button></div>
              </>
            ) : (
              <>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Title</label>
                  <input className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={140} placeholder="e.g. Bulk-import maintenance history" autoFocus style={{ width: '100%' }} />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Details</label>
                  <textarea className="input" rows={4} value={description} onChange={e => setDescription(e.target.value)} maxLength={4000} placeholder="Describe what you'd like and why it would help…" style={{ width: '100%', resize: 'vertical' }} />
                </div>
                {error && <div style={{ fontSize: '.78rem', color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn btn-ghost" onClick={reset}>Cancel</button>
                  <button className="btn btn-primary" disabled={submitting || title.trim().length < 3 || description.trim().length < 5} onClick={submit}>
                    {submitting ? 'Submitting…' : 'Submit request'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
