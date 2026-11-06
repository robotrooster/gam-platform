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
import { Building2, Users, Receipt, Landmark, HeartHandshake, UserPlus, Mail, Send } from 'lucide-react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { PM_STAFF_ROLES, PM_STAFF_ROLE_LABEL, PM_STAFF_STATUS_LABEL,
         type PmStaffRole, type PmStaffStatus } from '@gam/shared'
import { toast, appConfirm } from '../components/dialogs'

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
  id: string; userId: string
  // 11/01: this said `name`, which the endpoint never sends — it selects
  // u.first_name / u.last_name, so every row's Name column read "—" for as
  // long as the tab has existed.
  firstName?: string | null; lastName?: string | null; email?: string | null
  role: PmStaffRole; status: PmStaffStatus
}
interface StaffInvite {
  id: string; email: string; role: PmStaffRole; status: string
  expiresAt: string | null; acceptedAt: string | null; revokedAt: string | null
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
  const qc = useQueryClient()
  const [inviting, setInviting] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<PmStaffRole>('staff')

  const { data: staff = [], isLoading } = useQuery<StaffRow[]>(
    ['pm-staff', companyId], () => apiGet<StaffRow[]>(`/pm/companies/${companyId}/staff`))
  const { data: invites = [] } = useQuery<StaffInvite[]>(
    ['pm-staff-invites', companyId],
    () => apiGet<StaffInvite[]>(`/pm/companies/${companyId}/invitations`))

  const refresh = () => {
    qc.invalidateQueries(['pm-staff', companyId])
    qc.invalidateQueries(['pm-staff-invites', companyId])
  }

  // 11/01: the invitation endpoint, not the add-by-user-id one. POST
  // /staff wants a user UUID, which nobody running a management company
  // knows — and a user search that would find it for them would let one
  // company enumerate every account on the platform. Inviting by email is
  // the door that already emails an accept link.
  const invite = useMutation(
    () => apiPost(`/pm/companies/${companyId}/invitations`, { email: email.trim(), role }),
    {
      onSuccess: () => {
        toast('Invitation sent. They join once they accept it.')
        setInviting(false); setEmail(''); setRole('staff'); refresh()
      },
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not send that invitation.'),
    })

  const resend = useMutation(
    (invId: string) => apiPost(`/pm/companies/${companyId}/invitations/${invId}/resend`, {}),
    {
      onSuccess: () => { toast('Sent again.'); refresh() },
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not send that again.'),
    })

  const change = useMutation(
    (args: { staffId: string; body: Record<string, unknown> }) =>
      apiPatch(`/pm/companies/${companyId}/staff/${args.staffId}`, args.body),
    {
      onSuccess: () => { toast('Saved.'); refresh() },
      // The server refuses taking the last owner out, and says so in plain
      // words — show its sentence rather than a generic failure.
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not save that.'),
    })

  const pending = invites.filter(i => !i.acceptedAt && !i.revokedAt && i.status !== 'accepted')
  const nameOf = (s: StaffRow) =>
    [s.firstName, s.lastName].filter(Boolean).join(' ') || null

  if (isLoading) return <div className="muted">Loading…</div>
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <p style={{ color: 'var(--text-3)', fontSize: '.85rem', margin: 0, flex: 1, minWidth: 220 }}>
          Your people, and what each of them can do. Their access reaches only the properties owners
          have engaged you for, and never more than the owner agreed to.
        </p>
        {!inviting && (
          <button className="btn btn-primary btn-sm" onClick={() => setInviting(true)}>
            <UserPlus size={14} /> Add someone
          </button>
        )}
      </div>

      {inviting && (
        <div className="card" style={{ marginTop: 12, display: 'grid', gap: 10, maxWidth: 460 }}>
          <div>
            <label style={{ fontSize: '.75rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>
              Their email
            </label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                   placeholder="person@example.com" />
          </div>
          <div>
            <label style={{ fontSize: '.75rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>
              What they do
            </label>
            <select value={role} onChange={e => setRole(e.target.value as PmStaffRole)}>
              {PM_STAFF_ROLES.map(r => (
                <option key={r} value={r}>{PM_STAFF_ROLE_LABEL[r]}</option>
              ))}
            </select>
          </div>
          <p style={{ fontSize: '.75rem', color: 'var(--text-3)', margin: 0 }}>
            They get an email with a link to join. Whatever you give them here, they still
            only reach the properties your owners have engaged you for.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm"
                    onClick={() => { setInviting(false); setEmail('') }}>Cancel</button>
            <button className="btn btn-primary btn-sm"
                    disabled={invite.isLoading || !/.+@.+\..+/.test(email.trim())}
                    onClick={() => invite.mutate()}>
              {invite.isLoading ? 'Sending…' : 'Send the invitation'}
            </button>
          </div>
        </div>
      )}

      {!staff.length ? <div className="muted" style={{ marginTop: 12 }}>Just you so far.</div> : (
        <table className="table" style={{ marginTop: 12 }}>
          <thead><tr><th>Name</th><th>Email</th><th>What they do</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {staff.map(s => (
              <tr key={s.id}>
                <td>{nameOf(s) || '—'}</td>
                <td>{s.email || '—'}</td>
                <td>
                  {/* An owner may change what somebody does; the server refuses
                      taking the last owner out and says why. */}
                  <select value={s.role} disabled={change.isLoading}
                          onChange={e => change.mutate({ staffId: s.id, body: { role: e.target.value } })}>
                    {PM_STAFF_ROLES.map(r => (
                      <option key={r} value={r}>{PM_STAFF_ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                </td>
                <td>{PM_STAFF_STATUS_LABEL[s.status] ?? s.status}</td>
                <td>
                  {s.status === 'active' ? (
                    <button className="btn btn-ghost btn-sm" disabled={change.isLoading}
                            onClick={async () => {
                              const ok = await appConfirm(
                                `${nameOf(s) || s.email || 'This person'} keeps their account but stops reaching any of your owners' properties. You can switch them back on later.`,
                                { title: 'Switch this person off?', confirmLabel: 'Switch them off', danger: true })
                              if (ok) change.mutate({ staffId: s.id, body: { status: 'inactive' } })
                            }}>
                      Switch off
                    </button>
                  ) : (
                    <button className="btn btn-ghost btn-sm" disabled={change.isLoading}
                            onClick={() => change.mutate({ staffId: s.id, body: { status: 'active' } })}>
                      Switch back on
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pending.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h4 style={{ fontSize: '.85rem', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Mail size={14} /> Waiting to accept ({pending.length})
          </h4>
          <div style={{ display: 'grid', gap: 6 }}>
            {pending.map(i => (
              <div key={i.id} style={{
                display: 'grid', gap: '2px 10px', gridTemplateColumns: 'minmax(0, 1fr) auto',
                alignItems: 'center', fontSize: '.85rem',
                borderLeft: '3px solid var(--border-1, #2a2a2a)', paddingLeft: 10,
              }}>
                <span style={{ minWidth: 0 }}>{i.email}</span>
                <button className="btn btn-ghost btn-sm" disabled={resend.isLoading}
                        onClick={() => resend.mutate(i.id)}>
                  <Send size={12} /> Send again
                </button>
                <span style={{ color: 'var(--text-3)', gridColumn: '1 / -1' }}>
                  {PM_STAFF_ROLE_LABEL[i.role] ?? i.role}
                  {i.expiresAt ? ` · link good until ${String(i.expiresAt).slice(0, 10)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
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
