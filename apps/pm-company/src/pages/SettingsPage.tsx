import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useAuth } from '../context/AuthContext'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { Pencil, Save, X, ShieldCheck } from 'lucide-react'

interface PmCompany {
  id: string
  name: string
  businessEmail: string | null
  businessPhone: string | null
  businessStreet1: string | null
  businessCity: string | null
  businessState: string | null
  businessZip: string | null
  ein: string | null
  status: string
  createdAt: string
}

export function SettingsPage() {
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id
  const qc = useQueryClient()

  const cQ = useQuery<PmCompany>(
    ['pm-company', cid],
    () => apiGet<PmCompany>(`/pm/companies/${cid}`),
    { enabled: !!cid },
  )

  const canEdit = activePmCompany?.myRole === 'owner' || activePmCompany?.myRole === 'manager'

  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Partial<PmCompany>>({})
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (cQ.data && !editing) {
      setForm({
        name: cQ.data.name,
        businessEmail: cQ.data.businessEmail,
        businessPhone: cQ.data.businessPhone,
        businessStreet1: cQ.data.businessStreet1,
        businessCity: cQ.data.businessCity,
        businessState: cQ.data.businessState,
        businessZip: cQ.data.businessZip,
        ein: cQ.data.ein,
      })
    }
  }, [cQ.data, editing])

  const saveMut = useMutation(
    () => apiPatch(`/pm/companies/${cid}`, {
      name:             form.name?.trim() || undefined,
      businessEmail:   form.businessEmail   ?? null,
      businessPhone:   form.businessPhone   ?? null,
      businessStreet1: form.businessStreet1 ?? null,
      businessCity:    form.businessCity    ?? null,
      businessState:   form.businessState   ?? null,
      businessZip:     form.businessZip     ?? null,
      ein:              form.ein              ?? null,
    }),
    {
      onSuccess: () => { qc.invalidateQueries(['pm-company', cid]); setEditing(false); setErr(null) },
      onError:   (e: any) => setErr(e?.response?.data?.error || 'Save failed.'),
    },
  )

  const onChange = (k: keyof PmCompany, v: string) => setForm(f => ({ ...f, [k]: v.trim() === '' ? null : v }))

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>Settings</h1>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
          Company details and configuration.
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Company Details</div>
          {!editing && canEdit && (
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
              <Pencil size={12} style={{ marginRight: 4 }} /> Edit
            </button>
          )}
        </div>

        {cQ.isLoading ? (
          <div style={{ color: 'var(--text-3)' }}>Loading…</div>
        ) : !cQ.data ? (
          <div style={{ color: 'var(--text-3)' }}>Couldn&apos;t load company.</div>
        ) : !editing ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Name"            value={cQ.data.name} />
            <Field label="Status"          value={cQ.data.status} />
            <Field label="Business email"  value={cQ.data.businessEmail} />
            <Field label="Business phone"  value={cQ.data.businessPhone} />
            <Field label="Address"         value={[cQ.data.businessStreet1, cQ.data.businessCity, cQ.data.businessState, cQ.data.businessZip].filter(Boolean).join(', ') || null} />
            <Field label="EIN"             value={cQ.data.ein} />
            <Field label="Created"         value={new Date(cQ.data.createdAt).toLocaleDateString()} />
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Edit label="Name *"           value={form.name ?? ''}             onChange={v => onChange('name', v)} />
            <Edit label="Business email"   value={form.businessEmail ?? ''}   onChange={v => onChange('businessEmail', v)}   type="email" />
            <Edit label="Business phone"   value={form.businessPhone ?? ''}   onChange={v => onChange('businessPhone', v)} />
            <Edit label="EIN"              value={form.ein ?? ''}              onChange={v => onChange('ein', v)} />
            <Edit label="Street"           value={form.businessStreet1 ?? ''} onChange={v => onChange('businessStreet1', v)} />
            <Edit label="City"             value={form.businessCity ?? ''}    onChange={v => onChange('businessCity', v)} />
            <Edit label="State"            value={form.businessState ?? ''}   onChange={v => onChange('businessState', v)} />
            <Edit label="ZIP"              value={form.businessZip ?? ''}     onChange={v => onChange('businessZip', v)} />
          </div>
        )}

        {err && (
          <div style={{ marginTop: 10, padding: 8, background: 'rgba(220,76,76,.1)', borderRadius: 6, fontSize: '.74rem', color: 'var(--red, #dc4c4c)' }}>
            {err}
          </div>
        )}

        {editing && (
          <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
            <button className="btn btn-primary"
                    disabled={!form.name || saveMut.isLoading}
                    onClick={() => saveMut.mutate()}>
              <Save size={12} style={{ marginRight: 4 }} /> {saveMut.isLoading ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-ghost"
                    disabled={saveMut.isLoading}
                    onClick={() => { setEditing(false); setErr(null) }}>
              <X size={12} style={{ marginRight: 4 }} /> Cancel
            </button>
          </div>
        )}

        {!editing && !canEdit && (
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 14 }}>
            You don&apos;t have permission to edit company details. Owner or manager role required.
          </div>
        )}
      </div>

      <SecuritySection />
    </div>
  )
}

