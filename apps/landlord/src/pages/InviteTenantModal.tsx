import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { X, Mail, DoorOpen, Copy, Check, ChevronRight, ChevronLeft } from 'lucide-react'
import { canInviteToUnit, hiddenUnitReasons } from '../lib/inviteEligibility'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

interface Props { onClose: () => void }

const STEPS = ['Residents', 'Unit Assignment', 'Confirm']

const lbl: React.CSSProperties = {
  fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5,
}
const errStyle: React.CSSProperties = { color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }

export function InviteTenantModal({ onClose }: Props) {
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  // S605 (Nic): "have it say add resident and then have you able to put in
  // multiple people on the same form, multiple names and phone numbers, and just
  // select the one unit if they live together."
  //
  // A household — spouses, roommates — is ONE tenancy in one unit, and every
  // adult on it gets a FULL account. Nic: "everybody needs to see the full
  // details of what they are part of," the same rule as co-ownership. Inviting
  // them one at a time gave no way to say they belong together and left the
  // second person a stranger to the first person's lease.
  //
  // The FIRST resident is the primary; the rest are co-tenants. Liability is
  // joint-and-several (the lease_tenants default), which is the other reason
  // everyone needs their own login — a spouse who cannot sign in to pay rent
  // becomes the landlord's support problem.
  type Resident = { firstName: string; lastName: string; email: string; phone: string }
  const blankResident = (): Resident => ({ firstName: '', lastName: '', email: '', phone: '' })
  const [residents, setResidents] = useState<Resident[]>([blankResident()])
  const [form, setForm] = useState({ unitId: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [inviteResult, setInviteResult] = useState<{ acceptUrl: string; email: string; screened: boolean; sent?: { email: string; acceptUrl: string }[]; draft?: { drafted: boolean; reason?: string } | null } | null>(null)
  const [copied, setCopied] = useState(false)
  // S579: a person invited to a vacant unit is a NEW applicant by default — they
  // create an account + complete a background check before a unit is assigned
  // (property-level invite). Uncheck only for someone who doesn't need screening.
  const [requireScreening, setRequireScreening] = useState(true)

  // S613 (Nic): "Do the occupied units disappear from this list the same way
  // our submeter units disappear after they're selected?"
  //
  // They did — but only for a fully ACTIVE tenancy, which is a narrower test
  // than it looks. Three kinds of unit stayed on the list that should not have:
  //
  //   · a unit someone was ALREADY INVITED to, with no lease finished yet.
  //     Inviting thirty households in a sitting, that is how the same space gets
  //     offered to two of them — and nothing on screen would have said so.
  //     An invite that LAPSES unaccepted (7 days) releases the unit again, so a
  //     silent invite can never hold a space out of the list forever; one that
  //     was accepted keeps holding it while the lease is finished.
  //   · an OWNER-OCCUPIED unit, which has no lease at all, so it read as free.
  //   · a unit already holding a signed-but-not-active lease.
  //
  // Hidden rather than greyed, per the rule Nic set for the meter pickers ("I
  // don't want them grayed out because then I still have to scroll around
  // looking for just the odd one or two"), with a count of what was hidden
  // underneath so nothing vanishes unexplained.
  const { data: allUnits = [] } = useQuery<any[]>('vacant-units', () => apiGet('/units'))
  // S629: the predicate moved to lib/inviteEligibility so the Tenant Onboarding
  // roster form applies exactly the same rule. Behaviour here is unchanged.
  const hiddenReasons = hiddenUnitReasons(allUnits as any[])
  const units = (allUnits as any[]).filter(canInviteToUnit)

  const inviteMut = useMutation(
    async (payloads: any[]) => {
      const out: any[] = []
      for (const [i, payload] of payloads.entries()) {
        try {
          const res: any = await apiPost('/tenants/invite', payload)
          out.push({ email: payload.email, acceptUrl: res.data.acceptUrl })
        } catch (e: any) {
          const msg = e?.response?.data?.error || e?.message || 'Invite failed'
          // Name WHICH resident failed — "invite failed" on a four-person
          // household tells the landlord nothing about what to fix.
          throw new Error(`${payload.email}: ${msg}${i > 0 ? ` (${i} invite${i > 1 ? 's' : ''} already sent)` : ''}`)
        }
      }
      return out
    },
    {
      onSuccess: async (out: any[]) => {
        qc.invalidateQueries('tenants')
        qc.invalidateQueries('units')
        // S605: draft the lease for the whole household off the unit type's
        // default template. Best-effort — the invites already went out, so a
        // landlord who hasn't set a template yet is TOLD, not failed.
        let draft: { drafted: boolean; reason?: string } | null = null
        if (form.unitId) {
          try {
            const r: any = await apiPost('/esign/draft-household', {
              unitId: form.unitId, emails: out.map(o => o.email),
            })
            draft = r?.data ?? r
          } catch { draft = null }
        }
        setInviteResult({ acceptUrl: out[0].acceptUrl, email: out[0].email,
          screened: requireScreening, sent: out, draft })
      },
      onError: (e: any) => setErrors(er => ({ ...er, submit: e?.message || 'Could not send the invites' })),
    }
  )

  const set = (key: string, val: string) => {
    setForm(f => ({ ...f, [key]: val }))
    setErrors(e => ({ ...e, [key]: '' }))
  }
  const setResident = (i: number, key: keyof Resident, val: string) => {
    setResidents(rs => rs.map((r, idx) => idx === i ? { ...r, [key]: val } : r))
    setErrors(e => ({ ...e, [`r${i}_${key}`]: '' }))
  }
  const addResident = () => setResidents(rs => [...rs, blankResident()])
  const removeResident = (i: number) => setResidents(rs => rs.filter((_, idx) => idx !== i))

  const selectedUnit = (units as any[]).find(u => u.id === form.unitId)

  const validateStep = () => {
    const errs: Record<string, string> = {}
    if (step === 0) {
      const seen = new Set<string>()
      residents.forEach((r, i) => {
        if (!r.firstName.trim()) errs[`r${i}_firstName`] = 'First name required'
        const email = r.email.trim().toLowerCase()
        if (!email) errs[`r${i}_email`] = 'Email required'
        else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs[`r${i}_email`] = 'Invalid email'
        // Two residents sharing an address would collide into one account and
        // silently drop a signer off the lease.
        else if (seen.has(email)) errs[`r${i}_email`] = 'Already used by another resident'
        else seen.add(email)
      })
    }
    if (step === 1 && !form.unitId) errs.unitId = 'Select a unit'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const next = () => { if (validateStep()) setStep(s => s + 1) }
  const back = () => setStep(s => s - 1)

  const submit = () => {
    // Sequential, not parallel: they hit the same unit and the same landlord
    // scope, and a partially-applied household is worse than a slow one — the
    // caller sees exactly which resident failed.
    inviteMut.mutate(residents.map((r, i) => {
      const base = {
        email: r.email.trim(),
        firstName: r.firstName.trim(),
        lastName: r.lastName.trim(),
        phone: r.phone.trim() || undefined,
        // First listed holds the lease; the rest ride as co-tenants.
        householdRole: i === 0 ? 'primary' : 'co_tenant',
      }
      // S579: screening → property-level invite (they screen, unit assigned
      // later at lease). Otherwise the unit-bound invite.
      return requireScreening && selectedUnit?.propertyId
        ? { ...base, propertyId: selectedUnit.propertyId }
        : { ...base, unitId: form.unitId }
    }))
  }

  const copyLink = () => {
    if (!inviteResult) return
    navigator.clipboard.writeText(inviteResult.acceptUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Success screen
  if (inviteResult) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
          <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(30,219,122,.12)', border: '2px solid var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <Check size={24} style={{ color: 'var(--green)' }} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.15rem', fontWeight: 800, color: 'var(--text-0)', marginBottom: 6 }}>Invite Sent</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>
              {inviteResult.email} will receive an email to set up their account.
            </div>
          </div>

          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>
              Invite Link — share directly if needed
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '.68rem', color: 'var(--text-2)', background: 'var(--bg-3)', border: '1px solid var(--border-0)', borderRadius: 6, padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {inviteResult.acceptUrl}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={copyLink} style={{ flexShrink: 0, gap: 5 }}>
                {copied ? <><Check size={13} style={{ color: 'var(--green)' }} /> Copied</> : <><Copy size={13} /> Copy</>}
              </button>
            </div>
          </div>

          <div style={{ fontSize: '.75rem', color: 'var(--text-3)', background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.15)', borderRadius: 8, padding: '10px 12px', marginBottom: 20, lineHeight: 1.6 }}>
            {inviteResult.screened
              ? <>⚡ They&apos;ll create an account and complete a <strong style={{ color: 'var(--amber)' }}>background check</strong>. Once it clears and you approve, assign them a unit and send the lease.</>
              : <>⚡ Unit has been assigned. The tenant will appear as <strong style={{ color: 'var(--amber)' }}>Pending</strong> until they complete their account setup and verify their bank account.</>}
          </div>

          <button className="btn btn-primary" style={{ width: '100%' }} onClick={onClose}>Done</button>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 500 }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div className="modal-title" style={{ marginBottom: 6 }}>Invite Tenant</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {STEPS.map((s, i) => (
                <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '.65rem', fontWeight: 700,
                    background: i < step ? 'var(--green)' : i === step ? 'var(--gold)' : 'var(--bg-3)',
                    color: i <= step ? 'var(--bg-0)' : 'var(--text-3)',
                    border: `1px solid ${i < step ? 'var(--green)' : i === step ? 'var(--gold)' : 'var(--border-0)'}`,
                    transition: 'all .2s'
                  }}>
                    {i < step ? <Check size={11} /> : i + 1}
                  </div>
                  <span style={{ fontSize: '.65rem', color: i === step ? 'var(--text-1)' : 'var(--text-3)', fontWeight: i === step ? 600 : 400 }}>{s}</span>
                  {i < STEPS.length - 1 && <div style={{ width: 16, height: 1, background: 'var(--border-0)', margin: '0 2px' }} />}
                </div>
              ))}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {/* Step 0: Tenant Info */}
        {step === 0 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Everyone living in the unit. The first person listed holds the lease; anyone
              you add is a co-tenant on the same lease. <strong style={{ color: 'var(--text-0)' }}>Each
              of them gets their own login</strong> and sees the full tenancy — lease, balance and payments.
            </div>

            {residents.map((r, i) => (
              <div key={i} style={{ border: '1px solid var(--border-0)', borderRadius: 10,
                padding: 14, marginBottom: 12, background: i === 0 ? 'rgba(201,162,39,.04)' : 'var(--bg-2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '.06em', color: i === 0 ? 'var(--gold)' : 'var(--text-3)' }}>
                    {i === 0 ? 'Primary resident' : `Co-resident ${i + 1}`}
                  </span>
                  {i > 0 && (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', color: 'var(--red)' }}
                      onClick={() => removeResident(i)}>Remove</button>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={lbl}>First Name *</label>
                    <input className="input" placeholder="Jane" value={r.firstName} autoFocus={i === 0}
                      onChange={e => setResident(i, 'firstName', e.target.value)} style={{ width: '100%' }} />
                    {errors[`r${i}_firstName`] && <div style={errStyle}>{errors[`r${i}_firstName`]}</div>}
                  </div>
                  <div>
                    <label style={lbl}>Last Name</label>
                    <input className="input" placeholder="Smith" value={r.lastName}
                      onChange={e => setResident(i, 'lastName', e.target.value)} style={{ width: '100%' }} />
                  </div>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={lbl}>Email Address *</label>
                  <div style={{ position: 'relative' }}>
                    <Mail size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                    <input className="input" type="email" placeholder="jane@example.com" value={r.email}
                      onChange={e => setResident(i, 'email', e.target.value)} style={{ width: '100%', paddingLeft: 32 }} />
                  </div>
                  {errors[`r${i}_email`] && <div style={errStyle}>{errors[`r${i}_email`]}</div>}
                </div>

                <div>
                  <label style={lbl}>Phone <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
                  <input className="input" type="tel" placeholder="(555) 000-0000" value={r.phone}
                    onChange={e => setResident(i, 'phone', e.target.value)} style={{ width: '100%' }} />
                </div>
              </div>
            ))}

            <button type="button" className="btn btn-ghost btn-sm" onClick={addResident}>
              + Add resident
            </button>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 8, lineHeight: 1.5 }}>
              Add a spouse, partner or roommate who lives in the same unit. They all sign the
              same lease and are jointly responsible for the rent.
            </div>
          </div>
        )}

        {/* Step 1: Unit Assignment */}
        {step === 1 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Assign {residents.length > 1
                ? <strong style={{ color: 'var(--text-0)' }}>{residents.length} residents</strong>
                : <strong style={{ color: 'var(--text-0)' }}>{residents[0].firstName}</strong>} to a vacant unit.
              {residents.length > 1 && ' They share one lease on it.'}
            </div>

            {(units as any[]).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-3)' }}>
                <DoorOpen size={32} style={{ margin: '0 auto 8px', display: 'block', opacity: .4 }} />
                  <div style={{ fontSize: '.82rem' }}>No vacant units available.</div>
                <div style={{ fontSize: '.75rem', marginTop: 4 }}>
                  {hiddenReasons.length
                    ? <>Every unit is spoken for — {hiddenReasons.join(', ')}.</>
                    : <>Add units first or check existing unit assignments.</>}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
                {(units as any[]).map((u: any) => (
                  <div
                    key={u.id}
                    onClick={() => set('unitId', u.id)}
                    style={{
                      padding: '12px 14px', borderRadius: 10, cursor: 'pointer', transition: 'all .12s',
                      border: `1px solid ${form.unitId === u.id ? 'var(--gold)' : 'var(--border-0)'}`,
                      background: form.unitId === u.id ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
                      display: 'flex', alignItems: 'center', gap: 12,
                    }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                      background: form.unitId === u.id ? 'rgba(201,162,39,.15)' : 'var(--bg-3)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <DoorOpen size={16} style={{ color: form.unitId === u.id ? 'var(--gold)' : 'var(--text-3)' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>
                        Unit {u.unitNumber} <span style={{ fontSize: '.72rem', color: 'var(--text-3)', fontWeight: 400 }}>· {u.propertyName}</span>
                      </div>
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>
                        {u.bedrooms === 0 ? 'Studio' : `${u.bedrooms}bd`} · {u.bathrooms}ba
                        {u.sqft ? ` · ${u.sqft.toLocaleString()} sqft` : ''}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.85rem', color: 'var(--gold)', fontWeight: 600 }}>{fmt(u.rentAmount)}</div>
                      <div style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>/month</div>
                    </div>
                    {form.unitId === u.id && <Check size={16} style={{ color: 'var(--gold)', flexShrink: 0 }} />}
                  </div>
                ))}
              </div>
            )}
            {/* S613: nothing vanishes unexplained — the count of what was left
                out sits under the list, the same way the meter unit picker
                reports what it hid. */}
            {units.length > 0 && hiddenReasons.length > 0 && (
              <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 8 }}>
                Not shown: {hiddenReasons.join(', ')}.
              </div>
            )}
            {errors.unitId && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 8 }}>{errors.unitId}</div>}

            {form.unitId && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginTop: 14, padding: '12px 14px', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10 }}>
                <input type="checkbox" checked={requireScreening} onChange={e => setRequireScreening(e.target.checked)} style={{ marginTop: 2, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)' }}>Require background check (new applicant)</div>
                  <div style={{ fontSize: '.74rem', color: 'var(--text-3)', lineHeight: 1.5, marginTop: 2 }}>
                    They create an account and complete a background check before you assign the unit. Uncheck only for someone who doesn&apos;t need screening.
                  </div>
                </div>
              </label>
            )}
          </div>
        )}

        {/* Step 2: Confirm */}
        {step === 2 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Review and send the invite.
            </div>

            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              {/* Tenant */}
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg, var(--gold-dark), var(--gold))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontSize: '.8rem', fontWeight: 800, color: 'var(--bg-0)', flexShrink: 0 }}>
                  {residents[0].firstName[0]}{residents[0].lastName?.[0] || ''}
                </div>
                <div>
                  <div style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>
                    {residents.map(r => [r.firstName, r.lastName].filter(Boolean).join(' ')).join(' · ')}
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                    {residents.map(r => r.email).join(', ')}
                  </div>
                </div>
                <span className="badge badge-amber" style={{ marginLeft: 'auto' }}>Invite Pending</span>
              </div>

              {/* Unit */}
              {selectedUnit && (
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <DoorOpen size={14} style={{ color: 'var(--text-3)' }} />
                    <div>
                      <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text-0)' }}>Unit {selectedUnit.unitNumber}</div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{selectedUnit.propertyName}</div>
                    </div>
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.85rem', color: 'var(--gold)', fontWeight: 600 }}>{fmt(selectedUnit.rentAmount)}/mo</div>
                </div>
              )}

              {/* What happens next */}
              {[
                { icon: '📧', text: 'Invite email sent to tenant' },
                { icon: '🔐', text: 'Tenant sets password and verifies identity' },
                { icon: '🏦', text: 'Tenant connects bank account for ACH' },
                { icon: '✅', text: 'Unit goes active — rent collection begins' },
              ].map((item, i) => (
                <div key={i} style={{ padding: '8px 16px', borderBottom: i < 3 ? '1px solid var(--border-0)' : 'none', display: 'flex', alignItems: 'center', gap: 10, fontSize: '.75rem', color: 'var(--text-3)' }}>
                  <span>{item.icon}</span> {item.text}
                </div>
              ))}
            </div>

            {inviteMut.isError && (
              <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                {/* S605: names the resident that failed and how many already
                    went out — a household invite that dies halfway is otherwise
                    impossible to reason about. */}
                {errors.submit || 'Failed to send invite. The tenant may already be assigned to a unit.'}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="modal-footer" style={{ marginTop: 24 }}>
          {step > 0 ? (
            <button className="btn btn-ghost" onClick={back}><ChevronLeft size={14} /> Back</button>
          ) : (
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" onClick={next}>
              Next <ChevronRight size={14} />
            </button>
          ) : (
            <button className="btn btn-primary" onClick={submit} disabled={inviteMut.isLoading}>
              {inviteMut.isLoading ? <span className="spinner" />
                : <><Mail size={14} /> Send {residents.length > 1 ? `${residents.length} invites` : 'invite'}</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
