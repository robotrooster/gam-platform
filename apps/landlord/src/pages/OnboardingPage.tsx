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
    () => apiPost('/landlords/complete-onboarding', { signature, agreedAt: new Date().toISOString() }),
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
            Complete all 4 steps to activate On-Time Pay for your portfolio.
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

          {/* SLA reminder */}
          <div style={{ marginTop: 32, padding: '12px 14px', background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 10 }}>
            <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--gold)', marginBottom: 6 }}>ON-TIME PAY SLA</div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.6 }}>
              Rent initiated to your account on the 1st business day — every month — regardless of when your tenant pays.
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
                        Test mode. No real money will move until attorney review is complete.
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
                    { title: '1. On-Time Pay SLA', body: 'Platform initiates ACH disbursement to Landlord\'s connected bank account on or before the first business day of each calendar month ("Disbursement Date") regardless of whether Tenant has remitted rent payment. This constitutes a Service Level Agreement between Landlord and Platform. This is NOT an insurance policy, surety bond, financial guarantee, or indemnification. Platform acts as Landlord\'s authorized collection agent.' },
                    { title: '2. Platform Fees', body: 'Active/Occupied Units: $15.00/unit/month — includes On-Time Pay SLA and full platform access. Direct Pay Units: $5.00/unit/month — dashboard access, no ACH processing. Vacant Units: $0.00/unit/month — auto-listed in vacancy marketplace at $1.00/unit/month listing fee. Fees are billed monthly and deducted from disbursements.' },
                    { title: '3. Reserve Fund', body: 'Platform maintains an operational working capital reserve to fund disbursements pending tenant ACH settlement. This reserve constitutes Platform\'s operational capital — it is NOT an insurance reserve, trust account, or escrow. Landlord retains all legal rights against Tenant for unpaid rent. Platform\'s disbursement obligation is a service commitment funded by operational reserves, not Landlord\'s capital.' },
                    { title: '4. Eviction Mode', body: 'In many jurisdictions, accepting any rent payment while pursuing eviction for that nonpayment may waive the right to proceed. Landlord is responsible for knowing and complying with their local eviction rules. Landlord must activate Eviction Mode before filing any eviction action. Activation hard-blocks all tenant ACH pulls from the affected unit. Landlord\'s On-Time Pay SLA is suspended for eviction-mode units. Platform is not liable for eviction complications arising from failure to activate Eviction Mode or from non-compliance with local laws.' },
                    { title: '5. ACH Authorization', body: 'Landlord authorizes Platform to initiate ACH debit entries from Tenant\'s bank account and ACH credit entries to Landlord\'s connected bank account. Landlord authorizes Platform to reverse erroneous entries. Platform complies with NACHA Operating Rules and Guidelines. Landlord agrees to promptly notify Platform of any unauthorized transactions.' },
                    { title: '6. Work Trade Arrangements', body: 'Where Landlord establishes Work Trade Agreements through the Platform, Landlord acknowledges that labor received in exchange for rent reduction may constitute taxable income to Tenant under IRS Publication 525. Landlord is responsible for issuing required 1099-NEC forms. Platform provides documentation tools only and does not provide tax advice.' },
                    { title: '7. Governing Law', body: 'This Agreement is governed by the laws of the state where Platform is headquartered. If any provision is held unenforceable, the remaining provisions remain in full force.' },
                    { title: '8. Pending Legal Review', body: 'This Agreement is pending review by licensed counsel. It does not constitute legal advice. Landlord is encouraged to have independent counsel review this Agreement before signing. Platform reserves the right to update this Agreement following attorney review, with 30 days notice to Landlord.' },
                  ].map(section => (
                    <div key={section.title} style={{ marginBottom: 16 }}>
                      <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>{section.title}</div>
                      <div>{section.body}</div>
                    </div>
                  ))}

                  <div style={{ borderTop: '1px solid var(--border-0)', paddingTop: 12, marginTop: 8, color: 'var(--amber)', fontStyle: 'italic', fontSize: '.72rem' }}>
                    This agreement is pending review by licensed counsel. Questions about this agreement should be directed to your own legal counsel.
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
                      I have read and understand the Landlord Platform Participation Agreement. I agree to the On-Time Pay SLA terms, platform fees, and all other provisions. I acknowledge this agreement is pending attorney review.
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
