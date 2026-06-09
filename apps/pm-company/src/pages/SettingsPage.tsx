import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useAuth } from '../context/AuthContext'
import { apiGet, apiPatch } from '../lib/api'
import { Pencil, Save, X } from 'lucide-react'

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
      onError:   (e: any) => setErr(e?.response?.data?.error?.message || 'Save failed.'),
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
