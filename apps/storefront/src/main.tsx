/**
 * S544: GAM Storefront — the guest-facing per-property website.
 *
 * ONE deployment serves every property: the slug arrives via subdomain
 * in prod ({booking_slug}.gam.biz) or the first path segment in dev
 * (http://localhost:3013/sunset-palms). Fronts the S517/W-20 public
 * booking API (routes/publicPropertyBooking.ts):
 *   profile+amenities → availability quote → book (site TYPE, not a
 *   specific site — assigned morning of check-in) → Stripe deposit
 *   checkout. Full dates → waitlist; claim links land on
 *   /:slug/claim/:token (dev) or /claim/:token (subdomain).
 * Bookings write unit_bookings directly — they appear on the
 * landlord's Master Schedule calendar with zero import steps.
 *
 * Guests are anonymous; NO auth anywhere in this app. Inquiries post
 * to /inquiry and land as landlord notifications + property_inquiries.
 */
// S540: self-hosted fonts — no render-blocking external stylesheet
import { readBeatMs, typeBeatMs, readGapMs, PAUSE_BEFORE_TYPING_MS } from '@gam/shared'
import '@fontsource/syne/600.css'
import '@fontsource/syne/700.css'
import '@fontsource/syne/800.css'
import '@fontsource/dm-sans/300.css'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '@fontsource/dm-mono/400.css'
import '@fontsource/dm-mono/500.css'
import React, { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'

// S574: explicit env override wins; else localhost → the dev API, and any real
// host (a {slug}.gam.biz visitor) → the public production API. Without this a
// guest's browser would fetch from ITS OWN localhost:4000 and the site would
// load a blank shell with no property data.
const API = (import.meta as any).env?.VITE_API_URL
  || (typeof location !== 'undefined' && /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)
        ? 'http://localhost:4000'
        : 'https://api.goldassetmanagement.com')
const api = axios.create({ baseURL: `${API}/api/public` })

// ── Slug + page + claim-token resolution (subdomain in prod, path in dev) ──
// S547: the storefront is a full multi-page property WEBSITE — home,
// gallery, FAQ, booking — all living on the property's own subdomain.
type Page = 'home' | 'gallery' | 'faq' | 'book' | 'contact' | 'booked' | 'claim' | 'stay'
const PAGE_SEGMENTS = ['gallery', 'faq', 'book', 'contact', 'booked', 'claim', 'stay']

function resolveLocation(): { slug: string | null; page: Page; claimToken: string | null; stayToken: string | null } {
  const host = location.hostname
  const parts = location.pathname.split('/').filter(Boolean)
  const sub = host.split('.')
  const isSubdomainHost = host.endsWith('gam.biz') && sub.length >= 3 && sub[0] !== 'www'
  // Segments after the slug (dev) / from the root (subdomain).
  const rest = isSubdomainHost ? parts : parts.slice(1)
  const slug = isSubdomainHost ? sub[0] : parts[0] ?? null
  const page: Page = PAGE_SEGMENTS.includes(rest[0]) ? rest[0] as Page : 'home'
  return {
    slug, page,
    claimToken: page === 'claim' ? rest[1] ?? null : null,
    stayToken: page === 'stay' ? rest[1] ?? null : null,
  }
}

/** Site-internal link (subdomain roots at /, dev prefixes /:slug). */
function pageHref(slug: string, page: '' | 'gallery' | 'faq' | 'book' | 'contact'): string {
  const base = location.hostname.endsWith('gam.biz') ? '' : `/${slug}`
  return page ? `${base}/${page}` : (base || '/')
}

