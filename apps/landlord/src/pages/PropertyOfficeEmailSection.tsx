import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from 'react-query'
import { Mail } from 'lucide-react'
import { apiPatch } from '../lib/api'

// 10/5 (Nic): replies from this property's residents, guests and applicants —
// to an invoice, a receipt, a notice — go to the property, never to GAM. This
// is where. Until it is set they go to whoever runs the property. It is also
// the contact guests see on the booking site.

const lbl = { fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4, display: 'block' } as const

export function PropertyOfficeEmailSection(
  { property, onSaved }: { property: any; onSaved: () => void },
) {
  const qc = useQueryClient()
  const [email, setEmail] = useState(property?.officeEmail || '')
  const [err, setErr]     = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setEmail(property?.officeEmail || ''); setSaved(false); setErr(null)
  }, [property?.id, property?.officeEmail])

  const save = useMutation(
    () => apiPatch(`/properties/${property.id}/office-email`, { officeEmail: email.trim() }),
    {
      onSuccess: () => { setErr(null); setSaved(true); qc.invalidateQueries('properties'); onSaved() },
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not save'),
    },
  )
  const dirty = email.trim().toLowerCase() !== (property?.officeEmail || '')

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3 style={{ display:'flex', alignItems:'center', gap:8, margin:'0 0 4px', fontSize:'.95rem' }}>
        <Mail size={16} /> Office email
      </h3>
      <p style={{ fontSize:'.78rem', color:'var(--text-3)', margin:'0 0 16px', maxWidth:640 }}>
        When residents, guests or applicants at <strong>{property?.name}</strong> reply to an email
        from us — a bill, a receipt, a notice — their reply comes here. Guests also see it on your
        booking site. Leave it blank and replies go to whoever runs this property.
      </p>
      <div style={{ maxWidth:400 }}>
        <label style={lbl}>Replies go to</label>
        <input type="email" value={email} placeholder="office@yourproperty.com"
          onChange={e => { setEmail(e.target.value); setSaved(false) }}
          style={{ width:'100%' }} />
      </div>
      {err && <p style={{ color:'var(--red)', fontSize:'.78rem', marginTop:10 }}>{err}</p>}
      <div style={{ display:'flex', alignItems:'center', gap:12, marginTop:14 }}>
        <button className="btn btn-primary btn-sm" disabled={!dirty || save.isLoading} onClick={() => save.mutate()}>
          {save.isLoading ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && (
          <span style={{ fontSize:'.75rem', color:'var(--text-3)' }}>
            {property?.officeEmail ? `Replies go to ${property.officeEmail}` : 'Replies go to whoever runs this property'}
          </span>
        )}
      </div>
    </div>
  )
}
