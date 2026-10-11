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
import { apiGet, apiPost } from '../lib/api'
import { Check } from 'lucide-react'
import { EXPENSE_CATEGORY_LABEL, humanize } from '@gam/shared'

interface OwnerRow {
  landlordId: string
  businessName: string | null
  ownerEmail: string | null
  portalAccess: 'none' | 'active' | 'closed'
  portalOpenedAt: string | null
  notes: string | null
  propertyCount: number
  unitCount: number
}

/** S655: information only — this month's bills (by due date) and what became of them. */
interface StatementBilled { billed: number; collectedSoFar: number; clearing: number; stillOwed: number }
interface StatementProperty {
  propertyId: string; propertyName: string
  /** What residents paid, before anyone's cut (GROSS_LABEL says how it is dated). */
  grossCollected: number
  /** S655: of it, money GAM held and paid out (ties to the owner share and the management fee). */
  collectedThroughGam?: number
  /** S655: of it, money the manager took directly (cash, check, money paid ahead to the manager). */
  collectedDirectly?: number
  /** S655: what a dispute or bank return took back this month (negative) — beside gross, never in it. */
  returnedOrDisputed?: number
  billed?: StatementBilled
  ownerShare: number; managementFee: number
  expenses: number; net: number
  expenseLines: Array<{ date: string; category: string; amount: number; description: string | null; vendor: string | null }>
}
interface Statement {
  periodMonth: string
  properties: StatementProperty[]
  totals: {
    grossCollected: number; collectedThroughGam?: number; collectedDirectly?: number; returnedOrDisputed?: number
    billed?: StatementBilled
    ownerShare: number; managementFee: number; expenses: number; net: number
  }
}

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

/**
 * This month, as the API wants it ('YYYY-MM'), on the viewer's own calendar.
 * S655: it read the UTC date, which turns over at 5 pm in Arizona — on the last
 * evening of a month the statement opened on next month.
 */
const thisMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 'YYYY-MM' in words, "September 2026" — the month the statement is for, read as a calendar month. */
const monthWords = (ym: string) => {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

/**
 * S655: what the statement's gross is called. NOT "Money received": that name
 * means strictly the day money arrived (money plan §0.0), and this figure counts
 * money paid ahead through GAM on the day GAM pays it toward a bill (when the
 * owner's share of it is set aside for the next payout). Which way it should
 * go — count that money on the day it arrived, or keep this name — is Nic's
 * call; this is the one place to change it.
 */
const GROSS_LABEL = 'Collected'

/**
 * How the gross is dated, under the figures. Money paid ahead through GAM
 * counts the day GAM pays it toward a bill: that day the owner's share is SET
 * ASIDE (allocation_owner_share), and it reaches the owner in the next payout —
 * so the note never says it is paid out that day.
 */
export const GROSS_NOTE =
  `${GROSS_LABEL} is what residents paid, before anyone's cut, counted on the day it arrived — except ` +
  `money paid ahead through GAM, which counts on the day GAM pays it toward a bill (that day the ` +
  `owner's share of it is set aside for the owner's next payout). A deposit held for a tenant, a GAM ` +
  `fee and a credit the owner gave are never in it.`

/** S655: the gross, split by who held the money (it adds up to the gross). */
function GrossSplit({ through, direct }: { through?: number; direct?: number }) {
  if (through == null && direct == null) return null
  return (
    <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
      <div>Collected through GAM {money(Number(through || 0))}</div>
      <div>Collected by the manager directly {money(Number(direct || 0))}</div>
    </div>
  )
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

  const openPortal = useMutation(
    (landlordId: string) =>
      apiPost(`/pm/companies/${cid}/owners/${landlordId}/portal`),
    { onSuccess: () => qc.invalidateQueries(['pm-owners', cid]) },
  )

  const owners = ownersQ.data ?? []
  // Nothing to list because the load failed (a failed background refresh with
  // a list already on screen keeps the list): say why, never "No owners yet".
  const ownersFailed = ownersQ.isError && !ownersQ.data

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

      {/* A list that did not load says why, once — never "No owners yet". */}
      {ownersFailed && (
        <div className="card" style={{ padding: 16, color: 'var(--red, #e06666)', fontSize: '.88rem' }}>
          {ownersErrorText(ownersQ.error)}
        </div>
      )}

      {!ownersQ.isLoading && !ownersFailed && owners.length === 0 && (
        <div className="card" style={{ padding: 16, color: 'var(--text-2)', fontSize: '.88rem' }}>
          No owners yet. An owner appears here the moment one of their properties is linked
          to your company.
        </div>
      )}

      {/* A failed "Give access" says so once, with what to do next. */}
      {openPortal.isError && (
        <div style={{ color: 'var(--red, #e06666)', fontSize: '.8rem', marginBottom: 10 }}>
          {giveAccessErrorText(openPortal.error)}
        </div>
      )}

      {/* Scrolls sideways inside its own frame on a narrow screen, so the
          Statement button is never cut off. */}
      {owners.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-2)' }}>
                <Th>Owner</Th><Th>Portfolio</Th><Th>Portal</Th><Th>{' '}</Th>
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
                      className={openOwner === o.landlordId ? 'btn btn-ghost' : 'btn btn-primary'}
                      style={{ fontSize: '.72rem', padding: '4px 10px', whiteSpace: 'nowrap' }}
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
      {q.isError && (
        <div style={{ color: 'var(--red, #e06666)', fontSize: '.8rem', marginTop: 12 }}>
          {statementErrorText(q.error)}
        </div>
      )}

      {s && (
        <>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 14 }}>
            <div>
              <Figure label={GROSS_LABEL} value={money(s.totals.grossCollected)} />
              <GrossSplit through={s.totals.collectedThroughGam} direct={s.totals.collectedDirectly} />
            </div>
            <Figure label="Owner's share" value={money(s.totals.ownerShare)} />
            <Figure label="Management fee" value={money(s.totals.managementFee)} />
            <Figure label="Expenses" value={money(s.totals.expenses)} />
            <Figure label="Net to owner" value={money(s.totals.net)} accent />
          </div>

          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.5, maxWidth: 680 }}>
            {GROSS_NOTE}
            {Number(s.totals.returnedOrDisputed || 0) !== 0 && (
              <> In {monthWords(s.periodMonth || props.month)} a dispute or bank return took back {money(Math.abs(Number(s.totals.returnedOrDisputed)))} —
              shown here beside the total; the payment it reversed stays in the month it arrived.</>
            )}
          </div>

          {s.totals.billed && (
            <div style={{
              marginTop: 12, padding: '10px 12px', border: '1px dashed var(--border-0)', borderRadius: 8,
              fontSize: '.78rem', color: 'var(--text-2)', maxWidth: 680,
            }}>
              <strong style={{ color: 'var(--text-1)' }}>Money billed in {monthWords(s.periodMonth || props.month)} {money(s.totals.billed.billed)}</strong>
              {' — '}collected so far {money(s.totals.billed.collectedSoFar)}
              {s.totals.billed.clearing ? ` · clearing ${money(s.totals.billed.clearing)}` : ''}
              {' · '}still owed {money(s.totals.billed.stillOwed)}.
              <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>
                For information: bills by the day they were due. It changes no share or fee.
              </div>
            </div>
          )}

          {s.properties.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
              <thead>
                <tr style={{ background: 'var(--bg-2)' }}>
                  <Th>Property</Th><Th>{GROSS_LABEL}</Th><Th>Their share</Th>
                  <Th>Fee</Th><Th>Expenses</Th><Th>Net</Th>
                </tr>
              </thead>
              <tbody>
                {s.properties.map(p => (
                  <tr key={p.propertyId} style={{ borderTop: '1px solid var(--border-0)' }}>
                    <Td>
                      {p.propertyName}
                      {p.billed && (p.billed.billed || p.billed.stillOwed) ? (
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3 }}>
                          Billed {money(p.billed.billed)} · still owed {money(p.billed.stillOwed)}
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      {money(p.grossCollected)}
                      <GrossSplit through={p.collectedThroughGam} direct={p.collectedDirectly} />
                      {Number(p.returnedOrDisputed || 0) !== 0 && (
                        <div style={{ fontSize: '.7rem', color: 'var(--red, #e06666)', marginTop: 2 }}>
                          Returned or disputed {money(Number(p.returnedOrDisputed))}
                        </div>
                      )}
                    </Td>
                    <Td>{money(p.ownerShare)}</Td>
                    <Td>{money(p.managementFee)}</Td>
                    <Td>
                      {money(p.expenses)}
                      {p.expenseLines.length > 0 && (
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3 }}>
                          {p.expenseLines.map((l, i) => (
                            <div key={i}>
                              {l.date} · {(EXPENSE_CATEGORY_LABEL as Record<string, string>)[l.category] ?? humanize(l.category)}
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
            </div>
          )}

          {s.properties.length === 0 && (
            <div style={{ color: 'var(--text-3)', fontSize: '.84rem', marginTop: 14 }}>
              Nothing on this owner's books for {monthWords(s.periodMonth || props.month)}.
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Why something failed, once: the server's own sentence for a refusal or a bad
 * request (a 4xx carries its own next step, so no "try again" — it would send
 * the reader in a circle), and "Try again in a moment" only when trying again
 * can help (the connection, a server failure, or too many requests). This
 * app's API client does not rewrite axios' own words, so "Request failed with
 * status code 403", "Network Error" and "timeout of …" are never shown — the
 * fallback is.
 */
export function errorText(error: unknown, fallback: string): string {
  const e = error as any
  const status: number | undefined = e?.response?.status ?? e?.status
  const server = e?.response?.data?.error ?? e?.response?.data?.message
  const said: string = typeof server === 'string' && server.trim() ? server.trim()
    : typeof e?.message === 'string' ? e.message.trim() : ''
  const axiosWords = /^Network Error$|^Request failed with status code|^timeout of/i
  // Too many requests (the API's rate limit answers 429 in plain text):
  // waiting is the next step.
  if (status === 429) return `${said && !axiosWords.test(said) ? said : fallback} Try again in a moment.`
  if (status && status >= 400 && status < 500) return said && !axiosWords.test(said) ? said : fallback
  // A 500's message is an unexpected failure's own words (a database error) —
  // the server's insides, never shown. Another 5xx may carry a real sentence.
  const plain = status !== 500 && said && !axiosWords.test(said) ? said : fallback
  return `${plain} Try again in a moment.`
}

export const statementErrorText = (error: unknown) => errorText(error, 'Could not load this statement.')
export const giveAccessErrorText = (error: unknown) => errorText(error, 'Could not give portal access.')
export const ownersErrorText = (error: unknown) => errorText(error, 'Could not load your owners.')

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
