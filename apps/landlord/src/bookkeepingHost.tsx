/**
 * 10/12 (Nic): BOOKKEEPING — GAM BOOKS' PAGES INSIDE THE PORTAL.
 *
 * "Bookkeeping" in the menu is the GAM Books pages themselves, not a link out
 * (src/bookkeeping — the same files as GAM Books, bookkeeping-parity.test.ts).
 * This does for them what Books' own shell does (apps/books/src/main.tsx
 * CompanyGate / ClientSwitcher):
 *   - WHICH COMPANY. The Books API reads one company's books at a time and
 *     never picks one for an account that owns several (S654: "None is the
 *     default"). An owner with one company opens it; with several they are
 *     asked, and switch at the top. The choice is remembered on this device
 *     for this person only. A bookkeeper reads the company the portal signed
 *     them in to — the one the Financials pages show them.
 *   - A CACHE OF THEIR OWN, one per company. The pages keep GAM Books' cache
 *     names ('acct', 'bills', ...), so they never mix with the portal's own
 *     screens, and one company's figures never show under another's.
 *   - BOOKS' LOOK, scoped to .bk-host (bookkeepingHost.css).
 *   - WHO. The company's owner and its bookkeeper only — the menu's own rule
 *     (Layout visibleNavItemsFor). 10/12 review: the pages were mounted for
 *     anyone who typed the address; an admin sends no company and the Books
 *     API would hand them every company's books merged (and file what they
 *     saved under no company), and staff got "Insufficient permissions" on
 *     every card. Anyone else gets a plain notice and no page asks anything.
 * Landlord portal only — not one of the shared files.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Outlet } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from 'react-query'
import { useAuth } from './context/AuthContext'
import { booksGet, setBooksCompany } from './bookkeeping/adapter'
import { companyChoiceState, companyName, loadErrorText, type CompanyChoice } from './bookkeeping/booksMoney'
import './bookkeepingHost.css'

const BOOKS_COMPANY_KEY = 'gam_landlord_books_company'
function rememberedBooksCompany(userId: string | undefined): string | null {
  if (!userId) return null
  try {
    const v = JSON.parse(localStorage.getItem(BOOKS_COMPANY_KEY) || 'null')
    return v && v.userId === userId && typeof v.companyId === 'string' ? v.companyId : null
  } catch { return null }
}
function rememberBooksCompany(userId: string | undefined, companyId: string | null) {
  if (!userId) return
  try {
    if (companyId) localStorage.setItem(BOOKS_COMPANY_KEY, JSON.stringify({ userId, companyId }))
    else localStorage.removeItem(BOOKS_COMPANY_KEY)
  } catch { /* blocked storage: the choice holds for this visit only */ }
}

/** The roles the Bookkeeping pages are for (the menu shows them to these only). */
const BOOKKEEPING_ROLES = new Set(['landlord', 'bookkeeper'])

export function BookkeepingHost() {
  const { user } = useAuth()
  const isOwner = user?.role === 'landlord'
  const allowed = BOOKKEEPING_ROLES.has(user?.role ?? '')
  const [chosen, setChosen] = useState<string | null>(() => rememberedBooksCompany(user?.id))
  // 10/12 review: the portal's root cache never refetches on mount, so a
  // company created or joined during the visit never reached this list; it
  // is read fresh each time Bookkeeping opens.
  const { data: companies, isLoading, error, refetch, isFetching } = useQuery<CompanyChoice[]>(
    ['books-companies', user?.id], () => booksGet<CompanyChoice[]>('/books/companies'),
    { enabled: isOwner, staleTime: 60_000, refetchOnMount: 'always' })
  const state = companyChoiceState(companies, chosen)
  // A bookkeeper's own company; an owner's chosen one, or their only one. A
  // remembered company that is no longer theirs is dropped, never sent.
  const companyId = !isOwner ? (user?.landlordId ?? null)
    : state.staleChoice ? null
    : chosen ?? (companies?.length === 1 ? companies[0].landlordId : null)
  // Named before any page below asks for anything: a page's first request
  // goes out in its own effects, which run before this component's.
  setBooksCompany(companyId)
  const booksQc = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } }),
    [user?.id, companyId])
  useEffect(() => {
    if (isOwner && companies && state.staleChoice) { setChosen(null); rememberBooksCompany(user?.id, null) }
  }, [isOwner, companies, state.staleChoice, user?.id])
  const choose = (id: string) => { setChosen(id); rememberBooksCompany(user?.id, id) }

  let body: ReactNode
  if (!allowed) {
    body = (
      <div className="card" style={{ padding: '28px 20px', textAlign: 'center' }}>
        <h2 className="pt" style={{ fontSize: '1.1rem' }}>Bookkeeping</h2>
        <p className="ps" style={{ marginTop: 6, lineHeight: 1.5 }}>Bookkeeping is for the company&apos;s owner and its bookkeeper.</p>
      </div>
    )
  } else if (isOwner && (isLoading || (companies && state.staleChoice))) {
    body = <div className="bk-loading"><span className="spinner" /></div>
  } else if (isOwner && error) {
    body = (
      <div className="alert ae" style={{ alignItems: 'center' }}>
        <span style={{ flex: 1 }}>{loadErrorText(error, 'Could not load your companies.')}</span>
        <button className="btn bp bsm" disabled={isFetching} onClick={() => refetch()}>{isFetching ? 'Loading…' : 'Load again'}</button>
      </div>
    )
  } else if (isOwner && state.mustChoose && companies) {
    body = (
      <div className="card company-pick">
        <h2 className="pt" style={{ fontSize: '1.15rem' }}>Which company&apos;s books?</h2>
        <p className="ps" style={{ marginTop: 6, lineHeight: 1.5 }}>You own more than one company, and each keeps its own books. Choose one to open — you can switch at the top of the page any time.</p>
        <div className="company-pick-list">
          {companies.map((c, i) => (
            <button key={c.landlordId} type="button" className="btn bp" onClick={() => choose(c.landlordId)}>
              <span>{companyName(c, i)}</span>
              {c.businessName && c.propertyNames && <span className="company-pick-sub">{c.propertyNames}</span>}
            </button>
          ))}
        </div>
      </div>
    )
  } else {
    body = (
      // Keyed by company: every page starts over on the newly opened books.
      <QueryClientProvider key={companyId ?? 'only'} client={booksQc}>
        {isOwner && state.showSwitcher && companies && (
          <div className="bk-company">
            <label htmlFor="bk-company">Company</label>
            <select id="bk-company" value={companyId ?? ''} onChange={e => choose(e.target.value)}>
              {companies.map((c, i) => <option key={c.landlordId} value={c.landlordId}>{companyName(c, i)}</option>)}
            </select>
          </div>
        )}
        <Outlet />
      </QueryClientProvider>
    )
  }
  return <div className="bk-host">{body}</div>
}
