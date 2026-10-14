// S570 (Nic): bank feed. Link an operating bank read-only via Stripe Financial
// Connections; GAM auto-matches the money it already knows (rent payouts) and
// surfaces the rest — a $1k Home Depot charge from the landlord's own bank — for
// a 2-click categorize into the P&L. The landlord ALWAYS confirms and ALWAYS
// picks scope (a unit, or the property split/common across units); auto-suggest
// only pre-fills from what this landlord chose for the same merchant before.
// 10/13 (Nic): "each expense is chosen on the split or specific unit or
// property at the time of logging. there should never be a default setting to
// apply expenses." Money going out is never pre-filled with where it goes —
// the line asks (one unit, the whole property, or split across all the
// company's properties by units), and so does each part of a split; the
// remembered category still pre-fills. 10/14 (Nic): "if gam 100 percent knows
// who that money came from it can file it but no guessing." Money coming in
// is never pre-filled with a place either: where the payer's last deposit went
// is offered as a button the person presses, and nothing files itself. A
// deposit of a GAM payout's amount whose memo does not name GAM is offered as
// that payout for the person to match. 10/14 (Nic, answer 15): a line going out
// that is a check the bank returned — when GAM could not be sure which check —
// lists the checks of its amount under "What did this pay?" for the person to
// pick; a returned check GAM took back can be undone like any match.
import { useMemo, useState, useEffect } from 'react'
import { useUrlTab } from '../lib/useUrlTab'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { loadStripe } from '@stripe/stripe-js'
import { EntityPicker } from '../components/EntityPicker'
import { apiGet, apiPost , apiPut } from '../lib/api'
import {
  EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, OTHER_INCOME_CATEGORIES, OTHER_INCOME_CATEGORY_LABEL,
  BANK_TXN_IGNORED_REASON_LABEL, BANK_TXN_MATCH_KIND_LABEL, DEPOSIT_SLIP_SOURCE_LABEL,
  BANK_LINE_MATCH_KIND_LABEL, BANK_MATCH_FIRST_CODE, BOOKS_COST_PLACE_LABEL,
  type BankTxnIgnoredReason, type DepositSlipSource, type BankLineMatchKind,
} from '@gam/shared'
import '../styles/bank-reconciliation.css'
import { toast, appConfirm } from '../components/dialogs'
import { PayoutBreakdown } from '../components/PayoutBreakdown'
import { Landmark, RefreshCw, Check, X, Plus, Split } from 'lucide-react'

const STRIPE_PK = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
const stripePromise = STRIPE_PK ? loadStripe(STRIPE_PK) : null

