import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000'

// S527 W-29/W-45: SAME-TAB document viewing. The old pattern fetched a blob
// and window.open'd it after an await — popup blockers silently ate it, so
// "View" appeared dead. This route fetches the document with the Bearer
// token and renders it inline; Back returns to the list you came from.
// Usage: navigate(`/view?src=${encodeURIComponent('/leases/<id>/pdf')}&title=Lease`)
export function PdfViewerPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const src = params.get('src') || ''
  const title = params.get('title') || 'Document'
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let revoke: string | null = null
    if (!src.startsWith('/')) { setError('Invalid document path'); return }
    fetch(`${API_BASE}/api${src}`, {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') },
    })
      .then(async res => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        const url = URL.createObjectURL(await res.blob())
        revoke = url
        setBlobUrl(url)
      })
      .catch(e => setError(`Could not load the document (${e.message}).`))
    return () => { if (revoke) URL.revokeObjectURL(revoke) }
  }, [src])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> Back
        </button>
        <h1 className="page-title" style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h1>
      </div>
      {error ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>{error}</div>
      ) : !blobUrl ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
      ) : (
        <iframe src={blobUrl} title={title} style={{ flex: 1, width: '100%', border: '1px solid var(--border-0)', borderRadius: 12, background: '#fff' }} />
      )}
    </div>
  )
}
