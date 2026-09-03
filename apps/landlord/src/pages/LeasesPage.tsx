import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { UserPlus, AlertTriangle, DollarSign, FileText, Eye, X, Pause, Play } from 'lucide-react'
import { LEASE_TYPE_LABEL, LeaseStatus, humanize } from '@gam/shared'
import { toast, appConfirm } from '../components/dialogs'
import { LeaseFormModal } from './LeaseFormModal'
import { LeaseOverviewModal } from './LeaseOverviewModal'
import { RenewalDecisionModal } from './RenewalDecisionModal'
import { usePerms } from '../lib/permissions'
import { PropertySelect } from '../components/ListControls'

const fmt = (n: any) => n != null
  ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '—'

// S527 W-29: the old flow fetched a blob then window.open'd it AFTER an
// await — popup blockers silently killed it, so "View" looked dead. Now
// routes to the in-app same-tab viewer (W-45 rule: no new-tab jumps).

const STATUS_MAP: Record<LeaseStatus, string> = {
  pending:    'badge-amber',
  active:     'badge-green',
  expired:    'badge-red',
  terminated: 'badge-muted',
}

/** 1 → "1st". Used by the autopay badge. */
function ordinalDay(n: number): string {
  const suffix = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]}`
}

export function LeasesPage() {
  const { data: leases = [], isLoading } = useQuery<any[]>('leases', () => apiGet('/leases'))
  const [modalOpen, setModalOpen] = useState(false)
  const [editingLeaseId, setEditingLeaseId] = useState<string | undefined>(undefined)
  // S511 #15: confirmed leases open read-only (terms locked once signed); only
  // needs-review imports open editable so the owner can confirm defaults.
  const [viewOnly, setViewOnly] = useState(false)
  const [carriedLease, setCarriedLease] = useState<any | null>(null)
  // S181 / A2: bill-fee modal state. Holds the lease object to bill against,
  // or null when the modal is closed.
  const [billFeeLease, setBillFeeLease] = useState<any | null>(null)
  // S607 (Nic): a genuine one-off charge — amount + description, nothing defined
  // in advance. "The landlord's always gonna have some random thing... a notice
  // for parking violation. All that little stuff is not gonna be added into the
  // lease." Separate state from Bill fee, which bills a fee the lease already
  // carries.
  const [chargeLease, setChargeLease] = useState<any | null>(null)
  // S581: money add-on / notice modal (recurring charge or rent change that
  // reaches billing on a landlord-set date).
  const [addonLease, setAddonLease] = useState<any | null>(null)
  // W-7 (S531): renewal decision form — deep-linked from the dashboard
  // to-do's expiring-lease items via ?renew=<leaseId>.
  const [renewalLeaseId, setRenewalLeaseId] = useState<string | null>(null)
  const [propertyId, setPropertyId] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const leasesQc = useQueryClient()
  // S576 Snowbird Phase 1: hibernate (off-season) / resume a seasonal lease.
  const hibernateMut = useMutation(
    ({ id, action }: { id: string; action: 'hibernate' | 'resume' }) => apiPost(`/leases/${id}/${action}`, {}),
    {
      onSuccess: (_d, v) => { leasesQc.invalidateQueries('leases'); toast(v.action === 'hibernate' ? 'Lease hibernated — billing paused for the off-season.' : 'Lease resumed — billing restarts next cycle.') },
      onError: (e: any) => toast.error(e?.response?.data?.error || e?.message || 'Could not update the lease'),
    }
  )
  const { can } = usePerms()

  // Deep-link: ?open=<leaseId> opens the edit modal directly
  useEffect(() => {
    const openId = searchParams.get('open')
    if (openId && !modalOpen) {
      setEditingLeaseId(openId)
      setModalOpen(true)
    }
    const renewId = searchParams.get('renew')
    if (renewId && !renewalLeaseId) {
      setRenewalLeaseId(renewId)
    }
  }, [searchParams])

  const closeRenewal = () => {
    setRenewalLeaseId(null)
    if (searchParams.get('renew')) {
      searchParams.delete('renew')
      setSearchParams(searchParams, { replace: true })
    }
  }

  // S547 (Nic): screening for a long-stay draft is the landlord's explicit
  // choice — with a consistency reminder so the choice is applied evenly.
  const requestScreening = async (leaseId: string) => {
    const ok = await appConfirm(
      'Email this guest a background-screening request?\n\n' +
      'Consistency note: apply screening evenly. Requiring background checks from some guests ' +
      'but not others in the same situation can be considered discriminatory. If you screen, ' +
      'screen everyone in comparable situations; if you don’t, apply that policy to everyone too.',
      { title: 'Request screening', confirmLabel: 'Send request' },
    )
    if (!ok) return
    try {
      const r = await apiPost(`/leases/${leaseId}/request-background-check`)
      toast(`Screening request sent to ${(r as any)?.data?.sentTo || 'the guest'}`)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not send the screening request')
    }
  }

  // Row click (S534, Nic): the lease IS the document — clicking a lease
  // opens its PDF (executed e-sign doc, else imported original, else the
  // generated terms rendering). The one exception: a needs-review import
  // opens the editable confirm form for staff who can edit — that row is
  // flagged for action, not reading. Lease details moved to the Details
  // row button.
  const openLease = (l: any) => {
    if (l.needsReview && can('leases.edit')) {
      setViewOnly(false)
      setEditingLeaseId(l.id)
      setModalOpen(true)
      return
    }
    if (can('leases.view_pdf')) {
      navigate(`/view?src=${encodeURIComponent(`/leases/${l.id}/pdf`)}&title=${encodeURIComponent(`Lease — ${l.unitNumber || ''}`)}`)
      return
    }
    openDetails(l)
  }
  const openDetails = (l: any) => {
    setViewOnly(!l.needsReview || !can('leases.edit'))
    setEditingLeaseId(l.id)
    setModalOpen(true)
  }
  const closeModal = () => {
    setModalOpen(false)
    setEditingLeaseId(undefined)
    setViewOnly(false)
    if (searchParams.get('open')) {
      searchParams.delete('open')
      setSearchParams(searchParams, { replace: true })
    }
  }

  // S534 (Nic): this view is CURRENT info only — one glance at what's in
  // force (active + pending). Expired/terminated history stays reachable
  // behind the toggle, not mixed into the default list.
  const [showHistory, setShowHistory] = useState(false)
  const currentLeases = (leases as any[]).filter(l => l.status === 'active' || l.status === 'pending')
  // S536: count over CURRENT leases (matches the dashboard alert and the
  // default table) — a needs_review flag on an expired lease shouldn't
  // inflate a banner above rows that aren't shown.
  const needsReviewCount = currentLeases.filter(l => l.needsReview).length
  const historyCount = (leases as any[]).length - currentLeases.length
  const baseLeases = showHistory ? (leases as any[]) : currentLeases

  // S527 W-5: ?expiring=<days> (dashboard KPI deep-link) narrows the table to
  // active leases ending within the window.
  // S536 (Nic): ?review=1 (the needs-review banner) narrows to exactly the
  // rows the banner is counting — a count that disagrees with the filtered
  // list reads as a bug. review wins over expiring.
  const expiringDays = parseInt(searchParams.get('expiring') || '') || null
  const reviewOnly = searchParams.get('review') === '1'
  const visibleLeases = reviewOnly
    ? baseLeases.filter(l => l.needsReview)
    : expiringDays
      ? baseLeases.filter(l => {
          if (l.status !== 'active' || !l.endDate) return false
          const end = new Date(String(l.endDate).slice(0, 10) + 'T12:00:00')
          const days = Math.ceil((end.getTime() - Date.now()) / 86400000)
          return days >= 0 && days <= expiringDays
        })
      : baseLeases

  // S637 (Nic, DIRECTIVE): "I don't want the search bar. I want the filter.
  // Choose a property from a drop down list." The free-text search went with
  // it — one control, and it answers the question the landlord actually asks
  // of this page ("show me this park"). Options derive from the full lease set
  // so the History toggle never changes what the dropdown offers.
  const propertyOptions = (leases as any[]).map(l => ({ id: l.propertyId, name: l.propertyName }))
  const displayLeases = visibleLeases.filter((l: any) =>
    propertyId === '' || l.propertyId === propertyId)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Leases</h1>
          <p className="page-subtitle">Active and historical lease agreements</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {historyCount > 0 && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowHistory(v => !v)}>
              {showHistory ? 'Current leases only' : `History (${historyCount})`}
            </button>
          )}
          <Link to="/tenant-onboarding" className="btn btn-primary" style={{ textDecoration: 'none' }}>
            <UserPlus size={14} /> Start Tenant Onboarding
          </Link>
        </div>
      </div>

      {needsReviewCount > 0 && (
        <div
          onClick={() => {
            if (reviewOnly) { searchParams.delete('review') } else { searchParams.set('review', '1'); searchParams.delete('expiring') }
            setSearchParams(searchParams)
          }}
          style={{
          background: 'rgba(245,158,11,.08)',
          border: '1px solid var(--amber)',
          borderRadius: 10,
          padding: '10px 14px',
          marginBottom: 14,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          fontSize: '.82rem',
          color: 'var(--text-1)',
          cursor: 'pointer',
        }}>
          <AlertTriangle size={16} style={{ color: 'var(--amber)', flexShrink: 0 }} />
          <div>
            <strong style={{ color: 'var(--amber)' }}>{needsReviewCount} lease{needsReviewCount === 1 ? '' : 's'} need review.</strong>
            {' '}These were imported with default values. Click a row to review and confirm.
          </div>
          <span style={{ marginLeft: 'auto', fontSize: '.78rem', fontWeight: 600, color: 'var(--amber)', flexShrink: 0 }}>
            {reviewOnly ? 'Show all leases' : 'View →'}
          </span>
        </div>
      )}

      {expiringDays && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '8px 14px', background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.25)', borderRadius: 10, fontSize: '.82rem' }}>
          <span>Showing active leases expiring within <strong>{expiringDays} days</strong> ({visibleLeases.length}).</span>
          <button className="btn btn-ghost btn-sm" onClick={() => { searchParams.delete('expiring'); setSearchParams(searchParams) }}>Show all leases</button>
        </div>
      )}

      <div className="filter-bar">
        <PropertySelect value={propertyId} onChange={setPropertyId} properties={propertyOptions} />
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : (
          <table className="data-table" style={{ minWidth: 920 }}>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Tenant</th>
                <th>Type</th>
                <th>Start</th>
                <th>End</th>
                <th>Rent</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {displayLeases.length ? displayLeases.map((l: any) => {
                // S527 fix: the API returns a tenants[] array (multi-tenant
                // lease model); the old flat tenantFirst/tenantLast fields
                // were never sent, so this column rendered "—" for every
                // lease. Primary tenant first, "+N" for co-tenants.
                const activeTenants = (l.tenants || []).filter((t: any) => t.status === 'active')
                const primary = activeTenants.find((t: any) => t.role === 'primary') || activeTenants[0]
                const tenantName = primary
                  ? [primary.firstName, primary.lastName].filter(Boolean).join(' ')
                    + (activeTenants.length > 1 ? ` +${activeTenants.length - 1}` : '')
                  : '—'
                return (
                  <tr
                    key={l.id}
                    onClick={() => openLease(l)}
                    style={{ cursor: 'pointer' }}
                    className="row-clickable"
                  >
                    <td className="mono">{l.unitNumber || '—'}</td>
                    <td>
                      {tenantName}
                      {/* S609 (Nic): autopay VISIBILITY only. Knowing a payment
                          is scheduled stops a landlord reading a quiet lease as
                          a tenant who has stopped paying. The day is the
                          tenant's own choice and is not editable here — a
                          landlord able to move it could manufacture late fees. */}
                      {l.autopayEnabled && (
                        <span
                          title={`This tenant has scheduled automatic payment${l.autopayPullDay ? ` on the ${ordinalDay(l.autopayPullDay)} of each month` : ' on the day rent is due'}. They set this themselves — it can't be changed from here.`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            marginLeft: 8,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'rgba(34,197,94,.12)',
                            color: 'var(--green)',
                            fontSize: '.65rem',
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '.04em',
                          }}
                        >
                          Autopay {l.autopayPullDay ? ordinalDay(l.autopayPullDay) : 'on due date'}
                        </span>
                      )}
                      {l.needsReview && (
                        <span
                          title="Needs review"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            marginLeft: 8,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'rgba(245,158,11,.12)',
                            color: 'var(--amber)',
                            fontSize: '.65rem',
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '.04em',
                          }}
                        >
                          <AlertTriangle size={9} />
                          Review
                        </span>
                      )}
                      {/* S526: auto-drafted from a 30+/7+ day reservation. */}
                      {l.leaseSource === 'booking_draft' && (
                        <span
                          title="Drafted automatically from a long-stay reservation — attach the tenant and complete the terms"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            marginLeft: 6,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'rgba(201,162,39,.12)',
                            color: 'var(--gold)',
                            fontSize: '.65rem',
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '.04em',
                          }}
                        >
                          From reservation
                        </span>
                      )}
                      {/* S547: the screening decision is the landlord's — never automatic. */}
                      {l.leaseSource === 'booking_draft' && l.status === 'pending' && can('tenants.run_background_check') && (
                        <button
                          className="btn btn-ghost"
                          style={{ marginLeft: 6, padding: '1px 8px', fontSize: '.65rem' }}
                          onClick={e => { e.stopPropagation(); requestScreening(l.id) }}
                        >
                          Request screening
                        </button>
                      )}
                    </td>
                    <td style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
                      {LEASE_TYPE_LABEL[l.leaseType as keyof typeof LEASE_TYPE_LABEL] || l.leaseType || '—'}
                    </td>
                    <td className="mono">{l.startDate ? new Date(l.startDate).toLocaleDateString() : '—'}</td>
                    <td className="mono">
                      {l.endDate
                        ? new Date(l.endDate).toLocaleDateString()
                        : <span style={{ color: 'var(--text-3)' }}>MTM</span>}
                    </td>
                    <td className="mono" style={{ color: 'var(--text-0)' }}>{fmt(l.rentAmount)}</td>
                    <td>
                      <span className={'badge ' + (STATUS_MAP[l.status as LeaseStatus] || 'badge-muted')}>
                        {humanize(l.status) || '—'}
                      </span>
                      {l.isHibernating && (
                        <span className="badge badge-amber" title="Seasonally paused — no rent billed, deposit held, spot bookable off-season" style={{ marginLeft: 4 }}>Hibernating</span>
                      )}
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          title="Lease details (terms, fees, addendum history)"
                          onClick={() => openDetails(l)}
                          style={{ padding: '3px 8px' }}
                        >
                          <Eye size={12} /> Details
                        </button>
                        {can('leases.bill_fee') && l.status === 'active' && (
                          <button
                            className="btn btn-ghost btn-sm"
                            title="Bill the tenant a one-off fee on this lease"
                            onClick={() => setBillFeeLease(l)}
                            style={{ padding: '3px 8px' }}
                          >
                            <FileText size={12} /> Bill fee
                          </button>
                        )}
                        {can('leases.bill_fee') && l.status === 'active' && (
                          <button
                            className="btn btn-ghost btn-sm"
                            title="Charge this tenant a one-off amount — parking violation, damage, anything not in the lease"
                            onClick={() => setChargeLease(l)}
                            style={{ padding: '3px 8px' }}
                          >
                            <FileText size={12} /> Charge
                          </button>
                        )}
                        {/* S605 (Nic): arrears from the landlord's previous
                            system. Sits beside Bill fee because it is the same
                            act — a landlord adding a charge — but it is entered
                            ONCE per lease at migration, not recurring. */}
                        {can('leases.bill_fee') && l.status === 'active' && (
                          <button
                            className="btn btn-ghost btn-sm"
                            title="Record a balance this tenant already owed before moving onto GAM"
                            onClick={() => setCarriedLease(l)}
                            style={{ padding: '3px 8px' }}
                          >
                            <FileText size={12} /> Carried balance
                          </button>
                        )}
                        {can('leases.create') && l.status === 'active' && (
                          <button
                            className="btn btn-ghost btn-sm"
                            title="Add a recurring charge (parking, storage) or change the rent — as an agreement the tenant signs, or a notice you issue. Takes effect on the date you set."
                            onClick={() => setAddonLease(l)}
                            style={{ padding: '3px 8px' }}
                          >
                            <DollarSign size={12} /> Add-on / rent change
                          </button>
                        )}
                        {can('leases.deposit_return') && (l.status === 'active' || l.status === 'expired' || l.status === 'terminated') && (
                          <button
                            className="btn btn-ghost btn-sm"
                            title="Process move-out / deposit return"
                            onClick={() => navigate(`/leases/${l.id}/deposit-return`)}
                            style={{ padding: '3px 8px' }}
                          >
                            <DollarSign size={12} /> Move-out
                          </button>
                        )}
                        {can('leases.edit') && l.status === 'active' && (
                          <button
                            className="btn btn-ghost btn-sm"
                            title={l.isHibernating
                              ? 'Resume this seasonal lease — restart billing'
                              : 'Hibernate for the off-season — pause billing, hold the spot, deposit stays. Snowbirds.'}
                            disabled={hibernateMut.isLoading}
                            onClick={() => hibernateMut.mutate({ id: l.id, action: l.isHibernating ? 'resume' : 'hibernate' })}
                            style={{ padding: '3px 8px' }}
                          >
                            {l.isHibernating ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Hibernate</>}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              }) : (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>
                    No leases found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* W-28: view-only opens the clean read-only OVERVIEW (information, not
          disabled inputs). The editable needs-review confirm path keeps the
          full form. */}
      {renewalLeaseId && <RenewalDecisionModal leaseId={renewalLeaseId} onClose={closeRenewal} />}
      {modalOpen && (viewOnly && editingLeaseId ? (
        <LeaseOverviewModal leaseId={editingLeaseId} onClose={closeModal} />
      ) : (
        <LeaseFormModal
          onClose={closeModal}
          leaseId={editingLeaseId}
          readOnly={viewOnly}
        />
      ))}

      {billFeeLease && (
        <BillFeeModal
          lease={billFeeLease}
          onClose={() => setBillFeeLease(null)}
        />
      )}
      {chargeLease && (
        <OneOffChargeModal
          lease={chargeLease}
          onClose={() => setChargeLease(null)}
        />
      )}
      {carriedLease && (
        <CarriedBalanceModal
          lease={carriedLease}
          onClose={() => setCarriedLease(null)}
        />
      )}

      {addonLease && (
        <MoneyAddonModal
          lease={addonLease}
          onClose={() => setAddonLease(null)}
        />
      )}
    </div>
  )
}

