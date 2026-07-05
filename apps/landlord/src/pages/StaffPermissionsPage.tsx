import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'
import {
  PERMISSION_CATALOG,
  PERMISSION_PRESETS,
  LandlordAssignableRole,
  MAINTENANCE_JOB_CATEGORIES,
  MAINTENANCE_JOB_CATEGORY_LABEL,
  MaintenanceJobCategory,
} from '@gam/shared'

// Dedicated per-user permissions page — THE one surface for configuring a
// staff member (S526: the old Team-row expandable grid is retired). The
// landlord composes exactly what a staff member can see + do here:
//   1. Property scope (hard lock; which properties they may act on)
//   2. Direct deposit (property_manager only)
//   3. Permission toggles from PERMISSION_CATALOG (single source of truth)
// Each toggle flip full-replaces the user's permissions jsonb via the scopes
// endpoint; scope saves via the full-scope PATCH.

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
  permissions: Record<string, any>
  scope: any
  directDepositEnabled?: boolean
  connectChargesEnabled?: boolean
  connectPayoutsEnabled?: boolean
  connectDetailsSubmitted?: boolean
}

export function StaffPermissionsPage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<{ members: Member[] }>('team', () => apiGet('/scopes/team'))
  const member = data?.members.find(m => m.userId === userId)

  const [perms, setPerms] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (member) setPerms(Object.fromEntries(Object.entries(member.permissions || {}).map(([k, v]) => [k, v === true])))
  }, [member?.userId])

  const save = useMutation(
    (next: Record<string, boolean>) =>
      apiPatch(`/scopes/${member!.role}/${member!.userId}/permissions`, { permissions: next }),
    { onSuccess: () => qc.invalidateQueries('team') }
  )

  // S168: per-manager direct-deposit toggle (moved from the Team row). Enabling
  // fires a notification+email to the manager prompting them to onboard via
  // the Stripe Connect surface in their portal Banking page.
  const toggleDirectDeposit = useMutation(
    (args: { userId: string; enabled: boolean }) =>
      apiPatch(`/scopes/property_manager/${args.userId}/direct-deposit`, { enabled: args.enabled }),
    { onSuccess: () => qc.invalidateQueries('team') }
  )

  const toggle = (key: string) => {
    const next = { ...perms, [key]: !perms[key] }
    setPerms(next)
    save.mutate(next)
  }

  const setGroup = (keys: string[], on: boolean) => {
    const next = { ...perms }
    keys.forEach(k => { next[k] = on })
    setPerms(next)
    save.mutate(next)
  }

  if (isLoading) return <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
  if (!member) return (
    <div className="card" style={{ padding: 32, textAlign: 'center' }}>
      <div style={{ color: 'var(--text-2)', marginBottom: 12 }}>Staff member not found, or their invite hasn't been accepted yet.</div>
      <button className="btn btn-ghost" onClick={() => navigate('/team')}>← Back to Team</button>
    </div>
  )

  const enabledCount = Object.values(perms).filter(Boolean).length

  return (
    <div>
      <div className="page-header">
        <div>
          <button onClick={() => navigate('/team')} className="btn btn-ghost btn-sm" style={{ marginBottom: 8 }}>← Team</button>
          <h1 className="page-title">{member.firstName} {member.lastName}</h1>
          <p className="page-subtitle">{member.email} · {enabledCount} permission{enabledCount === 1 ? '' : 's'} granted</p>
        </div>
      </div>

      <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 16, lineHeight: 1.5, maxWidth: 720 }}>
        Turn on exactly what this person can see and do. Everything is off by default —
        they only get what you grant. Changes save instantly.
      </div>

      {/* Property scope — which properties this person may act on. A property-
          locked member only sees/acts on data at these properties (POS,
          Master Schedule, Reservations, Outstanding Balances…). */}
      {member.role !== 'bookkeeper' && (
        <ScopePicker member={member} onSaved={() => qc.invalidateQueries('team')} />
      )}

      {member.role === 'property_manager' && (
        <DirectDepositToggle
          member={member}
          onChange={(enabled) => {
            if (enabled && !confirm(
              `Enable direct deposit for ${member.firstName} ${member.lastName}? ` +
              `They'll get an email + in-app notification to link their ` +
              `bank account before manager fees can be paid out.`
            )) return
            toggleDirectDeposit.mutate({ userId: member.userId, enabled })
          }}
          pending={toggleDirectDeposit.isLoading}
        />
      )}

      {/* Presets — one-click bundles that flip a set of toggles ON. Not roles;
          the owner can fine-tune every toggle afterward. */}
      <div className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>
          Quick presets
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {PERMISSION_PRESETS.map(preset => (
            <button
              key={preset.id}
              className="btn btn-ghost btn-sm"
              disabled={save.isLoading}
              title={preset.description}
              onClick={() => setGroup(preset.keys, true)}
              style={{ textAlign: 'left', border: '1px solid var(--border-1)', borderRadius: 8, padding: '8px 12px', maxWidth: 320 }}
            >
              <div style={{ fontWeight: 600, fontSize: '.85rem', color: 'var(--gold)' }}>+ {preset.label}</div>
              <div style={{ fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.4, whiteSpace: 'normal' }}>{preset.description}</div>
            </button>
          ))}
        </div>
      </div>

      {PERMISSION_CATALOG.map(group => {
        const groupKeys = group.sections.flatMap(s => s.items.map(i => i.key))
        const allOn = groupKeys.every(k => perms[k])
        return (
          <div key={group.category} className="card" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border-1)' }}>
              <div style={{ fontWeight: 700, fontSize: '.95rem' }}>{group.label}</div>
              <button
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '.74rem' }}
                onClick={() => setGroup(groupKeys, !allOn)}
                disabled={save.isLoading}
              >
                {allOn ? 'Turn all off' : 'Turn all on'}
              </button>
            </div>
            <div style={{ padding: 16 }}>
              {group.sections.map(section => (
                <div key={section.label} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: '.7rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
                    {section.label}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6 }}>
                    {section.items.map(item => (
                      <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.83rem', color: 'var(--text-1)', cursor: 'pointer', padding: '4px 0' }}>
                        <input
                          type="checkbox"
                          checked={!!perms[item.key]}
                          onChange={() => toggle(item.key)}
                          disabled={save.isLoading}
                        />
                        <span>{item.label}</span>
                        {item.sensitive && (
                          <span style={{ fontSize: '.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gold)', background: 'rgba(201,162,39,.12)', border: '1px solid rgba(201,162,39,.3)', borderRadius: 4, padding: '1px 5px' }}>sensitive</span>
                        )}
                        {item.hint && <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>— {item.hint}</span>}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {save.isError && <div style={{ fontSize: '.8rem', color: 'var(--red, #ef4444)' }}>Failed to save — try again.</div>}
    </div>
  )
}

// S230 (moved here S526): per-property scope picker. Wraps the existing PATCH
// /api/scopes/:roleType/:userId endpoint (full-scope replace) — distinct from
// the /permissions partial endpoint used by the toggles above. Reads
// /properties + /units and lets the landlord toggle allProperties OR pick
// specific properties + per-property unit subsets. Maintenance gets the
// job-categories chip selector; PM gets the approval-ceiling input.
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

  // W-10 (S529, Nic decision): a staff member's property binding is PERMANENT
  // once set — chosen at invite, never edited here. Re-invite is the move
  // path. The server enforces this too (409 on change); this page just shows
  // the lock. Legacy rows with no property yet get one first-set.
  const propertyLocked = role === 'onsite_manager' && ((initial.propertyIds?.length ?? 0) > 0 || !!initial.allProperties)

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
    <form onSubmit={submit} className="card" style={{ padding: 14, marginBottom: 16 }}>
      <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
        Property scope
      </div>
      <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
        Hard lock: they can only see and act on the properties selected here.
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.82rem', cursor: 'pointer', marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={allProperties}
          disabled={propertyLocked}
          onChange={e => setAllProperties(e.target.checked)}
          style={{ width: 16, height: 16, cursor: propertyLocked ? 'not-allowed' : 'pointer' }}
        />
        <span><strong>All current and future properties</strong></span>
        <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>(overrides per-property selection)</span>
      </label>
      {propertyLocked && (
        <div style={{ fontSize: '.74rem', color: 'var(--amber)', background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.25)', borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
          Property assignment is permanent — it was fixed when this person was added. To move them to another property, remove them and re-invite them there.
        </div>
      )}

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
                        disabled={propertyLocked}
                        onChange={() => togglePropertyId(p.id)}
                        style={{ width: 15, height: 15, cursor: propertyLocked ? 'not-allowed' : 'pointer' }}
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

// S168 (moved here S526): per-manager direct-deposit opt-in. Renders the
// toggle plus the manager's live Stripe Connect readiness so the landlord can
// see who's opted in but hasn't onboarded yet.
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
    : ready                              ? { tone: 'green', text: 'Bank ready' }
    : member.connectDetailsSubmitted   ? { tone: 'gold',  text: 'Verifying' }
    :                                      { tone: 'gold',  text: 'Awaiting bank setup' }
  const showReqsButton = enabled && !ready

  return (
    <div className="card" style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px',
      marginBottom: 16, flexWrap: 'wrap',
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
        Pays out manager fees to their linked bank account once enabled and set up.
      </div>
      {showReqs && (
        <ConnectRequirementsModal userId={member.userId} memberName={`${member.firstName} ${member.lastName}`} onClose={() => setShowReqs(false)} />
      )}
    </div>
  )
}

// S168 follow-on (moved here S526): drill into a manager's outstanding Stripe
// Connect KYC requirements. Backend proxies stripe.accounts.retrieve so the
// data is always fresh; displays currently_due, past_due, and any
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
        <div className="modal-title" style={{ marginBottom: 6 }}>Bank Account Verification</div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 14 }}>
          {memberName} — items required to finish verifying their bank account.
          Forward these to them so they can complete setup.
        </div>
        {isLoading && <div style={{ color: 'var(--text-3)', padding: 16 }}>Loading…</div>}
        {error != null && (
          <div style={{ color: 'var(--red, #dc4c4c)', fontSize: '.82rem', padding: 12, background: 'rgba(255,71,87,.08)', borderRadius: 8 }}>
            Couldn't fetch verification status right now.
          </div>
        )}
        {data && !data.exists && (
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', padding: 12 }}>
            This manager hasn't started bank account setup yet. Their account will be
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
                No outstanding requirements. Verification is in progress —
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