const css = `
:root{
  --bg:#080a0c; --bg2:#0d1014; --bg3:#141820; --border:#1e2435;
  --t0:#f0f2f7; --t2:#aeb7cc; --t3:#8a96b0; --dim:#475060;
  --gold:#c9a227; --gold-dim:rgba(201,162,39,.12);
  --green:#22c55e; --red:#ef4444; --amber:#f59e0b;
  --fd:'Syne',sans-serif; --fb:'DM Sans',sans-serif; --fm:'DM Mono',monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{font-family:var(--fb);background:var(--bg);color:var(--t2);line-height:1.6}
.wrap{max-width:960px;margin:0 auto;padding:0 20px}
.hero{padding:64px 0 40px;border-bottom:1px solid var(--border)}
.hero h1{font-family:var(--fd);font-size:2.2rem;color:var(--t0);line-height:1.15}
.hero .loc{color:var(--gold);font-family:var(--fm);font-size:.85rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px}
.hero p{margin-top:14px;max-width:640px;font-size:1.02rem}
h2{font-family:var(--fd);color:var(--t0);font-size:1.3rem;margin-bottom:16px}
section{padding:40px 0;border-bottom:1px solid var(--border)}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px}
.grid{display:grid;gap:14px}
@media(min-width:720px){.grid.g2{grid-template-columns:1fr 1fr}.grid.g3{grid-template-columns:repeat(3,1fr)}}
.btn{font-family:var(--fb);font-weight:600;border:none;border-radius:8px;padding:11px 20px;cursor:pointer;font-size:.95rem}
.btn-p{background:var(--gold);color:#14100a}
.btn-p:disabled{opacity:.5;cursor:default}
.btn-g{background:transparent;color:var(--t2);border:1px solid var(--border)}
.inp,select.inp{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--t0);padding:10px 12px;font-family:var(--fb);font-size:.95rem;color-scheme:dark}
label.fl{display:block;font-size:.75rem;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;font-weight:600}
.badge{display:inline-block;font-size:.7rem;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:.04em}
.b-gold{background:var(--gold-dim);color:var(--gold)}
.b-green{background:rgba(34,197,94,.12);color:var(--green)}
.b-red{background:rgba(239,68,68,.12);color:var(--red)}
.price{font-family:var(--fm);color:var(--t0)}
.alert{border-radius:8px;padding:12px 14px;font-size:.88rem;margin-top:12px}
.a-warn{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);color:#fbd38d}
.a-ok{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:#9ae6b4}
.footer{padding:32px 0;font-size:.8rem;color:var(--dim);text-align:center}
.st-card{cursor:pointer;transition:border-color .15s}
.st-card.sel{border-color:var(--gold)}
.rate{font-family:var(--fm);font-size:.85rem;color:var(--t3)}
.nav{position:sticky;top:0;z-index:10;background:rgba(8,10,12,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.nav-in{max-width:960px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:22px;flex-wrap:wrap}
.nav .brand{font-family:var(--fd);font-weight:800;color:var(--t0);font-size:1.02rem;margin-right:auto;text-decoration:none}
.nav a.nl{color:var(--t2);text-decoration:none;font-size:.92rem;font-weight:500}
.nav a.nl.on{color:var(--gold)}
.nav a.book-cta{background:var(--gold);color:#14100a;font-weight:700;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:.9rem}
.gal{display:grid;gap:14px;grid-template-columns:1fr}
@media(min-width:720px){.gal{grid-template-columns:repeat(3,1fr)}}
.gal figure{margin:0;background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.gal img{width:100%;height:220px;object-fit:cover;display:block}
.gal figcaption{padding:10px 14px;font-size:.85rem;color:var(--t3)}
.strip{display:grid;gap:10px;grid-template-columns:repeat(2,1fr)}
@media(min-width:720px){.strip{grid-template-columns:repeat(3,1fr)}}
.strip img{width:100%;height:150px;object-fit:cover;border-radius:10px;border:1px solid var(--border);display:block}
.cover{width:100%;height:min(46vh,440px);object-fit:cover;display:block;border-bottom:1px solid var(--border)}
.faq-q{font-family:var(--fd);color:var(--t0);font-weight:700;margin-bottom:6px}
.faq-a{font-size:.95rem;white-space:pre-wrap}
/* Skye — the pre-booking property agent (floating chat) */
.pc-bubble{position:fixed;bottom:20px;right:20px;z-index:1000;width:56px;height:56px;border-radius:50%;background:var(--gold);color:#14100a;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:1.35rem;box-shadow:0 8px 24px rgba(0,0,0,.45)}
.pc-panel{position:fixed;bottom:20px;right:20px;z-index:1001;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 40px);background:var(--bg2);border:1px solid var(--border);border-radius:16px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.55)}
.pc-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border);background:var(--bg3)}
.pc-av{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--gold),#e6c45a);color:#14100a;display:flex;align-items:center;justify-content:center;font-weight:800;font-family:var(--fd);flex-shrink:0}
.pc-name{font-family:var(--fd);font-weight:700;color:var(--t0);font-size:.95rem;line-height:1.1}
.pc-sub{font-size:.72rem;color:var(--t3)}
.pc-x{margin-left:auto;background:none;border:none;color:var(--t3);cursor:pointer;font-size:1.2rem;line-height:1}
.pc-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.pc-row{display:flex;gap:8px;align-items:flex-end}
.pc-row.me{flex-direction:row-reverse}
.pc-mav{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--gold),#e6c45a);color:#14100a;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.72rem;flex-shrink:0}
.pc-b{max-width:78%;padding:9px 12px;border-radius:12px;font-size:.9rem;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.pc-b.them{background:var(--bg3);color:var(--t0);border-bottom-left-radius:3px}
.pc-b.me{background:var(--gold);color:#14100a;border-bottom-right-radius:3px}
.pc-read{font-size:.66rem;color:var(--dim);text-align:right;margin:-4px 4px 0 0}
.pc-typing{display:inline-flex;gap:4px;align-items:center;padding:11px 13px;background:var(--bg3);border-radius:12px;border-bottom-left-radius:3px}
.pc-typing i{width:5px;height:5px;border-radius:50%;background:var(--t3);animation:pcdot 1.2s infinite ease-in-out}
.pc-typing i:nth-child(2){animation-delay:.2s}.pc-typing i:nth-child(3){animation-delay:.4s}
@keyframes pcdot{0%,60%,100%{opacity:.3}30%{opacity:1}}
.pc-in{display:flex;gap:8px;padding:12px;border-top:1px solid var(--border);background:var(--bg3)}
.pc-in textarea{flex:1;resize:none;max-height:96px;padding:9px 11px;border-radius:9px;background:var(--bg);border:1px solid var(--border);color:var(--t0);font-family:inherit;font-size:.9rem;outline:none}
.pc-in button{width:40px;flex-shrink:0;border-radius:9px;background:var(--gold);color:#14100a;border:none;cursor:pointer;font-size:1.1rem}
.pc-in button:disabled{opacity:.4;cursor:not-allowed}
@media(prefers-reduced-motion:reduce){.pc-typing i{animation:none;opacity:.55}}
@media(max-width:480px){.pc-panel{width:calc(100vw - 20px);height:calc(100dvh - 30px);bottom:10px;right:10px}}
`

interface SiteType { id: string; name: string; unitType: string; siteCount: number; nightlyRate: number | null; weeklyRate: number | null; minStayNights: number | null; maxStayNights: number | null; checkInTime: string | null; checkOutTime: string | null }
interface Amenity {
  id: string; name: string; description: string | null; capacity: number | null
  openTime: string | null; closeTime: string | null
  reservable: boolean; requiresApproval: boolean
  reservationFee: string | number | null; weekendFee: string | number | null
  eventsEnabled: boolean; eventDepositAmount: string | number | null
  maxReservationHours: number | null; advanceBookingDays: number | null
}
interface SitePhoto { id: string; caption: string | null; url: string }
interface Faq { id: string; question: string; answer: string }
interface PropertyInfo {
  name: string; city: string | null; state: string | null; intro: string | null; depositPct: number
  about: string | null; area: string | null
  street1: string | null; zip: string | null
  officePhone: string | null; officeEmail: string | null; officeHours: string | null
}
interface Profile { property: PropertyInfo; siteTypes: SiteType[]; amenities: Amenity[]; photos: SitePhoto[]; faqs: Faq[] }
const photoSrc = (p: SitePhoto) => `${API}${p.url}`

const money = (n: number | null | undefined) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const hhmm = (t: string | null) => t ? t.slice(0, 5) : null

