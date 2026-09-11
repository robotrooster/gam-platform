import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { Upload, X } from 'lucide-react'
import { apiGet, apiPut } from '../lib/api'
import { usePerms } from '../lib/permissions'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000'

const DOC_TYPE_LABEL: Record<string, string> = {
  lease: 'Lease', addendum: 'Addendum', move_in_checklist: 'Move-In Checklist',
  move_out_checklist: 'Move-Out Checklist', notice: 'Notice', other: 'Other',
}

// W-45 (S529): the catch-all documents surface. Docs open SAME-TAB through
// the /view route (authed stream via /documents/:id/file — missing files get
// a clear message instead of a blank tab), and anything can be uploaded here
// with type/unit tagging so it still lands in the right bucket.
export function DocumentsPage() {
  const { can } = usePerms()
  const navigate = useNavigate()
  const [uploadOpen, setUploadOpen] = useState(false)
  // S641 (Nic): "the documents should be scoped to the property level… you
  // don't want that at the landlord level accidentally getting sent to a
  // property that doesn't pertain to them." The park is chosen first and
  // everything below lives inside it — the same shape the Units page uses.
  const [propertyId, setPropertyId] = useState('')
  const [pinning, setPinning] = useState<any>(null)
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const { data: docs = [], isLoading } = useQuery<any[]>(
    ['documents', propertyId],
    () => apiGet(propertyId ? `/documents?propertyId=${propertyId}` : '/documents'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Documents</h1><p className="page-subtitle">Park rules, notices, and anything else you print and hand over</p></div>
        {can('documents.upload') && (
          <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
            <Upload size={15} /> Upload Document
          </button>
        )}
      </div>
      <div className="filter-bar" style={{ marginBottom: 14 }}>
        <select className="input" style={{ maxWidth: 280 }}
          value={propertyId} onChange={e => setPropertyId(e.target.value)}>
          <option value="">All properties</option>
          {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {propertyId && (
          <span style={{ fontSize: '.76rem', color: 'var(--text-3)' }}>
            What applies at this park — plus anything kept for every property.
          </span>
        )}
      </div>
      <div className="alert alert-gold" style={{ marginBottom: 16, fontSize: '.82rem' }}>
        Looking for a lease? Print or download signed leases from the <a href="/leases" style={{ color: 'var(--gold)', fontWeight: 600 }}>Leases</a> tab. This is the filing cabinet — park rules, notices, disclosures, anything you hand somebody on paper.
      </div>
      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table" style={{minWidth:760}}>
            <thead><tr><th>Name</th><th>Type</th><th>Applies to</th><th>Unit</th><th>Tenant</th><th>Uploaded</th><th>Action</th></tr></thead>
            <tbody>
              {docs.length ? docs.map((d: any) => {
                const pins: string[] = Array.isArray(d.propertyIds) ? d.propertyIds : []
                const pinNames = pins
                  .map(id => (properties as any[]).find(p => p.id === id)?.name)
                  .filter(Boolean)
                return (
                <tr key={d.id}>
                  <td>{d.name || '—'}</td>
                  <td><span className="badge badge-muted">{DOC_TYPE_LABEL[d.docType] || d.docType || 'File'}</span></td>
                  {/* S641: no pins means every property — that is the default,
                      so a state disclosure need not be pinned to every park the
                      landlord will ever buy. */}
                  <td style={{ fontSize: '.78rem', color: pinNames.length ? 'var(--text-1)' : 'var(--text-3)' }}>
                    {pinNames.length ? pinNames.join(', ') : 'Every property'}
                  </td>
                  <td className="mono">{d.unitNumber || '—'}</td>
                  <td>{d.tenantName || '—'}</td>
                  <td className="mono">{d.createdAt ? new Date(d.createdAt).toLocaleDateString() : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--gold)', fontSize: '.82rem' }}
                      onClick={() => navigate(`/view?src=${encodeURIComponent(`/documents/${d.id}/file`)}&title=${encodeURIComponent(d.name || 'Document')}`)}
                    >
                      View
                    </button>
                    {can('documents.upload') && (
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: '.82rem' }}
                        onClick={() => setPinning({ ...d, pins })}>
                        Properties
                      </button>
                    )}
                  </td>
                </tr>
              )}) : (
                <tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>
                  {propertyId ? 'Nothing filed for this property yet.' : 'No documents yet.'}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {uploadOpen && <UploadModal onClose={() => setUploadOpen(false)} />}
      {pinning && <PinPropertiesModal doc={pinning} properties={properties as any[]}
        onClose={() => setPinning(null)} />}
    </div>
  )
}

function UploadModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState('other')
  const [unitId, setUnitId] = useState('')
  // S641: file it against the park it belongs to. Several, if it belongs to
  // several — "if I have parking rules at two of my properties and not a third,
  // I don't wanna have to upload it two times." None ticked = everywhere.
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const { data: units = [] } = useQuery<any[]>('units-for-doc-upload', () => apiGet('/units'))
  const { data: props = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const togglePin = (id: string) => setPinned(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
  })

  const mut = useMutation(
    async () => {
      const fd = new FormData()
      fd.append('file', file!)
      if (name.trim()) fd.append('name', name.trim())
      fd.append('type', type)
      if (unitId) fd.append('unitId', unitId)
      if (pinned.size) fd.append('propertyIds', JSON.stringify([...pinned]))
      const res = await fetch(`${API_BASE}/api/documents`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') },
        body: fd,
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j?.error || `Upload failed (${res.status})`)
      return j
    },
    {
      onSuccess: () => { qc.invalidateQueries('documents'); onClose() },
      onError: (e: any) => setError(e?.message || 'Upload failed'),
    },
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 460, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ marginBottom: 0 }}>Upload Document</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ padding: '4px 24px 24px', display: 'grid', gap: 12 }}>
          <div>
            <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>FILE</div>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
              onChange={e => {
                const f = e.target.files?.[0] || null
                setFile(f)
                if (f && !name.trim()) setName(f.name.replace(/\.[^.]+$/, ''))
              }}
              className="input"
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>NAME</div>
            <input className="input" style={{ width: '100%' }} value={name} onChange={e => setName(e.target.value)} placeholder="What is this document?" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>TYPE</div>
              <select className="input" style={{ width: '100%' }} value={type} onChange={e => setType(e.target.value)}>
                {Object.entries(DOC_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>UNIT (OPTIONAL)</div>
              <select className="input" style={{ width: '100%' }} value={unitId} onChange={e => setUnitId(e.target.value)}>
                <option value="">— none —</option>
                {(units as any[]).map(u => <option key={u.id} value={u.id}>{u.unitNumber} · {u.propertyName}</option>)}
              </select>
            </div>
          </div>
          {/* S641: which parks this belongs to. Park rules differ by park; a
              state disclosure does not. Nothing ticked is the everywhere
              default, so the common case needs no clicks. */}
          <div>
            <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>
              APPLIES TO
            </div>
            <div style={{ display: 'grid', gap: 5, maxHeight: 150, overflowY: 'auto' }}>
              {(props as any[]).map(p => (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 7px',
                  border: '1px solid var(--border-0)', borderRadius: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={pinned.has(p.id)} onChange={() => togglePin(p.id)} />
                  <span style={{ fontSize: '.82rem', color: 'var(--text-1)' }}>{p.name}</span>
                </label>
              ))}
            </div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 5 }}>
              {pinned.size === 0
                ? 'Leave unticked and it applies at every property.'
                : `Only at ${pinned.size} propert${pinned.size === 1 ? 'y' : 'ies'}.`}
            </div>
          </div>
          {error && <div style={{ fontSize: '.78rem', color: 'var(--red)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={!file || mut.isLoading} onClick={() => { setError(null); mut.mutate() }}>
              {mut.isLoading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * S641 (Nic) — which parks a document applies to.
 *
 *   "If I have parking rules at two of my properties and not a third, I don't
 *    wanna have to upload it two times… you never know what the next property
 *    you're gonna buy is gonna have, and being able to reuse as many things as
 *    possible for efficiency is the way to go."
 *
 * So the set is edited here rather than the file being uploaded again. Nothing
 * ticked means every property, which is the right default for a disclosure that
 * applies wherever the landlord operates.
 */
function PinPropertiesModal({ doc, properties, onClose }: {
  doc: any
  properties: any[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<Set<string>>(new Set(doc.pins || []))
  const save = useMutation(
    () => apiPut(`/documents/${doc.id}/properties`, { propertyIds: [...picked] }),
    {
      onSuccess: () => { qc.invalidateQueries('documents'); onClose() },
    })

  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>Where does this apply?</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginBottom: 4 }}>{doc.name}</div>
        <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 12 }}>
          Tick the properties it belongs to. Leave them all unticked and it applies everywhere.
        </div>
        <div style={{ display: 'grid', gap: 6, maxHeight: '40vh', overflowY: 'auto' }}>
          {properties.map(p => (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px',
              border: '1px solid var(--border-0)', borderRadius: 7, cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
              <span style={{ fontSize: '.84rem', color: 'var(--text-1)' }}>{p.name}</span>
            </label>
          ))}
        </div>
        <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 10 }}>
          {picked.size === 0
            ? 'Applies to every property, including ones you add later.'
            : `Applies at ${picked.size} propert${picked.size === 1 ? 'y' : 'ies'} — and nowhere else.`}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isLoading} onClick={() => save.mutate()}>
            {save.isLoading ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
