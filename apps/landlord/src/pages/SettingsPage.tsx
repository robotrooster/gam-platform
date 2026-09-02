import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { api, apiGet, apiPatch } from '../lib/api'
import { EntityPicker } from '../components/EntityPicker'
import { Check, DollarSign, X } from 'lucide-react'
import { LAUNCH_HIDDEN } from '../components/layout/Layout'
import { useAuth } from '../context/AuthContext'
import { ChangeSignInEmail } from '../components/ChangeSignInEmail'
import { usePerms } from '../lib/permissions'
import { NotificationPrefsSection } from './NotificationPrefsPage'

interface LinkedPmCompany {
  id: string
  name: string
  businessEmail: string | null
  status: string
  propertyCount: number
}

const fmt = (n: any) => n != null
  ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '—'

// S620 (Nic): "if I wanted to add another property that I am purchasing under
// another entity, how would I do that? There's nowhere for that to happen."
//
// Same land owner, different LLCs is how property is actually held. Until now
// an entity could only be created by registering a whole new account, and the
// active entity was inferred rather than chosen — which has no answer once a
// person owns two. This is where the choice gets made.
function EntitiesSection() {
  const qc = useQueryClient()
  const { data: entities = [], isLoading } = useQuery<any[]>(
    'landlord-entities', () => apiGet('/landlords/me/entities'))
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [ein, setEin] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [openEntity, setOpenEntity] = useState<string | null>(null)

  const fail = (e: any) =>
    setErr(e?.response?.data?.error?.message || e?.response?.data?.error || 'Something went wrong.')

  const createMut = useMutation(
    () => api.post('/landlords/me/entities', { businessName: name.trim(), ein: ein.trim() || undefined }).then(r => r.data),
    {
      onSuccess: () => {
        qc.invalidateQueries('landlord-entities')
        setAdding(false); setName(''); setEin(''); setErr(null)
        setNotice('Entity created. Choose it when you add a property.')
      },
      onError: fail,
    })

  if (isLoading) return null

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>Your entities</div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 12 }}>
        Each entity keeps its own properties, payouts and books — separate LLCs stay separate.
        Your dashboard shows all of them together; choose the entity when you add a property.
      </div>

      {/* S631 (Nic): "I see my different entities, and then I see owners, but I
          don't see anything linking that window to a specific entity. It just
          says add owner, and I don't know where it would be getting added at."
          He was right — the standalone Owners card always acted on whichever
          entity the session happened to be signed into, with nothing on screen
          saying which that was. Owners belong to an entity, so they live inside
          the entity. */}
      {entities.map((e: any) => (
        <EntityRow key={e.id} entity={e} expanded={openEntity === e.id}
          onToggle={() => setOpenEntity(openEntity === e.id ? null : e.id)} />
      ))}

      {notice && (
        <div style={{ fontSize: '.75rem', color: 'var(--gold)', marginTop: 10 }}>{notice}</div>
      )}
      {err && <div style={{ fontSize: '.75rem', color: 'var(--red)', marginTop: 10 }}>{err}</div>}

      {adding ? (
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          <input className="input" placeholder="Entity name (e.g. Haws Homes LLC)"
            value={name} onChange={e => setName(e.target.value)} />
          <input className="input" placeholder="EIN (optional)"
            value={ein} onChange={e => setEin(e.target.value)} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" style={{ fontSize: '.78rem' }}
              disabled={!name.trim() || createMut.isLoading}
              onClick={() => createMut.mutate()}>
              {createMut.isLoading ? 'Creating…' : 'Create entity'}
            </button>
            <button className="btn btn-ghost" style={{ fontSize: '.78rem' }}
              onClick={() => { setAdding(false); setErr(null) }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn btn-primary" style={{ marginTop: 12, fontSize: '.78rem' }}
          onClick={() => { setAdding(true); setNotice(null) }}>Add another entity</button>
      )}
    </div>
  )
}

