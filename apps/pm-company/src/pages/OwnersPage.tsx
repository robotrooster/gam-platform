/**
 * S644 — the people this company works for.
 *
 * A manager onboarding ~11,000 units has owners, not just properties, and two
 * things belong to the OWNER rather than to any one park: how they get paid,
 * and whether they can see this for themselves. Nic's framing of what an owner
 * needs is "their reports and things like that, and their payments" — so this
 * screen is a list of owners, each row carrying its terms, opening onto the
 * month's statement.
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useAuth } from '../context/AuthContext'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { Check } from 'lucide-react'

interface OwnerRow {
  landlordId: string
  businessName: string | null
  ownerEmail: string | null
  payoutMode: 'direct' | 'pm_trust'
  disbursementDay: number
  portalAccess: 'none' | 'active' | 'closed'
  portalOpenedAt: string | null
  notes: string | null
  propertyCount: number
  unitCount: number
}

interface StatementProperty {
  propertyId: string; propertyName: string
  grossCollected: number; ownerShare: number; managementFee: number
  expenses: number; net: number
  expenseLines: Array<{ date: string; category: string; amount: number; description: string | null; vendor: string | null }>
}
interface Statement {
  periodMonth: string
  payoutMode: 'direct' | 'pm_trust'
  properties: StatementProperty[]
  totals: { grossCollected: number; ownerShare: number; managementFee: number; expenses: number; net: number }
  distributedInPeriod: number
  heldForOwner: number
}

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

/** This month, as the API wants it. */
const thisMonth = () => new Date().toISOString().slice(0, 7)

const PAYOUT_LABEL: Record<OwnerRow['payoutMode'], string> = {
  direct: 'Paid at settlement',
  pm_trust: 'Held, paid on a run',
}

