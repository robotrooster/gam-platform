import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from 'react-query'
import { Mail } from 'lucide-react'
import { apiPatch } from '../lib/api'

// S630 (Nic): "I wanna log in to my portfolio with one email, but when I get an
// email saying there's a new draft lease that needs to be signed, I need it to
// go to separate emails... That way whoever's managing the account on-site can
// sign leases on behalf of me at that property without having full access to
// all of my emails and all of my properties."
//
// Deliberately separate from the property's office email, which is PUBLISHED to
// guests on the booking site. Whoever receives a signing link can sign a lease
// as the landlord, so this address must never be one that gets handed out.

const lbl = { fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4, display: 'block' } as const

export function PropertyLeaseSigningSection(
  { property, onSaved }: { property: any; onSaved: () => void },
) {
  const qc = useQueryClient()
  const [email, setEmail] = useState(property?.leaseSigningEmail || '')
  const [name, setName]   = useState(property?.leaseSigningName || '')
  const [err, setErr]     = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setEmail(property?.leaseSigningEmail || '')
    setName(property?.leaseSigningName || '')
    setSaved(false); setErr(null)
  }, [property?.id, property?.leaseSigningEmail, property?.leaseSigningName])

  const save = useMutation(
    () => apiPatch(`/properties/${property.id}`, {
      leaseSigningEmail: email.trim(),
      leaseSigningName:  name.trim(),
    }),
    {
      onSuccess: () => {
        setErr(null); setSaved(true)
        qc.invalidateQueries('properties'); onSaved()
      },
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not save'),
    },
  )

  const dirty = (email.trim() !== (property?.leaseSigningEmail || ''))
             || (name.trim()  !== (property?.leaseSigningName  || ''))

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3 style={{ display:'flex', alignItems:'center', gap:8, margin:'0 0 4px', fontSize:'.95rem' }}>
        <Mail size={16} /> Lease signing for this property
      </h3>
      <p style={{ fontSize:'.78rem', color:'var(--text-3)', margin:'0 0 16px', maxWidth:640 }}>
        Where lease-signature requests and lease notices for <strong>{property?.name}</strong> are
        sent. Use this to let whoever manages this property on site sign leases for it — they
        sign from the emailed link, so they never need your login or your other properties.
        Leave it blank and everything goes to your account email.
      </p>

      <div style={{ display:'flex', gap:16, flexWrap:'wrap', maxWidth:640 }}>
        <div style={{ flex:'1 1 260px' }}>
          <label style={lbl}>Send signing requests to</label>
          <input type="email" value={email} placeholder="your account email"
            onChange={e => { setEmail(e.target.value); setSaved(false) }}
            style={{ width:'100%' }} />
        </div>
        <div style={{ flex:'1 1 200px' }}>
          <label style={lbl}>On-site signer's name (optional)</label>
          <input type="text" value={name} placeholder="your name"
            onChange={e => { setName(e.target.value); setSaved(false) }}
            style={{ width:'100%' }} />
        </div>
      </div>

      <p style={{ fontSize:'.72rem', color:'var(--text-3)', margin:'12px 0 0', maxWidth:640 }}>
        This is not your public office email — anyone who receives a signing link can sign a
        lease for this property. The lease still names you as the landlord either way.
      </p>

      {err && <p style={{ color:'var(--red)', fontSize:'.78rem', marginTop:10 }}>{err}</p>}
      <div style={{ display:'flex', alignItems:'center', gap:12, marginTop:14 }}>
        <button className="btn btn-primary btn-sm"
          disabled={!dirty || save.isLoading}
          onClick={() => save.mutate()}>
          {save.isLoading ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && (
          <span style={{ fontSize:'.75rem', color:'var(--text-3)' }}>
            {property?.leaseSigningEmail
              ? `Signing requests go to ${property.leaseSigningEmail}`
              : 'Signing requests go to your account email'}
          </span>
        )}
      </div>
    </div>
  )
}
