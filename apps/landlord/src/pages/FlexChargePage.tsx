/**
 * S254: Landlord FlexCharge dashboard.
 *
 * Per-property accounts list + balances + per-account suspend / edit
 * limit + create-new-account form. POS customer roster CRUD. Replaces
 * the legacy per-tenant FlexChargePanel that was tied to a one-account-
 * per-tenant model.
 *
 * Scope deliberately minimal — power-user view rather than a polished
 * dashboard. Iterating on read flows + actions; statement history
 * deferred to a follow-up.
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { CreditCard, Plus } from 'lucide-react'
import { apiGet, apiPost, apiPatch, apiDel } from '../lib/api'

interface AccountRow {
  id:                  string
  tenantId:           string | null
  posCustomerId:     string | null
  propertyId:         string
  creditLimit:        string
  status:              'active' | 'suspended' | 'disqualified'
  disqualifiedReason: string | null
  notes:               string | null
  customerName:       string | null
  customerEmail:      string | null
  balance:             number
}

interface PosCustomerRow {
  id:           string
  firstName:    string
  lastName:     string
  email:        string
  phone:        string | null
  achVerified:  boolean
  bankLast4:    string | null
  stripeCustomerId: string | null
}

interface Property {
  id:                string
  name:              string
  // S309 / S312: per-Location FlexCharge enablement gate. The schema
  // column is `flexcharge_enabled`; after the S312 response-interceptor
  // transform (packages/shared/src/camelize.ts) the frontend reads it
  // as `flexchargeEnabled`. Properties with the flag off are hidden
  // from the create-account dropdown — the backend rejects creation
  // against them anyway, so showing them would only produce a 403 on
  // submit.
  flexchargeEnabled: boolean
}

interface Tenant {
  id:        string
  firstName: string
  lastName:  string
  email:     string
}

const fmt = (n: any) => '$' + Number(n || 0).toFixed(2)

export function FlexChargePage() {
  const qc = useQueryClient()
  const [propertyFilter, setPropertyFilter] = useState<string>('')
  const [showCreate, setShowCreate] = useState(false)
  const [showNewCustomer, setShowNewCustomer] = useState(false)

  const { data: properties = [] } = useQuery<Property[]>('properties', () => apiGet('/properties'))
  const { data: tenants    = [] } = useQuery<Tenant[]>('tenants', () => apiGet('/tenants'))
  const { data: posCustomers = [] } = useQuery<PosCustomerRow[]>('pos-customers', () => apiGet('/landlords/pos-customers'))

  // S309: properties enabled for FlexCharge creation. The full `properties`
  // list is still used for the filter chips and the existing-account table
  // (those reflect existing accounts which may sit on properties that have
  // since been disabled). New-account creation is restricted to enabled
  // properties — the backend gates this, and we hide the disabled ones to
  // avoid a guaranteed 403 on submit.
  const enabledProperties = properties.filter(p => p.flexchargeEnabled)

  const { data: accounts = [] } = useQuery<AccountRow[]>(
    ['flex-charge-accounts', propertyFilter],
    () => apiGet('/landlords/flex-charge/accounts' + (propertyFilter ? `?propertyId=${propertyFilter}` : '')),
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CreditCard size={22} /> FlexCharge
          </h1>
          <p className="page-sub">Per-property charge accounts for tenants and POS customers. The account holder pays a 1.5% finance charge on their outstanding monthly balance, paid to you (the account owner) — GAM provides the software, not the credit.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setShowNewCustomer(true)}>+ POS Customer</button>
          <button
            className="btn btn-primary"
            onClick={() => setShowCreate(true)}
            disabled={enabledProperties.length === 0}
            title={enabledProperties.length === 0
              ? 'No properties have FlexCharge enabled. Enable FlexCharge on at least one property from the property settings before creating an account.'
              : undefined}
          >
            <Plus size={14}/> New Account
          </button>
        </div>
      </div>
      {enabledProperties.length === 0 && properties.length > 0 && (
        <div style={{
          marginBottom: 14,
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid var(--border-0)',
          background: 'var(--bg-2)',
          fontSize: '.78rem',
          color: 'var(--text-2)',
          lineHeight: 1.5,
        }}>
          FlexCharge is not enabled on any of your properties. Open the property settings on the property where
          you want to offer a rolling charge account and toggle <strong>Offer FlexCharge at this property</strong>.
        </div>
      )}

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        <button onClick={() => setPropertyFilter('')} style={chipStyle(propertyFilter === '')}>All ({accounts.length})</button>
        {properties.map(p => (
          <button key={p.id} onClick={() => setPropertyFilter(p.id)} style={chipStyle(propertyFilter === p.id)}>
            {p.name}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        {accounts.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
            No FlexCharge accounts yet. Click "New Account" to enroll a customer.
          </div>
        ) : (
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Property</th>
                <th>Credit limit</th>
                <th>Balance</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => {
                const prop = properties.find(p => p.id === a.propertyId)
                return (
                  <tr key={a.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{a.customerName || '(unknown)'}</div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{a.customerEmail}</div>
                      <div style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>{a.tenantId ? 'Tenant' : 'POS customer'}</div>
                    </td>
                    <td style={{ fontSize: '.82rem' }}>{prop?.name || a.propertyId.slice(0, 8)}</td>
                    <td className="mono">{fmt(a.creditLimit)}</td>
                    <td className="mono" style={{ fontWeight: 600, color: 'var(--gold)' }}>{fmt(a.balance)}</td>
                    <td>
                      <span className={`badge ${a.status === 'active' ? 'badge-green' : a.status === 'suspended' ? 'badge-amber' : 'badge-red'}`}>{a.status}</span>
                      {a.status === 'disqualified' && a.disqualifiedReason && (
                        <div style={{ fontSize: '.65rem', color: 'var(--red)', marginTop: 2 }}>
                          {a.disqualifiedReason === 'tenant_dispute' ? 'customer dispute' : a.disqualifiedReason}
                        </div>
                      )}
                    </td>
                    <td>
                      <AccountActions account={a} qc={qc} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* S258: POS customer roster — show ACH status + onboarding action */}
      {posCustomers.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ marginBottom: 10, fontSize: '.78rem', color: 'var(--text-2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            POS Customers ({posCustomers.length})
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Bank</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {posCustomers.map(c => (
                  <PosCustomerActionsRow key={c.id} customer={c} qc={qc} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateAccountModal
          properties={enabledProperties}
          tenants={tenants}
          posCustomers={posCustomers}
          onClose={() => setShowCreate(false)}
          onSuccess={() => { qc.invalidateQueries('flex-charge-accounts'); setShowCreate(false) }}
        />
      )}
      {showNewCustomer && (
        <NewPosCustomerModal
          onClose={() => setShowNewCustomer(false)}
          onSuccess={() => { qc.invalidateQueries('pos-customers'); setShowNewCustomer(false) }}
        />
      )}
    </div>
  )
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    borderRadius: 14,
    border: active ? '1px solid var(--gold)' : '1px solid var(--border-0)',
    background: active ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
    color: active ? 'var(--gold)' : 'var(--text-2)',
    cursor: 'pointer',
    fontSize: '.8rem',
    fontWeight: 600,
  }
}

