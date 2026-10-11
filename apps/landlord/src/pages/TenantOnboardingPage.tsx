import { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
// S633: an import lands in ONE company. The account names it.
import { EntityPicker, useCompanyMissing } from '../components/EntityPicker'
import { WorkTradeTermsFields, defaultWorkTradeTerms, workTradeTermsPayload, type WorkTradeTerms } from '../components/WorkTradeTermsFields'
import { toast, appConfirm } from '../components/dialogs'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { canInviteToUnit, hiddenUnitReasons } from '../lib/inviteEligibility'
import { Upload, Download, FileText, AlertCircle, CheckCircle2, AlertTriangle, Inbox } from 'lucide-react'
import { api, apiPost, apiGet, apiPut, apiPatch, apiDelete } from '../lib/api'
import { UNIT_TYPE_LABEL, humanize, dueDayLabel } from '@gam/shared'

// S655: what checking a tenant file returns (POST /onboard-tenants-csv/validate).
type RosterIssue = { severity: 'block' | 'warn'; field?: string; message: string }
type RosterCsvRow = {
  rowIndex: number
  firstName: string; lastName: string; email: string; phone: string
  propertyName: string; unitNumber: string
  monthlyRent: string; outstandingBalance: string
  resolvedPropertyId?: string
  resolvedUnitId?: string
  unitRent?: number | null
  openingBalance?: number | null
  skip?: boolean
  issues: RosterIssue[]
}
type ValidateResponse = {
  rows: RosterCsvRow[]
  summary: { total: number; blockers: number; warnings: number; ready: number }
  // S537: (property, unit_type) pairs lacking a late-fee decision, each
  // with a suggested prefill = the file's most frequent (fee, grace) pair.
  missingLateFeeDecisions?: {
    propertyId: string; propertyName: string; unitType: string
    suggested: { initialAmount: number; graceDays: number; initialType: 'flat'; leaseCount: number; leaseTotal: number } | null
  }[]
}
// S655: what saving it as a draft roster returns (POST /onboard-tenants-csv/draft).
type DraftResponse = {
  saved: number
  updated: number
  properties: { propertyId: string; propertyName: string; count: number }[]
  notSaved: { rowIndex: number; email: string; name: string; reasons: string[] }[]
  /** S296: this platform's column mapping is still being checked by GAM. */
  escalateToSuperAdmin?: boolean
}

const PLATFORM_OPTIONS = [
  { value: 'generic',     label: 'Generic (GAM template)', enabled: true },
  { value: 'buildium',    label: 'Buildium',               enabled: true },
  { value: 'appfolio',    label: 'AppFolio',               enabled: true },
  { value: 'doorloop',    label: 'DoorLoop',               enabled: true },
  { value: 'yardi',       label: 'Yardi',                  enabled: true },
  { value: 'rentmanager', label: 'RentManager',            enabled: true },
  { value: 'propertyware',label: 'Propertyware',           enabled: true },
  { value: 'rentec',      label: 'Rentec Direct',          enabled: true },
  { value: 'tenantcloud', label: 'TenantCloud',            enabled: true },
]

type Mode = 'choose' | 'bulk' | 'single' | 'new_lease' | 'roster'

// S654: the API's reason lives in `error` (errorHandler). Reading only
// `message` hid every 400 behind a generic line.
const serverReason = (e: any, fallback: string): string =>
  e?.response?.data?.error || e?.response?.data?.message || fallback

const CHOOSE_COMPANY_FIRST = 'Choose the company this file belongs to first.'

// S579: shows every property whose onboarding window is still OPEN — how many
// days sitting tenants can still be grandfathered past screening — and lets the
// landlord close a property's window early. S654: also any property, window
// open or not, whose late-fee question is still unanswered. After close, every new tenant there
// must pass a background check (no reopen). Uses an inline two-step confirm (no
// native dialogs — Safari/webviews drop them).
function OnboardingWindowsBanner({ onOpenRoster }: { onOpenRoster: (propertyId: string) => void }) {
  const qc = useQueryClient()
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  // S654 (review): a closed-window property answered here stays on screen with
  // its answer marked, so a mistaken tap can be switched — no other screen sets it.
  const [answeredHere, setAnsweredHere] = useState<Set<string>>(new Set())
  const { data: windows = [] } = useQuery<any[]>('onboarding-windows', () => apiGet('/landlords/me/onboarding-windows'))
  const completeMut = useMutation(
    (propertyId: string) => apiPost(`/properties/${propertyId}/onboarding-complete`, {}),
    {
      onSuccess: () => { setConfirmingId(null); qc.invalidateQueries('onboarding-windows'); qc.invalidateQueries(['ob-window']) },
      // S655: refused while the property's draft roster has people nobody has
      // confirmed — say so, with the next step, and show the fresh state.
      onError: (e: any) => {
        setConfirmingId(null)
        toast(serverReason(e, 'Onboarding could not be marked complete. Try again.'))
        qc.invalidateQueries('onboarding-windows')
      },
    },
  )
  // S648 (Nic): waiving late fees while residents migrate is the landlord's
  // call, per property. Unanswered = residents are billed late fees.
  const all = (windows as any[]).filter(Boolean)
  const waiverMut = useMutation(
    ({ propertyId, waive }: { propertyId: string; waive: boolean }) =>
      apiPatch(`/properties/${propertyId}/onboarding-late-fee-waiver`, { waive }),
    {
      onSuccess: (_d, { propertyId, waive }) => {
        qc.invalidateQueries('onboarding-windows')
        const w = all.find(x => x.propertyId === propertyId)
        if (w && !w.open) {
          setAnsweredHere(prev => new Set(prev).add(propertyId))
          toast(`${w.propertyName}: ${waive ? 'late fees waived' : 'late fees apply'} on each resident's first bill. You can still switch it here.`)
        }
      },
      onError: (e: any) => toast(serverReason(e, 'Could not save that answer. Try again.')),
    },
  )
  const openWins = all.filter(w => w.open)
  // S654: Country Acres' window closed before this question shipped, so it could
  // never be answered and its residents' first bills would carry late fees by
  // default. An unanswered property keeps the question after its window closes;
  // "Mark onboarding complete" stays limited to open windows.
  const unansweredClosed = all.filter(w => !w.open && (w.lateFeeWaiver == null || answeredHere.has(w.propertyId)))
  if (openWins.length === 0 && unansweredClosed.length === 0) return null

  // S655 (Nic, 10/2): the first-bill late-fee waiver is the landlord's call,
  // never a platform rule. Late in the month (after the 20th, or with the
  // first bill close) residents who take a few days to sign up land right on
  // that bill, so the question is flagged prominently then.
  const waiverQuestion = (w: any) => (
    <div style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '.78rem',
                  ...(w.lateInMonth ? { background: 'rgba(201,162,39,.12)', border: '1px solid var(--gold)', borderRadius: 8, padding: '10px 12px' } : {}) }}>
      {w.lateInMonth ? (
        <span style={{ flexBasis: '100%', color: 'var(--text-0)', fontWeight: 700, fontSize: '.84rem', lineHeight: 1.5 }}>
          You&apos;re onboarding late in the month. If your tenants take some time to get signed up, do you want to
          waive their first late fee on GAM?
          {w.nextRentDueDate && (
            <span style={{ display: 'block', fontWeight: 400, fontSize: '.74rem', color: 'var(--text-2)' }}>
              Rent at {w.propertyName} is next due {new Date(w.nextRentDueDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.
            </span>
          )}
        </span>
      ) : (
        <span style={{ color: w.lateFeeWaiver == null ? 'var(--gold)' : 'var(--text-2)' }}>
          Waive late fees on each resident&apos;s first bill while they move over?
        </span>
      )}
      {/* Unanswered: both are actions (gold). Answered: the saved one gold, the other the switch. */}
      <button className={`btn btn-sm ${w.lateFeeWaiver === true || w.lateFeeWaiver == null ? 'btn-primary' : 'btn-ghost'}`}
        disabled={waiverMut.isLoading}
        onClick={() => waiverMut.mutate({ propertyId: w.propertyId, waive: true })}>Yes, waive</button>
      <button className={`btn btn-sm ${w.lateFeeWaiver === false || w.lateFeeWaiver == null ? 'btn-primary' : 'btn-ghost'}`}
        disabled={waiverMut.isLoading}
        onClick={() => waiverMut.mutate({ propertyId: w.propertyId, waive: false })}>No, charge them</button>
      {w.lateFeeWaiver == null && (
        <span style={{ color: 'var(--text-3)' }}>Not answered yet, so late fees apply.</span>
      )}
    </div>
  )

  return (
    <div style={{ background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.3)', borderRadius: 10, padding: '14px 16px', marginBottom: 20 }}>
      {openWins.length > 0 && <>
      <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--gold)', marginBottom: 8 }}>Onboarding window open</div>
      <div style={{ fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 10 }}>
        While a property&apos;s window is open you can grandfather existing residents past the background check. New applicants are always screened.
      </div>
      {openWins.map(w => (
        <div key={w.propertyId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: '1px solid var(--border-0)', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '.82rem', color: 'var(--text-1)' }}>
            <strong style={{ color: 'var(--text-0)' }}>{w.propertyName}</strong>
            {typeof w.daysRemaining === 'number' && <> — <span style={{ color: 'var(--gold)', fontWeight: 700 }}>{w.daysRemaining} day{w.daysRemaining === 1 ? '' : 's'}</span> left</>}
          </div>
          {waiverQuestion(w)}
          {/* S655: a draft roster is reviewed and confirmed before the window
              closes — closing it first would send every one of those sitting
              residents to a background check. */}
          {w.draftRosterCount > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.74rem', color: 'var(--text-2)' }}>
                {w.draftRosterCount} {w.draftRosterCount === 1 ? 'person' : 'people'} on the draft roster to confirm first.
              </span>
              <button className="btn btn-primary btn-sm" onClick={() => onOpenRoster(w.propertyId)}>Review roster</button>
            </div>
          ) : confirmingId === w.propertyId ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: '.74rem', color: 'var(--text-2)' }}>Close now? New tenants will be screened.</span>
              <button className="btn btn-primary btn-sm" disabled={completeMut.isLoading} onClick={() => completeMut.mutate(w.propertyId)}>Confirm</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(null)}>Cancel</button>
            </div>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => setConfirmingId(w.propertyId)}>Mark onboarding complete</button>
          )}
        </div>
      ))}
      </>}
      {unansweredClosed.length > 0 && <>
        <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--gold)', marginBottom: 8, marginTop: openWins.length > 0 ? 14 : 0 }}>
          Late fees on residents&apos; first bill
        </div>
        <div style={{ fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 10 }}>
          This question was never answered for {unansweredClosed.length === 1 ? 'this property' : 'these properties'}. Until it is, late fees apply.
        </div>
        {unansweredClosed.map(w => (
          <div key={w.propertyId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid var(--border-0)', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '.82rem', color: 'var(--text-1)' }}>
              <strong style={{ color: 'var(--text-0)' }}>{w.propertyName}</strong>
            </div>
            {waiverQuestion(w)}
          </div>
        ))}
      </>}
    </div>
  )
}

