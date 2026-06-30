import { useState, useEffect } from 'react'

// ─────────────────────────────────────────────────────────────
// Auth-gated media. The inspection photo/video file routes
// (/api/inspections/photo-files/<name>, /video-files/<name>) sit
// behind requireAuth, which only accepts an `Authorization: Bearer`
// header — a plain <img src>/<video src> can't send that, so it
// 401s. These helpers fetch the file as a blob with the bearer
// token and render it through an object URL, revoking on unmount.
//
// Mirrors the S512 AuthedImg pattern in LeaseFormModal
// (MoveInPhotosSection) and openLandlordAddendumPdf.
//
// Blob trade-off (video): a blob fetch pulls the whole file before
// playback and gives up HTTP range/seek. Fine for the short
// walkthrough clips this is used for; if long-form video becomes a
// real use case, move the video routes to a short-lived signed-token
// query param so <video> can stream with range support.
// ─────────────────────────────────────────────────────────────

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

function useAuthedBlob(path: string): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    setSrc(null)
    setFailed(false)
    const token = localStorage.getItem('gam_token') || ''
    fetch(`${API_BASE}${path}`, { headers: { Authorization: 'Bearer ' + token } })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('status ' + r.status))))
      .then(blob => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setSrc(url)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [path])
  return { src, failed }
}

export function AuthedImg({
  path,
  alt,
  style,
}: {
  path: string
  alt: string
  style?: React.CSSProperties
}) {
  const { src, failed } = useAuthedBlob(path)
  if (failed) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 8, color: 'var(--text-3)', fontSize: '.65rem', width: '100%', height: '100%', ...style }}>
        unavailable
      </div>
    )
  }
  if (!src) {
    return <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 8, width: '100%', height: '100%', ...style }} />
  }
  return <img src={src} alt={alt} style={style} />
}

export function AuthedVideo({
  path,
  style,
}: {
  path: string
  style?: React.CSSProperties
}) {
  const { src, failed } = useAuthedBlob(path)
  if (failed) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', borderRadius: 8, color: 'var(--text-3)', fontSize: '.7rem', aspectRatio: '16/9', ...style }}>
        video unavailable
      </div>
    )
  }
  if (!src) {
    return <div style={{ background: '#000', borderRadius: 8, aspectRatio: '16/9', ...style }} />
  }
  return <video controls preload="metadata" src={src} style={style} />
}
