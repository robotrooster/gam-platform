/**
 * Insurance — one place for every certificate, and the lapse list.
 *
 * 11/01. The API for this landed the same night (routes/insurance.ts,
 * services/insurancePolicies.ts) with nothing rendering it, so a policy the
 * lease parser lifted off a signed lease went into a drawer nobody could open.
 * This is the drawer handle.
 *
 * THE LAPSE LIST IS THE POINT, so it is the first thing on the page rather than
 * a tab behind it. A certificate that quietly expired is the whole exposure:
 * the operator did everything right months ago and has no idea the cover
 * stopped. Expired is listed before expiring-soon, because last week's lapse is
 * more urgent than next month's renewal.
 *
 * Three kinds of cover live here together — a property's building policy, a
 * resident's renters liability, and a vendor's or contractor's general
 * liability and bond — because the question "what is about to lapse?" is one
 * question, and across three screens it gets asked once and then forgotten.
 *
 * GAM states no required coverage amount anywhere and names no state's rules.
 * What an operator asks of a resident or a vendor is theirs to decide.
 */
import { useState, CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, openPdfInNewTab } from '../lib/api'
import {
  INSURANCE_COVERAGE_BY_SUBJECT, INSURANCE_COVERAGE_LABEL,
  INSURANCE_SUBJECT_LABEL, INSURANCE_LAPSE_DEFAULT_DAYS,
  type InsuranceCoverageType, type InsuranceSubject,
} from '@gam/shared'
import {
  ShieldCheck, ShieldAlert, ShieldX, Plus, X, FileText, Check, Ban, Clock,
} from 'lucide-react'
import { toast, appConfirm } from '../components/dialogs'
import { usePerms } from '../lib/permissions'

const lbl: CSSProperties = { fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 4, display: 'block' }
const money = (n: any) => n == null || n === ''
  ? '—'
  : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

interface Policy {
  id: string
  subject: InsuranceSubject
  subjectName: string | null
  propertyId: string | null
  leaseId: string | null
  vendorId: string | null
  contractorId: string | null
  coverageType: InsuranceCoverageType
  carrierName: string
  policyNumber: string | null
  coverageAmount: string | null
  effectiveDate: string | null
  expiryDate: string | null
  proofFileName: string | null
  verifiedAt: string | null
  voidedAt: string | null
  notes: string | null
  daysUntilExpiry?: number
}

interface LapseList {
  asOf: string
  days: number
  expired: Policy[]
  expiringSoon: Policy[]
}

export function InsurancePage() {
  const perms = usePerms()
  const [days, setDays] = useState(INSURANCE_LAPSE_DEFAULT_DAYS)
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState<'' | InsuranceSubject>('')

  const { data: lapses } = useQuery<LapseList>(
    ['insurance-lapses', days], () => apiGet(`/insurance/lapses?days=${days}`))
  const { data: policies = [], isLoading } = useQuery<Policy[]>(
    'insurance-policies', () => apiGet('/insurance'))

  const shown = filter ? policies.filter(p => p.subject === filter) : policies

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <ShieldCheck size={22} /> Insurance
        </h1>
        <div style={{ flex: 1 }} />
        {perms.can('insurance.manage') && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={16} /> Record a certificate
          </button>
        )}
      </div>

      <p style={{ color: 'var(--text-3)', maxWidth: '66ch', marginTop: 0 }}>
        Every certificate in one place — your building policies, your residents'
        renters liability, and your vendors' and contractors' liability and bonds.
        What you require of anyone is your call; GAM only keeps track of what you
        have and tells you what is running out.
      </p>

      <Lapses lapses={lapses} days={days} onDays={setDays} />

      <section style={{ marginTop: 26 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <h2 style={{ fontSize: '1rem', color: 'var(--text-2)', margin: 0 }}>
            Everything on file{' '}
            <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>({shown.length})</span>
          </h2>
          <div style={{ flex: 1 }} />
          <select value={filter} onChange={e => setFilter(e.target.value as any)}
                  style={{ maxWidth: 220 }}>
            <option value="">Everyone</option>
            <option value="property">Buildings</option>
            <option value="resident">Residents</option>
            <option value="vendor">Vendors</option>
            <option value="contractor">Contractors</option>
          </select>
        </div>

        {isLoading && <div className="card">Loading…</div>}
        {!isLoading && shown.length === 0 && (
          <div className="card" style={{ textAlign: 'center', padding: 30 }}>
            <ShieldAlert size={28} style={{ color: 'var(--text-3)' }} />
            <h3 style={{ marginBottom: 6 }}>
              {policies.length === 0 ? 'No certificates on file yet' : 'None of those'}
            </h3>
            <p style={{ color: 'var(--text-3)', margin: '0 auto', maxWidth: '46ch' }}>
              {policies.length === 0
                ? 'Record one as it comes in and you will be told before it runs out.'
                : 'Try a different group.'}
            </p>
          </div>
        )}

        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))' }}>
          {shown.map(p => <PolicyCard key={p.id} policy={p} />)}
        </div>
      </section>

      {adding && (
        <RecordCertificate onClose={() => setAdding(false)} />
      )}
    </div>
  )
}

