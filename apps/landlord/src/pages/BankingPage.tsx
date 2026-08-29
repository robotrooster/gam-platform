/**
 * S66: Banking page — owner manages their per-user bank account catalog.
 *
 * UX: list view + add form + per-row archive. No edit (nickname-only edit
 * is API-supported but not surfaced yet — Nic asks for it later if needed).
 * Routing/account numbers are immutable; a number change = add new + archive
 * old.
 *
 * Account numbers are encrypted at rest server-side. UI only ever sees the
 * last4. The full number is decrypted at payout fire time and via a
 * super_admin reveal flow.
 */

import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Landmark, Plus, X, Check, Archive } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import {
  ACCOUNT_TYPE_VALUES,
  ACCOUNT_HOLDER_TYPE_VALUES,
  AccountType,
  AccountHolderType,
  connectRequirementLabels,
} from '@gam/shared'
import { loadConnectAndInitialize } from '@stripe/connect-js'
import type { StripeConnectInstance } from '@stripe/connect-js'
import {
  ConnectAccountOnboarding, ConnectComponentsProvider,
} from '@stripe/react-connect-js'
import { appConfirm } from '../components/dialogs'
import { EntityPicker } from '../components/EntityPicker'

interface BankAccountRow {
  id: string
  nickname: string
  accountHolderName: string
  accountHolderType: AccountHolderType
  accountType: AccountType
  routingNumber: string
  accountNumberLast4: string
  status: 'active' | 'archived'
  createdAt: string
}

const lbl: React.CSSProperties = {
  fontSize: '.72rem',
  fontWeight: 600,
  color: 'var(--text-3)',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  display: 'block',
  marginBottom: 5,
}