function App() {
  const { slug, page, claimToken, stayToken } = useMemo(resolveLocation, [])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) { setErr('no-slug'); return }
    api.get(`/property/${slug}`)
      .then(r => { setProfile(r.data.data); document.title = r.data.data.property.name })
      .catch(() => setErr('not-found'))
  }, [slug])

  if (err === 'no-slug') return <Shell><section className="wrap"><h2>GAM Storefront</h2><p>No property selected. In development, open <span className="price">/&lt;booking-slug&gt;</span> (e.g. /sunset-palms).</p></section></Shell>
  if (err === 'not-found') return <Shell><section className="wrap"><h2>Site not found</h2><p>This site doesn’t exist or isn’t published right now.</p></section></Shell>
  if (!profile) return <Shell><section className="wrap"><p>Loading…</p></section></Shell>

  const p = profile.property
  const s = slug!
  const nav = (
    <nav className="nav">
      <div className="nav-in">
        <a className="brand" href={pageHref(s, '')}>{p.name}</a>
        <a className={`nl${page === 'home' ? ' on' : ''}`} href={pageHref(s, '')}>Home</a>
        {profile.photos.length > 0 && <a className={`nl${page === 'gallery' ? ' on' : ''}`} href={pageHref(s, 'gallery')}>Gallery</a>}
        {profile.faqs.length > 0 && <a className={`nl${page === 'faq' ? ' on' : ''}`} href={pageHref(s, 'faq')}>FAQ</a>}
        <a className={`nl${page === 'contact' ? ' on' : ''}`} href={pageHref(s, 'contact')}>Contact</a>
        <a className="book-cta" href={pageHref(s, 'book')}>Book Now</a>
      </div>
    </nav>
  )

  return (
    <Shell>
      {nav}
      {page === 'claim' && claimToken ? (
        <ClaimView slug={s} token={claimToken} />
      ) : page === 'booked' ? (
        <BookedView slug={s} propertyName={p.name} />
      ) : page === 'gallery' ? (
        <GalleryPage profile={profile} />
      ) : page === 'faq' ? (
        <FaqPage profile={profile} />
      ) : page === 'contact' ? (
        <ContactPage slug={s} profile={profile} />
      ) : page === 'stay' && stayToken ? (
        <StayPage slug={s} token={stayToken} profile={profile} />
      ) : page === 'book' ? (
        // S547 (Nic): no standalone contact form here — questions ride along
        // with the reservation; the contact form lives on the home page.
        <BookingSection slug={s} profile={profile} />
      ) : (
        <HomePage slug={s} profile={profile} />
      )}
      <div className="footer wrap">Reservations powered by Gold Asset Management</div>
      <PropertyChat slug={s} propertyName={p.name} />
    </Shell>
  )
}

// ── Home: hero + description + photos + amenities + inquiry ──
function HomePage({ slug, profile }: { slug: string; profile: Profile }) {
  const p = profile.property
  return (
    <>
      {profile.photos.length > 0 && (
        <img className="cover" src={photoSrc(profile.photos[0])} alt={profile.photos[0].caption ?? p.name} />
      )}
      <div className="hero wrap">
        <div className="loc">{[p.city, p.state].filter(Boolean).join(', ') || 'Welcome'}</div>
        <h1>{p.name}</h1>
        {p.intro && <p>{p.intro}</p>}
        <p style={{ marginTop: 22 }}>
          <a className="btn btn-p" style={{ textDecoration: 'none' }} href={pageHref(slug, 'book')}>Check availability &amp; book</a>
        </p>
      </div>
      {profile.photos.length > 1 && (
        <section className="wrap">
          <h2>Take a look around</h2>
          <div className="strip">
            {profile.photos.slice(1, 7).map(ph => (
              <a key={ph.id} href={pageHref(slug, 'gallery')}><img src={photoSrc(ph)} alt={ph.caption ?? p.name} loading="lazy" /></a>
            ))}
          </div>
          {profile.photos.length > 7 && (
            <p style={{ marginTop: 12 }}><a href={pageHref(slug, 'gallery')} style={{ color: 'var(--gold)' }}>See the full gallery →</a></p>
          )}
        </section>
      )}
      {p.about && (
        <section className="wrap">
          <h2>Our story</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{p.about}</p>
        </section>
      )}
      {p.area && (
        <section className="wrap">
          <h2>The area &amp; things to do</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{p.area}</p>
        </section>
      )}
      {profile.amenities.length > 0 && <AmenitiesSection slug={slug} amenities={profile.amenities} />}
      <InquirySection slug={slug} propertyName={p.name} />
    </>
  )
}

function GalleryPage({ profile }: { profile: Profile }) {
  return (
    <section className="wrap">
      <h2>Gallery</h2>
      {profile.photos.length === 0 ? <p>No photos yet.</p> : (
        <div className="gal">
          {profile.photos.map(ph => (
            <figure key={ph.id}>
              <img src={photoSrc(ph)} alt={ph.caption ?? profile.property.name} loading="lazy" />
              {ph.caption && <figcaption>{ph.caption}</figcaption>}
            </figure>
          ))}
        </div>
      )}
    </section>
  )
}

