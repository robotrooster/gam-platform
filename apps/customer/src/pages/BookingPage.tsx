import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'

// ── Wire shapes (API camelCases server-side) ──────────────────────
type Recurrence = 'one_time' | 'weekly' | 'biweekly' | 'monthly'
interface Service {
  id: string
  name: string
  description: string | null
  durationMinutes: number
  price: string | null
  recurrence: Recurrence
  recurrenceDayOfWeek: number | null
}
interface Profile {
  name: string
  phone: string | null
  address: { city: string | null; state: string | null }
  intro: string | null
  bookingMode: 'day' | 'slot'
  collectsVehicle: boolean
  services: Service[]
}
interface DaySlots { date: string; slots?: string[]; available?: boolean }
interface Availability { serviceId: string; mode: 'day' | 'slot'; days: DaySlots[] }

const RECURRENCE_LABEL: Record<Recurrence, string> = {
  one_time: 'One-time', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Every 4 weeks',
}
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const money = (n: string | null) =>
  n == null ? null : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDuration = (m: number) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} hr` : `${Math.floor(m / 60)} hr ${m % 60} min`)
const fmtDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
const fmtSlot = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10))
  const d = new Date(); d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// What flow a service uses: recurring services enroll; one-time depends on the
// business's booking mode (route → pick a day, else → pick a time slot).
function serviceFlow(s: Service, mode: 'day' | 'slot'): 'recurring' | 'day' | 'slot' {
  if (s.recurrence !== 'one_time') return 'recurring'
  return mode === 'day' ? 'day' : 'slot'
}

export function BookingPage() {
  const { slug = '' } = useParams()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const [service, setService] = useState<Service | null>(null)
  const [avail, setAvail] = useState<Availability | null>(null)
  const [availLoading, setAvailLoading] = useState(false)
  const [pickedDate, setPickedDate] = useState<string | null>(null)   // day mode
  const [pickedSlot, setPickedSlot] = useState<{ date: string; time: string } | null>(null) // slot mode

  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', notes: '' })
  const [vehicle, setVehicle] = useState({ year: '', make: '', model: '', plate: '' })
  const [submitting, setSubmitting] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)

  useEffect(() => {
    apiGet<Profile>(`/public/booking/${slug}`)
      .then(setProfile)
      .catch((e: any) => setLoadErr(e?.status === 404 ? 'This booking page isn’t available.' : (e?.message || 'Could not load booking page.')))
  }, [slug])

  const flow = service && profile ? serviceFlow(service, profile.bookingMode) : null

  const chooseService = async (s: Service) => {
    setService(s); setPickedDate(null); setPickedSlot(null); setAvail(null); setFormErr(null)
    if (!profile) return
    if (serviceFlow(s, profile.bookingMode) === 'recurring') return  // no availability needed
    setAvailLoading(true)
    try {
      const a = await apiGet<Availability>(`/public/booking/${slug}/availability?serviceId=${s.id}&fromDate=${todayIso()}`)
      setAvail(a)
    } catch (e: any) {
      setFormErr(e?.message || 'Could not load availability.')
    } finally { setAvailLoading(false) }
  }

  const readyForDetails = flow === 'recurring' || (flow === 'day' && !!pickedDate) || (flow === 'slot' && !!pickedSlot)

  const submit = async () => {
    if (!service || !flow) return
    setFormErr(null)
    if (!form.firstName.trim() || !form.lastName.trim()) { setFormErr('Enter your first and last name.'); return }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) { setFormErr('Enter a valid email.'); return }
    if (!form.phone.trim()) { setFormErr('Enter a phone number.'); return }
    setSubmitting(true)
    try {
      const payload: any = { serviceId: service.id, ...form, notes: form.notes.trim() || undefined }
      if (profile?.collectsVehicle) {
        if (vehicle.year.trim()) payload.vehicleYear = parseInt(vehicle.year, 10)
        if (vehicle.make.trim()) payload.vehicleMake = vehicle.make.trim()
        if (vehicle.model.trim()) payload.vehicleModel = vehicle.model.trim()
        if (vehicle.plate.trim()) payload.vehiclePlate = vehicle.plate.trim()
      }
      if (flow === 'day') payload.scheduledDate = pickedDate
      else if (flow === 'slot') payload.scheduledFor = new Date(`${pickedSlot!.date}T${pickedSlot!.time}:00`).toISOString()
      const r = await apiPost<{ confirmation: string }>(`/public/booking/${slug}/book`, payload)
      setConfirmation(r.confirmation)
    } catch (e: any) {
      if (e?.status === 409) { setFormErr('That time was just taken. Pick another.'); setPickedSlot(null); chooseService(service) }
      else setFormErr(e?.message || 'Could not complete the booking.')
    } finally { setSubmitting(false) }
  }

  if (loadErr) return <div style={page}><div style={center}>{loadErr}</div></div>
  if (!profile) return <div style={page}><div style={center}>Loading…</div></div>

  if (confirmation) {
    return (
      <div style={page}>
        <Header profile={profile} />
        <div style={{ ...card, textAlign: 'center', padding: 28 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✓</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--text-0)', marginBottom: 8 }}>You’re all set</div>
          <div style={{ color: 'var(--text-1)', fontSize: 14 }}>{confirmation}</div>
          <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 12 }}>A confirmation email is on its way to {form.email}.</div>
        </div>
      </div>
    )
  }

  return (
    <div style={page}>
      <Header profile={profile} />
      {profile.intro && <div style={{ color: 'var(--text-1)', fontSize: 14, marginBottom: 20 }}>{profile.intro}</div>}

      {/* Step 1 — service */}
      <h2 style={h2}>1 · Choose a service</h2>
      {profile.services.length === 0 ? (
        <div style={empty}>This business has no bookable services yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
          {profile.services.map((s) => {
            const active = service?.id === s.id
            return (
              <button key={s.id} onClick={() => chooseService(s)}
                style={{ ...card, textAlign: 'left', cursor: 'pointer', borderColor: active ? 'var(--gold)' : 'var(--border-1)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600, color: 'var(--text-0)' }}>{s.name}</span>
                  {money(s.price) && <span style={{ color: 'var(--gold)', fontFamily: 'var(--font-mono)' }}>{money(s.price)}</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                  {fmtDuration(s.durationMinutes)}
                  {s.recurrence !== 'one_time' && s.recurrenceDayOfWeek != null &&
                    ` · ${RECURRENCE_LABEL[s.recurrence]} on ${WEEKDAY[s.recurrenceDayOfWeek]}s`}
                </div>
                {s.description && <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 6 }}>{s.description}</div>}
              </button>
            )
          })}
        </div>
      )}

      {/* Step 2 — recurring: enroll banner; day: pick a day; slot: pick a time */}
      {service && flow === 'recurring' && service.recurrenceDayOfWeek != null && (
        <>
          <h2 style={h2}>2 · How it works</h2>
          <div style={{ ...card, marginBottom: 24, color: 'var(--text-1)', fontSize: 14 }}>
            You’ll be enrolled in <strong>{RECURRENCE_LABEL[service.recurrence].toLowerCase()}</strong> service on{' '}
            <strong>{WEEKDAY[service.recurrenceDayOfWeek]}s</strong>. {profile.name} runs a route that day — we’ll let you know
            when they’re on the way. No need to pick a time.
          </div>
        </>
      )}

      {service && flow === 'day' && (
        <>
          <h2 style={h2}>2 · Pick a day</h2>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: -4, marginBottom: 10 }}>
            {profile.name} comes by on a route — we’ll confirm the time on the day.
          </div>
          {availLoading ? <div style={empty}>Loading days…</div>
            : !avail || !avail.days.some((d) => d.available) ? <div style={empty}>No open days in the next two weeks.</div>
            : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 24 }}>
                {avail.days.filter((d) => d.available).map((d) => {
                  const active = pickedDate === d.date
                  return (
                    <button key={d.date} onClick={() => setPickedDate(d.date)}
                      style={{ ...slotBtn, background: active ? 'var(--gold)' : 'var(--bg-2)', color: active ? '#1a1a1a' : 'var(--text-1)', borderColor: active ? 'var(--gold)' : 'var(--border-1)' }}>
                      {fmtDay(d.date)}
                    </button>
                  )
                })}
              </div>
            )}
        </>
      )}

      {service && flow === 'slot' && (
        <>
          <h2 style={h2}>2 · Pick a time</h2>
          {availLoading ? <div style={empty}>Loading available times…</div>
            : !avail || avail.days.every((d) => !d.slots || d.slots.length === 0) ? <div style={empty}>No open times in the next two weeks.</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 24 }}>
                {avail.days.filter((d) => d.slots && d.slots.length > 0).map((d) => (
                  <div key={d.date}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', marginBottom: 6 }}>{fmtDay(d.date)}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {d.slots!.map((t) => {
                        const active = pickedSlot?.date === d.date && pickedSlot?.time === t
                        return (
                          <button key={t} onClick={() => setPickedSlot({ date: d.date, time: t })}
                            style={{ ...slotBtn, background: active ? 'var(--gold)' : 'var(--bg-2)', color: active ? '#1a1a1a' : 'var(--text-1)', borderColor: active ? 'var(--gold)' : 'var(--border-1)' }}>
                            {fmtSlot(t)}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </>
      )}

      {/* Step 3 — details */}
      {service && readyForDetails && (
        <>
          <h2 style={h2}>3 · Your details</h2>
          <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
              {service.name}
              {flow === 'day' && pickedDate && ` · ${fmtDay(pickedDate)}`}
              {flow === 'slot' && pickedSlot && ` · ${fmtDay(pickedSlot.date)} at ${fmtSlot(pickedSlot.time)}`}
              {flow === 'recurring' && service.recurrenceDayOfWeek != null && ` · ${RECURRENCE_LABEL[service.recurrence].toLowerCase()}, ${WEEKDAY[service.recurrenceDayOfWeek]}s`}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input style={input} placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              <input style={input} placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
            </div>
            <input style={input} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input style={input} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            {profile.collectsVehicle && (
              <>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>Your vehicle (optional)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 1fr', gap: 8 }}>
                  <input style={input} placeholder="Year" inputMode="numeric" value={vehicle.year} onChange={(e) => setVehicle({ ...vehicle, year: e.target.value })} />
                  <input style={input} placeholder="Make" value={vehicle.make} onChange={(e) => setVehicle({ ...vehicle, make: e.target.value })} />
                  <input style={input} placeholder="Model" value={vehicle.model} onChange={(e) => setVehicle({ ...vehicle, model: e.target.value })} />
                </div>
                <input style={input} placeholder="License plate (optional)" value={vehicle.plate} onChange={(e) => setVehicle({ ...vehicle, plate: e.target.value })} />
              </>
            )}
            <textarea style={{ ...input, resize: 'vertical' as const }} rows={2} placeholder="Anything we should know? (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            {formErr && <div style={errBox}>{formErr}</div>}
            <button onClick={submit} disabled={submitting} style={{ ...primaryBtn, opacity: submitting ? 0.6 : 1 }}>
              {submitting ? 'Submitting…' : flow === 'recurring' ? 'Enroll' : 'Confirm booking'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function Header({ profile }: { profile: Profile }) {
  const loc = [profile.address.city, profile.address.state].filter(Boolean).join(', ')
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, color: 'var(--gold)', letterSpacing: 1, textTransform: 'uppercase' }}>Book online</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, color: 'var(--text-0)' }}>{profile.name}</div>
      {(loc || profile.phone) && (
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 2 }}>{[loc, profile.phone].filter(Boolean).join(' · ')}</div>
      )}
    </div>
  )
}

// ── styles ─────────────────────────────────────────────────────
const page: React.CSSProperties = { maxWidth: 640, margin: '0 auto', padding: '32px 16px 64px' }
const center: React.CSSProperties = { textAlign: 'center', color: 'var(--text-2)', padding: 48 }
const h2: React.CSSProperties = { fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-3)', margin: '0 0 10px' }
const card: React.CSSProperties = { background: 'var(--bg-1)', border: '1px solid var(--border-1)', borderRadius: 12, padding: 14, width: '100%' }
const slotBtn: React.CSSProperties = { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-1)', fontSize: 13, cursor: 'pointer' }
const input: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--border-1)', color: 'var(--text-0)', fontSize: 14, boxSizing: 'border-box' as const }
const primaryBtn: React.CSSProperties = { padding: '11px 16px', borderRadius: 8, border: 'none', background: 'var(--gold)', color: '#1a1a1a', fontWeight: 700, fontSize: 14, cursor: 'pointer' }
const empty: React.CSSProperties = { padding: 16, textAlign: 'center', background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12, color: 'var(--text-3)', fontSize: 14, marginBottom: 24 }
const errBox: React.CSSProperties = { padding: '10px 12px', background: 'var(--red-bg)', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 8, fontSize: 13 }
