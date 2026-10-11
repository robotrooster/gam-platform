import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch, apiPost, apiDel } from '../lib/api'
import {
  LANDLORD_ASSIGNABLE_ROLE_LABEL,
  LandlordAssignableRole,
  BOOKKEEPER_ACCESS_SUMMARY,
} from '@gam/shared'
import { PermissionCatalogEditor } from '../components/PermissionCatalogEditor'
import { EntityPicker, useEntities } from '../components/EntityPicker'
import { appConfirm, toast } from '../components/dialogs'

// S526: the old expandable-row permission grid (SUB_PERMISSIONS_BY_ROLE
// checkboxes + inline ScopePicker) is RETIRED — the dedicated per-user page at
// /team/:userId/permissions is the one permissions surface (catalog toggles +
// property scope + direct deposit all live there). This page is now just the
// roster: invite form, member list, pending invitations. Bookkeepers keep
// their inline access-level select (they have no catalog permissions).

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
  const navigate = useNavigate()
  const { data, isLoading } = useQuery<TeamPayload>('team', () => apiGet('/scopes/team'))
  // 10/11: a bookkeeper's row names the properties they keep.
  const { data: properties = [] } = useQuery<any[]>('properties-for-invite', () => apiGet('/properties'))
  const [editingBookkeeper, setEditingBookkeeper] = useState<Member | null>(null)

  const removeBookkeeper = useMutation(
    (m: Member) => apiDel(`/scopes/bookkeeper/${m.userId}`),
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
          set their own password). Distinct from staff — no property, no
          permission catalog, just an access level. */}
      <BookkeeperInviteForm onSent={() => qc.invalidateQueries('team')} />

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
                      key={m.userId}
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
                              Change properties
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
// keeps ONE company's books — and, when that company has several properties,
// only the ones ticked here (none ticked = all of them). Their access is fixed:
// look, and add expenses ("Look + add expenses" — Nic's choice), so there is
// no access level to pick.
function BookkeeperInviteForm({ onSent }: { onSent: () => void }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  // S654 (Nic, DIRECTIVE): no default company. A bookkeeper keeps one
  // company's books; an account with several names which.
  const [entityId, setEntityId] = useState('')
  const [propertyIds, setPropertyIds] = useState<string[]>([])
  const { data: entities = [] } = useEntities()
  const { data: properties = [] } = useQuery<any[]>('properties-for-invite', () => apiGet('/properties'))
  const severalCompanies = entities.length >= 2
  const company = entityId || (entities.length === 1 ? entities[0].id : '')
  const companyProperties = (properties as any[]).filter(p => !company || p.landlordId === company)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const mut = useMutation(
    () => apiPost('/scopes/bookkeeper/invite', {
      landlordId: entityId || undefined,
      email: email.trim(),
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
      scope: { propertyIds: propertyIds.length ? propertyIds : null },
    }),
    {
      onSuccess: () => {
        setError(null)
        const where = propertyIds.length
          ? companyProperties.filter(p => propertyIds.includes(p.id)).map(p => p.name).join(', ')
          : 'every property of the company'
        setSuccess(`Invitation emailed to ${email.trim()}. They set their own password from the link, then see the money for ${where}.`)
        setFirstName(''); setLastName(''); setEmail(''); setPropertyIds([])
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
    mut.mutate()
  }

  const labelStyle = { fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.05em', display: 'block', marginBottom: 4 }
  const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' as const }

  return (
    <div className="card" style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ fontSize: '.95rem', fontWeight: 600, marginBottom: 4 }}>Invite a bookkeeper</div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
        {BOOKKEEPER_ACCESS_SUMMARY} They set their own password from the email link, and you can change their properties or remove them anytime below.
      </div>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <EntityPicker value={entityId} onChange={id => { setEntityId(id); setPropertyIds([]) }} label="Books of"
          note="They see this company's money and no other company's." />
        {company && companyProperties.length > 1 && (
          <PropertyChecklist properties={companyProperties} value={propertyIds} onChange={setPropertyIds} />
        )}
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
          <button type="submit" className="btn btn-primary" disabled={mut.isLoading || !email.trim() || (severalCompanies && !entityId)}>
            {mut.isLoading ? 'Sending…' : 'Send invitation'}
          </button>
        </div>
      </form>
    </div>
  )
}

/** 10/11: which of a company's properties a bookkeeper keeps. None ticked = all of them. */
function PropertyChecklist({ properties, value, onChange }: {
  properties: any[]; value: string[]; onChange: (ids: string[]) => void
}) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id])
  return (
    <div>
      <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
        Properties <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(none ticked = every property of the company)</span>
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

/** 10/11: the properties a bookkeeper keeps, in words, for their row. */
function bookkeeperPropertiesText(m: Member, properties: any[]): string {
  const ids: string[] | null = (m.scope as any)?.propertyIds ?? null
  if (!ids || !ids.length) return 'Every property of the company'
  const names = ids.map(id => properties.find(p => p.id === id)?.name).filter(Boolean)
  return names.length ? names.join(', ') : `${ids.length} propert${ids.length === 1 ? 'y' : 'ies'}`
}

/** 10/11: change which of the company's properties a bookkeeper keeps. */
function BookkeeperPropertiesEditor({ member, properties, onClose, onSaved }: {
  member: Member; properties: any[]; onClose: () => void; onSaved: () => void
}) {
  const [ids, setIds] = useState<string[]>(((member.scope as any)?.propertyIds ?? []) as string[])
  const [error, setError] = useState<string | null>(null)
  const save = useMutation(
    () => apiPatch(`/scopes/bookkeeper/${member.userId}`, { landlordId: member.landlordId, propertyIds: ids.length ? ids : null }),
    { onSuccess: () => { toast('Their properties are updated. It takes effect on their next click.'); onSaved() },
      onError: (e: any) => setError(e?.response?.data?.error || e?.message || 'Could not save.') },
  )
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Properties {member.firstName} {member.lastName} keeps</div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', margin: '6px 0 14px', lineHeight: 1.5 }}>{BOOKKEEPER_ACCESS_SUMMARY}</div>
        {properties.length > 1
          ? <PropertyChecklist properties={properties} value={ids} onChange={setIds} />
          : <div style={{ fontSize: '.84rem', color: 'var(--text-2)' }}>This company has one property, and they keep it.</div>}
        {error && <div style={{ color: 'var(--red)', fontSize: '.78rem', marginTop: 10 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isLoading || properties.length < 2} onClick={() => save.mutate()}>
            {save.isLoading ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
