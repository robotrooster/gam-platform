import { useState } from 'react'
import { HomeSaleToggle, homeSalePayload, homeSaleComplete, PacketChecklist, tickedIds, type HomeSaleForm } from './TenantOnboardingPage'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { X, Mail, DoorOpen, Check, ChevronRight, ChevronLeft } from 'lucide-react'
import { canInviteToUnit, hiddenUnitReasons } from '../lib/inviteEligibility'
import { reachedBy, unitInviteFallbackLine, screeningInviteLine, inviteResultTitle } from '../lib/inviteOutcome'
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
  // S655 (Nic, 10/2): invites are EMAIL-ONLY. The setup link sets the
  // person's password, so it goes only to their own inbox and never comes back
  // to this screen. Someone who didn't get it: Resend on the Front Desk.
  // notified: what actually reached them — an email, a notice in the GAM
  // account they already use, or nothing (null).
  type InviteOutcome = {
    email: string; name: string; inviteSent: boolean; alreadyOnPlatform: boolean; needsOwnSignature: boolean
    notified: 'email' | 'notice' | null
  }
  const [inviteResult, setInviteResult] = useState<{ screened: boolean; sent: InviteOutcome[]; drafted: boolean; draftBlocked: string[] } | null>(null)
  // S579: a person invited to a vacant unit is a NEW applicant by default — they
  // create an account + complete a background check before a unit is assigned
  // (property-level invite). Uncheck only for someone who doesn't need screening.
  // S652 (Nic, option 2): three doors, none of them a free "no screening".
  //   screen     — new applicant, background check first (default)
  //   returning  — lived here before; the landlord attests it, recorded and capped
  //   sitting    — already living here during the onboarding window (grandfather)
  const [screenMode, setScreenMode] = useState<'screen' | 'returning' | 'sitting'>('screen')
  const requireScreening = screenMode === 'screen'
  const { data: windows = [] } = useQuery<any[]>('onboarding-windows', () => apiGet('/landlords/me/onboarding-windows'), { retry: false })

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
  // Hidden rather than grayed, per the rule Nic set for the meter pickers ("I
  // don't want them grayed out because then I still have to scroll around
  // looking for just the odd one or two"), with a count of what was hidden
  // underneath so nothing vanishes unexplained.
  const { data: allUnits = [] } = useQuery<any[]>('vacant-units', () => apiGet('/units'))
  // S629: the predicate moved to lib/inviteEligibility so the Tenant Onboarding
  // roster form applies exactly the same rule. Behavior here is unchanged.
  const hiddenReasons = hiddenUnitReasons(allUnits as any[])
  const units = (allUnits as any[]).filter(canInviteToUnit)

  // S655: a household invited to a UNIT goes in one call — its lease drafts
  // once with everyone on it and waits for your signature; nobody is emailed
  // until you sign. Applicants invited to a PROPERTY (they screen first) are
  // invited one at a time and get their invite email now.
  const inviteMut = useMutation(
    async (req: { unit: any | null; property: any[] | null }) => {
      if (req.unit) {
        const res: any = await apiPost('/tenants/invite', req.unit)
        const d = res?.data ?? {}
        const people: any[] = Array.isArray(d.people) ? d.people : []
        return {
          drafted: d.leaseDrafted === true,
          draftBlocked: Array.isArray(d.draftBlocked) ? d.draftBlocked : [],
          sent: people.map(p => ({
            email: p.email, name: p.name || p.email, inviteSent: p.inviteSent === true,
            alreadyOnPlatform: p.alreadyOnPlatform === true, needsOwnSignature: p.needsOwnSignature === true,
            notified: reachedBy(p),
          })) as InviteOutcome[],
        }
      }
      const out: InviteOutcome[] = []
      for (const [i, payload] of (req.property ?? []).entries()) {
        try {
          const res: any = await apiPost('/tenants/invite', payload)
          const d = res?.data ?? {}
          out.push({
            email: payload.email, name: [payload.firstName, payload.lastName].filter(Boolean).join(' '),
            inviteSent: d.inviteSent === true, alreadyOnPlatform: d.alreadyOnPlatform === true, needsOwnSignature: false,
            notified: reachedBy(d),
          })
        } catch (e: any) {
          const msg = e?.response?.data?.error || e?.message || 'Invite failed'
          // Name WHICH resident failed — "invite failed" on a four-person
          // household tells the landlord nothing about what to fix.
          throw new Error(`${payload.email}: ${msg}${i > 0 ? ` (${i} invite${i > 1 ? 's' : ''} already sent)` : ''}`)
        }
      }
      return { drafted: false, draftBlocked: [] as string[], sent: out }
    },
    {
      onSuccess: (r) => {
        qc.invalidateQueries('tenants')
        qc.invalidateQueries('units')
        qc.invalidateQueries('vacant-units')
        setInviteResult({ screened: requireScreening, sent: r.sent, drafted: r.drafted, draftBlocked: r.draftBlocked })
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
  // S652 (Nic): "are you adding a home to the sale?" — only for a park-owned home.
  const [homeSale, setHomeSale] = useState<HomeSaleForm | null>(null)
  const [packet, setPacket] = useState<Record<string, boolean> | null>(null)
  const askSale = selectedUnit?.dwellingOwnership === 'landlord' && selectedUnit?.unitType === 'mobile_home'

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
    if (step === 1 && askSale && !homeSaleComplete(homeSale)) errs.unitId = 'Fill in the home sale terms, or untick the box'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const next = () => { if (validateStep()) setStep(s => s + 1) }
  const back = () => setStep(s => s - 1)

  const submit = () => {
    const people = residents.map(r => ({
      email: r.email.trim(),
      firstName: r.firstName.trim(),
      lastName: r.lastName.trim(),
      phone: r.phone.trim() || undefined,
    }))
    // S579: screening → property-level invite (they screen, unit assigned
    // later at lease). Sequential: the caller sees exactly which one failed.
    if (requireScreening && selectedUnit?.propertyId) {
      inviteMut.mutate({ unit: null, property: people.map(p => ({ ...p, propertyId: selectedUnit.propertyId })) })
      return
    }
    // The household on its unit, in one call. The first person listed holds
    // the lease; the rest are co-tenants on it.
    inviteMut.mutate({ property: null, unit: {
      ...people[0], residents: people, unitId: form.unitId,
      ...(screenMode === 'returning' ? { returningResident: true } : {}),
      ...(screenMode === 'sitting' ? { existingResident: true } : {}),
      homeSale: askSale && homeSale ? homeSalePayload(homeSale) : undefined,
      packageTemplateIds: tickedIds(packet),
    } })
  }

  // Success screen
  if (inviteResult) {
    const r = inviteResult
    const title = inviteResultTitle(r)
    // Green only when everything went; amber when something is left to do.
    const allWent = title === 'Lease drafted' || title === 'Invite Sent' || title === 'Already on GAM'
    const tone = allWent ? 'var(--green)' : 'var(--amber, #d97706)'
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
          <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: allWent ? 'rgba(30,219,122,.12)' : 'rgba(217,119,6,.12)', border: `2px solid ${tone}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <Check size={24} style={{ color: tone }} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.15rem', fontWeight: 800, color: 'var(--text-0)', marginBottom: 6 }}>
              {title}
            </div>
            {r.screened ? r.sent.map(x => (
              <div key={x.email} style={{ fontSize: '.82rem', color: x.notified ? 'var(--text-3)' : 'var(--amber, #d97706)', marginTop: 4 }}>
                {screeningInviteLine(x)}
              </div>
            )) : r.drafted ? (
              <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4, lineHeight: 1.6 }}>
                {r.draftBlocked.length === 0
                  ? <>The lease for {r.sent.map(x => x.name).join(', ')} is waiting for your signature in Front Desk.</>
                  // A by-room unit drafts a lease per person: some can draft
                  // while others are refused. Each reason names whose it is.
                  : <>The leases that drafted are waiting for your signature in Front Desk. These did not draft yet:</>}
                {r.draftBlocked.map((b, i) => <div key={i} style={{ color: 'var(--amber, #d97706)', marginTop: 4 }}>{b}</div>)}
                <div style={{ marginTop: 4 }}>
                  Nobody has been emailed yet — each person gets one email when you sign their lease.
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4, lineHeight: 1.6 }}>
                {r.draftBlocked.map((b, i) => <div key={i} style={{ color: 'var(--amber, #d97706)' }}>{b}</div>)}
                {/* The usual invite was tried instead: say who it reached, and
                    for anyone it did not, what to press. */}
                {r.sent.map(x => (
                  <div key={x.email} style={{ marginTop: 4, color: x.notified ? undefined : 'var(--amber, #d97706)' }}>
                    {unitInviteFallbackLine(x)}
                  </div>
                ))}
              </div>
            )}
            {!r.screened && r.sent.some(x => x.needsOwnSignature) && (
              <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 8, lineHeight: 1.6 }}>
                {r.sent.filter(x => x.needsOwnSignature).map(x => x.name).join(', ')} already
                {r.sent.filter(x => x.needsOwnSignature).length === 1 ? ' has' : ' have'} a GAM account with another
                company, so the lease starts when they sign it themselves.
              </div>
            )}
          </div>

          <div style={{ fontSize: '.75rem', color: 'var(--text-3)', background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.15)', borderRadius: 8, padding: '10px 12px', marginBottom: 20, lineHeight: 1.6 }}>
            {r.screened
              ? <>They&apos;ll set up an account and complete a <strong style={{ color: 'var(--amber)' }}>background check</strong>. Once it clears and you approve, assign them a unit and send the lease.</>
              : <>Sign the lease in <strong style={{ color: 'var(--amber)' }}>Front Desk → Waiting on you to sign</strong>. Rent bills from the lease once it is signed.</>}
            {r.screened
              ? <>{' '}If someone doesn&apos;t get their email, press <strong>Re-send invite</strong> next to them on the Front Desk.</>
              : <>{' '}If someone doesn&apos;t get their email after you sign, send a reminder from the lease&apos;s row in <strong>E-Sign</strong>.</>}
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
            {/* S652 (Nic): "are you adding a home to the sale?" — only for a park-owned home. */}
            {askSale && <div style={{ marginTop: 12 }}><HomeSaleToggle sale={homeSale} setSale={setHomeSale} /></div>}
            {form.unitId && <div style={{ marginTop: 12 }}><PacketChecklist unitId={form.unitId} sale={askSale && !!homeSale} ticked={packet} setTicked={setPacket} /></div>}
            {errors.unitId && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 8 }}>{errors.unitId}</div>}

            {form.unitId && (() => {
              const win = (windows as any[]).find((w: any) => w.propertyId === selectedUnit?.propertyId)
              const windowOpen = !!win?.open
              if (!windowOpen && screenMode === 'sitting') setScreenMode('screen')
              if (win?.returningAllowanceLeft === 0 && screenMode === 'returning') setScreenMode('screen')
              const opt = (mode: 'screen' | 'returning' | 'sitting', title: string, body: string) => (
                <label key={mode} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '10px 12px', background: screenMode === mode ? 'rgba(201,162,39,.06)' : 'var(--bg-2)', border: `1px solid ${screenMode === mode ? 'var(--gold)' : 'var(--border-0)'}`, borderRadius: 8 }}>
                  <input type="radio" checked={screenMode === mode} onChange={() => setScreenMode(mode)} style={{ marginTop: 2, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)' }}>{title}</div>
                    <div style={{ fontSize: '.74rem', color: 'var(--text-3)', lineHeight: 1.5, marginTop: 2 }}>{body}</div>
                  </div>
                </label>
              )
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
                  {opt('screen', 'New applicant — background check first', 'They create an account and complete a background check before you assign the space.')}
                  {win?.returningAllowanceLeft === 0
                    ? <div style={{ padding: '10px 12px', border: '1px solid var(--border-0)', borderRadius: 8, opacity: .6, fontSize: '.78rem', color: 'var(--text-3)' }}>
                        <b style={{ color: 'var(--text-1)' }}>Returning resident</b> — not available at this property right now. New residents complete a background check.
                      </div>
                    : opt('returning', 'Returning resident — lived here before', 'You are attesting this person has lived at this property before. No background check. GAM records the attestation.')}
                  {windowOpen && opt('sitting', 'Already lives here', 'A resident who was here when this property came onto GAM. Onboarding window is open.')}
                </div>
              )
            })()}

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

              {/* What happens next — S647: you sign first, then they get one email. */}
              {(requireScreening ? [
                'An invite email goes to each of them now',
                'They set up an account and complete a background check',
                'Once it clears, you assign their space and send the lease',
              ] : [
                'Their lease drafts now, from this unit\'s rent and your default lease',
                'You sign it in Front Desk → Waiting on you to sign',
                'Each of them gets one email: set up their account and sign',
                'Rent bills from the lease once it is signed',
              ]).map((text, i, arr) => (
                <div key={i} style={{ padding: '8px 16px', borderBottom: i < arr.length - 1 ? '1px solid var(--border-0)' : 'none', display: 'flex', alignItems: 'center', gap: 10, fontSize: '.75rem', color: 'var(--text-3)' }}>
                  <span style={{ color: 'var(--gold)', fontWeight: 700 }}>{i + 1}</span> {text}
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
                : requireScreening
                  ? <><Mail size={14} /> Send {residents.length > 1 ? `${residents.length} invites` : 'invite'}</>
                  : <>Invite and draft the lease</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
