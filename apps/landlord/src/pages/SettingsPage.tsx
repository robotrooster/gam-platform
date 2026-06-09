import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch, apiPut, apiDelete } from '../lib/api'
import { Check, DollarSign, Trash2, X } from 'lucide-react'

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

export function SettingsPage() {
  const qc = useQueryClient()
  const { data: me, isLoading } = useQuery<any>('landlord-me', () => apiGet('/landlords/me'))

  const [threshold, setThreshold] = useState<string>('')
  const [earlyTermMonths, setEarlyTermMonths] = useState<string>('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (me) {
      setThreshold(me.maintApprovalThreshold != null ? String(me.maintApprovalThreshold) : '500')
      setEarlyTermMonths(
        me.defaultEarlyTerminationMonthsRent != null
          ? String(me.defaultEarlyTerminationMonthsRent)
          : '',
      )
    }
  }, [me])

  const saveMut = useMutation(
    () => apiPatch('/landlords/me', {
      maintApprovalThreshold: Number(threshold),
      defaultEarlyTerminationMonthsRent: earlyTermMonths === '' ? null : Number(earlyTermMonths),
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('landlord-me')
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      }
    }
  )

  const thresholdNum = Number(threshold)
  const thresholdValid = !isNaN(thresholdNum) && thresholdNum >= 0
  const earlyTermNum = earlyTermMonths === '' ? null : Number(earlyTermMonths)
  const earlyTermValid = earlyTermMonths === '' || (!isNaN(Number(earlyTermMonths)) && Number(earlyTermMonths) >= 0)
  const thresholdChanged = me && (
    Number(me.maintApprovalThreshold || 500) !== thresholdNum ||
    (me.defaultEarlyTerminationMonthsRent ?? null) !== earlyTermNum
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Account and property configuration</p>
        </div>
      </div>

      {isLoading ? (
        <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>

          {/* Account */}
          <div className="card">
            <div className="card-header"><span className="card-title">Account</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Business Name</div>
                <div style={{ fontWeight: 500 }}>{me?.businessName || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>EIN</div>
                <div className="mono">{me?.ein || '—'}</div>
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
          </div>

          {/* Billing */}
          <div className="card">
            <div className="card-header"><span className="card-title">Billing</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 4 }}>Volume Tier</div>
                <div><span className="badge badge-green">{me?.volumeTier || 'standard'}</span></div>
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

          {/* Maintenance Approval */}
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

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => saveMut.mutate()}
                  disabled={!thresholdValid || !earlyTermValid || !thresholdChanged || saveMut.isLoading}
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

          {/* Default Early-Termination Policy */}
          <div className="card">
            <div className="card-header"><span className="card-title">Default Early-Termination Policy</span></div>
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
                Default early-termination fee for leases that don't specify one in writing.
                Expressed as a multiplier of monthly rent (e.g. 1.0 = one month's rent, 1.5 = one and a half months).
                Lease-specific clauses always override this default. Leave blank for no default policy
                (tenants will see "contact your landlord" if their lease has no clause).
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
                  Months of Rent
                </label>
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="0.25"
                  value={earlyTermMonths}
                  onChange={e => setEarlyTermMonths(e.target.value)}
                  placeholder="e.g. 1.0"
                  style={{ width: '100%' }}
                />
                <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 6 }}>
                  {earlyTermMonths
                    ? `On a $1,500 rent: ${(Number(earlyTermMonths) * 1500).toFixed(2)} fee`
                    : 'No default — tenants see "contact landlord" when no lease clause'}
                </div>
              </div>
            </div>
          </div>

          {/* Default PM Company (S157) */}
          <DefaultPmCompanyCard
            currentDefaultId={me?.defaultPmCompanyId ?? null}
            onChange={() => qc.invalidateQueries('landlord-me')}
          />

          {/* Deposit Interest Overrides (S190) */}
          <DepositInterestOverridesCard />

          {/* Notifications placeholder */}
          <div className="card">
            <div className="card-header"><span className="card-title">Notifications</span></div>
            <div style={{ color: 'var(--text-3)', fontSize: '.88rem', marginTop: 12 }}>
              See <a href="/notification-prefs">Notification Preferences</a> in the sidebar.
            </div>
          </div>
        </div>
      )}
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

// S190: Deposit interest rate overrides for variable-rate states
// (NY/NJ/CT/IL/PA/NH and others). Statutory hardcoded states (MA, MD,
// MN as of S188) take precedence; this UI is for entering rates the
// platform can't hardcode because they depend on the landlord's bank.
type Override = {
  stateCode:      string
  effectiveYear:  number
  annualRatePct: string
  sourceNotes:    string | null
  updatedAt:      string
}