// ── the lapse list ────────────────────────────────────────────

function Lapses({ lapses, days, onDays }: {
  lapses?: LapseList; days: number; onDays: (d: number) => void
}) {
  const expired = lapses?.expired ?? []
  const soon = lapses?.expiringSoon ?? []
  const clear = expired.length === 0 && soon.length === 0

  return (
    <section className="card" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '1rem', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Clock size={16} /> Running out
        </h2>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: '.8rem', color: 'var(--text-3)', display: 'flex', gap: 6, alignItems: 'center' }}>
          Looking ahead
          <select value={days} onChange={e => onDays(Number(e.target.value))}
                  style={{ padding: '2px 6px', fontSize: '.8rem' }}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
      </div>

      {clear && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12,
                      color: 'var(--green-dim, #30a46c)' }}>
          <ShieldCheck size={16} />
          <span>Nothing expired, and nothing running out in the next {days} days.</span>
        </div>
      )}

      {expired.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ fontSize: '.85rem', margin: '0 0 8px', color: 'var(--red-dim, #e5484d)',
                       display: 'flex', alignItems: 'center', gap: 6 }}>
            <ShieldX size={14} /> Already expired ({expired.length})
          </h3>
          <div style={{ display: 'grid', gap: 6 }}>
            {expired.map(p => <LapseRow key={p.id} policy={p} tone="expired" />)}
          </div>
        </div>
      )}

      {soon.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ fontSize: '.85rem', margin: '0 0 8px', color: 'var(--text-2)',
                       display: 'flex', alignItems: 'center', gap: 6 }}>
            <ShieldAlert size={14} /> Expiring soon ({soon.length})
          </h3>
          <div style={{ display: 'grid', gap: 6 }}>
            {soon.map(p => <LapseRow key={p.id} policy={p} tone="soon" />)}
          </div>
        </div>
      )}
    </section>
  )
}

function LapseRow({ policy, tone }: { policy: Policy; tone: 'expired' | 'soon' }) {
  const d = policy.daysUntilExpiry
  const when = tone === 'expired'
    ? (d != null ? `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago` : 'expired')
    : (d === 0 ? 'today' : d === 1 ? 'tomorrow' : d != null ? `in ${d} days` : 'soon')
  return (
    // A grid with declared tracks, so every row is the same shape on a desk and
    // stacks into one readable block on a phone instead of scrolling sideways.
    <div style={{
      display: 'grid', gap: '2px 10px',
      gridTemplateColumns: 'minmax(0, 1fr) auto',
      borderLeft: `3px solid ${tone === 'expired' ? 'var(--red-dim, #e5484d)' : 'var(--gold, #c9a227)'}`,
      paddingLeft: 10, fontSize: '.85rem',
    }}>
      <strong style={{ minWidth: 0 }}>{policy.subjectName || INSURANCE_SUBJECT_LABEL[policy.subject]}</strong>
      <span style={{ color: tone === 'expired' ? 'var(--red-dim, #e5484d)' : 'var(--text-2)', whiteSpace: 'nowrap' }}>
        {when}
      </span>
      <span style={{ color: 'var(--text-3)', gridColumn: '1 / -1' }}>
        {INSURANCE_COVERAGE_LABEL[policy.coverageType]} · {policy.carrierName}
        {policy.expiryDate ? ` · to ${policy.expiryDate}` : ''}
      </span>
    </div>
  )
}

// ── one certificate ───────────────────────────────────────────

