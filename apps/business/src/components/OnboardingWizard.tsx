import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import {
  BUSINESS_FEATURES, BUSINESS_FEATURE_LABEL, BUSINESS_FEATURE_ALWAYS_ON,
} from '@gam/shared'
import { Modal } from './Modal'
import { parseCustomerCsv } from '../lib/customerCsv'
import { Check, Circle, Rocket, Upload, ArrowRight, X } from 'lucide-react'

interface OnboardingStatus {
  completedAt: string | null
  steps: {
    profile: boolean
    features: boolean
    stripe: boolean
    stripeStarted: boolean
    tax: boolean
    customers: boolean
  }
  customerCount: number
  defaultTaxRate: number | null
}

// The post-signup activation checklist. Renders a dismissible banner on
// the dashboard until the owner finishes or dismisses; the banner opens a
// stepped modal. Each step writes through to its real endpoint, so the
// checklist self-updates from data on reload.
export function OnboardingWizard() {
  const { business, refreshBusiness } = useAuth()
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [open, setOpen] = useState(false)

  const reload = async () => {
    try { setStatus(await apiGet<OnboardingStatus>('/businesses/me/onboarding')) }
    catch { /* non-blocking — banner just won't show */ }
  }
  useEffect(() => { reload() }, [])

  if (!status || status.completedAt) return null

  const stepDefs: Array<{ key: keyof OnboardingStatus['steps']; label: string }> = [
    { key: 'profile',   label: 'Add your business address' },
    { key: 'features',  label: 'Choose your features' },
    { key: 'stripe',    label: 'Connect payments' },
    { key: 'tax',       label: 'Set your sales tax' },
    { key: 'customers', label: 'Import your customers' },
  ]
  const done = stepDefs.filter(s => status.steps[s.key]).length

  const dismiss = async () => {
    await apiPost('/businesses/me/onboarding/complete')
    await reload()
  }

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: 18, marginBottom: 24, borderRadius: 12,
        background: 'linear-gradient(135deg, rgba(212,175,55,.10), rgba(212,175,55,.03))',
        border: '1px solid var(--gold)',
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 10, flexShrink: 0,
          background: 'rgba(212,175,55,.15)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Rocket size={22} color="var(--gold)" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-0)', fontSize: 16 }}>
            Finish setting up {business?.name ?? 'your business'}
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 13, marginTop: 2 }}>
            {done} of {stepDefs.length} steps done — get ready to take your first payment.
          </div>
        </div>
        <button onClick={() => setOpen(true)} style={primaryBtn}>
          {done === 0 ? 'Start setup' : 'Continue'} <ArrowRight size={14} />
        </button>
        <button onClick={dismiss} title="Dismiss" style={{
          background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4,
        }}>
          <X size={16} />
        </button>
      </div>

      {open && (
        <WizardModal
          status={status}
          onClose={() => setOpen(false)}
          onChanged={async () => { await reload(); await refreshBusiness() }}
          onFinish={async () => { await dismiss(); setOpen(false) }} />
      )}
    </>
  )
}

function WizardModal({
  status, onClose, onChanged, onFinish,
}: {
  status: OnboardingStatus
  onClose: () => void
  onChanged: () => Promise<void>
  onFinish: () => Promise<void>
}) {
  return (
    <Modal title="Set up your business" onClose={onClose} width={620}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Close</button>
          <button onClick={onFinish} style={primaryBtn}>Finish setup</button>
        </>
      }>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
        <ProfileStep done={status.steps.profile} onSaved={onChanged} />
        <FeaturesStep done={status.steps.features} onSaved={onChanged} />
        <StripeStep done={status.steps.stripe} started={status.steps.stripeStarted} />
        <TaxStep done={status.steps.tax} current={status.defaultTaxRate} onSaved={onChanged} />
        <CustomersStep done={status.steps.customers} count={status.customerCount} onSaved={onChanged} />
      </div>
    </Modal>
  )
}