// 2FA surface — enable (navigate to enroll flow) / disable (password
// re-confirm). PM-company users are not in MANDATORY_TOTP_ROLES, so 2FA
// is optional; this is the opt-in/opt-out control.
function SecuritySection() {
  const { user, refresh } = useAuth()
  const navigate = useNavigate()
  const [showConfirm, setShowConfirm] = useState(false)
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')
  const [success, setSuccess] = useState('')

  const onDisable = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setErr('')
    try {
      await apiPost('/auth/totp/disable', { password })
      await refresh()
      setShowConfirm(false); setPassword('')
      setSuccess('Two-factor authentication disabled.')
    } catch (ex: any) {
      setErr(ex?.response?.data?.error || 'Could not disable 2FA. Check your password.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="card" style={{ padding: 16, maxWidth: 620 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <ShieldCheck size={16} style={{ color: 'var(--gold)' }} />
        <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Two-factor authentication</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: user?.totpEnabled ? 'var(--green-bg)' : 'var(--amber-bg)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem',
        }}>
          {user?.totpEnabled ? '✅' : '⚠️'}
        </div>
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-0)', fontSize: '.95rem' }}>
            {user?.totpEnabled ? 'Enabled' : 'Not enrolled'}
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
            {user?.totpEnabled
              ? 'You will be prompted for a 6-digit code on every sign-in.'
              : 'Add a second factor to protect your account. Optional, but recommended.'}
          </div>
        </div>
      </div>

      {success && (
        <div className="alert alert-success" style={{ marginBottom: 12 }}>{success}</div>
      )}

      {!user?.totpEnabled && (
        <button className="btn btn-primary" onClick={() => navigate('/totp/enroll')}>
          Enable two-factor
        </button>
      )}

      {user?.totpEnabled && !showConfirm && (
        <button className="btn btn-danger" onClick={() => { setShowConfirm(true); setSuccess('') }}>
          Disable two-factor
        </button>
      )}

      {user?.totpEnabled && showConfirm && (
        <form onSubmit={onDisable} style={{ marginTop: 8, padding: 14, background: 'var(--bg-1)', border: '1px solid var(--border-1)', borderRadius: 8 }}>
          <div style={{ fontSize: '.82rem', color: 'var(--text-1)', marginBottom: 10, lineHeight: 1.5 }}>
            Confirm your password to disable 2FA. After disable, any saved recovery codes are invalidated.
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: '.7rem', fontWeight: 600, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.06em' }}>Password</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              required
              style={{ width: '100%' }}
            />
          </div>
          {err && (
            <div style={{ marginBottom: 10, padding: 8, background: 'rgba(220,76,76,.1)', borderRadius: 6, fontSize: '.74rem', color: 'var(--red, #dc4c4c)' }}>{err}</div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-danger" disabled={submitting || !password}>
              {submitting ? 'Disabling…' : 'Disable two-factor'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setShowConfirm(false); setPassword(''); setErr('') }} disabled={submitting}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: '.88rem', color: 'var(--text-1)' }}>{value || '—'}</div>
    </div>
  )
}

function Edit({ label, value, onChange, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; type?: string
}) {
  return (
    <div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
        {label}
      </div>
      <input className="input" type={type} value={value} onChange={e => onChange(e.target.value)} style={{ width: '100%' }} />
    </div>
  )
}