// S258: per-customer row with ACH-onboarding action
function PosCustomerActionsRow({ customer, qc }: { customer: PosCustomerRow; qc: any }) {
  const [sentAt, setSentAt] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const sendMut = useMutation(
    () => apiPost(`/landlords/pos-customers/${customer.id}/send-onboarding`),
    {
      onSuccess: (r: any) => {
        setSentAt(r?.data?.expiresAt || new Date().toISOString())
        setErr(null)
        qc.invalidateQueries('pos-customers')
      },
      onError: (e: any) => setErr(e?.response?.data?.error?.message || 'Send failed'),
    },
  )
  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600 }}>{customer.firstName} {customer.lastName}</div>
        <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{customer.email}</div>
      </td>
      <td className="mono" style={{ fontSize: '.78rem' }}>
        {customer.bankLast4 ? '•••• ' + customer.bankLast4 : <span style={{ color: 'var(--text-3)' }}>—</span>}
      </td>
      <td>
        {customer.achVerified ? (
          <span className="badge badge-green">✓ Verified</span>
        ) : sentAt ? (
          <span className="badge badge-amber">Invite sent · expires {new Date(sentAt).toLocaleDateString()}</span>
        ) : (
          <span className="badge badge-muted">Not verified</span>
        )}
        {err && <div style={{ fontSize: '.7rem', color: 'var(--red)', marginTop: 4 }}>{err}</div>}
      </td>
      <td>
        {!customer.achVerified && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => sendMut.mutate()}
            disabled={sendMut.isLoading}
          >
            {sendMut.isLoading ? 'Sending…' : sentAt ? 'Resend invite' : 'Send onboarding'}
          </button>
        )}
      </td>
    </tr>
  )
}

