/**
 * TYPING OLD MONEY IN, ONE PAYMENT AT A TIME (11/1, Nic).
 *
 *   "Build the way to type manual stuff in. People switching to gam may not use
 *    software so lots of stuff may go in manual."
 *
 * The CSV import assumes the operator is coming off other software and can
 * export a file. Plenty are coming off a paper ledger, and they have nothing to
 * upload — so the import alone leaves exactly the people who most need the help
 * with no way in.
 *
 * BUILT FOR A SHEET OF PAPER, which drives every choice here:
 *   - the space is the first field, because that is how a ledger is organised;
 *   - the date, amount and kind STAY PUT after each save, so working down a
 *     column of twelve lots is: pick space, type amount, Enter. Only the space
 *     and the amount clear;
 *   - every saved line is listed underneath with an Undo, because the mistake
 *     this invites is keying the wrong lot and noticing two rows later;
 *   - it says which way each one went — onto a resident's record, or against the
 *     space — before and after saving, since the two are different things.
 *
 * NOTHING HERE BILLS ANYBODY. It records money already collected: no invoice, no
 * charge left owed, nothing on a balance, nothing on GAM's fee. The copy says so
 * in those words, because an operator typing a rent figure into a property
 * system has every reason to fear it will go out as a bill.
 */
import { useState, useMemo, useRef, useEffect } from 'react'
import { useQuery, useMutation } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, AlertCircle, Undo2, Upload } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

type Space = {
  unitId: string
  unitNumber: string
  propertyId: string
  propertyName: string
  leaseId: string | null
  residentName: string | null
  residentEmail: string | null
  /** An active lease with nobody named on it — neither "a resident" nor "empty". */
  hasLeaseWithoutResident?: boolean
}

type Saved = {
  key: string
  where: 'lease' | 'space'
  said: string
  spaceLabel: string
  amount: number
  /** Only a space line can be undone on its own — see the note on Undo below. */
  batchId?: string | null
  undone?: boolean
}

const KINDS = [
  { v: 'rent', label: 'Rent' },
  { v: 'stay', label: 'Stay / nightly' },
  { v: 'utility', label: 'Utilities' },
  { v: 'deposit', label: 'Deposit' },
  { v: 'fee', label: 'Fee' },
  { v: 'late_fee', label: 'Late fee' },
  { v: 'other', label: 'Something else' },
]
const METHODS = ['cash', 'check', 'money order', 'card', 'bank transfer', 'other']

const money = (n: number) => `$${n.toFixed(2)}`

