import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'

const API = 'http://localhost:4000'

const css = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg0:#f8f7f4;--bg1:#ffffff;--bg2:#f3f2ef;--bg3:#e8e6e1;
  --b0:#e0ddd6;--b1:#d4d0c8;
  --t0:#1a1814;--t1:#3d3a32;--t2:#6b6760;--t3:#9c9890;
  --gold:#b8860b;--green:#2d6a4f;--red:#c1121f;--blue:#1d4e89;
  --font-d:'Syne',sans-serif;--font-b:'DM Sans',sans-serif;--font-m:'DM Mono',monospace
}
html{-webkit-font-smoothing:antialiased}
body{font-family:var(--font-b);background:var(--bg0);color:var(--t1);line-height:1.6;min-height:100vh}
h1,h2,h3{font-family:var(--font-d);color:var(--t0)}
button{cursor:pointer;font-family:var(--font-b)}
input,select,textarea{font-family:var(--font-b)}
a{color:var(--gold);text-decoration:none}

.header{background:var(--bg1);border-bottom:1px solid var(--b0);padding:0 40px;height:64px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50}
.logo{font-family:var(--font-d);font-size:1.2rem;font-weight:800;color:var(--t0)}
.logo span{color:var(--gold)}
.hero{background:var(--t0);color:#fff;padding:64px 40px;text-align:center}
.hero h1{font-size:2.8rem;font-weight:800;color:#fff;margin-bottom:12px}
.hero p{color:rgba(255,255,255,.7);font-size:1rem;max-width:480px;margin:0 auto 28px}
.search-bar{display:flex;gap:8px;max-width:560px;margin:0 auto;flex-wrap:wrap;justify-content:center}
.search-bar input,.search-bar select{padding:10px 16px;border-radius:8px;border:none;font-size:.875rem;min-width:160px;flex:1}
.search-bar button{background:var(--gold);color:#fff;border:none;border-radius:8px;padding:10px 24px;font-weight:600;font-size:.875rem}
.main{max-width:1280px;margin:0 auto;padding:40px 24px}
.results-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.results-header h2{font-size:1.1rem;font-weight:700;color:var(--t0)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:24px}
.card{background:var(--bg1);border:1px solid var(--b0);border-radius:12px;overflow:hidden;transition:box-shadow .15s,transform .15s;cursor:pointer}
.card:hover{box-shadow:0 8px 32px rgba(0,0,0,.1);transform:translateY(-2px)}
.card-photos{position:relative;height:220px;background:var(--bg3);overflow:hidden}
.card-photos img{width:100%;height:100%;object-fit:cover}
.card-photos-count{position:absolute;bottom:10px;right:10px;background:rgba(0,0,0,.6);color:#fff;font-size:.7rem;padding:3px 8px;border-radius:12px;font-family:var(--font-m)}
.card-body{padding:18px}
.card-price{font-family:var(--font-d);font-size:1.5rem;font-weight:800;color:var(--t0);margin-bottom:4px}
.card-price span{font-size:.8rem;font-weight:400;color:var(--t2);font-family:var(--font-b)}
.card-address{font-size:.82rem;color:var(--t2);margin-bottom:10px}
.card-specs{display:flex;gap:16px;font-size:.78rem;color:var(--t2);margin-bottom:14px}
.card-specs strong{color:var(--t0)}
.card-available{font-size:.72rem;color:var(--green);font-weight:600;margin-bottom:12px}
.btn-apply{width:100%;background:var(--t0);color:#fff;border:none;border-radius:8px;padding:10px;font-weight:600;font-size:.82rem;transition:background .12s}
.btn-apply:hover{background:#2d2a22}

/* MODAL */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow-y:auto}
.modal{background:var(--bg1);border-radius:16px;width:100%;max-width:860px;overflow:hidden;margin:auto}
.modal-photos{display:grid;grid-template-columns:2fr 1fr;gap:3px;height:400px;background:var(--bg3)}
.modal-photos img{width:100%;height:100%;object-fit:cover}
.modal-photos-grid{display:grid;grid-template-rows:1fr 1fr;gap:3px}
.modal-body{padding:28px}
.modal-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
.modal-price{font-family:var(--font-d);font-size:2rem;font-weight:800;color:var(--t0)}
.modal-close{background:var(--bg2);border:none;border-radius:50%;width:36px;height:36px;font-size:1.1rem;color:var(--t2);cursor:pointer;flex-shrink:0}
.modal-specs{display:flex;gap:24px;margin-bottom:16px;flex-wrap:wrap}
.modal-spec{display:flex;flex-direction:column}
.modal-spec-val{font-family:var(--font-d);font-size:1.1rem;font-weight:700;color:var(--t0)}
.modal-spec-lbl{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.08em}
.modal-desc{font-size:.875rem;color:var(--t2);line-height:1.7;margin-bottom:20px;padding:14px;background:var(--bg2);border-radius:8px}
.modal-footer{display:flex;gap:12px}
.btn-primary{flex:1;background:var(--t0);color:#fff;border:none;border-radius:8px;padding:12px;font-weight:700;font-size:.9rem}
.btn-primary:hover{background:#2d2a22}
.btn-secondary{background:var(--bg2);color:var(--t1);border:1px solid var(--b1);border-radius:8px;padding:12px 20px;font-weight:600;font-size:.875rem}

/* APPLICATION FORM */
.app-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}
.app-modal{background:var(--bg1);border-radius:16px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;padding:32px}
.app-modal h2{font-size:1.3rem;font-weight:800;color:var(--t0);margin-bottom:4px}
.app-modal p{font-size:.82rem;color:var(--t2);margin-bottom:24px}
.frow{margin-bottom:14px}
.frow2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
label{display:block;font-size:.72rem;font-weight:600;color:var(--t2);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em}
input,select,textarea{width:100%;background:var(--bg2);border:1px solid var(--b1);border-radius:8px;color:var(--t0);padding:9px 12px;font-size:.875rem;outline:none;transition:border .12s}
input:focus,select:focus,textarea:focus{border-color:var(--gold)}
.factions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px;padding-top:16px;border-top:1px solid var(--b0)}
.alert{padding:12px 16px;border-radius:8px;font-size:.82rem;margin-bottom:14px}
.alert-success{background:#d8f3dc;color:#1b4332;border:1px solid #b7e4c7}
.alert-error{background:#ffe0e0;color:#c1121f;border:1px solid #ffb3b3}
.empty{text-align:center;padding:80px 20px;color:var(--t2)}
.empty h3{font-size:1.2rem;margin-bottom:8px;color:var(--t0)}
.spinner{display:inline-block;width:20px;height:20px;border:2px solid var(--b1);border-top-color:var(--gold);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.loading{display:flex;align-items:center;justify-content:center;padding:80px;gap:12px;color:var(--t2)}
`

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function App() {
  const [listings, setListings] = useState<any[]>([])
  const [filtered, setFiltered] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<any>(null)
  const [applying, setApplying] = useState<any>(null) // unit or null for general
  const [search, setSearch] = useState({ city: '', maxRent: '', beds: '' })
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', password: '', confirmPassword: '' })

  useEffect(() => {
    axios.get(`${API}/api/public/properties/listings`)
      .then(r => { setListings(r.data.data); setFiltered(r.data.data) })
      .catch(() => setError('Could not load listings'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let f = listings
    if (search.city) f = f.filter(l => l.city?.toLowerCase().includes(search.city.toLowerCase()) || l.property_name?.toLowerCase().includes(search.city.toLowerCase()))
    if (search.maxRent) f = f.filter(l => +l.rent_amount <= +search.maxRent)
    if (search.beds) f = f.filter(l => +l.bedrooms >= +search.beds)
    setFiltered(f)
  }, [search, listings])

  const submitApp = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true); setError('')
    try {
      const res = await axios.post(`${API}/api/auth/register-prospect`, {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        password: form.password,
        phone: form.phone || null,
        unitId: applying?.general ? null : applying?.id || null,
        landlordId: applying?.landlord_id || null,
      })
      const { token } = res.data.data
      // Store token and redirect to tenant portal background check
      localStorage.setItem('gam_prospect_token', token)
      window.location.href = `http://localhost:3002/accept-invite?token=${token}&unit=${applying?.id || ''}`
    } catch (ex: any) {
      setError(ex.response?.data?.error || 'Submission failed. Please try again.')
    } finally { setSubmitting(false) }
  }

  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }))

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <header className="header">
        <div className="logo">GAM <span>Rentals</span></div>
        <div style={{ fontSize: '.8rem', color: 'var(--t2)' }}>GAM Platform · Available Rentals</div>
      </header>

      <div className="hero">
        <h1>Find Your Next Home</h1>
        <p>Browse available rentals across properties on the GAM platform.</p>
        <div className="search-bar">
          <input placeholder="City or property name" value={search.city} onChange={e => setSearch(s => ({ ...s, city: e.target.value }))} />
          <select value={search.beds} onChange={e => setSearch(s => ({ ...s, beds: e.target.value }))}>
            <option value="">Any beds</option>
            <option value="1">1+ beds</option>
            <option value="2">2+ beds</option>
            <option value="3">3+ beds</option>
          </select>
          <input type="number" placeholder="Max rent" value={search.maxRent} onChange={e => setSearch(s => ({ ...s, maxRent: e.target.value }))} />
        </div>
      </div>

      <div className="main">
        <div className="results-header">
          <h2>{filtered.length} {filtered.length === 1 ? 'property' : 'properties'} available</h2>
          <button className="btn-secondary" onClick={() => { window.location.href = 'http://localhost:3002/background-check' }} style={{ fontSize: '.78rem', padding: '8px 16px' }}>
            📋 General Application
          </button>
        </div>

        {loading && <div className="loading"><span className="spinner" /> Loading listings…</div>}
        {!loading && filtered.length === 0 && (
          <div className="empty">
            <h3>No listings found</h3>
            <p>Try adjusting your search filters or check back soon.</p>
          </div>
        )}

        <div className="grid">
          {filtered.map((l: any) => (
            <div key={l.id} className="card" onClick={() => setSelected(l)}>
              <div className="card-photos">
                {l.photos?.[0]
                  ? <img src={`${API}${l.photos[0]}`} alt={l.unit_number} />
                  : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--t3)', fontSize: '.82rem' }}>No photo</div>
                }
                {l.photo_count > 1 && <div className="card-photos-count">+{l.photo_count - 1} photos</div>}
              </div>
              <div className="card-body">
                <div className="card-price">{formatCurrency(+l.rent_amount)}<span>/mo</span></div>
                <div className="card-address">{l.property_name} · Unit {l.unit_number}<br />{l.street1}, {l.city}, {l.state} {l.zip}</div>
                <div className="card-specs">
                  <span><strong>{l.bedrooms}</strong> bed</span>
                  <span><strong>{l.bathrooms}</strong> bath</span>
                  {l.sqft && <span><strong>{l.sqft?.toLocaleString()}</strong> sqft</span>}
                </div>
                {l.available_date && <div className="card-available">Available {new Date(l.available_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>}
                <button className="btn-apply" onClick={e => { e.stopPropagation(); window.location.href = `http://localhost:3002/background-check?unitId=${l.id}&landlordId=${l.landlord_id}` }}>Apply Now</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* UNIT DETAIL MODAL */}
      {selected && (
        <div className="overlay" onClick={e => { if (e.target === e.currentTarget) setSelected(null) }}>
          <div className="modal">
            {selected.photos?.length > 0 && (
              <div className="modal-photos">
                <img src={`${API}${selected.photos[0]}`} alt="main" />
                {selected.photos.length > 1 && (
                  <div className="modal-photos-grid">
                    {selected.photos.slice(1, 3).map((p: string, i: number) => (
                      <img key={i} src={`${API}${p}`} alt={`photo ${i + 2}`} />
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="modal-body">
              <div className="modal-header">
                <div>
                  <div className="modal-price">{formatCurrency(+selected.rent_amount)}<span style={{ fontSize: '.9rem', fontWeight: 400, color: 'var(--t2)', fontFamily: 'var(--font-b)' }}>/mo</span></div>
                  <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginTop: 4 }}>{selected.property_name} · Unit {selected.unit_number} · {selected.street1}, {selected.city}, {selected.state} {selected.zip}</div>
                </div>
                <button className="modal-close" onClick={() => setSelected(null)}>✕</button>
              </div>
              <div className="modal-specs">
                <div className="modal-spec"><span className="modal-spec-val">{selected.bedrooms}</span><span className="modal-spec-lbl">Bedrooms</span></div>
                <div className="modal-spec"><span className="modal-spec-val">{selected.bathrooms}</span><span className="modal-spec-lbl">Bathrooms</span></div>
                {selected.sqft && <div className="modal-spec"><span className="modal-spec-val">{selected.sqft?.toLocaleString()}</span><span className="modal-spec-lbl">Sq Ft</span></div>}
                <div className="modal-spec"><span className="modal-spec-val">{formatCurrency(+selected.security_deposit || 0)}</span><span className="modal-spec-lbl">Deposit</span></div>
                {selected.available_date && <div className="modal-spec"><span className="modal-spec-val">{new Date(selected.available_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span><span className="modal-spec-lbl">Available</span></div>}
              </div>
              {selected.listing_description && <div className="modal-desc">{selected.listing_description}</div>}
              <div className="modal-footer">
                <button className="btn-primary" onClick={() => { window.location.href = `http://localhost:3002/background-check?unitId=${selected.id}&landlordId=${selected.landlord_id}` }}>Apply for This Unit</button>
                <button className="btn-secondary" onClick={() => setSelected(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* APPLICATION MODAL */}
      {applying && (
        <div className="app-overlay" onClick={e => { if (e.target === e.currentTarget) { setApplying(null); setSubmitted(false); setForm({ firstName: '', lastName: '', email: '', phone: '', password: '', confirmPassword: '' }) } }}>
          <div className="app-modal">
            <h2>{applying.general ? 'General Rental Application' : `Apply — Unit ${applying.unit_number}`}</h2>
            <p>{applying.general ? 'No specific unit in mind? Submit a general application and a landlord will reach out.' : `${applying.property_name} · ${applying.street1}, ${applying.city} · ${formatCurrency(+applying.rent_amount)}/mo`}</p>

            {submitted ? (
              <div>
                <div className="alert alert-success">✅ Application submitted! A landlord will reach out to you within 1-2 business days.</div>
                <button className="btn-primary" style={{ width: '100%' }} onClick={() => { setApplying(null); setSubmitted(false) }}>Done</button>
              </div>
            ) : (
              <form onSubmit={submitApp}>
                {error && <div className="alert alert-error">{error}</div>}
                <div style={{padding:'10px 14px',background:'#f0f7ff',border:'1px solid #bdd7f5',borderRadius:8,fontSize:'.78rem',color:'#1d4e89',marginBottom:14}}>
                  Create your account to start the background check process. You'll be redirected to complete your application.
                </div>
                <div className="frow2">
                  <div><label>First Name</label><input value={form.firstName} onChange={f('firstName')} required /></div>
                  <div><label>Last Name</label><input value={form.lastName} onChange={f('lastName')} required /></div>
                </div>
                <div className="frow"><label>Email</label><input type="email" value={form.email} onChange={f('email')} required /></div>
                <div className="frow"><label>Phone (optional)</label><input type="tel" value={form.phone} onChange={f('phone')} /></div>
                <div className="frow2">
                  <div><label>Password</label><input type="password" value={form.password} onChange={f('password')} required minLength={8} /></div>
                  <div><label>Confirm Password</label><input type="password" value={form.confirmPassword} onChange={f('confirmPassword')} required /></div>
                </div>
                {form.password && form.confirmPassword && form.password !== form.confirmPassword && (
                  <div style={{fontSize:'.75rem',color:'var(--red)',marginBottom:8}}>Passwords do not match</div>
                )}
                <div className="factions">
                  <button type="button" className="btn-secondary" onClick={() => { setApplying(null); setSubmitted(false) }}>Cancel</button>
                  <button type="submit" className="btn-primary" disabled={submitting||!form.password||form.password!==form.confirmPassword} style={{ padding: '10px 28px' }}>{submitting ? 'Creating account…' : 'Create Account & Apply →'}</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
