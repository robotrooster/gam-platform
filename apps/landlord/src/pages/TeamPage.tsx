import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import {
  LANDLORD_ASSIGNABLE_ROLES,
  LANDLORD_ASSIGNABLE_ROLE_LABEL,
  LandlordAssignableRole,
  SUB_PERMISSIONS_BY_ROLE,
  SUB_PERMISSION_LABEL,
  BOOKKEEPER_ACCESS_LEVELS,
  MAINTENANCE_JOB_CATEGORIES,
  MAINTENANCE_JOB_CATEGORY_LABEL,
  MaintenanceJobCategory,
  BookkeeperAccessLevel,
} from '@gam/shared'

type NonBookkeeperRole = Exclude<LandlordAssignableRole, 'bookkeeper'>

interface PropertyLite {
  id: string
  name: string
  street1: string | null
  city: string | null
  state: string | null
}

interface UnitLite {
  id: string
  unitNumber: string
  propertyId: string
}

interface Member {
  userId: string
  role: LandlordAssignableRole
  email: string
  firstName: string
  lastName: string
  phone: string | null
  permissions: Record<string, any>
  scope: any
  createdAt: string
  updatedAt: string
  // S168: property_manager-only — direct-deposit opt-in toggle and the
  // cached Stripe Connect readiness flags from the manager's user row.
  directDepositEnabled?: boolean
  connectChargesEnabled?: boolean
  connectPayoutsEnabled?: boolean
  connectDetailsSubmitted?: boolean
}

interface Invitation {
  id: string
  email: string
  role: LandlordAssignableRole
  status: string
  expiresAt: string
  createdAt: string
}

interface TeamPayload {
  members: Member[]
  invitations: Invitation[]
}

const ROLE_BADGE: Record<LandlordAssignableRole, string> = {
  property_manager: 'badge-blue',
  onsite_manager:   'badge-amber',
  maintenance:      'badge-muted',
  bookkeeper:       'badge-green',
}

