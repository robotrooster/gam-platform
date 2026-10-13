import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch, apiPost, apiDel } from '../lib/api'
import {
  LANDLORD_ASSIGNABLE_ROLE_LABEL,
  LandlordAssignableRole,
  bookkeeperAccessSummary,
  BOOKKEEPER_MONEY_IN_FILING, BOOKKEEPER_MONEY_IN_FILING_LABEL, DEFAULT_BOOKKEEPER_MONEY_IN_FILING,
  type BookkeeperMoneyInFiling,
} from '@gam/shared'
import { PermissionCatalogEditor } from '../components/PermissionCatalogEditor'
import { EntityPicker, useEntities } from '../components/EntityPicker'
import { appConfirm, toast } from '../components/dialogs'

// S526: the old expandable-row permission grid (SUB_PERMISSIONS_BY_ROLE
// checkboxes + inline ScopePicker) is RETIRED — the dedicated per-user page at
// /team/:userId/permissions is the one permissions surface (catalog toggles +
// property scope + direct deposit all live there). This page is now just the
// roster: invite form, member list, pending invitations. Bookkeepers keep
// their boxes here (they have no catalog permissions; 10/12, Nic: and no
// access level — one level, full bookkeeping).

interface Member {
  userId: string
  role: LandlordAssignableRole
  email: string
  firstName: string
  lastName: string
  phone: string | null
  permissions: Record<string, any>
  scope: any
  // S652: the roster spans every company the account owns; each member
  // belongs to one, and the column shows only when there is more than one.
  landlordId: string
  companyName: string | null
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
  // 10/11: a pending bookkeeper invitation's ticked properties.
  propertyIds?: string[] | null
  // 10/12: and its company-wide and lease-dates boxes.
  companyWide?: boolean | null
  showLeaseDates?: boolean | null
  // 10/12 (Nic): the ledger, whole-company reports and monthly report boxes.
  companyLedger?: boolean | null
  wholeCompanyReports?: boolean | null
  seesMonthlyReport?: boolean | null
}

interface TeamPayload {
  members: Member[]
  invitations: Invitation[]
  /** 10/12: the API reads the bookkeeper boxes as boxes (see BOXES_NOT_LIVE). */
  bookkeeperBoxes?: boolean
  /** 10/12 (Nic): the API reads the ledger, whole-company reports and monthly
   *  report boxes. An API from before them would drop them silently, so until
   *  it says so they are not offered. */
  bookkeeperMoreBoxes?: boolean
}

/**
 * 10/12 review (deploy order): the boxes below send a company-wide-only
 * bookkeeper as no property + Company-wide, and an edit that unticks every
 * property as no property. An API from before 10/12 reads "no property" as
 * every property and the whole company, and ignores Company-wide, so this page
 * reaching production ahead of the API would give full access where the owner
 * chose almost none. The API says it reads the boxes (/scopes/team
 * bookkeeperBoxes); until it does, no bookkeeper is saved from here.
 */
const BOXES_NOT_LIVE = 'Bookkeeper access is being updated. Try again in a few minutes.'

const ROLE_BADGE: Record<LandlordAssignableRole, string> = {
  property_manager: 'badge-blue',
  onsite_manager:   'badge-amber',
  maintenance:      'badge-muted',
  bookkeeper:       'badge-green',
}

