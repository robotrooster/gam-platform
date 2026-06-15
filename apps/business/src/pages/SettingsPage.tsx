import { useEffect, useState } from 'react'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import {
  BUSINESS_TYPES, BUSINESS_TYPE_LABEL, BusinessType,
  BUSINESS_FEATURES, BUSINESS_FEATURE_LABEL, BUSINESS_FEATURE_DESCRIPTION,
  BUSINESS_FEATURE_ALWAYS_ON, BusinessFeature,
} from '@gam/shared'
import { loadConnectAndInitialize } from '@stripe/connect-js'
import type { StripeConnectInstance } from '@stripe/connect-js'
import {
  ConnectAccountOnboarding, ConnectComponentsProvider,
} from '@stripe/react-connect-js'

export function SettingsPage() {
  const [biz, setBiz] = useState<any>(null)
  const [form, setForm] = useState({
    businessName: '', businessType: 'trash_hauling' as BusinessType,
    email: '', phone: '',
    street1: '', street2: '', city: '', state: '', zip: '', ein: '',
  })
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const b = await apiGet<any>('/businesses/me')
        setBiz(b)
        setForm({
          businessName: b.name ?? '',
          businessType: b.businessType ?? 'trash_hauling',
          email: b.email ?? '',
          phone: b.phone ?? '',
          street1: b.street1 ?? '', street2: b.street2 ?? '',
          city: b.city ?? '', state: b.state ?? '', zip: b.zip ?? '',
          ein: b.ein ?? '',
        })
      } catch (e: any) {
        setErr(e?.response?.data?.error || 'Failed to load settings')
      }
    })()
  }, [])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setOk(false); setSaving(true)
    try {
      const updated = await apiPatch<any>('/businesses/me', form)
      setBiz(updated)
      setOk(true)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginTop: 0 }}>
        Settings
      </h1>
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 24 }}>
        Business profile + tax info. Stripe Connect onboarding lands later.
      </div>

      {err && <div style={errStyle}>{err}</div>}
      {ok &&  <div style={okStyle}>Saved.</div>}

      <form onSubmit={onSubmit} style={{
        maxWidth: 640,
        padding: 24, background: 'var(--bg-1)',
        border: '1px solid var(--border-0)', borderRadius: 12,
      }}>
        <label style={labelStyle}>Business name</label>
        <input value={form.businessName}
          onChange={e => setForm({ ...form, businessName: e.target.value })}
          style={inputStyle} />

        <label style={labelStyle}>Business type</label>
        <select value={form.businessType}
          onChange={e => setForm({ ...form, businessType: e.target.value as BusinessType })}
          style={inputStyle}>
          {BUSINESS_TYPES.map(t => (
            <option key={t} value={t}>{BUSINESS_TYPE_LABEL[t]}</option>
          ))}
        </select>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={labelStyle}>Email</label>
            <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
              type="email" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Phone</label>
            <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })}
              style={inputStyle} />
          </div>
        </div>

        <label style={labelStyle}>Address line 1</label>
        <input value={form.street1} onChange={e => setForm({ ...form, street1: e.target.value })}
          style={inputStyle} />

        <label style={labelStyle}>Address line 2</label>
        <input value={form.street2} onChange={e => setForm({ ...form, street2: e.target.value })}
          style={inputStyle} />

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <div>
            <label style={labelStyle}>City</label>
            <input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })}
              style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>State</label>
            <input value={form.state} onChange={e => setForm({ ...form, state: e.target.value })}
              style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>ZIP</label>
            <input value={form.zip} onChange={e => setForm({ ...form, zip: e.target.value })}
              style={inputStyle} />
          </div>
        </div>

        <label style={labelStyle}>EIN (tax ID)</label>
        <input value={form.ein} onChange={e => setForm({ ...form, ein: e.target.value })}
          style={inputStyle} />

        <button type="submit" disabled={saving}
          style={{ ...btnStyle, opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      {biz && (
        <div style={{
          marginTop: 24, padding: 16,
          background: 'var(--bg-1)', border: '1px solid var(--border-0)',
          borderRadius: 12, fontSize: 13, color: 'var(--text-2)',
        }}>
          Business id: <code style={{ color: 'var(--text-1)' }}>{biz.id}</code>
          {' · '}
          Status: <span style={{ color: 'var(--text-1)' }}>{biz.status}</span>
        </div>
      )}

      {biz && <StripeConnectSection biz={biz} />}
      {biz && <TaxSection biz={biz} setBiz={setBiz} />}
      {biz && <PublicBookingSection biz={biz} setBiz={setBiz} />}
      {biz && <FeaturesSection biz={biz} setBiz={setBiz} />}
    </div>
  )
}