const fmt = (n: any) => {
  const v = Number(n)
  const s = `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return v < 0 ? `− ${s}` : s
}
const fmtDate = (d: any) => (d ? String(d).slice(0, 10) : '—')
/** One value off the page's address (?line=…), or '' — read once, when the page opens. */
const urlParam = (key: string): string => {
  try { return new URLSearchParams(window.location.search).get(key) || '' } catch { return '' }
}

// S603 (Nic): property_common and property_allocate now do the SAME thing —
// every cost not tied to one unit is split across that property's units. Both
// labels say so, so the list can't imply a difference that no longer exists.
// (The duplicate enum value itself needs a migration to retire.)
const SCOPE_LABEL: Record<string, string> = {
  unit: 'One unit',
  property_common: 'Whole property, split per unit',
  property_allocate: 'Whole property, split per unit',
}

// What the PICKER offers. SCOPE_LABEL above still maps both property values so
// an existing rule saved as property_allocate still displays correctly, but the
// dropdown must not show the same choice twice.
const SCOPE_CHOICES: [string, string][] = [
  ['unit', SCOPE_LABEL.unit],
  ['property_common', SCOPE_LABEL.property_common], // wire-ok: local constant map, not an API response
]
// 10/13 (Nic): money going out may also be split across all the company's
// properties by units (BOOKS_COST_PLACES); money coming in sits on a unit or a property.
const scopeChoices = (moneyOut: boolean): [string, string][] => moneyOut
  ? [...SCOPE_CHOICES, ['split_by_units', BOOKS_COST_PLACE_LABEL.split_by_units]]  // wire-ok: a shared label key, not a field off an API response
  : SCOPE_CHOICES
/** 10/13: a filing's place is fully said — a unit, a property, or a split (naming neither). */
const scopePlaced = (p: { scopeKind: string; propertyId: string; unitId: string }) =>
  p.scopeKind === 'split_by_units' ? true : p.scopeKind === 'unit' ? !!p.unitId : p.scopeKind ? !!p.propertyId : false
/** The ids a filing sends for its place (a split names none). */
const scopeIds = (p: { scopeKind: string; propertyId: string; unitId: string }) =>
  p.scopeKind === 'split_by_units' ? {} : p.scopeKind === 'unit' ? { unitId: p.unitId } : { propertyId: p.propertyId }

type Draft = {
  category: string; scopeKind: string; propertyId: string; unitId: string
  /** 10/12 (Nic, L5): one of the company's own categories, when picked (wins over `category`). */
  categoryId?: string
}
/** 10/12 (Nic, L5): a company's own category, as GET /expenses/options lists it. */
type CompanyCategory = { id: string; landlordId: string; direction: 'expense' | 'income'; name: string; systemKey: string | null; inPicker: boolean }

// 10/12 (Nic): "categories are separate. if a deposit is multiple sources it
// should be split for record keeping." One part of a split bank line, as typed.
// 10/12 review: `description` is a part's own words (an edit the owner made on
// the Expenses page); carried through a change of the split so it is not reset
// to the bank's memo. Not edited here.
type SplitPart = {
  category: string; amount: string; scopeKind: string; propertyId: string; unitId: string; description?: string | null
  /** 10/12 (Nic, L5): the company's own category for this part, when picked. */
  categoryId?: string
}

/** A typed amount in cents, or null when it is not dollars and cents above $0. */
const partCents = (raw: string): number | null => {
  const t = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  const c = Math.round(Number(t) * 100)
  return c > 0 ? c : null
}

// S605 (Nic): merged into a single "Bank" tab alongside reconciliation.
// `embedded` renders this as a section of BankPage rather than its own screen.
export function BankFeedPage({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [linking, setLinking] = useState(false)
  const [linkErr, setLinkErr] = useState<string | null>(null)
  // S652 (Nic): "that $4,154.89 is not showing up on the transactions tab."
  // It was there — imported at midnight and MATCHED to GAM's own payout, which
  // is exactly right (a payout landing is never income) — but no view showed
  // matched rows. Now one does.
  // S652 (Nic): "the transaction log of the bank account is all money going in
  // and out of that bank account." The log opens on everything, newest first —
  // GAM's payouts landing included, labeled as matched so nothing is booked
  // twice. The buttons are filters over it, not separate pages.
  const [view, setView] = useUrlTab('view', 'all', ['all','needs_review','categorized','ignored'] as const)

  // S629 (Nic): "a property selector or entity selector, to view the
  // transaction logs and stuff specific to that entity." The feed was pinned
  // to the primary entity server-side, so a second LLC's transactions were
  // unreachable — not empty, unreachable.
  // 10/12 (Nic): the Expenses page sends the owner here to change an expense
  // the bank feed filed (?line=<the bank line>&company=<its company>). The page
  // opens on that company, showing that one line with its Undo and Split.
  const [entityId, setEntityId] = useState<string>(() => urlParam('company'))
  const [focusLine, setFocusLine] = useState<string>(() => urlParam('line'))
  const showAll = () => {
    setFocusLine('')
    const u = new URL(window.location.href)
    u.searchParams.delete('line'); u.searchParams.delete('company')
    window.history.replaceState(window.history.state, '', u)
  }
  const entityQS = entityId ? `entityId=${encodeURIComponent(entityId)}` : ''
  const { data: connections = [] } = useQuery<any[]>(
    ['bank-connections', entityId],
    () => apiGet(`/bank-feed/connections${entityQS ? `?${entityQS}` : ''}`))
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const { data: txns = [], isLoading } = useQuery<any[]>(
    ['bank-txns', view, entityId, focusLine],
    () => apiGet(`/bank-feed/transactions?${focusLine ? `lineId=${encodeURIComponent(focusLine)}&`
      : view === 'all' ? '' : `status=${view}&`}${entityQS}`))

  const propOf = (u: any) => u.propertyId
  const unitsForProp = (pid: string) => (units as any[]).filter(u => propOf(u) === pid)
  // 10/12 (Nic, L5): "just let bookkeeper/landlord create custom labels or
  // categories" — the picker offers the company's own categories (the
  // Categories page makes them); a merchant's remembered choice still pre-fills.
  const { data: expenseOptions } = useQuery<{ categories: CompanyCategory[] }>('expense-options', () => apiGet('/expenses/options'), { staleTime: 30_000 })
  const companyCategories = (t: any, isExpense: boolean): CompanyCategory[] =>
    (expenseOptions?.categories ?? []).filter(c => c.direction === (isExpense ? 'expense' : 'income') && c.inPicker
      && (!t.landlordId || c.landlordId === t.landlordId))
  /** The category a draft names: picked by id, else the company's category of the remembered key. */
  const draftCategoryId = (t: any, d: Draft): string => {
    if (d.categoryId) return d.categoryId
    const cats = companyCategories(t, Number(t.amount) < 0)
    return cats.find(c => c.systemKey === d.category)?.id ?? ''
  }

  // Per-row categorize draft, pre-seeded with the merchant's remembered category.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const draftFor = (t: any): Draft => drafts[t.id] || {
    // Income rows must not default to an expense category — confirming without
    // touching the dropdown would file a deposit as 'repairs'.
    category: t.suggestedCategory || (Number(t.amount) > 0 ? 'other' : 'repairs'),
    // 10/13 (Nic): money going out starts with no place (the API never suggests one for it).
    // 10/14 (Nic, answer 16): "no guessing" — money coming in starts with no
    // place either. Where this payer's last deposit went is offered beside
    // the pickers as a suggestion the person presses (placeSuggestion), never
    // filled in for them.
    scopeKind: '',
    propertyId: '',
    unitId: '',
  }
  /** 10/14: the place this payer's last deposit went, in words, or null (money in only). */
  const placeSuggestion = (t: any): { label: string; patch: Partial<Draft> } | null => {
    if (!(Number(t.amount) > 0) || !t.suggestedScopeKind) return null
    const prop = (properties as any[]).find((p: any) => p.id === t.suggestedPropertyId)
    if (t.suggestedScopeKind === 'unit') {
      const u = (units as any[]).find((x: any) => x.id === t.suggestedUnitId)
      if (!u) return null
      const uProp = (properties as any[]).find((p: any) => p.id === propOf(u))
      return {
        label: `${u.unitNumber || u.name || u.label || 'Unit'}${uProp?.name ? `, ${uProp.name}` : ''}`,
        patch: { scopeKind: 'unit', propertyId: propOf(u), unitId: u.id },
      }
    }
    if (!prop) return null
    return {
      label: `${prop.name} — ${scopeChoices(false).find(([k]) => k === t.suggestedScopeKind)?.[1] ?? 'the whole property'}`,
      patch: { scopeKind: t.suggestedScopeKind, propertyId: prop.id, unitId: '' },
    }
  }
  const setDraft = (id: string, patch: Partial<Draft>) => {
    const row = (txns as any[]).find(t => t.id === id) || { id }
    setDrafts(d => ({ ...d, [id]: { ...draftFor(row), ...d[id], ...patch } }))
  }

  const link = async () => {
    setLinkErr(null)
    if (!stripePromise) { setLinkErr('Bank linking is not configured (missing Stripe key).'); return }
    setLinking(true)
    try {
      const stripe = await stripePromise
      if (!stripe) throw new Error('Stripe failed to load')
      // S637: send the company the picker is on. Without it the endpoint fell
      // back to "which of your companies?" and refused, after the landlord had
      // already answered that question on screen.
      const { data: session } = await apiPost('/bank-feed/link-session', { entityId })
      const { clientSecret, sessionId } = session
      const result = await (stripe as any).collectFinancialConnectionsAccounts({ clientSecret })
      if (result.error) throw new Error(result.error.message)
      const accounts = result.financialConnectionsSession?.accounts ?? []
      if (!accounts.length) { setLinking(false); return } // user closed the modal
      await apiPost('/bank-feed/finalize', { sessionId, entityId })
      qc.invalidateQueries('bank-connections')
      qc.invalidateQueries(['bank-txns'])
      toast('Bank linked. Syncing transactions…')
    } catch (e: any) {
      // S605: this read data.message, but the API's error shape is
      // { success:false, error } — so it was ALWAYS undefined and every
      // failure here degraded to axios's raw "Request failed with status
      // code 400", hiding what Stripe actually said.
      setLinkErr(e?.response?.data?.error || e?.response?.data?.message || e?.message || 'Could not link the bank.')
    } finally {
      setLinking(false)
    }
  }

  // S605 (Nic): "when a landlord wants to onboard, say, October first, do we
  // wanna offer the option to not count previous transactions?" Linking pulls
  // the bank's whole history — Oak Park imported 112 rows back to February.
  // Anything before this date is kept but auto-ignored, so the review queue is
  // only the GAM era. Retroactive and reversible; categorized rows are never
  // touched.
  // S633: books-start-date is a COMPANY's setting, and this page already knows
  // which company the user is looking at. Without the id, /landlords/me now asks
  // an account that owns several which one it means — so pass the one already
  // selected above rather than making them answer twice.
  // S637 (Nic, DIRECTIVE): THE PAYOUT ACCOUNT COMES FIRST.
  //
  //   "Both places where they connect an account, whether it says connect feed
  //    or connect account on the disbursement page — that should just take them
  //    to the connect account. The feed can come after. It can be completely
  //    hidden until they set up the connect account. That way they never
  //    accidentally do it out of order."
  //
  // Two people in a row linked the read-only FEED believing they had set up
  // payouts, and a co-owner locked himself out of his bank re-linking an
  // institution that was already connected. The feed reads transactions; only
  // the Connect account moves money. Ordering them removes the choice that was
  // being got wrong, rather than explaining the difference again.
  const connectStatusQ = useQuery<{ payoutsEnabled?: boolean; detailsSubmitted?: boolean }>(
    ['stripe-connect-status', 'landlord', entityId],
    () => apiGet(`/stripe/connect/status?entity=landlord&entityId=${entityId}`),
    { enabled: !!entityId },
  )
  const payoutsReady = !!connectStatusQ.data?.payoutsEnabled && !!connectStatusQ.data?.detailsSubmitted

  const { data: me } = useQuery<any>(
    ['landlord-books-start', entityId],
    () => apiGet(`/landlords/me?landlordId=${entityId}`),
    { enabled: !!entityId })
  const [booksStart, setBooksStart] = useState<string>('')
  useEffect(() => {
    if (me?.booksStartDate) setBooksStart(String(me.booksStartDate).slice(0, 10))
  }, [me?.booksStartDate])

  const saveBooksStart = useMutation(
    (date: string | null) => apiPut('/bank-feed/books-start-date', { date, entityId }),
    { onSuccess: (r: any) => {
        qc.invalidateQueries(['bank-txns']); qc.invalidateQueries('landlord-books-start')
        // S655: apiPut already unwraps the response's `data` — reading
        // r.data.ignored was always undefined, so the count never showed.
        const ig = r?.ignored ?? 0, re = r?.restored ?? 0
        toast(ig || re
          ? `Updated — ${ig} hidden, ${re} brought back for review.`
          : 'Start date saved.')
      },
      onError: (e: any) => toast(e?.response?.data?.error || 'Could not save the start date.') },
  )

  const sync = useMutation((id: string) => apiPost(`/bank-feed/connections/${id}/sync`, { entityId }), {
    onSuccess: (d: any) => { qc.invalidateQueries(['bank-txns']); qc.invalidateQueries('bank-connections')
      const n = d?.data?.inserted; toast(n ? `${n} new transaction(s).` : 'Up to date.') },
    onError: (e: any) => toast(e?.response?.data?.error || e?.response?.data?.message || 'Sync failed.'),
  })

  // S655 (Step 12): the last bank GAM can collect its fees from is refused, in
  // the server's words; when the fee debit moves to the bank that stays, say so.
  const disconnect = useMutation((id: string) => apiPost(`/bank-feed/connections/${id}/disconnect`, { entityId }), {
    onSuccess: (r: any) => {
      qc.invalidateQueries('bank-connections')
      const moved = r?.data?.debitMovedTo
      toast(moved
        ? `Bank disconnected. GAM now collects its fees from ${moved.name}${moved.last4 ? ` ••${moved.last4}` : ''}.`
        : 'Bank disconnected.')
    },
    onError: (e: any) => toast.error(e?.message || 'That bank could not be disconnected.'),
  })

  // S655 (Step 12, K-C / K-D): take a match or a filing back, exactly.
  const undoMatch = useMutation((id: string) => apiPost(`/bank-feed/deposits/${id}/undo`, { entityId }), {
    onSuccess: (r: any) => {
      qc.invalidateQueries(['bank-txns']); qc.invalidateQueries('unmatched-deposits')
      qc.invalidateQueries('cash-position'); qc.invalidateQueries('deposit-slips'); qc.invalidateQueries('undeposited-cash')
      const d = r?.data
      toast(d?.kind === 'deposit_slip'
        ? (d?.slipReopened ? 'Match undone. The deposit slip is waiting for the bank again.' : 'Match undone. Those payments are back on the "not banked" list.')
        // 10/14 (Nic, answer 15): a returned check put back.
        : d?.kind === 'returned_check'
          ? 'Undone. The check counts as paid again; the returned-check fee and the late fees it brought are voided (kept on record). The line is back in review.'
        // 10/14 (Nic, answer 16): a payout matched by hand.
        : d?.kind === 'gam_payout'
          ? 'Undone. The deposit is back in review.'
        // 10/6: a line tied to a deposit the office recorded by hand — the payments stay as recorded.
        : d?.kind === 'recorded_deposit'
          ? 'Match undone. The deposit you recorded stays as you recorded it, late fees and all; the bank line is back in review.'
          : `Match undone. ${d?.reopenedChargeIds?.length ?? 0} bill line(s) are owed again; the deposit is back in review.`)
    },
    onError: (e: any) => toast.error(e?.message || 'That match could not be undone.'),
  })
  // 10/14 (Nic, answer 16): the person says this deposit IS GAM's payout.
  const matchPayout = useMutation(
    ({ id, disbursementId }: { id: string; disbursementId: string }) =>
      apiPost(`/bank-feed/transactions/${id}/match-payout`, { disbursementId, entityId }), {
    onSuccess: () => { qc.invalidateQueries(['bank-txns']); toast('Matched to GAM’s payout. It is counted once, through the payments inside it.') },
    onError: (e: any) => toast.error(e?.message || 'That match could not be saved.'),
  })
  const undoFiling = useMutation(
    ({ id }: { id: string }) => apiPost(`/bank-feed/transactions/${id}/undo-auto-file`, { entityId }), {
    onSuccess: () => {
      qc.invalidateQueries(['bank-txns'])
      toast('Undone. The deposit is back in review.')
    },
    onError: (e: any) => toast.error(e?.message || 'That filing could not be undone.'),
  })
  // 10/12 (Nic): split a bank line into parts, each its own category and place.
  const [splits, setSplits] = useState<Record<string, SplitPart[]>>({})
  const closeSplit = (id: string) => setSplits(s => { const n = { ...s }; delete n[id]; return n })
  const openSplit = (t: any) => {
    const moneyIn = Number(t.amount) > 0
    // 10/13 (Nic): a part going out starts with no place; it is asked on each part.
    const blank = (from: Partial<SplitPart> = {}): SplitPart => ({
      category: moneyIn ? 'other' : 'repairs', amount: '', scopeKind: moneyIn ? 'property_common' : '', propertyId: '', unitId: '', ...from,
    })
    const parts: SplitPart[] = Array.isArray(t.splitParts) && t.splitParts.length
      ? t.splitParts.map((p: any) => ({
          category: p.category, categoryId: p.categoryId || undefined, amount: Number(p.amount).toFixed(2),
          scopeKind: p.costPlace === 'split_by_units' ? 'split_by_units' : p.unitId ? 'unit' : 'property_common',
          propertyId: p.propertyId || '', unitId: p.unitId || '',
          description: p.description ?? null,
        }))
      : (() => {
          // Start from where it is filed now (or the review row's choice), so
          // the owner only says how the money divides. 10/13 (Nic): money going
          // out carries that choice to its first part only; each other part asks.
          const d = draftFor(t)
          const place = t.filedCategory
            ? { scopeKind: t.filedCostPlace === 'split_by_units' ? 'split_by_units' : t.filedUnitId ? 'unit' : 'property_common',
                propertyId: t.filedPropertyId || '', unitId: t.filedUnitId || '' }
            : { scopeKind: d.scopeKind === 'unit' || d.scopeKind === 'split_by_units' || !d.scopeKind ? d.scopeKind : 'property_common',
                propertyId: d.propertyId, unitId: d.unitId }
          return [blank({ category: t.filedCategory || d.category, categoryId: t.filedCategoryId || d.categoryId, ...place }),
            moneyIn ? blank(place) : blank()]
        })()
    setSplits(s => ({ ...s, [t.id]: parts }))
  }
  const setPart = (id: string, i: number, patch: Partial<SplitPart>) =>
    setSplits(s => ({ ...s, [id]: (s[id] || []).map((p, j) => (j === i ? { ...p, ...patch } : p)) }))
  // 10/12 review (Nic L5, match first): a money-out line the server found
  // already on record to the cent (409 MATCH_FIRST) opens its "What did this
  // pay?" panel, with "None of these" to file it anyway — by the action the
  // person had pressed ('categorize' or 'split').
  const [matchFirst, setMatchFirst] = useState<Record<string, 'categorize' | 'split'>>({})
  const clearMatchFirst = (id: string) => setMatchFirst(s => { const n = { ...s }; delete n[id]; return n })
  const isMatchFirst = (e: any) => e?.response?.data?.code === BANK_MATCH_FIRST_CODE
  const split = useMutation(
    ({ id, parts, notAMatch }: { id: string; parts: any[]; notAMatch?: boolean }) =>
      apiPost(`/bank-feed/transactions/${id}/split`, { parts, entityId, ...(notAMatch ? { notAMatch: true } : {}) }), {
    onSuccess: (_r: any, v) => {
      qc.invalidateQueries(['bank-txns'])
      clearMatchFirst(v.id)
      closeSplit(v.id)
      toast('Split saved. Each part is filed in its own category.')
    },
    onError: (e: any, v) => {
      if (isMatchFirst(e)) {
        setMatchFirst(s => ({ ...s, [v.id]: 'split' }))
        toast('This line fits something already on your books. Match it below, or press "None of these".')
        return
      }
      toast.error(e?.message || 'That split could not be saved.')
    },
  })

  // 10/12 (Nic): "every bank filing (hand-filed too) can be undone (kept on
  // record)." One Undo for a line filed as one category, or one the owner
  // ignored; what it booked is voided (kept on file) and the line goes back.
  const undoFiled = useMutation((id: string) => apiPost(`/bank-feed/transactions/${id}/undo-filing`, { entityId }), {
    onSuccess: (r: any) => {
      qc.invalidateQueries(['bank-txns']); qc.invalidateQueries('landlord-expenses')
      const d = r?.data
      // A line the bank voided meanwhile has nothing to file again: it stays set aside as the bank's void.
      const where = d?.status === 'matched' ? 'the line is back with its match.'
        : d?.status === 'ignored' ? 'your bank voided this line, so it stays set aside.'
        : 'the line is back in review.'
      toast(d?.kind === 'ignored'
        ? `Undone: ${where}`
        : `Undone. It comes out of your books (kept on file, marked voided), and ${where}`)
    },
    onError: (e: any) => toast.error(e?.message || 'That filing could not be undone.'),
  })
  const askUndoFiled = async (t: any) => {
    const ignored = t.status === 'ignored'
    const isOut = Number(t.amount) < 0
    const ok = await appConfirm(ignored
      ? 'Bring this line back? It goes back to review, to file or ignore again.'
      : `Undo this filing? The ${isOut ? 'expense' : 'income'} comes out of your books (it stays on file, marked voided) and the line goes back to review, to file as one category or split.`,
      { title: ignored ? 'Bring this line back' : 'Undo this filing', confirmLabel: 'Undo it' })
    if (ok) undoFiled.mutate(t.id)
  }
  const unsplit = useMutation((id: string) => apiPost(`/bank-feed/transactions/${id}/split/undo`, { entityId }), {
    onSuccess: () => { qc.invalidateQueries(['bank-txns']); toast('Split undone. The line is back in review; its parts stay on file as voided.') },
    onError: (e: any) => toast.error(e?.message || 'That split could not be undone.'),
  })
  const askUnsplit = async (t: any) => {
    const ok = await appConfirm(
      'Undo this split? Its parts come out of your books (they stay on file, marked voided) and the line goes back to review, to file as one category or split again.',
      { title: 'Undo this split', confirmLabel: 'Undo it' })
    if (ok) unsplit.mutate(t.id)
  }
  const saveSplit = (t: any, notAMatch = false) => {
    const parts = splits[t.id] || []
    const cats = companyCategories(t, Number(t.amount) < 0)
    split.mutate({ id: t.id, notAMatch, parts: parts.map(p => {
      // 10/12 (Nic, L5): each part names the company's own category.
      const categoryId = p.categoryId || cats.find(c => c.systemKey === p.category)?.id
      return {
      category: p.category, ...(categoryId ? { categoryId } : {}), amount: (partCents(p.amount) ?? 0) / 100, scopeKind: p.scopeKind,
      ...scopeIds(p),
      ...(p.description ? { description: p.description } : {}),
    } }) })
  }

  const askUndoMatch = async (t: any) => {
    const ok = await appConfirm(
      t.matchKind === 'deposit_slip'
        ? 'Undo this match? The deposit goes back to review and its slip waits for the bank again. Any "other money" on the slip comes back out of your income.'
        : t.matchKind === 'returned_check'
          ? 'Undo this returned check? The check counts as paid again on the day it was paid, the returned-check fee and the late fees it brought are voided (kept on record), the tenant is told, and the line goes back to review. Nothing is undone if the tenant paid since.'
        : t.matchKind === 'gam_payout'
          ? 'Undo this match? The deposit goes back to review, no longer matched to GAM’s payout.'
        : 'Undo this match? The bills it paid are owed again, any late fees it took off come back, credit it created is withdrawn, and the deposit goes back to review. Nothing is undone if any of that changed since.',
      { title: 'Undo this match', confirmLabel: 'Undo it' })
    if (ok) undoMatch.mutate(t.id)
  }

  const categorize = useMutation(
    ({ id, body }: { id: string; body: any }) => apiPost(`/bank-feed/transactions/${id}/categorize`, { ...body, entityId }), {
    onSuccess: (r: any, v) => { qc.invalidateQueries(['bank-txns'])
      clearMatchFirst(v.id)
      // The API returns incomeId for money in, expenseId for money out — say
      // which side it landed on rather than always claiming "expenses".
      toast(r?.data?.incomeId ? 'Categorized → added to your income.' : 'Categorized → added to your expenses.') },
    onError: (e: any, v) => {
      if (isMatchFirst(e)) {
        setMatchFirst(s => ({ ...s, [v.id]: 'categorize' }))
        toast('This line fits something already on your books. Match it below, or press "None of these".')
        return
      }
      toast(e?.response?.data?.error || e?.response?.data?.message || 'Could not categorize.')
    },
  })

  const ignore = useMutation((id: string) => apiPost(`/bank-feed/transactions/${id}/ignore`, { entityId }), {
    onSuccess: () => { qc.invalidateQueries(['bank-txns']); toast('Ignored.') },
  })

  const submit = (t: any, notAMatch = false) => {
    const d = draftFor(t)
    if (!d.scopeKind) { toast('Choose where it goes: one unit, the whole property, or split across your properties.'); return }
    if (d.scopeKind === 'unit' && !d.unitId) { toast('Pick a unit.'); return }
    if (d.scopeKind !== 'unit' && d.scopeKind !== 'split_by_units' && !d.propertyId) { toast('Pick a property.'); return }
    const categoryId = draftCategoryId(t, d)
    categorize.mutate({ id: t.id, body: {
      category: d.category, ...(categoryId ? { categoryId } : {}), scopeKind: d.scopeKind,
      ...scopeIds(d),
      ...(notAMatch ? { notAMatch: true } : {}),
    } })
  }

  const reviewCount = useMemo(() => txns.filter((t: any) => t.status === 'needs_review').length, [txns])

  return (
    <div>
      {/* S629: the feed, the connections and every categorization below belong
          to the entity chosen here. Hidden for a one-entity portfolio. */}
      <EntityPicker value={entityId} onChange={setEntityId} label="Transactions for" />

      {/* S637: until the payout account exists there is nothing to show here and
          no button to press — the only bank worth connecting first is the one
          rent lands in. */}
      {entityId && !connectStatusQ.isLoading && !payoutsReady ? (
        <div className="card" style={{ marginTop: 20, padding: '18px 20px' }}>
          <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 6 }}>
            Set up your payout account first
          </div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 14 }}>
            This page reads your bank transactions so you can categorize spending — it doesn't move
            any money. Before it's useful, connect the account your rent is deposited into.
            Once that's live, you can turn this feed on here.
          </div>
          <button className="btn btn-primary" onClick={() => navigate('/banking')}>
            Go to payout setup
          </button>
        </div>
      ) : embedded ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '26px 0 12px' }}>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-0)' }}>Your spending</div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
              Link your bank read-only. Rent payouts GAM already knows about are hidden; the rest is
              yours to categorize into your P&L.
            </div>
          </div>
          <button className="btn btn-primary" onClick={link} disabled={linking}>
            <Plus size={16} /> {linking ? 'Linking…' : 'Connect feed'}
          </button>
        </div>
      ) : (
        <div className="page-header">
          <div>
            <h1 className="page-title">Bank Feed</h1>
            <p className="page-subtitle">
              Link your operating bank read-only. GAM hides the money it already tracks (rent payouts)
              and surfaces the rest — your own spending — to categorize into your P&L in two clicks.
            </p>
          </div>
          <button className="btn btn-primary" onClick={link} disabled={linking}>
            <Plus size={16} /> {linking ? 'Linking…' : 'Connect feed'}
          </button>
        </div>
      )}
      {linkErr && <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)', marginBottom: 16 }}>{linkErr}</div>}

      {/* S576 (B-5): signpost the sibling workflow so the two "bank" tabs read as
          distinct jobs — this one CATEGORIZES spend; the other MATCHES a statement. */}
      {!embedded && (
        <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 16, lineHeight: 1.5 }}>
          This is for <strong>categorizing spending</strong> from a linked bank into your P&L.
        </div>
      )}

      {/* Linked banks */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title" style={{ marginBottom: 12 }}>Linked banks</div>
        {connections.length === 0
          ? <div style={{ color: 'var(--text-3)', fontSize: '.85rem', lineHeight: 1.6 }}>
              No banks linked yet.
              {/* S605 (Nic): he finished Stripe payout setup and reasonably expected
                  this to fill in. It can't. Stripe Connect tells GAM WHERE TO SEND
                  money; this needs READ access to the bank's transaction history,
                  which is a different permission the bank itself must grant — even
                  for the same account. Say so here, because the Banking page had
                  exactly this confusion and it cost real time. */}
              <div style={{ marginTop: 8, color: 'var(--text-2)' }}>
                <strong style={{ color: 'var(--text-1)' }}>This is separate from your payout setup.</strong>{' '}
                Verifying with Stripe told GAM where to <em>send</em> your rent. This asks your bank for
                read-only permission to <em>see</em> what you spend, so it can land in your P&L —
                a different permission, so your bank has to approve it even if it's the same account.
              </div>
              <div style={{ marginTop: 8 }}>
                Hit <strong>Connect feed</strong> above and sign in to your bank. Read-only —
                nothing can move money from here.
              </div>
            </div>
          : <div style={{ display: 'grid', gap: 8 }}>
              {connections.map((c: any) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border-0)' }}>
                  <Landmark size={18} style={{ color: 'var(--gold)' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{c.displayName || c.institutionName}</div>
                    <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                      {c.lastSyncedAt ? `Last synced ${fmtDate(c.lastSyncedAt)}` : 'Not yet synced'}
                      {c.status === 'error' && c.lastSyncError ? ` · error: ${c.lastSyncError}` : ''}
                    </div>
                    {/* S652 (Nic): linking a bank authorizes payouts AND debits. A link
                        GAM cannot pull from says so here, with the fix beside it. */}
                    {c.debitReady
                      ? <div style={{ fontSize: '.7rem', color: 'var(--green)', marginTop: 2 }}>GAM can pay out to and debit this account.</div>
                      : <div style={{ fontSize: '.7rem', color: 'var(--amber)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span>GAM cannot debit this account: {c.debitProblem || 'unknown reason'}</span>
                          <button className="btn btn-primary btn-sm" style={{ padding: '1px 8px', fontSize: '.68rem' }} onClick={link} disabled={linking}>{linking ? 'Linking…' : 'Relink'}</button>
                        </div>}
                  </div>
                  {/* S605: the account balance, which is what a landlord looks
                      for first on a page about their bank. Absent for links made
                      before balances consent — those show a re-link prompt
                      instead of a blank, so the fix is discoverable. */}
                  <div style={{ textAlign: 'right', marginRight: 4 }}>
                    {c.currentBalance != null
                      ? <>
                          <div style={{ fontWeight: 700, fontSize: '.95rem' }}>{fmt(c.currentBalance)}</div>
                          <div style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>
                            balance{c.balanceAsOf ? ` · ${fmtDate(c.balanceAsOf)}` : ''}
                          </div>
                        </>
                      : <div style={{ fontSize: '.68rem', color: 'var(--text-3)', maxWidth: 150 }}>
                          Balance needs a quick re-link
                        </div>}
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => sync.mutate(c.id)} disabled={sync.isLoading}>
                    <RefreshCw size={14} /> Sync
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={async () => {
                    if (await appConfirm('Disconnect this bank? Past transactions stay; no new ones will sync.')) disconnect.mutate(c.id)
                  }}>Disconnect</button>
                </div>
              ))}
            </div>}
      </div>

      {/* S605: books start date */}
      {connections.length > 0 && (
        <div className="card" style={{ marginBottom: 12, padding: 12, display: 'flex',
          alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontWeight: 600, fontSize: '.82rem' }}>Start my books from</div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2, lineHeight: 1.5 }}>
              Anything before this stays on file but is hidden from review — use it to skip spending
              from before you joined GAM. Already-categorized transactions are never changed, and
              nothing you ignored yourself comes back.
            </div>
          </div>
          <input className="form-input" type="date" value={booksStart} style={{ width: 'auto' }}
            onChange={e => setBooksStart(e.target.value)} />
          <button className="btn btn-primary btn-sm" disabled={saveBooksStart.isLoading || !booksStart}
            onClick={() => saveBooksStart.mutate(booksStart)}>Apply</button>
          {me?.booksStartDate && (
            <button className="btn btn-ghost btn-sm" disabled={saveBooksStart.isLoading}
              onClick={() => { setBooksStart(''); saveBooksStart.mutate(null) }}>Clear</button>
          )}
        </div>
      )}

      {/* 10/12 (Nic): opened from the Expenses page on the line an expense came from. */}
      {focusLine && (
        <div className="card" style={{ marginBottom: 12, padding: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220, fontSize: '.8rem', color: 'var(--text-1)', lineHeight: 1.5 }}>
            The bank line your expense came from. Change how it is filed here: split it, change the split, or undo it.
          </div>
          <button className="btn btn-ghost btn-sm" onClick={showAll}>Show all transactions</button>
        </div>
      )}

      {/* Transaction views */}
      {!focusLine && <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {(['all', 'needs_review', 'categorized', 'ignored'] as const).map(v => (
          <button key={v} className={`btn btn-sm ${view === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView(v)}>
            {v === 'all' ? 'All transactions'
              : v === 'needs_review' ? `Needs review${reviewCount ? ` (${reviewCount})` : ''}`
              : v === 'categorized' ? 'Categorized' : 'Ignored'}
          </button>
        ))}
      </div>}

      <div className="card">
        {isLoading ? <div style={{ color: 'var(--text-3)' }}>Loading…</div>
          : txns.length === 0 ? <div style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>
              {focusLine ? 'That bank line is not on this company’s feed.'
                : view === 'needs_review' ? 'Nothing to review.'
                : view === 'all' ? 'No transactions yet. Sync a linked bank to pull them in.' : 'None.'}
            </div>
          : <div style={{ display: 'grid', gap: 10 }}>
              {txns.map((t: any) => {
                const isExpense = Number(t.amount) < 0
                const d = draftFor(t)
                return (
                  <div key={t.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-0)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{t.normalizedMerchant || t.description || 'Transaction'}</div>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                          {fmtDate(t.postedDate)} · {t.connectionName}
                          {t.description && t.description !== t.normalizedMerchant ? ` · ${t.description}` : ''}
                        </div>
                      </div>
                      {/* S605 (Nic): color alone didn't say which way the money
                          went — "green numbers and white numbers" was a guess.
                          Label it. These are single transaction amounts, not a
                          running balance. */}
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 700, color: isExpense ? 'var(--text-0)' : 'var(--success, #3fb950)' }}>{fmt(t.amount)}</div>
                        <div style={{ fontSize: '.64rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                          {isExpense ? 'money out' : 'money in'}
                        </div>
                      </div>
                    </div>

                    {/* S605 (Nic): "if the only option is to ignore it, why are we even
                        showing it on this page?" — money in used to be a dead end here.
                        It now categorizes as income exactly like money out categorizes as
                        an expense; only the category list differs. 10/12: while the
                        line is being split, the split editor below replaces these. */}
                    {/* 10/12 (Nic, L5): money going out is matched to what it
                        paid FIRST — a bill, a check you wrote, GAM's fee debit,
                        a refund check, a transfer — and filed as a new expense
                        only when nothing fits. */}
                    {t.status === 'needs_review' && isExpense && (!splits[t.id] || matchFirst[t.id]) && (
                      <MoneyOutMatches t={t} entityId={entityId} startOpen={!!matchFirst[t.id]}
                        onNoneOfThese={matchFirst[t.id] ? () => (matchFirst[t.id] === 'split' ? saveSplit(t, true) : submit(t, true)) : undefined}
                        onDone={() => { clearMatchFirst(t.id); qc.invalidateQueries(['bank-txns']); qc.invalidateQueries('landlord-expenses') }} />
                    )}
                    {/* 10/12 (Nic): a deposit one of your loans fits is the loan's
                        money arriving — matched to the loan, never filed as income. */}
                    {t.status === 'needs_review' && !isExpense && t.loanFundingFits && !splits[t.id] && (
                      <MoneyOutMatches t={t} entityId={entityId} moneyIn onDone={() => { qc.invalidateQueries(['bank-txns']) }} />
                    )}
                    {/* 10/14 (Nic, answer 16): "no guessing" — a payout GAM sent of this
                        amount fits, but the memo does not name GAM: the person says. */}
                    {t.status === 'needs_review' && !isExpense && t.payoutSuggestion && !splits[t.id] && (
                      <div className="bankrec-matched" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                        <span style={{ flex: 1, minWidth: 220 }}>
                          GAM’s payout of {fmt(t.payoutSuggestion.amount)} sent {fmtDate(t.payoutSuggestion.sentOn)} fits this deposit.
                          {' '}GAM already counts the payments inside a payout — filing it as income would count them twice.
                        </span>
                        <button className="btn btn-primary btn-sm" disabled={matchPayout.isLoading}
                          onClick={() => matchPayout.mutate({ id: t.id, disbursementId: t.payoutSuggestion.id })}>
                          {matchPayout.isLoading ? 'Matching…' : 'Match it to that payout'}
                        </button>
                      </div>
                    )}
                    {t.status === 'needs_review' && !splits[t.id] && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
                        {companyCategories(t, isExpense).length > 0 ? (
                          <select className="input input-sm" value={draftCategoryId(t, d)} onChange={e => {
                            const c = companyCategories(t, isExpense).find(x => x.id === e.target.value)
                            setDraft(t.id, { categoryId: e.target.value, category: c?.systemKey ?? 'other' })
                          }}>
                            <option value="">Category…</option>
                            {companyCategories(t, isExpense).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        ) : (
                          <select className="input input-sm" value={d.category} onChange={e => setDraft(t.id, { category: e.target.value })}>
                            {isExpense
                              ? EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{EXPENSE_CATEGORY_LABEL[c]}</option>)
                              : OTHER_INCOME_CATEGORIES.map(c => <option key={c} value={c}>{OTHER_INCOME_CATEGORY_LABEL[c]}</option>)}
                          </select>
                        )}
                        <select className="input input-sm" value={d.scopeKind} aria-label="Where it goes"
                          onChange={e => setDraft(t.id, { scopeKind: e.target.value, ...(e.target.value === 'split_by_units' ? { propertyId: '', unitId: '' } : {}) })}>
                          {!d.scopeKind && <option value="">Where does it go?</option>}
                          {scopeChoices(isExpense).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                        {!d.scopeKind || d.scopeKind === 'split_by_units' ? null : d.scopeKind === 'unit' ? (
                          <>
                            <select className="input input-sm" value={d.propertyId} onChange={e => setDraft(t.id, { propertyId: e.target.value, unitId: '' })}>
                              <option value="">Property…</option>
                              {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                            <select className="input input-sm" value={d.unitId} onChange={e => setDraft(t.id, { unitId: e.target.value })} disabled={!d.propertyId}>
                              <option value="">Unit…</option>
                              {unitsForProp(d.propertyId).map((u: any) => <option key={u.id} value={u.id}>{u.unitNumber || u.name || u.label}</option>)}
                            </select>
                          </>
                        ) : (
                          <select className="input input-sm" value={d.propertyId} onChange={e => setDraft(t.id, { propertyId: e.target.value })}>
                            <option value="">Property…</option>
                            {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        )}
                        {t.suggestedCategory && <span style={{ fontSize: '.68rem', color: 'var(--gold)' }}>suggested</span>}
                        {/* 10/14 (Nic, answer 16): where this payer's last deposit went is a
                            suggestion the person presses — never filled in for them. */}
                        {(() => {
                          const sug = placeSuggestion(t)
                          if (!sug || (d.scopeKind === sug.patch.scopeKind && d.propertyId === sug.patch.propertyId
                            && (d.unitId || '') === (sug.patch.unitId || ''))) return null
                          return (
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => setDraft(t.id, sug.patch)}>
                              Same place as last time: {sug.label}
                            </button>
                          )
                        })()}
                        <button className="btn btn-primary btn-sm" onClick={() => submit(t)} disabled={categorize.isLoading}>
                          <Check size={14} /> Confirm
                        </button>
                        <button className="btn btn-primary btn-sm" onClick={() => openSplit(t)}>
                          <Split size={14} /> Split
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => ignore.mutate(t.id)}><X size={14} /> Ignore</button>
                      </div>
                    )}

                    {/* S655: a transaction the bank has not posted yet can still
                        change its amount or wording when it does. */}
                    {t.status === 'needs_review' && t.bankStatus === 'pending' && (
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>
                        Still pending at your bank — the amount or wording can change when it posts.
                      </div>
                    )}
                    {t.status === 'categorized' && t.matchKind !== 'auto_filed' && !(t.splitParts?.length) && (
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span>
                          Added to your {isExpense ? 'expenses' : 'income'}
                          {t.filedCategoryName ? ` as ${t.filedCategoryName}` : t.filedCategory ? ` as ${categoryLabel(isExpense, t.filedCategory)}` : ''}.
                        </span>
                        {!splits[t.id] && t.bankStatus !== 'void' && (
                          <button className="btn btn-primary btn-sm" style={{ padding: '1px 8px', fontSize: '.68rem' }} onClick={() => openSplit(t)}>
                            Split into parts
                          </button>
                        )}
                        {/* 10/12 (Nic): a line filed by hand can be undone too. */}
                        {!splits[t.id] && (
                          <button className="btn btn-primary btn-sm" style={{ padding: '1px 8px', fontSize: '.68rem' }}
                            disabled={undoFiled.isLoading} onClick={() => askUndoFiled(t)}>
                            {undoFiled.isLoading ? 'Undoing…' : 'Undo'}
                          </button>
                        )}
                      </div>
                    )}
                    {/* 10/12 (Nic): a line filed in parts lists each one. */}
                    {t.status === 'categorized' && t.splitParts?.length > 0 && (
                      <div style={{ fontSize: '.72rem', color: 'var(--text-2)', marginTop: 6 }}>
                        <div style={{ color: 'var(--text-3)', marginBottom: 2 }}>Split into {t.splitParts.length} parts:</div>
                        {t.splitParts.map((p: any) => (
                          <div key={p.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600, color: 'var(--text-1)' }}>{fmt(p.amount)}</span>
                            <span>{p.categoryName ?? categoryLabel(isExpense, p.category)}</span>
                            <span style={{ color: 'var(--text-3)' }}>
                              {p.costPlace === 'split_by_units' ? BOOKS_COST_PLACE_LABEL.split_by_units  // wire-ok: a shared label key, not a field off an API response
                                : [p.propertyName, p.unitNumber].filter(Boolean).join(' · ')}
                            </span>
                          </div>
                        ))}
                        {!splits[t.id] && (
                          <div className="bankrec-undo-box">
                            {/* 10/12 review: a line the bank voided cannot be filed again (the server refuses it); undo stays. */}
                            {t.bankStatus !== 'void' && (
                              <button className="btn btn-primary btn-sm" onClick={() => openSplit(t)}>Change the split</button>
                            )}
                            <button className="btn btn-primary btn-sm" disabled={unsplit.isLoading} onClick={() => askUnsplit(t)}>
                              {unsplit.isLoading ? 'Undoing…' : 'Undo the split'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {splits[t.id] && (
                      <SplitEditor
                        total={Number(t.amount)}
                        parts={splits[t.id]}
                        categories={companyCategories(t, isExpense)}
                        properties={properties}
                        unitsForProp={unitsForProp}
                        replacing={t.status === 'categorized'}
                        saving={split.isLoading}
                        onPart={(i, patch) => setPart(t.id, i, patch)}
                        onAdd={() => setSplits(s => ({ ...s, [t.id]: [...(s[t.id] || []), {
                          category: isExpense ? 'repairs' : 'other', amount: '',
                          // 10/13 (Nic): a new part going out asks where it goes.
                          scopeKind: isExpense ? '' : (s[t.id]?.[0]?.scopeKind) || 'property_common',
                          propertyId: isExpense ? '' : (s[t.id]?.[0]?.propertyId) || '', unitId: '',
                        }] }))}
                        onRemove={i => setSplits(s => ({ ...s, [t.id]: (s[t.id] || []).filter((_, j) => j !== i) }))}
                        onCancel={() => closeSplit(t.id)}
                        onSave={() => saveSplit(t)}
                      />
                    )}
                    {/* S655 (Step 12): a deposit that filed itself, labeled, with one-click undo. */}
                    {t.status === 'categorized' && t.matchKind === 'auto_filed' && (
                      <div className="bankrec-matched">
                        <span>
                          {BANK_TXN_MATCH_KIND_LABEL['auto_filed']} — added to your income like the last deposit from {t.normalizedMerchant || 'this payer'}.
                          {/* 10/14 (Nic, answer 16): nothing files itself from a payer's name any
                              more; a line filed that way before keeps its Undo. */}
                        </span>
                        <span className="bankrec-undo-box">
                          <button className="btn btn-primary btn-sm" disabled={undoFiling.isLoading}
                            onClick={() => undoFiling.mutate({ id: t.id })}>Undo</button>
                          {!splits[t.id] && t.bankStatus !== 'void' && (
                            <button className="btn btn-primary btn-sm" onClick={() => openSplit(t)}>Split into parts</button>
                          )}
                        </span>
                      </div>
                    )}
                    {/* S655: a row already filed or matched that the bank later
                        voided stays (it is in the books), and says so. */}
                    {t.bankStatus === 'void' && t.status !== 'ignored' && (
                      <div style={{ fontSize: '.72rem', color: 'var(--amber)', marginTop: 4 }}>
                        {t.status === 'matched'
                          ? 'Your bank voided this deposit after it was matched. Check what it was matched to — the money may never have arrived.'
                          : `Your bank voided this transaction after it was filed. Check the ${isExpense ? 'expense' : 'income'} it created — the money may never have moved.`}
                      </div>
                    )}
                    {t.status === 'matched' && !t.outMatchKind && <MatchedLine t={t} />}
                    {/* 10/12 (Nic, L5): money out matched to what it paid, with its Undo. */}
                    {t.status === 'matched' && t.outMatchKind && (
                      <div className="bankrec-matched">
                        <span>
                          {BANK_LINE_MATCH_KIND_LABEL[t.outMatchKind as BankLineMatchKind] ?? 'Matched'}
                          {t.outMatchLoanName && <> — {t.outMatchLoanName}</>}
                          {t.outMatchKind === 'expenses' && (t.outMatchExpenses ?? []).length > 0 && (
                            <> — {(t.outMatchExpenses as any[]).map(x => `${x.categoryName ?? 'Expense'}${x.vendorName ? ` (${x.vendorName})` : ''} ${fmt(x.amount)}`).join(', ')}</>
                          )}
                        </span>
                        <span className="bankrec-undo-box">
                          <button className="btn btn-primary btn-sm" disabled={undoFiled.isLoading} onClick={async () => {
                            if (await appConfirm('Undo this match? What it paid is owed again (the payment stays on file, marked voided) and the line goes back to review.',
                              { title: 'Undo this match', confirmLabel: 'Undo it' })) undoFiled.mutate(t.id)
                          }}>{undoFiled.isLoading ? 'Undoing…' : 'Undo this match'}</button>
                        </span>
                      </div>
                    )}
                    {t.status === 'matched' && t.canUndo && (
                      <div className="bankrec-undo-box">
                        <button className="btn btn-primary btn-sm" disabled={undoMatch.isLoading} onClick={() => askUndoMatch(t)}>
                          {undoMatch.isLoading ? 'Undoing…' : 'Undo this match'}
                        </button>
                      </div>
                    )}
                    {t.status === 'ignored' && (
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span>
                          {t.ignoredReason && t.ignoredReason in BANK_TXN_IGNORED_REASON_LABEL
                            ? `${BANK_TXN_IGNORED_REASON_LABEL[t.ignoredReason as BankTxnIgnoredReason]}.`
                            : 'Ignored.'}
                        </span>
                        {/* 10/12 (Nic): the owner's own Ignore can be taken back too. */}
                        {t.ignoredReason === 'landlord' && (
                          <button className="btn btn-primary btn-sm" style={{ padding: '1px 8px', fontSize: '.68rem' }}
                            disabled={undoFiled.isLoading} onClick={() => askUndoFiled(t)}>
                            {undoFiled.isLoading ? 'Undoing…' : 'Undo'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>}
      </div>
    </div>
  )
}

/** A filed category's words, from the side of the line it is on. */
function categoryLabel(isExpense: boolean, category: string): string {
  return isExpense
    ? (EXPENSE_CATEGORY_LABEL as Record<string, string>)[category] ?? 'Other'
    : (OTHER_INCOME_CATEGORY_LABEL as Record<string, string>)[category] ?? 'Other income'
}

/**
 * 10/12 (Nic): split one bank line into parts. Each part has its own amount,
 * category and unit or property; the parts must add up to the bank's amount
 * to the cent before Save is offered (the server checks it again).
 */
function SplitEditor({ total, parts, categories, properties, unitsForProp, replacing, saving, onPart, onAdd, onRemove, onCancel, onSave }: {
  total: number
  parts: SplitPart[]
  /** 10/12 (Nic, L5): the company's own categories for this side (empty: GAM's starting list). */
  categories: CompanyCategory[]
  properties: any[]
  unitsForProp: (propertyId: string) => any[]
  replacing: boolean
  saving: boolean
  onPart: (i: number, patch: Partial<SplitPart>) => void
  onAdd: () => void
  onRemove: (i: number) => void
  onCancel: () => void
  onSave: () => void
}) {
  const isExpense = total < 0
  const totalCents = Math.round(Math.abs(total) * 100)
  const sumCents = parts.reduce((s, p) => s + (partCents(p.amount) ?? 0), 0)
  const left = totalCents - sumCents
  const placed = scopePlaced
  const ready = parts.length >= 2 && left === 0
    && parts.every(p => partCents(p.amount) !== null && placed(p))
  const money = (c: number) => fmt(c / 100)
  return (
    // 10/12 review: theme tokens that exist (--border-1, --bg-3), so the editor stands apart from the card it sits in.
    <div style={{ marginTop: 10, padding: 12, border: '1px solid var(--border-1)', borderRadius: 8, background: 'var(--bg-3)' }}>
      <div style={{ fontWeight: 600, fontSize: '.82rem', color: 'var(--text-0)' }}>Split {money(totalCents)} into parts</div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '2px 0 10px', lineHeight: 1.5 }}>
        Each part is filed in its own category, on its own unit or property. The parts must add up to what your bank shows.
        {replacing ? ' Saving replaces how this line is filed now; the old filing stays on file, marked voided.' : ''}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {parts.map((p, i) => (
          <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <input className="input input-sm" inputMode="decimal" placeholder="0.00" value={p.amount} style={{ width: 96 }}
              aria-label={`Part ${i + 1} amount`}
              onChange={e => onPart(i, { amount: e.target.value })} />
            {left > 0 && partCents(p.amount) === null && (
              <button className="btn btn-primary btn-sm" style={{ padding: '1px 8px', fontSize: '.68rem' }}
                onClick={() => onPart(i, { amount: (left / 100).toFixed(2) })}>
                The rest ({money(left)})
              </button>
            )}
            {categories.length > 0 ? (
              <select className="input input-sm" aria-label={`Part ${i + 1} category`}
                value={p.categoryId || categories.find(c => c.systemKey === p.category)?.id || ''}
                onChange={e => {
                  const c = categories.find(x => x.id === e.target.value)
                  onPart(i, { categoryId: e.target.value || undefined, category: c?.systemKey ?? 'other' })
                }}>
                <option value="">Category…</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              <select className="input input-sm" value={p.category} aria-label={`Part ${i + 1} category`}
                onChange={e => onPart(i, { category: e.target.value })}>
                {isExpense
                  ? EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{EXPENSE_CATEGORY_LABEL[c]}</option>)
                  : OTHER_INCOME_CATEGORIES.map(c => <option key={c} value={c}>{OTHER_INCOME_CATEGORY_LABEL[c]}</option>)}
              </select>
            )}
            <select className="input input-sm" value={p.scopeKind} aria-label={`Part ${i + 1} placement`}
              onChange={e => onPart(i, { scopeKind: e.target.value, unitId: '', ...(e.target.value === 'split_by_units' ? { propertyId: '' } : {}) })}>
              {!p.scopeKind && <option value="">Where does it go?</option>}
              {scopeChoices(isExpense).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {p.scopeKind && p.scopeKind !== 'split_by_units' && (
              <select className="input input-sm" value={p.propertyId} aria-label={`Part ${i + 1} property`}
                onChange={e => onPart(i, { propertyId: e.target.value, unitId: '' })}>
                <option value="">Property…</option>
                {properties.map((pr: any) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
              </select>
            )}
            {p.scopeKind === 'unit' && (
              <select className="input input-sm" value={p.unitId} disabled={!p.propertyId} aria-label={`Part ${i + 1} unit`}
                onChange={e => onPart(i, { unitId: e.target.value })}>
                <option value="">Unit…</option>
                {unitsForProp(p.propertyId).map((u: any) => <option key={u.id} value={u.id}>{u.unitNumber || u.name || u.label}</option>)}
              </select>
            )}
            {parts.length > 2 && (
              <button className="btn btn-ghost btn-sm" aria-label={`Remove part ${i + 1}`} onClick={() => onRemove(i)}>
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 10 }}>
        <span style={{ fontSize: '.74rem', color: left === 0 ? 'var(--green)' : 'var(--amber)' }}>
          {left === 0 ? `The parts add up to ${money(totalCents)}.`
            : left > 0 ? `${money(left)} is not in any part yet.`
            : `The parts are ${money(-left)} more than your bank shows.`}
        </span>
        <span style={{ flex: 1 }} />
        {/* 20 is the API's SPLIT_MAX_PARTS (services/bankFeed); it refuses more. */}
        <button className="btn btn-primary btn-sm" onClick={onAdd} disabled={parts.length >= 20}><Plus size={14} /> Add a part</button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={onSave} disabled={!ready || saving}>
          <Check size={14} /> {saving ? 'Saving…' : 'Save split'}
        </button>
      </div>
    </div>
  )
}

// S655: what a matched row was matched TO. Every matched row used to read "GAM
// payout", including a tenant's own cash deposit. A payout now lists the
// payments inside it; a tenant's deposit names whose rent it paid.
function MatchedLine({ t }: { t: any }) {
  const [open, setOpen] = useState(false)
  const line = { fontSize: '.72rem', color: 'var(--gold, #c9a227)', marginTop: 4 } as const
  if (t.matchKind === 'gam_payout') {
    const b = t.payoutBreakdown
    const n = b?.payments?.length ?? 0
    return (
      <div>
        <div style={{ ...line, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>
            {BANK_TXN_MATCH_KIND_LABEL['gam_payout']}
            {b?.traced ? ` — ${n} payment${n === 1 ? '' : 's'}` : ''}; already in your books, never counted twice.
          </span>
          {b && (
            <button className="btn btn-primary btn-sm" style={{ padding: '1px 8px', fontSize: '.68rem' }}
                    onClick={() => setOpen(v => !v)}>
              {open ? 'Hide' : 'Show'} what it paid
            </button>
          )}
        </div>
        {open && b && <div style={{ marginTop: 8 }}><PayoutBreakdown breakdown={b} /></div>}
      </div>
    )
  }
  if (t.matchKind === 'tenant_deposit') {
    const who = [t.matchedUnitNumber, t.matchedTenantName].filter(Boolean).join(' · ')
    const more = Number(t.matchedChargeCount) > 1 ? ` (${t.matchedChargeCount} charges)` : ''
    return (
      <div style={line}>
        {BANK_TXN_MATCH_KIND_LABEL['tenant_deposit']} — applied to {who ? `${who}’s` : 'a tenant’s'} rent{more}
        {t.autoSettledAt ? ' by itself (it was exactly their whole bill, and nothing else fit)' : ''};
        already in your books, never counted twice.
      </div>
    )
  }
  if (t.matchKind === 'deposit_slip') {
    const n = Number(t.slipItemCount) || 0
    return (
      <div style={line}>
        {BANK_TXN_MATCH_KIND_LABEL['deposit_slip']} of {t.slipDepositDate}
        {t.slipSource === 'inferred' ? ` (${DEPOSIT_SLIP_SOURCE_LABEL['inferred' as DepositSlipSource].toLowerCase()})` : ''} —
        {' '}{n} payment{n === 1 ? '' : 's'} already in your books
        {Number(t.slipOtherAmount) > 0 ? `, plus ${fmt(t.slipOtherAmount)} of other money added to your income` : ''}; never counted twice.
      </div>
    )
  }
  // 10/14 (Nic, answer 15): a check the bank returned out of a deposit, taken
  // back by itself — just that check; the bills it paid are owed again.
  if (t.matchKind === 'returned_check') {
    return (
      <div style={line}>
        {BANK_TXN_MATCH_KIND_LABEL['returned_check']} — GAM took back {t.returnedCheckTenantName ? `${t.returnedCheckTenantName}’s` : 'the'} check;
        {' '}the bills it paid are owed again
        {t.returnedCheckFee != null ? `, and a ${fmt(t.returnedCheckFee)} returned-check fee was billed to them`
          : t.returnedCheckFeeFrom === 'unreadable' ? '; their lease’s returned-payment fee could not be read as an amount, so add it by hand'
          : t.returnedCheckFeeFrom === 'none' ? '; your bank showed no fee for it, so none was billed'
          : ', and the returned-check fee is billed to them when your bank’s fee for it shows'}.
        {' '}The bank’s own fee line is yours to file as a bank fee.
      </div>
    )
  }
  return <div style={line}>Matched to money GAM already has on record — never counted twice.</div>
}

type LoanSplit = { principalCents: number; interestCents: number; escrowCents: number }

/**
 * 10/12 (Nic): "principal / interest / escrow per payment" — a bank line that
 * is a loan payment, split as GAM suggests (interest on what is owed, the
 * regular escrow, the rest principal) and editable to the lender's statement
 * before it is matched. The three parts must add up to the line.
 */
function LoanPaymentRecord({ r, lineCents, busy, onMatch }: {
  r: any; lineCents: number; busy: boolean; onMatch: (split: LoanSplit) => void
}) {
  const toDollars = (c: number) => (c / 100).toFixed(2)
  const [principal, setPrincipal] = useState(toDollars(r.split.principalCents))
  const [interest, setInterest] = useState(toDollars(r.split.interestCents))
  const [escrow, setEscrow] = useState(toDollars(r.split.escrowCents))
  const c = (v: string) => Math.round((Number(v) || 0) * 100)
  const split: LoanSplit = { principalCents: c(principal), interestCents: c(interest), escrowCents: c(escrow) }
  const total = split.principalCents + split.interestCents + split.escrowCents
  const valid = [principal, interest, escrow].every(v => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0)
  const fits = valid && total === lineCents
  const box = { width: 96 } as const
  return (
    <div style={{ padding: '4px 0', fontSize: '.78rem' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 180 }}>{BANK_LINE_MATCH_KIND_LABEL['loan_payment']} · {r.label} · {fmtDate(r.day)} · {fmt(r.amount)}</span>
        <button className="btn btn-primary btn-sm" disabled={busy || !fits} onClick={() => onMatch(split)}>This is it</button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        <label>Principal <input className="input input-sm" style={box} inputMode="decimal" value={principal} onChange={e => setPrincipal(e.target.value)} /></label>
        <label>Interest <input className="input input-sm" style={box} inputMode="decimal" value={interest} onChange={e => setInterest(e.target.value)} /></label>
        <label>Escrow <input className="input input-sm" style={box} inputMode="decimal" value={escrow} onChange={e => setEscrow(e.target.value)} /></label>
        <span style={{ color: fits ? 'var(--text-3)' : 'var(--amber)' }}>
          {fits ? 'Adds up to the line. Check it against the lender\'s statement.' : `Comes to ${fmt(total / 100)} of ${fmt(lineCents / 100)}.`}
        </span>
      </div>
    </div>
  )
}

/**
 * 10/12 (Nic, L5): "money out = ONE record" — what a money-out bank line could
 * be, offered before it is filed as a new expense (GET /bank-feed/transactions
 * /:id/matches): the open bills and the checks already written (pick one, or
 * several that add up to the line), then GAM's fee debit, a register refund or
 * refund check, the same money arriving in another of your accounts, or a
 * payment on one of your loans. With `moneyIn`, a deposit one of your loans
 * fits: the loan's money arriving (10/12, Nic).
 */
function MoneyOutMatches({ t, entityId, onDone, moneyIn = false, startOpen = false, onNoneOfThese }: {
  t: any; entityId: string; onDone: () => void; moneyIn?: boolean
  /** 10/12 review: the server found it already on record — open at once. */
  startOpen?: boolean
  /** 10/12 review: file it as a new expense anyway (notAMatch). */
  onNoneOfThese?: () => void
}) {
  const [open, setOpen] = useState(startOpen)
  useEffect(() => { if (startOpen) setOpen(true) }, [startOpen])
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [askReturned, setAskReturned] = useState(false)
  const { data, isLoading } = useQuery<any>(['bank-out-matches', t.id], () => apiGet(`/bank-feed/transactions/${t.id}/matches`), { enabled: open })
  const lineCents = Math.round(Math.abs(Number(t.amount)) * 100)
  const matchExpenses = useMutation((body: { expenseIds: string[]; paymentIds: string[] }) =>
    apiPost(`/bank-feed/transactions/${t.id}/match-expenses`, { ...body, entityId }), {
    onSuccess: () => { toast('Matched. What it paid is marked paid from the bank.'); setOpen(false); onDone() },
    onError: (e: any) => toast.error(e?.message || 'That match could not be saved.'),
  })
  const matchRecord = useMutation((body: { kind: string; recordId: string; split?: LoanSplit | null }) =>
    apiPost(`/bank-feed/transactions/${t.id}/match-record`, { ...body, entityId }), {
    onSuccess: () => { toast('Matched.'); setOpen(false); onDone() },
    onError: (e: any) => toast.error(e?.message || 'That match could not be saved.'),
  })
  // 10/14 (Nic, answer 15): the owner picks the check the bank returned.
  const bounced = useMutation((remittanceId: string) =>
    apiPost(`/bank-feed/transactions/${t.id}/returned-check`, { remittanceId, entityId }), {
    onSuccess: () => {
      toast('Taken back. The bills that check paid are owed again, with any late fees and the returned-check fee, and the tenant was told.')
      setOpen(false); onDone()
    },
    onError: (e: any) => toast.error(e?.message || 'That check could not be taken back.'),
  })
  const askBounced = async (c: any) => {
    const ok = await appConfirm(
      `Take back ${c.tenantName ? `${c.tenantName}’s` : 'this'} ${fmt(c.amount)} ${c.method === 'money_order' ? 'money order' : 'check'} from the deposit of ${fmtDate(c.depositedOn)}? `
        + 'Just that payment comes off the bills it paid: they are owed again with any late fees from their due dates, the returned-check fee is billed, and the tenant is told. You can undo it.',
      { title: 'A check bounced', confirmLabel: 'Take it back' })
    if (ok) bounced.mutate(c.remittanceId)
  }
  if (!open) {
    return (
      <div style={{ marginTop: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>{moneyIn ? 'Is this money from your loan?' : 'What did this pay?'}</button>
      </div>
    )
  }
  const expenses: any[] = data?.expenses ?? []
  const checks: any[] = data?.checks ?? []
  const records: any[] = data?.records ?? []
  const returnedChecks: any[] = moneyIn ? [] : (data?.returnedChecks ?? [])
  // Open at once on a line that speaks of a return; one press away on any other.
  const showReturned = returnedChecks.length > 0 && (!!data?.returnedLine || askReturned)
  const pickedCents = [...expenses.filter(e => picked[`e:${e.expenseId}`]).map(e => Math.round(e.unpaid * 100)),
    ...checks.filter(c => picked[`c:${c.paymentId}`]).map(c => Math.round(c.amount * 100))].reduce((a, b) => a + b, 0)
  const pickedCount = Object.values(picked).filter(Boolean).length
  const onePartial = pickedCount === 1 && expenses.some(e => picked[`e:${e.expenseId}`] && Math.round(e.unpaid * 100) > lineCents)
  const fits = pickedCount > 0 && (pickedCents === lineCents || onePartial)
  const row = { display: 'flex', gap: 8, alignItems: 'center', fontSize: '.78rem', padding: '3px 0' } as const
  return (
    <div className="bankrec-matched" style={{ display: 'block', marginTop: 8 }}>
      {isLoading ? <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Looking…</div> : (
        <>
          {/* 10/14 (Nic, answer 15): a check the bank returned — GAM could not be
              sure which one, so the owner picks. A tenant's own bank deposit is
              taken back with Undo this match on that deposit instead. */}
          {returnedChecks.length > 0 && !showReturned && (
            <div style={{ marginBottom: 6 }}>
              <button className="btn btn-primary btn-sm" onClick={() => setAskReturned(true)}>Was this a check your bank returned?</button>
            </div>
          )}
          {showReturned && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 2 }}>
                If this is a check your bank returned, pick the one that bounced:
              </div>
              {returnedChecks.map(c => (
                <div key={c.remittanceId} style={row}>
                  <span style={{ flex: 1 }}>
                    {c.tenantName ?? 'A tenant'}{c.spaces ? ` (${c.spaces})` : ''} · {c.method === 'money_order' ? 'Money order' : c.tenantDeposit ? 'Their own bank deposit' : 'Check'} · {fmt(c.amount)} · deposited {fmtDate(c.depositedOn)}
                  </span>
                  {c.tenantDeposit
                    ? <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Use Undo this match on that deposit</span>
                    : <button className="btn btn-primary btn-sm" disabled={bounced.isLoading} onClick={() => askBounced(c)}>This one bounced</button>}
                </div>
              ))}
            </div>
          )}
          {expenses.length + checks.length + records.length + returnedChecks.length === 0 && (
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
              {moneyIn ? 'No loan fits this deposit any more. File it below.' : 'Nothing on record fits this line. File it below as a new expense.'}
            </div>
          )}
          {(expenses.length > 0 || checks.length > 0) && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 2 }}>Bills and checks you logged — tick what this line paid:</div>
              {checks.map(c => (
                <label key={c.paymentId} style={row}>
                  <input type="checkbox" checked={!!picked[`c:${c.paymentId}`]} onChange={e => setPicked(p => ({ ...p, [`c:${c.paymentId}`]: e.target.checked }))} />
                  <span>Check written {fmtDate(c.paidOn)} · {c.categoryName ?? 'Expense'}{c.vendorName ? ` · ${c.vendorName}` : ''} · {fmt(c.amount)}{c.exact ? ' · same amount' : ''}</span>
                </label>
              ))}
              {expenses.map(e => (
                <label key={e.expenseId} style={row}>
                  <input type="checkbox" checked={!!picked[`e:${e.expenseId}`]} onChange={ev => setPicked(p => ({ ...p, [`e:${e.expenseId}`]: ev.target.checked }))} />
                  <span>{e.categoryName ?? 'Expense'}{e.vendorName ? ` · ${e.vendorName}` : ''}{e.description ? ` · ${e.description}` : ''} · {fmt(e.unpaid)} owed{e.dueDate ? ` · due ${fmtDate(e.dueDate)}` : ''}{e.exact ? ' · same amount' : ''}</span>
                </label>
              ))}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                <button className="btn btn-primary btn-sm" disabled={!fits || matchExpenses.isLoading}
                  onClick={() => matchExpenses.mutate({
                    expenseIds: expenses.filter(e => picked[`e:${e.expenseId}`]).map(e => e.expenseId),
                    paymentIds: checks.filter(c => picked[`c:${c.paymentId}`]).map(c => c.paymentId),
                  })}>Match</button>
                <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                  {pickedCount === 0 ? 'Tick one or more.' : fits ? (onePartial ? 'This line pays part of it.' : 'Adds up to the line.')
                    : `Ticked: ${fmt(pickedCents / 100)} of ${fmt(lineCents / 100)}.`}
                </span>
              </div>
            </div>
          )}
          {records.map(r => r.kind === 'loan_payment' && r.split ? (
            <LoanPaymentRecord key={`${r.kind}:${r.id}`} r={r} lineCents={lineCents} busy={matchRecord.isLoading}
              onMatch={split => matchRecord.mutate({ kind: r.kind, recordId: r.id, split })} />
          ) : (
            <div key={`${r.kind}:${r.id}`} style={row}>
              <span style={{ flex: 1 }}>{BANK_LINE_MATCH_KIND_LABEL[r.kind as BankLineMatchKind] ?? r.label} · {r.label} · {fmtDate(r.day)} · {fmt(r.amount)}</span>
              <button className="btn btn-primary btn-sm" disabled={matchRecord.isLoading} onClick={() => matchRecord.mutate({ kind: r.kind, recordId: r.id })}>This is it</button>
            </div>
          ))}
        </>
      )}
      <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {onNoneOfThese && (
          <button className="btn btn-primary btn-sm" onClick={onNoneOfThese}>None of these — file it as a new expense</button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); setPicked({}) }}>Close</button>
      </div>
    </div>
  )
}
