import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { apiGet } from '../lib/api'
import { resolveBookingSlug } from '../lib/slug'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

// Raw POST so we can read the `full` flag on a 409 (apiPost throws on non-2xx).
async function rawPost(path: string, body: any): Promise<{ ok: boolean; status: number; data: any; full?: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/api${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data: json.data, full: json.full, error: json.error }
}

const todayPlus = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

export function PropertyBookingPage() {
  const { slug: pathSlug } = useParams()
  const slug = resolveBookingSlug(pathSlug)

  const [site, setSite] = useState<any>(null)
  const [err, setErr] = useState('')
  const [unitId, setUnitId] = useState('')
  const [checkIn, setCheckIn] = useState(todayPlus(7))
  const [checkOut, setCheckOut] = useState(todayPlus(10))
  const [avail, setAvail] = useState<any>(null)
  const [checking, setChecking] = useState(false)
  const [guest, setGuest] = useState({ guestName: '', guestEmail: '', guestPhone: '' })
  const [busy, setBusy] = useState(false)
  const [waitlisted, setWaitlisted] = useState<number | null>(null)

  useEffect(() => {
    if (!slug) { setErr('No booking site specified.'); return }
    apiGet(`/public/property/${slug}`).then((d: any) => {
      setSite(d)
      if (d.units?.[0]) setUnitId(d.units[0].id)
    }).catch(e => setErr(e.message || 'Booking site not found'))
  }, [slug])

  const checkAvailability = async () => {
    setChecking(true); setAvail(null); setWaitlisted(null)
    try {
      const d = await apiGet(`/public/property/${slug}/availability?unitId=${unitId}&checkIn=${checkIn}&checkOut=${checkOut}`)
      setAvail(d)
    } catch (e: any) { setAvail({ available: false, unavailableReason: e.message }) }
    setChecking(false)
  }

  const book = async () => {
    if (!guest.guestName || !guest.guestEmail) { setErr('Name and email are required'); return }
    setBusy(true); setErr('')
    const r = await rawPost(`/public/property/${slug}/book`, { unitId, checkIn, checkOut, ...guest })
    setBusy(false)
    if (r.ok && r.data?.checkoutUrl) { window.location.href = r.data.checkoutUrl; return }
    if (r.status === 409 && r.full) { setAvail({ ...avail, available: false, unavailableReason: 'booked' }); return }
    setErr(r.error || 'Could not book — please try again')
  }

  const joinWaitlist = async () => {
    if (!guest.guestName || !guest.guestEmail) { setErr('Name and email are required'); return }
    setBusy(true); setErr('')
    const r = await rawPost(`/public/property/${slug}/waitlist`, { unitId, checkIn, checkOut, ...guest })
    setBusy(false)
    if (r.ok) { setWaitlisted(r.data?.position ?? 1); return }
    setErr(r.error || 'Could not join the waitlist')
  }

  const card: React.CSSProperties = { background: 'var(--surface-1,#11161d)', border: '1px solid var(--border,#222b36)', borderRadius: 12, padding: 18, marginBottom: 16 }
  const input: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #2a3340', background: '#0c1117', color: '#e8edf7', boxSizing: 'border-box', marginBottom: 10 }
  const label: React.CSSProperties = { fontSize: 12, color: '#8b97b3', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 4 }

  if (err && !site) return <div style={{ maxWidth: 480, margin: '64px auto', textAlign: 'center', color: '#ff6b81' }}>{err}</div>
  if (!site) return <div style={{ maxWidth: 480, margin: '64px auto', textAlign: 'center', color: '#8b97b3' }}>Loading…</div>

  return (
    <div style={{ maxWidth: 560, margin: '32px auto', padding: 16, color: '#e8edf7', fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 26, margin: '0 0 2px' }}>{site.property.name}</h1>
      <div style={{ color: '#8b97b3', marginBottom: 4 }}>{[site.property.city, site.property.state].filter(Boolean).join(', ')}</div>
      {site.property.intro && <p style={{ color: '#b8c4d8' }}>{site.property.intro}</p>}

      <div style={card}>
        <label style={label}>Unit</label>
        <select style={input} value={unitId} onChange={e => { setUnitId(e.target.value); setAvail(null) }}>
          {site.units.map((u: any) => (
            <option key={u.id} value={u.id}>
              Unit {u.unitNumber}{u.nightlyRate != null ? ` — $${u.nightlyRate}/night` : ''}{u.weeklyRate != null ? ` · $${u.weeklyRate}/week` : ''}
            </option>
          ))}
        </select>
        {site.units.length === 0 && <div style={{ color: '#8b97b3' }}>No units are available to book right now.</div>}

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}><label style={label}>Check-in</label><input type="date" style={input} value={checkIn} onChange={e => { setCheckIn(e.target.value); setAvail(null) }} /></div>
          <div style={{ flex: 1 }}><label style={label}>Check-out</label><input type="date" style={input} value={checkOut} onChange={e => { setCheckOut(e.target.value); setAvail(null) }} /></div>
        </div>
        <button onClick={checkAvailability} disabled={!unitId || checking} style={{ width: '100%', padding: 12, borderRadius: 8, border: 0, background: '#5b8cff', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
          {checking ? 'Checking…' : 'Check availability'}
        </button>
      </div>

      {avail && (
        <div style={card}>
          {avail.available ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#6fe0a0', marginBottom: 6 }}>Available!</div>
              <div style={{ color: '#b8c4d8', marginBottom: 12 }}>
                {avail.nights} nights{avail.tier ? ` · ${avail.tier} rate` : ''}
                {avail.tax > 0 ? ` · $${avail.base} + $${avail.tax} tax` : ''}
                {' · total '}<b>${avail.total}</b> · deposit due now <b>${avail.depositAmount}</b> ({avail.depositPct}%)
              </div>
              <label style={label}>Your name</label>
              <input style={input} value={guest.guestName} onChange={e => setGuest(g => ({ ...g, guestName: e.target.value }))} />
              <label style={label}>Email</label>
              <input style={input} type="email" value={guest.guestEmail} onChange={e => setGuest(g => ({ ...g, guestEmail: e.target.value }))} />
              <label style={label}>Phone (optional)</label>
              <input style={input} value={guest.guestPhone} onChange={e => setGuest(g => ({ ...g, guestPhone: e.target.value }))} />
              <button onClick={book} disabled={busy} style={{ width: '100%', padding: 13, borderRadius: 8, border: 0, background: '#ffd23d', color: '#3a2a00', fontWeight: 800, cursor: 'pointer' }}>
                {busy ? '…' : `Pay $${avail.depositAmount} deposit & book`}
              </button>
            </>
          ) : waitlisted != null ? (
            <div style={{ color: '#6fe0a0' }}>You're on the waitlist (position {waitlisted}). If these dates free up we'll email you a 1-hour link to claim them.</div>
          ) : (
            <>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#ffb84d', marginBottom: 6 }}>
                {avail.unavailableReason === 'booked' ? 'Those dates are taken' : avail.unavailableReason || 'Not available'}
              </div>
              {avail.unavailableReason === 'booked' && (
                <>
                  <div style={{ color: '#b8c4d8', marginBottom: 12 }}>Join the waitlist — if there's a cancellation you'll get first dibs for 1 hour.</div>
                  <label style={label}>Your name</label>
                  <input style={input} value={guest.guestName} onChange={e => setGuest(g => ({ ...g, guestName: e.target.value }))} />
                  <label style={label}>Email</label>
                  <input style={input} type="email" value={guest.guestEmail} onChange={e => setGuest(g => ({ ...g, guestEmail: e.target.value }))} />
                  <button onClick={joinWaitlist} disabled={busy} style={{ width: '100%', padding: 12, borderRadius: 8, border: 0, background: '#2e3650', color: '#e8edf7', fontWeight: 700, cursor: 'pointer' }}>
                    {busy ? '…' : 'Join the waitlist'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {err && <div style={{ color: '#ff6b81', marginTop: 8 }}>{err}</div>}
    </div>
  )
}
