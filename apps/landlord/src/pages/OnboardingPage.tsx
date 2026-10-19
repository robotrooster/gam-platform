import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { EntityPicker, useEntities } from '../components/EntityPicker'
// 10/19 (Nic): "Merge it all so it's one flow for any other landlords that
// onboard." The two bank steps below render the SAME components as the Bank
// setup tab (pages/BankSetup.tsx), so there is one implementation of each step
// and the wizard can never drift from the page a landlord comes back to.
import {
  PayoutVerifyStep, BankFeedLinkStep, useConnectStatus, payoutsLive,
} from './BankSetup'
import { companiesMissingPayouts, payoutsReadyFor, type PayoutCompany } from '../lib/payoutReadiness'
import {
  Check, Building2, CreditCard, FileText, User,
  ChevronRight, ChevronLeft,
  Landmark, Plus, LayoutGrid
} from 'lucide-react'
import {
  PROCESSING_FEE_CHOICES, PROCESSING_FEE_CHOICE_LABEL, PROCESSING_FEE_CHOICE_HINT,
  UNIT_TYPES, UNIT_TYPE_LABEL,
  EARLY_DEPARTURE_REFUNDS_QUESTION, EARLY_DEPARTURE_REFUNDS_HINT,
  MID_MONTH_PRORATION_QUESTION, MID_MONTH_PRORATION_HINT,
} from '@gam/shared'

const STEPS = [
  { id: 'profile',    label: 'Business Profile', icon: User,      desc: 'Tell us about yourself and your business' },
  { id: 'property',   label: 'First Property',   icon: Building2, desc: 'Add your first property to the platform' },
  // S605 (Nic, DIRECTIVE): units come BEFORE either bank step. "It's weird to
  // ask for bank information when they haven't had a chance to initiate or
  // immerse themselves into the platform." Asking for bank details from someone
  // who has entered a name and an address — and seen nothing of their own
  // portfolio yet — reads like a payment wall, not onboarding. Adding units is
  // the first moment the platform reflects THEIR property back at them, so the
  // money questions land after they have something to be paid for.
  { id: 'units',      label: 'Add Your Units',    icon: LayoutGrid,desc: 'Add the units at this property — you can refine them later' },
  { id: 'banking',    label: 'Get Paid',          icon: CreditCard,desc: 'Verify your business so rent can reach your bank' },
  // S605 (Nic, DIRECTIVE): the bank feed is NOT optional. "No landlord is gonna
  // be able to get their PNLs accurate if they can't reconcile the bank
  // transactions." Its own step, after the payout account so the two bank
  // moments read as distinct: money OUT to you, then your spending IN.
  { id: 'bankfeed',   label: 'Connect Your Bank', icon: Landmark,  desc: 'Link your operating bank so your expenses land in your P&L' },
  { id: 'agreement',  label: 'Sign Agreement',    icon: FileText,  desc: 'Review and sign the platform agreement' },
]

