import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { Upload, X } from 'lucide-react'
import { apiGet } from '../lib/api'
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
  const { data: docs = [], isLoading } = useQuery<any[]>('documents', () => apiGet('/documents'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Documents</h1><p className="page-subtitle">Signed addenda, uploads, and supporting files</p></div>
        {can('documents.upload') && (
          <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
            <Upload size={15} /> Upload Document
          </button>
        )}
      </div>
      <div className="alert alert-gold" style={{ marginBottom: 16, fontSize: '.82rem' }}>
        Looking for a lease? Print or download signed leases from the <a href="/leases" style={{ color: 'var(--gold)', fontWeight: 600 }}>Leases</a> tab. Anything else — addenda, notices, receipts, whatever — can be uploaded right here.
      </div>
      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table" style={{minWidth:760}}>
            <thead><tr><th>Name</th><th>Type</th><th>Unit</th><th>Tenant</th><th>Uploaded</th><th>Action</th></tr></thead>
            <tbody>
              {docs.length ? docs.map((d: any) => (
                <tr key={d.id}>
                  <td>{d.name || '—'}</td>
                  <td><span className="badge badge-muted">{DOC_TYPE_LABEL[d.docType] || d.docType || 'File'}</span></td>
                  <td className="mono">{d.unitNumber || '—'}</td>
                  <td>{d.tenantName || '—'}</td>
                  <td className="mono">{d.createdAt ? new Date(d.createdAt).toLocaleDateString() : '—'}</td>
                  <td>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--gold)', fontSize: '.82rem' }}
                      onClick={() => navigate(`/view?src=${encodeURIComponent(`/documents/${d.id}/file`)}&title=${encodeURIComponent(d.name || 'Document')}`)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No documents yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {uploadOpen && <UploadModal onClose={() => setUploadOpen(false)} />}
    </div>
  )
}

function UploadModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState('other')
  const [unitId, setUnitId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: units = [] } = useQuery<any[]>('units-for-doc-upload', () => apiGet('/units'))

  const mut = useMutation(
    async () => {
      const fd = new FormData()
      fd.append('file', file!)
      if (name.trim()) fd.append('name', name.trim())
      fd.append('type', type)
      if (unitId) fd.append('unitId', unitId)
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
