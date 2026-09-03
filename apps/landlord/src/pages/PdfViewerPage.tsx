import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Download, Printer } from 'lucide-react'
import { downloadAuthedFile, printAuthedFile } from '../lib/downloadFile'
import { toast } from '../components/dialogs'
import { loadPdfjs } from '../lib/pdfjs'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000'

// S527 W-29/W-45: SAME-TAB document viewing. The old pattern fetched a blob
// and window.open'd it after an await — popup blockers silently ate it, so
// "View" appeared dead. This route fetches the document with the Bearer
// token and renders it inline; Back returns to the list you came from.
// Usage: navigate(`/view?src=${encodeURIComponent('/leases/<id>/pdf')}&title=Lease`)
//
// S534 (Nic): render with pdf.js canvases instead of a native <iframe>.
// Safari does not reliably render PDF blob URLs inside iframes — the page
// showed nothing at all in Nic's browser while working in Chrome. Same
// CDN pdf.js pattern as the sign pages; all pages render stacked for
// continuous scroll.
export function PdfViewerPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const src = params.get('src') || ''
  const title = params.get('title') || 'Document'
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!src.startsWith('/')) { setError('Invalid document path'); return }
      try {
        const pdfjsLib = await loadPdfjs()
        const pdf = await pdfjsLib.getDocument({
          url: `${API_BASE}/api${src}`,
          httpHeaders: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') },
        }).promise
        if (cancelled || !containerRef.current) return
        const container = containerRef.current
        container.innerHTML = ''
        const width = container.clientWidth - 24 // padding allowance
        for (let n = 1; n <= pdf.numPages; n++) {
          const p = await pdf.getPage(n)
          const baseVp = p.getViewport({ scale: 1 })
          const scale = Math.min(width / baseVp.width, 2)
          const vp = p.getViewport({ scale: scale * (window.devicePixelRatio || 1) })
          const canvas = document.createElement('canvas')
          canvas.width = vp.width
          canvas.height = vp.height
          canvas.style.width = `${vp.width / (window.devicePixelRatio || 1)}px`
          canvas.style.display = 'block'
          canvas.style.margin = '0 auto 12px'
          canvas.style.background = '#fff'
          canvas.style.borderRadius = '6px'
          container.appendChild(canvas)
          await p.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
          if (cancelled) return
        }
        setLoading(false)
      } catch (e: any) {
        if (!cancelled) setError(`Could not load the document (${e?.message || 'unknown error'}).`)
      }
    }
    load()
    return () => { cancelled = true }
  }, [src])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> Back
        </button>
        <h1 className="page-title" style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h1>
        {/* S637 (Nic): "there's no option to print or download from this
            screen." The page rendered the PDF to canvases and stopped there, so
            the one thing a landlord needs from an executed lease — a copy, on
            paper or on disk — was the one thing it would not do. Printing the
            PAGE would print portal chrome around a canvas; these fetch the PDF
            itself with the session token and hand the real bytes to the browser. */}
        {!error && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" title="Print"
              onClick={async () => {
                try { await printAuthedFile(`/api${src}`) }
                catch (e: any) { toast.error(`Could not print this document (${e?.message || 'unknown error'}).`) }
              }}><Printer size={14} /> Print</button>
            <button className="btn btn-primary btn-sm" title="Download"
              onClick={async () => {
                try {
                  await downloadAuthedFile(`/api${src}`,
                    `${title.replace(/[^\w\-. ]+/g, '_')}.pdf`)
                } catch (e: any) { toast.error(`Could not download this document (${e?.message || 'unknown error'}).`) }
              }}><Download size={14} /> Download</button>
          </div>
        )}
      </div>
      {error ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>{error}</div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border-0)', borderRadius: 12, background: 'var(--bg-2)', padding: 12, position: 'relative' }}>
          {loading && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
          )}
          <div ref={containerRef} />
        </div>
      )}
    </div>
  )
}
