import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import {
  Check, Building2, CreditCard, FileText, User,
  ChevronRight, ChevronLeft, AlertTriangle,
  Landmark, Plus, X
} from 'lucide-react'
import {
  ACCOUNT_TYPE_VALUES, ACCOUNT_HOLDER_TYPE_VALUES,
  AccountType, AccountHolderType,
} from '@gam/shared'

const STEPS = [
  { id: 'profile',    label: 'Business Profile', icon: User,      desc: 'Tell us about yourself and your business' },
  { id: 'property',   label: 'First Property',   icon: Building2, desc: 'Add your first property to the platform' },
  { id: 'banking',    label: 'Bank Account',      icon: CreditCard,desc: 'Connect your account to receive disbursements' },
  { id: 'agreement',  label: 'Sign Agreement',    icon: FileText,  desc: 'Review and sign the platform agreement' },
]

export function OnboardingPage() {
  const navigate = useNavigate()
  const { user, refresh } = useAuth()
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [completed, setCompleted] = useState<Set<number>>(new Set())
  const [signature, setSignature] = useState('')
  const [agreed, setAgreed] = useState(false)
  const agreementRef = useRef<HTMLDivElement>(null)
  const [scrolledAgreement, setScrolledAgreement] = useState(false)
  const [showAddBank, setShowAddBank] = useState(false)
  // S513 (#2): landlord's onboarding ACH fee election. Default false = tenant
  // pays ACH (the launch default). Card is always the tenant's — not a choice.
  const [coverTenantAch, setCoverTenantAch] = useState(false)

  // Profile form
  const [profile, setProfile] = useState({ businessName: '', ein: '', phone: '', street1: '', city: '', state: '', zip: '' })
  // Property form
  const [property, setProperty] = useState({ name: '', street1: '', street2: '', city: '', state: '', zip: '', type: 'residential' })
  const [errors, setErrors] = useState<Record<string, string>>({})

  // S67: Banking step now reads the user's bank account catalog directly.
  // Step 2 is complete when at least one active account exists.
  const { data: bankAccounts = [] } = useQuery<any[]>(
    'bank-accounts', () => apiGet('/bank-accounts')
  )
  const activeBankAccounts = bankAccounts.filter((a: any) => a.status === 'active')
  const bankReady = activeBankAccounts.length > 0
  useEffect(() => {
    if (bankReady) setCompleted(prev => new Set([...prev, 2]))
  }, [bankReady])

  const addPropertyMut = useMutation(
    (data: any) => apiPost('/properties', data),
    { onSuccess: () => { setCompleted(prev => new Set([...prev, 1])); setStep(2) } }
  )

  const completeMut = useMutation(
    () => apiPost('/landlords/complete-onboarding', { signature, agreedAt: new Date().toISOString(), coverTenantAch }),
    { onSuccess: async () => {
      await refresh?.()
      navigate('/dashboard')
    }}
  )

  const validate = (stepIdx: number) => {
    const errs: Record<string, string> = {}
    if (stepIdx === 0) {
      if (!profile.phone.trim()) errs.phone = 'Phone required'
    }
    if (stepIdx === 1) {
      if (!property.name.trim()) errs.propName = 'Property name required'
      if (!property.street1.trim()) errs.street1 = 'Address required'
      if (!property.city.trim()) errs.city = 'City required'
      if (!property.zip.trim()) errs.zip = 'ZIP required'
    }
    if (stepIdx === 3) {
      if (!agreed) errs.agreed = 'You must agree to continue'
      if (!signature.trim()) errs.signature = 'Signature required'
      if (!scrolledAgreement) errs.scroll = 'Please read the full agreement'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleNext = () => {
    if (!validate(step)) return
    if (step === 0) {
      setCompleted(prev => new Set([...prev, 0]))
      setStep(1)
    } else if (step === 1) {
      addPropertyMut.mutate(property)
    } else if (step === 2) {
      if (bankReady) {
        setCompleted(prev => new Set([...prev, 2]))
        setStep(3)
      }
    } else if (step === 3) {
      completeMut.mutate()
    }
  }

  const progress = (completed.size / STEPS.length) * 100

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-0)', display: 'flex', flexDirection: 'column' }}>

      {/* Top bar */}
      <div style={{ height: 56, borderBottom: '1px solid var(--border-0)', background: 'var(--bg-1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 32px', flexShrink: 0 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 800, color: 'var(--gold)' }}>⚡ GAM</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Signed in as {user?.email}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.72rem', color: 'var(--gold)' }}>{Math.round(progress)}% complete</div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--bg-3)' }}>
        <div style={{ height: '100%', background: 'linear-gradient(90deg, var(--gold-dark), var(--gold))', width: `${progress}%`, transition: 'width .4s ease' }} />
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Left sidebar — steps */}
        <div style={{ width: 280, flexShrink: 0, background: 'var(--bg-1)', borderRight: '1px solid var(--border-0)', padding: '32px 24px', overflowY: 'auto' }}>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 20, lineHeight: 1.6 }}>
            Complete all 4 steps to activate your portfolio.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {STEPS.map((s, i) => {
              const Icon = s.icon
              const isDone = completed.has(i)
              const isActive = step === i
              const isLocked = i > step && !completed.has(i)
              return (
                <div
                  key={s.id}
                  onClick={() => !isLocked && setStep(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10,
                    cursor: isLocked ? 'not-allowed' : 'pointer', transition: 'all .12s',
                    background: isActive ? 'rgba(201,162,39,.08)' : isDone ? 'rgba(30,219,122,.04)' : 'transparent',
                    border: `1px solid ${isActive ? 'rgba(201,162,39,.3)' : isDone ? 'rgba(30,219,122,.2)' : 'transparent'}`,
                    opacity: isLocked ? .4 : 1,
                  }}
                >
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: isDone ? 'rgba(30,219,122,.15)' : isActive ? 'rgba(201,162,39,.15)' : 'var(--bg-3)',
                    border: `1px solid ${isDone ? 'rgba(30,219,122,.4)' : isActive ? 'rgba(201,162,39,.4)' : 'var(--border-0)'}`,
                  }}>
                    {isDone
                      ? <Check size={14} style={{ color: 'var(--green)' }} />
                      : <Icon size={14} style={{ color: isActive ? 'var(--gold)' : 'var(--text-3)' }} />
                    }
                  </div>
                  <div>
                    <div style={{ fontSize: '.78rem', fontWeight: isActive ? 700 : 500, color: isDone ? 'var(--text-2)' : isActive ? 'var(--text-0)' : 'var(--text-3)' }}>{s.label}</div>
                    {isActive && <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 1 }}>{s.desc}</div>}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Fee + payout reminder */}
          <div style={{ marginTop: 32, padding: '12px 14px', background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 10 }}>
            <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--gold)', marginBottom: 6 }}>SIMPLE, FLAT PRICING</div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.6 }}>
              $2 per occupied unit / month — vacant units are free. Rent is routed to your connected bank account as your tenants' payments settle.
            </div>
          </div>
        </div>

        {/* Main content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '40px 48px' }}>
          <div style={{ maxWidth: 560, margin: '0 auto' }}>

            {/* Step header */}
            <div style={{ marginBottom: 32 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Step {step + 1} of {STEPS.length}</div>
                {completed.has(step) && <span className="badge badge-green"><Check size={10} /> Complete</span>}
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-0)', marginBottom: 6 }}>{STEPS[step].label}</div>
              <div style={{ fontSize: '.85rem', color: 'var(--text-3)' }}>{STEPS[step].desc}</div>
            </div>

            {/* ── STEP 0: BUSINESS PROFILE ── */}
            {step === 0 && (
              <div>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
                    Business / Company Name <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span>
                  </label>
                  <input className="input" placeholder="Smith Properties LLC" value={profile.businessName} onChange={e => setProfile(p => ({ ...p, businessName: e.target.value }))} style={{ width: '100%' }} />
                  <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 4 }}>If you own property as an LLC, partnership, or trust, enter that name here.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
                    EIN / Tax ID <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional — required for 1099 at tax time)</span>
                  </label>
                  <input className="input" placeholder="XX-XXXXXXX" value={profile.ein} onChange={e => setProfile(p => ({ ...p, ein: e.target.value }))} style={{ width: '100%' }} />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Phone Number *</label>
                  <input className="input" type="tel" placeholder="(555) 000-0000" value={profile.phone} onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))} style={{ width: '100%' }} autoFocus />
                  {errors.phone && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.phone}</div>}
                </div>

                <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 16, marginBottom: 14 }}>
                  <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 12 }}>Mailing Address <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></div>
                  <div style={{ marginBottom: 10 }}>
                    <input className="input" placeholder="Street address" value={profile.street1} onChange={e => setProfile(p => ({ ...p, street1: e.target.value }))} style={{ width: '100%' }} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10 }}>
                    <input className="input" placeholder="City" value={profile.city} onChange={e => setProfile(p => ({ ...p, city: e.target.value }))} />
                    <input className="input" placeholder="ST" value={profile.state} onChange={e => setProfile(p => ({ ...p, state: e.target.value }))} style={{ width: 56 }} />
                    <input className="input" placeholder="ZIP" value={profile.zip} onChange={e => setProfile(p => ({ ...p, zip: e.target.value }))} style={{ width: 88 }} />
                  </div>
                </div>
              </div>
            )}

            {/* ── STEP 1: FIRST PROPERTY ── */}
            {step === 1 && (
              <div>
                <div style={{ background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 10, padding: '10px 14px', marginBottom: 20, fontSize: '.78rem', color: 'var(--gold)', lineHeight: 1.5 }}>
                  💡 Add your first property. You can add more properties and units after onboarding.
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Property Name *</label>
                  <input className="input" placeholder="Oak Street Apartments" value={property.name} onChange={e => setProperty(p => ({ ...p, name: e.target.value }))} style={{ width: '100%' }} autoFocus />
                  {errors.propName && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.propName}</div>}
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Street Address *</label>
                  <input className="input" placeholder="4821 W Oak St" value={property.street1} onChange={e => setProperty(p => ({ ...p, street1: e.target.value }))} style={{ width: '100%' }} />
                  {errors.street1 && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.street1}</div>}
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Suite / Unit / Lot <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
                  <input className="input" placeholder="Suite 100" value={property.street2} onChange={e => setProperty(p => ({ ...p, street2: e.target.value }))} style={{ width: '100%' }} />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, marginBottom: 14 }}>
                  <div>
                    <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>City *</label>
                    <input className="input" placeholder="Phoenix" value={property.city} onChange={e => setProperty(p => ({ ...p, city: e.target.value }))} style={{ width: '100%' }} />
                    {errors.city && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.city}</div>}
                  </div>
                  <div>
                    <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>State</label>
                    <input className="input" placeholder="ST" value={property.state} onChange={e => setProperty(p => ({ ...p, state: e.target.value }))} style={{ width: 56 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>ZIP *</label>
                    <input className="input" placeholder="85031" value={property.zip} onChange={e => setProperty(p => ({ ...p, zip: e.target.value }))} style={{ width: 88 }} />
                    {errors.zip && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.zip}</div>}
                  </div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 8 }}>Property Type *</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
                    {[
                      { value: 'residential',  label: '🏠 Residential',       desc: 'Apartments, houses, condos' },
                      { value: 'rv_longterm',  label: '🚐 RV — Long-term',    desc: '3+ month stays' },
                      { value: 'rv_weekly',    label: '🏕️ RV — Weekly',       desc: 'Weekly billing' },
                      { value: 'rv_nightly',   label: '⭐ RV — Nightly',      desc: 'Nightly/short-term' },
                    ].map(t => (
                      <div key={t.value} onClick={() => setProperty(p => ({ ...p, type: t.value }))} style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${property.type === t.value ? 'var(--gold)' : 'var(--border-0)'}`, background: property.type === t.value ? 'rgba(201,162,39,.06)' : 'var(--bg-2)', transition: 'all .12s' }}>
                        <div style={{ fontSize: '.8rem', fontWeight: 600, color: property.type === t.value ? 'var(--gold)' : 'var(--text-1)' }}>{t.label}</div>
                        <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 2 }}>{t.desc}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {addPropertyMut.isError && (
                  <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                    Failed to add property. Please try again.
                  </div>
                )}
              </div>
            )}

            {/* ── STEP 2: BANKING ── */}
            {step === 2 && (
              <div>
                {bankReady ? (
                  <div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', gap: 12 }}>
                      <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(30,219,122,.12)', border: '2px solid var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Check size={28} style={{ color: 'var(--green)' }} />
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-0)', marginBottom: 6 }}>Bank Account Added</div>
                        <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>You can route each property to one of your accounts from the Properties page.</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                      {activeBankAccounts.map((a: any) => (
                        <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10 }}>
                          <div>
                            <div style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>{a.nickname}</div>
                            <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{a.accountHolderName} · {a.accountType} •••• {a.accountNumberLast4}</div>
                          </div>
                          <Check size={16} style={{ color: 'var(--green)' }} />
                        </div>
                      ))}
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowAddBank(true)}>
                      <Plus size={12} /> Add another account
                    </button>
                  </div>
                ) : (
                  <div>
                    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                        <div style={{ width: 44, height: 44, borderRadius: 10, background: 'rgba(201,162,39,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Landmark size={20} style={{ color: 'var(--gold)' }} />
                        </div>
                        <div>
                          <div style={{ fontSize: '.88rem', fontWeight: 700, color: 'var(--text-0)' }}>Add a payout bank account</div>
                          <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Where rent disbursements land. Multiple LLCs? Add one per LLC.</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                        {[
                          'US checking or savings account',
                          'Personal or business (LLC) accounts both supported',
                          'Account number encrypted at rest, last 4 only ever shown',
                          'Multiple properties can share one account — collapses to a single ACH',
                        ].map(item => (
                          <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.78rem', color: 'var(--text-2)' }}>
                            <Check size={12} style={{ color: 'var(--green)', flexShrink: 0 }} /> {item}
                          </div>
                        ))}
                      </div>
                      <div style={{ background: 'rgba(255,184,32,.06)', border: '1px solid rgba(255,184,32,.2)', borderRadius: 8, padding: '8px 12px', fontSize: '.72rem', color: 'var(--amber)', display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16 }}>
                        <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                        Test mode. No real money will move until live payment processing is enabled.
                      </div>
                      <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: 13 }} onClick={() => setShowAddBank(true)}>
                        <Plus size={14} /> Add Bank Account
                      </button>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setCompleted(prev => new Set([...prev, 2])); setStep(3) }}>
                        Skip for now — set up banking later
                      </button>
                    </div>
                  </div>
                )}

                {/* S513 (#2): ACH fee election. Card is always the tenant's. */}
                <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 12, padding: 18, marginTop: 8 }}>
                  <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>Who pays the ACH processing fee?</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
                    ACH bank payments cost 1.0% (capped $6.00). By default your tenants pay this fee. You can
                    choose to cover it for them — applied across your properties (change per-property later in Settings).
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {[
                      { v: false, title: 'Tenant pays ACH', sub: 'Standard — fee added on top of rent' },
                      { v: true,  title: "I'll cover ACH",   sub: 'Deducted from your payouts' },
                    ].map(opt => {
                      const selected = coverTenantAch === opt.v
                      return (
                        <button key={String(opt.v)} type="button" onClick={() => setCoverTenantAch(opt.v)}
                          style={{ flex: 1, textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                            background: selected ? 'rgba(201,162,39,.1)' : 'var(--bg-1)',
                            border: selected ? '1.5px solid var(--gold)' : '1px solid var(--border-0)' }}>
                          <div style={{ fontSize: '.82rem', fontWeight: 700, color: selected ? 'var(--gold)' : 'var(--text-0)' }}>{opt.title}</div>
                          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>{opt.sub}</div>
                        </button>
                      )
                    })}
                  </div>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <CreditCard size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                    Card payments (3.25%) are always paid by the tenant — landlords never cover card fees.
                  </div>
                </div>
              </div>
            )}

            {/* ── STEP 3: AGREEMENT ── */}
            {step === 3 && (
              <div>
                <div
                  ref={agreementRef}
                  onScroll={e => {
                    const el = e.currentTarget
                    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 20) setScrolledAgreement(true)
                  }}
                  style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 20, maxHeight: 340, overflowY: 'auto', fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.9, marginBottom: 16 }}
                >
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 800, color: 'var(--text-0)', marginBottom: 16, textAlign: 'center' }}>
                    Landlord Platform Participation Agreement<br />
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: '.75rem', fontWeight: 400, color: 'var(--text-3)' }}>Gold Asset Management LLC · Effective {new Date().toLocaleDateString()}</span>
                  </div>

                  {[
                    { title: '1. Payment Processing & Payouts', body: 'Platform processes Tenant rent payments (ACH and card) and routes settled funds to Landlord\'s connected bank account via Stripe Connect. Platform does NOT advance funds — Landlord receives rent as Tenant payments settle, not before. Platform acts as Landlord\'s authorized payment processor and collection agent. This is NOT an insurance policy, surety bond, financial guarantee, or rent advance.' },
                    { title: '2. Payment Routing Priority', body: 'When a Tenant makes a payment through the Platform, the payment is applied first to any outstanding balance the Tenant owes to Platform under any current or future Platform service, beginning with the oldest such balance (first-in, first-out); the remaining amount is then routed to Landlord. Landlord acknowledges that where a Tenant owes Platform, Landlord receives the residual amount after Platform\'s balance is satisfied, not the gross payment. This is an authorized routing of the Tenant\'s own funds — not a debt-collection action and not a reduction of any amount the Tenant owes Landlord. Landlord retains all rights and remedies against the Tenant for any rent or other amount that remains unpaid.' },
                    { title: '3. Platform Fees', body: 'Occupied Units: $2.00 per occupied unit per month, subject to a $10.00 monthly minimum per connected payout account. A connected payout account corresponds to the legal entity or bank account that receives payouts; properties that share one connected account share a single minimum, while separate entities (for example, separate LLCs, each with its own connected account) each carry their own minimum. Vacant Units: $0.00 — vacant units are never charged. Card and ACH processing fees are paid by the Tenant and are never absorbed by Platform; at onboarding, Landlord may elect to cover its Tenants\' ACH fees, but card processing fees are always paid by the Tenant and are never covered by Landlord. Platform fees are billed monthly and deducted from Landlord payouts.' },
                    { title: '4. Payment Reversals & Pass-Through Charges', body: 'Platform does not absorb banking, processing, or payment-network charges of any kind. All such charges — including card-processing fees, ACH fees, returned-payment fees, and chargeback or dispute fees — pass through to the responsible party as described in the Platform Fees section, and Platform absorbs none of them. Because Platform does not advance funds, a Tenant payment that fails, is returned, or is reversed before settlement is simply not paid out. If a payment is reversed, returned, or charged back after it has been routed to Landlord, Landlord authorizes Platform to recover the reversed amount and any associated charge from Landlord\'s balance or future payouts. Platform bears no liability for reversed, returned, or charged-back payments.' },
                    { title: '5. Additional Services', body: 'Platform may make additional, optional services and products available to Landlord from time to time (for example, premium features, marketing or listing enhancements, tenant-screening packages, or other add-ons). Each such service is optional and is enrolled in separately. The scope and fees for any additional service are disclosed to Landlord at the point of enrollment, and upon enrollment that service is governed by this Agreement. Landlord authorizes Platform to bill the disclosed fees for any service Landlord enrolls in under the same terms as Platform Fees — billed monthly and deducted from Landlord payouts. Declining or not enrolling in an additional service does not affect Landlord\'s core platform access.' },
                    { title: '6. Security Deposit Custody', body: 'Where Landlord uses Platform to collect or hold security deposits, Platform holds those funds as custodian. Where applicable law requires a security deposit to be held in a separate, escrow, or trust account, to be held in a particular form, or to accrue interest, Platform holds the deposit accordingly and pays any required interest at the applicable statutory rate. Where applicable law does not require segregation, Landlord authorizes Platform to hold deposit funds in its general account and to use such funds in the ordinary course of its business. In all cases, Platform remains obligated to keep the deposit available for return and disbursement in accordance with the lease and applicable law, and the manner in which deposit funds are held does not reduce or impair the deposit owed to the Tenant; Landlord remains responsible to the Tenant for the security deposit under the lease and applicable law. Landlord may transfer security deposits it currently holds into Platform custody, in which case those deposits are held under this Section and Landlord\'s platform fee is reduced as disclosed by Platform.' },
                    { title: '7. Tenant Screening & FCRA', body: 'Where Landlord uses Platform\'s tenant-screening or background-check tools, Landlord is the user of the consumer report under the Fair Credit Reporting Act (FCRA) and applicable law. Landlord certifies that it will request and use reports only for a permissible purpose, obtain any required applicant authorization, and make its own screening decisions. When Landlord takes adverse action based in whole or in part on a report, Platform generates and sends the federal adverse-action notice on Landlord\'s behalf using the decision information Landlord provides; Landlord is responsible for the accuracy of that information and for any additional notice or disclosure its jurisdiction requires. Platform provides screening tools only — it is not the decision-maker and does not provide legal advice regarding screening.' },
                    { title: '8. Eviction Mode', body: 'In many jurisdictions, accepting any rent payment while pursuing eviction for that nonpayment may waive the right to proceed. Landlord is responsible for knowing and complying with their local eviction rules. Landlord must activate Eviction Mode before filing any eviction action. While Eviction Mode is active, all Tenant payments routed to the Landlord for the affected unit are paused. Platform is not liable for eviction complications arising from failure to activate Eviction Mode or from non-compliance with local laws.' },
                    { title: '9. ACH Authorization', body: 'Landlord authorizes Platform to initiate ACH debit entries from Tenant\'s bank account and ACH credit entries to Landlord\'s connected bank account. Landlord authorizes Platform to reverse erroneous entries. Platform complies with NACHA Operating Rules and Guidelines. Landlord agrees to promptly notify Platform of any unauthorized transactions.' },
                    { title: '10. Tax Reporting', body: 'Landlord is solely responsible for its own tax obligations arising from its use of the Platform. Platform and its payment processor may issue tax forms (for example, IRS Form 1099-K) to Landlord and to taxing authorities as required by law. Platform does not provide tax advice.' },
                    { title: '11. Landlord Compliance & Indemnification', body: 'Landlord is solely responsible for operating its rental business in compliance with all applicable laws, including fair-housing, landlord-tenant, consumer-protection, and privacy laws, and for the lawfulness of its lease terms, fees, and tenant communications. Platform\'s features are configurable tools that Landlord directs; Platform does not set, review, or warrant the legality of Landlord\'s decisions. Landlord will indemnify and hold harmless Platform from any claim, loss, or liability arising out of Landlord\'s acts or omissions, its violation of law, or its breach of this Agreement.' },
                    { title: '12. Disclaimers & Limitation of Liability', body: 'The Platform is provided "as is" and "as available," without warranties of any kind, express or implied. Platform does not provide legal, tax, accounting, or financial advice, and nothing in the Platform constitutes such advice. To the maximum extent permitted by law, Platform is not liable for indirect, incidental, special, consequential, or punitive damages, and Platform\'s total liability for any claim arising out of or relating to this Agreement is limited to the total Platform Fees paid by Landlord in the twelve (12) months preceding the event giving rise to the claim.' },
                    { title: '13. Automated Systems & AI Agents', body: 'Platform operates in part through automated systems and AI-assisted agents that may communicate with users, generate documents and notices, schedule and process activity, and perform routine actions within the Platform. Where an automated or AI agent presents an action for review, Landlord (or its operator) is responsible for confirming the action before it is taken, and is responsible for any action it confirms or directs the agent to take. These systems may occasionally make an error or take an incorrect action; Platform may review, correct, reverse, or adjust any erroneous action, entry, communication, or record produced by such systems, and Landlord authorizes Platform to make those corrections. Automated or AI-generated communications are operational tools — they are not legal, tax, or financial advice and do not replace Landlord\'s own judgment. Platform\'s responsibility for the actions of its automated systems is governed by the Disclaimers and Limitation of Liability section, and Landlord agrees to promptly notify Platform of any error it identifies so it can be corrected.' },
                    { title: '14. Electronic Records & Signatures', body: 'Landlord consents to transact with Platform electronically. Landlord agrees that its electronic signature on this Agreement and on any document executed through the Platform is legally binding, and that Platform may deliver this Agreement, notices, disclosures, statements, and other communications electronically, consistent with the federal ESIGN Act and applicable state law. Landlord may request a paper copy of any record and may withdraw consent to electronic delivery as provided by law, which may limit Landlord\'s ability to use the Platform.' },
                    { title: '15. Communications Consent', body: 'Landlord consents to receive communications from Platform — including account, billing, transaction, security, and service messages — by email, SMS/text, push notification, and telephone, including messages sent by automated systems, at the contact information Landlord provides. Message and data rates may apply. Landlord may opt out of non-essential marketing communications at any time; Landlord may not opt out of operational and transactional messages necessary to provide the service. Landlord is responsible for keeping its contact information current.' },
                    { title: '16. Privacy & Data', body: 'Platform\'s collection and use of personal information is described in its Privacy Policy, which is incorporated into this Agreement by reference. Landlord represents that it has the authority and any required consents to provide tenant and applicant information to Platform and to direct Platform\'s processing of that information, and that it will handle personal information it receives through the Platform in compliance with applicable privacy laws. Each party will use reasonable measures to protect personal information.' },
                    { title: '17. FlexCharge', body: 'FlexCharge is a product organized by GAM but operated by Landlord. It lets Landlord, acting as a Business Account Owner, offer a rolling charge account to its tenants or point-of-sale customers at a Location. Landlord — not GAM — is the creditor. Landlord sets all account terms (credit limit, any interest or finance charges, payment cadence, and default consequences) and is solely responsible for compliance with all laws applicable to extending and servicing such accounts, including the Truth in Lending Act, Equal Credit Opportunity Act, Fair Credit Billing Act, Fair Debt Collection Practices Act, and state lending, retail-installment, and usury laws. GAM provides the accounting software only, sets no rules on how Landlord operates its charge accounts, and advises Landlord to operate within its local laws. The three-party terms among the account holder, Landlord, and GAM are set out in the FlexCharge Business Account Agreement Landlord enters at enablement. FlexCharge is not a launch feature; these terms govern it if and when Landlord enables it.' },
                    { title: '18. Termination', body: 'Landlord may stop using and leave the Platform at any time. Platform Fees are not prorated; no partial-month credit or refund is issued upon termination, and any outstanding Platform Fees or other amounts owed to Platform remain due and may be settled from Landlord\'s balance or payouts. Following termination, security deposits held by Platform in custody may be retained for up to ninety (90) days to wind down accounts and close any interest-bearing accounts, unless applicable law requires earlier return or disbursement; such deposits remain subject to the lease and applicable law. Final payouts settle through normal processing.' },
                    { title: '19. Dispute Resolution & Arbitration', body: 'Most concerns can be resolved informally: before starting a formal proceeding, a party must send the other written notice describing the dispute and allow 30 days to resolve it. Any dispute not resolved that way will be settled by binding arbitration administered by the American Arbitration Association under its Commercial Arbitration Rules, before a single arbitrator, in the state where Platform is headquartered, and the Federal Arbitration Act governs this section. Disputes will be arbitrated only on an individual basis: Landlord and Platform each waive any right to bring or participate in a class, collective, consolidated, or representative action, and the arbitrator may not consolidate claims or preside over any form of representative proceeding. Notwithstanding the above, either party may bring an individual claim in small-claims court, and either party may seek injunctive or other equitable relief in court to protect its intellectual property or confidential information. If the class-action waiver in this section is found unenforceable as to a particular claim, that claim (and only that claim) will proceed in court rather than arbitration, and the remainder of this section stays in effect.' },
                    { title: '20. Governing Law & Amendments', body: 'This Agreement is governed by the laws of the state where Platform is headquartered. If any provision is held unenforceable, the remaining provisions remain in full force. Platform may update this Agreement with 30 days\' written notice to Landlord.' },
                    { title: '21. General Provisions', body: 'Landlord may not assign this Agreement without Platform\'s prior written consent; Platform may assign it to an affiliate or to a successor in connection with a merger, acquisition, or sale of assets. This Agreement, together with any terms presented at enrollment for a specific service, is the entire agreement between the parties on its subject matter and supersedes prior understandings. Platform may provide notices to Landlord electronically or through the Platform. Neither party is liable for failures or delays caused by events beyond its reasonable control. A failure to enforce any provision is not a waiver of it.' },
                  ].map(section => (
                    <div key={section.title} style={{ marginBottom: 16 }}>
                      <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>{section.title}</div>
                      <div>{section.body}</div>
                    </div>
                  ))}

                  <div style={{ borderTop: '1px solid var(--border-0)', paddingTop: 12, marginTop: 8, color: 'var(--text-3)', fontSize: '.72rem' }}>
                    Landlords are encouraged to consult their own advisor before signing.
                  </div>
                </div>

                {!scrolledAgreement && (
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textAlign: 'center', marginBottom: 12 }}>↓ Scroll to read the full agreement before signing</div>
                )}
                {errors.scroll && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginBottom: 10 }}>{errors.scroll}</div>}

                {/* Checkbox */}
                <div style={{ marginBottom: 16, padding: '12px 14px', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                    <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: 2 }} />
                    <div style={{ fontSize: '.78rem', color: 'var(--text-1)', lineHeight: 1.5 }}>
                      I have read and understand the Landlord Platform Participation Agreement. I agree to the platform fees and all other provisions.
                    </div>
                  </label>
                  {errors.agreed && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 6 }}>{errors.agreed}</div>}
                </div>

                {/* Signature */}
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
                    Type your full legal name as signature *
                  </label>
                  <input
                    className="input"
                    placeholder={`${user?.firstName} ${user?.lastName}`}
                    value={signature}
                    onChange={e => setSignature(e.target.value)}
                    style={{ width: '100%', fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: '1rem' }}
                  />
                  {errors.signature && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.signature}</div>}
                  <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 4 }}>
                    Signing as {user?.firstName} {user?.lastName} · {new Date().toLocaleDateString()} · {new Date().toLocaleTimeString()}
                  </div>
                </div>

                {completeMut.isError && (
                  <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                    Failed to complete onboarding. Please try again.
                  </div>
                )}
              </div>
            )}

            {/* Navigation */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--border-0)' }}>
              <button
                className="btn btn-ghost"
                onClick={() => step > 0 && setStep(s => s - 1)}
                disabled={step === 0}
                style={{ opacity: step === 0 ? 0 : 1 }}
              >
                <ChevronLeft size={15} /> Back
              </button>

              <button
                className="btn btn-primary"
                onClick={handleNext}
                disabled={addPropertyMut.isLoading || completeMut.isLoading || (step === 2 && !bankReady && !completed.has(2))}
                style={{ padding: '10px 24px' }}
              >
                {addPropertyMut.isLoading || completeMut.isLoading ? <span className="spinner" /> :
                  step === STEPS.length - 1 ? <>Sign & Activate</> :
                  <>Continue <ChevronRight size={14} /></>
                }
              </button>
            </div>

          </div>
        </div>
      </div>

      {showAddBank && (
        <AddBankAccountInlineModal
          onClose={() => setShowAddBank(false)}
          onAdded={() => { qc.invalidateQueries('bank-accounts'); setShowAddBank(false) }}
        />
      )}
    </div>
  )
}

function AddBankAccountInlineModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({
    nickname: '', accountHolderName: '',
    accountHolderType: 'individual' as AccountHolderType,
    accountType: 'checking' as AccountType,
    routingNumber: '', accountNumber: '', confirm_accountNumber: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const lbl: React.CSSProperties = {
    fontSize: '.7rem', fontWeight: 600, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: '.06em',
    display: 'block', marginBottom: 5,
  }

  const mut = useMutation(
    (data: any) => apiPost('/bank-accounts', data),
    {
      onSuccess: () => onAdded(),
      onError: (e: any) => setErrors({ submit: e?.response?.data?.error || 'Failed to add account' }),
    }
  )

  const submit = () => {
    const errs: Record<string, string> = {}
    if (!form.nickname.trim()) errs.nickname = 'Required'
    if (!form.accountHolderName.trim()) errs.accountHolderName = 'Required'
    if (!/^\d{9}$/.test(form.routingNumber.replace(/\D/g, ''))) errs.routingNumber = 'Must be 9 digits'
    const acct = form.accountNumber.replace(/\D/g, '')
    if (acct.length < 4 || acct.length > 17) errs.accountNumber = 'Must be 4–17 digits'
    if (form.accountNumber !== form.confirm_accountNumber) errs.confirm_accountNumber = "Account numbers don't match"
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    mut.mutate({
      nickname: form.nickname.trim(),
      accountHolderName: form.accountHolderName.trim(),
      accountHolderType: form.accountHolderType,
      accountType: form.accountType,
      routingNumber: form.routingNumber.replace(/\D/g, ''),
      accountNumber: acct,
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>Add Bank Account</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Nickname</label>
          <input className="input" style={{ width: '100%' }} value={form.nickname}
            placeholder='e.g. "Acme Holdings LLC"'
            onChange={e => setForm(f => ({ ...f, nickname: e.target.value }))} />
          {errors.nickname && <div style={{ fontSize: '.68rem', color: 'var(--red)', marginTop: 4 }}>{errors.nickname}</div>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={lbl}>Holder Type</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {ACCOUNT_HOLDER_TYPE_VALUES.map(v => (
                <button key={v} type="button"
                  onClick={() => setForm(f => ({ ...f, accountHolderType: v }))}
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                    fontSize: '.76rem', textTransform: 'capitalize',
                    border: `1px solid ${form.accountHolderType === v ? 'var(--gold)' : 'var(--border-0)'}`,
                    background: form.accountHolderType === v ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                    color: 'var(--text-0)',
                  }}>{v}</button>
              ))}
            </div>
          </div>
          <div>
            <label style={lbl}>Account Type</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {ACCOUNT_TYPE_VALUES.map(v => (
                <button key={v} type="button"
                  onClick={() => setForm(f => ({ ...f, accountType: v }))}
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                    fontSize: '.76rem', textTransform: 'capitalize',
                    border: `1px solid ${form.accountType === v ? 'var(--gold)' : 'var(--border-0)'}`,
                    background: form.accountType === v ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                    color: 'var(--text-0)',
                  }}>{v}</button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Account Holder Name</label>
          <input className="input" style={{ width: '100%' }} value={form.accountHolderName}
            placeholder={form.accountHolderType === 'business' ? 'Legal entity name' : 'Full name on account'}
            onChange={e => setForm(f => ({ ...f, accountHolderName: e.target.value }))} />
          {errors.accountHolderName && <div style={{ fontSize: '.68rem', color: 'var(--red)', marginTop: 4 }}>{errors.accountHolderName}</div>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={lbl}>Routing #</label>
            <input className="input" style={{ width: '100%' }} value={form.routingNumber}
              inputMode="numeric" maxLength={9}
              onChange={e => setForm(f => ({ ...f, routingNumber: e.target.value }))} />
            {errors.routingNumber && <div style={{ fontSize: '.68rem', color: 'var(--red)', marginTop: 4 }}>{errors.routingNumber}</div>}
          </div>
          <div>
            <label style={lbl}>Account #</label>
            <input className="input" style={{ width: '100%' }} value={form.accountNumber}
              inputMode="numeric"
              onChange={e => setForm(f => ({ ...f, accountNumber: e.target.value }))} />
            {errors.accountNumber && <div style={{ fontSize: '.68rem', color: 'var(--red)', marginTop: 4 }}>{errors.accountNumber}</div>}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Confirm Account #</label>
          <input className="input" style={{ width: '100%' }} value={form.confirm_accountNumber}
            inputMode="numeric"
            onChange={e => setForm(f => ({ ...f, confirm_accountNumber: e.target.value }))} />
          {errors.confirm_accountNumber && <div style={{ fontSize: '.68rem', color: 'var(--red)', marginTop: 4 }}>{errors.confirm_accountNumber}</div>}
        </div>

        {errors.submit && (
          <div style={{ color: 'var(--red)', fontSize: '.78rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            {errors.submit}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={mut.isLoading}>
            {mut.isLoading ? <span className="spinner" /> : <><Check size={14} /> Add Account</>}
          </button>
        </div>
      </div>
    </div>
  )
}