// S507: public booking config. Owner toggles enabled, sets slug, intro,
// per-day business hours. Slug becomes the URL on the marketing site.
const DEFAULT_BUSINESS_HOURS = {
  '0': null,
  '1': { open: '09:00', close: '17:00' },
  '2': { open: '09:00', close: '17:00' },
  '3': { open: '09:00', close: '17:00' },
  '4': { open: '09:00', close: '17:00' },
  '5': { open: '09:00', close: '17:00' },
  '6': null,
} as Record<string, { open: string; close: string } | null>

const DOW_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function PublicBookingSection({ biz, setBiz }: { biz: any; setBiz: (b: any) => void }) {
  const [enabled, setEnabled] = useState(!!biz.publicBookingEnabled)
  const [slug, setSlug] = useState(biz.publicBookingSlug ?? '')
  const [intro, setIntro] = useState(biz.publicBookingIntro ?? '')
  const [hours, setHours] = useState<Record<string, { open: string; close: string } | null>>(
    biz.businessHours && Object.keys(biz.businessHours).length > 0
      ? biz.businessHours
      : DEFAULT_BUSINESS_HOURS)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  const marketingBase = (import.meta as any).env?.VITE_MARKETING_URL || 'http://localhost:3004'
  const publicUrl = slug ? `${marketingBase}/book/${slug}` : null

  const toggleDay = (dow: string) => {
    setHours(p => ({
      ...p,
      [dow]: p[dow] ? null : { open: '09:00', close: '17:00' },
    }))
  }
  const setDayTime = (dow: string, field: 'open' | 'close', value: string) => {
    setHours(p => ({
      ...p,
      [dow]: p[dow] ? { ...(p[dow] as { open: string; close: string }), [field]: value } : null,
    }))
  }

  const onSave = async () => {
    setErr(null); setOk(false); setSaving(true)
    try {
      const body: any = {
        publicBookingEnabled: enabled,
        publicBookingIntro: intro.trim() || null,
        businessHours: hours,
      }
      // Slug is required when enabling; allow clearing only when disabled.
      if (slug.trim()) body.publicBookingSlug = slug.trim().toLowerCase()
      else if (!enabled) body.publicBookingSlug = null
      const updated = await apiPatch<any>('/businesses/me', body)
      setBiz(updated)
      setOk(true)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div style={{
      marginTop: 24, padding: 24,
      background: 'var(--bg-1)', border: '1px solid var(--border-0)',
      borderRadius: 12, maxWidth: 640,
    }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginTop: 0 }}>
        Public booking page
      </h2>
      <div style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 16 }}>
        Let customers book appointments themselves from a public URL. No account required on their end.
      </div>

      {err && <div style={errStyle}>{err}</div>}
      {ok && <div style={okStyle}>Saved.</div>}

      <label style={{
        display: 'flex' as const, alignItems: 'center', gap: 10,
        padding: 12, marginBottom: 12,
        background: enabled ? 'rgba(34,197,94,.08)' : 'var(--bg-2)',
        border: `1px solid ${enabled ? 'rgba(34,197,94,.4)' : 'var(--border-1)'}`,
        borderRadius: 8, cursor: 'pointer',
      }}>
        <input type="checkbox" checked={enabled}
          onChange={e => setEnabled(e.target.checked)} />
        <span style={{ fontSize: 14, color: 'var(--text-1)' }}>
          Public booking is {enabled ? 'enabled' : 'off'}
        </span>
        {enabled && publicUrl && (
          <a href={publicUrl} target="_blank" rel="noreferrer" style={{
            marginLeft: 'auto', fontSize: 12, color: 'var(--gold)',
            textDecoration: 'none' as const,
          }}>
            Visit page →
          </a>
        )}
      </label>

      <label style={labelStyle}>URL slug (a-z, 0-9, dashes)</label>
      <input value={slug}
        onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        placeholder="my-shop"
        style={{ ...inputStyle, fontFamily: 'var(--font-mono)' as const }} />
      {slug && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
          Booking page will live at: <span style={{ color: 'var(--gold)' }}>{marketingBase}/book/{slug}</span>
        </div>
      )}

      <label style={labelStyle}>Intro message (optional)</label>
      <textarea value={intro}
        onChange={e => setIntro(e.target.value)}
        rows={2}
        placeholder="Welcome! Pick a service and a time that works for you."
        style={{ ...inputStyle, fontFamily: 'var(--font-body)' as const, resize: 'vertical' as const }} />

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
          Hours customers can book
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
          {Object.keys(DOW_LABEL).map(dow => {
            const day = hours[dow]
            return (
              <div key={dow} style={{
                display: 'flex' as const, alignItems: 'center', gap: 8,
                padding: '6px 10px',
                background: 'var(--bg-2)', borderRadius: 6,
              }}>
                <label style={{ display: 'flex' as const, alignItems: 'center', gap: 6, minWidth: 110, fontSize: 13, color: 'var(--text-1)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!day}
                    onChange={() => toggleDay(dow)} />
                  {DOW_LABEL[Number(dow)]}
                </label>
                {day ? (
                  <>
                    <input type="time" value={day.open}
                      onChange={e => setDayTime(dow, 'open', e.target.value)}
                      style={{ ...inputStyle, marginTop: 0, width: 110 }} />
                    <span style={{ color: 'var(--text-3)', fontSize: 12 }}>to</span>
                    <input type="time" value={day.close}
                      onChange={e => setDayTime(dow, 'close', e.target.value)}
                      style={{ ...inputStyle, marginTop: 0, width: 110 }} />
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Closed</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <button onClick={onSave} disabled={saving}
        style={{ ...btnStyle, marginTop: 16, opacity: saving ? 0.6 : 1 }}>
        {saving ? 'Saving…' : 'Save booking settings'}
      </button>
    </div>
  )
}

// S506: tax rate + label config. Rate displays as percentage (8.75%)
// but stores in DB as decimal (0.0875). Customer-level tax_exempt
// overrides on individual records.
function TaxSection({ biz, setBiz }: { biz: any; setBiz: (b: any) => void }) {
  const [ratePct, setRatePct] = useState(
    biz.defaultTaxRate !== undefined
      ? (Number(biz.defaultTaxRate) * 100).toFixed(4).replace(/\.?0+$/, '') || '0'
      : '0')
  const [label, setLabel] = useState(biz.taxLabel || 'Sales Tax')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  const onSave = async () => {
    setErr(null); setOk(false); setSaving(true)
    try {
      const updated = await apiPatch<any>('/businesses/me', {
        defaultTaxRate: (Number(ratePct) || 0) / 100,
        taxLabel: label.trim() || 'Sales Tax',
      })
      setBiz(updated)
      setOk(true)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div style={{
      marginTop: 24, padding: 24,
      background: 'var(--bg-1)', border: '1px solid var(--border-0)',
      borderRadius: 12, maxWidth: 640,
    }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginTop: 0 }}>
        Sales tax
      </h2>
      <div style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 16 }}>
        Default rate applied to new invoices, quotes, and POS sales. Per-customer exemption (resale, nonprofit) overrides this to zero. Per-line override on each invoice or quote line still wins.
      </div>

      {err && <div style={errStyle}>{err}</div>}
      {ok && <div style={okStyle}>Saved.</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Default rate (%)</label>
          <input value={ratePct}
            onChange={e => setRatePct(e.target.value)}
            type="number" step="0.001" min="0" max="99.99"
            placeholder="8.75"
            style={inputStyle} />
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
            Set to 0 to disable auto-tax.
          </div>
        </div>
        <div>
          <label style={labelStyle}>Label (shown on receipts + invoices)</label>
          <input value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Sales Tax"
            style={inputStyle} />
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
            "Sales Tax" / "HST" / "VAT" / "GST"
          </div>
        </div>
      </div>

      <button onClick={onSave} disabled={saving}
        style={{ ...btnStyle, marginTop: 16, opacity: saving ? 0.6 : 1 }}>
        {saving ? 'Saving…' : 'Save tax settings'}
      </button>
    </div>
  )
}

// S494: Stripe Connect onboarding for business operators. Mirrors the
// landlord-portal BankingPage pattern. Owner clicks "Set up payments"
// → embedded ConnectAccountOnboarding fetches a fresh session client
// secret on demand → Stripe renders the KYC flow inline. On exit,
// status query polls until details_submitted + payouts_enabled flip.
function StripeConnectSection({ biz: _biz }: { biz: any }) {
  const PUB_KEY = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [connectInstance, setConnectInstance] = useState<StripeConnectInstance | null>(null)
  const [initErr, setInitErr] = useState<string | null>(null)
  const [status, setStatus] = useState<{
    accountId: string | null
    payouts_enabled: boolean
    details_submitted: boolean
    requirements_currently_due: string[]
  } | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)

  const fetchStatus = async () => {
    try {
      const r = await apiGet<any>('/businesses/me/connect/account-status')
      setStatus(r)
    } catch {
      setStatus({
        accountId: null, payouts_enabled: false,
        details_submitted: false, requirements_currently_due: [],
      })
    } finally { setStatusLoading(false) }
  }
  useEffect(() => { fetchStatus() }, [])

  const ready = status?.payouts_enabled && status?.details_submitted

  // Poll while the onboarding sheet is open so we see the flip.
  useEffect(() => {
    if (!showOnboarding) return
    const t = setInterval(fetchStatus, 4000)
    return () => clearInterval(t)
  }, [showOnboarding])

  const startOnboarding = async () => {
    setInitErr(null)
    try {
      if (!PUB_KEY) throw new Error('VITE_STRIPE_PUBLISHABLE_KEY is not configured.')
      const instance = await loadConnectAndInitialize({
        publishableKey: PUB_KEY,
        fetchClientSecret: async () => {
          const r = await apiPost<{ clientSecret: string }>(
            '/businesses/me/connect/onboarding-link', {})
          return r.data!.clientSecret
        },
      })
      setConnectInstance(instance)
      setShowOnboarding(true)
    } catch (e: any) {
      setInitErr(e?.response?.data?.error || e?.message || 'Failed to start onboarding')
    }
  }

  const tone = ready ? 'green' : 'amber'
  const label = ready
    ? 'Ready'
    : status?.accountId
      ? (status.details_submitted ? 'Verifying…' : 'Onboarding incomplete')
      : 'Not started'

  return (
    <div style={{
      marginTop: 24, padding: 24,
      background: 'var(--bg-1)', border: '1px solid var(--border-0)',
      borderRadius: 12, maxWidth: 640,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, margin: 0 }}>
            Payments
          </h2>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 4 }}>
            {ready
              ? 'Customers can pay invoices by card or ACH. Funds settle to your linked bank.'
              : 'Set up Stripe Connect to accept card + ACH payments on invoices.'}
          </div>
        </div>
        <span style={{
          padding: '4px 12px', borderRadius: 14,
          fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
          background: tone === 'green' ? 'rgba(34,197,94,.16)' : 'rgba(245,158,11,.16)',
          color: tone === 'green' ? 'var(--green, #22c55e)' : 'var(--amber)',
          textTransform: 'uppercase' as const,
          whiteSpace: 'nowrap' as const,
        }}>{statusLoading ? '...' : label}</span>
      </div>

      {(status?.requirements_currently_due ?? []).length > 0 && (
        <div style={{
          marginTop: 14, padding: 10,
          background: 'var(--bg-2)', borderRadius: 6,
          fontSize: 12, color: 'var(--text-2)',
        }}>
          <strong style={{ color: 'var(--amber)' }}>Outstanding requirements:</strong>{' '}
          {(status?.requirements_currently_due ?? []).join(', ')}
        </div>
      )}

      {!ready && !showOnboarding && (
        <div style={{ marginTop: 18 }}>
          <button onClick={startOnboarding}
            style={{
              padding: '10px 16px',
              background: 'var(--gold)', color: 'var(--bg-0)',
              border: 'none', borderRadius: 8,
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>
            {status?.accountId ? 'Continue onboarding' : 'Set up payments'}
          </button>
          {initErr && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red, #ef4444)' }}>
              {initErr}
            </div>
          )}
        </div>
      )}

      {showOnboarding && connectInstance && (
        <div style={{ marginTop: 16 }}>
          <ConnectComponentsProvider connectInstance={connectInstance}>
            <ConnectAccountOnboarding onExit={() => { setShowOnboarding(false); fetchStatus() }} />
          </ConnectComponentsProvider>
          <button onClick={() => { setShowOnboarding(false); fetchStatus() }}
            style={{
              marginTop: 12, padding: '8px 14px',
              background: 'transparent', color: 'var(--text-2)',
              border: '1px solid var(--border-1)', borderRadius: 8,
              fontSize: 12, cursor: 'pointer',
            }}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}

// S492: feature toggles. Owner picks which capabilities apply to
// their business. Always-on features render as locked-on (visual
// reassurance + the API guards against trying to disable them).
function FeaturesSection({ biz, setBiz }: { biz: any; setBiz: (b: any) => void }) {
  const { refreshBusiness } = useAuth()
  const initial: Set<BusinessFeature> = new Set(
    (biz.enabledFeatures ?? biz.enabled_features ?? []) as BusinessFeature[],
  )
  const [selected, setSelected] = useState<Set<BusinessFeature>>(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const alwaysOn = new Set(BUSINESS_FEATURE_ALWAYS_ON)

  const toggle = (f: BusinessFeature) => {
    if (alwaysOn.has(f)) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f)
      else next.add(f)
      return next
    })
    setOk(false)
  }

  const dirty = (() => {
    if (selected.size !== initial.size) return true
    for (const f of selected) if (!initial.has(f)) return true
    return false
  })()

  const onSave = async () => {
    setSaving(true); setErr(null); setOk(false)
    try {
      const r = await apiPatch<any>('/businesses/me/features', {
        enabledFeatures: Array.from(selected),
      })
      const updated = r.enabled_features ?? r.enabledFeatures ?? Array.from(selected)
      setBiz({ ...biz, enabled_features: updated, enabledFeatures: updated })
      setOk(true)
      await refreshBusiness()  // refresh Layout nav
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div style={{
      marginTop: 24, padding: 24,
      background: 'var(--bg-1)', border: '1px solid var(--border-0)',
      borderRadius: 12, maxWidth: 640,
    }}>
      <h2 style={{
        fontFamily: 'var(--font-display)', fontSize: 20,
        margin: 0, marginBottom: 4,
      }}>Features</h2>
      <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 18 }}>
        Toggle which capabilities apply to your business. Changes take
        effect immediately across the nav and dashboard.
      </div>

      {err && <div style={errStyle}>{err}</div>}
      {ok && <div style={okStyle}>Features saved.</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {BUSINESS_FEATURES.map(f => {
          const enabled = selected.has(f)
          const locked = alwaysOn.has(f)
          return (
            <div key={f}
              onClick={() => toggle(f)}
              style={{
                display: 'flex', gap: 12, alignItems: 'flex-start',
                padding: 14,
                background: enabled ? 'var(--gold-bg)' : 'var(--bg-2)',
                border: `1px solid ${enabled ? 'var(--gold)' : 'var(--border-1)'}`,
                borderRadius: 8,
                cursor: locked ? 'default' : 'pointer',
                opacity: locked ? 0.85 : 1,
              }}
            >
              <div style={{
                width: 18, height: 18, marginTop: 2,
                borderRadius: 4,
                background: enabled ? 'var(--gold)' : 'var(--bg-3)',
                border: `1px solid ${enabled ? 'var(--gold)' : 'var(--border-1)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {enabled && (
                  <span style={{ color: 'var(--bg-0)', fontSize: 12, lineHeight: 1 }}>✓</span>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 14, fontWeight: 600,
                  color: enabled ? 'var(--gold)' : 'var(--text-0)',
                  marginBottom: 2,
                }}>
                  {BUSINESS_FEATURE_LABEL[f]}
                  {locked && (
                    <span style={{
                      fontSize: 10, color: 'var(--text-3)',
                      marginLeft: 8, fontWeight: 400,
                      textTransform: 'uppercase', letterSpacing: 1,
                    }}>always on</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.4 }}>
                  {BUSINESS_FEATURE_DESCRIPTION[f]}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={onSave}
        disabled={saving || !dirty}
        style={{
          ...btnStyle,
          opacity: (saving || !dirty) ? 0.5 : 1,
          cursor: (saving || !dirty) ? 'not-allowed' : 'pointer',
        }}
      >
        {saving ? 'Saving…' : dirty ? 'Save features' : 'No changes'}
      </button>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box',
}
const btnStyle: React.CSSProperties = {
  width: '100%', padding: '12px',
  background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 14, fontWeight: 600, marginTop: 20, cursor: 'pointer',
}
const errStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red-dim)', borderRadius: 8, fontSize: 13,
}
const okStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'var(--green-bg)', color: 'var(--green)',
  border: '1px solid var(--green-dim)', borderRadius: 8, fontSize: 13,
}