function PolicyCard({ policy }: { policy: Policy }) {
  const qc = useQueryClient()
  const perms = usePerms()

  const refresh = () => {
    qc.invalidateQueries('insurance-policies')
    qc.invalidateQueries(['insurance-lapses'])
  }

  const verify = useMutation(
    () => apiPatch(`/insurance/${policy.id}`, { verified: true }),
    {
      onSuccess: () => { toast('Marked as confirmed. Your name is on it.'); refresh() },
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not confirm that.'),
    })

  const voidIt = useMutation(
    (reason: string) => apiPost(`/insurance/${policy.id}/void`, { reason }),
    {
      onSuccess: () => { toast('Taken off the list. The record is kept.'); refresh() },
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not do that.'),
    })

  const expired = !!policy.expiryDate && policy.expiryDate < new Date().toISOString().slice(0, 10)

  return (
    <div className="card" style={{ display: 'grid', gap: 7, opacity: policy.voidedAt ? 0.55 : 1 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <strong style={{ flex: 1, minWidth: 0 }}>
          {policy.subjectName || INSURANCE_SUBJECT_LABEL[policy.subject]}
        </strong>
        <span className="badge">{INSURANCE_SUBJECT_LABEL[policy.subject]}</span>
      </div>

      <div style={{ fontSize: '.85rem' }}>{INSURANCE_COVERAGE_LABEL[policy.coverageType]}</div>
      <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
        {policy.carrierName}
        {policy.policyNumber ? ` · ${policy.policyNumber}` : ''}
      </div>
      <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
        {policy.coverageAmount ? `${money(policy.coverageAmount)} cover · ` : ''}
        {policy.expiryDate
          ? <span style={{ color: expired ? 'var(--red-dim, #e5484d)' : undefined }}>
              {expired ? 'expired' : 'to'} {policy.expiryDate}
            </span>
          : 'no expiry recorded'}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: '.8rem' }}>
        {policy.voidedAt
          ? <span style={{ color: 'var(--text-3)' }}>Off the record</span>
          : policy.verifiedAt
            ? <span style={{ display: 'flex', gap: 4, alignItems: 'center', color: 'var(--green-dim, #30a46c)' }}>
                <Check size={13} /> Confirmed
              </span>
            : <span style={{ color: 'var(--text-3)' }}>Not confirmed yet</span>}
        {policy.proofFileName && (
          <button className="btn btn-ghost" style={{ fontSize: '.78rem', padding: '2px 8px' }}
                  onClick={() => openPdfInNewTab(`/insurance/${policy.id}/proof`)}>
            <FileText size={12} /> Certificate
          </button>
        )}
      </div>

      {!policy.voidedAt && perms.can('insurance.manage') && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!policy.verifiedAt && (
            <button className="btn btn-primary" style={{ fontSize: '.78rem', padding: '3px 9px' }}
                    disabled={verify.isLoading}
                    onClick={async () => {
                      const ok = await appConfirm(
                        'This says you have read the certificate and it is what it claims to be. Your name goes on the record, and a contractor marked insured can be awarded work on that basis.',
                        { title: 'Confirm this certificate?', confirmLabel: 'I have read it' })
                      if (ok) verify.mutate()
                    }}>
              <Check size={12} /> Confirm it
            </button>
          )}
          <button className="btn btn-ghost" style={{ fontSize: '.78rem', padding: '3px 9px' }}
                  disabled={voidIt.isLoading}
                  onClick={async () => {
                    const ok = await appConfirm(
                      'It comes off the list and stops counting as cover. The record itself is kept — GAM never erases anything.',
                      { title: 'Take this certificate off the record?', confirmLabel: 'Take it off', danger: true })
                    if (ok) voidIt.mutate('Taken off the record by the operator')
                  }}>
            <Ban size={12} /> Take it off
          </button>
        </div>
      )}
    </div>
  )
}

// ── recording one ─────────────────────────────────────────────

