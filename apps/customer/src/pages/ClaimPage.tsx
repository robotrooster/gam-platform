import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { apiGet } from '../lib/api'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export function ClaimPage() {
  const { slug, token } = useParams()
  const [info, setInfo] = useState<any>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiGet(`/public/property/${slug}/claim/${token}`)
      .then(setInfo)
      .catch(e => setErr(e.message || 'Claim link not found'))
  }, [slug, token])

  const claim = async () => {
    setBusy(true); setErr('')
    try {
      const res = await fetch(`${API_URL}/api/public/property/${slug}/claim/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stayType: 'nightly' }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok && json.data?.checkoutUrl) { window.location.href = json.data.checkoutUrl; return }
      setErr(json.error || 'Could not claim — it may have just been taken')
    } catch { setErr('Could not claim — please try again') }
    setBusy(false)
  }

  const wrap: React.CSSProperties = { maxWidth: 480, margin: '64px auto', padding: 24, textAlign: 'center', color: '#e8edf7', fontFamily: 'system-ui' }

  if (err && !info) return <div style={{ ...wrap, color: '#ff6b81' }}>{err}</div>
  if (!info) return <div style={{ ...wrap, color: '#8b97b3' }}>Loading…</div>

  if (info.expired) return (
    <div style={wrap}>
      <h1 style={{ fontSize: 22 }}>This claim has expired</h1>
      <p style={{ color: '#8b97b3' }}>The 1-hour window passed and the spot rolled to the next person. You're still on the waitlist for future openings.</p>
    </div>
  )

  return (
    <div style={wrap}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>A spot opened up!</h1>
      <p style={{ color: '#b8c4d8' }}>
        {info.propertyName} · Unit {info.unitNumber}<br />
        {info.checkIn} → {info.checkOut}
      </p>
      <p style={{ color: '#ffb84d', fontWeight: 700 }}>Claim it within the hour before it rolls to the next guest.</p>
      <button onClick={claim} disabled={busy} style={{ padding: '13px 28px', borderRadius: 8, border: 0, background: '#ffd23d', color: '#3a2a00', fontWeight: 800, cursor: 'pointer', fontSize: 16 }}>
        {busy ? '…' : 'Claim & pay deposit'}
      </button>
      {err && <div style={{ color: '#ff6b81', marginTop: 12 }}>{err}</div>}
    </div>
  )
}