// S553: owner-members of ONE landlord entity (multi-owner LLCs — Oak Park).
// Any owner can add a co-owner by email; the founding owner can't be removed.
// Memberships take effect at the co-owner's next sign-in.
//
// S631 (Nic): now always rendered for an explicit entity, and always passing
// that entity's id. The endpoints have taken `landlordId` since S553 — the old
// card never sent it, so every add silently landed on the session's active
// entity. With one entity that is invisible; with three it is a co-owner
// appearing on the wrong LLC.
function OwnersSection({ landlordId, entityName }: { landlordId: string; entityName: string }) {
  const qc = useQueryClient()
  const { data: members = [], isLoading } = useQuery<any[]>(
    ['landlord-members', landlordId],
    () => apiGet(`/landlords/members?landlordId=${landlordId}`))
  const [email, setEmail] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const addMut = useMutation(
    () => api.post('/landlords/members', { email: email.trim(), landlordId }).then(r => r.data), {
    onSuccess: () => { qc.invalidateQueries(['landlord-members', landlordId]); setEmail(''); setErr(null) },
    onError: (e: any) => setErr(e?.response?.data?.error?.message || e?.response?.data?.error || 'Could not add owner.'),
  })
  const rmMut = useMutation((id: string) => api.delete(`/landlords/members/${id}`).then(r => r.data), {
    onSuccess: () => qc.invalidateQueries(['landlord-members', landlordId]),
  })
  if (isLoading) return null
  return (
    <div style={{ padding: '4px 0 10px' }}>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 10 }}>
        Owners of <strong style={{ color: 'var(--text-1)' }}>{entityName}</strong>. They see this
        entity&apos;s properties alongside their own portfolio. If they have no GAM account yet we email
        them an invite; changes apply the next time they sign in.
      </div>
      {members.map((m: any) => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-1, rgba(255,255,255,.06))' }}>
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-0)', fontWeight: 600 }}>
              {[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email}
              {m.isFounding && <span style={{ marginLeft: 8, fontSize: '.62rem', color: 'var(--gold)', fontWeight: 700 }}>FOUNDING</span>}
            </div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{m.email}</div>
          </div>
          {!m.isFounding && (
            <button className="btn btn-ghost btn-sm" onClick={() => rmMut.mutate(m.id)} disabled={rmMut.isLoading}>
              <X size={12} /> Remove
            </button>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="co-owner@email.com"
          style={{ flex: 1, background: 'var(--surface-1, rgba(255,255,255,.04))', border: '1px solid var(--border-1, rgba(255,255,255,.1))', borderRadius: 8, padding: '8px 10px', color: 'var(--text-0)', fontSize: '.8rem' }}
        />
        <button className="btn btn-primary btn-sm" disabled={!email.trim() || addMut.isLoading} onClick={() => addMut.mutate()}>
          Add owner
        </button>
      </div>
      {err && <div style={{ fontSize: '.72rem', color: '#ef4444', marginTop: 8 }}>{err}</div>}
    </div>
  )
}

export function SettingsPage() {
  const qc = useQueryClient()

  // ── S633: WHICH COMPANY ARE THESE SETTINGS FOR? ────────────────────────────
  //
  // Nic (DIRECTIVE): "Account ownership is no correlation to a specific entity.
  // Entities own properties. The account owns the entities."
  //
  // Everything on this card — legal name, EIN, approval thresholds — belongs to
  // a COMPANY, not to the account. It used to be read through whichever entity
  // the session sat on, so a landlord who owns two saw one company's settings
  // with nothing on screen saying which, and no way to reach the other's.
  //
  // The account picks. Owning exactly one, the picker is not rendered at all and
  // nothing changes for the overwhelming majority of landlords.
  // EntityPicker owns the list and lands on the first company itself.
  const [companyId, setCompanyId] = useState<string>('')
  const { data: me, isLoading, refetch: refetchMe } = useQuery<any>(
    ['landlord-me', companyId],
    () => apiGet(`/landlords/me?landlordId=${companyId}`),
    { enabled: !!companyId },
  )

  const [threshold, setThreshold] = useState<string>('')
  const [depThreshold, setDepThreshold] = useState<string>('')
  const [saved, setSaved] = useState(false)

  // S620: editing the entity's business name + EIN. The PATCH already accepted
  // both; nothing in the UI ever sent them, so a landlord whose signup dropped
  // them had no way to put them back.
  const [editAccount, setEditAccount] = useState(false)
  const [acctForm, setAcctForm] = useState({ businessName: '' })
  const acctMut = useMutation(
    () => apiPatch('/landlords/me', {
      businessName: acctForm.businessName.trim() || undefined,
      landlordId: companyId || undefined,
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('landlord-me')
        // The entity list renders the same name, so refresh it too — otherwise
        // it keeps saying "Unnamed entity" right below the name you just set.
        qc.invalidateQueries('landlord-entities')
        setEditAccount(false)
      },
    })

  useEffect(() => {
    if (me) {
      setThreshold(me.maintApprovalThreshold != null ? String(me.maintApprovalThreshold) : '500')
      setDepThreshold(me.depositReturnApprovalThreshold != null ? String(me.depositReturnApprovalThreshold) : '500')
    }
  }, [me])

  const saveMut = useMutation(
    () => apiPatch('/landlords/me', {
      maintApprovalThreshold: Number(threshold),
      depositReturnApprovalThreshold: Number(depThreshold),
      landlordId: companyId || undefined,
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('landlord-me')
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      }
    }
  )

  const { can } = usePerms()

  const thresholdNum = Number(threshold)
  const depThresholdNum = Number(depThreshold)
  const thresholdValid = !isNaN(thresholdNum) && thresholdNum >= 0
    && !isNaN(depThresholdNum) && depThresholdNum >= 0
  const thresholdChanged = me && (
    Number(me.maintApprovalThreshold || 500) !== thresholdNum
    || Number(me.depositReturnApprovalThreshold ?? 500) !== depThresholdNum
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Account and property configuration</p>
        </div>
      </div>

      <FeatureRequestCard />

      {/* S633: the same picker every other per-company surface uses. It renders
          nothing when the account owns one, which is nearly every landlord. */}
      <EntityPicker value={companyId} onChange={setCompanyId} label="Company"
        note="Legal name, EIN and approval thresholds belong to this company. Your properties, tenants and reports are unaffected — they always cover everything you own." />

      {isLoading ? (
        <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>

          {/* Account */}
          {can('settings.account_view') && (
          <div className="card">
            <div className="card-header">
              <span className="card-title">Account</span>
              {/* S620 (Nic): "the business name and EIN were already input. I
                  filled all that stuff out when I was signing up." Signup DID
                  collect and send both — the server dropped them, so his entity
                  has been nameless ever since (hence "Unnamed entity" in the
                  entity list, and a co-owner invite that said "a property on
                  GAM"). Signup keeps them now, but every landlord who already
                  registered needs a way to put them back, and this card was
                  read-only display with no edit path anywhere. */}
              {!editAccount && (
                <button className="btn btn-ghost btn-sm" style={{ fontSize: '.72rem' }}
                  onClick={() => {
                    setAcctForm({ businessName: me?.businessName || '' })
                    setEditAccount(true)
                  }}>Edit</button>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Business Name</div>
                {editAccount ? (
                  <input className="input" value={acctForm.businessName} autoFocus
                    placeholder="Oak Park Motel and RV LLC"
                    onChange={e => setAcctForm(f => ({ ...f, businessName: e.target.value }))} />
                ) : (
                  <div style={{ fontWeight: 500 }}>{me?.businessName || '—'}</div>
                )}
              </div>
              <div>
                {/* S620 (Nic): "replace the EIN field on the account card with
                    'on file with Stripe'. I like that one."
                    GAM never read this value — it was collected, stored and
                    displayed, nothing more. Stripe holds the real one for KYC
                    and 1099-K and will not return it, so keeping a copy was
                    liability in exchange for a label. */}
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Tax ID</div>
                <div style={{ color: me?.connectDetailsSubmitted ? 'var(--text-0)' : 'var(--text-3)' }}>
                  {me?.connectDetailsSubmitted
                    ? 'On file with Stripe'
                    : 'Collected during payout setup'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Name</div>
                <div style={{ fontWeight: 500 }}>{[me?.firstName, me?.lastName].filter(Boolean).join(' ') || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Email</div>
                <div>{me?.email || '—'}</div>
              </div>
            </div>
            {editAccount && (
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button className="btn btn-primary" style={{ fontSize: '.78rem' }}
                  disabled={acctMut.isLoading}
                  onClick={() => acctMut.mutate()}>
                  {acctMut.isLoading ? 'Saving…' : 'Save'}
                </button>
                <button className="btn btn-ghost" style={{ fontSize: '.78rem' }}
                  onClick={() => setEditAccount(false)}>Cancel</button>
                {acctMut.isError && (
                  <span style={{ fontSize: '.75rem', color: 'var(--red)', alignSelf: 'center' }}>
                    Could not save. Try again.
                  </span>
                )}
              </div>
            )}

            {/* S630: the sign-in email must be one the owner keeps, not one
                that transfers with a property being sold. */}
            <ChangeSignInEmail
              currentEmail={me?.email || ''}
              pendingEmail={me?.pendingEmail}
              onChanged={() => refetchMe?.()}
            />
          </div>
          )}

          {/* Security / 2FA */}
          <SecurityCard />

          {/* S631: first billing cycle */}
          {can('settings.billing_view') && <FirstBillingCycleCard />}

          {/* Billing */}
          {can('settings.billing_view') && (
          <div className="card">
            <div className="card-header"><span className="card-title">Billing</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Platform Fee</div>
                <div style={{ fontSize: '.88rem', color: 'var(--text-0)', fontWeight: 600 }}>$2 / occupied unit / mo</div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>Billed monthly · deducted from your payouts</div>
              </div>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Bank Account</div>
                <div>
                  {me?.bankAccountReady
                    ? <span className="badge badge-green">Ready</span>
                    : <span className="badge badge-amber">Not configured</span>}
                </div>
              </div>
            </div>
          </div>
          )}

          {/* Maintenance Approval */}
          {can('settings.maintenance_approval') && (
          <div className="card">
            <div className="card-header"><span className="card-title">Maintenance Approval</span></div>
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
                Set a cost threshold for maintenance requests. Any request with an estimated cost above this amount will be held in <strong style={{ color: 'var(--amber)' }}>Awaiting Approval</strong> status and require your explicit approval before being assigned to a contractor.
              </div>
              <div style={{ maxWidth: 280 }}>
                <label style={{
                  fontSize: '.72rem',
                  fontWeight: 600,
                  color: 'var(--text-3)',
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  display: 'block',
                  marginBottom: 5
                }}>
                  Approval Threshold
                </label>
                <div style={{ position: 'relative' }}>
                  <DollarSign size={14} style={{
                    position: 'absolute',
                    left: 11,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-3)'
                  }} />
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="10"
                    value={threshold}
                    onChange={e => setThreshold(e.target.value)}
                    placeholder="500"
                    style={{ width: '100%', paddingLeft: 30 }}
                  />
                </div>
                <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 6 }}>
                  Requests over {fmt(thresholdNum || 0)} will require approval.
                </div>
              </div>

              {/* S548: deposit-return approval threshold — staff finalize refunds
                  at/below this; larger refunds park for the landlord's approval. */}
              <div style={{ maxWidth: 280, marginTop: 18 }}>
                <label style={{
                  fontSize: '.72rem',
                  fontWeight: 600,
                  color: 'var(--text-3)',
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  display: 'block',
                  marginBottom: 5
                }}>
                  Deposit Return Approval Threshold
                </label>
                <div style={{ position: 'relative' }}>
                  <DollarSign size={14} style={{
                    position: 'absolute',
                    left: 11,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-3)'
                  }} />
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="10"
                    value={depThreshold}
                    onChange={e => setDepThreshold(e.target.value)}
                    placeholder="500"
                    style={{ width: '100%', paddingLeft: 30 }}
                  />
                </div>
                <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 6 }}>
                  Team members can finalize deposit refunds up to {fmt(depThresholdNum || 0)}; anything above waits for your approval. Set 0 to approve every refund yourself.
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => saveMut.mutate()}
                  disabled={!thresholdValid || !thresholdChanged || saveMut.isLoading}
                >
                  {saveMut.isLoading ? <span className="spinner" /> : 'Save'}
                </button>
                {saved && (
                  <span style={{ fontSize: '.78rem', color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Check size={12} /> Saved
                  </span>
                )}
                {saveMut.isError && (
                  <span style={{ fontSize: '.78rem', color: 'var(--red)' }}>
                    Failed to save. Try again.
                  </span>
                )}
              </div>
            </div>
          </div>
          )}

          {/* Default PM Company (S157) — S512: hidden at launch with the
              PM-company surface (PM Invitations not in the launch trio). */}
          {can('settings.default_pm_company') && !LAUNCH_HIDDEN.has('/pm-invitations') && (
            <DefaultPmCompanyCard
              currentDefaultId={me?.defaultPmCompanyId ?? null}
              onChange={() => qc.invalidateQueries('landlord-me')}
            />
          )}

          {/* S553/S631: entities, each carrying its own owners. */}
          <EntitiesSection />

          {/* W-53 (S531): Notification Prefs merged in as a real section —
              the standalone nav item is gone. The section renders its own
              cards, so no wrapper card here. */}
          <NotificationPrefsSection />
        </div>
      )}
    </div>
  )
}