function RecordCertificate({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [subject, setSubject] = useState<InsuranceSubject>('property')
  const [propertyId, setPropertyId] = useState('')
  const [leaseId, setLeaseId] = useState('')
  const [vendorId, setVendorId] = useState('')
  const [coverageType, setCoverageType] = useState<InsuranceCoverageType>('building')
  const [carrierName, setCarrier] = useState('')
  const [policyNumber, setNumber] = useState('')
  const [coverageAmount, setAmount] = useState('')
  const [effectiveDate, setEffective] = useState('')
  const [expiryDate, setExpiry] = useState('')
  const [verified, setVerified] = useState(false)

  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const { data: leases = [] } = useQuery<any[]>('leases', () => apiGet('/leases'),
    { enabled: subject === 'resident' })
  const { data: vendors = [] } = useQuery<any[]>('books-vendors', () => apiGet('/books/vendors'),
    { enabled: subject === 'vendor' })

  const allowed = INSURANCE_COVERAGE_BY_SUBJECT[subject]

  const create = useMutation(
    () => apiPost('/insurance', {
      ...(subject === 'property' ? { propertyId } : {}),
      ...(subject === 'resident' ? { leaseId } : {}),
      ...(subject === 'vendor' ? { vendorId } : {}),
      coverageType, carrierName,
      policyNumber: policyNumber || null,
      coverageAmount: coverageAmount ? Number(coverageAmount) : null,
      effectiveDate: effectiveDate || null,
      expiryDate: expiryDate || null,
      verified,
    }),
    {
      onSuccess: () => {
        toast('Recorded.')
        qc.invalidateQueries('insurance-policies')
        qc.invalidateQueries(['insurance-lapses'])
        onClose()
      },
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not record that.'),
    })

  const whoChosen = subject === 'property' ? !!propertyId
    : subject === 'resident' ? !!leaseId
    : subject === 'vendor' ? !!vendorId
    : false
  const ready = whoChosen && carrierName.trim().length > 0 && allowed.includes(coverageType)

  function pickSubject(s: InsuranceSubject) {
    setSubject(s)
    // Keep the pairing honest: a building policy cannot hang off a resident.
    const first = INSURANCE_COVERAGE_BY_SUBJECT[s][0]
    setCoverageType(first)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2 style={{ margin: 0 }}>Record a certificate</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <label style={lbl}>Whose policy is it</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['property', 'resident', 'vendor'] as InsuranceSubject[]).map(s => (
                <button key={s} type="button"
                        className={subject === s ? 'btn btn-primary' : 'btn btn-ghost'}
                        style={{ fontSize: '.82rem', padding: '4px 10px' }}
                        onClick={() => pickSubject(s)}>
                  {INSURANCE_SUBJECT_LABEL[s]}
                </button>
              ))}
            </div>
            <p style={{ fontSize: '.73rem', color: 'var(--text-3)', margin: '6px 0 0' }}>
              A contractor's own liability and bond are recorded from their profile
              on the marketplace, not here.
            </p>
          </div>

          {subject === 'property' && (
            <div>
              <label style={lbl}>Which property</label>
              <select value={propertyId} onChange={e => setPropertyId(e.target.value)}>
                <option value="">Choose a property…</option>
                {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          {subject === 'resident' && (
            <div>
              <label style={lbl}>Which lease</label>
              <select value={leaseId} onChange={e => setLeaseId(e.target.value)}>
                <option value="">Choose a lease…</option>
                {leases.filter((l: any) => l.status === 'active').map((l: any) => (
                  <option key={l.id} value={l.id}>
                    {l.unitNumber ?? 'Unit'} — {l.propertyName ?? ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {subject === 'vendor' && (
            <div>
              <label style={lbl}>Which vendor</label>
              <select value={vendorId} onChange={e => setVendorId(e.target.value)}>
                <option value="">Choose a vendor…</option>
                {vendors.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
          )}

          <div>
            <label style={lbl}>Kind of cover</label>
            <select value={coverageType} onChange={e => setCoverageType(e.target.value as any)}>
              {allowed.map(c => (
                <option key={c} value={c}>{INSURANCE_COVERAGE_LABEL[c]}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '2fr 1fr' }}>
            <div>
              <label style={lbl}>Carrier that wrote it</label>
              <input value={carrierName} onChange={e => setCarrier(e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Policy number</label>
              <input value={policyNumber} onChange={e => setNumber(e.target.value)} />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr 1fr' }}>
            <div>
              <label style={lbl}>Cover amount</label>
              {/* Recorded as the certificate states it. GAM never compares it to
                  a minimum and never says what a policy ought to be worth. */}
              <input type="number" min="0" value={coverageAmount}
                     onChange={e => setAmount(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label style={lbl}>Starts</label>
              <input type="date" value={effectiveDate} onChange={e => setEffective(e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Expires</label>
              <input type="date" value={expiryDate} onChange={e => setExpiry(e.target.value)} />
            </div>
          </div>
          {!expiryDate && (
            <p style={{ fontSize: '.75rem', color: 'var(--text-3)', margin: 0 }}>
              Without an expiry date this certificate can never appear on the
              running-out list. Worth filling in if you have it.
            </p>
          )}

          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '.85rem' }}>
            <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)}
                   style={{ marginTop: 3 }} />
            <span>
              I have read this certificate and it is what it claims to be.
              <span style={{ color: 'var(--text-3)' }}> Your name goes on the record.</span>
            </span>
          </label>
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || create.isLoading}
                  onClick={() => create.mutate()}>
            {create.isLoading ? 'Recording…' : 'Record it'}
          </button>
        </div>
      </div>
    </div>
  )
}