export function BankingPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [showAdd, setShowAdd] = useState(false)

  // S168: managers landing on /banking after the landlord enabled their
  // direct deposit toggle only need the Stripe Connect onboarding pane.
  // The legacy 16a per-user bank-account catalog is a landlord-only
  // construct (used for historical / manual ledger payouts under the
  // GAM-rail era) — irrelevant to managers, who are paid only via the
  // Connect destination Transfer path.
  const isManager = user?.role === 'property_manager'

  const { data: accounts = [], isLoading } = useQuery<BankAccountRow[]>(
    'bank-accounts', () => apiGet('/bank-accounts'),
    { enabled: !isManager }
  )

  const archiveMut = useMutation(
    (id: string) => apiPost(`/bank-accounts/${id}/archive`),
    { onSuccess: () => qc.invalidateQueries('bank-accounts') }
  )

  if (isManager) {
    return (
      <div style={{ padding: '24px 32px', maxWidth: 960, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <Landmark size={22} color="var(--gold)" />
          <h1 style={{ fontSize: '1.4rem', fontWeight: 600, margin: 0 }}>Disbursement Account</h1>
        </div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
          Your landlord has enabled direct deposit on your account. Link your
          bank account below so your manager fees can be paid out. Once set up,
          every rent payment you're cut from will deposit to your bank
          automatically.
        </div>
        <StripeConnectSection />
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Landmark size={22} color="var(--gold)" />
          <h1 style={{ fontSize: '1.4rem', fontWeight: 600, margin: 0 }}>Disbursement Account</h1>
        </div>
        {(
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={14} /> Add Account
          </button>
        )}
      </div>

      {/* S160: Stripe Connect Express onboarding section. Sits above the
            legacy 16a bank account catalog — under S113 destination charges,
            Stripe Connect IS the rail and the bank catalog stays for
            historical/manual ledger payouts. */}
      <StripeConnectSection />

      {/* S605 (Nic): this list is NOT the payout account and never was — rent
          pays out through Stripe Connect (jobs/autoPayouts.ts fires
          stripe.payouts.create against the Connect account; it never reads this
          table). It exists for advanced multi-owner allocation splits. Sitting
          directly under a completed Stripe section with an empty state reading
          "Add one to start routing rent payouts", it looked like the Stripe
          onboarding hadn't saved and the landlord had to enter their bank a
          second time. Say plainly that it's optional. */}
      <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 18, lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--text-2)' }}>Optional — most landlords never need this.</strong>{' '}
        Rent already pays out to the account you gave Stripe above. Accounts added here are only
        for splitting a property's income between multiple owners. Routing and account numbers
        can't be edited once saved; to change one, add a new account and archive the old one.
      </div>

      {isLoading && <div style={{ color: 'var(--text-3)' }}>Loading…</div>}

      {!isLoading && accounts.length === 0 && (
        <div style={{
          padding: '32px 24px', textAlign: 'center',
          background: 'var(--bg-1)', border: '1px solid var(--border-0)',
          borderRadius: 12, color: 'var(--text-3)', fontSize: '.85rem'
        }}>
          Nothing here, and that's normal — your rent payouts are already set up through Stripe above.
        </div>
      )}

      {!isLoading && accounts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {accounts.map(a => (
            <div key={a.id} style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              alignItems: 'center', gap: 12,
              padding: '14px 16px',
              background: a.status === 'archived' ? 'var(--bg-1)' : 'var(--bg-2)',
              border: '1px solid var(--border-0)',
              borderRadius: 10,
              opacity: a.status === 'archived' ? 0.6 : 1,
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, fontSize: '.95rem' }}>{a.nickname}</span>
                  <span style={{
                    fontSize: '.65rem',
                    padding: '2px 7px',
                    borderRadius: 4,
                    textTransform: 'uppercase',
                    letterSpacing: '.05em',
                    background: a.accountHolderType === 'business' ? 'rgba(201,162,39,.12)' : 'rgba(255,255,255,.06)',
                    color: a.accountHolderType === 'business' ? 'var(--gold)' : 'var(--text-3)',
                  }}>{a.accountHolderType}</span>
                  {a.status === 'archived' && (
                    <span style={{
                      fontSize: '.65rem',
                      padding: '2px 7px',
                      borderRadius: 4,
                      textTransform: 'uppercase',
                      letterSpacing: '.05em',
                      background: 'rgba(255,71,87,.1)',
                      color: 'var(--red)',
                    }}>archived</span>
                  )}
                </div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                  {a.accountHolderName} • {a.accountType} •••• {a.accountNumberLast4}
                </div>
              </div>
              {a.status === 'active' && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    appConfirm(`Archive "${a.nickname}"? This cannot be undone.`, { danger: true, confirmLabel: 'Archive' }).then(ok => { if (ok) archiveMut.mutate(a.id) })
                  }}
                  disabled={archiveMut.isLoading}
                  title="Archive"
                >
                  <Archive size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {showAdd && <AddBankAccountModal onClose={() => setShowAdd(false)} />}
    </div>
  )
}

function AddBankAccountModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [form, setForm] = useState({
    nickname: '',
    accountHolderName: '',
    accountHolderType: 'individual' as AccountHolderType,
    accountType: 'checking' as AccountType,
    routingNumber: '',
    accountNumber: '',
    confirm_accountNumber: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const mut = useMutation(
    (data: any) => apiPost('/bank-accounts', data),
    {
      onSuccess: () => { qc.invalidateQueries('bank-accounts'); onClose() },
      onError: (e: any) => {
        setErrors({ submit: e?.response?.data?.error || 'Failed to add account' })
      },
    }
  )

  const submit = () => {
    const errs: Record<string, string> = {}
    if (!form.nickname.trim()) errs.nickname = 'Required'
    if (!form.accountHolderName.trim()) errs.accountHolderName = 'Required'
    if (!/^\d{9}$/.test(form.routingNumber.replace(/\D/g, ''))) errs.routingNumber = 'Must be 9 digits'
    const acct = form.accountNumber.replace(/\D/g, '')
    if (acct.length < 4 || acct.length > 17) errs.accountNumber = 'Must be 4–17 digits'
    if (form.accountNumber !== form.confirm_accountNumber) errs.confirm_accountNumber = 'Account numbers do not match'
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    mut.mutate({
      nickname: form.nickname.trim(),
      accountHolderName: form.accountHolderName.trim(),
      accountHolderType: form.accountHolderType,
      accountType: form.accountType,
      routingNumber: form.routingNumber.replace(/\D/g, ''),
      accountNumber: acct,
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>Add Bank Account</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Nickname <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--text-3)' }}>(e.g. "Acme Holdings LLC")</span></label>
          <input className="input" style={{ width: '100%' }} value={form.nickname}
            onChange={e => setForm(f => ({ ...f, nickname: e.target.value }))} />
          {errors.nickname && <div style={{ fontSize: '.7rem', color: 'var(--red)', marginTop: 4 }}>{errors.nickname}</div>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={lbl}>Holder Type</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {ACCOUNT_HOLDER_TYPE_VALUES.map(v => (
                <button key={v} type="button"
                  onClick={() => setForm(f => ({ ...f, accountHolderType: v }))}
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: '.78rem',
                    textTransform: 'capitalize',
                    border: `1px solid ${form.accountHolderType === v ? 'var(--gold)' : 'var(--border-0)'}`,
                    background: form.accountHolderType === v ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                    color: 'var(--text-0)',
                  }}>{v}</button>
              ))}
            </div>
          </div>
          <div>
            <label style={lbl}>Account Type</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {ACCOUNT_TYPE_VALUES.map(v => (
                <button key={v} type="button"
                  onClick={() => setForm(f => ({ ...f, accountType: v }))}
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: '.78rem',
                    textTransform: 'capitalize',
                    border: `1px solid ${form.accountType === v ? 'var(--gold)' : 'var(--border-0)'}`,
                    background: form.accountType === v ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                    color: 'var(--text-0)',
                  }}>{v}</button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Account Holder Name</label>
          <input className="input" style={{ width: '100%' }} value={form.accountHolderName}
            placeholder={form.accountHolderType === 'business' ? 'Legal entity name' : 'Full name on account'}
            onChange={e => setForm(f => ({ ...f, accountHolderName: e.target.value }))} />
          {errors.accountHolderName && <div style={{ fontSize: '.7rem', color: 'var(--red)', marginTop: 4 }}>{errors.accountHolderName}</div>}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Routing Number (9 digits)</label>
          <input className="input" style={{ width: '100%' }} value={form.routingNumber}
            inputMode="numeric" maxLength={9}
            onChange={e => setForm(f => ({ ...f, routingNumber: e.target.value }))} />
          {errors.routingNumber && <div style={{ fontSize: '.7rem', color: 'var(--red)', marginTop: 4 }}>{errors.routingNumber}</div>}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Account Number</label>
          <input className="input" style={{ width: '100%' }} value={form.accountNumber}
            inputMode="numeric"
            onChange={e => setForm(f => ({ ...f, accountNumber: e.target.value }))} />
          {errors.accountNumber && <div style={{ fontSize: '.7rem', color: 'var(--red)', marginTop: 4 }}>{errors.accountNumber}</div>}
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Confirm Account Number</label>
          <input className="input" style={{ width: '100%' }} value={form.confirm_accountNumber}
            inputMode="numeric"
            onChange={e => setForm(f => ({ ...f, confirm_accountNumber: e.target.value }))} />
          {errors.confirm_accountNumber && <div style={{ fontSize: '.7rem', color: 'var(--red)', marginTop: 4 }}>{errors.confirm_accountNumber}</div>}
        </div>

        {errors.submit && (
          <div style={{ color: 'var(--red)', fontSize: '.78rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            {errors.submit}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={mut.isLoading}>
            {mut.isLoading ? <span className="spinner" /> : <><Check size={14} /> Add Account</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// S160: Stripe Connect Express embedded onboarding for landlords. Mirrors
// the PM portal BankingPage pattern. Uses the existing shared endpoints at
// /api/stripe/connect/onboarding-session (entity='user') and
// /api/stripe/connect/status?entity=user.
function StripeConnectSection() {
  const PUB_KEY = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [connectInstance, setConnectInstance] = useState<StripeConnectInstance | null>(null)
  const [initErr, setInitErr] = useState<string | null>(null)
  const qc = useQueryClient()
  const { user } = useAuth()

  // S554 Connect re-anchor: an OWNER landlord onboards the landlord ENTITY's
  // own account (entity='landlord', entityId = their landlords.id = profileId).
  // Scoped WORKERS (managers with a direct-deposit opt-in) still onboard their
  // OWN user account (entity='user') — switching them would 403 on the live
  // membership check and break manager direct deposit.
  const isOwner = user?.role === 'landlord'
  // S629 (Nic): this was pinned to profileId, so a landlord with two LLCs saw
  // and onboarded exactly one of them — the other could never link a bank at
  // all. Banking is per entity, so the entity is a choice on this page.
  const [entityId, setEntityId] = useState<string>(isOwner ? (user?.profileId ?? '') : '')
  const connectEntity = isOwner ? 'landlord' : 'user'
  const connectEntityQS = isOwner ? `entity=landlord&entityId=${entityId}` : 'entity=user'
  const connectOnboardBody = isOwner
    ? { entity: 'landlord', entityId }
    : { entity: 'user' }

  const statusQ = useQuery<{
    connectAccountId: string | null
    exists: boolean
    chargesEnabled?: boolean
    payoutsEnabled?: boolean
    detailsSubmitted?: boolean
    requirementsCurrentlyDue?: string[]
    payoutBank?: { bankName: string | null; last4: string | null } | null
  }>(
    ['stripe-connect-status', connectEntity, entityId],
    () => apiGet(`/stripe/connect/status?${connectEntityQS}`),
    {
      refetchInterval: (data) =>
        showOnboarding && !(data?.payoutsEnabled && data?.detailsSubmitted)
          ? 3000 : false,
    },
  )

  const ready = !!statusQ.data?.payoutsEnabled && !!statusQ.data?.detailsSubmitted

  useEffect(() => {
    if (!showOnboarding) qc.invalidateQueries('stripe-connect-status')
  }, [showOnboarding, qc])

  const startOnboarding = async () => {
    setInitErr(null)
    try {
      if (!PUB_KEY) throw new Error('VITE_STRIPE_PUBLISHABLE_KEY is not configured.')
      const instance = await loadConnectAndInitialize({
        publishableKey: PUB_KEY,
        fetchClientSecret: async () => {
          const r = await apiPost<{ connectAccountId: string; clientSecret: string }>(
            '/stripe/connect/onboarding-session',
            connectOnboardBody,
          )
          return r.data!.clientSecret
        },
      })
      setConnectInstance(instance)
      setShowOnboarding(true)
    } catch (e: any) {
      setInitErr(e?.response?.data?.error?.message || e?.message || 'Failed to start onboarding')
    }
  }

  const statusLabel = useMemo(() => {
    if (ready)                            return { tone: 'green', text: 'Ready' }
    if (statusQ.data?.exists)             return { tone: 'gold',  text: statusQ.data?.detailsSubmitted ? 'Verifying…' : 'Onboarding incomplete' }
    return { tone: 'gold', text: 'Not started' }
  }, [ready, statusQ.data])

  return (
    <div className="card" style={{ padding: 16, marginBottom: 18 }}>
      {/* S629: which LLC is being verified and paid. Every figure and every
          status below belongs to the entity selected here — and with one
          entity it renders nothing, so the common case is unchanged. */}
      {isOwner && <EntityPicker value={entityId} onChange={setEntityId} label="Paying out for" />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          {/* S605 (Nic): this said "Bank Account" / "Link your bank account",
              so landlords expected a routing-number form and were blindsided by
              Stripe asking for an EIN, a date of birth and an SSN. Naming it
              honestly up front is the whole fix — "if I don't know how to do
              what I need to do, that's where the friction lives." */}
          <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Verify your business &amp; get paid</div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4 }}>
            {ready
              ? (statusQ.data?.payoutBank?.last4
                  ? `You're all set. Rent deposits to ${statusQ.data.payoutBank.bankName ?? 'your bank'} ••${statusQ.data.payoutBank.last4}.`
                  : "You're all set. Rent deposits to the account you gave Stripe.")
              : 'Required before tenants can pay rent. Stripe (our payments partner) verifies who you are, then you add the account rent gets deposited into.'}
          </div>
        </div>
        <span style={{
          padding: '4px 12px', borderRadius: 14, fontSize: '.74rem', fontWeight: 600,
          background: statusLabel.tone === 'green' ? 'rgba(38,167,90,.16)' : 'rgba(220,165,40,.16)',
          color: statusLabel.tone === 'green' ? 'var(--green, #2ea35a)' : 'var(--gold)',
          textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap',
        }}>{statusLabel.text}</span>
      </div>

      {(statusQ.data?.requirementsCurrentlyDue ?? []).length > 0 && (
        <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-2)', borderRadius: 6, fontSize: '.74rem', color: 'var(--text-2)' }}>
          {/* S605: these were printed as raw Stripe dot-paths
              ("individual.id_number, business_profile.mcc"), which told a
              landlord nothing about what to actually go and do. */}
          <strong style={{ color: 'var(--gold)' }}>Stripe still needs:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {connectRequirementLabels(statusQ.data?.requirementsCurrentlyDue ?? [])
              .map((r: string) => <li key={r} style={{ marginBottom: 2 }}>{r}</li>)}
          </ul>
        </div>
      )}

      {!ready && !showOnboarding && (
        <div style={{ marginTop: 14 }}>
          {/* Gathering an EIN mid-form is where people abandon. Say what to have
              to hand BEFORE the form opens. */}
          <div style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 12 }}>
            <div style={{ fontSize: '.76rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 6 }}>
              Have these ready — it takes about 10 minutes:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.7 }}>
              <li>Your business legal name and <strong>EIN</strong> (or your SSN if you operate as an individual)</li>
              <li>Business address and phone</li>
              <li>Your date of birth, home address, and the last 4 of your SSN — Stripe verifies a real person is behind the account</li>
              <li>The <strong>routing and account number</strong> rent should be deposited into</li>
            </ul>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 8 }}>
              Handled by Stripe, not stored by GAM. Usually verified within minutes; occasionally Stripe asks for a photo ID.
            </div>
            {/* S605 (Nic): the one moment you leave this page is a small Stripe
                sign-in window (email + phone + a texted code). It is Stripe's
                anti-account-takeover step and cannot be turned off for our
                account type. Saying so up front stops it reading as "the app
                just threw me somewhere else". */}
            <div style={{ fontSize: '.72rem', color: 'var(--text-2)', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-0)' }}>
              <strong style={{ color: 'var(--text-1)' }}>One quick step first:</strong> Stripe opens a small window asking for
              your email and phone, then texts you a code. That's just to confirm it's you —
              after that, the rest of the form happens right here without leaving GAM.
            </div>
          </div>
          <button className="btn btn-primary" onClick={startOnboarding}>
            {statusQ.data?.exists ? 'Continue verification' : 'Start verification'}
          </button>
          {initErr && (
            <div style={{ marginTop: 8, fontSize: '.74rem', color: 'var(--red, #dc4c4c)' }}>{initErr}</div>
          )}
        </div>
      )}

      {showOnboarding && connectInstance && (
        <div style={{ marginTop: 16 }}>
          <ConnectComponentsProvider connectInstance={connectInstance}>
            <ConnectAccountOnboarding onExit={() => setShowOnboarding(false)} />
          </ConnectComponentsProvider>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }}
                  onClick={() => setShowOnboarding(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}