// S581 (Nic): create a MONEY add-on on a lease — a recurring charge (parking,
// storage) or a rent change — that reaches billing on a landlord-set date.
// Two modes: 'agreement' (tenant signs to accept — parking) and 'notice' (landlord
// issues, tenant can't refuse — e.g. a mobile-home space-rent increase; no tenant
// signature, they get a blocking portal acknowledgment). The backend resolves
// signers from the lease, so this form only sends leaseId + mode + the change.
const RECURRING_FEE_OPTIONS: Array<{ v: string; label: string }> = [
  { v: 'parking_rent', label: 'Parking' },
  { v: 'storage_rent', label: 'Storage' },
  { v: 'pet_rent', label: 'Pet rent' },
  { v: 'amenity_fee_monthly', label: 'Amenity' },
  { v: 'trash_fee', label: 'Trash' },
  { v: 'pest_control_fee', label: 'Pest control' },
  { v: 'technology_fee', label: 'Technology' },
  { v: 'other_fee', label: 'Other monthly charge' },
]
function MoneyAddonModal({ lease, onClose }: { lease: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<'agreement' | 'notice'>('agreement')
  const [changeType, setChangeType] = useState<'rent' | 'recurring_fee'>('recurring_fee')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [newRent, setNewRent] = useState('')
  const [feeType, setFeeType] = useState('parking_rent')
  const [feeAmount, setFeeAmount] = useState('')
  const [feeDescription, setFeeDescription] = useState('')
  const [error, setError] = useState('')

  const valid = effectiveDate && (changeType === 'rent'
    ? Number(newRent) > 0
    : Number(feeAmount) > 0)

  const mut = useMutation(
    async () => {
      const change = changeType === 'rent'
        ? { changeType: 'rent', effectiveDate, newRentAmount: Number(newRent) }
        : { changeType: 'recurring_fee', effectiveDate, feeType, feeAmount: Number(feeAmount),
            ...(feeDescription ? { feeDescription } : {}) }
      const title = changeType === 'rent'
        ? (mode === 'notice' ? 'Rent Change Notice' : 'Rent Change Agreement')
        : `${RECURRING_FEE_OPTIONS.find(o => o.v === feeType)?.label ?? 'Charge'} — ${mode === 'notice' ? 'Notice' : 'Agreement'}`
      const res = await apiPost('/esign/documents/addendum-terms', {
        leaseId: lease.id, title, mode, scheduledChanges: [change],
      })
      // Send it out immediately (landlord signs first; for agreement the tenant
      // then signs — for a notice landlord-only completes it).
      await apiPost(`/esign/documents/${res.data.id}/send`, {})
      return res
    },
    {
      onSuccess: () => {
        qc.invalidateQueries('esign-documents')
        onClose()
      },
      onError: (e: any) => setError(e?.response?.data?.error?.message || e?.response?.data?.error || 'Could not create it. Try again.'),
    },
  )

  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 540 }}>
        <div className="modal-t"><DollarSign size={16} /> Add-on or rent change</div>
        <p style={{ fontSize: '.8rem', color: 'var(--text-2)', marginBottom: 14 }}>
          Add a recurring charge or change the rent on this lease. It takes effect on the date you set.
        </p>

        {/* Mode */}
        <label className="lbl" style={{ display: 'block', marginBottom: 6 }}>How does it take effect?</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button type="button" className={`btn btn-sm ${mode === 'agreement' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1 }} onClick={() => setMode('agreement')}>Agreement (tenant signs)</button>
          <button type="button" className={`btn btn-sm ${mode === 'notice' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1 }} onClick={() => setMode('notice')}>Notice (you issue)</button>
        </div>
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 16 }}>
          {mode === 'agreement'
            ? 'The tenant must sign to accept (e.g. opting into a parking spot). Check your local laws.'
            : 'You issue it; the tenant is notified and must acknowledge it, but does not sign (e.g. a rent increase you have the right to make with notice). Check your local laws.'}
        </div>

        {/* Change type */}
        <label className="lbl" style={{ display: 'block', marginBottom: 6 }}>What is changing?</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button type="button" className={`btn btn-sm ${changeType === 'recurring_fee' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1 }} onClick={() => setChangeType('recurring_fee')}>Add a recurring charge</button>
          <button type="button" className={`btn btn-sm ${changeType === 'rent' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1 }} onClick={() => setChangeType('rent')}>Change the rent</button>
        </div>

        {changeType === 'rent' ? (
          <div style={{ marginBottom: 14 }}>
            <label className="lbl">New monthly rent ($)</label>
            <input className="inp" type="number" min="0" step="0.01" value={newRent}
              onChange={e => setNewRent(e.target.value)} placeholder="e.g. 1300.00" />
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label className="lbl">Charge type</label>
                <select className="inp" value={feeType} onChange={e => setFeeType(e.target.value)}>
                  {RECURRING_FEE_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="lbl">Amount ($/mo)</label>
                <input className="inp" type="number" min="0" step="0.01" value={feeAmount}
                  onChange={e => setFeeAmount(e.target.value)} placeholder="e.g. 50.00" />
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label className="lbl">Description (optional)</label>
              <input className="inp" value={feeDescription} maxLength={200}
                onChange={e => setFeeDescription(e.target.value)} placeholder="e.g. Reserved spot #12" />
            </div>
          </>
        )}

        <div style={{ marginBottom: 16 }}>
          <label className="lbl">Effective date</label>
          <input className="inp" type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} />
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>
            Billing switches on this date. For a notice with a required notice period, pick a date past it.
          </div>
        </div>

        {error && <div className="alert a-warn" style={{ marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={!valid || mut.isLoading}
            onClick={() => { setError(''); mut.mutate() }}>
            {mut.isLoading ? 'Sending…' : mode === 'notice' ? 'Issue notice' : 'Send for signature'}
          </button>
        </div>
      </div>
    </div>
  )
}

// S181 / A2: landlord-triggered one-off fee billing.
// S607 (Nic): a one-off charge with the landlord's own wording.
//
// Distinct from Bill fee, which bills a fee the LEASE already defines. This is
// for the real world — a parking violation, a replaced gate remote, a rule
// change nobody is going to sign an addendum for. The description is required
// and is what the TENANT sees on their bill, so a charge never lands unexplained.
//
// It is not a late fee: it stays out of late-fee reporting and does not count
// against the lease's late-fee cap, so a landlord who keeps late fees switched
// off can still charge the occasional tenant.
function OneOffChargeModal({ lease, onClose }: { lease: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const post = useMutation(
    () => apiPost(`/leases/${lease.id}/charge`, {
      amount: Number(amount),
      description: description.trim(),
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('leases')
        qc.invalidateQueries('payments')
        onClose()
      },
      onError: (e: any) =>
        setError(e?.response?.data?.error || 'Could not post this charge'),
    },
  )

  const amt = Number(amount)
  const ready = amt > 0 && description.trim().length >= 3

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Charge this tenant</div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 14 }}>
          A one-off amount added to their balance — {lease.tenantName || 'the tenant'} sees the
          description you write here on their bill. Not a late fee: it stays out of late-fee
          totals and does not count toward the lease's late-fee cap.
        </div>

        <label style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-1)' }}>Amount</label>
        <input
          className="form-input"
          inputMode="decimal"
          placeholder="45.00"
          value={amount}
          onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
          style={{ width: '100%', marginBottom: 12 }}
        />

        <label style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-1)' }}>
          What is this for?
        </label>
        <input
          className="form-input"
          placeholder="Parking violation — blocked the gate arm"
          maxLength={200}
          value={description}
          onChange={e => setDescription(e.target.value)}
          style={{ width: '100%' }}
        />
        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4, lineHeight: 1.45 }}>
          Write it the way you would explain it at the door — this is the only thing the tenant
          gets to go on.
        </div>

        {error && <div style={{ marginTop: 10, fontSize: '.8rem', color: 'var(--red)' }}>{error}</div>}

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!ready || post.isLoading}
            onClick={() => { setError(null); post.mutate() }}
          >
            {post.isLoading ? 'Posting…' : `Charge $${(amt || 0).toFixed(2)}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// Posts to /api/leases/:id/bill-fee (S180). Per the S177 walkthrough
// "platform provides capability not execution" — this is just a
// surface for the existing backend endpoint. The created payments row
// flows through the standard /payments tenant Pay Now UI.
function BillFeeModal({ lease, onClose }: { lease: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [leaseFeeId, setLeaseFeeId] = useState('')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // W-30 (lease-is-law): only fees in THIS lease's signed terms can be
  // billed, at the lease's own amount. The billable set = due_timing='other'
  // rows (everything else bills automatically).
  const { data: leaseDetail } = useQuery(['lease-fees', lease.id], () => apiGet<any>(`/leases/${lease.id}`))
  const billableFees: any[] = (leaseDetail?.fees || []).filter((f: any) => f.dueTiming === 'other')
  const selectedFee = billableFees.find(f => f.id === leaseFeeId)

  const mut = useMutation(
    (body: { leaseFeeId: string; description?: string; dueDate?: string }) =>
      apiPost(`/leases/${lease.id}/bill-fee`, body),
    {
      onSuccess: () => {
        setError(null)
        setSuccess('Fee billed. Tenant will see it on their Payments page.')
        qc.invalidateQueries('leases')
        setTimeout(onClose, 1200)
      },
      onError: (e: any) => {
        setSuccess(null)
        setError(e?.response?.data?.error?.message || e?.response?.data?.error || 'Could not bill fee')
      },
    },
  )

  const submit = () => {
    setError(null)
    if (!leaseFeeId) { setError('Pick a fee from the lease terms'); return }
    mut.mutate({
      leaseFeeId,
      description: description.trim() || undefined,
      dueDate:     dueDate || undefined,
    })
  }

  return (
    <div
      onClick={onClose}
      style={{
        position:       'fixed',
        inset:          0,
        background:     'rgba(0,0,0,.6)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        zIndex:         100,
        padding:        16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="card"
        style={{ width: '100%', maxWidth: 460, padding: 22 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Bill a Fee</h3>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 14 }}>
          Lease for {(() => { const p = (lease.tenants || []).find((t: any) => t.role === 'primary' && t.status === 'active') || (lease.tenants || [])[0]; return p ? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() : 'tenant' })()} — Unit {lease.unitNumber ?? '—'}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
            Fee (From Lease Terms)
          </label>
          {billableFees.length === 0 ? (
            <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--border-0)', fontSize: '.8rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
              This lease's terms don't include any landlord-billable fees.
              Nothing can be billed that isn't in the signed lease.
            </div>
          ) : (
            <select
              value={leaseFeeId}
              onChange={e => setLeaseFeeId(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', color: 'var(--text-0)' }}
            >
              <option value="">— pick a fee —</option>
              {billableFees.map((f: any) => (
                <option key={f.id} value={f.id}>
                  {humanize(f.feeType)} — ${Number(f.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </option>
              ))}
            </select>
          )}
          {selectedFee && (
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>
              Amount is fixed by the lease — ${Number(selectedFee.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}.
            </div>
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
            Description (optional)
          </label>
          <input
            type="text"
            maxLength={500}
            placeholder="What is this fee for?"
            value={description}
            onChange={e => setDescription(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
            Due date (optional — defaults to today)
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' }}
          />
        </div>

        {error && (
          <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', color: 'var(--red)', fontSize: '.78rem' }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.25)', color: 'var(--green)', fontSize: '.78rem' }}>
            {success}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={mut.isLoading || !!success || !leaseFeeId}
            onClick={submit}
          >
            {mut.isLoading ? 'Billing…' : success ? '✓ Billed' : 'Bill fee'}
          </button>
        </div>
        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.5 }}>
          The tenant will see this on their Payments page as a pending charge. If unpaid at move-out it sweeps into the deposit deduction automatically.
        </div>
      </div>
    </div>
  )
}

// ── S605 (Nic): CARRIED BALANCE ─────────────────────────────────────────────
// "No way to carry a tenant's OUTSTANDING BALANCE onto the platform." A landlord
// migrating from another system had no way to record what a tenant already owed,
// so the debt lived off-platform and the books never reconciled.
//
// The late-fee choice is the part that matters and is why it is a visible
// decision rather than a hidden default: the nightly engine walks unpaid
// invoices, so without the exemption a carried balance starts compounding the
// day it is entered. Nic: a tenant on a catch-up plan shouldn't be fined for
// arrears from the old system.
function CarriedBalanceModal({ lease, onClose }: { lease: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [accruesLateFees, setAccruesLateFees] = useState(false)
  const [error, setError] = useState('')

  const save = useMutation(
    () => apiPost(`/leases/${lease.id}/carried-balance`, {
      amount: Number(amount),
      description: description.trim() || undefined,
      accruesLateFees,
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('leases'); qc.invalidateQueries('payments')
        toast('Carried balance recorded.')
        onClose()
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not record the balance'),
    },
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Carried balance</div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.55 }}>
          What this tenant already owed before moving onto GAM. It becomes a charge
          they can pay in their portal, and it shows on their statement as "BALANCE"
          so it doesn't read as a duplicate rent charge.
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Amount owed *</label>
          <input className="input" type="number" step="0.01" min="0" value={amount} autoFocus
            onChange={e => setAmount(e.target.value)} placeholder="2000.00" style={{ width: '100%' }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>What it's for</label>
          <input className="input" value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Balance from previous management" style={{ width: '100%' }} />
        </div>

        <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', padding: 10, borderRadius: 8, background: 'var(--bg-2)', marginBottom: 14 }}>
          <input type="checkbox" checked={accruesLateFees} onChange={e => setAccruesLateFees(e.target.checked)} style={{ marginTop: 2 }} />
          <span style={{ fontSize: '.8rem', lineHeight: 1.5 }}>
            <strong>Charge late fees on this balance</strong>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
              Off by default — a tenant catching up on an old balance isn't fined for it.
              Turn this on only if the debt was already accruing fees before the move.
            </div>
          </span>
        </label>

        {error && (
          <div style={{ color: 'var(--red)', fontSize: '.78rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!Number(amount) || save.isLoading}
            onClick={() => { setError(''); save.mutate() }}>
            {save.isLoading ? 'Saving…' : 'Record balance'}
          </button>
        </div>
      </div>
    </div>
  )
}