function StepShell({
  done, title, children,
}: { done: boolean; title: string; children: React.ReactNode }) {
  return (
    <div style={{
      border: `1px solid ${done ? 'var(--green, #22c55e)' : 'var(--border-1)'}`,
      borderRadius: 10, padding: 14,
      background: done ? 'rgba(34,197,94,.05)' : 'var(--bg-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: children ? 10 : 0 }}>
        {done
          ? <Check size={16} color="var(--green, #22c55e)" />
          : <Circle size={16} color="var(--text-3)" />}
        <strong style={{ color: 'var(--text-0)', fontSize: 14 }}>{title}</strong>
      </div>
      {children}
    </div>
  )
}

function ProfileStep({ done, onSaved }: { done: boolean; onSaved: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(!done)
  const [street1, setStreet1] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setErr(null)
    if (!street1 || !city || !state || !zip) { setErr('Fill in the full address'); return }
    setSaving(true)
    try {
      await apiPatch('/businesses/me', { street1, city, state, zip, phone: phone || null })
      await onSaved()
    } catch (e: any) { setErr(e?.response?.data?.error || 'Save failed') }
    finally { setSaving(false) }
  }

  return (
    <StepShell done={done} title="Add your business address">
      {done && !expanded ? (
        <button onClick={() => setExpanded(true)} style={linkBtn}>Edit</button>
      ) : (
        <>
          {err && <div style={miniErr}>{err}</div>}
          <input value={street1} onChange={e => setStreet1(e.target.value)} placeholder="Street address" style={inp} />
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginTop: 8 }}>
            <input value={city} onChange={e => setCity(e.target.value)} placeholder="City" style={{ ...inp, marginTop: 0 }} />
            <input value={state} onChange={e => setState(e.target.value)} placeholder="State" style={{ ...inp, marginTop: 0 }} />
            <input value={zip} onChange={e => setZip(e.target.value)} placeholder="ZIP" style={{ ...inp, marginTop: 0 }} />
          </div>
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone (optional)" style={inp} />
          <button onClick={save} disabled={saving} style={{ ...primaryBtn, marginTop: 10 }}>
            {saving ? 'Saving…' : 'Save address'}
          </button>
        </>
      )}
    </StepShell>
  )
}

function FeaturesStep({ done, onSaved }: { done: boolean; onSaved: () => Promise<void> }) {
  const { business } = useAuth()
  const alwaysOn = new Set(BUSINESS_FEATURE_ALWAYS_ON)
  const [selected, setSelected] = useState<Set<string>>(new Set(business?.enabledFeatures ?? []))
  const [saving, setSaving] = useState(false)

  const toggle = (f: string) => {
    if (alwaysOn.has(f as any)) return
    setSelected(prev => {
      const next = new Set(prev)
      next.has(f) ? next.delete(f) : next.add(f)
      return next
    })
  }
  const save = async () => {
    setSaving(true)
    try {
      await apiPatch('/businesses/me/features', { enabledFeatures: Array.from(selected) })
      await onSaved()
    } finally { setSaving(false) }
  }

  return (
    <StepShell done={done} title="Choose your features">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {BUSINESS_FEATURES.map(f => {
          const on = selected.has(f) || alwaysOn.has(f)
          const locked = alwaysOn.has(f)
          return (
            <label key={f} style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
              color: locked ? 'var(--text-3)' : 'var(--text-1)',
              cursor: locked ? 'default' : 'pointer',
            }}>
              <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(f)} />
              {BUSINESS_FEATURE_LABEL[f]}
            </label>
          )
        })}
      </div>
      <button onClick={save} disabled={saving} style={{ ...primaryBtn, marginTop: 10 }}>
        {saving ? 'Saving…' : 'Save features'}
      </button>
    </StepShell>
  )
}