function AccountActions({ account, qc }: { account: AccountRow; qc: any }) {
  const [showStatements, setShowStatements] = useState(false)
  const suspendMut = useMutation(
    () => apiPatch(`/landlords/flex-charge/accounts/${account.id}`, { status: 'suspended' }),
    { onSuccess: () => qc.invalidateQueries('flex-charge-accounts') },
  )
  const activateMut = useMutation(
    () => apiPatch(`/landlords/flex-charge/accounts/${account.id}`, { status: 'active' }),
    { onSuccess: () => qc.invalidateQueries('flex-charge-accounts') },
  )
  const editLimit = async () => {
    const v = window.prompt('New credit limit:', account.creditLimit)
    if (!v) return
    const n = parseFloat(v)
    if (!Number.isFinite(n) || n < 0) return
    await apiPatch(`/landlords/flex-charge/accounts/${account.id}`, { creditLimit: n })
    qc.invalidateQueries('flex-charge-accounts')
  }
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button className="btn btn-ghost btn-sm" onClick={() => setShowStatements(true)}>Statements</button>
      <button className="btn btn-ghost btn-sm" onClick={editLimit}>Edit limit</button>
      {account.status === 'active' ? (
        <button className="btn btn-ghost btn-sm" onClick={() => suspendMut.mutate()} style={{ color: 'var(--amber)' }}>Suspend</button>
      ) : account.status === 'suspended' ? (
        <button className="btn btn-ghost btn-sm" onClick={() => activateMut.mutate()} style={{ color: 'var(--green)' }}>Reactivate</button>
      ) : null}
      {showStatements && (
        <StatementHistoryModal account={account} onClose={() => setShowStatements(false)} />
      )}
    </div>
  )
}

interface StatementRow {
  id:            string
  cycleMonth:   string
  balance:       string
  serviceFee:   string
  totalDue:     string
  dueDate:      string
  status:        'open' | 'billed' | 'paid' | 'failed' | 'voided'
  billedAt:     string | null
  settledAt:    string | null
  failedReason: string | null
}

interface DisputeRow {
  id:             string
  amount:         string
  disputedAt:    string
  disputeReason: string
  createdAt:     string
}

