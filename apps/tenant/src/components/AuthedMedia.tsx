import { useState, useEffect } from 'react'

// Authed file routes (inspection + maintenance media) only honor an
// `Authorization: Bearer` header, so a plain <img src> 401s. Fetch the file as
// a blob with the tenant token and render via an object URL, revoking on
// unmount. (Same approach as the inline helper in main.tsx; extracted so
// page-level files can use it without a circular import.)
const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

export function useAuthedBlob(path: string | null): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!path) { setSrc(null); setFailed(false); return }
    let url: string | null = null
    let cancelled = false
    setSrc(null); setFailed(false)
    const token = localStorage.getItem('gam_tenant_token') || ''
    fetch(`${API_URL}${path}`, { headers: { Authorization: 'Bearer ' + token } })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('status ' + r.status))))
      .then(blob => { if (!cancelled) { url = URL.createObjectURL(blob); setSrc(url) } })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [path])
  return { src, failed }
}

export function AuthedImg({ path, alt, style }: { path: string; alt: string; style?: React.CSSProperties }) {
  const { src, failed } = useAuthedBlob(path)
  if (failed) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f1318', color: '#7a8aaa', fontSize: '.62rem', ...style }}>unavailable</div>
  if (!src) return <div style={{ background: '#141920', ...style }} />
  return <img src={src} alt={alt} style={style} />
}

// Open a video/photo blob in a new tab (authed). Used for videos, which lose
// HTTP range/seek when blobbed — fine for short clips.
export async function openAuthedBlob(path: string): Promise<void> {
  const token = localStorage.getItem('gam_tenant_token') || ''
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: 'Bearer ' + token } })
  if (!res.ok) return
  window.open(URL.createObjectURL(await res.blob()), '_blank')
}
