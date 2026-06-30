import { useEffect, useState } from 'react'
import { useQuery } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'

const CUSTOMER_URL = (import.meta as any).env?.VITE_CUSTOMER_PORTAL_URL || 'http://localhost:3014'

export function BookingSitesPage() {
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const [propId, setPropId] = useState('')
  const [cfg, setCfg] = useState<any>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { if (!propId && properties.length) setPropId(properties[0].id) }, [properties])
  useEffect(() => {
    if (!propId) return
    setMsg(''); setErr('')
    apiGet(`/properties/${propId}/booking-config`).then(setCfg).catch(() => setCfg(null))
  }, [propId])

  const save = async () => {
    setSaving(true); setMsg(''); setErr('')
    try {
      const num = (v: any) => (v === '' || v == null ? null : Number(v))
      const updated = await apiPatch(`/properties/${propId}/booking-config`, {
        slug: cfg.slug || null,
        enabled: cfg.enabled,
        intro: cfg.intro || null,
        depositPct: Number(cfg.depositPct),
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

  const publicUrl = cfg?.slug ? `${CUSTOMER_URL}/property/${cfg.slug}` : null

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Booking Sites</h1><p className="page-subtitle">Public per-property booking pages — guests book short stays and pay a deposit</p></div>
      </div>

      <div className="card" style={{ padding: 16, maxWidth: 560 }}>
        <label className="form-label">Property</label>
        <select className="input" value={propId} onChange={e => setPropId(e.target.value)} style={{ marginBottom: 16 }}>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        {!cfg ? <div style={{ color: 'var(--text-3)' }}>Loading…</div> : (
          <>
            <label className="form-label">Booking address (slug)</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <input className="input" value={cfg.slug || ''} placeholder="sunny-rv-park"
                onChange={e => setCfg((c: any) => ({ ...c, slug: e.target.value.toLowerCase() }))} style={{ flex: 1 }} />
            </div>
            <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 14 }}>
              Lowercase letters, numbers, hyphens. Your site: {publicUrl
                ? <a href={publicUrl} target="_blank" rel="noreferrer">{publicUrl}</a>
                : '— set a slug first'}
            </div>

            <label className="form-label">Welcome text (optional)</label>
            <textarea className="input" rows={3} value={cfg.intro || ''}
              onChange={e => setCfg((c: any) => ({ ...c, intro: e.target.value }))} style={{ marginBottom: 14, resize: 'vertical' }} />

            <div style={{ borderTop: '1px solid var(--border-1)', margin: '6px 0 14px' }} />
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Stay rates</div>
            <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 10 }}>
              Used for every reservation at this property (Master Schedule + booking site). The rate tier
              follows the length of stay — under 7 nights nightly, 7–29 weekly, 30+ monthly — prorated for
              odd lengths.
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
            <label className="form-label">Deposit at booking (% of stay total)</label>
            <input className="input" type="number" min={0} max={100} value={cfg.depositPct}
              onChange={e => setCfg((c: any) => ({ ...c, depositPct: e.target.value }))} style={{ marginBottom: 16, maxWidth: 140 }} />

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!cfg.enabled} onChange={e => setCfg((c: any) => ({ ...c, enabled: e.target.checked }))} />
              <span><b>Publish</b> this booking site (live to the public)</span>
            </label>

            <button className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
            {msg && <span style={{ color: 'var(--green)', marginLeft: 12 }}>{msg}</span>}
            {err && <span style={{ color: 'var(--red,#ff6b81)', marginLeft: 12 }}>{err}</span>}
          </>
        )}
      </div>
    </div>
  )
}