function FaqPage({ profile }: { profile: Profile }) {
  return (
    <section className="wrap">
      <h2>Frequently asked questions</h2>
      {profile.faqs.length === 0 ? <p>No FAQs yet.</p> : (
        <div className="grid">
          {profile.faqs.map(f => (
            <div key={f.id} className="card">
              <div className="faq-q">{f.question}</div>
              <div className="faq-a">{f.answer}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <><style dangerouslySetInnerHTML={{ __html: css }} />{children}</>
}

// ── Booking (S547, dates-first): dates → what's open → pick → deposit ──
// The guest never clicks into a site type that turns out to be full: one
// availability call prices every type for the chosen dates, available types
// render as pick-cards, full ones dim to a waitlist option.
interface BillingSegment { from: string; to: string; nights: number; amount: number; fullMonth: boolean }
interface TypeAvail {
  id: string; name: string; unitType: string
  available: boolean; unavailableReason: string | null
  total: number | null; tax: number; depositAmount: number | null
  minStayNights: number | null; checkInTime: string | null; checkOutTime: string | null
  monthlyBilling: { monthlyRate: number; segments: BillingSegment[] } | null
  altStay: { checkOut: string; nights: number } | null
}
const monthDay = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
interface AvailResult { nights: number; depositPct: number; utilitiesBilled: boolean; siteTypes: TypeAvail[] }

// Plural section labels for booking-page grouping (mirror @gam/shared
// UNIT_TYPE_LABEL; kept local so this anonymous public app needs no workspace dep).
const UNIT_TYPE_GROUP_LABEL: Record<string, string> = {
  rv_spot: 'RV Sites', campsite: 'Campsites', hotel_room: 'Rooms',
  mobile_home: 'Mobile Homes', apartment: 'Apartments', single_family: 'Homes',
  storage: 'Storage', parking: 'Parking', boat_slip: 'Boat Slips',
  land_lot: 'Lots', commercial: 'Commercial',
}
const groupLabel = (ut: string) => UNIT_TYPE_GROUP_LABEL[ut] || 'Other'

function BookingSection({ slug, profile }: { slug: string; profile: Profile }) {
  const today = new Date().toISOString().slice(0, 10)
  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [avail, setAvail] = useState<AvailResult | null>(null)
  const [typeId, setTypeId] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [guest, setGuest] = useState({ name: '', email: '', phone: '', note: '' })
  const [booking, setBooking] = useState(false)
  const [justFilled, setJustFilled] = useState(false)
  const [waitlisted, setWaitlisted] = useState(false)

  const reset = () => { setAvail(null); setTypeId(''); setError(null); setJustFilled(false); setWaitlisted(false) }

  const check = async (checkOutOverride?: string) => {
    setChecking(true); reset()
    try {
      const r = await api.get(`/property/${slug}/availability`, { params: { checkIn, checkOut: checkOutOverride ?? checkOut } })
      const data: AvailResult = r.data.data
      setAvail(data)
      // One open option → pre-select it; several → the guest picks their preference.
      const open = data.siteTypes.filter(t => t.available)
      if (open.length === 1) setTypeId(open[0].id)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not check those dates')
    } finally { setChecking(false) }
  }

  const book = async () => {
    setBooking(true); setError(null)
    try {
      const r = await api.post(`/property/${slug}/book`, {
        siteTypeId: typeId, checkIn, checkOut,
        guestName: guest.name, guestEmail: guest.email, guestPhone: guest.phone || undefined,
        note: guest.note.trim() || undefined,
      })
      // Deposit checkout finishes the reservation; the hold is already on
      // the landlord's calendar.
      window.location.href = r.data.data.checkoutUrl
    } catch (e: any) {
      if (e?.response?.status === 409 && e?.response?.data?.full) setJustFilled(true)
      else setError(e?.response?.data?.error || 'Booking failed — please try again')
    } finally { setBooking(false) }
  }

  const joinWaitlist = async () => {
    setBooking(true); setError(null)
    try {
      await api.post(`/property/${slug}/waitlist`, {
        siteTypeId: typeId, checkIn, checkOut,
        guestName: guest.name, guestEmail: guest.email, guestPhone: guest.phone || undefined,
      })
      setWaitlisted(true)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not join the waitlist')
    } finally { setBooking(false) }
  }

  const sel = avail?.siteTypes.find(t => t.id === typeId) ?? null
  const selOpen = !!sel && sel.available && !justFilled
  const anyOpen = !!avail && avail.siteTypes.some(t => t.available)
  const nightsLabel = avail ? `${avail.nights} night${avail.nights === 1 ? '' : 's'}` : ''

  // Group available types by unit type so RV sites cluster, rooms cluster, etc.
  // (Nic S600). A single-type property falls through to a flat grid — no heading.
  const typeGroups = useMemo(() => {
    if (!avail) return [] as { ut: string; types: TypeAvail[] }[]
    const order: string[] = []
    const map = new Map<string, TypeAvail[]>()
    for (const t of avail.siteTypes) {
      const ut = t.unitType || 'other'
      if (!map.has(ut)) { map.set(ut, []); order.push(ut) }
      map.get(ut)!.push(t)
    }
    return order.map(ut => ({ ut, types: map.get(ut)! }))
  }, [avail])

  const renderTypeCard = (t: TypeAvail) => {
    const selectable = t.available || t.unavailableReason === 'booked'
    return (
      <div key={t.id}
        className={`card st-card${t.id === typeId ? ' sel' : ''}`}
        style={selectable ? undefined : { opacity: .55, cursor: 'default' }}
        onClick={() => { if (selectable) { setTypeId(t.id); setJustFilled(false); setWaitlisted(false) } }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <div style={{ fontFamily: 'var(--fd)', color: 'var(--t0)', fontWeight: 700 }}>{t.name}</div>
          {t.available
            ? <span className="badge b-green">Available</span>
            : t.unavailableReason === 'booked'
            ? <span className="badge b-red">Full</span>
            : null}
        </div>
        <div className="rate" style={{ marginTop: 8 }}>
          {t.available && t.total != null ? (
            <>
              {t.monthlyBilling ? (
                <>
                  <span className="price" style={{ fontSize: '1.05rem', fontWeight: 700 }}>{money(t.monthlyBilling.monthlyRate)}/month</span>
                  {avail!.utilitiesBilled && <> plus utilities</>} · {nightsLabel}
                </>
              ) : (
                <>
                  <span className="price" style={{ fontSize: '1.05rem', fontWeight: 700 }}>{money(t.total)}</span> · {nightsLabel}
                  {t.tax > 0 && <><br />incl. {money(t.tax)} lodging tax</>}
                </>
              )}
              <br />Due now: {money(t.depositAmount)} deposit
            </>
          ) : t.unavailableReason === 'booked' ? (
            <>
              Full for these dates — join the waitlist
              {t.altStay && (
                <div style={{ marginTop: 8 }}>
                  <button className="btn btn-g" style={{ padding: '5px 10px', fontSize: '.8rem' }}
                    onClick={e => { e.stopPropagation(); setCheckOut(t.altStay!.checkOut); check(t.altStay!.checkOut) }}>
                    Open until {monthDay(t.altStay.checkOut)} — shorten to {t.altStay.nights} night{t.altStay.nights === 1 ? '' : 's'}
                  </button>
                </div>
              )}
            </>
          ) : t.unavailableReason === 'rate_unavailable' ? (
            <>Online rates aren’t set for this stay — contact us from the home page</>
          ) : (
            <>{t.unavailableReason}</>
          )}
        </div>
      </div>
    )
  }

  return (
    <section className="wrap" id="book">
      <h2>Book your stay</h2>
      {profile.siteTypes.length === 0 ? (
        <p>Online booking isn’t available right now — send us a note below and we’ll help directly.</p>
      ) : (
        <>
          <div className="card">
            <div className="grid g3">
              <div><label className="fl">Check-in</label><input className="inp" type="date" min={today} value={checkIn} onChange={e => { setCheckIn(e.target.value); reset() }} /></div>
              <div><label className="fl">Check-out</label><input className="inp" type="date" min={checkIn || today} value={checkOut} onChange={e => { setCheckOut(e.target.value); reset() }} /></div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button className="btn btn-p" style={{ width: '100%' }} disabled={!checkIn || !checkOut || checking} onClick={() => check()}>
                  {checking ? 'Checking…' : 'Check availability'}
                </button>
              </div>
            </div>
            {!avail && (
              <div className="rate" style={{ marginTop: 12 }}>
                {profile.siteTypes.map(t => [
                  t.name,
                  t.nightlyRate != null ? `from ${money(t.nightlyRate)}/night` : null,
                ].filter(Boolean).join(' ')).join(' · ')}
              </div>
            )}
            {error && <div className="alert a-warn">{error}</div>}
          </div>

          {avail && (
            <>
              {!anyOpen && (
                <div className="alert a-warn" style={{ marginTop: 14 }}>
                  We’re full for {checkIn} → {checkOut}. Pick a spot below to join the waitlist — we’ll email you the moment those dates open — or try different dates.
                </div>
              )}
              {typeGroups.length <= 1 ? (
                <div className="grid g3" style={{ marginTop: 14 }}>
                  {avail.siteTypes.map(renderTypeCard)}
                </div>
              ) : (
                typeGroups.map(g => (
                  <div key={g.ut} style={{ marginTop: 18 }}>
                    <h3 style={{ fontFamily: 'var(--fd)', color: 'var(--t2)', fontSize: '1.05rem', margin: '0 0 10px' }}>{groupLabel(g.ut)}</h3>
                    <div className="grid g3">{g.types.map(renderTypeCard)}</div>
                  </div>
                ))
              )}

              {sel && !waitlisted && (
                <div className="card" style={{ marginTop: 14 }}>
                  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 14 }}>
                    <span style={{ fontFamily: 'var(--fd)', color: 'var(--t0)', fontWeight: 700 }}>{sel.name}</span>
                    <span className="rate">{checkIn} → {checkOut} · {nightsLabel}</span>
                    {selOpen && sel.total != null && (
                      <>
                        <span className="price" style={{ fontSize: '1.15rem', fontWeight: 700 }}>{sel.monthlyBilling ? `${money(sel.monthlyBilling.monthlyRate)}/mo${avail!.utilitiesBilled ? ' + utilities' : ''}` : money(sel.total)}</span>
                        <span className="rate">Due now: {money(sel.depositAmount)} deposit</span>
                      </>
                    )}
                  </div>
                  {selOpen && sel.monthlyBilling && (
                    <div className="rate" style={{ marginBottom: 14 }}>
                      Invoiced monthly on the 1st — your first and last months are prorated to the days you stay.
                      {avail!.utilitiesBilled && ' Utilities are billed separately.'}
                    </div>
                  )}
                  <div className="grid g3">
                    <div><label className="fl">Name</label><input className="inp" value={guest.name} onChange={e => setGuest({ ...guest, name: e.target.value })} /></div>
                    <div><label className="fl">Email</label><input className="inp" type="email" value={guest.email} onChange={e => setGuest({ ...guest, email: e.target.value })} /></div>
                    <div><label className="fl">Phone (optional)</label><input className="inp" value={guest.phone} onChange={e => setGuest({ ...guest, phone: e.target.value })} /></div>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <label className="fl">Questions or requests (optional)</label>
                    <textarea className="inp" rows={2} maxLength={2000} value={guest.note}
                      onChange={e => setGuest({ ...guest, note: e.target.value })}
                      placeholder="Rig size, arrival time, anything we should know…" />
                  </div>
                  <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {selOpen ? (
                      <button className="btn btn-p" disabled={booking || !guest.name || !guest.email} onClick={book}>
                        {booking ? 'Holding your dates…' : `Reserve — pay ${money(sel.depositAmount)} deposit`}
                      </button>
                    ) : (
                      <button className="btn btn-p" disabled={booking || !guest.name || !guest.email} onClick={joinWaitlist}>
                        {booking ? 'Joining…' : 'Join the waitlist'}
                      </button>
                    )}
                  </div>
                  {justFilled && <div className="alert a-warn">Those dates were just taken — you can join the waitlist instead.</div>}
                  {(hhmm(sel.checkInTime) || hhmm(sel.checkOutTime)) && (
                    <div className="rate" style={{ marginTop: 10 }}>
                      {hhmm(sel.checkInTime) && <>Check-in after {hhmm(sel.checkInTime)}</>}{hhmm(sel.checkInTime) && hhmm(sel.checkOutTime) && ' · '}{hhmm(sel.checkOutTime) && <>Check-out by {hhmm(sel.checkOutTime)}</>}
                    </div>
                  )}
                  {selOpen && (
                    <div className="rate" style={{ marginTop: 6 }}>
                      Your exact site number is assigned and emailed to you the morning of check-in.
                    </div>
                  )}
                </div>
              )}
              {waitlisted && <div className="alert a-ok" style={{ marginTop: 14 }}>You’re on the waitlist — we’ll email you a claim link if those dates open up.</div>}
            </>
          )}
        </>
      )}
    </section>
  )
}

// ── Booked confirmation (S547): Stripe success returns to /booked?booking=<id>.
// Polls the sanitized status endpoint until the deposit webhook confirms.
function BookedView({ slug, propertyName }: { slug: string; propertyName: string }) {
  const bookingId = new URLSearchParams(location.search).get('booking')
  const [info, setInfo] = useState<any>(null)
  const [notFound, setNotFound] = useState(false)
  const [polls, setPolls] = useState(0)

  useEffect(() => {
    if (!bookingId) return
    let cancelled = false
    const load = () => api.get(`/property/${slug}/booking/${bookingId}`)
      .then(r => { if (!cancelled) setInfo(r.data.data) })
      .catch(() => { if (!cancelled) setNotFound(true) })
    load()
    return () => { cancelled = true }
  }, [slug, bookingId, polls])

  // While tentative, re-poll every 3s (webhook latency) up to ~30s.
  useEffect(() => {
    if (info?.status === 'tentative' && polls < 10) {
      const t = setTimeout(() => setPolls(p => p + 1), 3000)
      return () => clearTimeout(t)
    }
  }, [info, polls])

  const dates = info ? <>{String(info.checkIn).slice(0, 10)} → {String(info.checkOut).slice(0, 10)} · {info.nights} night{info.nights === 1 ? '' : 's'}</> : null

  return (
    <section className="wrap">
      {!bookingId || notFound ? (
        <>
          <h2>Deposit received</h2>
          <div className="alert a-ok">Thanks — your payment went through. A confirmation email with your reservation details is on its way.</div>
        </>
      ) : !info ? (
        <p>Checking your reservation…</p>
      ) : info.status === 'confirmed' || info.status === 'checked_in' ? (
        <>
          <h2>You’re booked, {info.guestName}!</h2>
          <div className="card">
            <div style={{ marginBottom: 8 }}><span className="badge b-green">Confirmed</span></div>
            <p style={{ color: 'var(--t0)' }}>{propertyName}</p>
            <p className="rate" style={{ marginTop: 6 }}>{dates}</p>
            <p className="rate" style={{ marginTop: 6 }}>Deposit paid: <span className="price">{money(info.depositAmount)}</span> · Stay total: <span className="price">{money(info.total)}</span></p>
            <p className="rate" style={{ marginTop: 10 }}>Your exact site number is assigned and emailed to you the morning of check-in.</p>
            <p className="rate" style={{ marginTop: 6 }}>Check your email for your private <b>stay link</b> — reserve amenities and manage your stay from there.</p>
          </div>
        </>
      ) : info.status === 'tentative' ? (
        <>
          <h2>Payment received — finalizing your reservation</h2>
          <div className="card">
            <p className="rate">{dates}</p>
            <p style={{ marginTop: 10 }}>{polls < 10
              ? 'Hang tight — we’re confirming your deposit with the payment processor…'
              : 'Your deposit is processing. You’ll get a confirmation email the moment it clears — no need to stay on this page.'}</p>
          </div>
        </>
      ) : (
        <>
          <h2>Reservation status</h2>
          <div className="alert a-warn">This reservation is no longer active. If you believe that’s wrong, reply to your confirmation email or send us an inquiry.</div>
          <p style={{ marginTop: 12 }}><a href={pageHref(slug, 'book')} style={{ color: 'var(--gold)' }}>Back to booking</a></p>
        </>
      )}
    </section>
  )
}

// ── S547: contact page — hours, phone, address, and the message form ──
function ContactPage({ slug, profile }: { slug: string; profile: Profile }) {
  const p = profile.property
  const address = [p.street1, [p.city, p.state].filter(Boolean).join(', '), p.zip].filter(Boolean).join(' · ')
  return (
    <>
      <section className="wrap">
        <h2>Contact {p.name}</h2>
        <div className="grid g2">
          <div className="card">
            <div style={{ fontFamily: 'var(--fd)', color: 'var(--t0)', fontWeight: 700, marginBottom: 8 }}>Office</div>
            {p.officePhone && <div style={{ marginBottom: 6 }}>📞 <a href={`tel:${p.officePhone.replace(/[^+\d]/g, '')}`} style={{ color: 'var(--gold)' }}>{p.officePhone}</a></div>}
            {p.officeEmail && <div style={{ marginBottom: 6 }}>✉️ <a href={`mailto:${p.officeEmail}`} style={{ color: 'var(--gold)' }}>{p.officeEmail}</a></div>}
            {address && <div style={{ marginBottom: 6 }}>📍 {address}</div>}
            {!p.officePhone && !p.officeEmail && !address && <div className="rate">Contact details coming soon — send us a message below.</div>}
          </div>
          {p.officeHours && (
            <div className="card">
              <div style={{ fontFamily: 'var(--fd)', color: 'var(--t0)', fontWeight: 700, marginBottom: 8 }}>Office hours</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: '.95rem' }}>{p.officeHours}</div>
            </div>
          )}
        </div>
      </section>
      <InquirySection slug={slug} propertyName={p.name} />
    </>
  )
}

// ── Amenities + S547 guest reservations ──
// The public site is INFO-ONLY (Nic: the pool must never look bookable by
// the public). Booking happens on the tokened /stay page — the stay link
// emailed at booking is the guest's key.
function AmenityCard({ slug, a, stayToken }: { slug: string; a: Amenity; stayToken?: string | null }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ date: '', start: '', end: '', guestCount: '', notes: '', isEvent: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ status: string; feeAmount: number } | null>(null)

  const fee = Number(a.reservationFee || 0)
  const eventFee = Number(a.eventDepositAmount || 0)

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      const startsAt = new Date(`${f.date}T${f.start}`).toISOString()
      const endsAt   = new Date(`${f.date}T${f.end}`).toISOString()
      const r = await api.post(`/property/${slug}/stay/${stayToken}/amenity/${a.id}/reserve`, {
        startsAt, endsAt,
        guestCount: f.guestCount ? Number(f.guestCount) : undefined,
        notes: f.notes || undefined,
        isEvent: f.isEvent || undefined,
      })
      setDone(r.data.data)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not reserve — please try again')
    } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div style={{ fontFamily: 'var(--fd)', color: 'var(--t0)', fontWeight: 700 }}>{a.name}</div>
      {a.description && <div style={{ fontSize: '.88rem', marginTop: 6 }}>{a.description}</div>}
      <div className="rate" style={{ marginTop: 8 }}>
        {hhmm(a.openTime) && hhmm(a.closeTime) ? `Open ${hhmm(a.openTime)} – ${hhmm(a.closeTime)}` : ''}
        {a.capacity ? `${hhmm(a.openTime) ? ' · ' : ''}Up to ${a.capacity}` : ''}
        {!stayToken && a.reservable ? `${hhmm(a.openTime) || a.capacity ? ' · ' : ''}Guests can reserve` : ''}
      </div>
      {stayToken && a.reservable && !done && (
        <div style={{ marginTop: 10 }}>
          {!open ? (
            <button className="btn btn-g" style={{ padding: '6px 12px', fontSize: '.85rem' }} onClick={() => setOpen(true)}>
              Reserve{fee > 0 ? ` — ${money(fee)}` : ''}
            </button>
          ) : (
            <div style={{ marginTop: 6 }}>
              {a.requiresApproval && <div className="rate" style={{ marginBottom: 8 }}>The office confirms each reservation.</div>}
              <div className="grid g2" style={{ gap: 8 }}>
                <div><label className="fl">Date</label><input className="inp" type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></div>
                <div><label className="fl">Guests (optional)</label><input className="inp" type="number" min={1} value={f.guestCount} onChange={e => setF({ ...f, guestCount: e.target.value })} /></div>
                <div><label className="fl">From</label><input className="inp" type="time" value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></div>
                <div><label className="fl">To</label><input className="inp" type="time" value={f.end} onChange={e => setF({ ...f, end: e.target.value })} /></div>
              </div>
              {a.eventsEnabled && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, cursor: 'pointer', fontSize: '.88rem' }}>
                  <input type="checkbox" checked={f.isEvent} onChange={e => setF({ ...f, isEvent: e.target.checked })} />
                  <span>Private event (birthday, gathering){eventFee > 0 ? ` — ${money(eventFee)} deposit` : ''}</span>
                </label>
              )}
              <div style={{ marginTop: 8 }}>
                <label className="fl">Notes (optional)</label>
                <textarea className="inp" rows={2} maxLength={2000} value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} />
              </div>
              {error && <div className="alert a-warn">{error}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-p" style={{ padding: '6px 14px', fontSize: '.85rem' }}
                  disabled={busy || !f.date || !f.start || !f.end} onClick={submit}>
                  {busy ? 'Reserving…' : 'Reserve'}
                </button>
                <button className="btn btn-g" style={{ padding: '6px 12px', fontSize: '.85rem' }} onClick={() => setOpen(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {done && (
        <div className="alert a-ok">
          {done.status === 'approved'
            ? <>Reserved! {done.feeAmount > 0 && <>The {money(done.feeAmount)} fee is payable at the office.</>}</>
            : <>Request sent — the office will confirm your reservation.{done.feeAmount > 0 && <> The {money(done.feeAmount)} fee is payable at the office.</>}</>}
        </div>
      )}
    </div>
  )
}

function AmenitiesSection({ slug, amenities, stayToken }: { slug: string; amenities: Amenity[]; stayToken?: string | null }) {
  return (
    <section className="wrap">
      <h2>Amenities</h2>
      <div className="grid g3">
        {amenities.map(a => <AmenityCard key={a.id} slug={slug} a={a} stayToken={stayToken} />)}
      </div>
      {!stayToken && amenities.some(a => a.reservable) && <StayLinkBox slug={slug} />}
    </section>
  )
}

// "Staying with us?" — amenity booking lives behind the guest's private stay
// link; this box re-sends it (always answers success — no email enumeration).
function StayLinkBox({ slug }: { slug: string }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const send = async () => {
    setBusy(true)
    try { await api.post(`/property/${slug}/stay-link`, { email }); setSent(true) }
    catch { setSent(true) }
    finally { setBusy(false) }
  }
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div style={{ fontFamily: 'var(--fd)', color: 'var(--t0)', fontWeight: 700 }}>Staying with us?</div>
      <div className="rate" style={{ margin: '6px 0 10px' }}>
        Guests reserve amenities from their private stay link — it's in your booking email. Need it again?
      </div>
      {sent ? (
        <div className="alert a-ok">If we have a stay under that email, your link is on its way.</div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="inp" type="email" placeholder="Email on your reservation" value={email}
            onChange={e => setEmail(e.target.value)} style={{ maxWidth: 320 }} />
          <button className="btn btn-p" disabled={busy || !email} onClick={send}>{busy ? 'Sending…' : 'Email my stay link'}</button>
        </div>
      )}
    </div>
  )
}

// ── S547: the guest's tokened stay page — stay summary + amenity booking ──
function StayPage({ slug, token, profile }: { slug: string; token: string; profile: Profile }) {
  const [stay, setStay] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api.get(`/property/${slug}/stay/${token}`)
      .then(r => setStay(r.data.data))
      .catch(e => setErr(e?.response?.data?.error || 'This stay link is invalid or has expired'))
  }, [slug, token])

  if (err) return (
    <section className="wrap">
      <h2>Your stay</h2>
      <div className="alert a-warn">{err}</div>
      <p style={{ marginTop: 12 }}>Need a fresh link? Use the "Staying with us?" box on the <a href={pageHref(slug, '')} style={{ color: 'var(--gold)' }}>home page</a>, or contact the office.</p>
    </section>
  )
  if (!stay) return <section className="wrap"><p>Loading…</p></section>

  return (
    <>
      <section className="wrap">
        <h2>Welcome, {stay.guestName || 'guest'}</h2>
        <div className="card">
          <p style={{ color: 'var(--t0)' }}>{stay.propertyName}</p>
          <p className="rate" style={{ marginTop: 6 }}>
            {String(stay.checkIn).slice(0, 10)} → {String(stay.checkOut).slice(0, 10)} · {stay.nights} night{stay.nights === 1 ? '' : 's'}
          </p>
          <p className="rate" style={{ marginTop: 6 }}>Your exact site number is assigned and emailed to you the morning of check-in.</p>
        </div>
      </section>
      {profile.amenities.length > 0 && <AmenitiesSection slug={slug} amenities={profile.amenities} stayToken={token} />}
      <InquirySection slug={slug} propertyName={stay.propertyName} />
    </>
  )
}