export function TenantOnboardingPage() {
  // S629 (Nic): the unit detail page links straight here with the unit already
  // chosen. Landing on the mode chooser with an empty unit dropdown, after
  // clicking "Invite to sign a lease" ON a unit, is a step backwards.
  const [sp, setSp] = useSearchParams()
  // Read ONCE. ?unit= means "expand this one, I just came from it" — an
  // instruction about this arrival, not a property of the page.
  const [deepLinkUnit] = useState(() => sp.get('unit') ?? '')
  const deepLinkProperty = sp.get('property') ?? ''
  const [mode, setMode] = useState<Mode>(deepLinkUnit || deepLinkProperty ? 'new_lease' : 'choose')
  // S655: which property's draft roster to open.
  const [rosterProperty, setRosterProperty] = useState('')
  const openRoster = (propertyId: string) => { setRosterProperty(propertyId); setMode('roster') }
  const { data: rosterSummary } = useQuery<any>('tenant-roster-summary',
    () => apiGet('/landlords/me/tenant-roster'), { staleTime: 0, refetchOnWindowFocus: true })
  const rosterCount = ((rosterSummary?.properties ?? []) as any[]).reduce((n, p) => n + Number(p.count || 0), 0)

  // S629 (Nic): "when I click out and back into it, it wants to open with
  // mobile home six selected and expanded already... I've cleared the whole
  // list, I go back, I do a hard refresh, and it still keeps populating mobile
  // home six."
  //
  // Because ?unit= stayed in the URL, so every reload replayed an arrival that
  // happened once. Consumed after the first render: the card is already open
  // for this visit, and a refresh now opens the page clean. ?property= is
  // deliberately kept — the scope IS a property of the page, and losing it on
  // refresh would dump the whole portfolio back.
  useEffect(() => {
    if (!sp.get('unit')) return
    const next = new URLSearchParams(sp)
    next.delete('unit')
    setSp(next, { replace: true })
  }, [])
  const navigate = useNavigate()

  // Static pending count for the third mode card. staleTime 30s — mode picker
  // is a navigation surface, not a working surface. Click into the pool for
  // live state. Defensive against wrapped/unwrapped API response shapes.
  const { data: pendingCount = 0 } = useQuery(
    'pending-tenants-count',
    () => apiGet('/landlords/me/pending-tenants').then((r: any) => {
      const list = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : [])
      return list.length
    }),
    { staleTime: 30_000, refetchOnWindowFocus: false }
  )

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-0)', margin: 0 }}>
          Tenant Onboarding
        </h1>
        <p style={{ fontSize: '.88rem', color: 'var(--text-2)', marginTop: 6, lineHeight: 1.5 }}>
          Bring tenants who already live in your units onto GAM. During your property&apos;s
          onboarding window you can grandfather existing residents past the background check —
          after it closes, every new tenant is screened.
        </p>
      </div>

      <OnboardingWindowsBanner onOpenRoster={openRoster} />

      {mode === 'choose' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          <button
            onClick={() => setMode('new_lease')}
            style={{ textAlign: 'left', padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--gold)', cursor: 'pointer' }}
          >
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)', marginBottom: 6 }}>New Lease — Invite to Sign</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              Put a household on a unit. Their lease drafts right away from your setup and waits for
              your signature; they get one email when you sign it.
            </div>
          </button>

          <button
            onClick={() => setMode('bulk')}
            style={{ textAlign: 'left', padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', cursor: 'pointer' }}
          >
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)', marginBottom: 6 }}>Bulk CSV Import</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              Upload a spreadsheet of the tenants who live here now, from another platform or the
              GAM template. It becomes a draft roster you review — nobody is emailed by the upload.
            </div>
          </button>

          {rosterCount > 0 && (
            <button
              onClick={() => openRoster('')}
              style={{ textAlign: 'left', padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--gold)', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)' }}>Draft roster</div>
                <span className="badge badge-amber" style={{ fontSize: '.72rem' }}>{rosterCount} to review</span>
              </div>
              <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
                People from your uploaded file, waiting for you to check where they live and confirm.
              </div>
            </button>
          )}

          <button
            onClick={() => setMode('single')}
            style={{ textAlign: 'left', padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', cursor: 'pointer' }}
          >
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)', marginBottom: 6 }}>Add One Tenant</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              Type a single tenant info and lease terms. Best for adding one tenant
              at a time.
            </div>
          </button>

          <button
            onClick={() => navigate('/tenant-onboarding/pending')}
            style={{ textAlign: 'left', padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', cursor: 'pointer', position: 'relative' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Inbox size={16} style={{ color: 'var(--text-2)' }} />
                <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)' }}>Pending Pool</div>
              </div>
              {pendingCount > 0 && (
                <span className="badge badge-amber" style={{ fontSize: '.72rem' }}>
                  {pendingCount} pending
                </span>
              )}
            </div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              Tenants waiting on a lease document. Upload PDFs to complete onboarding.
            </div>
          </button>
        </div>
      )}

      {mode === 'bulk' && <BulkCsvMode onBack={() => setMode('choose')} onOpenRoster={openRoster} />}

      {mode === 'roster' && <RosterReviewMode key={rosterProperty} onBack={() => setMode('choose')} initialPropertyId={rosterProperty} />}

      {mode === 'new_lease' && <NewLeaseInviteMode onBack={() => setMode('choose')} initialUnitId={deepLinkUnit} initialPropertyId={deepLinkProperty} />}

      {mode === 'single' && (
        <SingleTenantMode
          onBack={() => setMode('choose')}
          onComplete={() => navigate('/tenant-onboarding/pending')}
        />
      )}
    </div>
  )
}

// S558 (Flow B): invite a tenant to a UNIT for a NEW lease they will sign.
// Unit-linked invite → the lease auto-drafts from the unit's default template
// on accept. Co-tenants: keep the same unit and invite again before anyone signs.
type Person = { firstName: string; lastName: string; email: string; phone: string }

// S652: the terms of a home sold on installments, as typed on the invite.
export type HomeSaleForm = { planType: 'flat' | 'amortized'; monthlyAmount: string; numberOfPayments: string;
  salePrice: string; downPayment: string; annualInterestRate: string; termMonths: string; startMonth: string }
export const emptyHomeSale = (): HomeSaleForm => ({ planType: 'flat', monthlyAmount: '', numberOfPayments: '',
  salePrice: '', downPayment: '0', annualInterestRate: '0', termMonths: '', startMonth: new Date().toISOString().slice(0, 7) + '-01' })
// S652 (Nic): "it's not gonna derive from anywhere." The invite only says the
// household is buying the home; the landlord TYPES the terms on the installment
// contract at signing and those become the sale record.
export const homeSalePayload = (_f: HomeSaleForm) => ({ selling: true })
export const homeSaleComplete = (_f: HomeSaleForm | null) => true

/**
 * S652 (Nic): "it needs to show the packet at the invite." The unit's default
 * package, as it will draft, pre-ticked — untick what does not apply. Same
 * checklist the e-sign page shows. `sale` re-asks the package as a sale so the
 * installment papers appear the moment the sale box is ticked.
 */
export function PacketChecklist({ unitId, sale, ticked, setTicked, initial, onUserChange }: {
  unitId: string; sale: boolean; ticked: Record<string, boolean> | null; setTicked: (v: Record<string, boolean>) => void
  /** S655: ticks saved earlier (a draft roster); left out, the package's own suggestion. */
  initial?: string[] | null
  /** S655: called only when the landlord ticks or unticks something. */
  onUserChange?: (v: Record<string, boolean>) => void
}) {
  const { data: pkg, isLoading } = useQuery<any>(['signing-package-for-unit', unitId, sale],
    () => apiGet(`/signing-packages/for-unit/${unitId}${sale ? '?sale=1' : ''}`), { enabled: !!unitId })
  // Pre-tick from the package's own judgment whenever the packet is (re)loaded.
  useEffect(() => {
    if (!pkg?.items) return
    const next: Record<string, boolean> = {}
    for (const i of pkg.items) next[i.templateId] = Array.isArray(initial) ? (initial.includes(i.templateId) || !!i.required) : !!i.suggested
    setTicked(next)
  }, [pkg])
  // S652 (Nic): "no packet yet — build one; not able to build one — take you
  // to the upload for your templates."
  const qc = useQueryClient()
  const [buildErr, setBuildErr] = useState<{ reason: string; needsLease: boolean } | null>(null)
  const build = useMutation(() => apiPost<any>(`/signing-packages/for-unit/${unitId}/build-default`, {}), {
    onSuccess: (r: any) => {
      const d = r?.data ?? r
      if (d?.packageId) { setBuildErr(null); qc.invalidateQueries(['signing-package-for-unit', unitId, sale]); qc.invalidateQueries('signing-packages') }
      else setBuildErr({ reason: d?.reason || 'Could not build the packet', needsLease: !!d?.needsLease })
    },
    onError: (e: any) => setBuildErr({ reason: e?.message || 'Could not build the packet', needsLease: false }),
  })
  if (isLoading) return <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 10 }}>Loading the packet…</div>
  if (!pkg?.items?.length) return (
    <div style={{ marginBottom: 10, padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--border-0)' }}>
      <div style={{ fontSize: '.78rem', color: 'var(--text-1)', lineHeight: 1.5, marginBottom: 8 }}>
        No packet is set for this kind of unit yet. Build one from your documents — the default lease plus every filled slot for this state and kind of space — and it becomes the packet for every invite like this one.
      </div>
      {buildErr ? (
        <div style={{ fontSize: '.74rem', color: 'var(--amber, #d97706)', lineHeight: 1.5 }}>
          {buildErr.reason}{' '}
          {buildErr.needsLease && <Link to="/esign" style={{ color: 'var(--gold)', fontWeight: 600 }}>Go to Templates</Link>}
        </div>
      ) : (
        <button type="button" className="btn btn-primary btn-sm" disabled={build.isLoading} onClick={() => build.mutate()}>
          {build.isLoading ? 'Building…' : 'Build the packet from my documents'}
        </button>
      )}
    </div>
  )
  const t = ticked ?? {}
  return (
    <div style={{ marginBottom: 10, padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--border-0)' }}>
      <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text-0)', marginBottom: 2 }}>{pkg.name}</div>
      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 8 }}>What they sign, in this order. Untick anything that doesn't apply.</div>
      {pkg.items.map((i: any) => (
        <label key={i.templateId} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '4px 0',
          cursor: i.required ? 'default' : 'pointer', opacity: i.required ? .85 : 1 }}>
          <input type="checkbox" checked={i.required ? true : !!t[i.templateId]} disabled={i.required}
            onChange={e => { const next = { ...t, [i.templateId]: e.target.checked }; setTicked(next); onUserChange?.(next) }} style={{ marginTop: 3 }} />
          <span>
            <span style={{ fontSize: '.78rem', color: 'var(--text-1)' }}>{i.templateName}</span>
            <span style={{ display: 'block', fontSize: '.68rem', color: 'var(--text-3)', marginTop: 1 }}>{i.reason}</span>
          </span>
        </label>
      ))}
    </div>
  )
}
export const tickedIds = (t: Record<string, boolean> | null) => t ? Object.entries(t).filter(([, v]) => v).map(([k]) => k) : undefined