function StripeStep({ done, started }: { done: boolean; started: boolean }) {
  return (
    <StepShell done={done} title="Connect payments">
      <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>
        {done
          ? 'Your Stripe account is connected and ready to accept payouts.'
          : started
            ? 'Stripe onboarding started — finish verification in Settings to enable payouts.'
            : 'Connect a Stripe account to accept card + ACH payments and get paid out.'}
      </div>
      {!done && (
        <Link to="/settings" style={{ ...primaryBtn, textDecoration: 'none' }}>
          {started ? 'Finish in Settings' : 'Connect payments'} <ArrowRight size={14} />
        </Link>
      )}
    </StepShell>
  )
}

function TaxStep({ done, current, onSaved }: { done: boolean; current: number | null; onSaved: () => Promise<void> }) {
  const [pct, setPct] = useState(current != null ? String((current * 100).toFixed(4).replace(/\.?0+$/, '')) : '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setErr(null)
    const p = parseFloat(pct)
    if (isNaN(p) || p < 0 || p >= 100) { setErr('Enter a rate between 0 and 100'); return }
    setSaving(true)
    try {
      await apiPatch('/businesses/me', { defaultTaxRate: Math.round((p / 100) * 1e6) / 1e6 })
      await onSaved()
    } catch (e: any) { setErr(e?.response?.data?.error || 'Save failed') }
    finally { setSaving(false) }
  }

  return (
    <StepShell done={done} title="Set your sales tax">
      <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>
        Default rate applied to invoices + POS sales. Enter 0 if you don't collect sales tax.
      </div>
      {err && <div style={miniErr}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="number" step="0.01" min={0} value={pct} onChange={e => setPct(e.target.value)}
          placeholder="8.75" style={{ ...inp, marginTop: 0, maxWidth: 120 }} />
        <span style={{ color: 'var(--text-2)' }}>%</span>
        <button onClick={save} disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </StepShell>
  )
}

function CustomersStep({ done, count, onSaved }: { done: boolean; count: number; onSaved: () => Promise<void> }) {
  const [result, setResult] = useState<{ created: number; skipped: number; total: number; errors: Array<{ row: number; reason: string }> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onFile = async (file: File) => {
    setErr(null); setResult(null); setBusy(true)
    try {
      const text = await file.text()
      const customers = parseCustomerCsv(text)
      if (customers.length === 0) { setErr('No rows found in the file'); return }
      const r = await apiPost<typeof result>('/business-customers/import', { customers })
      setResult(r.data as any)
      await onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Import failed')
    } finally { setBusy(false) }
  }

  return (
    <StepShell done={done} title="Import your customers">
      <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>
        {count > 0 ? `${count} customer${count === 1 ? '' : 's'} so far. ` : ''}
        Upload a CSV with columns: <code>firstName, lastName, email, phone, street1, city, state, zip, companyName</code>.
      </div>
      <label style={{ ...ghostBtn, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <Upload size={14} /> {busy ? 'Importing…' : 'Choose CSV file'}
        <input type="file" accept=".csv,text/csv" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
      </label>
      {err && <div style={miniErr}>{err}</div>}
      {result && (
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-1)' }}>
          Imported <strong style={{ color: 'var(--green, #22c55e)' }}>{result.created}</strong> of {result.total}.
          {result.skipped > 0 && (
            <div style={{ marginTop: 6, color: 'var(--text-2)' }}>
              {result.skipped} skipped:
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {result.errors.slice(0, 5).map((e, i) => (
                  <li key={i}>Row {e.row}: {e.reason}</li>
                ))}
                {result.errors.length > 5 && <li>…and {result.errors.length - 5} more</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </StepShell>
  )
}

const inp: React.CSSProperties = {
  width: '100%', padding: '9px 11px', marginTop: 8,
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 13, boxSizing: 'border-box' as const,
}
const primaryBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--gold)', color: 'var(--bg-0)', border: 'none',
  borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
}
const linkBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--gold)',
  cursor: 'pointer', fontSize: 13, padding: 0,
}
const miniErr: React.CSSProperties = {
  margin: '8px 0', padding: '8px 10px', background: 'var(--red-bg)',
  color: 'var(--red, #ef4444)', border: '1px solid var(--red-dim, #ef4444)',
  borderRadius: 6, fontSize: 12,
}
