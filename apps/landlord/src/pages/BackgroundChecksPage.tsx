import { useEffect, useMemo, useState } from 'react'
import { useUrlTab } from '../lib/useUrlTab'
import { useQuery } from 'react-query'
import { humanize } from '@gam/shared'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { EntityPicker, useEntities } from '../components/EntityPicker'
import { toast } from '../components/dialogs'
import { ScreeningsWaitingPanel } from '../../../../packages/shared-ui/ScreeningsWaitingPanel'

/** Shared with the front desk's own Checks tab in the POS — one list, both screens. */
const screeningsApi = { get: apiGet, post: apiPost }

// S527 W-6: the real applicant list is GET /background (not /background-checks).
// S561: rows are now clickable → a review modal with Approve / Deny. On Deny,
// the landlord composes and sends their OWN adverse-action notice (GAM authors
// no legal content); GAM returns the credit-bureau contact facts + the
// landlord's saved template to help, and delivers/records what they send.
const STATUS_MAP: Record<string, string> = {
  approved: 'badge-green', denied: 'badge-red', pending: 'badge-amber',
  awaiting_applicant: 'badge-amber', submitted: 'badge-blue',
  processing: 'badge-blue', complete: 'badge-green',
  failed: 'badge-red', cancelled: 'badge-muted', expired: 'badge-muted',
}
// Statuses the API's /decision route will accept a decision for. 10/5 (Nic,
// A6): only once the results are back — a decision before then is refused.
const DECIDABLE = new Set(['complete'])
// Still on its way to a result: submitted to the screener, or being worked.
const RESULTS_PENDING = new Set(['submitted', 'processing'])