// S604 (Nic): EIN and phone accepted anything — "let's lock it so I can't just
// type in fifty freaking numbers". Format as the landlord types and cap at the
// real length. EIN is ALWAYS 9 digits (XX-XXXXXXX); US phone is 10.
function formatEin(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 9)
  return d.length > 2 ? `${d.slice(0, 2)}-${d.slice(2)}` : d
}
function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 10)
  if (d.length <= 3) return d
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

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
  // S513 (#2): landlord's onboarding ACH fee election. Default false = tenant
  // pays ACH (the launch default). Card is always the tenant's — not a choice.
  const [coverFees, setCoverFees] = useState(false)

  // Profile form
  const [profile, setProfile] = useState({ businessName: '', ein: '', phone: '', street1: '', city: '', state: '', zip: '' })
  // Property form
  // 10/18 (Nic): the two departure answers start at Yes — the way every
  // property on GAM already works — so a landlord who skips past them is set up
  // the same as everyone else, and only a deliberate No changes anything.
  const [property, setProperty] = useState({ name: '', street1: '', street2: '', city: '', state: '', zip: '', type: 'residential', refundsEarlyDeparture: true, proratesMidMonth: true, firstBillingCycle: (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })() })
  const [errors, setErrors] = useState<Record<string, string>>({})

  // S637 (Nic, DIRECTIVE): "Get Paid" means the STRIPE CONNECT ACCOUNT, and
  // nothing else counts as done. (The long note on why lives below, at
  // bankReady.) Resolved here, ABOVE the feed read, because the feed read needs
  // to say which company's bank it is asking about.
  const { data: entities = [] } = useEntities()
  const ownedEntities = (entities as Array<PayoutCompany & { isOwner?: boolean }>)
    .filter(e => e.isOwner)
  const payoutEntityId = ownedEntities.length === 1 ? ownedEntities[0].id : ''
  // 10/19 (Nic): an account that owns several companies can say which one here,
  // the same way the Bank page does, instead of being sent off to pick on
  // another screen. One company needs no choosing (EntityPicker renders
  // nothing), so a fresh signup sees no extra control.
  const [bankEntityId, setBankEntityId] = useState('')
  const bankEntity = bankEntityId || payoutEntityId

  // S637: the bank-account CATALOG no longer gates onboarding — "Get Paid" is
  // answered by the Stripe Connect account (payoutsReady below). 10/12 (Nic):
  // and the catalog's add form is gone from this page and the Banking page.
  // S605: the operating-bank feed. Polls while the landlord is on that step so
  // the screen flips to "connected" the moment Stripe's window closes.
  //
  // 10/19 (review): THIS READ NAMED NO COMPANY, and the API cannot answer
  // "which of your companies?" — it returns 400 for an account that owns two or
  // more (routes/bankFeed.ts scope → lib/landlordScope.resolveLandlordTarget).
  // So for anyone in Blu's position the list came back empty forever: the link
  // really happened (step 2 does send the company), the wizard kept reading
  // "Not done", Continue stayed greyed out and Sign Agreement stayed locked.
  // A dead end on the one screen that activates the account.
  //
  // The SAME query key the Bank page uses, so linking on either screen
  // refreshes both (BankSetup.useLinkBankFeed invalidates 'bank-connections').
  const { data: feedConnections = [], refetch: refetchFeed } = useQuery<any[]>(
    ['bank-connections', bankEntity],
    () => apiGet(`/bank-feed/connections?entityId=${encodeURIComponent(bankEntity)}`),
    { enabled: !!bankEntity, refetchInterval: step === 4 ? 4000 : false },
  )
  const feedLinked = feedConnections.some((c: any) => c.status === 'active')
  // 10/12 (Nic): the feed is step 4. This marked 3 — Get Paid — so linking the
  // read-only feed put a green check and "Complete" on Get Paid with no Stripe
  // payouts behind it: the same feed-for-payouts mix-up S637 describes. Left
  // over from S649 inserting Add Your Units at index 2.
  useEffect(() => { if (feedLinked) setCompleted(prev => new Set([...prev, 4])) }, [feedLinked])
  // S637 (Nic, DIRECTIVE): "Get Paid" means the STRIPE CONNECT ACCOUNT, and
  // nothing else counts as done.
  //
  // This step used to be satisfied by adding a row to GAM's own bank catalog —
  // type a routing and account number, see a green tick, move on. But rent pays
  // out through Connect, and that catalog row reaches payouts for nobody: it
  // serves PM-company payouts and owner distributions. So a landlord typed their
  // bank details, was told they were set up to get paid, and wasn't. Dusty
  // Rhoades did exactly that at 1:44pm, then hit the feed step, tried to link
  // the same Wells Fargo account a second time, and locked himself out of his
  // own bank — for a step that was never his payout account to begin with.
  //
  // Nic: "Both places where they connect an account... should just take them to
  // the connect account. The feed can come after."
  //
  // 10/12: and the COMPANY's Connect account. This asked about entity=user —
  // the account's own user-level Connect id — but since S554 an owner verifies
  // the landlord company (entity=landlord), so a landlord who finished Stripe
  // was still told "Set up payouts" here. Ask about the company this account
  // owns. With one owned company (every fresh signup) that is its live Stripe
  // status; with several, the same rule as the owner to-do list
  // (/landlords/me/todos).
  // 10/12 (Nic): that rule is now "every company with a property can be paid"
  // (lib/payoutReadiness.ts) — "any of them can be paid" let a paid company
  // answer for one that holds a property and has no Stripe account.
  // 10/19: the SAME query key the Bank page and the feed use, so one answer
  // drives the wizard's green check and the step's own panel.
  const connectStatusQ = useConnectStatus(bankEntity, true, { refetchInterval: 15000 })
  const payoutsReady = bankEntity
    ? payoutsLive(connectStatusQ.data)
    : payoutsReadyFor(ownedEntities)
  const unpaidOwned = companiesMissingPayouts(ownedEntities)
  const bankReady = payoutsReady
  // 10/12 (Nic): Get Paid is step 3. This marked 2 (Add Your Units), the same
  // S649 off-by-one as the feed marker above.
  useEffect(() => {
    if (bankReady) setCompleted(prev => new Set([...prev, 3]))
  }, [bankReady])

  // S629: the entity gets its NAME here, at the first moment the landlord
  // tells us what it is. Everything downstream — the property form's entity
  // picker, the banking page's "paying out for", the co-owner invitations —
  // names entities to a person, and a nameless one reads as a system artifact
  // they did not create and cannot identify.
  //
  // Stripe also syncs the legal name back on Connect completion, but that can
  // be days later or never, and until then the landlord is choosing between
  // "Unnamed entity" and a property that quietly files itself somewhere.
  const saveProfileMut = useMutation(
    () => apiPatch('/landlords/me', { businessName: profile.businessName.trim() }),
    {
      onSuccess: () => {
        qc.invalidateQueries('landlord-entities')
        setCompleted(prev => new Set([...prev, 0]))
        setStep(1)
      },
      onError: (e: any) =>
        setErrors({ businessName: e?.response?.data?.error?.message || 'Could not save that name.' }),
    })

  const addPropertyMut = useMutation(
    (data: any) => apiPost('/properties', data),
    { onSuccess: (r: any) => {
      // S604: the property IS created server-side, but react-query is still
      // holding the empty 'properties' list it cached while the landlord was
      // mid-onboarding. Without this invalidation the Properties page and the
      // Units page both render "Add your first property" for a landlord who
      // just added one — the data is on the server, the browser is showing a
      // stale cache. Units/dashboard are invalidated too since both derive
      // from the property list.
      qc.invalidateQueries('properties')
      qc.invalidateQueries('units')
      qc.invalidateQueries('dashboard')
      // S605: the units step needs the id of the property just created.
      const pid = (r as any)?.data?.data?.id ?? (r as any)?.data?.id ?? null
      if (pid) setNewPropertyId(pid)
      setCompleted(prev => new Set([...prev, 1])); setStep(2)
    } }
  )

  // ── S605: units step ──────────────────────────────────────────────────────
  // Deliberately the SHORT form. The full unit editor (subtypes, amp service,
  // inspection features, per-type late fees) lives on the Units page; forcing
  // all of it here would trade one friction point for a worse one. This asks
  // only what can't be inferred — what to call them, what they are, how many,
  // and the rent — and says plainly that the rest can wait.
  // Set when the property is created in THIS pass. A landlord who leaves and
  // comes back has no such id, so fall back to the property they already have —
  // otherwise resuming onboarding leaves the Add button permanently disabled.
  const [newPropertyId, setNewPropertyId] = useState<string | null>(null)
  const { data: existingProps = [] } = useQuery<any[]>('properties', () => apiGet('/properties'), { enabled: step >= 2 })
  const targetPropertyId = newPropertyId ?? (existingProps as any[])[0]?.id ?? null
  const [unitDraft, setUnitDraft] = useState({ unitNumber: '', unitType: 'apartment', quantity: 1, rentAmount: '' })

  const { data: existingUnits = [] } = useQuery<any[]>('units', () => apiGet('/units'), { enabled: step >= 2 })
  const unitCount = (existingUnits as any[]).length

  const addUnitsMut = useMutation(
    (data: any) => apiPost('/units', data),
    { onSuccess: () => {
        qc.invalidateQueries('units'); qc.invalidateQueries('dashboard')
        setUnitDraft({ unitNumber: '', unitType: 'apartment', quantity: 1, rentAmount: '' })
      } }
  )

  const completeMut = useMutation(
    () => apiPost('/landlords/complete-onboarding', { signature, agreedAt: new Date().toISOString(), coverFees, propertyId: targetPropertyId }),
    { onSuccess: async () => {
      await refresh?.()
      // S604: same reason as addPropertyMut — everything downstream of the
      // property list is stale by the time onboarding finishes.
      qc.invalidateQueries()
      navigate('/dashboard')
    }}
  )

  const validate = (stepIdx: number) => {
    const errs: Record<string, string> = {}
    if (stepIdx === 0) {
      // S629 (Nic): "there's no default blank spot." This field was collected
      // and then thrown away — never validated, never sent — which is where
      // every blank entity on a self-serve signup came from. The landlord
      // typed their LLC name on the first screen and the system kept a
      // nameless one, then offered it back to them as "Unnamed entity".
      if (!profile.businessName.trim()) errs.businessName = 'Entity name required'
      if (!profile.phone.trim()) errs.phone = 'Phone required'
    }
    if (stepIdx === 1) {
      if (!property.name.trim()) errs.propName = 'Property name required'
      if (!property.street1.trim()) errs.street1 = 'Address required'
      if (!/^\d{4}-\d{2}$/.test(property.firstBillingCycle || '')) errs.firstBillingCycle = 'Pick the month GAM sends the first bill'
      if (!property.city.trim()) errs.city = 'City required'
      if (!property.zip.trim()) errs.zip = 'ZIP required'
    }
    // 10/12: the agreement is step 5. At 4 this demanded a signature on the
    // bank-feed step — Next there silently did nothing — and never checked
    // the agreement itself (another S649 off-by-one).
    if (stepIdx === 5) {
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
      saveProfileMut.mutate()
    } else if (step === 1) {
      addPropertyMut.mutate(property)
    } else if (step === 2) {
      // S605 (Nic): units gate the money steps — see the STEPS comment.
      if (unitCount > 0) {
        setCompleted(prev => new Set([...prev, 2]))
        setStep(3)
      }
    } else if (step === 3) {
      if (bankReady) {
        setCompleted(prev => new Set([...prev, 3]))
        setStep(4)
      }
    } else if (step === 4) {
      // Advances once a bank is linked, or once the step has been skipped —
      // see the disabled rule on the Continue button.
      if (feedLinked || completed.has(4)) {
        setCompleted(prev => new Set([...prev, 4]))
        setStep(5)
      }
    } else if (step === 5) {
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
            Complete all {STEPS.length} steps to activate your portfolio.
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
                    Entity Name
                  </label>
                  <input className="input" placeholder="Smith Properties LLC" value={profile.businessName} onChange={e => setProfile(p => ({ ...p, businessName: e.target.value }))} style={{ width: '100%' }} />
                  {/* S629: was "(optional)", so anyone operating in their own
                      name left it blank and got a nameless entity they never
                      asked for. Required now, and the copy says what to put
                      when there is no LLC — the honest answer is their name. */}
                  <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 4 }}>
                    The LLC, partnership, or trust that owns the property. If you own it in your own
                    name, use your name — you can add more entities later, and each one keeps its own
                    bank account.
                  </div>
                  {errors.businessName && (
                    <div style={{ fontSize: '.68rem', color: 'var(--red)', marginTop: 4 }}>{errors.businessName}</div>
                  )}
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
                    EIN / Tax ID <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional — required for 1099 at tax time)</span>
                  </label>
                  <input className="input" placeholder="XX-XXXXXXX" inputMode="numeric" value={profile.ein}
                    onChange={e => setProfile(p => ({ ...p, ein: formatEin(e.target.value) }))} style={{ width: '100%' }} />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Phone Number *</label>
                  <input className="input" type="tel" placeholder="(555) 000-0000" inputMode="numeric" value={profile.phone}
                    onChange={e => setProfile(p => ({ ...p, phone: formatPhone(e.target.value) }))} style={{ width: '100%' }} autoFocus />
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
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>First bill from GAM *</label>
                  <input type="month" className="input" value={property.firstBillingCycle} onChange={e => setProperty(p => ({ ...p, firstBillingCycle: e.target.value }))} style={{ width: 180 }} />
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5 }}>GAM sends the first bill for this month and nothing earlier. Existing residents you add mid-month get their first bill here; what happened before stays outside GAM.</div>
                  {errors.firstBillingCycle && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.firstBillingCycle}</div>}
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

                {/* 10/18 (Nic): "these should all be property level settings."
                    Every landlord choice belongs in this one form, so the two
                    departure answers are asked here, where the property is
                    made — not left to be found on a settings page later. Both
                    start at Yes, the way every property already works. */}
                <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 16, marginBottom: 14 }}>
                  <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 12 }}>When someone leaves early</div>
                  {([
                    { key: 'refundsEarlyDeparture' as const, q: EARLY_DEPARTURE_REFUNDS_QUESTION, hint: EARLY_DEPARTURE_REFUNDS_HINT },
                    { key: 'proratesMidMonth' as const, q: MID_MONTH_PRORATION_QUESTION, hint: MID_MONTH_PRORATION_HINT },
                  ]).map((row, i) => {
                    const on = property[row.key]
                    return (
                      <div key={row.key} style={{ marginBottom: i === 0 ? 16 : 0 }}>
                        <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 7 }}>{row.q}</div>
                        <div style={{ display: 'flex', gap: 10 }}>
                          {[true, false].map(v => (
                            <button key={String(v)} type="button" onClick={() => setProperty(p => ({ ...p, [row.key]: v }))}
                              style={{ flex: 1, textAlign: 'center', padding: '9px 14px', borderRadius: 10, cursor: 'pointer',
                                fontSize: '.82rem', fontWeight: 700,
                                color: on === v ? 'var(--gold)' : 'var(--text-1)',
                                background: on === v ? 'rgba(201,162,39,.1)' : 'var(--bg-1)',
                                border: on === v ? '1.5px solid var(--gold)' : '1px solid var(--border-0)' }}>
                              {v ? 'Yes' : 'No'}
                            </button>
                          ))}
                        </div>
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>{row.hint[on ? 'yes' : 'no']}</div>
                      </div>
                    )
                  })}
                </div>

                {addPropertyMut.isError && (
                  <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                    Failed to add property. Please try again.
                  </div>
                )}
              </div>
            )}

            {/* ── STEP 2: UNITS (S605) ── */}
            {step === 2 && (
              <div>
                <div style={{ background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 10, padding: '10px 14px', marginBottom: 20, fontSize: '.78rem', color: 'var(--gold)', lineHeight: 1.5 }}>
                  💡 Add the units at this property. Numbering a block at a time is fine —
                  add "RV" 1–3, then "Apt" 4–5, and so on. You can rename, re-type, and
                  set details for any of them later.
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.4fr .7fr 1fr', gap: 10, marginBottom: 14 }}>
                  <div>
                    <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Name / prefix *</label>
                    <input className="input" placeholder="RV" value={unitDraft.unitNumber}
                      onChange={e => setUnitDraft(u => ({ ...u, unitNumber: e.target.value }))} style={{ width: '100%' }} autoFocus />
                  </div>
                  <div>
                    <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Type *</label>
                    <select className="input" value={unitDraft.unitType}
                      onChange={e => setUnitDraft(u => ({ ...u, unitType: e.target.value }))} style={{ width: '100%' }}>
                      {UNIT_TYPES.map(t => <option key={t} value={t}>{UNIT_TYPE_LABEL[t]}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>How many *</label>
                    <input className="input" type="number" min={1} max={200} value={unitDraft.quantity}
                      onChange={e => setUnitDraft(u => ({ ...u, quantity: Math.max(1, Number(e.target.value) || 1) }))} style={{ width: '100%' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Rent each</label>
                    <input className="input" type="number" min={0} placeholder="850" value={unitDraft.rentAmount}
                      onChange={e => setUnitDraft(u => ({ ...u, rentAmount: e.target.value }))} style={{ width: '100%' }} />
                  </div>
                </div>

                <button className="btn btn-primary btn-sm"
                  disabled={!unitDraft.unitNumber.trim() || !targetPropertyId || addUnitsMut.isLoading}
                  onClick={() => addUnitsMut.mutate({
                    propertyId: targetPropertyId,
                    unitNumber: unitDraft.unitNumber.trim(),
                    unitType: unitDraft.unitType,
                    quantity: unitDraft.quantity,
                    ...(unitDraft.rentAmount ? { rentAmount: Number(unitDraft.rentAmount) } : {}),
                  })}>
                  <Plus size={14} /> {addUnitsMut.isLoading ? 'Adding…' : `Add ${unitDraft.quantity > 1 ? unitDraft.quantity + ' units' : 'unit'}`}
                </button>

                {addUnitsMut.isError && (
                  <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginTop: 12 }}>
                    {(addUnitsMut.error as any)?.response?.data?.error || 'Could not add those units. Please try again.'}
                  </div>
                )}

                <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--text-0)', marginBottom: 8 }}>
                    {unitCount === 0 ? 'No units yet' : `${unitCount} unit${unitCount === 1 ? '' : 's'} added`}
                  </div>
                  {unitCount > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {(existingUnits as any[]).slice(0, 40).map((u: any) => (
                        <span key={u.id} style={{ fontSize: '.72rem', padding: '3px 9px', borderRadius: 999, background: 'rgba(201,162,39,.1)', border: '1px solid rgba(201,162,39,.25)', color: 'var(--gold)' }}>
                          {u.unitNumber}
                        </span>
                      ))}
                      {unitCount > 40 && <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>+{unitCount - 40} more</span>}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── STEP 3: GET PAID (Stripe Connect) ── */}
            {/* S649: this was `step === 4` — the Bank Feed step's index — since
                Add Your Units was inserted ahead of it, so Get Paid rendered an
                empty screen with Next disabled (Nicholas Fausett, stuck). */}
            {/* 10/19 (Nic): "Merge it all so it's one flow." This step used to
                be a pitch with a button that navigated AWAY to the Disbursement
                Account page to do the actual Stripe verification — the second
                sign-up Nic was asking about. It renders the real step now, the
                same component as the Bank setup tab, so the landlord finishes
                here without leaving and the two screens cannot drift. */}
            {step === 3 && (
              <div>
                <EntityPicker value={bankEntity} onChange={setBankEntityId} label="Bank setup for"
                  note="Each company has its own bank account — both bank steps are done once per company." />
                <PayoutVerifyStep entityId={bankEntity} isOwner
                  otherUnpaid={unpaidOwned.filter(e => e.id !== bankEntity)} />
                {!payoutsReady && (
                  <div style={{ textAlign: 'center', marginBottom: 8 }}>
                    {/* Skipping payouts also skips the bank feed — the feed is
                        only useful once money is actually moving, and offering
                        it first is what let people link the read-only feed
                        believing they had set up payouts. */}
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => { setCompleted(prev => new Set([...prev, 3, 4])); setStep(5) }}>
                      Skip for now — finish bank setup later
                    </button>
                  </div>
                )}

                {/* 10/5 (Nic): ONE choice per property for card and bank fees,
                    for everyone who pays there. Kept OUTSIDE the payouts-ready
                    branch on purpose — it is a pricing decision, answerable
                    whether or not payout setup is done. */}
                <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 12, padding: 18, marginTop: 8 }}>
                  <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>Card and bank payment fees</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
                    Do you want to pass them on, or cover them? It applies to everyone who pays at your property —
                    rent, the front counter, pay links and the booking site. You can change it on the property's page any time.
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {PROCESSING_FEE_CHOICES.map(v => {
                      const selected = (coverFees ? 'cover' : 'pass_on') === v
                      return (
                        <button key={v} type="button" onClick={() => setCoverFees(v === 'cover')}
                          style={{ flex: 1, textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                            background: selected ? 'rgba(201,162,39,.1)' : 'var(--bg-1)',
                            border: selected ? '1.5px solid var(--gold)' : '1px solid var(--border-0)' }}>
                          <div style={{ fontSize: '.82rem', fontWeight: 700, color: selected ? 'var(--gold)' : 'var(--text-0)' }}>{PROCESSING_FEE_CHOICE_LABEL[v]}</div>
                          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>{PROCESSING_FEE_CHOICE_HINT[v]}</div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* ── STEP 4: CONNECT YOUR BANK (read-only feed) ── */}
            {/* S605: required step — a landlord without this has no expense side
                to their P&L. Read-only; it cannot move money.
                10/19 (Nic): the same component as step 2 of Bank setup on the
                Bank page — one implementation, so the copy that explains why a
                read-only link is a SEPARATE bank permission from the payout
                account exists in one place. */}
            {step === 4 && (
              <div>
                {/* 10/19 (review): the step said "Choose the company above to
                    link its bank read-only" and there was nothing above it —
                    the picker was rendered only inside step 3. A landlord who
                    reached this step with several companies and none chosen
                    (Continue from step 3 is allowed when every company's
                    payouts are already live) read an instruction they could not
                    follow. Same control, same wording, both steps. */}
                <EntityPicker value={bankEntity} onChange={setBankEntityId} label="Bank setup for"
                  note="Each company has its own bank account — both bank steps are done once per company." />
                <BankFeedLinkStep entityId={bankEntity} linked={feedLinked}
                  needsCompany={!bankEntity}
                  linkedName={feedConnections.find((c: any) => c.status === 'active')?.displayName ?? null}
                  payoutBank={connectStatusQ.data?.payoutBank ?? null}
                  step1Done={payoutsReady}
                  onLinked={() => { refetchFeed() }} />
                {!feedLinked && (
                  <div style={{ textAlign: 'center', marginBottom: 8 }}>
                    {/* 10/19 (review): the same escape step 3 already offers,
                        reachable from the step somebody is actually stuck on.
                        Without it, a landlord whose bank Stripe cannot reach had
                        a greyed-out Continue, a locked Sign Agreement and no way
                        to activate the account at all. The feed is still not
                        optional — the Bank page says so on every tab until it is
                        done, and the owner to-do list keeps asking. */}
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => { setCompleted(prev => new Set([...prev, 4])); setStep(5) }}>
                      Skip for now — finish bank setup later
                    </button>
                  </div>
                )}
              </div>
            )}

            {step === 5 && (
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
                    { title: '3. Platform Fees', body: 'Occupied Units: $2.00 per occupied unit per month, subject to a $10.00 monthly minimum per connected payout account. A connected payout account corresponds to the legal entity or bank account that receives payouts; properties that share one connected account share a single minimum, while separate entities (for example, separate LLCs, each with its own connected account) each carry their own minimum. Vacant Units: $0.00 — vacant units are never charged. Short-Term Stays: for nightly or weekly bookings, space-only sites (RV spots, campsites, boat slips) are billed $2.00 per 30 booked nights, and furnished short stays (apartments, condos, motel/hotel rooms, and similar) are billed 3% of booking revenue; these amounts are additive to the occupied-unit fee and fall under the same $10.00 per-account monthly minimum. New-Landlord Grace: Platform does not charge the occupied-unit fee or the per-account minimum until Landlord goes live (the first rent payment settles through the Platform), up to a maximum of two billing cycles, so a Landlord switching from another platform does not pay both at once during onboarding. Card and ACH processing fees are paid by the Tenant and are never absorbed by Platform; at onboarding, Landlord may elect to cover its Tenants\' ACH fees, but card processing fees are always paid by the Tenant and are never covered by Landlord. Platform fees are billed monthly and deducted from Landlord payouts.' },
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
                disabled={addPropertyMut.isLoading || completeMut.isLoading || addUnitsMut.isLoading || (step === 2 && unitCount === 0) || (step === 3 && !bankReady && !completed.has(3)) || (step === 4 && !feedLinked && !completed.has(4))}
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
    </div>
  )
}