// Two-factor authentication surface. S574: email-code 2FA is MANDATORY for
// every landlord (enforced server-side at login), so this is a read-only status
// card — no enable/disable, no authenticator enrollment. The code always goes to
// the account's login email; changing that email changes the 2FA destination.
function SecurityCard() {
  const { user } = useAuth()

  // Legacy authenticator accounts (pre-S574) still verify via TOTP at login;
  // note it here so the surface reads truthfully. No new landlord can enroll one.
  const legacyTotp = !!user?.totpEnabled

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">Two-Factor Authentication</span></div>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 9,
            background: 'var(--green-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem'
          }}>
            🔒
          </div>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-0)', fontSize: '.95rem' }}>
              On — email code
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              {legacyTotp
                ? 'Every sign-in requires your authenticator-app code. New accounts use an emailed 6-digit code.'
                : `Every sign-in requires a 6-digit code sent to ${user?.email || 'your email'}. This protects your tenants' data and is always on.`}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function DefaultPmCompanyCard({
  currentDefaultId, onChange,
}: {
  currentDefaultId: string | null
  onChange: () => void
}) {
  const linkedQ = useQuery<LinkedPmCompany[]>(
    'linked-pm-companies',
    () => apiGet<LinkedPmCompany[]>('/landlords/me/linked-pm-companies'),
  )
  const [pendingId, setPendingId] = useState<string>('')

  const setMut = useMutation(
    (pmCompanyId: string | null) => apiPatch('/landlords/me/default-pm-company', { pmCompanyId }),
    { onSuccess: () => { setPendingId(''); onChange() } },
  )

  const linked = linkedQ.data ?? []
  const currentName = currentDefaultId
    ? linked.find(c => c.id === currentDefaultId)?.name ?? '— unlinked PM —'
    : null

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">Default PM Company</span></div>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
          When set, this PM company becomes the proposed manager for any
          new property you add — you can override per-property at creation
          time. Only PM companies currently managing at least one of your
          properties can be set as the default.
        </div>

        {currentDefaultId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Current default:</div>
            <div style={{ fontWeight: 600, color: 'var(--gold)' }}>{currentName}</div>
            <button className="btn btn-ghost btn-sm"
                    disabled={setMut.isLoading}
                    onClick={() => setMut.mutate(null)}>
              <X size={11} style={{ marginRight: 4 }} /> Clear
            </button>
          </div>
        )}

        {linked.length === 0 ? (
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', fontStyle: 'italic' }}>
            No PM companies are currently managing your properties. Send an invitation from <a href="/pm-invitations">PM Invitations</a> to link one.
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 480 }}>
            <select className="input" value={pendingId}
                    onChange={e => setPendingId(e.target.value)}
                    style={{ flex: 1 }}>
              <option value="">— select a PM to set as default —</option>
              {linked.filter(c => c.id !== currentDefaultId).map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.propertyCount} {c.propertyCount === 1 ? 'property' : 'properties'}
                </option>
              ))}
            </select>
            <button className="btn btn-primary"
                    disabled={!pendingId || setMut.isLoading}
                    onClick={() => setMut.mutate(pendingId)}>
              {setMut.isLoading ? '…' : 'Set Default'}
            </button>
          </div>
        )}

        {setMut.isError && (
          <div style={{ fontSize: '.74rem', color: 'var(--red)', marginTop: 8 }}>
            {(setMut.error as any)?.response?.data?.error?.message || 'Save failed.'}
          </div>
        )}
      </div>
    </div>
  )
}