/** "Are you adding a home to the sale?" — the invite's one question beyond who lives there. */
export function HomeSaleToggle({ sale, setSale }: { sale: HomeSaleForm | null; setSale: (v: HomeSaleForm | null) => void }) {
  const f = sale
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: '10px 14px', marginBottom: 10 }}>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input type="checkbox" checked={!!f} onChange={e => setSale(e.target.checked ? emptyHomeSale() : null)} style={{ marginTop: 3, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)' }}>Selling them this home on installments</div>
          <div style={{ fontSize: '.74rem', color: 'var(--text-2)', lineHeight: 1.5, marginTop: 2 }}>
            The packet drafts as a sale: the installment contract and the sale papers go in with the lot lease.
          </div>
        </div>
      </label>
      {f && (
        <div style={{ marginTop: 8, fontSize: '.74rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
          You type the price, the monthly payment and the number of payments on the installment contract when you sign it — that is what bills, and it stops after the last payment.
        </div>
      )}
    </div>
  )
}
const blankPerson = (): Person => ({ firstName: '', lastName: '', email: '', phone: '' })

/**
 * S629 (Nic): "I want everything onto one page. I want to type in these emails
 * for unit six and these emails for unit seven and these emails for unit eight
 * all on one page at the same time and then send it."
 *
 * A bulk form, not a queue of single forms. Every invitable unit is on the
 * page, every roster is open at once, and ONE button sends the lot.
 *
 * Two earlier shapes were wrong and are gone. Arriving from a unit's page used
 * to scope the page to that unit alone — you clicked unit six and could only
 * see unit six, which is the opposite of a worklist. And each card had its own
 * Send, which is thirty presses for thirty units. Now the deep-linked unit is
 * simply the one that starts expanded, and the send button is at the bottom of
 * the page.
 *
 * Rosters live HERE rather than inside each card, because one send button has
 * to see all of them.
 */
function NewLeaseInviteMode({ onBack, initialUnitId = '', initialPropertyId = '' }: {
  onBack: () => void; initialUnitId?: string; initialPropertyId?: string
}) {
  const qc = useQueryClient()
  const { data: allUnits = [] } = useQuery<any[]>('units', () => apiGet('/units'))

  // S629 (Nic): "it needs to be filtered per property... otherwise you're gonna
  // be scrolling down forever when you are onboarding lots of properties."
  //
  // One property at a time. Coming from a property or from one of its units
  // scopes it automatically; otherwise you pick, and a landlord with a single
  // property never sees the question.
  const properties = Array.from(
    new Map((allUnits as any[]).map(u => [u.propertyId, u.propertyName])).entries())
    .map(([id, name]) => ({ id, name: String(name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const unitProperty = initialUnitId
    ? (allUnits as any[]).find(u => u.id === initialUnitId)?.propertyId ?? ''
    : ''
  const [propertyId, setPropertyId] = useState(initialPropertyId || unitProperty)
  useEffect(() => {
    if (!propertyId && properties.length === 1) setPropertyId(properties[0].id)
    else if (!propertyId && unitProperty) setPropertyId(unitProperty)
  }, [properties.length, unitProperty])

  const inProperty = (allUnits as any[]).filter(u => u.propertyId === propertyId)
  const selectable = inProperty.filter(canInviteToUnit)
  const hiddenReasons = hiddenUnitReasons(inProperty)

  const [rosters, setRosters] = useState<Record<string, Person[]>>({})
  const [attest, setAttest] = useState<Record<string, boolean>>({})
  // S652 (Nic): "are you adding a home to the sale?" — per unit, on the invite,
  // only for a park-owned home. Terms travel with the invite so the packet
  // drafts as a sale before the landlord signs anything.
  const [sale, setSale] = useState<Record<string, HomeSaleForm | null>>({})
  // S652: the packet as the landlord left it ticked, per unit.
  const [packet, setPacket] = useState<Record<string, Record<string, boolean> | null>>({})
  // S652: each household's own due day, when it has one.
  const [dueDay, setDueDay] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<Record<string, boolean>>(
    initialUnitId ? { [initialUnitId]: true } : {})
  // S655: what each unit's invite did — who is on it, why a lease did not
  // draft (when it didn't), and who signs their own lease first.
  const [sent, setSent] = useState<Record<string, { names: string[]; blocked: string[]; ownSignature: string[]; invited: string[] }>>({})
  const [sending, setSending] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const rosterFor = (id: string) => rosters[id] ?? [blankPerson()]
  const setRoster = (id: string, next: Person[]) => setRosters(p => ({ ...p, [id]: next }))

  const complete = (p: Person) => !!(p.firstName && p.lastName && p.email)
  const untouched = (p: Person) => !p.firstName && !p.lastName && !p.email && !p.phone

  // Every unit with at least one fully filled person, and no half-filled one.
  const unitsReady = selectable.filter(u => {
    if (sent[u.id]) return false
    const typed = rosterFor(u.id).filter(p => !untouched(p))
    return typed.length > 0 && typed.every(complete)
  })
  const unitsHalfDone = selectable.filter(u => {
    if (sent[u.id]) return false
    const typed = rosterFor(u.id).filter(p => !untouched(p))
    return typed.length > 0 && !typed.every(complete)
  })
  const peopleReady = unitsReady.reduce(
    (n, u) => n + rosterFor(u.id).filter(p => !untouched(p)).length, 0)

  const blockedBecause =
    unitsHalfDone.length > 0
      ? `Unit${unitsHalfDone.length === 1 ? '' : 's'} ${unitsHalfDone.map(u => u.unitNumber).join(', ')}: ` +
        'every person needs a first name, last name and email. Phone is optional.'
      : unitsReady.length === 0 ? 'Fill in at least one unit.' : null

  /**
   * One press, every unit. S655: each unit's household goes in ONE call, so
   * its lease drafts once with everyone on it (one person at a time drafted,
   * voided and re-drafted the lease for every person added). A unit that fails
   * stays on the page with the reason and everyone still on it; units that
   * succeed drop off. Nobody is emailed: the leases wait for your signature.
   */
  const sendEverything = async () => {
    setSending(true); setErrors({})
    const nextSent: Record<string, { names: string[]; blocked: string[]; ownSignature: string[]; invited: string[] }> = {}
    const nextErrors: Record<string, string> = {}
    for (const u of unitsReady) {
      const people = rosterFor(u.id).filter(p => !untouched(p))
      try {
        const r: any = await apiPost<any>('/landlords/me/onboard-new-lease-tenant', {
          unitId: u.id, people,
          existingResident: attest[u.id] !== false,
          rentDueDay: attest[u.id] !== false && dueDay[u.id] ? Number(dueDay[u.id]) : undefined,
          homeSale: sale[u.id] ? homeSalePayload(sale[u.id]!) : undefined,
          packageTemplateIds: tickedIds(packet[u.id] ?? null),
        })
        const d = r?.data ?? {}
        nextSent[u.id] = {
          names: people.map(p => `${p.firstName} ${p.lastName}`.trim() || p.email),
          blocked: Array.isArray(d.draftBlocked) ? d.draftBlocked : [],
          ownSignature: (Array.isArray(d.people) ? d.people : []).filter((x: any) => x.needsOwnSignature).map((x: any) => x.name),
          // A lease that could not draft: these people got the usual invite instead.
          invited: (Array.isArray(d.people) ? d.people : []).filter((x: any) => !!x.notified).map((x: any) => x.name || x.email),
        }
      } catch (e: any) {
        nextErrors[u.id] = serverReason(e, 'This unit could not be invited. Try again.')
      }
    }
    setSent(prev => ({ ...prev, ...nextSent }))
    setErrors(nextErrors)
    setSending(false)
    qc.invalidateQueries('units')
  }

  // A unit deep-linked from its own page is always on the list, even if it has
  // an invite out: clicking "Invite to Sign a Lease" on a unit and landing on a
  // page that does not contain it is worse than showing it. Everything else
  // obeys the eligibility rule.
  const deepLinked = initialUnitId
    ? inProperty.filter(u => u.id === initialUnitId && !selectable.some(s => s.id === u.id))
    : []
  const remaining = [...deepLinked, ...selectable].filter(u => !sent[u.id])
  const byProperty = remaining.reduce((acc: Record<string, any[]>, u: any) => {
    (acc[u.propertyName] ||= []).push(u); return acc
  }, {})
  const sentUnitCount = Object.keys(sent).length

  return (
    <div style={{ maxWidth: 760, paddingBottom: 96 }}>
      <button onClick={onBack} className="btn btn-ghost" style={{ marginBottom: 16 }}>&larr; Back</button>

      <div style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-0)', margin: 0, marginBottom: 6 }}>Invite to sign a new lease</h2>
        <p style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5, margin: 0 }}>
          Fill in as many units as you like, then send them all at once. Each household&apos;s lease drafts
          right away from your setup and waits for your signature in Front Desk. Nobody is emailed until
          you sign their lease; then each person gets one email to set up their account and sign. Units drop
          off the list as they go.
        </p>
      </div>

      {properties.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <label className="form-label" style={{ margin: 0, fontSize: '.72rem' }}>Property</label>
          <select className="input" style={{ width: 'auto', minWidth: 260 }}
                  value={propertyId} onChange={e => setPropertyId(e.target.value)}>
            <option value="">Choose a property…</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>One property at a time.</span>
        </div>
      )}

      {!propertyId ? (
        <div className="card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-2)', fontSize: '.85rem' }}>
          Pick a property to see its units.
        </div>
      ) : (
      <>
      {sentUnitCount > 0 && (
        <div style={{ background: 'rgba(38,167,90,.08)', border: '1px solid rgba(38,167,90,.3)', borderRadius: 8,
                      padding: '10px 14px', marginBottom: 14, fontSize: '.8rem', color: 'var(--text-1)' }}>
          <strong style={{ color: 'var(--green)' }}>Done for {sentUnitCount} unit{sentUnitCount === 1 ? '' : 's'}:</strong>{' '}
          {Object.entries(sent).map(([id, r]) => {
            const u = (allUnits as any[]).find(x => x.id === id)
            return `${u ? `Unit ${u.unitNumber}` : 'unit'} (${r.names.join(', ')})`
          }).join(' · ')}
          {Object.values(sent).some(r => r.blocked.length === 0) && (
            <div style={{ marginTop: 4, color: 'var(--text-2)' }}>
              {Object.values(sent).some(r => r.blocked.length > 0) ? 'The leases that drafted are' : 'Their leases are'} waiting
              for your signature in <Link to="/front-desk" style={{ color: 'var(--gold)', fontWeight: 600 }}>Front Desk</Link>.
            </div>
          )}
          {Object.entries(sent).flatMap(([id, r]) => {
            const u = (allUnits as any[]).find(x => x.id === id)
            const label = u ? `Unit ${u.unitNumber}` : 'A unit'
            return [
              ...r.blocked.map((b, i) => (
                <div key={`${id}-b${i}`} style={{ marginTop: 4, color: 'var(--amber, #d97706)' }}>{label}: {b}</div>
              )),
              ...(r.blocked.length && r.invited.length ? [(
                <div key={`${id}-inv`} style={{ marginTop: 4, color: 'var(--text-2)' }}>
                  {label}: because the lease did not draft, {r.invited.join(', ')} {r.invited.length === 1 ? 'was' : 'were'} sent
                  the usual invite instead (an email to set up their account, or a notice in the GAM account they already use).
                </div>
              )] : []),
              ...(r.ownSignature.length ? [(
                <div key={`${id}-own`} style={{ marginTop: 4, color: 'var(--text-2)' }}>
                  {label}: {r.ownSignature.join(', ')} already {r.ownSignature.length === 1 ? 'has' : 'have'} a GAM account with
                  another company, so {r.ownSignature.length === 1 ? 'they sign' : 'each signs'} the lease themselves and it starts when they sign.
                </div>
              )] : []),
            ]
          })}
        </div>
      )}

      {remaining.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)', fontSize: '.85rem' }}>
          {sentUnitCount > 0 ? 'Every unit on this list has invites out. Nothing left to send.'
                             : 'No units are available to invite into right now.'}
          {hiddenReasons.length > 0 && (
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 6 }}>Not listed: {hiddenReasons.join(', ')}.</div>
          )}
        </div>
      ) : (
        <>
          {Object.entries(byProperty).map(([propertyName, units]) => (
            <div key={propertyName} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em' }}>
                  {propertyName} — {(units as any[]).length} unit{(units as any[]).length === 1 ? '' : 's'}
                </div>
                <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: '.7rem' }}
                  onClick={() => setOpen(prev => {
                    const next = { ...prev }
                    for (const u of units as any[]) next[u.id] = true
                    return next
                  })}>
                  Open all
                </button>
              </div>
              {(units as any[]).map(u => (
                <UnitInviteCard key={u.id} unit={u}
                  open={!!open[u.id]}
                  onOpen={() => setOpen(prev => ({ ...prev, [u.id]: true }))}
                  onClose={() => { setOpen(prev => ({ ...prev, [u.id]: false })); setRoster(u.id, [blankPerson()]) }}
                  people={rosterFor(u.id)}
                  setPeople={next => setRoster(u.id, next)}
                  attest={attest[u.id] !== false}
                  setAttest={v => setAttest(prev => ({ ...prev, [u.id]: v }))}
                  sale={sale[u.id] ?? null}
                  setSale={v => setSale(prev => ({ ...prev, [u.id]: v }))}
                  packet={packet[u.id] ?? null}
                  setPacket={v => setPacket(prev => ({ ...prev, [u.id]: v }))}
                  dueDay={dueDay[u.id] ?? ''}
                  setDueDay={v => setDueDay(prev => ({ ...prev, [u.id]: v }))}
                  error={errors[u.id] ?? null} />
              ))}
            </div>
          ))}
          {hiddenReasons.length > 0 && (
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 12 }}>Not listed: {hiddenReasons.join(', ')}.</div>
          )}

          {/* One send for the whole page. Sticky, because a bulk form whose
              button is below thirty units is a button nobody finds. */}
          <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg-1)', borderTop: '1px solid var(--border-0)',
                        padding: '12px 0', marginTop: 8 }}>
            <button type="button" className="btn btn-primary" style={{ width: '100%' }}
                    disabled={!!blockedBecause || sending} onClick={sendEverything}>
              {sending ? 'Drafting the leases…'
                : unitsReady.length === 0 ? 'Invite and draft the leases'
                : `Invite ${peopleReady} ${peopleReady === 1 ? 'person' : 'people'} and draft ${unitsReady.length} lease${unitsReady.length === 1 ? '' : 's'}`}
            </button>
            {blockedBecause && !sending && (
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 6, textAlign: 'center' }}>{blockedBecause}</div>
            )}
          </div>
        </>
      )}
      </>
      )}
    </div>
  )
}

