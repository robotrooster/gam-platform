import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { Cake, Check } from 'lucide-react'
import { apiGet, apiPatch } from '../lib/api'
import { useAuth } from '../context/AuthContext'

// 10/13 (Nic): "emailing tenants on their birthday and saying, Hey, happy
// birthday from GAM ... Thank you for using GAM" — to tenants AND landlords,
// and landlords need a birthday on their profile. This is that birthday: the
// signed-in person's own (not the company's — the account owns its companies),
// stored on their account through PATCH /auth/me. Optional; leaving it empty
// means no birthday email. Only a landlord account has one here — a team
// member gets no birthday email, and a tenant's birthday comes from their lease.

const BIRTHDAY_KEY = 'my-birthday'

export function BirthdayField() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const isLandlord = user?.role === 'landlord'
  const { data: saved, isLoading } = useQuery<string | null>(BIRTHDAY_KEY,
    () => apiGet<any>('/auth/me').then(me => me?.dateOfBirth ?? null),
    { enabled: isLandlord })
  const [value, setValue] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => { setValue(saved ?? '') }, [saved])

  const save = useMutation(
    () => apiPatch('/auth/me', { dateOfBirth: value || null }),
    {
      onSuccess: () => {
        setErr(null); setDone(true)
        qc.invalidateQueries(BIRTHDAY_KEY)
        setTimeout(() => setDone(false), 2500)
      },
      onError: (e: any) => setErr(e?.response?.data?.error?.message || e?.response?.data?.error || 'Could not save your birthday.'),
    },
  )

  if (!isLandlord || isLoading) return null
  const changed = (saved ?? '') !== value
  // The box will not offer a date after today.
  const today = new Date().toLocaleDateString('en-CA')

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-0)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Cake size={14} />
        <strong style={{ fontSize: '.82rem' }}>Your birthday</strong>
      </div>
      <p style={{ fontSize: '.78rem', color: 'var(--text-3)', margin: '0 0 10px', maxWidth: 560 }}>
        Optional. GAM sends you a happy-birthday email on the day. You can turn that email off
        under Notification Preferences.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" type="date" aria-label="Your birthday" value={value}
          min="1900-01-01" max={today} style={{ maxWidth: 200 }}
          onChange={e => { setValue(e.target.value); setErr(null) }} />
        <button className="btn btn-primary btn-sm" disabled={!changed || save.isLoading}
          onClick={() => save.mutate()}>
          {save.isLoading ? 'Saving…' : 'Save'}
        </button>
        {done && (
          <span style={{ fontSize: '.78rem', color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Check size={12} /> Saved
          </span>
        )}
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: '.76rem', marginTop: 8 }}>{err}</div>}
    </div>
  )
}