function StatementHistoryModal({ account, onClose }: { account: AccountRow; onClose: () => void }) {
  const { data, isLoading } = useQuery<{ statements: StatementRow[]; disputes: DisputeRow[] }>(
    ['flex-charge-statements', account.id],
    () => apiGet(`/landlords/flex-charge/accounts/${account.id}/statements`),
  )
  const statements = data?.statements || []
  const disputes = data?.disputes || []
  const statusBadge = (s: StatementRow['status']) => {
    const cls =
      s === 'paid' ? 'badge-green' :
      s === 'failed' ? 'badge-red' :
      s === 'billed' ? 'badge-amber' :
      s === 'voided' ? 'badge-muted' :
      'badge-muted'
    return <span className={`badge ${cls}`}>{s}</span>
  }
  const fmtMonth = (d: string) => {
    const [y, m] = d.split('-')
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  }
  const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString() : '—'
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 760 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Statements — {account.customerName}</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>x</button>
        </div>
        <div style={{ padding: '0 24px 24px' }}>
          {isLoading ? (
            <div style={{ padding: 24, color: 'var(--text-3)', textAlign: 'center' }}>Loading...</div>
          ) : (
            <>
              {disputes.length > 0 && (
                <div style={{ marginBottom: 18, padding: 12, background: 'rgba(220,60,50,.05)', border: '1px solid rgba(220,60,50,.2)', borderRadius: 6 }}>
                  <div style={{ fontSize: '.78rem', color: 'var(--red)', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                    Disputed charges ({disputes.length})
                  </div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {disputes.map(d => (
                      <div key={d.id} style={{ fontSize: '.78rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span className="mono" style={{ fontWeight: 600 }}>{fmt(d.amount)}</span>
                          <span style={{ color: 'var(--text-3)' }}>disputed {fmtDate(d.disputedAt)} · charged {fmtDate(d.createdAt)}</span>
                        </div>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-2)', marginTop: 2, fontStyle: 'italic' }}>
                          "{d.disputeReason}"
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {statements.length === 0 ? (
                <div style={{ padding: 24, color: 'var(--text-3)', textAlign: 'center' }}>
                  No statements yet. Statements generate on the 1st of each month for any account with a non-zero balance.
                </div>
              ) : (
                <table className="data-table" style={{ width: '100%', fontSize: '.82rem' }}>
                  <thead>
                    <tr>
                      <th>Cycle</th>
                      <th className="mono">Balance</th>
                      <th className="mono">Fee</th>
                      <th className="mono">Total</th>
                      <th>Due</th>
                      <th>Status</th>
                      <th>Settled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statements.map(s => (
                      <tr key={s.id}>
                        <td>{fmtMonth(s.cycleMonth)}</td>
                        <td className="mono">{fmt(s.balance)}</td>
                        <td className="mono">{fmt(s.serviceFee)}</td>
                        <td className="mono" style={{ fontWeight: 600 }}>{fmt(s.totalDue)}</td>
                        <td>{fmtDate(s.dueDate)}</td>
                        <td>
                          {statusBadge(s.status)}
                          {s.status === 'failed' && s.failedReason && (
                            <div style={{ fontSize: '.7rem', color: 'var(--red)', marginTop: 2 }}>{s.failedReason}</div>
                          )}
                        </td>
                        <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{fmtDate(s.settledAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function CreateAccountModal({ properties, tenants, posCustomers, onClose, onSuccess }: {
  properties: Property[]; tenants: Tenant[]; posCustomers: PosCustomerRow[];
  onClose: () => void; onSuccess: () => void;
}) {
  const [customerType, setCustomerType] = useState<'tenant'|'pos_customer'>('tenant')
  const [tenantId, setTenantId] = useState('')
  const [posCustomerId, setPosCustomerId] = useState('')
  const [propertyId, setPropertyId] = useState(properties[0]?.id || '')
  const [creditLimit, setCreditLimit] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const create = useMutation(
    () => apiPost('/landlords/flex-charge/accounts', {
      tenantId:       customerType === 'tenant' ? tenantId : null,
      posCustomerId:  customerType === 'pos_customer' ? posCustomerId : null,
      propertyId,
      creditLimit:    creditLimit ? parseFloat(creditLimit) : undefined,
    }),
    {
      onSuccess,
      onError: (e: any) => setErr(e?.response?.data?.error?.message || 'Create failed'),
    },
  )
  const canSubmit = propertyId && (customerType === 'tenant' ? tenantId : posCustomerId)
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">New FlexCharge Account</span><button className="btn btn-ghost btn-sm" onClick={onClose}>x</button></div>
        <div style={{ padding: '0 24px 24px', display: 'grid', gap: 12 }}>
          <div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4 }}>Customer type</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {(['tenant','pos_customer'] as const).map(t => (
                <button key={t} type="button" onClick={() => setCustomerType(t)}
                  style={{ padding: 8, borderRadius: 6,
                    border: customerType === t ? '1px solid var(--gold)' : '1px solid var(--border-0)',
                    background: customerType === t ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                    color: customerType === t ? 'var(--gold)' : 'var(--text-2)',
                    cursor: 'pointer', fontSize: '.78rem', fontWeight: 600 }}>
                  {t === 'tenant' ? 'Tenant' : 'POS Customer'}
                </button>
              ))}
            </div>
          </div>
          {customerType === 'tenant' ? (
            <div>
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4 }}>Tenant</div>
              <select className="form-select" value={tenantId} onChange={e => setTenantId(e.target.value)} style={{ width: '100%' }}>
                <option value="">Select tenant...</option>
                {tenants.map(t => <option key={t.id} value={t.id}>{t.firstName} {t.lastName} — {t.email}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4 }}>POS customer</div>
              <select className="form-select" value={posCustomerId} onChange={e => setPosCustomerId(e.target.value)} style={{ width: '100%' }}>
                <option value="">Select customer...</option>
                {posCustomers.map(c => <option key={c.id} value={c.id}>{c.firstName} {c.lastName} — {c.email}</option>)}
              </select>
            </div>
          )}
          <div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4 }}>Property</div>
            <select className="form-select" value={propertyId} onChange={e => setPropertyId(e.target.value)} style={{ width: '100%' }}>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4 }}>Credit limit (blank = property default)</div>
            <input className="form-input" type="number" min={0} step={10} value={creditLimit} onChange={e => setCreditLimit(e.target.value)} style={{ width: '100%' }} placeholder="500.00" />
          </div>
          {err && <div style={{ color: 'var(--red)', fontSize: '.78rem' }}>{err}</div>}
          <button className="btn btn-primary" disabled={!canSubmit || create.isLoading} onClick={() => create.mutate()}>
            {create.isLoading ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </div>
    </div>
  )
}

function NewPosCustomerModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName]   = useState('')
  const [email, setEmail]         = useState('')
  const [phone, setPhone]         = useState('')
  const [err, setErr] = useState<string | null>(null)
  const create = useMutation(
    () => apiPost('/landlords/pos-customers', { firstName, lastName, email, phone: phone || null }),
    {
      onSuccess,
      onError: (e: any) => setErr(e?.response?.data?.error?.message || 'Create failed'),
    },
  )
  void apiDel
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">New POS Customer</span><button className="btn btn-ghost btn-sm" onClick={onClose}>x</button></div>
        <div style={{ padding: '0 24px 24px', display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <input className="form-input" placeholder="First name" value={firstName} onChange={e => setFirstName(e.target.value)} />
            <input className="form-input" placeholder="Last name" value={lastName} onChange={e => setLastName(e.target.value)} />
          </div>
          <input className="form-input" placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
          <input className="form-input" placeholder="Phone (optional)" value={phone} onChange={e => setPhone(e.target.value)} />
          {err && <div style={{ color: 'var(--red)', fontSize: '.78rem' }}>{err}</div>}
          <button className="btn btn-primary" disabled={!firstName || !lastName || !email || create.isLoading} onClick={() => create.mutate()}>
            {create.isLoading ? 'Creating…' : 'Create customer'}
          </button>
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
            The customer can be enrolled in a FlexCharge account at any of your properties from the main page.
          </div>
        </div>
      </div>
    </div>
  )
}