export function TypeInPastPaymentsPage() {
  const navigate = useNavigate()
  const { data: spaces, isLoading } = useQuery<Space[]>(
    'payment-history-spaces', () => apiGet<Space[]>('/landlords/me/payment-history/spaces'))

  const [unitId, setUnitId]   = useState('')
  const [onLease, setOnLease] = useState(true)
  const [payerName, setPayerName]   = useState('')
  const [payerPhone, setPayerPhone] = useState('')
  // These three persist between saves on purpose — a paper sheet is a column of
  // one month's rent, so re-typing the date twelve times is the whole friction.
  const [date, setDate]     = useState('')
  const [kind, setKind]     = useState('rent')
  const [method, setMethod] = useState('cash')
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<Saved[]>([])
  const amountRef = useRef<HTMLInputElement>(null)

  const space = useMemo(
    () => (spaces ?? []).find(s => s.unitId === unitId) ?? null, [spaces, unitId])

  // A space with nobody on it cannot go onto a resident's record, so the choice
  // is not offered and the form asks who paid instead.
  useEffect(() => {
    if (space && !space.leaseId) setOnLease(false)
    if (space && space.leaseId) setOnLease(true)
  }, [space?.unitId, space?.leaseId])

  const save = useMutation(
    () => apiPost<{ where: 'lease' | 'space'; said: string; batchId?: string }>(
      '/landlords/me/payment-history/manual', {
        unitId,
        leaseId: onLease && space?.leaseId ? space.leaseId : null,
        payerName: onLease ? null : (payerName.trim() || null),
        payerPhone: onLease ? null : (payerPhone.trim() || null),
        paymentDate: date,
        amount: Number(amount),
        paymentType: kind,
        paymentMethod: method || null,
        reference: reference.trim() || null,
      }),
    {
      onSuccess: (res: any) => {
        const d = res.data
        setSaved(prev => [{
          key: `${Date.now()}-${Math.random()}`,
          where: d.where, said: d.said,
          spaceLabel: space ? `${space.propertyName} ${space.unitNumber}` : '',
          amount: Number(amount),
          batchId: d.batchId ?? null,
        }, ...prev])
        setErr(null)
        // Only the two things that change line to line.
        setAmount('')
        setUnitId('')
        setReference('')
        amountRef.current?.blur()
      },
      onError: (e: any) => setErr(
        e?.response?.data?.error || e?.response?.data?.message || 'That could not be saved.'),
    })

  const undo = useMutation(
    (batchId: string) => apiPost('/landlords/me/payment-history/undo', { batchId }),
    { onSuccess: (_r, batchId) => setSaved(prev => prev.map(
        s => s.batchId === batchId ? { ...s, undone: true } : s)) })

  const ready = !!unitId && !!date && Number(amount) > 0
    && (onLease || !!payerName.trim() || !!payerPhone.trim() || true)

  const field: React.CSSProperties = {
    width: '100%', padding: '9px 11px', background: 'var(--bg-1)',
    border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text-0)', fontSize: '.92rem',
  }
  const label: React.CSSProperties = {
    display: 'block', fontSize: '.78rem', color: 'var(--text-2)',
    marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.03em',
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>Type in past payments</h1>
        <button className="btn" onClick={() => navigate('/payment-history-onboarding')}
          style={{ whiteSpace: 'nowrap' }}>
          <Upload size={14} /> Upload a file instead
        </button>
      </div>
      <p style={{ color: 'var(--text-2)', fontSize: '.88rem', marginTop: 0, marginBottom: 20, lineHeight: 1.5 }}>
        For money you already collected before coming to GAM — off a paper ledger, a
        receipt book, a spreadsheet you never exported. <strong>Nothing here bills anybody.</strong>{' '}
        No invoice goes out, nothing lands on anyone's balance, and no payment is pulled.
        It records what came in so your books are whole.
      </p>

      {err && (
        <div style={{
          padding: 12, marginBottom: 16, background: 'var(--bg-2)',
          borderLeft: '3px solid #dc2626', borderRadius: 6, fontSize: '.88rem',
          display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--text-0)',
        }}>
          <AlertCircle size={17} style={{ color: '#dc2626', flexShrink: 0, marginTop: 1 }} />
          <div>{err}</div>
        </div>
      )}

      <div style={{
        background: 'var(--bg-2)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 18, marginBottom: 22,
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={label}>Space</label>
            <select style={field} value={unitId} onChange={e => setUnitId(e.target.value)}
              disabled={isLoading}>
              <option value="">{isLoading ? 'Loading your spaces…' : 'Pick the space'}</option>
              {(spaces ?? []).map(s => (
                <option key={s.unitId} value={s.unitId}>
                  {s.propertyName} — {s.unitNumber}
                  {/* Three states, not two. A space can hold a lease with
                      nobody named on it (Copper Canyon House 01 does), and
                      calling that "nobody on it" while still offering the lease
                      is how an operator puts money on the wrong thing. */}
                  {s.residentName
                    ? ` (${s.residentName})`
                    : s.hasLeaseWithoutResident
                      ? ' (has a lease, nobody named on it)'
                      : ' (no lease)'}
                </option>
              ))}
            </select>
          </div>

          {/* Who it goes to. Only a space with a resident can offer the choice. */}
          {space && space.leaseId && (
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={label}>Who paid</label>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: '.88rem', color: 'var(--text-0)' }}>
                <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="radio" checked={onLease} onChange={() => setOnLease(true)} />
                  {space.residentName} — goes on their record
                </label>
                <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="radio" checked={!onLease} onChange={() => setOnLease(false)} />
                  Somebody else — goes against the space
                </label>
              </div>
            </div>
          )}

          {space && !onLease && (
            <>
              <div>
                <label style={label}>Who paid (optional)</label>
                <input style={field} value={payerName} onChange={e => setPayerName(e.target.value)}
                  placeholder="Name on the sheet" />
              </div>
              <div>
                <label style={label}>Their phone (optional)</label>
                <input style={field} value={payerPhone} onChange={e => setPayerPhone(e.target.value)}
                  placeholder="So repeat guests link up" />
              </div>
            </>
          )}

          <div>
            <label style={label}>Date it came in</label>
            <input style={field} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <label style={label}>Amount</label>
            <input ref={amountRef} style={field} value={amount} inputMode="decimal"
              onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              onKeyDown={e => { if (e.key === 'Enter' && ready && !save.isLoading) save.mutate() }}
              placeholder="450.00" />
          </div>
          <div>
            <label style={label}>What for</label>
            <select style={field} value={kind} onChange={e => setKind(e.target.value)}>
              {KINDS.map(k => <option key={k.v} value={k.v}>{k.label}</option>)}
            </select>
          </div>
          <div>
            <label style={label}>How they paid</label>
            <select style={field} value={method} onChange={e => setMethod(e.target.value)}>
              {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label style={label}>Reference (optional)</label>
            <input style={field} value={reference} onChange={e => setReference(e.target.value)}
              placeholder="Check no., receipt no." />
          </div>
        </div>

        {/* Said before saving, not only after: the two destinations are
            different things and the operator should know which they are about
            to write. */}
        {space && (
          <div style={{ marginTop: 14, fontSize: '.84rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
            {onLease && space.leaseId
              ? <>This will show on <strong>{space.residentName ?? 'the lease on this space'}</strong>’s
                 record as already paid. No bill, nothing owed.</>
              : <>This will be recorded as <strong>{space.propertyName} {space.unitNumber}</strong>’s past income
                 {payerName.trim() ? <> from <strong>{payerName.trim()}</strong></> : null}. Nobody is billed.</>}
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" disabled={!ready || save.isLoading}
            onClick={() => save.mutate()}>
            {save.isLoading ? 'Saving…' : 'Save and next'}
          </button>
          <span style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>
            The date, what for and how they paid stay put, so you can work straight down a column.
          </span>
        </div>
      </div>

      {saved.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-0)' }}>
              Typed in this sitting
            </h2>
            <span style={{ fontSize: '.84rem', color: 'var(--text-2)' }}>
              {saved.filter(s => !s.undone).length} entries,{' '}
              {money(saved.filter(s => !s.undone).reduce((t, s) => t + s.amount, 0))}
            </span>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {saved.map(s => (
              <div key={s.key} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                borderBottom: '1px solid var(--border)', background: 'var(--bg-1)',
                fontSize: '.87rem', color: s.undone ? 'var(--text-2)' : 'var(--text-0)',
                textDecoration: s.undone ? 'line-through' : 'none',
              }}>
                <CheckCircle2 size={15} style={{ color: s.undone ? 'var(--text-2)' : '#16a34a', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <strong>{money(s.amount)}</strong> · {s.spaceLabel}
                  <span style={{ color: 'var(--text-2)' }}>
                    {' '}· {s.where === 'lease' ? 'on the resident’s record' : 'against the space'}
                  </span>
                </div>
                {/* Undo is offered only where it is honest. A space line owns its
                    own batch and comes off cleanly; a line on a resident's
                    record is an ordinary payment and is taken off from the
                    Payments page, so offering a button here that could not do
                    it would be worse than not offering one. */}
                {!s.undone && s.where === 'space' && s.batchId && (
                  <button className="btn" onClick={() => undo.mutate(s.batchId!)}
                    disabled={undo.isLoading} style={{ fontSize: '.8rem', padding: '4px 9px' }}>
                    <Undo2 size={13} /> Undo
                  </button>
                )}
                {!s.undone && s.where === 'lease' && (
                  <a href="/payments" style={{ fontSize: '.8rem', color: 'var(--gold)' }}>
                    Payments page
                  </a>
                )}
              </div>
            ))}
          </div>
          <p style={{ fontSize: '.84rem', color: 'var(--text-2)', marginTop: 12, lineHeight: 1.5 }}>
            Money against a space shows on your{' '}
            <a href="/reports" style={{ color: 'var(--gold)' }}>P&amp;L</a> for the month it came in,
            as “Collected before GAM”. Money on a resident’s record shows on the{' '}
            <a href="/payments" style={{ color: 'var(--gold)' }}>Payments page</a>.
          </p>
        </div>
      )}
    </div>
  )
}
