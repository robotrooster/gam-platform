import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Camera, CheckCircle2 } from 'lucide-react'
import { apiGet, api } from '../lib/api'
import { toast } from '../components/dialogs'

// S652 (Nic): "maintenance people need to be able to add a picture to something
// for record keeping. But also, for notice posting… there needs to be a way to
// upload a picture of said notice to that tenant's profile… it can just go in
// their history with all their other documents."
//
// One screen, built for a phone: pick the park, pick the resident, take the
// photo, say what it is. It lands on the resident's record (landlord's Tenant
// page and the resident's own Documents) the moment it uploads. Needs only
// "Add photos & posted notices" — nothing else in Documents.
const KINDS = [
  { value: 'notice', label: 'Notice posted on the door', hint: 'late rent, violation, entry — the photo proves delivery' },
  { value: 'other',  label: 'Photo for the record',      hint: 'condition, damage, anything worth keeping' },
] as const

export function TenantPhotosPage() {
  const qc = useQueryClient()
  const [propertyId, setPropertyId] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [kind, setKind] = useState<'notice' | 'other'>('notice')
  const [note, setNote] = useState('')
  const [postedAt, setPostedAt] = useState(() => new Date().toISOString().slice(0, 10))
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [lastSaved, setLastSaved] = useState<string | null>(null)

  const { data: targets } = useQuery<any>('photo-targets', () => apiGet('/documents/photo-targets'))
  const properties: any[] = targets?.properties ?? []
  const { data: pool } = useQuery<any>(['photo-targets', propertyId], () => apiGet(`/documents/photo-targets?propertyId=${propertyId}`), { enabled: !!propertyId })
  const residents: any[] = pool?.residents ?? []
  const resident = residents.find(r => r.tenantId === tenantId)

  const pick = (f: File | null) => {
    setFile(f)
    if (preview) URL.revokeObjectURL(preview)
    setPreview(f ? URL.createObjectURL(f) : null)
  }
  const save = useMutation(
    () => {
      const fd = new FormData()
      fd.append('file', file!)
      fd.append('type', kind)
      fd.append('tenantId', tenantId)
      if (resident?.unitId) fd.append('unitId', resident.unitId)
      fd.append('postedAt', postedAt)
      // The name is what the resident and the landlord read in their lists —
      // a date the way people write it, not the wire format.
      const when = new Date(postedAt + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      const label = kind === 'notice' ? `Notice posted ${when}` : `Photo ${when}`
      fd.append('name', resident ? `${label} — ${resident.unitNumber}` : label)
      if (note.trim()) fd.append('note', note.trim())
      return api.post('/documents', fd).then(r => r.data)
    },
    {
      onSuccess: () => {
        setLastSaved(`${kind === 'notice' ? 'Notice' : 'Photo'} saved to ${resident?.name ?? 'the resident'}'s record`)
        toast('Saved to the resident\'s record')
        pick(null); setNote('')
        qc.invalidateQueries('documents')
      },
      onError: (e: any) => toast.error(e?.response?.data?.error?.message || e?.response?.data?.error || 'Could not save the photo'),
    },
  )

  return (
    <div style={{ maxWidth: 560 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title"><Camera size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Photos & Notices</h1>
          <p className="page-subtitle">A photo onto a resident's record — a posted notice, or anything worth keeping</p>
        </div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <label>
          <div className="form-label">PROPERTY</div>
          <select className="input" style={{ width: '100%' }} value={propertyId}
            onChange={e => { setPropertyId(e.target.value); setTenantId('') }}>
            <option value="">Choose a property…</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          <div className="form-label">RESIDENT</div>
          <select className="input" style={{ width: '100%' }} value={tenantId} disabled={!propertyId}
            onChange={e => setTenantId(e.target.value)}>
            <option value="">{propertyId ? 'Choose a resident…' : 'Pick the property first'}</option>
            {residents.map(r => <option key={`${r.tenantId}-${r.unitId}`} value={r.tenantId}>{r.unitNumber} — {r.name}</option>)}
          </select>
        </label>
        <div>
          <div className="form-label">WHAT IS IT</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {KINDS.map(k => (
              <label key={k.value} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                background: kind === k.value ? 'var(--gold-bg)' : 'var(--bg-2)', border: '1px solid ' + (kind === k.value ? 'var(--gold)' : 'var(--border-1)') }}>
                <input type="radio" checked={kind === k.value} onChange={() => setKind(k.value)} style={{ marginTop: 3 }} />
                <span><span style={{ fontWeight: 600, fontSize: '.85rem' }}>{k.label}</span><br /><span style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>{k.hint}</span></span>
              </label>
            ))}
          </div>
        </div>
        <label>
          <div className="form-label">{kind === 'notice' ? 'POSTED ON' : 'TAKEN ON'}</div>
          <input type="date" className="input" style={{ width: '100%' }} value={postedAt} onChange={e => setPostedAt(e.target.value)} />
        </label>
        <label>
          <div className="form-label">NOTE (OPTIONAL)</div>
          <input className="input" style={{ width: '100%' }} value={note} maxLength={1000}
            placeholder={kind === 'notice' ? '5-day notice, taped to the front door' : 'Skirting damage, north side'}
            onChange={e => setNote(e.target.value)} />
        </label>
        <div>
          <div className="form-label">PHOTO</div>
          <label className="btn btn-primary" style={{ display: 'inline-flex', gap: 8, cursor: 'pointer' }}>
            <Camera size={15} /> {file ? 'Retake / choose another' : 'Take a photo'}
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
              onChange={e => pick(e.target.files?.[0] ?? null)} />
          </label>
          {preview && <img src={preview} alt="" style={{ display: 'block', marginTop: 10, maxWidth: '100%', maxHeight: 320, borderRadius: 10, border: '1px solid var(--border-1)' }} />}
        </div>
        <button className="btn btn-primary" disabled={!tenantId || !file || save.isLoading} onClick={() => save.mutate()}>
          {save.isLoading ? 'Saving…' : 'Save to the resident\'s record'}
        </button>
        {lastSaved && <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '.82rem', color: 'var(--green, #1edb7a)' }}><CheckCircle2 size={15} /> {lastSaved}</div>}
      </div>
    </div>
  )
}