// ── FEATURE REQUEST (S571) ────────────────────────────────────────────────
// Landlords submit ideas the same way tenants do (POST /feature-requests); the
// GAM team reviews them in the admin portal. Input from both parties.
function FeatureRequestCard() {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    setSubmitting(true); setError('')
    try {
      await api.post('/feature-requests', { title: title.trim(), description: description.trim() })
      setDone(true)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not submit your request. Please try again.')
    }
    setSubmitting(false)
  }
  const reset = () => { setOpen(false); setTitle(''); setDescription(''); setError(''); setDone(false) }

  return (
    <div className="card" style={{ marginBottom: 16, background: 'rgba(59,130,246,.04)', border: '1px solid rgba(59,130,246,.2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>💡 Have a feature idea?</div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-3)', lineHeight: 1.5 }}>Suggest a new capability or improvement. Requests go directly to the GAM team.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>Submit request →</button>
      </div>

      {open && (
        <div className="modal-overlay" onClick={reset}>
          <div className="modal" style={{ maxWidth: 480, width: '95vw' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>💡 Suggest a feature</h3>
              <button className="btn btn-ghost btn-sm" onClick={reset} style={{ padding: 6 }}><X size={15} /></button>
            </div>
            {done ? (
              <>
                <p style={{ fontSize: '.85rem', color: 'var(--text-2)', margin: '4px 0 20px' }}>Thanks — your idea went to the GAM team. We read every one.</p>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" onClick={reset}>Done</button></div>
              </>
            ) : (
              <>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Title</label>
                  <input className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={140} placeholder="e.g. Bulk-import maintenance history" autoFocus style={{ width: '100%' }} />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Details</label>
                  <textarea className="input" rows={4} value={description} onChange={e => setDescription(e.target.value)} maxLength={4000} placeholder="Describe what you'd like and why it would help…" style={{ width: '100%', resize: 'vertical' }} />
                </div>
                {error && <div style={{ fontSize: '.78rem', color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn btn-ghost" onClick={reset}>Cancel</button>
                  <button className="btn btn-primary" disabled={submitting || title.trim().length < 3 || description.trim().length < 5} onClick={submit}>
                    {submitting ? 'Submitting…' : 'Submit request'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}


// ── First billing cycle (S631, moved to per-property in S633) ────────────────
//
// Nic (DIRECTIVE): "Maybe we just have a toggle for the landlord. Hey, when is
// your first billing cycle on this platform? That way the landlord can manually
// say, hey, I'm a little bit late onboarding everybody here, or I'm onboarding
// early — bill October first kind of thing. That way it puts it on the landlord
// to bill the tenants correctly."
//
// Only affects EXISTING tenants papered during onboarding. A new move-in is
// billed from the day they move in and this never touches them, which is what
// the copy below has to make obvious — otherwise it reads like a switch that
// stops all billing.
//
// The alternative was inferring the month from the signing date, which was
// tried and was wrong: it handed a free September to everyone signing on the
// 1st or 2nd. Which month is owed depends on which months the landlord already
// collected off-platform, and that is not in any date GAM holds.
//
// S633 — ONE ROW PER PROPERTY, NOT PER ENTITY. Nic: "if I onboard different
// properties that I own next month, it's gonna bill them right away. This needs
// to be a setting per property." Onboarding happens a property at a time, so the
// answer does too. Two bugs died with the old card: it acted on whichever entity
// the session sat on (Mountain View's answer was unreachable from Oak Park), and
// it read `entity.firstBillingCycle`, which /landlords/me/entities never
// returned — so every row rendered blank no matter what had been saved.
//
// GET /properties already spans every entity the account owns, so this list
// needs no entity picker and no switcher: a property is named, and its company
// is printed beside it.
function FirstBillingCycleCard() {
  const qc = useQueryClient()
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  return (
    <div className="card">
      <div className="card-header"><span className="card-title">First billing cycle</span></div>
      <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.6, marginTop: 8 }}>
        The first month GAM invoices your <strong>existing</strong> tenants for — the ones you
        papered during onboarding, who were already living on the property. Set it per property,
        to the month you want GAM to take over, and no earlier than the last month you collected
        yourself.
      </div>
      <div style={{ display: 'grid', gap: 14, marginTop: 16 }}>
        {(properties as any[]).length === 0
          ? <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
              No properties yet. Add one and its billing cycle will appear here.
            </div>
          : (properties as any[]).map(p => <PropertyBillingCycleRow key={p.id} property={p} qc={qc} />)}
      </div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 12, lineHeight: 1.6 }}>
        New move-ins are unaffected: they are billed from their move-in date, prorated as usual.
      </div>
    </div>
  )
}

function PropertyBillingCycleRow({ property, qc }: { property: any; qc: any }) {
  const current = property.firstBillingCycle ? String(property.firstBillingCycle).slice(0, 7) : ''
  const [month, setMonth] = useState(current)
  const [saved, setSaved] = useState(false)
  const saveMut = useMutation(
    () => apiPatch(`/properties/${property.id}/first-billing-cycle`,
      { firstBillingCycle: month || null }),
    {
      onSuccess: () => {
        qc.invalidateQueries('properties')
        setSaved(true); setTimeout(() => setSaved(false), 2500)
      },
    },
  )
  const changed = month !== current

  return (
    <div style={{ borderTop: '1px solid var(--border-1, rgba(255,255,255,.06))', paddingTop: 12 }}>
      <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)' }}>
        {property.name || 'Unnamed property'}
      </div>
      {property.entityName && (
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>{property.entityName}</div>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
        <div>
          <label style={{ fontSize: '.72rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>
            Bill existing tenants from
          </label>
          <input className="input" type="month" value={month}
            style={{ maxWidth: 190 }}
            onChange={e => { setMonth(e.target.value); setSaved(false) }} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={!changed || saveMut.isLoading}
          onClick={() => saveMut.mutate()}>
          {saveMut.isLoading ? 'Saving…' : 'Save'}
        </button>
        {saved && <span style={{ fontSize: '.74rem', color: 'var(--green, var(--gold))' }}>Saved</span>}
      </div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.6 }}>
        {month
          ? <>An existing tenant here who signs any time before {month} is first invoiced for {month},
              at full rent — never a part month. Someone who signs later is invoiced for the month
              they sign in.</>
          : <>Not set — each existing tenant here is invoiced for the month their lease starts in, at
              full rent. Set this if you already collected that month yourself.</>}
        {' '}New move-ins are unaffected: they are billed from their move-in date, prorated as usual.
      </div>
    </div>
  )
}


// S631 (Nic): "Maybe add owners from inside the entity details." One entity, its
// properties, and the people who own it — in one place, so "add owner" can never
// be ambiguous about where the owner is being added.
function EntityRow({ entity, expanded, onToggle }: { entity: any; expanded: boolean; onToggle: () => void }) {
  const { data: members = [] } = useQuery<any[]>(
    ['landlord-members', entity.id],
    () => apiGet(`/landlords/members?landlordId=${entity.id}`),
  )
  const ownerCount = members.length
  return (
    <div style={{ borderBottom: '1px solid var(--border-1, rgba(255,255,255,.06))' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
        <div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-0)', fontWeight: 600 }}>
            {entity.businessName || 'Unnamed entity'}
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
            {entity.propertyCount} {entity.propertyCount === 1 ? 'property' : 'properties'}
            {ownerCount > 0 && ` · ${ownerCount} ${ownerCount === 1 ? 'owner' : 'owners'}`}
            {!entity.isOwner && ' · co-owned'}
            {!entity.connectPayoutsEnabled && ' · payouts not set up'}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" style={{ fontSize: '.72rem' }} onClick={onToggle}>
          {expanded ? 'Hide owners' : 'Manage owners'}
        </button>
      </div>
      {expanded && (
        <OwnersSection landlordId={entity.id} entityName={entity.businessName || 'this entity'} />
      )}
    </div>
  )
}