/**
 * S652 (Nic): "they let their due date be whenever they come in." Someone who
 * already lives there is already due on SOME day, and the lease can't work it
 * out — their start date on GAM is not the day they moved in. Asked on the
 * invite, for existing residents only; left alone it follows the property.
 */
export function DueDayPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '.76rem', color: 'var(--text-2)', marginBottom: 10 }}>
      Their rent is due on
      <select className="input" value={value} onChange={e => onChange(e.target.value)}
        style={{ width: 'auto', minWidth: 170, fontSize: '.78rem', padding: '4px 8px' }}>
        <option value="">the property&apos;s usual day</option>
        {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>the {dueDayLabel(d)}</option>)}
      </select>
      <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
        Their meter is read the business day before, and late fees count from this day.
      </span>
    </label>
  )
}

/** S629: one unit's roster. Presentational — the page owns the data so a
 *  single send can see every unit at once. */
function UnitInviteCard({ unit, open, onOpen, onClose, people, setPeople, attest, setAttest, sale, setSale, packet, setPacket, dueDay, setDueDay, error }: {
  unit: any; open: boolean; onOpen: () => void; onClose: () => void
  dueDay: string; setDueDay: (v: string) => void
  people: Person[]; setPeople: (next: Person[]) => void
  attest: boolean; setAttest: (v: boolean) => void
  sale: HomeSaleForm | null; setSale: (v: HomeSaleForm | null) => void
  packet: Record<string, boolean> | null; setPacket: (v: Record<string, boolean>) => void
  error: string | null
}) {
  const { data: obWindow } = useQuery<any>(
    ['ob-window', unit.propertyId],
    () => apiGet(`/properties/${unit.propertyId}/onboarding-window`),
    { enabled: open && !!unit.propertyId, staleTime: 60_000 })
  const windowOpen = !!obWindow?.open

  const setField = (i: number, k: keyof Person, v: string) =>
    setPeople(people.map((p, idx) => idx === i ? { ...p, [k]: v } : p))

  const filled = people.filter(p => p.firstName || p.lastName || p.email || p.phone).length

  if (!open) {
    return (
      <div className="card" style={{ padding: '10px 14px', marginBottom: 8, display: 'flex',
                                     alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontSize: '.85rem', color: 'var(--text-1)' }}>
          <strong>Unit {unit.unitNumber}</strong>
          {unit.occupancyMode === 'by_room' && <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}> · by-room</span>}
          {filled > 0 && <span style={{ fontSize: '.72rem', color: 'var(--green)' }}> · {filled} added</span>}
        </div>
        <button className="btn btn-sm btn-primary" onClick={onOpen}>Add people</button>
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 14, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: '.85rem', fontWeight: 700, color: 'var(--text-0)' }}>Unit {unit.unitNumber}</div>
        <button className="btn btn-ghost btn-sm" style={{ fontSize: '.72rem' }} onClick={onClose}>Clear</button>
      </div>

      {obWindow && (windowOpen ? (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', marginBottom: 10 }}>
          <input type="checkbox" checked={attest} onChange={e => setAttest(e.target.checked)} style={{ marginTop: 3 }} />
          <span style={{ fontSize: '.74rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--text-1)' }}>Existing residents — skip background check.</strong>{' '}
            They already live here and will sign the new lease without screening.
            {typeof obWindow.daysRemaining === 'number' && <> Window closes in {obWindow.daysRemaining} day{obWindow.daysRemaining === 1 ? '' : 's'}.</>}
          </span>
        </label>
      ) : (
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
          Onboarding window closed — everyone invited here completes a background check before portal access.
        </div>
      ))}
      {windowOpen && attest && <DueDayPicker value={dueDay} onChange={setDueDay} />}

      {/* S652 (Nic): asked only for a park-owned home — a tenant-owned home,
          an RV site or a bare lot never asks. */}
      {unit.dwellingOwnership === 'landlord' && unit.unitType === 'mobile_home' && (
        <HomeSaleToggle sale={sale} setSale={setSale} />
      )}
      {/* S652 (Nic): the packet, at the invite. */}
      <PacketChecklist unitId={unit.id} sale={!!sale} ticked={packet} setTicked={setPacket} />

      {people.map((p, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          {i > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: '.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Co-tenant {i}</span>
              <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '1px 7px', fontSize: '.68rem' }}
                      onClick={() => setPeople(people.filter((_, idx) => idx !== i))}>Remove</button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input className="input" placeholder="First name" value={p.firstName} onChange={e => setField(i, 'firstName', e.target.value)} />
            <input className="input" placeholder="Last name" value={p.lastName} onChange={e => setField(i, 'lastName', e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <input className="input" placeholder="Email" type="email" value={p.email} onChange={e => setField(i, 'email', e.target.value)} />
            <input className="input" placeholder="Phone (optional)" value={p.phone} onChange={e => setField(i, 'phone', e.target.value)} />
          </div>
        </div>
      ))}

      <button type="button" className="btn btn-ghost" style={{ width: '100%', fontSize: '.74rem' }}
              onClick={() => setPeople([...people, blankPerson()])}>
        + Add another person to this lease
      </button>

      {error && <div style={{ color: 'var(--red)', fontSize: '.76rem', marginTop: 8 }}>{error}</div>}
    </div>
  )
}

