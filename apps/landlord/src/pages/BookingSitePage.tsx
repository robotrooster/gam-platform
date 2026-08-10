/**
 * Booking Site — the landlord's control panel for a property's public,
 * customer-facing booking website (the {slug}.gam.biz subdomain that guests
 * land on from Google to browse and reserve).
 *
 * S602: pulled out of the Master Schedule "Booking Page" tab into its own
 * discoverable nav item, and extended with personalization content — the host's
 * story (who they are, family-owned, years running) and a local-area / things-
 * to-do guide — alongside the existing slug/publish, welcome text, photos, FAQs,
 * stay rates, deposit/tax, and contact info. Amenities are pulled automatically
 * from the property's amenities (common areas); the landlord doesn't re-enter them.
 *
 * Talks to routes/propertyBookingAdmin.ts. The landlord axios client camelizes
 * responses, so server fields arrive camelCase here.
 */

import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { appConfirm, appPrompt } from '../components/dialogs'

// Mirror the API's STOREFRONT_URL_TEMPLATE: explicit env override wins; else
// localhost → dev path, any real host → prod subdomain.
const STOREFRONT_TEMPLATE = (import.meta as any).env?.VITE_STOREFRONT_URL_TEMPLATE
  || (typeof location !== 'undefined' && /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)
        ? 'http://localhost:3015/{slug}'
        : 'https://{slug}.gam.biz')
const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

/** A site photo thumbnail fetched with the auth token (the file route is authed). */
function AuthThumb({ url, h = 90 }: { url: string; h?: number }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    const token = localStorage.getItem('gam_token') || ''
    fetch(`${API_URL}/api${url}`, { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.ok ? r.blob() : null)
      .then(b => {
        if (!b || cancelled) return
        objectUrl = URL.createObjectURL(b)
        setSrc(objectUrl)
      })
      .catch(() => {})
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url])
  return (
    <div style={{ width: '100%', height: h, borderRadius: 8, background: 'var(--bg-3)', border: '1px solid var(--border-1)', overflow: 'hidden' }}>
      {src && <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
    </div>
  )
}

