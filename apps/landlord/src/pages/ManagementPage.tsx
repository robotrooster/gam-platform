/**
 * 10/22–23 (Nic) — THE MANAGEMENT COMPANY, IN THE SAME PORTAL.
 *
 * The third-party PM portal folded into this one:
 *
 *   "Blue's going to be property managing for some other people. And he doesn't
 *    necessarily want to toggle between portals with a different login. He
 *    wants to just adjust a view in the same screen... The goal is flexibility
 *    to allow them to run the business where they want to run it. All these
 *    other softwares I've used in the past, I have to come up with some ghetto
 *    workaround to get it to do what I want."
 *
 * Everything a management company needs that an owner's own portal did not
 * already have: the owners it works for and what each is owed, the rate sheets
 * it offers them, its own staff, and its own bank account. Four things, one
 * page, because they are four tabs of one subject and not four places to go.
 *
 * The properties, leases, residents, maintenance and schedule are NOT here —
 * those are the portal's own pages, which read every company this account can
 * act for and are better than anything the old portal had. The company picker
 * groups owned and managed (financials/EntityPicker).
 *
 * It talks to the SAME endpoints the old portal did (/pm/companies/...), which
 * already gate on PM staff role, so nothing about who may see what changed in
 * the move.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Building2, Users, Receipt, Landmark, HeartHandshake } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

interface PmCompany { id: string; name: string; status?: string }
interface OwnerRow {
  landlordId: string; businessName: string | null; ownerEmail: string | null
  portalAccess: 'none' | 'active' | 'closed'; propertyCount: number; unitCount: number
  notes?: string | null
}
interface FeePlan {
  id: string; name: string; basis?: string; percent?: number | null
  flatAmount?: number | null; status?: string; isActive?: boolean
}
interface StaffRow {
  id: string; userId: string; name?: string | null; email?: string | null
  role: string; status: string
}
interface ConnectStatus {
  payoutsEnabled?: boolean; detailsSubmitted?: boolean; chargesEnabled?: boolean
  accountId?: string | null
}

const money = (n: number | null | undefined) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const TABS = [
  { key: 'owners',    label: 'Owners',      icon: Building2 },
  { key: 'invites',   label: 'Engagements', icon: HeartHandshake },
  { key: 'feePlans',  label: 'Rate sheets', icon: Receipt },
  { key: 'staff',     label: 'Staff',       icon: Users },
  { key: 'banking',   label: 'Banking',     icon: Landmark },
] as const
type TabKey = typeof TABS[number]['key']

export default function ManagementPage() {
  const [tab, setTab] = useState<TabKey>('owners')
  const { data: companies = [], isLoading } = useQuery<PmCompany[]>(
    'my-pm-companies', () => apiGet<PmCompany[]>('/pm/companies'))
  const [picked, setPicked] = useState<string>('')
  const company = companies.find(c => c.id === picked) ?? (companies.length === 1 ? companies[0] : undefined)

  if (isLoading) return <div className="muted">Loading…</div>

  /* Nobody manages for anybody else, so the page says what it is for rather
     than showing five empty tabs. */
  if (!companies.length) {
    return (
      <div>
        <div className="page-header"><h1>Management</h1></div>
        <div className="card" style={{ maxWidth: 620 }}>
          <p style={{ marginTop: 0 }}>
            This is where a management company's own side of the business lives — the owners it
            works for, the rate sheets it offers them, its staff and its bank account.
          </p>
          <p style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>
            Your own properties are on the pages you already use. This appears once you manage
            property for somebody else.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Management</h1>
        {companies.length > 1 && (
          <select className="input" style={{ width: 'auto' }} value={company?.id ?? ''}
                  onChange={e => setPicked(e.target.value)}>
            <option value="">Choose a company…</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {companies.length === 1 && <span style={{ color: 'var(--text-3)' }}>{companies[0].name}</span>}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.key} className={`btn btn-sm ${tab === t.key ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setTab(t.key)}>
            <t.icon size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />{t.label}
          </button>
        ))}
      </div>

      {!company ? (
        <div className="muted">Choose a company to see its owners, rate sheets, staff and banking.</div>
      ) : tab === 'owners'   ? <Owners companyId={company.id} />
        : tab === 'invites'  ? <Engagements companyId={company.id} />
        : tab === 'feePlans' ? <FeePlans companyId={company.id} />
        : tab === 'staff'    ? <Staff companyId={company.id} />
        : <Banking companyId={company.id} />}
    </div>
  )
}

/** The people this company works for, and what each of their months came to. */
function Owners({ companyId }: { companyId: string }) {
  const { data: owners = [], isLoading } = useQuery<OwnerRow[]>(
    ['pm-owners', companyId], () => apiGet<OwnerRow[]>(`/pm/companies/${companyId}/owners`))
  const [open, setOpen] = useState<string>('')
  const month = new Date().toISOString().slice(0, 7)
  const { data: statement } = useQuery<any>(
    ['pm-statement', companyId, open, month],
    () => apiGet<any>(`/pm/companies/${companyId}/owners/${open}/statement?month=${month}`),
    { enabled: !!open })

  if (isLoading) return <div className="muted">Loading…</div>
  if (!owners.length) return <div className="muted">No owners yet. An engagement starts on the Engagements tab.</div>

  return (
    <div>
      <table className="table">
        <thead><tr><th>Owner</th><th>Properties</th><th>Units</th><th>Their portal</th><th></th></tr></thead>
        <tbody>
          {owners.map(o => (
            <tr key={o.landlordId}>
              <td>
                <div style={{ fontWeight: 600 }}>{o.businessName || 'Unnamed company'}</div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{o.ownerEmail || 'no email'}</div>
              </td>
              <td>{o.propertyCount}</td>
              <td>{o.unitCount}</td>
              <td>{o.portalAccess === 'active' ? 'Open' : o.portalAccess === 'closed' ? 'Closed' : '—'}</td>
              <td style={{ textAlign: 'right' }}>
                <button className="btn btn-ghost btn-sm"
                        onClick={() => setOpen(open === o.landlordId ? '' : o.landlordId)}>
                  {open === o.landlordId ? 'Hide' : 'This month'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && statement && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="kpi-l">This month, property by property</div>
          <table className="table" style={{ marginTop: 8 }}>
            <thead><tr><th>Property</th><th>Collected</th><th>Your fee</th><th>To the owner</th></tr></thead>
            <tbody>
              {(statement.properties ?? []).map((p: any) => (
                <tr key={p.propertyId}>
                  <td>{p.propertyName}</td>
                  <td>{money(p.collected ?? p.gross)}</td>
                  <td>{money(p.pmFee)}</td>
                  <td>{money(p.net ?? p.toOwner)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Engagements: an owner asking this company in, or this company asking an owner. */
function Engagements({ companyId }: { companyId: string }) {
  const qc = useQueryClient()
  const [err, setErr] = useState('')
  const { data: invites = [], isLoading } = useQuery<any[]>(
    ['pm-property-invites', companyId],
    () => apiGet<any[]>(`/pm/companies/${companyId}/property-invitations`))

  const act = useMutation(
    (p: { id: string; what: 'accept' | 'reject' }) =>
      apiPost(`/pm/companies/${companyId}/property-invitations/${p.id}/${p.what}`, {}),
    { onSuccess: () => { qc.invalidateQueries(['pm-property-invites', companyId]); setErr('') },
      onError: (e: any) => setErr(e?.message || 'That did not go through — try again.') })

  if (isLoading) return <div className="muted">Loading…</div>
  return (
    <div>
      {err && <div className="alert a-red" style={{ marginBottom: 10 }}>{err}</div>}
      <p style={{ color: 'var(--text-3)', fontSize: '.85rem', marginTop: 0 }}>
        Accepting an engagement gives your staff that property in this portal — the properties the
        owner engaged you for, and nothing else of theirs. What each person can do there is what you
        gave them on the Staff tab, capped by what the owner agreed to.
      </p>
      {!invites.length ? <div className="muted">Nothing waiting.</div> : (
        <table className="table">
          <thead><tr><th>Property</th><th>Owner</th><th>Scope</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {invites.map(i => (
              <tr key={i.id}>
                <td>{i.propertyName || '—'}</td>
                <td>{i.ownerName || '—'}</td>
                <td>{i.proposedScope || '—'}</td>
                <td>{i.status}</td>
                <td style={{ textAlign: 'right' }}>
                  {i.status === 'pending' && i.direction === 'owner_to_pm' && (
                    <>
                      <button className="btn btn-primary btn-sm" disabled={act.isLoading}
                              onClick={() => act.mutate({ id: i.id, what: 'accept' })}>Accept</button>{' '}
                      <button className="btn btn-ghost btn-sm" disabled={act.isLoading}
                              onClick={() => act.mutate({ id: i.id, what: 'reject' })}>Decline</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** The rate sheets this company offers owners. */
function FeePlans({ companyId }: { companyId: string }) {
  const { data: plans = [], isLoading } = useQuery<FeePlan[]>(
    ['pm-fee-plans', companyId], () => apiGet<FeePlan[]>(`/pm/companies/${companyId}/fee-plans`))
  if (isLoading) return <div className="muted">Loading…</div>
  if (!plans.length) return <div className="muted">No rate sheets yet.</div>
  return (
    <table className="table">
      <thead><tr><th>Rate sheet</th><th>Basis</th><th>Rate</th><th>Status</th></tr></thead>
      <tbody>
        {plans.map(p => (
          <tr key={p.id}>
            <td>{p.name}</td>
            <td>{p.basis || '—'}</td>
            <td>{p.percent != null ? `${p.percent}%` : money(p.flatAmount)}</td>
            <td>{p.status || (p.isActive === false ? 'retired' : 'active')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * This company's own people. 10/22 (Nic): "If I own the property management
 * company and I have somebody working for me that does maintenance, they are
 * scoped to maintenance. I add them as a team member for maintenance. It's the
 * same kind of breakdown as the people that do it on site."
 */
function Staff({ companyId }: { companyId: string }) {
  const { data: staff = [], isLoading } = useQuery<StaffRow[]>(
    ['pm-staff', companyId], () => apiGet<StaffRow[]>(`/pm/companies/${companyId}/staff`))
  if (isLoading) return <div className="muted">Loading…</div>
  return (
    <div>
      <p style={{ color: 'var(--text-3)', fontSize: '.85rem', marginTop: 0 }}>
        Your people, and what each of them can do. Their access reaches only the properties owners
        have engaged you for, and never more than the owner agreed to.
      </p>
      {!staff.length ? <div className="muted">Just you so far.</div> : (
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>
            {staff.map(s => (
              <tr key={s.id}>
                <td>{s.name || '—'}</td><td>{s.email || '—'}</td><td>{s.role}</td><td>{s.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** The company's own bank account — its fee lands there, not in an owner's. */
function Banking({ companyId }: { companyId: string }) {
  const [err, setErr] = useState('')
  const { data: status, isLoading } = useQuery<ConnectStatus>(
    ['pm-connect', companyId], () => apiGet<ConnectStatus>(`/pm/companies/${companyId}/connect/account-status`))
  const onboard = useMutation(
    () => apiPost<{ url?: string }>(`/pm/companies/${companyId}/connect/onboarding-link`, {}),
    { onSuccess: (r: any) => { const u = r?.data?.url ?? r?.url; if (u) window.location.href = u },
      onError: (e: any) => setErr(e?.message || 'That link could not be made just now — try again.') })

  if (isLoading) return <div className="muted">Loading…</div>
  const ready = !!status?.payoutsEnabled && !!status?.detailsSubmitted
  return (
    <div className="card" style={{ maxWidth: 620 }}>
      {err && <div className="alert a-red" style={{ marginBottom: 10 }}>{err}</div>}
      <div className="kpi-l">Payouts</div>
      <div style={{ fontSize: '1.05rem', fontWeight: 600, marginTop: 4 }}>
        {ready ? 'Ready — your management fee pays out to this company' : 'Not finished'}
      </div>
      <p style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>
        Your company keeps its own bank account, separate from the owners you work for. An
        engagement GAM routes money under cannot be accepted until this is finished.
      </p>
      {!ready && (
        <button className="btn btn-primary btn-sm" disabled={onboard.isLoading} onClick={() => onboard.mutate()}>
          {onboard.isLoading ? 'Opening…' : 'Finish banking setup'}
        </button>
      )}
    </div>
  )
}