export function TeamPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data, isLoading } = useQuery<TeamPayload>('team', () => apiGet('/scopes/team'))
  // 10/11: a bookkeeper's row names the properties they keep.
  const { data: properties = [] } = useQuery<any[]>('properties-for-invite', () => apiGet('/properties'))
  const [editingBookkeeper, setEditingBookkeeper] = useState<Member | null>(null)

  // 10/11: names the company — a bookkeeper who keeps two of the account's
  // companies' books is removed from this row's company only.
  const removeBookkeeper = useMutation(
    (m: Member) => apiDel(`/scopes/bookkeeper/${m.userId}?landlordId=${encodeURIComponent(m.landlordId)}`),
    { onSuccess: () => { qc.invalidateQueries('team'); toast('Bookkeeper removed. Their access ends now.') },
      onError: (e: any) => toast(e?.response?.data?.error || e?.message || 'Could not remove the bookkeeper.') }
  )

  const members = data?.members || []
  const invitations = data?.invitations || []
  const multiCompany = new Set(members.map(m => m.landlordId)).size > 1

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-subtitle">Staff and per-feature permissions</p>
        </div>
      </div>

      {/* S229: invite form. Posts to /scopes/:role/invite (canonical
          token-based flow, S80) — sends an email link to the invitee. The
          invite grants nothing; everything is set on the member's
          permissions page after they accept. */}
      <InviteForm onSent={() => qc.invalidateQueries('team')} />

      {/* S592: bookkeepers are invited here too, via the email-link flow (they
          set their own password). Distinct from staff — no permission
          catalog: their boxes (10/11 properties; 10/12 Company-wide and lease
          dates) are the whole of what they get. */}
      <BookkeeperInviteForm boxesLive={data?.bookkeeperBoxes === true} moreBoxes={data?.bookkeeperMoreBoxes === true}
        onSent={() => qc.invalidateQueries('team')} />

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
                  {multiCompany && <th>Company</th>}
                  <th>Permissions</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.length === 0 ? (
                  <tr><td colSpan={multiCompany ? 6 : 5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No team members yet.</td></tr>
                ) : members.map(m => {
                  const isBookkeeper = m.role === 'bookkeeper'
                  const perms = (m.permissions || {}) as Record<string, boolean>
                  const enabledCount = isBookkeeper ? 0 : Object.values(perms).filter(Boolean).length
                  return (
                    <tr
                      key={`${m.userId}:${m.landlordId}`}
                      style={{ cursor: isBookkeeper ? 'default' : 'pointer' }}
                      onClick={() => { if (!isBookkeeper) navigate(`/team/${m.userId}/permissions`) }}
                    >
                      <td style={{ fontWeight: 500 }}>{m.firstName} {m.lastName}</td>
                      <td style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>{m.email}</td>
                      <td><span className={`badge ${ROLE_BADGE[m.role]}`}>{LANDLORD_ASSIGNABLE_ROLE_LABEL[m.role]}</span></td>
                      {multiCompany && <td style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>{m.companyName || '—'}</td>}
                      <td style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>
                        {isBookkeeper
                          ? bookkeeperPropertiesText(m, properties as any[])
                          : `${enabledCount} permission${enabledCount === 1 ? '' : 's'} granted`}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-3)', fontSize: '.82rem', whiteSpace: 'nowrap' }}>
                        {isBookkeeper && (
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <button className="btn btn-primary btn-sm" style={{ fontSize: '.74rem' }}
                              onClick={(e) => { e.stopPropagation(); setEditingBookkeeper(m) }}>
                              Change access
                            </button>
                            <button className="btn btn-ghost btn-sm" style={{ fontSize: '.74rem' }}
                              disabled={removeBookkeeper.isLoading}
                              onClick={async (e) => {
                                e.stopPropagation()
                                if (await appConfirm(`Remove ${m.firstName} ${m.lastName} as your bookkeeper? They lose access right away.`,
                                  { danger: true, confirmLabel: 'Remove' })) removeBookkeeper.mutate(m)
                              }}>
                              Remove
                            </button>
                          </span>
                        )}
                        {!isBookkeeper && (
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: '.74rem' }}
                            onClick={(e) => { e.stopPropagation(); navigate(`/team/${m.userId}/permissions`) }}
                          >
                            Permissions →
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {editingBookkeeper && (
            <BookkeeperPropertiesEditor
              boxesLive={data?.bookkeeperBoxes === true}
              moreBoxes={data?.bookkeeperMoreBoxes === true}
              member={editingBookkeeper}
              properties={(properties as any[]).filter(p => p.landlordId === editingBookkeeper.landlordId)}
              onClose={() => setEditingBookkeeper(null)}
              onSaved={() => { setEditingBookkeeper(null); qc.invalidateQueries('team') }}
            />
          )}

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
                {' '}haven't linked their bank account yet. Their fees will
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
                      <td>
                        <span className={`badge ${ROLE_BADGE[inv.role] || 'badge-muted'}`}>{LANDLORD_ASSIGNABLE_ROLE_LABEL[inv.role]}</span>
                        {inv.role === 'bookkeeper' && (
                          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 3 }}>
                            {[
                              propertyNames(inv.propertyIds ?? [], properties as any[]) || (inv.companyWide ? null : 'No property ticked'),
                              inv.companyWide ? 'Company-wide (bank, payouts, payroll)' : null,
                              ...extraBoxWords({ companyWide: !!inv.companyWide, companyLedger: !!inv.companyLedger,
                                wholeCompanyReports: !!inv.wholeCompanyReports, seesMonthlyReport: !!inv.seesMonthlyReport }),
                              inv.showLeaseDates ? 'Lease dates shown' : null,
                            ].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </td>
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

// S229: TeamPage invite form. Wraps POST /api/scopes/:roleType/invite —
// the canonical token-based flow that emails the invitee a link.
function InviteForm({ onSent }: { onSent: () => void }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  // W-10 (S529): the property binding is chosen HERE and permanent from then
  // on (re-invite is the move path). W-52 → S576 (B-10): the FULL permission
  // catalog rides the invite (presets + granular toggles) so the person lands
  // with exactly the right access the moment they accept — no second trip.
  const [propertyId, setPropertyId] = useState('')
  const [perms, setPerms] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const { data: properties = [] } = useQuery<any[]>('properties-for-invite', () => apiGet('/properties'))

  const reset = () => {
    setFirstName('')
    setLastName('')
    setEmail('')
    setPhone('')
    setPropertyId('')
    setPerms({})
  }

  const mut = useMutation(
    // No role dropdown: every staff user is created generic and fully defined
    // by their permission toggles. onsite_manager is the internal backing type
    // (has a property-scoped table + is wired through auth/POS) — invisible to
    // the landlord. Property access + permissions are set on the user's
    // dedicated permissions page after they accept; the invite grants nothing.
    () => apiPost(`/scopes/onsite_manager/invite`, {
      email: email.trim(),
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
      phone: phone.trim() || undefined,
      scope: {
        propertyIds: [propertyId], unitIds: [], allProperties: false,
        // Only the ON keys ride the invite (false toggles are just noise).
        permissions: Object.fromEntries(
          Object.entries(perms).filter(([, on]) => on).map(([k]) => [k, true])),
      },
    }),
    {
      onSuccess: () => {
        setError(null)
        setSuccess(`Invitation emailed to ${email.trim()}. They'll land with the permissions you set — adjust anytime on their permissions page.`)
        reset()
        onSent()
        setTimeout(() => setSuccess(null), 5000)
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
    if (!firstName.trim() || !lastName.trim()) {
      setError('First and last name are required')
      return
    }
    if (!email.trim()) {
      setError('Email is required')
      return
    }
    if (!propertyId) {
      setError('Pick the property this person belongs to — it is permanent once they are added')
      return
    }
    mut.mutate()
  }

  const labelStyle = { fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.05em', display: 'block', marginBottom: 4 }
  const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' as const }

  return (
    <div className="card" style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ fontSize: '.95rem', fontWeight: 600, marginBottom: 4 }}>Add a staff member</div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
        Enter their details, pick their property, and set the permissions they start with — they land with exactly that access the moment they accept, so there's no second trip. The property is <strong>permanent</strong> (to move someone later, remove and re-invite them); permissions stay adjustable anytime on their permissions page.
      </div>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>First name</label>
            <input
              type="text"
              required
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              placeholder="Jane"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Last name</label>
            <input
              type="text"
              required
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              placeholder="Doe"
              style={inputStyle}
            />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="name@example.com"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Phone <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="(555) 123-4567"
              style={inputStyle}
            />
          </div>
        </div>

        <div>
          <label style={labelStyle}>Property <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(permanent — re-invite to move someone later)</span></label>
          <select value={propertyId} onChange={e => setPropertyId(e.target.value)} style={inputStyle} required>
            <option value="">Pick their property…</option>
            {(properties as any[]).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div>
          <label style={labelStyle}>Starting Permissions <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional — applied the moment they accept, editable anytime after)</span></label>
          <PermissionCatalogEditor value={perms} onChange={setPerms} disabled={mut.isLoading} />
        </div>

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

// S592 (Nic): landlords invite their OWN bookkeeper here, via the same
// canonical email-link flow (POST /api/scopes/bookkeeper/invite → accept page
// where the bookkeeper sets their OWN password). GAM admins no longer create
// bookkeeper accounts.
//
// 10/11 (Nic): "I need to invite somebody to be a bookkeeper for the Mountain
// View property. They don't need to see anything with Oak Park." A bookkeeper
// keeps ONE company's books, and inside it only the properties ticked here.
// Every property is its own box, even when the company has just one, and a
// property the company adds later arrives unticked. 10/12 (Nic, ledger
// decision 2): "Full bookkeeping … never tenant-account actions … One level,
// no per-bookkeeper switch" — every bookkeeper does the bookkeeping on what is
// ticked for them (bookkeeperAccessSummary says what), so there is no access
// level to pick.
//
// 10/12 (Nic): two more boxes, the owner's choice per bookkeeper —
// "Company-wide: bank account, payouts and payroll" (its own box; ticking every
// property no longer gives it) and "Show lease start and end dates" on their
// rent roll (off unless ticked). A company with no property yet may have a
// company-wide bookkeeper. Only nothing ticked at all is refused.
//
// 10/12 (Nic): three more boxes, all off unless ticked — "May use the
// whole-company ledger" (BK1), "Company reports show the whole company" (BK2)
// and "Sees the monthly property report on screen" (BookkeeperBoxes).
function BookkeeperInviteForm({ boxesLive, moreBoxes, onSent }: { boxesLive: boolean; moreBoxes: boolean; onSent: () => void }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  // S654 (Nic, DIRECTIVE): no default company. A bookkeeper keeps one
  // company's books; an account with several names which.
  const [entityId, setEntityId] = useState('')
  const [propertyIds, setPropertyIds] = useState<string[]>([])
  const [companyWide, setCompanyWide] = useState(false)
  const [showLeaseDates, setShowLeaseDates] = useState(false)
  const [more, setMore] = useState<MoreBoxes>(NO_MORE_BOXES)
  const { data: entities = [] } = useEntities()
  const { data: properties = [], isLoading: propertiesLoading } =
    useQuery<any[]>('properties-for-invite', () => apiGet('/properties'))
  const severalCompanies = entities.length >= 2
  const company = entityId || (entities.length === 1 ? entities[0].id : '')
  const companyProperties = (properties as any[]).filter(p => !company || p.landlordId === company)
  const noProperty = !propertiesLoading && companyProperties.length === 0
  const nothingTicked = !propertyIds.length && !companyWide
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const mut = useMutation(
    () => apiPost('/scopes/bookkeeper/invite', {
      landlordId: entityId || undefined,
      email: email.trim(),
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
      scope: { propertyIds, companyWide, showLeaseDates,
               ...(moreBoxes ? effectiveMoreBoxes(more, { propertyCount: propertyIds.length, companyWide }) : {}) },
    }),
    {
      onSuccess: () => {
        setError(null)
        const sees = [
          propertyIds.length ? `the money for ${propertyNames(propertyIds, companyProperties)}` : null,
          companyWide ? 'the company-wide books' : null,
        ].filter(Boolean).join(' and ')
        setSuccess(`Invitation emailed to ${email.trim()}. They set their own password from the link, then see ${sees}.`)
        setFirstName(''); setLastName(''); setEmail(''); setPropertyIds([]); setCompanyWide(false); setShowLeaseDates(false)
        setMore(NO_MORE_BOXES)
        onSent()
        setTimeout(() => setSuccess(null), 6000)
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
    if (!firstName.trim() || !lastName.trim()) { setError('First and last name are required'); return }
    if (!email.trim()) { setError('Email is required'); return }
    if (severalCompanies && !entityId) { setError('Choose whose books they keep'); return }
    if (nothingTicked) { setError('Tick at least one property or Company-wide.'); return }
    if (!boxesLive) { setError(BOXES_NOT_LIVE); return }
    mut.mutate()
  }

  const labelStyle = { fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.05em', display: 'block', marginBottom: 4 }
  const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' as const }

  return (
    <div className="card" style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ fontSize: '.95rem', fontWeight: 600, marginBottom: 4 }}>Invite a bookkeeper</div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
        {bookkeeperAccessSummary({ propertyCount: propertyIds.length, companyWide, showLeaseDates,
          ...(moreBoxes ? effectiveMoreBoxes(more, { propertyCount: propertyIds.length, companyWide }) : {}) })} They set their own password from the email link, and you can change what they keep or remove them anytime below.
      </div>
      <EntityPicker value={entityId} onChange={id => { setEntityId(id); setPropertyIds([]) }} label="Books of"
        note="They see this company's money and no other company's." />
      <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        {company || !severalCompanies ? (
          <BookkeeperBoxes
            properties={companyProperties} noProperty={noProperty}
            propertyIds={propertyIds} onPropertyIds={setPropertyIds}
            companyWide={companyWide} onCompanyWide={setCompanyWide}
            showLeaseDates={showLeaseDates} onShowLeaseDates={setShowLeaseDates}
            more={moreBoxes ? more : null} onMore={setMore} />
        ) : null}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>First name</label>
            <input type="text" required value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Jane" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Last name</label>
            <input type="text" required value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Doe" style={inputStyle} />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Email</label>
          <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" style={inputStyle} />
        </div>
        {error && (<div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(220,76,76,.08)', border: '1px solid rgba(220,76,76,.25)', color: 'var(--red, #dc4c4c)', fontSize: '.78rem' }}>{error}</div>)}
        {success && (<div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(46,163,90,.08)', border: '1px solid rgba(46,163,90,.25)', color: 'var(--green, #2ea35a)', fontSize: '.78rem' }}>{success}</div>)}
        <div>
          <button type="submit" className="btn btn-primary"
            disabled={mut.isLoading || !email.trim() || (severalCompanies && !entityId) || nothingTicked}>
            {mut.isLoading ? 'Sending…' : 'Send invitation'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * 10/11 (Nic): which of a company's properties a bookkeeper keeps. Every
 * property is its own box; nothing is ticked for them by default, and "Tick
 * all" ticks every property the company owns today (one it adds later still
 * starts unticked).
 */
function PropertyChecklist({ properties, value, onChange }: {
  properties: any[]; value: string[]; onChange: (ids: string[]) => void
}) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id])
  const allTicked = properties.length > 0 && properties.every(p => value.includes(p.id))
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Properties <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(tick each one they keep)</span>
        </div>
        {properties.length > 1 && (
          <button type="button"
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--gold)', fontSize: '.72rem', cursor: 'pointer', textDecoration: 'underline' }}
            onClick={() => onChange(allTicked ? [] : properties.map(p => p.id))}>
            {allTicked ? 'Untick all' : 'Tick all'}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
        {properties.map(p => (
          <label key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '.84rem', color: 'var(--text-1)', cursor: 'pointer' }}>
            <input type="checkbox" checked={value.includes(p.id)} onChange={() => toggle(p.id)} />
            {p.name}
          </label>
        ))}
      </div>
    </div>
  )
}

/**
 * 10/12 (Nic): the three boxes added on 10/12 evening, all off unless ticked.
 *   companyLedger        "May use the whole-company ledger" (BK1) — offered
 *                        only without Company-wide, which already holds it
 *   wholeCompanyReports  "Company reports show the whole company" (BK2) —
 *                        offered when they open company reports (Company-wide
 *                        or the ledger)
 *   seesMonthlyReport    "Sees the monthly property report on screen" —
 *                        offered when a property is ticked
 */
interface MoreBoxes { companyLedger: boolean; wholeCompanyReports: boolean; seesMonthlyReport: boolean }
const NO_MORE_BOXES: MoreBoxes = { companyLedger: false, wholeCompanyReports: false, seesMonthlyReport: false }

/**
 * What is saved: a box only where it is offered, so a box hidden by another
 * choice (the ledger under Company-wide, the monthly report with no property
 * ticked) never stays on unseen.
 */
function effectiveMoreBoxes(m: MoreBoxes, at: { propertyCount: number; companyWide: boolean }): MoreBoxes {
  const companyLedger = !at.companyWide && at.propertyCount > 0 && m.companyLedger
  return {
    companyLedger,
    wholeCompanyReports: (at.companyWide || companyLedger) && m.wholeCompanyReports,
    seesMonthlyReport: at.propertyCount > 0 && m.seesMonthlyReport,
  }
}

/** 10/12 (Nic): the ledger, whole-company reports and monthly report boxes, in words, for a row. */
function extraBoxWords(b: { companyWide: boolean } & Partial<MoreBoxes>): string[] {
  return [
    b.companyLedger && !b.companyWide ? 'Whole-company ledger' : null,
    b.wholeCompanyReports ? 'Company reports: whole company' : null,
    b.seesMonthlyReport ? 'Monthly report on screen' : null,
  ].filter(Boolean) as string[]
}

/**
 * 10/12 (Nic): every box a bookkeeper has, on the invite and the edit alike —
 * the property boxes, "Company-wide: bank account, payouts and payroll", and
 * "Show lease start and end dates". A company with no property yet shows only
 * the company-wide box (it may have a company-wide bookkeeper). With `more`
 * (an API that reads them), the three 10/12-evening boxes too.
 */
function BookkeeperBoxes({ properties, noProperty, propertyIds, onPropertyIds, companyWide, onCompanyWide, showLeaseDates, onShowLeaseDates, more, onMore }: {
  properties: any[]; noProperty: boolean
  propertyIds: string[]; onPropertyIds: (ids: string[]) => void
  companyWide: boolean; onCompanyWide: (on: boolean) => void
  showLeaseDates: boolean; onShowLeaseDates: (on: boolean) => void
  more: MoreBoxes | null; onMore: (m: MoreBoxes) => void
}) {
  const box = { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '.84rem', color: 'var(--text-1)', cursor: 'pointer', lineHeight: 1.4 } as const
  const hint = { display: 'block', fontSize: '.72rem', color: 'var(--text-3)' } as const
  const ticked = propertyIds.length > 0
  const offersLedger = !!more && !companyWide && ticked
  const offersWholeReports = !!more && (companyWide || (offersLedger && more.companyLedger))
  const offersMonthly = !!more && ticked
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {noProperty
        ? <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>This company has no property yet. Tick Company-wide to give them its company-wide books.</div>
        : <PropertyChecklist properties={properties} value={propertyIds} onChange={onPropertyIds} />}
      <label style={box}>
        <input type="checkbox" checked={companyWide} onChange={e => onCompanyWide(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          Company-wide: bank account, payouts and payroll
          <span style={hint}>Also the company's whole Books ledger, P&amp;L, cash flow and owner statements. Leave it off and they see only the properties ticked above.</span>
        </span>
      </label>
      {offersLedger && (
        <label style={box}>
          <input type="checkbox" checked={more!.companyLedger} onChange={e => onMore({ ...more!, companyLedger: e.target.checked })} style={{ marginTop: 2 }} />
          <span>
            May use the whole-company ledger
            <span style={hint}>The company's Books ledger: chart of accounts, journal, bills, vendors, payroll, tax, P&amp;L and balance sheet. Never the bank account or payouts.</span>
          </span>
        </label>
      )}
      {offersWholeReports && (
        <label style={box}>
          <input type="checkbox" checked={more!.wholeCompanyReports} onChange={e => onMore({ ...more!, wholeCompanyReports: e.target.checked })} style={{ marginTop: 2 }} />
          <span>
            Company reports show the whole company
            <span style={hint}>Their company P&amp;L{companyWide ? ', cash flow and owner statements carry' : ' carries'} every property's money. Leave it off and only the ticked properties' money is in them.</span>
          </span>
        </label>
      )}
      {!noProperty && (
        <label style={box}>
          <input type="checkbox" checked={showLeaseDates} onChange={e => onShowLeaseDates(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            Show lease start and end dates
            <span style={hint}>On their rent roll. The dates only, never the lease itself or its documents.</span>
          </span>
        </label>
      )}
      {offersMonthly && (
        <label style={box}>
          <input type="checkbox" checked={more!.seesMonthlyReport} onChange={e => onMore({ ...more!, seesMonthlyReport: e.target.checked })} style={{ marginTop: 2 }} />
          <span>
            Sees the monthly property report on screen
            <span style={hint}>On their Reports page, for the ticked properties only.</span>
          </span>
        </label>
      )}
    </div>
  )
}

/** 10/11: property ids in words, by name. */
function propertyNames(ids: string[], properties: any[]): string {
  return ids.map(id => properties.find(p => p.id === id)?.name).filter(Boolean).join(', ')
}

/** 10/12: '2026-09-30' → 'Sep 30, 2026' (a calendar day, no time-zone shift). */
function dayWords(ymd: string): string {
  const d = new Date(String(ymd).slice(0, 10) + 'T12:00:00')
  return isNaN(d.getTime()) ? ymd : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface BookkeeperRowScope {
  propertyIds?: string[] | null
  coversCompany?: boolean
  companyWide?: boolean
  showLeaseDates?: boolean
  // 10/12 (Nic): the ledger, whole-company reports and monthly report boxes.
  companyLedger?: boolean
  wholeCompanyReports?: boolean
  seesMonthlyReport?: boolean
  /** 10/12 (Nic, L19): what they may file of the money coming in. */
  moneyInFiling?: BookkeeperMoneyInFiling
  formerProperties?: Array<{ propertyId: string; name: string; lastDay: string }>
}

/**
 * 10/11: the properties a bookkeeper keeps, in words, for their row. "Every
 * property" only while they have ticked every property the company owns today
 * (the server works that out: scope.coversCompany); otherwise the ticked ones,
 * and the company's properties they do not keep, so a park bought since shows
 * up here as not ticked. 10/12: the company-wide and lease-dates boxes, and a
 * sold property whose history they keep up to the day it left.
 */
function bookkeeperPropertiesText(m: Member, properties: any[]): string {
  const scope = (m.scope ?? {}) as BookkeeperRowScope
  const ids = scope.propertyIds ?? []
  const company = properties.filter(p => p.landlordId === m.landlordId)
  let props: string | null
  if (scope.coversCompany) props = 'Every property'
  else if (!ids.length) props = scope.companyWide ? null : 'No property ticked'
  else {
    const kept = propertyNames(ids, company) || `${ids.length} propert${ids.length === 1 ? 'y' : 'ies'}`
    const notKept = company.filter(p => !ids.includes(p.id)).map(p => p.name).join(', ')
    props = notKept ? `${kept} · Not ticked: ${notKept}` : kept
  }
  return [
    props,
    scope.companyWide ? 'Company-wide (bank, payouts, payroll)' : null,
    // 10/12 (Nic) review: the boxes as they work today — the ledger and the
    // whole-company reports end with the last property they kept (the server's
    // rule, lib/bookkeeperScope), so a row never says "Whole-company ledger"
    // for a bookkeeper who keeps only a sold property's history.
    ...extraBoxWords({ companyWide: !!scope.companyWide, ...effectiveMoreBoxes(
      { companyLedger: !!scope.companyLedger, wholeCompanyReports: !!scope.wholeCompanyReports, seesMonthlyReport: !!scope.seesMonthlyReport },
      { propertyCount: ids.length, companyWide: !!scope.companyWide }) }),
    scope.showLeaseDates ? 'Lease dates shown' : null,
    // 10/12 (Nic, L19): money coming in, when it is not the default.
    scope.companyWide && scope.moneyInFiling && scope.moneyInFiling !== DEFAULT_BOOKKEEPER_MONEY_IN_FILING
      ? `Money in: ${BOOKKEEPER_MONEY_IN_FILING_LABEL[scope.moneyInFiling].toLowerCase()}` : null,
    ...(scope.formerProperties ?? []).map(f => `Sold: ${f.name} (history through ${dayWords(f.lastDay)})`),
  ].filter(Boolean).join(' · ')
}

/** 10/11: change which of the company's properties a bookkeeper keeps. 10/12: and their other boxes. */
function BookkeeperPropertiesEditor({ boxesLive, moreBoxes, member, properties, onClose, onSaved }: {
  boxesLive: boolean; moreBoxes: boolean; member: Member; properties: any[]; onClose: () => void; onSaved: () => void
}) {
  const scope = (member.scope ?? {}) as BookkeeperRowScope
  const [ids, setIds] = useState<string[]>((scope.propertyIds ?? []) as string[])
  const [companyWide, setCompanyWide] = useState(!!scope.companyWide)
  const [showLeaseDates, setShowLeaseDates] = useState(!!scope.showLeaseDates)
  // 10/12 (Nic): the ledger, whole-company reports and monthly report boxes.
  const [more, setMore] = useState<MoreBoxes>({
    companyLedger: !!scope.companyLedger, wholeCompanyReports: !!scope.wholeCompanyReports, seesMonthlyReport: !!scope.seesMonthlyReport,
  })
  const extra = moreBoxes ? effectiveMoreBoxes(more, { propertyCount: ids.length, companyWide }) : {}
  // 10/12 (Nic, L19): "bookkeepers filing money coming in → landlord's choice
  // per bookkeeper". Sent only when changed (the owner's alone; the server
  // refuses anyone else).
  const startMoneyIn = scope.moneyInFiling ?? DEFAULT_BOOKKEEPER_MONEY_IN_FILING
  const [moneyIn, setMoneyIn] = useState<BookkeeperMoneyInFiling>(startMoneyIn)
  const [error, setError] = useState<string | null>(null)
  const nothingTicked = !ids.length && !companyWide
  const save = useMutation(
    () => apiPatch(`/scopes/bookkeeper/${member.userId}`, {
      landlordId: member.landlordId, propertyIds: ids, companyWide, showLeaseDates, ...extra,
      ...(scope.moneyInFiling !== undefined && moneyIn !== startMoneyIn ? { moneyInFiling: moneyIn } : {}),
    }),
    { onSuccess: () => { toast('Their access is updated. It takes effect on their next click.'); onSaved() },
      onError: (e: any) => setError(e?.response?.data?.error || e?.message || 'Could not save.') },
  )
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">What {member.firstName} {member.lastName} keeps</div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', margin: '6px 0 14px', lineHeight: 1.5 }}>
          {bookkeeperAccessSummary({ propertyCount: ids.length, companyWide, showLeaseDates, ...extra })}
        </div>
        <BookkeeperBoxes
          properties={properties} noProperty={properties.length === 0}
          propertyIds={ids} onPropertyIds={setIds}
          companyWide={companyWide} onCompanyWide={setCompanyWide}
          showLeaseDates={showLeaseDates} onShowLeaseDates={setShowLeaseDates}
          more={moreBoxes ? more : null} onMore={setMore} />
        {scope.moneyInFiling !== undefined && companyWide && (
          <label style={{ display: 'grid', gap: 4, fontSize: '.84rem', color: 'var(--text-1)', marginTop: 12 }}>
            Money coming in on the bank feed
            <select className="form-input" value={moneyIn} onChange={e => setMoneyIn(e.target.value as BookkeeperMoneyInFiling)}>
              {BOOKKEEPER_MONEY_IN_FILING.map(v => <option key={v} value={v}>{BOOKKEEPER_MONEY_IN_FILING_LABEL[v]}</option>)}
            </select>
            <span style={{ fontSize: '.72rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
              A deposit they file leaves the rent queue, so a tenant's rent filed as other income stays owed on the tenant's account. "Not rent" is yours to mark. Money going out is always theirs to file.
            </span>
          </label>
        )}
        {(scope.formerProperties ?? []).length > 0 && (
          <div style={{ color: 'var(--text-3)', fontSize: '.76rem', marginTop: 10, lineHeight: 1.5 }}>
            They also keep, read only, the history of {(scope.formerProperties ?? []).map(f => `${f.name} through ${dayWords(f.lastDay)}`).join(', ')}: the days it was this company's, and nothing after.
          </div>
        )}
        {nothingTicked && <div style={{ color: 'var(--text-3)', fontSize: '.78rem', marginTop: 10 }}>Tick at least one property or Company-wide.</div>}
        {!boxesLive && <div style={{ color: 'var(--text-3)', fontSize: '.78rem', marginTop: 10 }}>{BOXES_NOT_LIVE}</div>}
        {error && <div style={{ color: 'var(--red)', fontSize: '.78rem', marginTop: 10 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isLoading || nothingTicked || !boxesLive} onClick={() => save.mutate()}>
            {save.isLoading ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