export function OwnersPage() {
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id
  const qc = useQueryClient()
  const [openOwner, setOpenOwner] = useState<string | null>(null)
  const [month, setMonth] = useState(thisMonth())

  const ownersQ = useQuery<OwnerRow[]>(
    ['pm-owners', cid],
    () => apiGet<OwnerRow[]>(`/pm/companies/${cid}/owners`),
    { enabled: !!cid },
  )

  const terms = useMutation(
    (v: { landlordId: string; body: any }) =>
      apiPatch(`/pm/companies/${cid}/owners/${v.landlordId}`, v.body),
    { onSuccess: () => qc.invalidateQueries(['pm-owners', cid]) },
  )

  const openPortal = useMutation(
    (landlordId: string) =>
      apiPost(`/pm/companies/${cid}/owners/${landlordId}/portal`),
    { onSuccess: () => qc.invalidateQueries(['pm-owners', cid]) },
  )

  const owners = ownersQ.data ?? []

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>Owners</h1>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
          The people {activePmCompany?.name ?? 'your company'} manages for — how each one is paid,
          and what their month looks like.
        </div>
      </div>

      {ownersQ.isLoading && <div style={{ color: 'var(--text-3)' }}>Loading…</div>}

      {!ownersQ.isLoading && owners.length === 0 && (
        <div className="card" style={{ padding: 16, color: 'var(--text-2)', fontSize: '.88rem' }}>
          No owners yet. An owner appears here the moment one of their properties is linked
          to your company.
        </div>
      )}

      {owners.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-2)' }}>
                <Th>Owner</Th><Th>Portfolio</Th><Th>How they're paid</Th>
                <Th>Portal</Th><Th>{' '}</Th>
              </tr>
            </thead>
            <tbody>
              {owners.map(o => (
                <tr key={o.landlordId} style={{ borderTop: '1px solid var(--border-0)' }}>
                  <Td>
                    <strong style={{ color: 'var(--text-0)' }}>{o.businessName || 'Owner'}</strong>
                    {o.ownerEmail && (
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{o.ownerEmail}</div>
                    )}
                  </Td>
                  <Td>
                    {o.propertyCount} {o.propertyCount === 1 ? 'property' : 'properties'}
                    <span style={{ color: 'var(--text-3)' }}> · {o.unitCount} units</span>
                  </Td>
                  <Td>
                    <select
                      value={o.payoutMode}
                      onChange={e => terms.mutate({
                        landlordId: o.landlordId, body: { payoutMode: e.target.value } })}
                      style={selectStyle}
                    >
                      <option value="direct">{PAYOUT_LABEL.direct}</option>
                      <option value="pm_trust">{PAYOUT_LABEL.pm_trust}</option>
                    </select>
                    {o.payoutMode === 'pm_trust' && (
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>
                        Paid out on the{' '}
                        <select
                          value={o.disbursementDay}
                          onChange={e => terms.mutate({
                            landlordId: o.landlordId,
                            body: { disbursementDay: Number(e.target.value) } })}
                          style={{ ...selectStyle, padding: '1px 4px' }}
                        >
                          {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                            <option key={d} value={d}>{ordinal(d)}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </Td>
                  <Td>
                    {o.portalAccess === 'active' ? (
                      <span style={{ color: 'var(--green, #2f9e5f)', fontSize: '.78rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Check size={13} /> Open
                      </span>
                    ) : (
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: '.72rem', padding: '4px 10px' }}
                        disabled={openPortal.isLoading}
                        onClick={() => openPortal.mutate(o.landlordId)}
                      >
                        {o.portalAccess === 'closed' ? 'Re-open access' : 'Give access'}
                      </button>
                    )}
                  </Td>
                  <Td>
                    <button
                      className="btn"
                      style={{ fontSize: '.72rem', padding: '4px 10px' }}
                      onClick={() => setOpenOwner(openOwner === o.landlordId ? null : o.landlordId)}
                    >
                      {openOwner === o.landlordId ? 'Hide statement' : 'Statement'}
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Nic (S644, DIRECTIVE): "Owner can access if they want. Request portal
          access through PM, but PM can't deny an owner." There is deliberately
          no Deny or Revoke control above — only Give access — and the API has no
          route for either. Closing it is the owner's own act, from their side. */}
      {owners.some(o => o.portalAccess !== 'active') && (
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 10, maxWidth: 620, lineHeight: 1.5 }}>
          An owner who asks for portal access gets it. They see their own properties and
          statements and nothing else, and they can close their own access whenever they like.
        </div>
      )}

      {openOwner && (
        <OwnerStatement
          pmCompanyId={cid!}
          landlordId={openOwner}
          ownerName={owners.find(o => o.landlordId === openOwner)?.businessName ?? 'Owner'}
          month={month}
          onMonth={setMonth}
        />
      )}
    </div>
  )
}

function OwnerStatement(props: {
  pmCompanyId: string; landlordId: string; ownerName: string
  month: string; onMonth: (m: string) => void
}) {
  const q = useQuery<Statement>(
    ['owner-statement', props.pmCompanyId, props.landlordId, props.month],
    () => apiGet<Statement>(
      `/pm/companies/${props.pmCompanyId}/owners/${props.landlordId}/statement?month=${props.month}`),
  )

  const s = q.data
  return (
    <div className="card" style={{ marginTop: 16, padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-0)' }}>
          {props.ownerName} — statement
        </h2>
        <input
          type="month" value={props.month}
          onChange={e => props.onMonth(e.target.value)}
          style={selectStyle}
        />
      </div>

      {q.isLoading && <div style={{ color: 'var(--text-3)', marginTop: 12 }}>Loading…</div>}

      {s && (
        <>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 14 }}>
            <Figure label="Collected" value={money(s.totals.grossCollected)} />
            <Figure label="Owner's share" value={money(s.totals.ownerShare)} />
            <Figure label="Management fee" value={money(s.totals.managementFee)} />
            <Figure label="Expenses" value={money(s.totals.expenses)} />
            <Figure label="Net to owner" value={money(s.totals.net)} accent />
          </div>

          <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.5 }}>
            {s.payoutMode === 'direct'
              ? `Paid at settlement — ${money(s.distributedInPeriod)} already went to their account this period.`
              : `Held for disbursement — ${money(s.heldForOwner)} is owed to them and has not been paid out yet.`}
          </div>

          {s.properties.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
              <thead>
                <tr style={{ background: 'var(--bg-2)' }}>
                  <Th>Property</Th><Th>Collected</Th><Th>Their share</Th>
                  <Th>Fee</Th><Th>Expenses</Th><Th>Net</Th>
                </tr>
              </thead>
              <tbody>
                {s.properties.map(p => (
                  <tr key={p.propertyId} style={{ borderTop: '1px solid var(--border-0)' }}>
                    <Td>{p.propertyName}</Td>
                    <Td>{money(p.grossCollected)}</Td>
                    <Td>{money(p.ownerShare)}</Td>
                    <Td>{money(p.managementFee)}</Td>
                    <Td>
                      {money(p.expenses)}
                      {p.expenseLines.length > 0 && (
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3 }}>
                          {p.expenseLines.map((l, i) => (
                            <div key={i}>
                              {l.date} · {l.category}
                              {l.vendor ? ` · ${l.vendor}` : ''} · {money(l.amount)}
                            </div>
                          ))}
                        </div>
                      )}
                    </Td>
                    <Td><strong>{money(p.net)}</strong></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {s.properties.length === 0 && (
            <div style={{ color: 'var(--text-3)', fontSize: '.84rem', marginTop: 14 }}>
              Nothing on this owner's books for this month.
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-2)', color: 'var(--text-1)',
  border: '1px solid var(--border-0)', borderRadius: 6,
  padding: '4px 8px', fontSize: '.78rem',
}

const Figure = ({ label, value, accent }: { label: string; value: string; accent?: boolean }) => (
  <div>
    <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-3)' }}>{label}</div>
    <div style={{ fontSize: '1.05rem', fontWeight: 700, color: accent ? 'var(--gold)' : 'var(--text-0)', marginTop: 2 }}>{value}</div>
  </div>
)

const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', fontWeight: 600 }}>{children}</th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '12px 14px', fontSize: '.84rem', color: 'var(--text-1)', verticalAlign: 'top', ...style }}>{children}</td>
)