const VARIABLE_STATE_HINTS: Record<string, string> = {
  NY: 'NY: bank passbook rate (RPL § 7-103). Look up your escrow account’s current rate.',
  NJ: 'NJ: bank rate minus 1% admin fee (NJSA § 46:8-19).',
  CT: 'CT: state-published rate, updated annually by the Banking Commissioner.',
  IL: 'IL: actual interest earned (or higher of statutory minimum if applicable).',
  PA: 'PA: bank passbook rate, escrow account required for deposits ≥ $100.',
  NH: 'NH: rate held in escrow (must equal at least bank-paid rate).',
}

function DepositInterestOverridesCard() {
  const qc = useQueryClient()
  const { data: rows = [], isLoading } = useQuery<Override[]>(
    'deposit-interest-overrides',
    () => apiGet<Override[]>('/landlords/me/deposit-interest-overrides'),
  )

  const [showAdd, setShowAdd] = useState(false)
  const [stateCode, setStateCode] = useState('')
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [rate, setRate] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const upsertMut = useMutation(
    (body: any) => apiPut('/landlords/me/deposit-interest-overrides', body),
    {
      onSuccess: () => {
        qc.invalidateQueries('deposit-interest-overrides')
        setShowAdd(false)
        setStateCode(''); setRate(''); setNotes('')
        setError(null)
      },
      onError: (e: any) => {
        setError(e?.response?.data?.error?.message || 'Failed to save')
      },
    },
  )

  const deleteMut = useMutation(
    ({ state, year }: { state: string; year: number }) =>
      apiDelete(`/landlords/me/deposit-interest-overrides/${state}/${year}`),
    {
      onSuccess: () => qc.invalidateQueries('deposit-interest-overrides'),
    },
  )

  const handleSubmit = () => {
    setError(null)
    const yr = parseInt(year, 10)
    const rt = parseFloat(rate)
    if (!stateCode || stateCode.length !== 2) {
      setError('State code must be 2 letters')
      return
    }
    if (isNaN(yr) || yr < 2020 || yr > 2100) {
      setError('Year must be between 2020 and 2100')
      return
    }
    if (isNaN(rt) || rt < 0 || rt > 100) {
      setError('Rate must be between 0 and 100')
      return
    }
    upsertMut.mutate({
      stateCode: stateCode.toUpperCase(),
      effectiveYear: yr,
      annualRatePct: rt,
      sourceNotes: notes.trim() || null,
    })
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Deposit Interest — Bank Rates</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
          For states where the deposit interest rate depends on your bank (NY, NJ, CT, IL, PA, NH and others),
          enter the rate here. The platform applies it to deposits in escrow at properties in those states.
          Statutory fixed-rate states (currently MA 5%, MD 1.5%, MN 1%) are hardcoded and don't need entry.
        </div>

        {isLoading ? (
          <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 6, color: 'var(--text-3)', fontSize: '.82rem', marginBottom: 12 }}>
            No overrides set. Add one if you have properties in a variable-rate state.
          </div>
        ) : (
          <table className="data-table" style={{ width: '100%', marginBottom: 12 }}>
            <thead>
              <tr>
                <th>State</th>
                <th>Year</th>
                <th>Rate</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.stateCode}-${r.effectiveYear}`}>
                  <td className="mono"><strong>{r.stateCode}</strong></td>
                  <td>{r.effectiveYear}</td>
                  <td className="mono">{Number(r.annualRatePct).toFixed(4)}%</td>
                  <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                    {r.sourceNotes || '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--red)' }}
                      onClick={() => deleteMut.mutate({ state: r.stateCode, year: r.effectiveYear })}
                      disabled={deleteMut.isLoading}
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!showAdd ? (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAdd(true)}>
            + Add override
          </button>
        ) : (
          <div style={{ background: 'var(--bg-2)', padding: 14, borderRadius: 8, border: '1px solid var(--border-0)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '90px 110px 130px 1fr', gap: 10, marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 4 }}>State</label>
                <input
                  className="input"
                  type="text"
                  maxLength={2}
                  value={stateCode}
                  onChange={(e) => setStateCode(e.target.value.toUpperCase())}
                  placeholder="NY"
                  style={{ textTransform: 'uppercase' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 4 }}>Year</label>
                <input
                  className="input"
                  type="number"
                  min="2020"
                  max="2100"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                />
              </div>
              <div>
                <label style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 4 }}>Rate (%)</label>
                <input
                  className="input"
                  type="number"
                  step="0.0001"
                  min="0"
                  max="100"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="1.5"
                />
              </div>
              <div>
                <label style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 4 }}>Notes (optional)</label>
                <input
                  className="input"
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Chase passbook rate as of Jan 2026"
                />
              </div>
            </div>
            {stateCode.length === 2 && VARIABLE_STATE_HINTS[stateCode] && (
              <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 10, padding: 8, background: 'var(--bg-1)', borderRadius: 4 }}>
                {VARIABLE_STATE_HINTS[stateCode]}
              </div>
            )}
            {error && (
              <div style={{ color: 'var(--red)', fontSize: '.78rem', marginBottom: 10 }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSubmit}
                disabled={upsertMut.isLoading}
              >
                {upsertMut.isLoading ? '…' : 'Save'}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => { setShowAdd(false); setError(null) }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