// 10/5 (Nic, R10/A8): a guest screened for a STAY. Their approval clears the
// stay for check-in; it is never waiting on a space or a lease here — a stay
// that chose a lease already has its own draft on the Leases page.
const stayDay = (ymd: string | null | undefined) =>
  ymd ? new Date(String(ymd).slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : null
// 10/19 (Nic): "they did move in and then they left." Until now a check only
// ever found a stay that was still ahead or running, so every one of these said
// "they can be checked in from the schedule" — which reads as a to-do, and is
// the opposite of true for two guests who left yesterday. A stay that is behind
// them says so instead.
//
// Whether it is behind them is the SERVER's answer (stayOver), not a comparison
// against this browser's clock. The same row decides which list it sits on and
// whether it is still cleared for check-in, and all of that is settled on the
// database's date — so a manager working from a laptop set to another timezone
// reads the same thing as the front desk, instead of being told a guest had
// finished their stay hours before the guest had packed up.
const stayIsOver = (c: any) => !!c?.stayOver

type Cra = { name: string; address: string; phone: string; website: string | null }

export function BackgroundChecksPage() {
  const { data: checks = [], isLoading, refetch } = useQuery<any[]>('background-checks', () => apiGet('/background'))
  const [selected, setSelected] = useState<any | null>(null)
  const [denyFlow, setDenyFlow] = useState<{ checkId: string; cra: Cra | null; savedTemplate: string | null } | null>(null)
  // S653 (Nic): "the main background checks page is only showing people that
  // need attention." The API says which list a row is on (bucket); denied,
  // housed, expired and cancelled sit behind the Past tab, searchable.
  const [tab, setTab] = useUrlTab('tab', 'attention', ['attention','past'] as const)
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()

  // ── 10/19 (Nic): NARROW THE LIST BY COMPANY AND BY PARK ──────────────────
  //
  // "I can't choose my property on the background check page. I can't go to the
  //  Oak Park ones, I guess. … So we need a way to filter that."
  //
  // Nothing was hidden — the list is the whole account — but two companies and
  // five parks arrive as one run of names with no way to say which ones he is
  // looking at. The company choice is the same control the bank and front-desk
  // pages use, so there is one way to pick a company in this portal, and it
  // renders nothing at all for an account that owns one.
  //
  // Both filters only ever NARROW: they sift the rows the server already
  // decided this login may read, and the park list is built from those same
  // rows, so choosing one can never reach a park whose screenings were not sent
  // in the first place. A staff login scoped to one park gets no company
  // control (the entities list is the owner's) and only its own park to choose.
  const [companyId, setCompanyId] = useState('')
  const [propertyId, setPropertyId] = useState('')
  const { data: entities = [] } = useEntities()
  // One company is not a choice — the picker auto-selects it and hides itself,
  // and a row must never drop out of a list that offers nothing to filter by.
  const byCompany = entities.length > 1 ? companyId : ''
  const ofCompany = useMemo(
    () => (checks as any[]).filter(c => !byCompany || c.landlordId === byCompany),
    [checks, byCompany])

  // The parks that actually have screenings, in the chosen company.
  const parks = useMemo(() => Array.from(
    new Map(ofCompany.filter(c => c.propertyId)
      .map(c => [c.propertyId as string, String(c.propertyName || 'Unnamed property')])).entries(),
  ).sort((a, b) => a[1].localeCompare(b[1])), [ofCompany])
  // Switching company drops a park that company does not own, rather than
  // leaving a filter set to something no longer on the list and an empty table.
  useEffect(() => {
    if (propertyId && !parks.some(([id]) => id === propertyId)) setPropertyId('')
  }, [parks, propertyId])

  const scoped = ofCompany.filter(c => !propertyId || c.propertyId === propertyId)
  const attention = scoped.filter(c => c.bucket !== 'past')
  const past = scoped.filter(c => c.bucket === 'past')
  const shown = (tab === 'attention' ? attention : past).filter(c => !term ||
    [c.firstName, c.lastName, c.email, c.unitNumber, c.propertyName].some(v => String(v ?? '').toLowerCase().includes(term)))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Background Checks</h1><p className="page-subtitle">
          {attention.length} need{attention.length === 1 ? 's' : ''} attention · {past.length} past
        </p></div>
      </div>
      <EntityPicker value={companyId} onChange={setCompanyId} label="Company"
        note="Choose one to see only its applicants." />
      {/* 10/21 (Nic): checks somebody has already PAID for and not done. They
          are not applicants yet — no report, nothing to decide — so they are
          not in either list below, and until now they were in no list at all.
          The address is editable because a mistyped one is both why the link
          never arrived and why they cannot sign in to sort it out themselves. */}
      <ScreeningsWaitingPanel propertyId={propertyId || null} api={screeningsApi} />
      <div className="filter-bar" style={{display:'flex',gap:6,alignItems:'center',marginBottom:12,flexWrap:'wrap'}}>
        <button type="button" className={`btn btn-sm ${tab === 'attention' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('attention')}>
          Needs attention ({attention.length})
        </button>
        <button type="button" className={`btn btn-sm ${tab === 'past' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('past')}>
          Past ({past.length})
        </button>
        {parks.length > 1 && (
          <select className="input" style={{maxWidth:260}} value={propertyId} onChange={e => setPropertyId(e.target.value)}>
            <option value="">All properties</option>
            {parks.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <input className="input" style={{marginLeft:'auto',maxWidth:280}} placeholder="Name, email, space…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table" style={{minWidth:780}}>
            {/* S639 (Nic): "is that low risk vetted by Checkr?" No — and the
                column said "Risk" as though it were. riskLevel is GAM's own
                INTAKE score, computed from what the applicant typed on the form
                (stated income, employment, how fast they filled it in) before
                Checkr is contacted at all. Anastacio read "low" here while
                Checkr's verdict on him was CONSIDER. Two different questions,
                and the screening answer is the one a tenancy turns on, so it
                gets the column and the intake score is named for what it is. */}
            <thead><tr><th>Applicant</th><th>Started</th><th>Screening</th><th>Intake score</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {shown.length ? shown.map((c: any) => (
                <tr key={c.id} onClick={() => { setSelected(c); refetch() }} style={{cursor:'pointer'}}>
                  <td style={{fontWeight:500}}>{[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}</td>
                  <td className="mono">{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}</td>
                  <td>
                    {(() => {
                      // Checkr's verdict — the one that matters for a tenancy decision.
                      const v = (c.reportSummary && typeof c.reportSummary === 'object')
                        ? (c.reportSummary as any).result : null
                      return <span className={`badge ${v === 'clear' ? 'badge-green' : v === 'consider' ? 'badge-amber' : 'badge-muted'}`}>
                        {v === 'clear' ? 'Clear' : v === 'consider' ? 'Consider' : 'Not back yet'}
                      </span>
                    })()}
                  </td>
                  <td>
                    {c.riskLevel
                      ? <span className={`badge ${c.riskLevel === 'low' ? 'badge-green' : c.riskLevel === 'medium' ? 'badge-amber' : 'badge-red'}`} title="GAM's intake plausibility score from the application form — NOT the background check result">{c.riskLevel}{c.riskScore != null ? ` · ${c.riskScore}` : ''}</span>
                      : <span style={{color:'var(--text-3)'}}>—</span>}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_MAP[c.status] || 'badge-muted'}`}>{humanize(c.status) || '—'}</span>
                    {c.status === 'approved' && c.clearedForStay && (stayIsOver(c)
                      ? <span className="badge badge-muted" style={{marginLeft:4}} title="Screened for their stay — they stayed and checked out">Stay finished</span>
                      : <span className="badge badge-muted" style={{marginLeft:4}} title="Screened for their stay — they can be checked in">Cleared for their stay</span>)}
                    {c.status === 'approved' && !c.clearedForStay && c.housed && <span className="badge badge-muted" style={{marginLeft:4}} title="A lease exists for them">Housed</span>}
                    {c.status === 'approved' && !c.clearedForStay && !c.housed && c.parkedAt && <span className="badge badge-muted" style={{marginLeft:4}} title={c.parkedNote || 'Set aside — not moving in for now'}>Not moving in for now</span>}
                    {c.status === 'approved' && !c.clearedForStay && !c.housed && !c.parkedAt && <span className="badge badge-gold" style={{marginLeft:4}} title="Approved — pick a space and draft the lease">Needs a lease</span>}
                  </td>
                  <td style={{textAlign:'right',color:'var(--text-3)',fontSize:'.8rem'}}>Review →</td>
                </tr>
              )) : (
                <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>
                  {term ? 'Nobody matches that.'
                    : propertyId || byCompany ? 'No screenings here.'
                    : tab === 'attention' ? 'Nobody needs anything from you right now.' : 'Nothing here yet.'}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <ReviewModal
          // 10/4: always the row as it is NOW — the list refetches when the
          // window opens and closes, so an approval left at "Which space?"
          // reopens on that step, never on Approve / Deny again.
          check={(checks as any[]).find(c => c.id === selected.id) ?? selected}
          onClose={() => { setSelected(null); refetch() }}
          onDecided={(denied) => {
            refetch()
            if (denied) {
              // Deny → open the adverse-action compose modal with the facts
              // the decision response handed back.
              setDenyFlow(denied)
            }
            setSelected(null)
          }}
        />
      )}

      {denyFlow && (
        <AdverseActionModal
          flow={denyFlow}
          onClose={() => setDenyFlow(null)}
          onSent={() => { setDenyFlow(null); refetch() }}
        />
      )}
    </div>
  )
}

// ========== Applicant review + decision ==========
/**
 * 10/24 (Nic) — EVERYTHING CHECKR SENT, RENDERED WITHOUT A FIELD LIST.
 *
 *   "why do we not provide more of the information that came from Checker to
 *    the landlord?... Some of those other details are important, not just a
 *    clear or consider."
 *
 * Written GENERICALLY on purpose. The reason the landlord only ever saw a score
 * was a hand-written list of fields on the server that dropped anything it did
 * not name, and a hand-written list here would fail the same way the first time
 * Checkr adds a field. So this walks whatever arrived: objects nest, arrays
 * count themselves and list their contents, and a key it has never seen before
 * still lands on the screen with its name tidied up.
 *
 * The server has already held back the identity DOCUMENT — images, licence
 * number, and any link out to Checkr's dashboard (services/backgroundProvider).
 * Nothing here needs to know that; it renders what it is given.
 */
// Checkr sends rates ALREADY as percentages — on_time_payment_rate 90 means
// 90%, and a utilization of 184 means 184%. Multiplying by 100 here (which is
// what this did first) put "9000%" in front of a landlord, which is exactly the
// kind of number that must never reach one.
const asPct = (n: unknown): string => {
  const v = Number(n)
  if (!Number.isFinite(v)) return String(n)
  return `${Math.round(v * 10) / 10}%`
}
const asMoney = (cents: unknown): string => {
  const v = Number(cents)
  if (!Number.isFinite(v)) return String(cents)
  return `$${(v / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
/**
 * "onTimePaymentRate" → "On time payment rate".
 *
 * 10/24 (Nic): "it's confusing the word balances with two split words meaning
 * balance and cents, like loose change... it says open collections balance
 * cents." Right, and it was mine, not Checkr's. Those fields are named for how
 * the number is STORED — open_collections_balance_cents is an integer count of
 * cents — and the value was already being formatted as money while the label
 * still carried the unit. So the label read "Open collections balance cents"
 * next to "$1,842.00", which reads like a column about loose change.
 *
 * The unit belongs to the storage, not to the reader: it is dropped here, and
 * the money formatting that keys off the same suffix is untouched.
 */
const SAID_BETTER: Record<string, string> = {
  // "Consider reasons" is a field's name, not a sentence anybody says.
  considerReasons: 'Why it says consider',
  creditScoreFactors: 'What moved the score',
  creditFileStatus: 'Credit file',
  evictionReportStatus: 'Eviction report',
}
const tidyKey = (k: string): string => {
  if (SAID_BETTER[k]) return SAID_BETTER[k]
  const words = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  const said = words.replace(/\s+(cents|count|months)$/, '').replace(/\bcharge offs\b/, 'charge-offs')
  return said.charAt(0).toUpperCase() + said.slice(1)
}
/**
 * A percentage, and only when the value really is one. creditUtilization
 * matches this name but arrives as an OBJECT ({ rate, limitCents,
 * balanceCents }), and a percentage formatter run over an object prints
 * "NaN%" — which is exactly what the first version of the headline line did.
 * Objects go down the nested branch before they reach here, so this is belt
 * and braces; it is checked rather than assumed because that bug was real.
 */
const looksLikeRate = (k: string, v?: unknown) =>
  /(rate|utilization|ratio|percent)$/i.test(k) && (v === undefined || typeof v === 'number')
/**
 * Checkr's payment_timeline is two dozen months of
 * { month, lateCount, onTimeRate, onTimeCount }. The figure a landlord reads
 * off it is how many payments were late lately — Nic read "9 payments late in
 * the last 7 months" off exactly this — so it is counted here rather than left
 * for somebody to add up twenty-four rows by eye.
 */
const lateInLastMonths = (timeline: unknown, months: number): number | null => {
  if (!Array.isArray(timeline) || !timeline.length) return null
  const recent = [...timeline]
    .filter((m: any) => m && typeof m === 'object' && typeof m.month === 'string')
    .sort((a: any, b: any) => String(b.month).localeCompare(String(a.month)))
    .slice(0, months)
  if (!recent.length) return null
  return recent.reduce((n: number, m: any) => n + (Number(m.lateCount) || 0), 0)
}
const looksLikeMoney = (k: string) => /cents$/i.test(k)
/** A count of months reads as months, beside a label that no longer says it. */
const looksLikeMonths = (k: string) => /months$/i.test(k)

function PaymentTimeline({ rows }: { rows: any[] }) {
  const months = [...rows].sort((a, b) => String(b.month).localeCompare(String(a.month)))
  return (
    <div style={{display:'grid',gap:2}}>
      {months.map((m, i) => {
        const late = Number(m.lateCount) || 0
        return (
          <div key={i} style={{display:'flex',justifyContent:'space-between',gap:12,fontSize:'.78rem'}}>
            <span style={{color:'var(--text-3)'}}>{String(m.month)}</span>
            <span style={{textAlign:'right',color: late > 0 ? 'var(--amber,#f59e0b)' : 'var(--text-1)',fontWeight:600}}>
              {late > 0 ? `${late} late` : 'all on time'}
              {m.onTimeCount != null && <span style={{color:'var(--text-3)',fontWeight:500}}> · {m.onTimeCount} paid</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ReportDetail({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null) return <span style={{color:'var(--text-3)'}}>—</span>
  if (Array.isArray(value)) {
    // A month-by-month payment history reads as a list of months, not as two
    // dozen nested blocks of four fields each.
    if (value.length && value.every((v: any) => v && typeof v === 'object' && typeof v.month === 'string')) {
      return <PaymentTimeline rows={value as any[]} />
    }
    if (value.length === 0) return <span style={{color:'var(--text-3)'}}>None</span>
    return (
      <div style={{display:'grid',gap:6}}>
        {value.map((v, i) => (
          <div key={i} style={{paddingLeft:depth?8:0}}>
            {typeof v === 'object' && v !== null
              ? <ReportDetail value={v} depth={depth + 1} />
              : <span style={{color:'var(--text-1)'}}>{String(v)}</span>}
          </div>
        ))}
      </div>
    )
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // Row ids and timestamps are plumbing, not something a landlord weighs.
      .filter(([k]) => !/^id$|Id$|^created_?At$|^updated_?At$/i.test(k))
      // 10/24: and at the top of a product its own `status` is the verdict the
      // row above already shows in colour — "Status: clear" under "Clear" is
      // the page repeating itself.
      .filter(([k]) => !(depth === 0 && k === 'status'))
    if (!entries.length) return <span style={{color:'var(--text-3)'}}>—</span>
    return (
      <div style={{display:'grid',gap:4}}>
        {entries.map(([k, v]) => {
          const nested = v !== null && typeof v === 'object'
          return (
            <div key={k} style={nested
              ? {paddingTop:4}
              : {display:'flex',justifyContent:'space-between',gap:12,fontSize:'.8rem'}}>
              <span style={{color:'var(--text-3)'}}>{tidyKey(k)}</span>
              {nested
                ? <div style={{marginTop:2,paddingLeft:10,borderLeft:'1px solid var(--border-0)'}}>
                    <ReportDetail value={v} depth={depth + 1} />
                  </div>
                : <span style={{color:'var(--text-1)',fontWeight:600,textAlign:'right'}}>
                    {typeof v === 'boolean' ? (v ? 'Yes' : 'No')
                      : looksLikeMoney(k) ? asMoney(v)
                      : looksLikeRate(k, v) ? asPct(v)
                      : looksLikeMonths(k) ? `${v} month${Number(v) === 1 ? '' : 's'}`
                      : String(v)}
                  </span>}
            </div>
          )
        })}
      </div>
    )
  }
  return <span style={{color:'var(--text-1)',fontWeight:600}}>{String(value)}</span>
}

function ReviewModal({ check, onClose, onDecided }: {
  check: any
  onClose: () => void
  onDecided: (denyFlow: { checkId: string; cra: Cra | null; savedTemplate: string | null } | null) => void
}) {
  const [busy, setBusy] = useState<'' | 'approved' | 'denied'>('')
  // 10/24 (Nic): which product's full detail is open. One at a time — the
  // report is long and a landlord is looking for one thing at a time.
  const [openDetail, setOpenDetail] = useState<string | null>(null)
  const decidable = DECIDABLE.has(check.status)

  // S639: an approval used to end at "approved" with nothing to click. The
  // application already carries the space, the move-in date and the term, so
  // the next step is one button — it files the screening as an application and
  // hands it to the same drafter the listings door uses.
  const [drafting, setDrafting] = useState(false)
  const [pickedUnit, setPickedUnit] = useState('')
  // A walk-up who scanned the park's QR code named no space — that is the point
  // of the code. The park IS known, so the choice is between ITS vacant units
  // and nothing else: unit numbers repeat across parks, and a cross-property
  // list here would let one wrong click file a lease at another property.
  // S653: after an approval in THIS modal the prop is stale (the list has not
  // refetched yet), so the approved state is tracked here too.
  const [approvedNow, setApprovedNow] = useState(false)
  const isApproved = check.status === 'approved' || approvedNow
  // A guest screened for a stay: their check only clears check-in (R10/A8).
  const forStay = !!check.stayBookingId
  // 10/19 (Nic): and once that stay is behind them, not even that.
  const over = forStay && stayIsOver(check)
  const needsUnit = isApproved && !check.unitId && !forStay
  const { data: vacants = [] } = useQuery<any[]>(
    ['vacant-units', check.propertyId],
    () => apiGet(`/units?propertyId=${check.propertyId}`),
    { enabled: !!(needsUnit && check.propertyId) },
  )
  const choosable = (vacants as any[]).filter(u => u.status === 'vacant')

  // S653 (Nic): the draft IS the signing packet. Land on it to sign — never on
  // an edit window. No default template for the unit type → GoldSign, where
  // one is set, and the sweep drafts the moment it exists.
  const landOnDraft = (d: any) => {
    if (d?.documentId) {
      toast(`Lease drafted for ${d.unitNumber || 'the space'} — sign it and it goes to them.`)
      window.location.href = `/sign/${d.documentId}`
    } else if (d?.needsTemplate) {
      toast.error(`No default lease template for that unit type yet — set one in GoldSign and the lease drafts on its own.`)
      window.location.href = '/esign'
    } else {
      toast('Lease drafted — it is waiting for your signature in GoldSign.')
      window.location.href = '/esign'
    }
  }

  const draftLease = async () => {
    setDrafting(true)
    try {
      const res: any = await apiPost(`/background/${check.id}/draft-lease`,
        pickedUnit ? { unitId: pickedUnit } : {})
      const d = res?.data ?? res
      onClose()
      landOnDraft(d)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not draft a lease.')
      setDrafting(false)
    }
  }

  const decide = async (decision: 'approved' | 'denied') => {
    setBusy(decision)
    try {
      const res: any = await apiPatch(`/background/${check.id}/decision`, { decision })
      if (decision === 'approved' && res?.stay) {
        // A stay guest: cleared for check-in, nothing to draft (R10/A8).
        toast(res.stay.leaseId
          ? 'Approved — cleared for their stay. Their lease is already drafted on the Leases page.'
          : 'Approved — cleared for their stay. Check them in from the schedule.')
        onDecided(null)
        return
      }
      if (decision === 'approved' && res?.alreadyApproved) {
        // An older screen: it was approved already — show the next step here.
        toast(res.needsUnit ? 'Already approved. Which space are they taking?' : 'Already approved. Draft their lease, or mark them not moving in for now.')
        setApprovedNow(true)
        setBusy('')
        return
      }
      if (decision === 'approved') {
        // S653 (Nic): "When we approve somebody... it doesn't automatically draft
        // up a lease for me to sign." Now it does: the approval drafted it, so
        // go straight to it. A walk-up with no space named stays here to pick one.
        if (res?.lease) {
          onDecided(null)
          landOnDraft(res.lease)
          return
        }
        if (res?.needsUnit) {
          toast('Approved. Which space are they taking?')
          setApprovedNow(true)
          setBusy('')
          return
        }
        toast.error(res?.draftError ? `Approved, but the lease could not be drafted: ${res.draftError}` : 'Approved.')
        onDecided(null)
      } else {
        toast('Applicant denied. Send them an adverse-action notice.')
        onDecided({
          checkId: check.id,
          cra: res?.adverseAction?.craInfo ?? null,
          savedTemplate: res?.adverseAction?.savedTemplate ?? null,
        })
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not record the decision.')
      setBusy('')
    }
  }

  // S653 (Nic): "keep them approved but mark them as dormant for now." The
  // approval stands; they leave the to-do list until they turn up again.
  const [parkNote, setParkNote] = useState('')
  const [parking, setParking] = useState(false)
  const park = async (dir: 'park' | 'unpark') => {
    setParking(true)
    try {
      await apiPost(`/background/${check.id}/${dir}`, dir === 'park' ? { note: parkNote.trim() || null } : {})
      toast(dir === 'park' ? 'Set aside — still approved, off the to-do list.' : 'Back on the to-do list.')
      onDecided(null)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not save that.')
      setParking(false)
    }
  }

  const field = (label: string, value: any) => (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:'.68rem',textTransform:'uppercase',letterSpacing:'.05em',color:'var(--text-3)',marginBottom:2}}>{label}</div>
      <div style={{fontSize:'.88rem',color:'var(--text-1)'}}>{value || '—'}</div>
    </div>
  )

  const report = check.reportSummary && typeof check.reportSummary === 'object' ? check.reportSummary : null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{maxWidth:640}} onClick={e => e.stopPropagation()}>
        <div className="modal-title">{[check.firstName, check.lastName].filter(Boolean).join(' ') || 'Applicant'} — screening review</div>
        <div style={{padding:16,maxHeight:'62vh',overflowY:'auto'}}>
          {/* Identity + basics only. Employment/income/prior-landlord were
              self-reported intake fields (not Checkr data) — dropped per the
              keep-it-simple rule. Real deciding factors come from the Checkr
              report block below. */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 24px'}}>
            {field('Status', humanize(check.status))}
            {field('Property / Unit', [check.propertyName, check.unitNumber && `Unit ${check.unitNumber}`].filter(Boolean).join(' · '))}
            {field('Email', check.email)}
            {field('Phone', check.phone)}
            {field('Applied', check.createdAt ? new Date(check.createdAt).toLocaleDateString() : null)}
            {/* S639 (Nic): "I don't know how much he's wanting to have the spot
                for... I don't wanna do back and forth with, hey, they told me
                something, and then I forgot because I was busy." Asked on the
                application now, so the answer is sitting here when he decides. */}
            {field('Wants to move in', check.desiredMoveIn ? new Date(check.desiredMoveIn + 'T00:00:00').toLocaleDateString() : null)}
            {field('Term wanted', check.desiredMonthToMonth ? 'Month to month'
              : check.desiredTermMonths ? `${check.desiredTermMonths} months` : null)}
          </div>

          {/* ── S639 (Nic): "how do I see the actual data in the report? Is the
              landlord gonna have to go to the Checkr settings?" ─────────────

              They could not see it. This block looped the summary's TOP level,
              so it printed order_id, provider and report_id — identifiers of no
              use to anybody — while the findings themselves sat one level down
              inside `products` and rendered as nothing at all. Anastacio
              Erreguin's report came back CONSIDER on the credit file and clear
              on everything else, and none of that reached the screen.

              Per-product, plainly, with the overall verdict first. */}
          {report && (
            <div style={{marginTop:8,padding:12,background:'var(--bg-3)',borderRadius:8}}>
              <div style={{fontSize:'.72rem',textTransform:'uppercase',letterSpacing:'.05em',color:'var(--text-3)',marginBottom:8}}>
                Background report · Checkr
              </div>
              {(() => {
                // report_summary is on camelize's JSONB_PASSTHROUGH_KEYS list, so
                // Checkr's own response shape survives verbatim — these inner keys
                // are deliberately snake_case and camelCase reads return undefined.
                // S639: the API camelizes with lib/caseConversion, which has NO
                // passthrough list — it descends into jsonb, so Checkr's own
                // snake_case keys arrive camelCased and are read that way.
                // (packages/shared/camelize DOES have a passthrough list; it is a
                // different, client-side camelizer. I read that one, marked the
                // wire-contract guard a false positive, and shipped reads that
                // returned undefined — the exact bug the guard exists to catch.)
                const r: any = report
                const verdict = typeof r.result === 'string' ? r.result : null
                const products: Record<string, any> = (r.products && typeof r.products === 'object') ? r.products : {}
                const details: Record<string, any> = (r.details && typeof r.details === 'object') ? r.details : {}
                // S639: the figures that explain a status — a credit score of 720
                // reading "consider" makes no sense until you can see the 720.
                const detailFor = (k: string): string | null => {
                  const d = details[k]
                  if (!d || typeof d !== 'object') return null
                  const bits: string[] = []
                  if (d.creditScore != null) bits.push(`score ${d.creditScore}`)
                  // 10/24: the headline figures off the credit summary, so the
                  // line a landlord skims carries the two numbers they actually
                  // weigh before they open anything.
                  const cs = d.creditSummary
                  if (cs && typeof cs === 'object') {
                    if (cs.onTimePaymentRate != null) bits.push(`${asPct(cs.onTimePaymentRate)} on time`)
                    // Utilization is an OBJECT — { rate, limitCents, balanceCents } —
                    // not a number. Read as a number it rendered NaN.
                    const util = cs.creditUtilization
                    const rate = util && typeof util === 'object' ? util.rate : util
                    if (rate != null) bits.push(`${asPct(rate)} utilization`)
                    // What Nic actually reads off the timeline: how many
                    // payments were late recently, not twenty-four months of rows.
                    const late = lateInLastMonths(cs.paymentTimeline, 12)
                    if (late != null) bits.push(`${late} late in 12mo`)
                  }
                  const recs = Array.isArray(d.records) ? d.records.length
                    : d.recordsCount != null ? Number(d.recordsCount) : null
                  if (recs != null) bits.push(`${recs} record${recs === 1 ? '' : 's'}`)
                  const fileStatus = d.creditFileStatus
                  if (typeof fileStatus === 'string' && fileStatus !== 'available') bits.push(humanize(fileStatus))
                  return bits.length ? bits.join(' · ') : null
                }
                const reportId: string | null = r.reportId ? String(r.reportId) : null
                const fetchedAt: string | null = r.fetchedAt ? String(r.fetchedAt) : null
                const tone = (v: string) => v === 'clear' ? 'var(--green,#22c55e)'
                  : v === 'consider' ? 'var(--amber,#f59e0b)' : 'var(--text-1)'
                return (
                  <>
                    {verdict && (
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                                   paddingBottom:8,marginBottom:8,borderBottom:'1px solid var(--border-0)'}}>
                        <span style={{color:'var(--text-1)',fontWeight:700}}>Overall</span>
                        <span style={{color:tone(verdict),fontWeight:800,fontSize:'.95rem'}}>
                          {verdict === 'clear' ? 'Clear' : verdict === 'consider' ? 'Consider — review before deciding' : humanize(verdict)}
                        </span>
                      </div>
                    )}
                    {Object.keys(products).length === 0 ? (
                      <div style={{fontSize:'.82rem',color:'var(--text-3)'}}>
                        No per-check results returned yet.
                      </div>
                    ) : Object.entries(products).map(([k, v]) => {
                      const extra = detailFor(k)
                      const full = details[k]
                      const openable = !!full && typeof full === 'object' && Object.keys(full).length > 0
                      const isOpen = openDetail === k
                      return (
                        <div key={k}>
                          <div
                            onClick={openable ? () => setOpenDetail(isOpen ? null : k) : undefined}
                            style={{display:'flex',justifyContent:'space-between',fontSize:'.85rem',padding:'4px 0',gap:12,
                                    cursor:openable?'pointer':'default'}}>
                            <span style={{color:'var(--text-2)'}}>
                              {openable && <span style={{color:'var(--text-3)',marginRight:6,fontSize:'.7rem'}}>{isOpen?'▾':'▸'}</span>}
                              {humanize(k)}
                            </span>
                            <span style={{textAlign:'right'}}>
                              <span style={{color:tone(String(v)),fontWeight:600}}>{humanize(String(v))}</span>
                              {extra && <span style={{color:'var(--text-3)',fontWeight:500}}> · {extra}</span>}
                            </span>
                          </div>
                          {openable && isOpen && (
                            <div style={{margin:'2px 0 10px 14px',padding:'8px 10px',background:'var(--bg-2)',
                                         borderRadius:6,borderLeft:'2px solid var(--border-1)'}}>
                              <ReportDetail value={full} />
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {verdict === 'consider' && (
                      <div style={{marginTop:10,fontSize:'.78rem',color:'var(--text-2)',lineHeight:1.5}}>
                        A “consider” is not a decline, and not a judgment that a number is
                        bad — it means the result did not automatically clear the criteria set
                        on the Checkr account, so Checkr is handing you the decision. Read the
                        figures beside each line before deciding. If you do decline on one, the
                        applicant is entitled to an adverse action notice naming the agency and
                        their right to dispute; use the Adverse Action button rather than
                        declining silently.
                      </div>
                    )}
                    {reportId && (
                      <div style={{marginTop:10,fontSize:'.72rem',color:'var(--text-3)'}}>
                        Checkr report {reportId}
                        {fetchedAt ? ` · pulled ${new Date(fetchedAt).toLocaleString()}` : ''}
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          )}

          {RESULTS_PENDING.has(check.status) && (
            <div style={{marginTop:12,fontSize:'.8rem',color:'var(--text-2)'}}>The results aren't back yet. You can approve or deny once they are.</div>
          )}

          {forStay && (
            <div style={{marginTop:12,fontSize:'.8rem',color:'var(--text-2)',lineHeight:1.5}}>
              {over ? 'They stayed'
                : isApproved ? 'Cleared for their stay'
                : 'Screened for their stay'}
              {check.stayCheckIn ? ` — check-in ${stayDay(check.stayCheckIn)}` : ''}
              {check.stayCheckOut ? `, check-out ${stayDay(check.stayCheckOut)}` : ''}.
              {/* 10/19 (Nic): a finished stay is not a to-do. Nothing to check
                  in, nothing to set aside, nothing to draft. */}
              {over ? ' That stay is finished — nothing here is waiting on you.'
                : isApproved ? ' They can be checked in from the schedule.'
                : check.status === 'denied' ? ' You can still check them in from the schedule if you choose to.'
                : check.status === 'complete' ? ' Check-in waits for your decision.'
                : ' Check-in waits for the results and your decision.'}
              {check.stayLeaseId ? ' They chose a lease — it is already drafted on the Leases page.' : ''}
            </div>
          )}

          {check.status === 'denied' && (
            <div style={{marginTop:12,fontSize:'.8rem',color:'var(--text-2)'}}>This applicant was denied{check.decidedAt ? ` on ${new Date(check.decidedAt).toLocaleDateString()}` : ''}. If a screening report factored into the decision, federal law requires sending an adverse-action notice.</div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={!!busy}>Close</button>
          {isApproved && forStay && check.stayLeaseId && (
            <button className="btn btn-primary" onClick={() => { window.location.href = `/leases?open=${check.stayLeaseId}` }}>
              Open their lease
            </button>
          )}
          {isApproved && !forStay && !check.housed && (
            check.parkedAt ? (
              <button className="btn btn-ghost" onClick={() => park('unpark')} disabled={parking}
                title={check.parkedNote ? `Set aside: ${check.parkedNote}` : 'Set aside — not moving in for now'}>
                {parking ? '…' : 'They\'re back'}
              </button>
            ) : (
              <div style={{display:'flex',gap:6,alignItems:'center'}}>
                <input className="input" style={{maxWidth:200}} placeholder="Why? (optional)" value={parkNote} onChange={e => setParkNote(e.target.value)} />
                <button className="btn btn-ghost" onClick={() => park('park')} disabled={parking}
                  title="Keeps the approval; takes them off Needs attention until they turn up again">
                  {parking ? '…' : 'Not moving in for now'}
                </button>
              </div>
            )
          )}
          {/* 10/24 (Nic): "Why is it offering me the option to draft a lease for
              two people who are already on a lease and that background check was
              used to populate the lease with their name and stuff?"
              Because this was the one control in the approved block that did not
              ask whether they are already housed — the "Not moving in for now"
              control directly above has always asked. Robert Housley and James
              Fenton are both on leases here and were being offered a second one;
              Victor and Nemesio are matched to their old stays (by guest email),
              which skips this whole block, which is why only those two looked
              right. `housed` is true for a pending or active lease OR a live
              draft, so this also stops a second draft being raised on top of one
              already out for signature. */}
          {isApproved && !forStay && check.housed && (
            <span style={{fontSize:'.8rem',color:'var(--text-2)'}}>
              Already on a lease here — nothing is waiting on this check.
            </span>
          )}
          {isApproved && !forStay && !check.housed && (
            <>
              {needsUnit && (
                <select className="input" style={{maxWidth:220}} value={pickedUnit} onChange={e => setPickedUnit(e.target.value)}>
                  <option value="">Which space?</option>
                  {choosable.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.unitNumber}{u.rentAmount ? ` · $${Number(u.rentAmount).toLocaleString()}/mo` : ''}
                    </option>
                  ))}
                </select>
              )}
              <button className="btn btn-primary" onClick={draftLease} disabled={drafting || (needsUnit && !pickedUnit)}>
                {drafting ? 'Drafting…' : 'Draft lease'}
              </button>
            </>
          )}
          {decidable && !approvedNow && (
            <>
              <button className="btn" style={{background:'var(--danger,#dc2626)',color:'#fff',borderColor:'var(--danger,#dc2626)'}} onClick={() => decide('denied')} disabled={!!busy}>
                {busy === 'denied' ? 'Denying…' : 'Deny'}
              </button>
              <button className="btn btn-primary" onClick={() => decide('approved')} disabled={!!busy}>
                {busy === 'approved' ? 'Approving…' : 'Approve'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ========== Adverse-action compose + send ==========
function AdverseActionModal({ flow, onClose, onSent }: {
  flow: { checkId: string; cra: Cra | null; savedTemplate: string | null }
  onClose: () => void
  onSent: () => void
}) {
  const [text, setText] = useState(flow.savedTemplate || '')
  const [saveTpl, setSaveTpl] = useState(false)
  const [busy, setBusy] = useState(false)

  const insertCra = () => {
    const c = flow.cra
    if (!c) return
    const block = `Consumer reporting agency that provided the report:\n  ${c.name}\n  ${c.address}\n  ${c.phone}${c.website ? `\n  ${c.website}` : ''}\n`
    setText(t => (t.trim() ? `${t.trimEnd()}\n\n${block}` : block))
  }

  const send = async () => {
    if (!text.trim()) { toast.error('Write the notice first, or choose to handle it yourself.'); return }
    setBusy(true)
    try {
      await apiPost(`/background/${flow.checkId}/adverse-action`, { text, saveAsTemplate: saveTpl })
      toast('Adverse-action notice sent to the applicant.')
      onSent()
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not send the notice.')
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{maxWidth:600}} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Send adverse-action notice</div>
        <div style={{padding:16}}>
          <div style={{fontSize:'.82rem',color:'var(--text-2)',lineHeight:1.5,marginBottom:12}}>
            You denied this applicant. If a screening report factored into the decision, federal law (FCRA) requires sending them an adverse-action notice. Write it below — this is your notice; GAM only delivers it and keeps a copy. Consult your own counsel on what it must contain.
          </div>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={10}
            placeholder="Write the adverse-action notice to the applicant…"
            style={{width:'100%',padding:'10px 12px',border:'1px solid var(--border)',borderRadius:8,background:'var(--bg-3)',color:'var(--text-0)',fontSize:'.85rem',fontFamily:'inherit',resize:'vertical',boxSizing:'border-box'}}
          />
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:10,gap:12,flexWrap:'wrap'}}>
            <button className="btn btn-ghost btn-sm" onClick={insertCra} disabled={!flow.cra} title={flow.cra ? '' : 'No reporting-agency info on file'}>
              Insert credit-bureau contact
            </button>
            <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'.8rem',color:'var(--text-2)',cursor:'pointer'}}>
              <input type="checkbox" checked={saveTpl} onChange={e => setSaveTpl(e.target.checked)} />
              Save as my reusable template
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>I'll handle this myself</button>
          <button className="btn btn-primary" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send notice'}</button>
        </div>
      </div>
    </div>
  )
}