function InquirySection({ slug, propertyName }: { slug: string; propertyName: string }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', message: '' })
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    setBusy(true); setError(null)
    try {
      await api.post(`/property/${slug}/inquiry`, { name: f.name, email: f.email, phone: f.phone || undefined, message: f.message })
      setSent(true)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not send — please try again')
    } finally { setBusy(false) }
  }
  return (
    <section className="wrap">
      <h2>Questions? Ask {propertyName}</h2>
      {sent ? (
        <div className="alert a-ok">Thanks — your message is on its way. We’ll get back to you at {f.email}.</div>
      ) : (
        <div className="card">
          <div className="grid g3">
            <div><label className="fl">Name</label><input className="inp" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div>
            <div><label className="fl">Email</label><input className="inp" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></div>
            <div><label className="fl">Phone (optional)</label><input className="inp" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="fl">Message</label>
            <textarea className="inp" rows={4} maxLength={2000} value={f.message} onChange={e => setF({ ...f, message: e.target.value })}
              placeholder="Availability questions, long-term stays, rig size, anything…" />
          </div>
          {error && <div className="alert a-warn">{error}</div>}
          <div style={{ marginTop: 14 }}>
            <button className="btn btn-p" disabled={busy || !f.name || !f.email || !f.message} onClick={send}>
              {busy ? 'Sending…' : 'Send inquiry'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

// ── Waitlist claim landing (/claim/:token) ──
function ClaimView({ slug, token }: { slug: string; token: string }) {
  const [info, setInfo] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    api.get(`/property/${slug}/claim/${token}`)
      .then(r => setInfo(r.data.data))
      .catch(() => setErr('This claim link isn’t valid.'))
  }, [slug, token])

  const claim = async () => {
    setBusy(true)
    try {
      const r = await api.post(`/property/${slug}/claim/${token}`, {})
      window.location.href = r.data.data.checkoutUrl
    } catch (e: any) {
      if (e?.response?.status === 409) setGone(true)
      else setErr(e?.response?.data?.error || 'Could not claim — please try again')
    } finally { setBusy(false) }
  }

  if (err) return <section className="wrap"><h2>Waitlist claim</h2><div className="alert a-warn">{err}</div></section>
  if (!info) return <section className="wrap"><p>Loading…</p></section>
  return (
    <section className="wrap">
      <h2>Your spot opened up</h2>
      <div className="card">
        <p style={{ marginBottom: 10 }}>
          {info.guestName}, dates <span className="price">{info.checkIn}</span> → <span className="price">{info.checkOut}</span> at {info.propertyName} are yours to claim.
        </p>
        {info.expired ? (
          <div className="alert a-warn">This claim window has expired.</div>
        ) : gone ? (
          <div className="alert a-warn">Those dates were just taken by someone else.</div>
        ) : (
          <>
            {info.claimExpiresAt && <div className="rate" style={{ marginBottom: 12 }}>Claim by {new Date(info.claimExpiresAt).toLocaleString()}</div>}
            <button className="btn btn-p" disabled={busy} onClick={claim}>{busy ? 'Claiming…' : 'Claim & pay deposit'}</button>
          </>
        )}
      </div>
    </section>
  )
}

// ── Skye — the pre-booking property agent (floating chat) ──
// Talks to POST /api/property/:slug/agent/chat: a public, property-scoped agent
// that answers pricing/availability/amenities for THIS property and can start a
// reservation. Human texting cadence (Read receipt → typing → paced reply
// bubbles) mirrors the platform's other agents. History persists per-property in
// localStorage so a visitor doesn't lose the thread while browsing the site.
const chatSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
interface ChatMsg { role: 'user' | 'agent'; text: string }

function ChatRow({ role, text }: { role: 'user' | 'agent'; text: string }) {
  const me = role === 'user'
  return (
    <div className={`pc-row${me ? ' me' : ''}`}>
      {!me && <div className="pc-mav">S</div>}
      <div className={`pc-b ${me ? 'me' : 'them'}`}>{text}</div>
    </div>
  )
}

function PropertyChat({ slug, propertyName }: { slug: string; propertyName: string }) {
  const KEY = `gam_property_chat_${slug}`
  const GREETING = `Hi! I'm Skye, the booking host for ${propertyName}. Ask me anything — rates, availability, or what's here — and I can get you booked.`
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [indicator, setIndicator] = useState<'none' | 'read' | 'typing'>('none')
  const scrollRef = React.useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) {
        const s = JSON.parse(raw)
        if (Array.isArray(s.messages)) setMessages(s.messages)
        if (typeof s.conversationId === 'string') setConversationId(s.conversationId)
      }
    } catch { /* ignore corrupt cache */ }
  }, [])

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ messages: messages.slice(-60), conversationId })) } catch { /* quota */ }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, conversationId, indicator, sending])

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text }])
    setSending(true)

    // History = prior turns only; current message rides separately. Runs in
    // parallel with the read/typing beats and never throws, so the cadence
    // always completes.
    const priorHistory = messages
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text).slice(0, 8000) }))
      .slice(-30)
    const replyPromise: Promise<string> = (async () => {
      try {
        const r = await axios.post(`${API}/api/property/${slug}/agent/chat`,
          conversationId ? { message: text, conversationId, history: priorHistory } : { message: text, history: priorHistory })
        const d = r.data?.data || {}
        if (typeof d.conversationId === 'string') setConversationId(d.conversationId)
        return d.reply || "Sorry — I didn't catch that. Could you say it another way?"
      } catch (e: any) {
        return e?.response?.status === 429
          ? "You're sending those a little quickly — give me a moment and try again."
          : "I'm having trouble connecting right now. Please try again in a moment."
      }
    })()

    // Read receipt → typing → the reply lands as separate, paced bubbles.
    const readMs = readBeatMs(text.length)
    await chatSleep(readMs); setIndicator('read')
    await chatSleep(PAUSE_BEFORE_TYPING_MS); setIndicator('typing')
    let since = Date.now()

    const reply = await replyPromise
    const parts = String(reply).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
    if (!parts.length) parts.push(String(reply))
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const typeMs = typeBeatMs(part.length)
      const held = Date.now() - since
      await chatSleep(Math.max(0, typeMs - held))
      setIndicator('none')
      setMessages((m) => [...m, { role: 'agent', text: part }])
      if (i < parts.length - 1) {
        const readGap = readGapMs(part.length)
        await chatSleep(readGap)
        setIndicator('typing'); since = Date.now()
      }
    }
    setIndicator('none'); setSending(false)
  }

  if (!open) {
    return <button className="pc-bubble" aria-label="Chat with the booking host" onClick={() => setOpen(true)}>💬</button>
  }
  return (
    <div className="pc-panel" role="dialog" aria-label="Booking assistant">
      <div className="pc-head">
        <div className="pc-av">S</div>
        <div>
          <div className="pc-name">Skye</div>
          <div className="pc-sub">Booking host · {propertyName}</div>
        </div>
        <button className="pc-x" aria-label="Close chat" onClick={() => setOpen(false)}>▾</button>
      </div>
      <div className="pc-msgs" ref={scrollRef}>
        <ChatRow role="agent" text={GREETING} />
        {messages.map((m, i) => <ChatRow key={i} role={m.role} text={m.text} />)}
        {indicator === 'read' && <div className="pc-read">Read</div>}
        {indicator === 'typing' && (
          <div className="pc-row"><div className="pc-mav">S</div><div className="pc-typing"><i /><i /><i /></div></div>
        )}
      </div>
      <div className="pc-in">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Ask about rates, availability…"
          rows={1}
        />
        <button onClick={send} disabled={!input.trim() || sending} aria-label="Send">↑</button>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