export function TeamPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<TeamPayload>('team', () => apiGet('/scopes/team'))
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const togglePerm = useMutation(
    (args: { role: LandlordAssignableRole; userId: string; permissions: Record<string, boolean> }) =>
      apiPatch(`/scopes/${args.role}/${args.userId}/permissions`, { permissions: args.permissions }),
    { onSuccess: () => qc.invalidateQueries('team') }
  )

  const updateBookkeeperLevel = useMutation(
    (args: { userId: string; accessLevel: string }) =>
      apiPatch(`/scopes/bookkeeper/${args.userId}`, { accessLevel: args.accessLevel }),
    { onSuccess: () => qc.invalidateQueries('team') }
  )

  // S168: per-manager direct-deposit toggle. Enabling fires a
  // notification+email to the manager prompting them to onboard via
  // the Stripe Connect surface in their portal Banking page.
  const toggleDirectDeposit = useMutation(
    (args: { userId: string; enabled: boolean }) =>
      apiPatch(`/scopes/property_manager/${args.userId}/direct-deposit`, { enabled: args.enabled }),
    { onSuccess: () => qc.invalidateQueries('team') }
  )

  const members = data?.members || []
  const invitations = data?.invitations || []

  const toggleOne = (m: Member, key: string) => {
    const current = (m.permissions || {}) as Record<string, boolean>
    const next = { ...current, [key]: !current[key] }
    togglePerm.mutate({ role: m.role, userId: m.userId, permissions: next })
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-subtitle">Staff and per-feature permissions</p>
        </div>
      </div>

      {/* S229: invite form. Posts to /scopes/:role/invite (canonical
          token-based flow, S80) — sends an email link to the invitee.
          Scope minimums only; landlord refines per-property + per-
          permission via the rows below after the invite is accepted. */}
      <InviteForm onSent={() => qc.invalidateQueries('team')} />

      {isLoading ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : (
        <>
          <div className="card" style={{ padding: 0, marginBottom: 20, overflowX: 'auto' }}>
            <table className="data-table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No team members yet.</td></tr>
                ) : members.map(m => {
                  const expanded = expandedId === m.userId
                  const isBookkeeper = m.role === 'bookkeeper'
                  const perms = (m.permissions || {}) as Record<string, boolean>
                  const enabledCount = isBookkeeper ? 0 : Object.values(perms).filter(Boolean).length
                  const totalKeys = isBookkeeper ? 0 : (SUB_PERMISSIONS_BY_ROLE[m.role as Exclude<LandlordAssignableRole,'bookkeeper'>]?.length || 0)
                  return (
                    <>
                      <tr key={m.userId} style={{ cursor: 'pointer' }} onClick={() => setExpandedId(expanded ? null : m.userId)}>
                        <td style={{ fontWeight: 500 }}>{m.firstName} {m.lastName}</td>
                        <td style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>{m.email}</td>
                        <td><span className={`badge ${ROLE_BADGE[m.role]}`}>{LANDLORD_ASSIGNABLE_ROLE_LABEL[m.role]}</span></td>
                        <td style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>
                          {isBookkeeper
                            ? <span className="mono">access: {(m.permissions as any)?.accessLevel || '—'}</span>
                            : `${enabledCount} / ${totalKeys} enabled`}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--text-3)', fontSize: '.82rem' }}>{expanded ? '▾' : '▸'}</td>
                      </tr>
                      {expanded && (
                        <tr key={m.userId + '_expanded'}>
                          <td colSpan={5} style={{ background: 'var(--bg-2, rgba(0,0,0,.2))', padding: 16 }}>
                            {isBookkeeper ? (
                              <div>
                                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 8 }}>Access level</div>
                                <select
                                  value={(m.permissions as any)?.accessLevel || 'read_only'}
                                  onChange={e => updateBookkeeperLevel.mutate({ userId: m.userId, accessLevel: e.target.value })}
                                  style={{ background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 6, color: 'var(--text-0)', padding: '6px 10px', fontSize: '.82rem' }}>
                                  {BOOKKEEPER_ACCESS_LEVELS.map(lv => <option key={lv} value={lv}>{lv}</option>)}
                                </select>
                              </div>
                            ) : (
                              <>
                                {m.role === 'property_manager' && (
                                  <DirectDepositToggle
                                    member={m}
                                    onChange={(enabled) => {
                                      if (enabled && !confirm(
                                        `Enable direct deposit for ${m.firstName} ${m.lastName}? ` +
                                        `They'll get an email + in-app notification to complete Stripe Connect ` +
                                        `onboarding before manager fees can be paid out.`
                                      )) return
                                      toggleDirectDeposit.mutate({ userId: m.userId, enabled })
                                    }}
                                    pending={toggleDirectDeposit.isLoading}
                                  />
                                )}
                                {/* S230: per-property scope picker. Wraps PATCH
                                    /scopes/:role/:userId — full-scope replace,
                                    not the partial /permissions endpoint. */}
                                <ScopePicker
                                  member={m}
                                  onSaved={() => qc.invalidateQueries('team')}
                                />
                                <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', margin: '14px 0 6px' }}>
                                  Permissions
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 6 }}>
                                  {(SUB_PERMISSIONS_BY_ROLE[m.role as Exclude<LandlordAssignableRole,'bookkeeper'>] || []).map(key => (
                                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.82rem', color: 'var(--text-1)', cursor: 'pointer' }}>
                                      <input
                                        type="checkbox"
                                        checked={!!perms[key]}
                                        onChange={() => toggleOne(m, key)}
                                        disabled={togglePerm.isLoading}
                                      />
                                      <span>{SUB_PERMISSION_LABEL[key as keyof typeof SUB_PERMISSION_LABEL] || key}</span>
                                      <span className="mono" style={{ fontSize: '.7rem', color: 'var(--text-3)', marginLeft: 'auto' }}>{key}</span>
                                    </label>
                                  ))}
                                </div>
                              </>
                            )}
                            {togglePerm.isError && <div style={{ marginTop: 8, fontSize: '.78rem', color: 'var(--red, #ef4444)' }}>Failed to update permissions.</div>}
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Direct-deposit summary KPI: visible count of managers opted in
              but not yet ready in Stripe. Helps the landlord notice
              managers who haven't finished onboarding. */}
          {(() => {
            const pending = members.filter(m =>
              m.role === 'property_manager' &&
              m.directDepositEnabled &&
              !(m.connectPayoutsEnabled && m.connectDetailsSubmitted))
            if (pending.length === 0) return null
            return (
              <div className="card" style={{ padding: 12, marginBottom: 16, fontSize: '.82rem', color: 'var(--text-2)' }}>
                <strong style={{ color: 'var(--gold)' }}>{pending.length}</strong>{' '}
                manager{pending.length === 1 ? '' : 's'} have direct deposit enabled but
                {' '}haven't completed Stripe Connect onboarding yet. Their fees will
                accumulate as unpaid until they finish setup.
              </div>
            )
          })()}

          {invitations.length > 0 && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-1)', fontWeight: 600, fontSize: '.88rem' }}>Pending invitations</div>
              <table className="data-table">
                <thead>
                  <tr><th>Email</th><th>Role</th><th>Sent</th><th>Expires</th></tr>
                </thead>
                <tbody>
                  {invitations.map(inv => (
                    <tr key={inv.id}>
                      <td style={{ fontSize: '.82rem' }}>{inv.email}</td>
                      <td><span className={`badge ${ROLE_BADGE[inv.role] || 'badge-muted'}`}>{LANDLORD_ASSIGNABLE_ROLE_LABEL[inv.role]}</span></td>
                      <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{new Date(inv.createdAt).toLocaleDateString()}</td>
                      <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{new Date(inv.expiresAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// S168: per-manager direct-deposit opt-in. Renders the toggle plus the
// manager's live Stripe Connect readiness so the landlord can see who's
// opted in but hasn't onboarded yet.
function DirectDepositToggle({
  member, onChange, pending,
}: {
  member: Member
  onChange: (enabled: boolean) => void
  pending: boolean
}) {
  const [showReqs, setShowReqs] = useState(false)
  const enabled = !!member.directDepositEnabled
  const ready   = !!(member.connectPayoutsEnabled && member.connectDetailsSubmitted)
  const status: { tone: 'green' | 'gold' | 'muted'; text: string } =
    !enabled                             ? { tone: 'muted', text: 'Disabled' }
    : ready                              ? { tone: 'green', text: 'Connected' }
    : member.connectDetailsSubmitted   ? { tone: 'gold',  text: 'Verifying' }
    :                                      { tone: 'gold',  text: 'Awaiting onboarding' }
  const showReqsButton = enabled && !ready

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '10px 12px',
      background: 'var(--bg-1)', border: '1px solid var(--border-1)',
      borderRadius: 8, marginBottom: 12, flexWrap: 'wrap',
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: pending ? 'wait' : 'pointer', fontSize: '.85rem', fontWeight: 600 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={e => onChange(e.target.checked)}
        />
        Direct Deposit
      </label>
      <span style={{
        padding: '2px 10px', borderRadius: 12, fontSize: '.7rem', fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '.05em',
        background:
          status.tone === 'green' ? 'rgba(38,167,90,.15)' :
          status.tone === 'gold'  ? 'rgba(220,165,40,.15)' :
                                    'rgba(255,255,255,.06)',
        color:
          status.tone === 'green' ? 'var(--green, #2ea35a)' :
          status.tone === 'gold'  ? 'var(--gold)' :
                                    'var(--text-3)',
      }}>{status.text}</span>
      {showReqsButton && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowReqs(true)}
          style={{ fontSize: '.74rem' }}>
          View requirements
        </button>
      )}
      <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginLeft: 'auto' }}>
        Pays out manager fees through Stripe Connect once enabled and onboarded.
      </div>
      {showReqs && (
        <ConnectRequirementsModal userId={member.userId} memberName={`${member.firstName} ${member.lastName}`} onClose={() => setShowReqs(false)} />
      )}
    </div>
  )
}

// S168 follow-on: drill into a manager's outstanding Stripe Connect KYC
// requirements. Backend proxies stripe.accounts.retrieve so the data is
// always fresh; displays currently_due, past_due, and any
// disabled_reason that's parking the account.
function ConnectRequirementsModal({
  userId, memberName, onClose,
}: {
  userId: string
  memberName: string
  onClose: () => void
}) {
  const { data, isLoading, error } = useQuery<{
    exists: boolean
    connectAccountId?: string
    chargesEnabled?: boolean
    payoutsEnabled?: boolean
    detailsSubmitted?: boolean
    requirementsCurrentlyDue?: string[]
    requirementsPastDue?: string[]
    requirementsDisabledReason?: string | null
  }>(
    ['manager-connect-status', userId],
    () => apiGet(`/scopes/property_manager/${userId}/connect-status`),
  )

  const currentlyDue = data?.requirementsCurrentlyDue ?? []
  const pastDue      = data?.requirementsPastDue ?? []

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-title" style={{ marginBottom: 6 }}>Stripe Onboarding Requirements</div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 14 }}>
          {memberName} — pulled live from Stripe. Forward these items to them so they
          can finish onboarding.
        </div>
        {isLoading && <div style={{ color: 'var(--text-3)', padding: 16 }}>Loading…</div>}
        {error != null && (
          <div style={{ color: 'var(--red, #dc4c4c)', fontSize: '.82rem', padding: 12, background: 'rgba(255,71,87,.08)', borderRadius: 8 }}>
            Couldn't fetch Stripe status right now.
          </div>
        )}
        {data && !data.exists && (
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', padding: 12 }}>
            This manager hasn't started Stripe onboarding yet. Their account will be
            created the first time they visit Banking in their portal.
          </div>
        )}
        {data?.exists && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {data.requirementsDisabledReason && (
              <div style={{ padding: 10, background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, fontSize: '.78rem' }}>
                <strong style={{ color: 'var(--red, #dc4c4c)' }}>Account disabled:</strong>{' '}
                <span className="mono">{data.requirementsDisabledReason}</span>
              </div>
            )}
            <RequirementsList title="Past due" items={pastDue} tone="red" />
            <RequirementsList title="Currently due" items={currentlyDue} tone="gold" />
            {pastDue.length === 0 && currentlyDue.length === 0 && !data.requirementsDisabledReason && (
              <div style={{ fontSize: '.82rem', color: 'var(--text-3)', padding: 12 }}>
                No outstanding requirements. Stripe is verifying their submission —
                this can take up to a business day.
              </div>
            )}
          </div>
        )}
        <div className="modal-footer" style={{ marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function RequirementsList({ title, items, tone }: { title: string; items: string[]; tone: 'red' | 'gold' }) {
  if (items.length === 0) return null
  const color = tone === 'red' ? 'var(--red, #dc4c4c)' : 'var(--gold)'
  return (
    <div>
      <div style={{ fontSize: '.74rem', fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
        {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: '.82rem', color: 'var(--text-1)' }}>
        {items.map(item => (
          <li key={item} className="mono" style={{ fontSize: '.78rem' }}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

// S229: TeamPage invite form. Wraps POST /api/scopes/:roleType/invite —
// the canonical token-based flow that emails the invitee a link.
// Scope minimums only (allProperties / accessLevel / jobCategories);
// per-property pickers + permission toggles happen on the team table
// rows below after the invite is accepted.
function InviteForm({ onSent }: { onSent: () => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<LandlordAssignableRole>('maintenance')
  const [allProperties, setAllProperties] = useState(false)
  const [jobCategories, setJobCategories] = useState<MaintenanceJobCategory[]>([])
  const [accessLevel, setAccessLevel] = useState<BookkeeperAccessLevel>('read_only')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const reset = () => {
    setEmail('')
    setAllProperties(false)
    setJobCategories([])
    setAccessLevel('read_only')
  }

  const mut = useMutation(
    () => {
      const scope: any =
        role === 'bookkeeper'  ? { accessLevel } :
        role === 'maintenance' ? { propertyIds: [], unitIds: [], jobCategories, allProperties } :
        role === 'onsite_manager' ? { propertyIds: [], unitIds: [], allProperties } :
        /* property_manager */ { propertyIds: [], unitIds: [], allProperties, maintApprovalCeilingCents: null }
      return apiPost(`/scopes/${role}/invite`, { email: email.trim(), scope })
    },
    {
      onSuccess: () => {
        setError(null)
        setSuccess(`Invitation emailed to ${email.trim()}.`)
        reset()
        onSent()
        setTimeout(() => setSuccess(null), 4000)
      },
      onError: (e: any) => {
        setSuccess(null)
        setError(e?.response?.data?.message || e?.response?.data?.error || e?.message || 'Could not send invitation')
      },
    },
  )

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!email.trim()) {
      setError('Email is required')
      return
    }
    mut.mutate()
  }

  const toggleJobCat = (cat: MaintenanceJobCategory) => {
    setJobCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat])
  }

  const showAllPropsToggle = role === 'property_manager' || role === 'onsite_manager' || role === 'maintenance'
  const showJobCats = role === 'maintenance'
  const showAccessLevel = role === 'bookkeeper'

  return (
    <div className="card" style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ fontSize: '.95rem', fontWeight: 600, marginBottom: 4 }}>Invite team member</div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
        Sends an email with a link to claim the invitation. After acceptance, you can refine per-property scope and per-permission toggles on the team row below.
      </div>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 4 }}>
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="name@example.com"
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 4 }}>
              Role
            </label>
            <select
              value={role}
              onChange={e => setRole(e.target.value as LandlordAssignableRole)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', color: 'var(--text-0)', boxSizing: 'border-box' }}
            >
              {LANDLORD_ASSIGNABLE_ROLES.map(r => (
                <option key={r} value={r}>{LANDLORD_ASSIGNABLE_ROLE_LABEL[r]}</option>
              ))}
            </select>
          </div>
        </div>

        {showAllPropsToggle && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.82rem', cursor: 'pointer', padding: '4px 0' }}>
            <input
              type="checkbox"
              checked={allProperties}
              onChange={e => setAllProperties(e.target.checked)}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            <span>Grant access to <strong>all current and future properties</strong></span>
            <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>(otherwise scope to specific properties after acceptance)</span>
          </label>
        )}

        {showJobCats && (
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 6 }}>
              Job categories <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)' }}>(empty = all)</span>
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {MAINTENANCE_JOB_CATEGORIES.map(cat => {
                const on = jobCategories.includes(cat)
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => toggleJobCat(cat)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      fontSize: '.72rem',
                      fontWeight: 500,
                      border: `1px solid ${on ? 'var(--gold)' : 'var(--border-0)'}`,
                      background: on ? 'rgba(201,162,39,.12)' : 'var(--bg-2)',
                      color: on ? 'var(--gold)' : 'var(--text-2)',
                      cursor: 'pointer',
                    }}
                  >
                    {MAINTENANCE_JOB_CATEGORY_LABEL[cat]}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {showAccessLevel && (
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 4 }}>
              Access level
            </label>
            <select
              value={accessLevel}
              onChange={e => setAccessLevel(e.target.value as BookkeeperAccessLevel)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', color: 'var(--text-0)', boxSizing: 'border-box' }}
            >
              {BOOKKEEPER_ACCESS_LEVELS.map(lvl => (
                <option key={lvl} value={lvl}>
                  {lvl === 'read_only' ? 'Read only — view books, no edits' : 'Read + write — full books access'}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(220,76,76,.08)', border: '1px solid rgba(220,76,76,.25)', color: 'var(--red, #dc4c4c)', fontSize: '.78rem' }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(46,163,90,.08)', border: '1px solid rgba(46,163,90,.25)', color: 'var(--green, #2ea35a)', fontSize: '.78rem' }}>
            {success}
          </div>
        )}

        <div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={mut.isLoading || !email.trim()}
          >
            {mut.isLoading ? 'Sending…' : 'Send invitation'}
          </button>
        </div>
      </form>
    </div>
  )
}

// S230: per-property scope picker for non-bookkeeper members. Wraps the
// existing PATCH /api/scopes/:roleType/:userId endpoint (full-scope
// replace) — distinct from the /permissions partial endpoint already used
// by the sub-permission checkbox grid below. Reads /properties + /units
// (already cached on most landlord pages) and lets the landlord toggle
// allProperties OR pick specific properties + per-property unit subsets.
// Maintenance gets the job-categories chip selector; PM gets the
// approval-ceiling input.
function ScopePicker({ member, onSaved }: { member: Member; onSaved: () => void }) {
  const role = member.role as NonBookkeeperRole
  const { data: properties = [], isLoading: propsLoading } =
    useQuery<PropertyLite[]>('properties', () => apiGet<PropertyLite[]>('/properties'))
  const { data: units = [], isLoading: unitsLoading } =
    useQuery<UnitLite[]>('units', () => apiGet<UnitLite[]>('/units'))

  const initial = (member.scope || {}) as {
    propertyIds?: string[]
    unitIds?: string[]
    allProperties?: boolean
    jobCategories?: MaintenanceJobCategory[]
    maintApprovalCeilingCents?: number | null
  }

  const [allProperties, setAllProperties] = useState<boolean>(!!initial.allProperties)
  const [propertyIds, setPropertyIds]     = useState<string[]>(initial.propertyIds || [])
  const [unitIds, setUnitIds]             = useState<string[]>(initial.unitIds || [])
  const [jobCategories, setJobCategories] =
    useState<MaintenanceJobCategory[]>(initial.jobCategories || [])
  const [ceilingDollars, setCeilingDollars] = useState<string>(
    initial.maintApprovalCeilingCents != null
      ? String((initial.maintApprovalCeilingCents / 100).toFixed(2))
      : '')
  const [error, setError]     = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [expandedProp, setExpandedProp] = useState<string | null>(null)

  const unitsByProperty = useMemo(() => {
    const m: Record<string, UnitLite[]> = {}
    for (const u of units) {
      ;(m[u.propertyId] ||= []).push(u)
    }
    for (const k of Object.keys(m)) {
      m[k].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }))
    }
    return m
  }, [units])

  const togglePropertyId = (id: string) => {
    setPropertyIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
    // Clear any redundant unit picks under a property that's now whole-property.
    const justAdded = !propertyIds.includes(id)
    if (justAdded) {
      const propUnitIds = (unitsByProperty[id] || []).map(u => u.id)
      if (propUnitIds.length > 0) {
        setUnitIds(prev => prev.filter(uid => !propUnitIds.includes(uid)))
      }
    }
  }
  const toggleUnitId = (id: string) => {
    setUnitIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }
  const toggleJobCat = (cat: MaintenanceJobCategory) => {
    setJobCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat])
  }

  const mut = useMutation(
    () => {
      let parsedCeiling: number | null = null
      if (role === 'property_manager' && ceilingDollars.trim() !== '') {
        const n = Number(ceilingDollars)
        if (!Number.isFinite(n) || n < 0) {
          throw new Error('Approval ceiling must be a non-negative number')
        }
        parsedCeiling = Math.round(n * 100)
      }
      const scope: any =
        role === 'maintenance'    ? { propertyIds, unitIds, jobCategories, allProperties } :
        role === 'onsite_manager' ? { propertyIds, unitIds, allProperties } :
        /* property_manager */      { propertyIds, unitIds, allProperties,
                                      maintApprovalCeilingCents: parsedCeiling }
      return apiPatch(`/scopes/${role}/${member.userId}`, scope)
    },
    {
      onSuccess: () => {
        setError(null)
        setSuccess('Scope saved.')
        onSaved()
        setTimeout(() => setSuccess(null), 3500)
      },
      onError: (e: any) => {
        setSuccess(null)
        setError(e?.response?.data?.message || e?.response?.data?.error || e?.message || 'Could not save scope')
      },
    },
  )

  const sortedProps = useMemo(
    () => [...properties].sort((a, b) => a.name.localeCompare(b.name)),
    [properties])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    mut.mutate()
  }

  return (
    <form onSubmit={submit} style={{
      padding: 12,
      background: 'var(--bg-1)',
      border: '1px solid var(--border-1)',
      borderRadius: 8,
      marginBottom: 12,
    }}>
      <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
        Property scope
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.82rem', cursor: 'pointer', marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={allProperties}
          onChange={e => setAllProperties(e.target.checked)}
          style={{ width: 16, height: 16, cursor: 'pointer' }}
        />
        <span><strong>All current and future properties</strong></span>
        <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>(overrides per-property selection)</span>
      </label>

      {!allProperties && (
        <div style={{ marginBottom: 10 }}>
          {propsLoading || unitsLoading ? (
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)', padding: 8 }}>Loading properties…</div>
          ) : sortedProps.length === 0 ? (
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)', padding: 8 }}>You have no properties yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 280, overflowY: 'auto', padding: '4px 0' }}>
              {sortedProps.map(p => {
                const propChecked = propertyIds.includes(p.id)
                const propUnits = unitsByProperty[p.id] || []
                const unitsChecked = propUnits.filter(u => unitIds.includes(u.id)).length
                const isExpanded = expandedProp === p.id
                return (
                  <div key={p.id} style={{ border: '1px solid var(--border-0)', borderRadius: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px' }}>
                      <input
                        type="checkbox"
                        checked={propChecked}
                        onChange={() => togglePropertyId(p.id)}
                        style={{ width: 15, height: 15, cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: '.83rem', fontWeight: 500, flex: 1 }}>{p.name}</span>
                      <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                        {p.city}{p.state ? `, ${p.state}` : ''}
                      </span>
                      {!propChecked && propUnits.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setExpandedProp(isExpanded ? null : p.id)}
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: '.72rem', padding: '2px 8px' }}
                        >
                          {isExpanded ? 'Hide units' : `Units (${unitsChecked}/${propUnits.length})`}
                        </button>
                      )}
                      {propChecked && propUnits.length > 0 && (
                        <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                          all {propUnits.length} units
                        </span>
                      )}
                    </div>
                    {!propChecked && isExpanded && propUnits.length > 0 && (
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                        gap: 4,
                        padding: '4px 10px 10px 30px',
                        borderTop: '1px solid var(--border-0)',
                      }}>
                        {propUnits.map(u => (
                          <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.78rem', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={unitIds.includes(u.id)}
                              onChange={() => toggleUnitId(u.id)}
                            />
                            <span>Unit {u.unitNumber}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {role === 'maintenance' && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
            Job categories <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(empty = all)</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {MAINTENANCE_JOB_CATEGORIES.map(cat => {
              const on = jobCategories.includes(cat)
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleJobCat(cat)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: '.72rem',
                    fontWeight: 500,
                    border: `1px solid ${on ? 'var(--gold)' : 'var(--border-0)'}`,
                    background: on ? 'rgba(201,162,39,.12)' : 'var(--bg-2)',
                    color: on ? 'var(--gold)' : 'var(--text-2)',
                    cursor: 'pointer',
                  }}
                >
                  {MAINTENANCE_JOB_CATEGORY_LABEL[cat]}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {role === 'property_manager' && (
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 4 }}>
            Maintenance approval ceiling <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(blank = no override)</span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: '.85rem', color: 'var(--text-3)' }}>$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={ceilingDollars}
              onChange={e => setCeilingDollars(e.target.value)}
              placeholder="e.g. 500"
              style={{ width: 140, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.82rem' }}
            />
            <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
              Manager auto-approves under this amount; falls back to the property setting if blank.
            </span>
          </div>
        </div>
      )}

      {error && (
        <div style={{ padding: '6px 10px', borderRadius: 6, background: 'rgba(220,76,76,.08)', border: '1px solid rgba(220,76,76,.25)', color: 'var(--red, #dc4c4c)', fontSize: '.76rem', marginBottom: 8 }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{ padding: '6px 10px', borderRadius: 6, background: 'rgba(46,163,90,.08)', border: '1px solid rgba(46,163,90,.25)', color: 'var(--green, #2ea35a)', fontSize: '.76rem', marginBottom: 8 }}>
          {success}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={mut.isLoading}>
          {mut.isLoading ? 'Saving…' : 'Save scope'}
        </button>
        {!allProperties && (
          <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
            {propertyIds.length} propert{propertyIds.length === 1 ? 'y' : 'ies'}
            {unitIds.length > 0 ? `, ${unitIds.length} additional unit${unitIds.length === 1 ? '' : 's'}` : ''}
          </span>
        )}
      </div>
    </form>
  )
}