function SingleTenantMode({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '' })
  // W-27 (S531): optionally bind the unit the incoming tenant already
  // occupies — the availability predicate excludes it from guest booking
  // until the intent resolves (migration protection).
  const [unitId, setUnitId] = useState('')
  const { data: allUnits = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  // S654 (NO DEFAULT COMPANY): a chosen unit names its company. With no unit,
  // an account that owns several companies names it here; the server reads
  // landlordId and checks it is theirs.
  const [landlordId, setLandlordId] = useState('')
  const needsCompany = useCompanyMissing(landlordId) && !unitId
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ intentId: string | null; name: string } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // S579: onboarding-window grandfather (only when a unit is bound — it's per unit).
  const propertyIdForWindow = (allUnits as any[]).find(u => u.id === unitId)?.propertyId
  const { data: obWindow } = useQuery<any>(
    ['ob-window', propertyIdForWindow],
    () => apiGet(`/properties/${propertyIdForWindow}/onboarding-window`),
    { enabled: !!propertyIdForWindow, staleTime: 60_000 })
  const windowOpen = !!obWindow?.open
  const [attestExisting, setAttestExisting] = useState(true)
  const [ownDueDay, setOwnDueDay] = useState('')   // S652
  // S631 (Nic, DIRECTIVE): "Let's flag on invite so that no matter when they
  // accept it, the work-trade agreement has inserted it slightly before the
  // invoice is created." Declared here because a work_trade_agreement needs an
  // active lease and cannot exist until they sign — by which point the first
  // invoice is already written, and already chargeable.
  const [isWorkTrade, setIsWorkTrade] = useState(false)
  // 10/6: the one work-trade picker (components/WorkTradeTermsFields) — the
  // same one the schedule's reservation form uses. Covers everything by default.
  const [wt, setWt] = useState<WorkTradeTerms>(defaultWorkTradeTerms)

  const set = (k: keyof typeof form, v: string) => setForm(prev => ({ ...prev, [k]: v }))

  // The trimmed values are passed in: setForm() has not landed yet when the
  // mutation runs, so reading `form` here sent the untrimmed copy.
  const submitMut = useMutation(
    (f: typeof form) => apiPost<any>('/landlords/me/onboard-tenant-pending', {
      ...f,
      phone: f.phone || undefined,
      unitId: unitId || undefined,
      landlordId: !unitId && landlordId ? landlordId : undefined,
      existingResident: !!unitId && windowOpen && attestExisting,
      rentDueDay: unitId && windowOpen && attestExisting && ownDueDay ? Number(ownDueDay) : undefined,
      // Work trade is per unit — it trades labor for THAT tenancy's rent.
      isWorkTrade: !!unitId && isWorkTrade,
      ...(isWorkTrade ? (() => {
        const p = workTradeTermsPayload(wt, { trusted: false })
        return {
          workTradeTracksHours: p.tracksHours,
          workTradeHoursTarget: p.hoursTarget ?? undefined,
          workTradeDuties: p.duties ?? undefined,
          workTradeCoveredCharges: p.coveredCharges,
        }
      })() : {}),
    }),
    {
      onSuccess: (res: any) => {
        // Codebase convention: handlers return { success, data: { ... } }.
        // Defensive against shape drift — fall back to navigate-to-pool if intentId missing.
        const intentId = res?.data?.intentId || res?.data?.intentId || null
        setSuccess({
          intentId,
          name: `${form.firstName} ${form.lastName}`.trim() || form.email,
        })
        setError(null)
      },
      onError: (e: any) => {
        // The server's own plain-words reason (already on a lease with you,
        // already in your pending list, a login that isn't a resident's).
        setError(serverReason(e, 'Could not add tenant.'))
      },
    }
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const trimmed = {
      firstName: form.firstName.trim(),
      lastName:  form.lastName.trim(),
      email:     form.email.trim(),
      phone:     form.phone.trim(),
    }
    // S629: phone is optional — plenty of landlords only have an email.
    if (!trimmed.firstName || !trimmed.lastName || !trimmed.email) {
      setError('Add their first name, last name and email.')
      return
    }
    if (needsCompany) { setError('Pick the unit they live in, or choose the company they belong to.'); return }
    setForm(trimmed)
    submitMut.mutate(trimmed)
  }

  const handleAddAnother = () => {
    setForm({ firstName: '', lastName: '', email: '', phone: '' })
    setUnitId('')
    setSuccess(null)
    setError(null)
    setUploadError(null)
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !success?.intentId) return
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setUploadError('File must be a PDF.')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setUploadError('File exceeds the 20 MB limit.')
      return
    }
    setUploading(true)
    setUploadError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post(
        `/landlords/me/pending-tenants/${success.intentId}/document`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      )
      onComplete()
    } catch (err: any) {
      setUploadError(serverReason(err, 'Upload failed'))
    } finally {
      setUploading(false)
    }
  }

  // Form state — collecting tenant info.
  if (!success) {
    return (
      <div>
        <button onClick={onBack} className="btn btn-ghost" style={{ marginBottom: 16 }}>&larr; Back</button>
        <form onSubmit={handleSubmit} style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', maxWidth: 560 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-0)', margin: 0, marginBottom: 6 }}>
            Add One Tenant
          </h2>
          <p style={{ fontSize: '.84rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 20, lineHeight: 1.5 }}>
            Type the tenant's contact info. They land in your pending pool until you upload
            their lease PDF — the parser fills in unit and lease terms automatically.
          </p>

          {error && (
            <div style={{
              padding: 10, marginBottom: 16, background: 'var(--bg-2)',
              borderLeft: '3px solid #dc2626', borderRadius: 6,
              fontSize: '.84rem', color: 'var(--text-1)',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <AlertCircle size={14} style={{ color: '#dc2626', flexShrink: 0, marginTop: 2 }} />
              <span>{error}</span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 4 }}>First name</label>
              <input className="input" placeholder="Jane" value={form.firstName} onChange={e => set('firstName', e.target.value)} autoFocus style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 4 }}>Last name</label>
              <input className="input" placeholder="Smith" value={form.lastName} onChange={e => set('lastName', e.target.value)} style={{ width: '100%' }} />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 4 }}>Email</label>
            <input className="input" type="email" placeholder="jane@example.com" value={form.email} onChange={e => set('email', e.target.value)} style={{ width: '100%' }} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 4 }}>Phone (optional)</label>
            <input className="input" type="tel" placeholder="(555) 000-0000" value={form.phone} onChange={e => set('phone', e.target.value)} style={{ width: '100%' }} />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 4 }}>Unit they occupy (optional)</label>
            <select className="input" value={unitId} onChange={e => setUnitId(e.target.value)} style={{ width: '100%' }}>
              <option value="">— None yet —</option>
              {(allUnits as any[]).map((u: any) => (
                <option key={u.id} value={u.id}>{u.propertyName} — Unit {u.unitNumber}</option>
              ))}
            </select>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>
              Holds their spot: guests can't book this unit while onboarding completes.
            </div>
            {!unitId && (
              <div style={{ marginTop: 12 }}>
                <EntityPicker value={landlordId} onChange={setLandlordId}
                  note="With no unit picked, they are added under this company." />
              </div>
            )}
          </div>

          {/* S579: grandfather — only when a unit is bound (per-occupied-unit). */}
          {unitId && obWindow && (windowOpen ? (
            <div style={{ background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.3)', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={attestExisting} onChange={e => setAttestExisting(e.target.checked)} style={{ marginTop: 3, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)' }}>Existing resident — skip background check</div>
                  <div style={{ fontSize: '.74rem', color: 'var(--text-2)', lineHeight: 1.5, marginTop: 2 }}>
                    I attest this person already lives in this unit.
                    {typeof obWindow.daysRemaining === 'number' && <> Onboarding window closes in <strong style={{ color: 'var(--gold)' }}>{obWindow.daysRemaining} day{obWindow.daysRemaining === 1 ? '' : 's'}</strong>.</>}
                  </div>
                  {!attestExisting && <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>Unchecked — this tenant will complete a background check.</div>}
                </div>
              </label>
              {attestExisting && <div style={{ marginTop: 10 }}><DueDayPicker value={ownDueDay} onChange={setOwnDueDay} /></div>}
            </div>
          ) : (
            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              Onboarding window closed — this tenant will complete a <strong style={{ color: 'var(--text-1)' }}>background check</strong> before portal access.
            </div>
          ))}

          {/* S631: work trade, declared before the lease exists. */}
          {unitId && (
            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="checkbox" checked={isWorkTrade}
                  onChange={e => setIsWorkTrade(e.target.checked)}
                  style={{ marginTop: 3, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)' }}>Work trade — they work off their rent</div>
                  <div style={{ fontSize: '.74rem', color: 'var(--text-2)', lineHeight: 1.5, marginTop: 2 }}>
                    Their invoice still issues in full and is credited at month close from the
                    hours they log. No late fees while they&apos;re working the month off.
                  </div>
                </div>
              </label>
              {isWorkTrade && (
                <div style={{ marginTop: 10 }}>
                  <WorkTradeTermsFields value={wt} onChange={setWt} showTrusted={false} />
                </div>
              )}
            </div>
          )}

          <button type="submit" disabled={submitMut.isLoading || needsCompany || (isWorkTrade && !wt.coveredCharges.length)} className="btn btn-primary" style={{ width: '100%' }}>
            {submitMut.isLoading ? 'Adding...' : 'Add tenant to pending pool'}
          </button>
          {needsCompany && (
            <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 6, textAlign: 'center' }}>
              Pick the unit they live in, or choose the company they belong to.
            </div>
          )}
        </form>
      </div>
    )
  }

  // Success state — tenant added, optional inline PDF upload.
  return (
    <div>
      <button onClick={onBack} className="btn btn-ghost" style={{ marginBottom: 16 }}>&larr; Back</button>
      <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <CheckCircle2 size={20} style={{ color: '#16a34a' }} />
          <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', margin: 0 }}>
            {success.name} added to pending pool
          </h2>
        </div>
        <p style={{ fontSize: '.84rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 20, lineHeight: 1.5 }}>
          Upload the lease PDF now and the parser will read the unit and lease terms.
          You can also do this later from the Pending Pool.
        </p>

        {uploadError && (
          <div style={{
            padding: 10, marginBottom: 16, background: 'var(--bg-2)',
            borderLeft: '3px solid #dc2626', borderRadius: 6,
            fontSize: '.84rem', color: 'var(--text-1)',
            display: 'flex', alignItems: 'flex-start', gap: 8,
          }}>
            <AlertCircle size={14} style={{ color: '#dc2626', flexShrink: 0, marginTop: 2 }} />
            <span>{uploadError}</span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {success.intentId ? (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="btn btn-primary"
              style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            >
              <Upload size={14} />
              {uploading ? 'Uploading...' : 'Upload lease PDF'}
            </button>
          ) : (
            <button onClick={onComplete} className="btn btn-primary" style={{ width: '100%' }}>
              Go to Pending Pool to Upload
            </button>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAddAnother} className="btn btn-ghost" style={{ flex: 1 }}>
              Add Another
            </button>
            <button onClick={onComplete} className="btn btn-ghost" style={{ flex: 1 }}>
              View Pending Pool
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * S655 (Nic, 10/2): THE TENANT CSV IS A DRAFT ROSTER.
 *
 * "Check the file" only checks it. "Save as draft roster" saves who lives
 * where — nobody is emailed and no account is made. The landlord then reviews
 * each property's roster (RosterReviewMode) and confirms it; confirming drafts
 * every household's lease from the landlord's own setup, the leases wait for
 * the landlord's signature, and each household gets one email when he signs.
 *
 * It used to commit on Validate: clean units became live leases nobody had
 * signed, and every new person got an "Activate your account" email at once.
 */
function BulkCsvMode({ onBack, onOpenRoster }: { onBack: () => void; onOpenRoster: (propertyId: string) => void }) {
  const qc = useQueryClient()
  const [source, setSource] = useState<string>('generic')
  // S633: a tenant import lands in ONE company. Single-company accounts never
  // see the picker; an account that owns several must say which.
  const [landlordId, setLandlordId] = useState<string>('')
  const [fileName, setFileName] = useState<string>('')
  const [csvText, setCsvText] = useState<string>('')
  const [review, setReview] = useState<ValidateResponse | null>(null)
  const [saved, setSaved] = useState<DraftResponse | null>(null)
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [reviewBanner, setReviewBanner] = useState<{ platform: string } | null>(null)
  // S297: free-text claim required on generic uploads.
  const [claimedPlatformName, setClaimedPlatformName] = useState<string>('')
  // S537: undecided late-fee classes are decided before the roster is saved —
  // a roster can't be confirmed onto an undecided class.
  const [pendingDecisions, setPendingDecisions] = useState<NonNullable<ValidateResponse['missingLateFeeDecisions']>>([])
  const [decisionInputs, setDecisionInputs] = useState<Record<string, { noLateFee: boolean; amount: string; grace: string; kind: 'flat' | 'percent_of_rent' }>>({})
  const [savingDecisions, setSavingDecisions] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // S654: NO DEFAULT COMPANY — a several-company account checks and saves
  // nothing until it names one.
  const companyMissing = useCompanyMissing(landlordId)
  const clearResults = () => {
    setReview(null); setSaved(null); setPendingDecisions([]); setDecisionInputs({})
    setErrorMsg(''); setReviewBanner(null)
  }
  // A check was matched against one company's units; switching company makes it stale.
  const chooseCompany = useCallback((id: string) => {
    if (landlordId && id !== landlordId) clearResults()
    setLandlordId(id)
  }, [landlordId])

  // S297: client mirror of normalizeClaimName for soft-warning check.
  const normalizeClaim = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const claimMatchesExisting = useMemo(() => {
    if (!claimedPlatformName.trim()) return null
    const n = normalizeClaim(claimedPlatformName)
    if (!n) return null
    return PLATFORM_OPTIONS.find(p =>
      p.value !== 'generic' && p.enabled && (normalizeClaim(p.value) === n || normalizeClaim(p.label) === n)
    ) || null
  }, [claimedPlatformName])

  const fileBody = () => ({
    csv: csvText, source, landlordId,
    ...(source === 'generic' ? { claimedPlatformName: claimedPlatformName.trim() } : {}),
  })

  const validateMut = useMutation(
    () => apiPost<ValidateResponse>('/landlords/me/onboard-tenants-csv/validate', fileBody()),
    {
      onSuccess: (res: any) => {
        const data: ValidateResponse = res.data
        setErrorMsg('')
        setSaved(null)
        if (data.missingLateFeeDecisions && data.missingLateFeeDecisions.length > 0) {
          setPendingDecisions(data.missingLateFeeDecisions)
          setDecisionInputs(Object.fromEntries(data.missingLateFeeDecisions.map(m => [
            `${m.propertyId}|${m.unitType}`,
            m.suggested
              ? { noLateFee: false, amount: String(m.suggested.initialAmount), grace: String(m.suggested.graceDays), kind: 'flat' as const }
              : { noLateFee: false, amount: '', grace: '5', kind: 'flat' as const },
          ])))
          setReview(null)
          return
        }
        setPendingDecisions([])
        setReview(data)
      },
      onError: (err: any) => {
        setErrorMsg(serverReason(err, 'The file could not be checked. Make sure it is a CSV and try again.'))
        setReview(null)
      },
    }
  )

  const saveMut = useMutation(
    () => apiPost<DraftResponse>('/landlords/me/onboard-tenants-csv/draft', fileBody()),
    {
      onSuccess: (res: any) => {
        const d: DraftResponse = res.data
        setSaved(d)
        setReview(null)
        setErrorMsg('')
        qc.invalidateQueries('tenant-roster-summary')
        qc.invalidateQueries('onboarding-windows')
        if (d.escalateToSuperAdmin) {
          setReviewBanner({ platform: PLATFORM_OPTIONS.find(p => p.value === source)?.label || source })
        } else {
          setReviewBanner(null)
        }
      },
      onError: (err: any) => setErrorMsg(serverReason(err, 'The roster could not be saved. Check the file and try again.')),
    }
  )

  const handleFile = (file: File) => {
    setFileName(file.name)
    clearResults()
    const reader = new FileReader()
    reader.onload = (e) => setCsvText(String(e.target?.result || ''))
    reader.onerror = () => setErrorMsg('Could not read the file. Try again.')
    reader.readAsText(file)
  }

  const handleDownloadTemplate = async () => {
    // Raw fetch (not apiGet) because the response is text/csv, not JSON.
    try {
      const apiUrl = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
      const token = localStorage.getItem('gam_token')
      const res = await fetch(`${apiUrl}/api/landlords/me/onboard-tenants-csv/template?source=${encodeURIComponent(source)}`, {
        headers: { Authorization: 'Bearer ' + token },
      })
      if (!res.ok) { setErrorMsg('Could not download the template. Try again.'); return }
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = source === 'generic' ? 'gam-tenant-roster-template.csv' : `gam-tenant-roster-template-${source}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      setErrorMsg('Could not download the template. Try again.')
    }
  }

  const handleValidate = () => {
    if (!csvText.trim()) { setErrorMsg('Pick a CSV file first.'); return }
    if (companyMissing) { setErrorMsg(CHOOSE_COMPANY_FIRST); return }
    if (source === 'generic' && !claimedPlatformName.trim()) {
      setErrorMsg('Enter the name of the platform this file came from first.')
      return
    }
    validateMut.mutate()
  }

  // S537: save the decisions, then check the file again — the import resumes.
  const handleSaveDecisions = async () => {
    if (companyMissing) { setErrorMsg(CHOOSE_COMPANY_FIRST); return }
    const incomplete = pendingDecisions.some(m => {
      const d = decisionInputs[`${m.propertyId}|${m.unitType}`]
      return !d || (!d.noLateFee && (d.amount === '' || d.grace === ''))
    })
    if (incomplete) { setErrorMsg('Every listed kind of unit needs an answer: a fee, or "No late fee".'); return }
    setSavingDecisions(true)
    setErrorMsg('')
    try {
      for (const m of pendingDecisions) {
        const d = decisionInputs[`${m.propertyId}|${m.unitType}`]!
        await apiPut(`/properties/${m.propertyId}/late-fee-overrides`, d.noLateFee
          ? { unitType: m.unitType, noLateFee: true }
          : { unitType: m.unitType, graceDays: Math.trunc(Number(d.grace) || 0), initialAmount: Number(d.amount), initialType: d.kind })
      }
      setPendingDecisions([])
      validateMut.mutate()
    } catch (e: any) {
      setErrorMsg(serverReason(e, 'The late-fee answers could not be saved. Try again.'))
    } finally {
      setSavingDecisions(false)
    }
  }

  const handleReset = () => {
    setFileName('')
    setCsvText('')
    clearResults()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const busy = validateMut.isLoading || saveMut.isLoading || savingDecisions

  return (
    <div>
      <button onClick={onBack} className="btn btn-ghost" style={{ marginBottom: 16 }}>&larr; Back</button>

      <EntityPicker value={landlordId} onChange={chooseCompany}
        disabled={busy}
        note="Everyone in this file goes on this company's draft roster." />

      <div style={{ padding: 16, borderRadius: 10, background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.25)', marginBottom: 16, fontSize: '.82rem', color: 'var(--text-1)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--text-0)' }}>How this works.</strong> Your file becomes a <strong>draft roster</strong> of who
        lives where. Nothing is sent to anyone and no accounts are made. You review each property&apos;s roster and confirm it;
        GAM then drafts every household&apos;s lease from your own setup (the unit&apos;s rent and your default lease) and they
        wait for your signature. Each household gets one email when you sign their lease.
      </div>

      <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 12 }}>1. Pick where the file came from</h2>
        <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
          GAM reads the standard export columns from Buildium, AppFolio, DoorLoop, Yardi, RentManager, Propertyware,
          Rentec Direct and TenantCloud. Pick Generic if you are filling in the GAM template yourself.
        </p>
        <select
          value={source}
          onChange={(e) => { setSource(e.target.value); clearResults() }}
          style={{ width: '100%', maxWidth: 360, padding: '10px 12px', borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border-0)', color: 'var(--text-0)', fontSize: '.88rem' }}
        >
          {PLATFORM_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value} disabled={!opt.enabled}>
              {opt.label}{!opt.enabled ? ' — coming soon' : ''}
            </option>
          ))}
        </select>

        {source === 'generic' && (
          <div style={{ marginTop: 16 }}>
            <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--text-1)', marginBottom: 6, fontWeight: 600 }}>
              What platform is this file from? <span style={{ color: 'var(--gold)' }}>*</span>
            </label>
            <input
              type="text"
              value={claimedPlatformName}
              onChange={e => setClaimedPlatformName(e.target.value)}
              placeholder="e.g. Hemlane, SimplifyEm, Rentmoji..."
              style={{ width: '100%', maxWidth: 360, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border-0)', color: 'var(--text-0)', fontSize: '.86rem' }}
            />
            {claimMatchesExisting && (
              <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 7, background: 'var(--bg-2)', borderLeft: '3px solid var(--gold)', fontSize: '.78rem', color: 'var(--text-1)' }}>
                GAM reads <strong>{claimMatchesExisting.label}</strong> files directly — pick <em>{claimMatchesExisting.label}</em> above for better column matching.
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 12 }}>
          2. {source === 'generic' ? 'Get the template' : 'Export from your platform'}
        </h2>
        <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
          One row per person. People in the same home share the same property and unit. Only the name, email, property
          and unit are needed; a phone number and an old balance are welcome. Rent, dates, deposit and late fee are
          optional — they are shown beside each person for reference, and the lease drafts from your own setup.
        </p>
        <button onClick={handleDownloadTemplate} className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Download size={14} /> {source === 'generic' ? 'Download template' : 'Download column reference'}
        </button>
      </div>

      <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 12 }}>3. Upload the file</h2>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
          style={{ display: 'none' }}
        />
        {!fileName ? (
          <button onClick={() => fileInputRef.current?.click()} className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Upload size={14} /> Choose CSV file
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border-0)' }}>
              <FileText size={14} color="var(--text-2)" /> <span style={{ fontSize: '.85rem', color: 'var(--text-0)' }}>{fileName}</span>
            </div>
            <button onClick={handleReset} className="btn btn-ghost" style={{ fontSize: '.82rem' }} disabled={busy}>Use a different file</button>
            <button onClick={handleValidate} className="btn btn-primary" disabled={busy || companyMissing} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {validateMut.isLoading ? <span className="spinner" /> : null}
              {validateMut.isLoading ? 'Checking…' : 'Check the file'}
            </button>
            {companyMissing && <span style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>{CHOOSE_COMPANY_FIRST}</span>}
          </div>
        )}
      </div>

      {errorMsg && (
        <div style={{ padding: 16, borderRadius: 10, background: 'rgba(220,80,80,.08)', border: '1px solid rgba(220,80,80,.3)', color: 'var(--red,#dc5050)', display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 16 }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: '.85rem' }}>{errorMsg}</div>
        </div>
      )}

      {reviewBanner && (
        <div style={{ padding: 14, marginBottom: 16, background: 'var(--bg-2)', borderLeft: '3px solid var(--gold)', borderRadius: 6, fontSize: '.9rem', color: 'var(--text-0)' }}>
          <strong>We&apos;re checking how your {reviewBanner.platform} file was read.</strong>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 }}>
            Our team looks over the column matching on every new {reviewBanner.platform} import. If anything looks off we&apos;ll reach out. Nothing for you to do.
          </div>
        </div>
      )}

      {pendingDecisions.length > 0 && (
        <div style={{ padding: 20, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--gold)', marginBottom: 16 }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>
            One question first: late fees
          </div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
            These kinds of unit have no late-fee answer yet, and a lease can&apos;t be drafted without one. Where your
            file&apos;s leases share a late fee, it is filled in below as a suggestion — keep it or change it.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pendingDecisions.map(m => {
              const key = `${m.propertyId}|${m.unitType}`
              const d = decisionInputs[key] || { noLateFee: false, amount: '', grace: '5', kind: 'flat' as const }
              const setD = (patch: Partial<typeof d>) => setDecisionInputs(prev => ({ ...prev, [key]: { ...d, ...patch } }))
              return (
                <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '.84rem' }}>
                  <span style={{ flex: '0 0 300px', color: 'var(--text-1)' }}>
                    <strong>{m.propertyName}</strong> · {UNIT_TYPE_LABEL[m.unitType as keyof typeof UNIT_TYPE_LABEL] || humanize(m.unitType)}
                    {m.suggested && (
                      <span style={{ display: 'block', fontSize: '.72rem', color: 'var(--text-3)' }}>
                        suggested from {m.suggested.leaseCount} of {m.suggested.leaseTotal} lease{m.suggested.leaseTotal === 1 ? '' : 's'} in your file
                      </span>
                    )}
                  </span>
                  <select className="input" value={d.noLateFee ? 'none' : 'fee'}
                    onChange={e => setD({ noLateFee: e.target.value === 'none' })}
                    style={{ width: 130, fontSize: '.8rem', padding: '4px 6px' }}>
                    <option value="fee">Charge a fee</option>
                    <option value="none">No late fee</option>
                  </select>
                  {!d.noLateFee && (
                    <>
                      <span style={{ color: 'var(--text-3)' }}>$</span>
                      <input className="input" value={d.amount} inputMode="decimal"
                        onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setD({ amount: v }) }}
                        style={{ width: 70, fontSize: '.8rem', padding: '4px 6px' }} />
                      <span style={{ color: 'var(--text-3)' }}>after</span>
                      <input className="input" value={d.grace} inputMode="numeric"
                        onChange={e => { const v = e.target.value; if (v === '' || /^\d+$/.test(v)) setD({ grace: v }) }}
                        style={{ width: 50, fontSize: '.8rem', padding: '4px 6px' }} />
                      <span style={{ color: 'var(--text-3)' }}>days</span>
                    </>
                  )}
                </div>
              )
            })}
          </div>
          <button className="btn btn-primary" style={{ marginTop: 14 }} disabled={savingDecisions || companyMissing}
            onClick={handleSaveDecisions}>
            {savingDecisions ? 'Saving…' : 'Save answers and check the file again'}
          </button>
        </div>
      )}

      {review && (
        <RosterFileReview review={review} saving={saveMut.isLoading} disabled={companyMissing}
          onSave={() => saveMut.mutate()} />
      )}

      {saved && <RosterSaved saved={saved} onOpenRoster={onOpenRoster} />}
    </div>
  )
}

/** What checking the file found: what will be saved, what can't be, and every note. */
function RosterFileReview({ review, saving, disabled, onSave }: {
  review: ValidateResponse; saving: boolean; disabled: boolean; onSave: () => void
}) {
  const rowName = (r: RosterCsvRow) => `${r.firstName} ${r.lastName}`.trim() || r.email || `Row ${r.rowIndex + 1}`
  const blocked = review.rows.filter(r => r.issues.some(i => i.severity === 'block'))
  const notes = review.rows.filter(r => !r.issues.some(i => i.severity === 'block') && r.issues.length > 0)
  const ready = review.summary.ready
  return (
    <div style={{ padding: 24, borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', marginBottom: 16 }}>
      <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-0)', marginTop: 0, marginBottom: 16 }}>What the file says</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
        <SummaryStat label="People in the file" value={review.summary.total} color="var(--text-0)" />
        <SummaryStat label="Ready to save" value={ready} color="#22c55e" icon={<CheckCircle2 size={14} />} />
        <SummaryStat label="With a note" value={notes.length} color="#eab308" icon={<AlertTriangle size={14} />} />
        <SummaryStat label="Can't be saved" value={blocked.length} color="#dc5050" icon={<AlertCircle size={14} />} />
      </div>

      {blocked.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--red,#dc5050)', marginBottom: 6 }}>
            These can&apos;t be saved. Fix them in your file and check it again — everyone else can be saved now.
          </div>
          {blocked.map(r => (
            <div key={r.rowIndex} style={{ fontSize: '.8rem', color: 'var(--text-1)', padding: '4px 0', borderTop: '1px solid var(--border-0)' }}>
              <strong>Row {r.rowIndex + 1}</strong> — {rowName(r)}: {r.issues.filter(i => i.severity === 'block').map(i => i.message).join(' ')}
            </div>
          ))}
        </div>
      )}

      {notes.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)', marginBottom: 6 }}>Notes</div>
          {notes.map(r => (
            <div key={r.rowIndex} style={{ fontSize: '.8rem', color: 'var(--text-2)', padding: '4px 0', borderTop: '1px solid var(--border-0)' }}>
              <strong style={{ color: 'var(--text-1)' }}>Row {r.rowIndex + 1}</strong> — {rowName(r)}: {r.issues.map(i => i.message).join(' ')}
            </div>
          ))}
        </div>
      )}

      <button className="btn btn-primary" style={{ width: '100%' }} disabled={saving || disabled || ready === 0} onClick={onSave}>
        {saving ? 'Saving…' : ready === 0 ? 'Nobody in this file can be saved yet'
          : `Save ${ready} ${ready === 1 ? 'person' : 'people'} as a draft roster`}
      </button>
      <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 6, textAlign: 'center' }}>
        Nothing is sent to anyone. You review each property&apos;s roster next.
      </div>
    </div>
  )
}

function RosterSaved({ saved, onOpenRoster }: { saved: DraftResponse; onOpenRoster: (propertyId: string) => void }) {
  const total = saved.saved + saved.updated
  return (
    <div style={{ padding: 20, borderRadius: 10, background: 'rgba(34,197,94,.06)', border: '1px solid rgba(34,197,94,.3)', marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 12 }}>
        <CheckCircle2 size={18} style={{ color: '#22c55e', flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: '.9rem', color: 'var(--text-0)', lineHeight: 1.5 }}>
          <strong>{total} {total === 1 ? 'person is' : 'people are'} on the draft roster.</strong>
          {saved.updated > 0 && <> ({saved.updated} already there {saved.updated === 1 ? 'was' : 'were'} updated from this file.)</>}
          {' '}Nobody has been emailed. Review each property next and confirm it to draft the leases.
          {' '}Payment history from your old system can be imported once their leases are signed — it is matched to their GAM lease.
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {saved.properties.map(p => (
          <button key={p.propertyId} className="btn btn-primary" onClick={() => onOpenRoster(p.propertyId)}>
            Review {p.propertyName} ({p.count})
          </button>
        ))}
      </div>
      {saved.notSaved.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: '.8rem', fontWeight: 700, color: 'var(--text-1)', marginBottom: 4 }}>Not saved</div>
          {saved.notSaved.map(n => (
            <div key={n.rowIndex} style={{ fontSize: '.78rem', color: 'var(--text-2)', padding: '3px 0' }}>
              Row {n.rowIndex + 1} — {n.name || n.email}: {n.reasons.join(' ') || 'Left out.'}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SummaryStat({ label, value, color, icon }: { label: string; value: number; color: string; icon?: React.ReactNode }) {
  return (
    <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border-0)' }}>
      <div style={{ fontSize: '.72rem', color: 'var(--text-2)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon && <span style={{ color }}>{icon}</span>}
        {label}
      </div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, color }}>{value}</div>
    </div>
  )
}

/** An input that saves when you leave it, and takes fresh values from the server while you're not in it. */
function BlurInput({ value, onCommit, placeholder, type = 'text', width }: {
  value: string; onCommit: (v: string) => void; placeholder?: string; type?: string; width?: number | string
}) {
  const [v, setV] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setV(value) }, [value])
  return (
    <input className="input" type={type} placeholder={placeholder} value={v}
      style={{ width: width ?? '100%', fontSize: '.8rem', padding: '6px 8px' }}
      onFocus={() => { focused.current = true }}
      onChange={e => setV(e.target.value)}
      onBlur={() => { focused.current = false; if (v.trim() !== (value ?? '').trim()) onCommit(v.trim()) }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
  )
}

const usd = (n: number | null | undefined) => n == null ? '' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

/**
 * S655: one property's draft roster. Read fresh from the server every time and
 * after every change — never a stale copy. Each unit's problems are named with
 * the next step; one gold button confirms the property, and it says why when
 * it can't yet.
 */
function RosterReviewMode({ onBack, initialPropertyId = '' }: { onBack: () => void; initialPropertyId?: string }) {
  const qc = useQueryClient()
  const { data: summary } = useQuery<any>('tenant-roster-summary', () => apiGet('/landlords/me/tenant-roster'),
    { staleTime: 0, refetchOnWindowFocus: true })
  const properties: Array<{ propertyId: string; propertyName: string; count: number }> = summary?.properties ?? []
  const [propertyId, setPropertyId] = useState(initialPropertyId)
  useEffect(() => {
    if (!propertyId && properties.length > 0) setPropertyId(properties[0].propertyId)
  }, [properties.length])
  const rosterKey = ['tenant-roster', propertyId]
  const { data: roster, isLoading } = useQuery<any>(rosterKey,
    () => apiGet(`/landlords/me/tenant-roster?propertyId=${propertyId}`),
    { enabled: !!propertyId, staleTime: 0, refetchOnWindowFocus: true })
  const { data: allUnits = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const [error, setError] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const [result, setResult] = useState<any>(null)

  const refresh = () => {
    qc.invalidateQueries(rosterKey)
    qc.invalidateQueries('tenant-roster-summary')
    qc.invalidateQueries('onboarding-windows')
  }
  const patch = async (id: string, body: any) => {
    try {
      await apiPatch(`/landlords/me/tenant-roster/${id}`, body)
      setError('')
    } catch (e: any) {
      setError(serverReason(e, 'That change did not save. Try it again.'))
    } finally { refresh() }
  }
  const remove = async (id: string, name: string) => {
    if (!(await appConfirm(`Take ${name} off this roster? Nothing has been sent to them, and you can upload them again later.`,
      { title: 'Remove from the roster', confirmLabel: 'Remove' }))) return
    try {
      await apiDelete(`/landlords/me/tenant-roster/${id}`)
      setError('')
    } catch (e: any) {
      setError(serverReason(e, 'They could not be removed. Try again.'))
    } finally { refresh() }
  }
  const confirmMut = useMutation(
    () => apiPost<any>('/landlords/me/tenant-roster/confirm', { propertyId }),
    {
      onSuccess: (res: any) => {
        setResult(res.data); setProblems([]); setError('')
        refresh()
        qc.invalidateQueries('units'); qc.invalidateQueries('pending-tenants'); qc.invalidateQueries('pending-tenants-count')
      },
      onError: (e: any) => {
        const p = e?.response?.data?.problems
        if (Array.isArray(p) && p.length) { setProblems(p); setError('') }
        else { setProblems([]); setError(serverReason(e, 'The roster could not be confirmed. Try again.')) }
        refresh()
      },
    },
  )

  const units: any[] = roster?.units ?? []
  const notPlaced: any[] = roster?.notPlaced ?? []
  const inProperty = (allUnits as any[]).filter(u => u.propertyId === propertyId)
  const rosterUnitIds = new Set(units.map(u => u.unitId))
  const placeable = inProperty.filter(u => rosterUnitIds.has(u.id) || canInviteToUnit(u))
    .sort((a, b) => String(a.unitNumber).localeCompare(String(b.unitNumber), undefined, { numeric: true }))
  const anyBlocker = units.some(u => (u.blockers ?? []).length > 0)
  const confirmBlocked = notPlaced.length > 0
    ? `Place ${notPlaced.length === 1 ? 'the 1 person' : `all ${notPlaced.length} people`} below "Not placed yet" in a unit, or remove them.`
    : anyBlocker ? 'Fix what is listed in red on the units above.'
    : units.length === 0 ? 'There is nobody on this roster.' : null

  return (
    <div style={{ maxWidth: 820, paddingBottom: 110 }}>
      <button onClick={onBack} className="btn btn-ghost" style={{ marginBottom: 16 }}>&larr; Back</button>
      <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-0)', margin: 0, marginBottom: 6 }}>Draft roster</h2>
      <p style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5, marginTop: 0 }}>
        Check who lives where, then confirm. Confirming drafts each household&apos;s lease from your setup, and they wait for
        your signature in Front Desk. Nobody hears from GAM until you sign their lease. Changes save as you go.
      </p>

      {properties.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <label className="form-label" style={{ margin: 0, fontSize: '.72rem' }}>Property</label>
          <select className="input" style={{ width: 'auto', minWidth: 260 }} value={propertyId}
            onChange={e => { setPropertyId(e.target.value); setResult(null); setProblems([]); setError('') }}>
            {properties.map(p => <option key={p.propertyId} value={p.propertyId}>{p.propertyName} ({p.count})</option>)}
          </select>
        </div>
      )}

      {result && (
        <div style={{ padding: 16, borderRadius: 10, background: 'rgba(34,197,94,.06)', border: '1px solid rgba(34,197,94,.3)', marginBottom: 16 }}>
          <div style={{ fontSize: '.92rem', fontWeight: 700, color: 'var(--text-0)', marginBottom: 6 }}>
            {result.drafted} lease{result.drafted === 1 ? ' is' : 's are'} waiting for your signature.
          </div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginBottom: 10 }}>
            Sign them in Front Desk → Waiting on you to sign. Each household gets one email when you sign theirs.
          </div>
          {(result.units ?? []).filter((u: any) => u.status !== 'drafted').map((u: any) => (
            <div key={u.unitId} style={{ fontSize: '.8rem', color: u.status === 'error' ? 'var(--red,#dc5050)' : 'var(--amber,#d97706)', padding: '3px 0' }}>
              Unit {u.unitNumber} ({u.people.join(', ')}): {u.message}
            </div>
          ))}
          {(result.units ?? []).filter((u: any) => Array.isArray(u.ownSignature) && u.ownSignature.length > 0).map((u: any) => (
            <div key={`${u.unitId}-own`} style={{ fontSize: '.8rem', color: 'var(--text-1)', padding: '3px 0' }}>
              Unit {u.unitNumber}: {u.ownSignature.join(', ')} already {u.ownSignature.length === 1 ? 'has' : 'have'} a GAM
              account, so {u.ownSignature.length === 1 ? 'their lease starts when they sign it themselves' : 'a lease with them on it starts only once they have signed it themselves'}.
              Sign as usual; nothing on that lease is billed until then.
            </div>
          ))}
          <Link to="/front-desk" className="btn btn-primary" style={{ marginTop: 10, display: 'inline-flex' }}>Go to Front Desk</Link>
        </div>
      )}

      {!propertyId ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)', fontSize: '.85rem' }}>
          No draft roster yet. Upload a tenant file from Bulk CSV Import to start one.
        </div>
      ) : isLoading ? (
        <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>Loading the roster…</div>
      ) : (
        <>
          {roster?.window && (
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
              {roster.window.open
                ? <>Onboarding window: <strong style={{ color: 'var(--gold)' }}>{roster.window.daysRemaining} day{roster.window.daysRemaining === 1 ? '' : 's'}</strong> left. Existing residents confirmed before it closes skip the background check.</>
                : <>The onboarding window for this property is closed, so everyone confirmed here completes a background check.</>}
            </div>
          )}

          {error && (
            <div style={{ padding: 12, borderRadius: 8, background: 'rgba(220,80,80,.08)', border: '1px solid rgba(220,80,80,.3)', color: 'var(--red,#dc5050)', fontSize: '.82rem', marginBottom: 12 }}>
              {error}
            </div>
          )}
          {problems.length > 0 && (
            <div style={{ padding: 12, borderRadius: 8, background: 'rgba(220,80,80,.08)', border: '1px solid rgba(220,80,80,.3)', marginBottom: 12 }}>
              <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--red,#dc5050)', marginBottom: 6 }}>Fix these, then press Confirm again:</div>
              {problems.map((p, i) => <div key={i} style={{ fontSize: '.8rem', color: 'var(--text-1)', padding: '2px 0' }}>• {p}</div>)}
            </div>
          )}

          {notPlaced.length > 0 && (
            <div className="card" style={{ padding: 14, marginBottom: 14, border: '1px solid var(--gold)' }}>
              <div style={{ fontSize: '.85rem', fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>Not placed yet ({notPlaced.length})</div>
              <div style={{ fontSize: '.76rem', color: 'var(--text-2)', marginBottom: 10 }}>Pick the unit each person lives in.</div>
              {notPlaced.map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid var(--border-0)' }}>
                  <div style={{ flex: '1 1 220px', fontSize: '.82rem', color: 'var(--text-1)' }}>
                    <strong>{p.firstName} {p.lastName}</strong> <span style={{ color: 'var(--text-3)' }}>{p.email}</span>
                    {p.file?.unitNumber && <span style={{ display: 'block', fontSize: '.72rem', color: 'var(--text-3)' }}>Your file said: {p.file.propertyName} {p.file.unitNumber}</span>}
                  </div>
                  <select className="input" value="" style={{ width: 'auto', minWidth: 170, fontSize: '.8rem' }}
                    onChange={e => { if (e.target.value) patch(p.id, { unitId: e.target.value }) }}>
                    <option value="">Pick their unit…</option>
                    {placeable.map(u => <option key={u.id} value={u.id}>Unit {u.unitNumber}</option>)}
                  </select>
                  <button className="btn btn-danger btn-sm" onClick={() => remove(p.id, `${p.firstName} ${p.lastName}`.trim())}>Remove</button>
                </div>
              ))}
            </div>
          )}

          {units.map(u => (
            <RosterUnitCard key={u.unitId} unit={u} windowOpen={!!roster?.window?.open} placeable={placeable}
              onPatch={patch} onRemove={remove} />
          ))}

          <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg-1)', borderTop: '1px solid var(--border-0)', padding: '12px 0', marginTop: 8 }}>
            <button type="button" className="btn btn-primary" style={{ width: '100%' }}
              disabled={!!confirmBlocked || confirmMut.isLoading}
              onClick={() => confirmMut.mutate()}>
              {confirmMut.isLoading ? 'Drafting the leases…'
                : `Confirm roster and draft ${units.length} lease${units.length === 1 ? '' : 's'}`}
            </button>
            {confirmBlocked && !confirmMut.isLoading && (
              <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 6, textAlign: 'center' }}>{confirmBlocked}</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** One unit's household on the roster: who, what the file said, and the household's settings. */
function RosterUnitCard({ unit, windowOpen, placeable, onPatch, onRemove }: {
  unit: any; windowOpen: boolean; placeable: any[]
  onPatch: (id: string, body: any) => Promise<void>; onRemove: (id: string, name: string) => Promise<void>
}) {
  const people: any[] = unit.people ?? []
  const first = people[0]
  const all = (body: any) => Promise.all(people.map(p => onPatch(p.id, body)))
  const blockers: string[] = unit.blockers ?? []
  const existing = people.every(p => p.existingResident !== false)
  const dueDay = people.find(p => p.rentDueDay != null)?.rentDueDay
  const sale = people.some(p => p.homeSale)
  const [ticked, setTicked] = useState<Record<string, boolean> | null>(null)
  // A whole unit's household has one old balance; in a by-room unit each
  // person is their own lease, so each keeps their own (on their row below).
  const byRoom = unit.occupancyMode === 'by_room'
  const balanceHolder = people.find(p => p.openingBalance != null) ?? first
  const fileRent = first?.file?.monthlyRent ? Number(String(first.file.monthlyRent).replace(/[$,\s]/g, '')) : null
  const rentDiffers = fileRent != null && Number.isFinite(fileRent) && unit.rent != null && Math.abs(fileRent - unit.rent) >= 0.005
  return (
    <div className="card" style={{ padding: 14, marginBottom: 10, border: blockers.length ? '1px solid rgba(220,80,80,.45)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: '.9rem', fontWeight: 700, color: 'var(--text-0)' }}>
          Unit {unit.unitNumber}
          {unit.occupancyMode === 'by_room' && <span style={{ fontSize: '.72rem', color: 'var(--text-3)', fontWeight: 400 }}> · by the room</span>}
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>
          {unit.rent != null && unit.rent > 0 ? <>Lease drafts at <strong style={{ color: 'var(--gold)' }}>{usd(unit.rent)}/mo</strong></> : 'No rent set'}
        </div>
      </div>

      {blockers.length > 0 && (
        <div style={{ background: 'rgba(220,80,80,.07)', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
          {blockers.map((b, i) => <div key={i} style={{ fontSize: '.78rem', color: 'var(--red,#dc5050)', padding: '1px 0' }}>{b}</div>)}
        </div>
      )}

      {first?.file && (first.file.monthlyRent || first.file.leaseStart || first.file.securityDeposit) && (
        <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
          From your file, for reference: {[
            first.file.monthlyRent && <span key="r" style={rentDiffers ? { color: 'var(--amber,#d97706)', fontWeight: 600 } : undefined}>
              rent {usd(fileRent)}{rentDiffers ? ` (differs from this unit's ${usd(unit.rent)})` : ''}</span>,
            first.file.leaseStart && <span key="s">lease started {first.file.leaseStart}</span>,
            first.file.securityDeposit && <span key="d">deposit {first.file.securityDeposit}</span>,
          ].filter(Boolean).reduce((acc: any[], el, i) => (i ? [...acc, ' · ', el] : [el]), [])}
        </div>
      )}

      {people.map((p, i) => (
        <div key={p.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border-0)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: '.68rem', color: i === 0 || byRoom ? 'var(--gold)' : 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>
              {byRoom ? 'Their own lease' : i === 0 ? 'Holds the lease' : `Co-tenant ${i}`}
            </span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select className="input" value="" style={{ width: 'auto', fontSize: '.74rem', padding: '3px 6px' }}
                onChange={e => { if (e.target.value === '__none') onPatch(p.id, { unitId: null }); else if (e.target.value) onPatch(p.id, { unitId: e.target.value }) }}>
                <option value="">Move to…</option>
                {placeable.filter(u => u.id !== unit.unitId).map(u => <option key={u.id} value={u.id}>Unit {u.unitNumber}</option>)}
                <option value="__none">Not placed</option>
              </select>
              <button className="btn btn-danger btn-sm" style={{ padding: '1px 8px' }}
                onClick={() => onRemove(p.id, `${p.firstName} ${p.lastName}`.trim())}>Remove</button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <BlurInput value={p.firstName} placeholder="First name" onCommit={v => onPatch(p.id, { firstName: v })} />
            <BlurInput value={p.lastName} placeholder="Last name" onCommit={v => onPatch(p.id, { lastName: v })} />
            <BlurInput value={p.email} type="email" placeholder="Email" onCommit={v => onPatch(p.id, { email: v })} />
            <BlurInput value={p.phone ?? ''} placeholder="Phone (optional)" onCommit={v => onPatch(p.id, { phone: v })} />
          </div>
          {byRoom && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '.76rem', color: 'var(--text-2)', marginTop: 6 }}>
              Their old balance owed
              <BlurInput width={110} placeholder="0.00" value={p.openingBalance != null ? String(p.openingBalance) : ''}
                onCommit={v => onPatch(p.id, { openingBalance: v === '' ? null : v })} />
            </label>
          )}
        </div>
      ))}

      <div style={{ borderTop: '1px solid var(--border-0)', paddingTop: 10, marginTop: 4 }}>
        {windowOpen ? (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', marginBottom: 10 }}>
            <input type="checkbox" checked={existing} onChange={e => all({ existingResident: e.target.checked })} style={{ marginTop: 3 }} />
            <span style={{ fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--text-1)' }}>They already live here — skip the background check.</strong>
            </span>
          </label>
        ) : null}
        {windowOpen && existing && (
          <DueDayPicker value={dueDay != null ? String(dueDay) : ''} onChange={v => all({ rentDueDay: v === '' ? null : Number(v) })} />
        )}
        {unit.dwellingOwnership === 'landlord' && unit.unitType === 'mobile_home' && (
          // Selling the home changes the packet (the sale papers go in), so the
          // ticks start again from the package's own suggestion.
          <HomeSaleToggle sale={sale ? emptyHomeSale() : null} setSale={v => all({ homeSale: !!v, packageTemplateIds: null })} />
        )}
        <PacketChecklist unitId={unit.unitId} sale={sale} ticked={ticked} setTicked={setTicked}
          initial={first?.packageTemplateIds ?? null}
          onUserChange={next => all({ packageTemplateIds: tickedIds(next) ?? [] })} />
        {byRoom ? (
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
            Each person here rents by the room on their own lease, so each old balance above is theirs alone. It posts once, as one
            charge on their own lease when it starts. No late fees on it.
          </div>
        ) : (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '.76rem', color: 'var(--text-2)' }}>
            Old balance owed
            <BlurInput width={110} placeholder="0.00" value={balanceHolder?.openingBalance != null ? String(balanceHolder.openingBalance) : ''}
              onCommit={v => onPatch(balanceHolder.id, { openingBalance: v === '' ? null : v })} />
            <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>One balance for the whole household. It posts once, as one charge on their lease when it starts. No late fees on it.</span>
          </label>
        )}
      </div>
    </div>
  )
}