export function BookingSitePage() {
  const { can } = usePerms()
  const qc = useQueryClient()

  const [propId, setPropId] = useState('')
  const [cfg, setCfg] = useState<any>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'), { staleTime: 30000 })
  useEffect(() => { if (!propId && properties.length) setPropId(properties[0].id) }, [properties])

  // Load the selected property's booking-site config.
  useEffect(() => {
    if (!propId) return
    setMsg(''); setErr('')
    apiGet(`/properties/${propId}/booking-config`)
      // Prefill a blank slug with the server's suggestion (name + city).
      .then((c: any) => setCfg(c?.slug || !c?.suggestedSlug ? c : { ...c, slug: c.suggestedSlug }))
      .catch(() => setCfg(null))
  }, [propId])

  const save = async () => {
    setSaving(true); setMsg(''); setErr('')
    try {
      const num = (v: any) => (v === '' || v == null ? null : Number(v))
      const updated = await apiPatch(`/properties/${propId}/booking-config`, {
        slug: cfg.slug || null,
        enabled: cfg.enabled,
        intro: cfg.intro || null,
        about: cfg.about || null,
        area: cfg.area || null,
        depositPct: Number(cfg.depositPct),
        monthlyDeposit: num(cfg.monthlyDeposit),
        utilitiesBilled: cfg.utilitiesBilled !== false,
        officePhone: cfg.officePhone?.trim() || null,
        officeEmail: cfg.officeEmail?.trim() || null,
        officeHours: cfg.officeHours?.trim() || null,
        nightlyRate: num(cfg.nightlyRate),
        weeklyRate: num(cfg.weeklyRate),
        monthlyRate: num(cfg.monthlyRate),
        shortTermTaxRate: Number(cfg.shortTermTaxRate) || 0,
      })
      setCfg(updated)
      setMsg('Saved.')
    } catch (e: any) {
      setErr(e?.response?.data?.error || e.message || 'Could not save')
    }
    setSaving(false)
  }

  const publicUrl = cfg?.slug ? STOREFRONT_TEMPLATE.replace('{slug}', cfg.slug) : null

  // Photos + FAQs.
  const { data: photos = [] } = useQuery<any[]>(['site-photos', propId], () => apiGet(`/properties/${propId}/site-photos`), { enabled: !!propId })
  const { data: faqs = [] } = useQuery<any[]>(['property-faqs', propId], () => apiGet(`/properties/${propId}/faqs`), { enabled: !!propId })
  const [faqDraft, setFaqDraft] = useState({ question: '', answer: '' })
  const [uploading, setUploading] = useState(false)

  const uploadPhotos = async (files: FileList | null) => {
    if (!files?.length || !propId) return
    setUploading(true); setErr('')
    try {
      const fd = new FormData()
      Array.from(files).forEach(f => fd.append('photos', f))
      await apiPost(`/properties/${propId}/site-photos`, fd)
      qc.invalidateQueries(['site-photos', propId])
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Upload failed')
    }
    setUploading(false)
  }
  const deletePhoto = async (photoId: string) => {
    if (!await appConfirm('Remove this photo from the website?')) return
    await apiDelete(`/properties/${propId}/site-photos/${photoId}`)
    qc.invalidateQueries(['site-photos', propId])
  }
  const captionPhoto = async (photoId: string, current: string | null) => {
    const caption = await appPrompt('Photo caption (blank to clear):', { defaultValue: current || '' })
    if (caption === null) return
    await apiPatch(`/properties/${propId}/site-photos/${photoId}`, { caption: caption || null })
    qc.invalidateQueries(['site-photos', propId])
  }
  const addFaq = async () => {
    if (!faqDraft.question.trim() || !faqDraft.answer.trim()) return
    await apiPost(`/properties/${propId}/faqs`, { question: faqDraft.question.trim(), answer: faqDraft.answer.trim() })
    setFaqDraft({ question: '', answer: '' })
    qc.invalidateQueries(['property-faqs', propId])
  }
  const editFaq = async (f: any) => {
    const question = await appPrompt('Question:', { defaultValue: f.question })
    if (question === null) return
    const answer = await appPrompt('Answer:', { defaultValue: f.answer })
    if (answer === null) return
    if (!question.trim() || !answer.trim()) return
    await apiPatch(`/properties/${propId}/faqs/${f.id}`, { question: question.trim(), answer: answer.trim() })
    qc.invalidateQueries(['property-faqs', propId])
  }
  const deleteFaq = async (faqId: string) => {
    if (!await appConfirm('Delete this FAQ?')) return
    await apiDelete(`/properties/${propId}/faqs/${faqId}`)
    qc.invalidateQueries(['property-faqs', propId])
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 4 }}>Booking Site</h1>
        <div style={{ fontSize: '.85rem', color: 'var(--text-3)' }}>
          Your property's public website — where guests find you online, learn about the place, and book a stay.
          Amenities are pulled from the property's amenities automatically.
        </div>
      </div>

      <div className="card" style={{ padding: 16, maxWidth: 620 }}>
        <label className="form-label">Property</label>
        <select className="input" value={propId} onChange={e => setPropId(e.target.value)} style={{ marginBottom: 16 }}>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        {!cfg ? <div style={{ color: 'var(--text-3)' }}>Loading…</div> : (
          <>
            <label className="form-label">Booking address (slug)</label>
            <input className="input" value={cfg.slug || ''} placeholder="oak-park-yarnell"
              onChange={e => setCfg((c: any) => ({ ...c, slug: e.target.value.toLowerCase() }))} style={{ marginBottom: 4 }} />
            <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 14 }}>
              Lowercase letters, numbers, hyphens. Your site: {publicUrl
                ? <a href={publicUrl} target="_blank" rel="noreferrer">{publicUrl}</a>
                : '— set a slug first'}
            </div>

            <label className="form-label">Welcome text (a short line under your property name)</label>
            <textarea className="input" rows={2} value={cfg.intro || ''}
              onChange={e => setCfg((c: any) => ({ ...c, intro: e.target.value }))} style={{ marginBottom: 14, resize: 'vertical' }} />

            <label className="form-label">Our story (who you are — family-owned, how long you've run the place, what makes it yours)</label>
            <textarea className="input" rows={5} value={cfg.about || ''}
              placeholder={"We're a family-owned park that's welcomed travelers for over 20 years…"}
              onChange={e => setCfg((c: any) => ({ ...c, about: e.target.value }))} style={{ marginBottom: 14, resize: 'vertical' }} />

            <label className="form-label">The area &amp; things to do (nearby attractions, restaurants, trails, what makes the location great)</label>
            <textarea className="input" rows={5} value={cfg.area || ''}
              placeholder={"Ten minutes from downtown, with hiking trails, golf, and great local eats…"}
              onChange={e => setCfg((c: any) => ({ ...c, area: e.target.value }))} style={{ marginBottom: 14, resize: 'vertical' }} />

            <div style={{ borderTop: '1px solid var(--border-1)', margin: '6px 0 14px' }} />
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Stay rates</div>
            <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 10 }}>
              Used for every reservation at this property (Master Schedule + booking site). The rate tier follows
              the length of stay — under 7 nights nightly, 7–29 weekly, 30+ monthly — prorated for odd lengths.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div>
                <label className="form-label">Nightly ($)</label>
                <input className="input" type="number" min={0} value={cfg.nightlyRate ?? ''} placeholder="—"
                  onChange={e => setCfg((c: any) => ({ ...c, nightlyRate: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Weekly ($)</label>
                <input className="input" type="number" min={0} value={cfg.weeklyRate ?? ''} placeholder="—"
                  onChange={e => setCfg((c: any) => ({ ...c, weeklyRate: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Monthly ($)</label>
                <input className="input" type="number" min={0} value={cfg.monthlyRate ?? ''} placeholder="—"
                  onChange={e => setCfg((c: any) => ({ ...c, monthlyRate: e.target.value }))} />
              </div>
            </div>

            <label className="form-label">Short-term lodging tax (% — applied to stays under 30 nights; 30+ is tax-exempt)</label>
            <input className="input" type="number" min={0} max={100} value={cfg.shortTermTaxRate ?? 0}
              onChange={e => setCfg((c: any) => ({ ...c, shortTermTaxRate: e.target.value }))} style={{ marginBottom: 16, maxWidth: 140 }} />

            <div style={{ borderTop: '1px solid var(--border-1)', margin: '6px 0 14px' }} />
            <label className="form-label">Deposit for short stays (% of stay total — stays under 30 nights)</label>
            <input className="input" type="number" min={0} max={100} value={cfg.depositPct}
              onChange={e => setCfg((c: any) => ({ ...c, depositPct: e.target.value }))} style={{ marginBottom: 14, maxWidth: 140 }} />

            <label className="form-label">Deposit for monthly stays ($ flat — 30+ nights)</label>
            <input className="input" type="number" min={0} value={cfg.monthlyDeposit ?? ''} placeholder="150"
              onChange={e => setCfg((c: any) => ({ ...c, monthlyDeposit: e.target.value }))} style={{ marginBottom: 4, maxWidth: 140 }} />
            <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 16 }}>
              Blank = $150 default. Always capped at one month's rent — long-term guests never owe more than a month up front.
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
              <input type="checkbox" checked={cfg.utilitiesBilled !== false} onChange={e => setCfg((c: any) => ({ ...c, utilitiesBilled: e.target.checked }))} />
              <span>Utilities billed back on monthly stays (quote shows "plus utilities")</span>
            </label>

            <div style={{ borderTop: '1px solid var(--border-1)', margin: '6px 0 14px' }} />
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Contact page</div>
            <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 10 }}>
              Shown on the website's Contact page with the property address and the message form.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div>
                <label className="form-label">Office phone</label>
                <input className="input" value={cfg.officePhone ?? ''} placeholder="(555) 555-0100"
                  onChange={e => setCfg((c: any) => ({ ...c, officePhone: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Office email</label>
                <input className="input" type="email" value={cfg.officeEmail ?? ''} placeholder="office@yourpark.com"
                  onChange={e => setCfg((c: any) => ({ ...c, officeEmail: e.target.value }))} />
              </div>
            </div>
            <label className="form-label">Office hours</label>
            <textarea className="input" rows={3} value={cfg.officeHours ?? ''}
              placeholder={'Mon–Fri 9am–5pm\nSat 10am–2pm\nClosed Sunday'}
              onChange={e => setCfg((c: any) => ({ ...c, officeHours: e.target.value }))} style={{ marginBottom: 16, resize: 'vertical' }} />

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!cfg.enabled} onChange={e => setCfg((c: any) => ({ ...c, enabled: e.target.checked }))} />
              <span><b>Publish</b> this booking site (live to the public)</span>
            </label>

            {can('booking_sites.edit') && <button className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>}
            {msg && <span style={{ color: 'var(--green)', marginLeft: 12 }}>{msg}</span>}
            {err && <span style={{ color: 'var(--red,#ff6b81)', marginLeft: 12 }}>{err}</span>}
          </>
        )}
      </div>

      {/* Website photos */}
      {cfg && (
        <div className="card" style={{ padding: 16, maxWidth: 620, marginTop: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Website photos</div>
          <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 12 }}>
            Shown in the Gallery and on the home page of this property's website. JPEG/PNG/WebP, up to 10 MB each.
          </div>
          {can('booking_sites.edit') && (
            <label className="btn" style={{ display: 'inline-block', marginBottom: 12, cursor: 'pointer' }}>
              {uploading ? 'Uploading…' : 'Add photos'}
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden
                disabled={uploading}
                onChange={e => { uploadPhotos(e.target.files); e.target.value = '' }} />
            </label>
          )}
          {photos.length === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>No photos yet.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {photos.map((ph: any) => (
                <div key={ph.id}>
                  <AuthThumb url={`/properties/${propId}/site-photos/${ph.id}/file`} />
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '4px 0', minHeight: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ph.caption || '—'}</div>
                  {can('booking_sites.edit') && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => captionPhoto(ph.id, ph.caption)}>Caption</button>
                      <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => deletePhoto(ph.id)}>Remove</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Website FAQs */}
      {cfg && (
        <div className="card" style={{ padding: 16, maxWidth: 620, marginTop: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Website FAQ</div>
          <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 12 }}>
            Questions guests ask before booking — office hours, pets, rig limits, cancellation policy.
          </div>
          {faqs.map((f: any) => (
            <div key={f.id} style={{ borderTop: '1px solid var(--border-1)', padding: '10px 0' }}>
              <div style={{ fontWeight: 600, fontSize: '.88rem' }}>{f.question}</div>
              <div style={{ color: 'var(--text-3)', fontSize: '.84rem', whiteSpace: 'pre-wrap', margin: '4px 0 6px' }}>{f.answer}</div>
              {can('booking_sites.edit') && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => editFaq(f)}>Edit</button>
                  <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => deleteFaq(f.id)}>Delete</button>
                </div>
              )}
            </div>
          ))}
          {faqs.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: '.85rem', marginBottom: 10 }}>No FAQs yet.</div>}
          {can('booking_sites.edit') && (
            <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 12, marginTop: 6 }}>
              <label className="form-label">Question</label>
              <input className="input" value={faqDraft.question}
                onChange={e => setFaqDraft(d => ({ ...d, question: e.target.value }))} style={{ marginBottom: 8 }} />
              <label className="form-label">Answer</label>
              <textarea className="input" rows={3} value={faqDraft.answer}
                onChange={e => setFaqDraft(d => ({ ...d, answer: e.target.value }))} style={{ marginBottom: 10, resize: 'vertical' }} />
              <button className="btn" disabled={!faqDraft.question.trim() || !faqDraft.answer.trim()} onClick={addFaq}>Add FAQ</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
