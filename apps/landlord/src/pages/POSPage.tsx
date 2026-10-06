import { useState, useEffect, useRef, Fragment } from 'react'
import { useUrlTab } from '../lib/useUrlTab'
import type { KeyboardEvent as ReactKeyboardEvent, ClipboardEvent as ReactClipboardEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import {
  discoverReaders, connectReader, collectCardPayment, cancelCurrentPayment, clearReaderPrompt,
  createTerminalIntent, processIntentOnReader, pollPiUntilTerminal,
  cancelTerminalIntent, showCartOnReader as showCartLive, TAP_WINDOW_SECONDS,
  listRegisteredReaders, registerNewReader, archiveRegisteredReader,
  type RegisteredReader,
} from '../lib/terminal'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiPut, apiDel } from '../lib/api'
import { humanize, processingFeeFor, rvSiteFactsLabel, SUPPORTED_CARD_READER, READER_ORDER_STATUS_LABEL, STAY_TERMS, STAY_TERMS_LABEL, RETURNING_GUEST_LABEL, type StayTerms } from '@gam/shared'
import { enqueue as enqueueSync, preloadMapping, mintClientId } from '../lib/syncQueue'
import { appConfirm, appPrompt } from '../components/dialogs'
import { SendPayLinkModal, PayLinksTab } from './POSPayLinks'
import { POSCustomerPicker, toastOnce, errorMessage, type PickedPerson, type NewCustomerDraft } from '../components/POSCustomerPicker'

// S243: Active reader for the terminal flow. Two paths:
//   - 'smart'     — server-driven (S700, WisePOS E, etc.) registered
//                    via /pos/terminal/readers. Backend pushes the PI;
//                    frontend polls status.
//   - 'bluetooth' — client-driven via the Stripe Terminal JS SDK
//                    (handheld readers paired through the browser).
type ActiveReader =
  | { type: 'smart'; stripeReaderId: string; nickname: string }
  | { type: 'bluetooth'; sdkReader: any; label: string }
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const pct = (n: any) => n != null ? `${(Number(n)*100).toFixed(2)}%` : '—'

const STATUS_MAP: Record<string,string> = { completed:'badge-green', voided:'badge-red', refunded:'badge-amber', partial_refund:'badge-amber' }
// S653 (Nic): "flag the history different for pay links vs terminal reader."
// The API says HOW a card arrived (tender); payment_method alone says only 'card'.
const METHOD_MAP: Record<string,string> = { cash:'badge-green', card:'badge-blue', card_reader:'badge-blue', pay_link:'badge-gold', pay_link_in_person_cash:'badge-gold', pay_link_in_person_card:'badge-gold', card_on_file:'badge-blue', charge:'badge-amber' }
// S654 (Nic): online and in person are different facts about the same card.

/** The person a recorded sale names, as the picker shows them — or nobody (a card with no name yet). */
function personOfSale(t: any): PickedPerson | null {
  if (t?.tenantId) return { kind: 'resident', tenantId: t.tenantId, customerId: t.posCustomerId ?? null, name: t.tenantName || 'Resident', hint: 'resident' }
  const name = String(t?.customerName ?? '').trim()
  if (t?.posCustomerId && name && name !== 'Card Customer') return { kind: 'customer', tenantId: null, customerId: t.posCustomerId, name }
  return null
}

/**
 * 10/2 (Nic): the person a ticket or pay link names, as the chip shows them —
 * by the name on the ticket itself, whether or not they would turn up in a
 * search. A reservation with nobody named is nobody.
 */
function personOfTicket(t: any): PickedPerson | null {
  const name = String(t?.customerName ?? '').trim()
  if (t?.tenantId) return { kind: 'resident', tenantId: t.tenantId, customerId: null, name: name || 'Resident', hint: 'resident' }
  if (t?.posCustomerId) return { kind: 'customer', tenantId: null, customerId: t.posCustomerId, name: name && name !== 'Card Customer' ? name : 'Unnamed customer' }
  return null
}

/** A ticket's lines as the cart holds them. A line with no register item (a pay link's own) is an open line. */
function cartFromTicket(t: any): CartItem[] {
  // 10/2 (decisions #9): a reservation ticket's stay comes priced by the server
  // at what the reservation owes, marked as the reservation — shown as it is.
  // 10/3 (decisions #9, #23): a pay link's reservation comes the same way, with
  // its nights — the reservation's own, changed only on the schedule.
  return (t?.items || []).map((i: any, n: number) => ({
    id: i.id || `open-${t.id}-${n}`, name: i.name || 'Item', price: Number(i.price) || 0, qty: Number(i.qty) || 1,
    tax: Number(i.tax) || 0, cat: i.cat || '', icon: '📦', chargeEligible: true, stayUnit: null,
    reservation: !!i.reservation,
    // 10/5 (Nic, R8): a link's background check stays on it — it cannot be taken off.
    fixed: !!i.screening,
    ...(i.reservation && Number(i.nights) > 0 ? { nights: Number(i.nights) } : {}),
  }))
}

/**
 * 10/2 (review): a pay link's discount for the cart now in the register — all
 * of it while the cart keeps every line the link was sent with, else the share
 * of the link (by value) the cart still keeps. The same arithmetic as the
 * server's linkDiscountFor (routes/pos.ts): a line is the link's by (item,
 * price), or by (name, price) for a line with no register item; at most as
 * many of each as the link carries.
 */
function linkDiscountShare(discount: number, linkLines: any[], cart: CartItem[]): number {
  const key = (id: string | null, name: string, price: number) =>
    id ? `i:${id.trim().toLowerCase()}:${price.toFixed(2)}` : `t:${name}|${price.toFixed(2)}`
  const sent = new Map<string, { qty: number; price: number }>()
  for (const l of linkLines) {
    const price = Number(l?.price) || 0
    const k = key(l?.id || null, String(l?.name ?? ''), price)
    const e = sent.get(k) ?? { qty: 0, price }
    e.qty += Number(l?.qty) || 0
    sent.set(k, e)
  }
  const kept = new Map<string, number>()
  for (const i of cart) {
    const k = key(i.id.startsWith('open-') ? null : i.id, i.name, Number(i.price) || 0)
    kept.set(k, (kept.get(k) ?? 0) + Math.max(0, Number(i.qty) || 0))
  }
  let whole = 0, keptValue = 0
  sent.forEach((e, k) => { whole += e.qty * e.price; keptValue += Math.min(e.qty, kept.get(k) ?? 0) * e.price })
  const share = whole > 0 ? Math.min(1, keptValue / whole) : 1
  return Math.round((Number(discount) || 0) * share * 100) / 100
}

/** What a ticket holds, to tell whether the cart still matches it. */
type TicketSnapshot = { id: string; lines: string; tenantId: string | null; posCustomerId: string | null; name: string | null }
const linesKey = (items: { id: string | null; qty: number; price: number }[]) =>
  items.map(i => `${i.id ?? ''}:${Number(i.qty)}:${Number(i.price).toFixed(2)}`).sort().join('|')

// 10/2 (review): what the last link of each sale said, and its Undo. Kept
// outside the row: a History row is drawn afresh once the sale names someone
// new, and the message and its Undo must still be there.
const linkNotes = new Map<string, { said: string | null; undo: string | null }>()

// 10/2 (Nic): "on the history, same thing... start typing in their name; if
// they're an existing customer I can click them and link them to that
// transaction. And then have it retroactively fill to any matching cards."
// Linking moves THIS sale to the person picked — it never renames whoever the
// sale named before — and the server carries every other sale on the same card
// that nobody had confirmed, then says so in one line, with an Undo.
function SaleCustomerLink({ saleId, propertyId, current, startOpen, onLinked }: {
  saleId: string
  propertyId: string
  current: PickedPerson | null
  startOpen?: boolean
  onLinked: (r: any, picked: PickedPerson | null) => void
}) {
  const [editing, setEditing] = useState(!!startOpen && !current)
  const [note, setNote] = useState<{ said: string | null; undo: string | null }>(() => linkNotes.get(saleId) ?? { said: null, undo: null })
  const remember = (n: { said: string | null; undo: string | null }) => { linkNotes.set(saleId, n); setNote(n) }
  const linkMut = useMutation(
    (v: { body: any; picked: PickedPerson | null }) => apiPatch<any>(`/pos/transactions/${saleId}/customer`, v.body),
    { onSuccess: (r: any, v) => { setEditing(false); remember({ said: r?.message ?? null, undo: r?.undo ?? null }); toastOnce(r?.message || 'Customer linked'); onLinked(r, v.picked) },
      onError: (e: any) => toastOnce(errorMessage(e, 'The customer could not be linked — check the connection and pick them again.'), { error: true }) })
  // 10/2 (review): a wrong pick is put back with one button — the sale, and
  // every other sale and card the link carried with it.
  const undoMut = useMutation(
    (undo: string) => apiPost<any>(`/pos/transactions/${saleId}/customer/undo`, { undo }).then((r: any) => r?.data),
    { onSuccess: (r: any) => {
        remember({ said: r?.message ?? null, undo: null }); toastOnce(r?.message || 'Put back')
        const name = String(r?.customerName ?? '').trim()
        onLinked(r, r?.posCustomerId && name ? { kind: r?.tenantId ? 'resident' : 'customer', tenantId: r?.tenantId ?? null, customerId: r.posCustomerId, name } : null)
      },
      onError: (e: any) => { remember({ said: note.said, undo: null }); toastOnce(errorMessage(e, 'That could not be undone — check the connection, then open the sale in History and pick the right person.'), { error: true }) } })
  const pick = (p: PickedPerson | null) => {
    if (!p) return
    // Someone from outside this company: their record here is made with the link.
    linkMut.mutate({ body: p.pick ? { match: { pick: p.pick } } : p.kind === 'resident' ? { tenantId: p.tenantId } : { posCustomerId: p.customerId }, picked: p })
  }
  const addNew = (d: NewCustomerDraft) => linkMut.mutate({
    body: { addNew: { firstName: d.firstName, lastName: d.lastName || null, email: d.email || null, phone: d.phone || null } },
    picked: null })
  if (editing) return (
    <div style={{display:'grid',gap:6,width:'100%'}}>
      <POSCustomerPicker propertyId={propertyId} value={null} onChange={pick} onAddNew={addNew} sealedPicks busy={linkMut.isLoading}
        autoFocus={!startOpen} placeholder="Type their name to link this sale" />
      {current && <button type="button" className="btn btn-ghost btn-sm" style={{justifySelf:'start'}} onClick={()=>setEditing(false)}>Cancel</button>}
    </div>
  )
  return (
    <div style={{display:'grid',gap:4,width:'100%'}}>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        <span style={{color:'var(--text-3)',fontSize:'.75rem'}}>Customer:</span>
        {/* 10/2: whoever the sale names shows by name, with × to take them off it. */}
        {current ? (
          <span style={{display:'inline-flex',alignItems:'center',gap:6,padding:'2px 4px 2px 10px',border:'1px solid var(--gold)',borderRadius:'var(--r-md)',background:'var(--gold-bg)'}}>
            <strong style={{fontSize:'.8rem'}}>{current.name}</strong>
            {current.hint && <span style={{color:'var(--text-3)',fontSize:'.72rem'}}>{current.hint}</span>}
            <button type="button" aria-label="Remove the customer from this sale" title="Remove the customer from this sale" disabled={linkMut.isLoading || undoMut.isLoading}
              onClick={()=>linkMut.mutate({ body: { posCustomerId: null }, picked: null })}
              style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-2)',fontSize:'1rem',lineHeight:1,padding:'0 4px'}}>×</button>
          </span>
        ) : <strong style={{fontSize:'.8rem'}}>none yet</strong>}
        <button type="button" className="btn btn-primary btn-sm" disabled={undoMut.isLoading} onClick={()=>{ remember({ said: null, undo: null }); setEditing(true) }}>{current ? 'Change customer' : 'Add customer'}</button>
      </div>
      {note.said && <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',fontSize:'.72rem',color:'var(--text-2)'}}>
        <span>{note.said}</span>
        {note.undo && <button type="button" className="btn btn-primary btn-sm" disabled={undoMut.isLoading} onClick={()=>undoMut.mutate(note.undo!)}>
          {undoMut.isLoading ? 'Putting back…' : 'Undo'}</button>}
      </div>}
    </div>
  )
}

// S654 (Nic): one customer record — edit it, open its history, fold it into
// another. Merge candidates are the same email or the same phone; never the
// same name ("people aren't going to have the same email if they're a different
// person"). The folded record is archived, never deleted.
function CustomerEditor({ c, all, onHistory, onChanged }: { c: any; all: any[]; onHistory: () => void; onChanged: () => void }) {
  const qc = useQueryClient()
  const [form, setForm] = useState({ firstName: c.firstName || '', lastName: c.lastName || '', email: c.email || '', phone: c.phone || '' })
  const [mergeInto, setMergeInto] = useState('')
  const [confirmMerge, setConfirmMerge] = useState(false)
  const refresh = () => { qc.invalidateQueries('pos-customer-base'); qc.invalidateQueries('pos-transactions') }
  const saveMut = useMutation(
    () => apiPatch(`/pos/customers/${c.id}`, { firstName: form.firstName.trim() || undefined, lastName: form.lastName.trim(), email: form.email.trim() || null, phone: form.phone.trim() || null }),
    { onSuccess: () => { refresh(); toastOnce('Saved') }, onError: (e: any) => toastOnce(errorMessage(e, 'Could not save — check the connection and press Save again.'), { error: true }) })
  const mergeMut = useMutation(
    () => apiPost(`/pos/customers/${c.id}/merge`, { into: mergeInto }),
    { onSuccess: () => { refresh(); setConfirmMerge(false); toastOnce('Merged'); onChanged() }, onError: (e: any) => { setConfirmMerge(false); toastOnce(errorMessage(e, 'Could not merge — check the connection and press Merge again.'), { error: true }) } })
  const dupeIds: string[] = c.duplicateIds || []
  const others = all.filter(o => o.id !== c.id)
  const ordered = [...others.filter(o => dupeIds.includes(o.id)), ...others.filter(o => !dupeIds.includes(o.id))]
  const target = others.find(o => o.id === mergeInto)
  const label = (o: any) => `${o.firstName} ${o.lastName}`.trim() + (o.email ? ` — ${o.email}` : o.phone ? ` — ${o.phone}` : '')
  return (
    <div style={{display:'grid',gap:10}}>
      {/* 10/2: a resident's name, email and phone are on their own account. */}
      {c.isResident ? (
        <div style={{fontSize:'.78rem',color:'var(--text-2)'}}>Resident — their name, email and phone come from their own account and are changed there.</div>
      ) : (
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
        <input className="form-input" placeholder="First name" value={form.firstName} onChange={e=>setForm(f=>({ ...f, firstName:e.target.value }))} />
        <input className="form-input" placeholder="Last name" value={form.lastName} onChange={e=>setForm(f=>({ ...f, lastName:e.target.value }))} />
        <input className="form-input" type="email" placeholder="Email" value={form.email} onChange={e=>setForm(f=>({ ...f, email:e.target.value }))} />
        <input className="form-input" placeholder="Phone" value={form.phone} onChange={e=>setForm(f=>({ ...f, phone:e.target.value }))} />
      </div>)}
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        {!c.isResident && <button className="btn btn-primary btn-sm" disabled={!form.firstName.trim()||saveMut.isLoading} onClick={()=>saveMut.mutate()}>{saveMut.isLoading?'Saving…':'Save'}</button>}
        <button className="btn btn-ghost btn-sm" onClick={onHistory}>Purchase history</button>
        <span style={{flex:1}} />
        <span style={{fontSize:'.75rem',color:'var(--text-3)'}}>Fold into</span>
        <select className="form-select" value={mergeInto} onChange={e=>{ setMergeInto(e.target.value); setConfirmMerge(false) }} style={{minWidth:240}}>
          <option value="">Choose a customer…</option>
          {ordered.map(o => <option key={o.id} value={o.id}>{dupeIds.includes(o.id) ? '★ ' : ''}{label(o)}</option>)}
        </select>
        {!confirmMerge ? (
          <button className="btn btn-ghost btn-sm" disabled={!mergeInto} onClick={()=>setConfirmMerge(true)}>Merge</button>
        ) : (
          <button className="btn btn-primary btn-sm" disabled={mergeMut.isLoading} onClick={()=>mergeMut.mutate()}>
            {mergeMut.isLoading ? 'Merging…' : `Confirm: fold ${`${c.firstName} ${c.lastName}`.trim()} into ${target ? `${target.firstName} ${target.lastName}`.trim() : '…'}`}
          </button>
        )}
      </div>
      {dupeIds.length>0 && <div style={{fontSize:'.75rem',color:'var(--text-3)'}}>★ same email or phone as this record — likely the same person.</div>}
      {confirmMerge && <div style={{fontSize:'.75rem',color:'var(--text-2)'}}>Their purchases, cards on file, open tickets and charge account move to that record; this one is archived (never deleted).</div>}
    </div>
  )
}

const TENDER_LABEL: Record<string,string> = { cash:'Cash', card:'Card · online', card_reader:'Card · in person', pay_link:'Pay link · online', pay_link_in_person_cash:'Pay link · in person (cash)', pay_link_in_person_card:'Pay link · in person (card)', card_on_file:'Card on file', charge:'Charge account' }
// S512 LAUNCH: the "charge" (FlexCharge) tender is hidden at launch with the
// rest of the Flex Suite. The button is filtered out of the register picker so
// a clerk can only ring cash/card; all charge code stays for post-launch.
const LAUNCH_HIDE_CHARGE = true
// S218: pos_categories is the source of truth for the category list.
// Pre-S218 this file used a hardcoded ['fuel','amenity','laundry',
// 'parking','fee','misc']. The DB pos_categories table + /api/pos/
// categories endpoint already existed with the same set seeded as
// DEFAULT_CATEGORIES in the API; this file just wasn't consuming them.
// S227: FALLBACK_CATEGORIES removed — the FK refactor means dropdown
// values must be category UUIDs, not name strings. The very-first-load
// case now shows an empty dropdown until /pos/categories resolves;
// landlord can't submit an item without a real category id anyway.

// S651: stayUnit is set only on a STAY item (a night, a week or a month per
// unit of quantity). Its presence is what makes the register ask for a site and
// an arrival date before it will take the money — see StayDetailsModal.
// 10/2 (decisions #9): `reservation` marks a reservation ticket's stay line —
// the reservation itself, at what it still owes (its price was quoted on the
// schedule, tax included). It is not re-priced or re-counted at the register.
// 10/3 (decisions #23): `nights` — a pay link's stay, as the reservation has
// it. Its nights, site and price change only on the schedule, never here.
// 10/3 (decisions #9, #21): `stayUnitId` / `stayCheckIn` / `stayTotal` /
// `stayTax` — a stay rung here once its site and arrival are picked: what its
// nights cost by the schedule's own pricing (the same figure a pay link and the
// schedule charge), with the lodging tax inside it. Changing its nights clears
// them — the site is picked again for the new length.
// 10/5 (Nic): `stayEmail` / `stayTerms` / `stayExtend` / `screeningFee` — the
// guest's email, the counter's lease answer, the stay a month is added to and
// the background check's fee the server quoted (POST /pos/stays/quote); they
// ride on the stay's line so every pricing call (the reader's too) prices the
// same stay. `fixed` — a line the register cannot take off (a pay link's
// background check).
interface CartItem { id:string; name:string; price:number; qty:number; tax:number; cat:string; icon:string; chargeEligible:boolean; stayUnit?:'night'|'week'|'month'|null; reservation?:boolean; nights?:number
  stayUnitId?:string; stayCheckIn?:string; stayTotal?:number; stayTax?:number
  stayEmail?:string|null; stayTerms?:StayTerms|null; stayExtend?:string|null; screeningFee?:number|null; fixed?:boolean
  /** 10/6 (Nic): "Returning guest — they've stayed with us before" — no background check (owner / a manager only). */
  stayReturning?:boolean|null }

/** 10/3 (decisions #9): a stay whose site and arrival are picked shows what its nights cost; anything else, price × quantity. */
const stayPriced = (i: CartItem) => !!i.stayUnit && !i.reservation && typeof i.stayTotal === 'number'
/** A line's amount before tax — a priced stay at its price less the lodging tax inside it. */
const lineAmount = (i: CartItem) => stayPriced(i) ? Math.round(((i.stayTotal ?? 0) - (i.stayTax ?? 0)) * 100) / 100 : i.price * i.qty
/** A line's tax — a priced stay's lodging tax; a reservation's is in its price. */
const lineTax = (i: CartItem) => stayPriced(i) ? (i.stayTax ?? 0) : i.price * i.qty * i.tax
/** A stay's nights changed: its site and price are picked again for the new length. */
const unpriceStay = <T extends CartItem>(i: T): T => {
  const { stayUnitId: _u, stayCheckIn: _c, stayTotal: _t, stayTax: _x, stayEmail: _e, stayTerms: _l, stayExtend: _m, screeningFee: _f, stayReturning: _r, ...rest } = i
  return rest as T
}

/**
 * A cart line as the server's pricing calls take it (the quote, the card
 * reader's charge and breakdown). A reservation's line names its ticket, so the
 * server prices it as the reservation — the same way the sale does.
 */
function wireLine(i: CartItem, ticketId: string | null, linkId: string | null = null) {
  return { id: i.id.startsWith('open-') ? null : i.id, name: i.name, qty: i.qty, price: i.price, tax: i.tax,
           ...(i.reservation && ticketId ? { openTicketId: ticketId } : {}),
           // 10/3: a pay link's reservation names its link (and its nights), so
           // the server prices it as the reservation — the quote, the reader, the sale.
           ...(i.reservation && linkId ? { payLinkId: linkId, reservation: true, ...(i.nights ? { nights: i.nights } : {}) } : {}),
           // 10/3 (decisions #9): a stay carries its site, arrival and the figure
           // the register shows, so every pricing call prices the same nights the
           // same way — and refuses a figure that is not what they cost now.
           ...(stayPriced(i) && i.stayUnitId ? { stayUnitId: i.stayUnitId, stayCheckIn: i.stayCheckIn, stayTotal: i.stayTotal,
             // 10/5: who it is for, the lease answer, the month added and the background check's fee as shown.
             ...(i.stayEmail ? { stayEmail: i.stayEmail } : {}), ...(i.stayTerms ? { stayTerms: i.stayTerms } : {}),
             ...(i.stayExtend ? { stayExtend: i.stayExtend } : {}), ...(i.screeningFee ? { screeningFee: i.screeningFee } : {}),
             ...(i.stayReturning ? { stayReturning: true } : {}) } : {}) }
}


// POS money/quantity fields are never negative. Spread {...nonNeg} into every
// numeric input to block a value < 0 three ways: typing '-'/'+'/'e', spinner-
// stepping below 0 (min=0), and pasting a string containing '-'.
const blockNeg = (e: ReactKeyboardEvent<HTMLInputElement>) => {
  if (e.key === '-' || e.key === '+' || e.key === 'e' || e.key === 'E') e.preventDefault()
}
const blockNegPaste = (e: ReactClipboardEvent<HTMLInputElement>) => {
  if (e.clipboardData.getData('text').includes('-')) e.preventDefault()
}
const nonNeg = { min: 0, onKeyDown: blockNeg, onPaste: blockNegPaste }

export function POSPage() {
  const qc = useQueryClient()
  const [payLinkOpen, setPayLinkOpen] = useState(false)
  const [tab, setTab] = useUrlTab('tab', 'register', ['register','history','customers','paylinks','items','categories','taxes','discounts','vendors','orders','inventory','readers'] as const)

  const [cart, setCart] = useState<CartItem[]>([])
  // S651: the site + dates + guest for a stay in the cart. Held here rather
  // than inside the modal so the details survive the modal closing, and so
  // checkout can refuse to run without them.
  const [stay, setStay] = useState<any | null>(null)
  const [stayModal, setStayModal] = useState(false)
  // The stay line in the cart, if there is one. Only ONE kind of stay can be
  // sold at a time — two different lengths on one sale have no single set of
  // dates, and the server refuses it too.
  const stayLine = cart.find(i => !!i.stayUnit) || null
  const stayInCart = !!stayLine
  // 10/3 (decisions #9): ready to charge once its site and arrival are picked
  // for the nights in the cart (changing the nights asks for the site again).
  const stayReady = !!stay && !!stayLine && (stayLine.reservation || stayPriced(stayLine))
  // S536: browser-neutral — no native alert(); transient in-app notice.
  const [stockNotice, setStockNotice] = useState<string | null>(null)
  const showStockNotice = (msg: string) => {
    setStockNotice(msg)
    setTimeout(() => setStockNotice(null), 2500)
  }
  // S263/S264: server-of-record cart sync. clientSessionId is the LOCAL
  // identifier of the active session — generated at session-open time
  // and used to enqueue subsequent mutations through services/syncQueue.
  // The server-side pos_sessions.id resolves asynchronously via the
  // queue's clientId→serverId mapping. For resumed sessions, the server
  // id is pre-mapped so the queue resolves it immediately.
  const [clientSessionId, setClientSessionId] = useState<string|null>(null)
  // S654 (Nic): "if there's any outstanding shopping carts, have those as an
  // expandable list to choose from, not just resuming a single cart."
  type OpenTab = { id:string; total:number; openedAt:string; itemCount:number; customerName:string|null; preview:string|null }
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([])
  const [tabsExpanded, setTabsExpanded] = useState(false)
  const [method, setMethod] = useState<'cash'|'card'|'card_on_file'|'charge'>('cash')
  // S254/S538: FlexCharge account holder can come from either backing
  // list (resident account or POS customer account). The register shows
  // ONE neutral "customer" picker; the ids stay mutually exclusive.
  // 10/2 (Nic): "One flow" — the person is typed and picked (a chip), never
  // picked from a list AND added beside it. A resident is sent by their tenant
  // id, a register customer by theirs; the server stamps both on a resident's sale.
  const [person, setPerson] = useState<PickedPerson | null>(null)
  const tenantId = person?.kind === 'resident' ? (person.tenantId ?? '') : ''
  const posCustomerId = person?.kind === 'customer' ? (person.customerId ?? '') : ''
  // S652 (Nic): propane is pumped in the office — that is where the meter is,
  // and it has to be zeroed before the next tank — and paid for at the door.
  // A ticket is the cart in between. Carries no total: the price is decided
  // when it is rung, by the same server path as every other sale.
  const [ticketsOpen, setTicketsOpen] = useState(false)
  const [openTicketId, setOpenTicketId] = useState<string | null>(null)
  // 10/2 (the Scott Duffy ticket): what the reopened ticket held when it was
  // opened, read fresh from the server — so Clear can put the ORIGINAL back,
  // unchanged or updated in place, and never write a second ticket.
  const [ticketSnapshot, setTicketSnapshot] = useState<TicketSnapshot | null>(null)
  const [reopening, setReopening] = useState<string | null>(null)
  // S652 (Nic): an emailed pay link being settled here, in person. The link
  // is the bill; the server charges its lines and marks it paid.
  const [payLinkId, setPayLinkId] = useState<string | null>(null)
  const [dismissedSessions, setDismissedSessions] = useState<Set<string>>(new Set())
  const [cashGiven, setCashGiven] = useState('')
  const [filterCat, setFilterCat] = useState('all')
  const [receipt, setReceipt] = useState<any>(null)
  // S654 (Nic): the customer base. After a card sale the reader asks the
  // customer (their own screen, their own finger) whether to keep the card and
  // for a receipt email; the register watches for the answer.
  const [saveCard, setSaveCard] = useState<'asking' | 'saved' | 'declined' | 'timeout' | null>(null)
  const [receiptEmail, setReceiptEmail] = useState('')
  const [receiptSent, setReceiptSent] = useState<string | null>(null)
  const [historyCustomer, setHistoryCustomer] = useState<{ id: string; name: string } | null>(null)
  // S654: resending a sale's receipt from History; the Customers tab.
  const [txEdit, setTxEdit] = useState<{ id: string; mode: 'receipt'; value: string } | null>(null)
  const [custSearch, setCustSearch] = useState('')
  const [openCust, setOpenCust] = useState<string | null>(null)
  const [appliedDiscount, setAppliedDiscount] = useState<any>(null)
  const [discountCode, setDiscountCode] = useState('')
  const [openTx,setOpenTx]=useState<string|null>(null)   // S653: history row expanded to its lines
  const [refundModal, setRefundModal] = useState<{show:boolean; tx:any}>({show:false,tx:null})
  // 10/3 (review): Void asks first, in the app — never a browser pop-up.
  const [voidAsk, setVoidAsk] = useState<any | null>(null)
  const [refundAmt, setRefundAmt] = useState('')
  const [refundReason, setRefundReason] = useState('')
  // S339: refund_method enforcement. Cashier picks cash or check for
  // cash/card sales; FlexCharge sales reverse on the open account
  // (server forces 'charge' regardless of what we send).
  const [refundMethod, setRefundMethod] = useState<'cash'|'check'>('cash')
  const [readerModal, setReaderModal] = useState(false)
  const [readers, setReaders] = useState<any[]>([])  // Bluetooth-discovered SDK readers
  const [activeReader, setActiveReader] = useState<ActiveReader | null>(null)
  const [terminalStatus, setTerminalStatus] = useState<'idle'|'discovering'|'connecting'|'awaiting_tap'|'collecting'|'capturing'|'error'>('idle')
  // S654 (Nic): "I don't want it to void the charge… revert back to the cart so
  // they can try again." A card charge the reader timed out on (or declined)
  // stays open with the cart; Charge sends it again. It is voided only when the
  // cart is cleared or changed.
  const [pendingIntent, setPendingIntent] = useState<{ id: string; readerId: string } | null>(null)
  const abandonPendingIntent = () => {
    if (pendingIntent) { cancelTerminalIntent(pendingIntent.id).catch(() => {}); setPendingIntent(null) }
  }
  const [terminalError, setTerminalError] = useState('')
  // S243: cart-level property — the PI is stamped with this and the
  // smart-reader selector filters to readers registered under it.
  // Card method requires a property; cash/charge don't.
  const [registerProperty, setRegisterProperty] = useState<string>('')
  // S243: Readers-tab register-new form.
  const [newReader, setNewReader] = useState({ propertyId: '', registrationCode: '', nickname: '' })
  const [editItem, setEditItem] = useState<any>(null)
  // S219: Manage Categories tab state.
  // S220: + propertyId on the Add form, + filterCategoryProperty for
  // the management-list filter (mirrors items + tax-rates filters).
  // propertyIds: [] = all properties (company-wide); a non-empty list scopes
  // the category to exactly those properties (toggle per property).
  const [newCategory, setNewCategory] = useState({ name:'', icon:'📦', sortOrder:'', propertyIds: [] as string[] })
  const [editCategory, setEditCategory] = useState<any>(null)
  const [filterCategoryProperty, setFilterCategoryProperty] = useState<string>('all')
  // Categories table sort — click a column header to sort; click again to flip.
  const [catSort, setCatSort] = useState<{ key: 'name' | 'property'; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' })
  const toggleCatSort = (key: 'name' | 'property') =>
    setCatSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  // New-category property picker is a popup (clearer than inline checkboxes).
  const [showCatPropPicker, setShowCatPropPicker] = useState(false)
  // Items table sort — click a column header to sort; click again to flip.
  const [itemSort, setItemSort] = useState<{ key: 'name'|'category'|'property'|'price'|'stock'; dir: 'asc'|'desc' }>({ key: 'name', dir: 'asc' })
  const toggleItemSort = (key: 'name'|'category'|'property'|'price'|'stock') =>
    setItemSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  // S227: form now stores categoryId (uuid). Default '' until categories
  // load, then we auto-pick the first available (see useEffect below).
  const [newItem, setNewItem] = useState({ name:'', categoryId:'', icon:'📦', sellPrice:'', costPrice:'', marginPct:'', chargeEligible:true, stockQty:'0', stockMin:'5', stockMax:'50', propertyId:'' as string })
  // S650 (Nic): one list of named taxes, each applied to everything, to whole
  // categories, or to single items. The name is what the receipt prints.
  const blankTax = { id:'' as string, name:'', ratePct:'', all:true, categoryIds:[] as string[], itemIds:[] as string[] }
  const [taxDraft, setTaxDraft] = useState(blankTax)
  // S217: tax-rate list filter on the taxes tab.
  const [newDiscount, setNewDiscount] = useState({ name:'', type:'percent', value:'', code:'' })
  const [newVendor, setNewVendor] = useState({ name:'', contactName:'', email:'', phone:'', address:'', leadTimeDays:'3', notes:'' })
  const [editVendor, setEditVendor] = useState<any>(null)
  const [newPO, setNewPO] = useState({ vendorId:'', notes:'', expectedDate:'' })
  const [poItems, setPoItems] = useState<{itemId:string;itemName:string;qtyOrdered:number;unitCost:number}[]>([])
  const [poItemRow, setPoItemRow] = useState({ itemId:'', qtyOrdered:'1', unitCost:'' })
  const [expandedPO, setExpandedPO] = useState<string|null>(null)

  // W-12 (S531): every POS read is scoped to the page-level property.
  const propQ = registerProperty ? `?propertyId=${registerProperty}` : ''
  const { data: items = [] } = useQuery<any[]>(['pos-items', registerProperty], () => apiGet(`/pos/items${propQ}`))
  // POS #1: business-level default margin → drives item auto-pricing.
  // S654 (Nic): no default company — every register call names the property.
  const { data: posSettings } = useQuery<any>(['pos-settings', registerProperty], () => apiGet<any>(`/pos/settings?propertyId=${registerProperty}`), { enabled: !!registerProperty })
  const defaultMarginPct: number | null = posSettings?.defaultMarginPct ?? null
  const [marginEdit, setMarginEdit] = useState('')
  const saveMarginMut = useMutation(
    (v: string) => apiPatch('/pos/settings', { propertyId: registerProperty, defaultMarginPct: v === '' ? null : Number(v) }),
    { onSuccess: () => qc.invalidateQueries('pos-settings') }
  )
  // S218: pos_categories from the API replaces the old hardcoded
  // CATEGORIES const. First GET auto-seeds defaults if empty.
  const { data: posCategories = [] } = useQuery<any[]>(['pos-categories', registerProperty], () => apiGet(`/pos/categories${propQ}`))
  // S219: full list (incl. inactive) for the manage-categories tab.
  const { data: posCategoriesAll = [] } = useQuery<any[]>(['pos-categories-all', registerProperty], () => apiGet(`/pos/categories?all=1${registerProperty ? '&propertyId='+registerProperty : ''}`), { enabled: tab==='categories' })
  // S192: per-property POS — properties list feeds the property
  // selector on item create/edit. NotificationBell already pulls
  // /properties so this is in cache.
  const { data: allProperties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  // Property lock: a scoped worker (cashier) only sees the register properties
  // in their scope. Owners + allProperties=true see everything. Backend enforces
  // the same via assertPropertyInScope; this just keeps the UI honest so they
  // can't pick — and accidentally charge — the wrong property.
  const { user } = useAuth()
  // Owners send propertyIds=null (→ see all); a scoped worker always sends an
  // array (even empty), so key off Array.isArray — a mis-assigned worker with
  // [] correctly sees none rather than falling through to all.
  const isScoped = !!user && !user.allProperties && Array.isArray(user.propertyIds)
  const properties = isScoped
    ? (allProperties as any[]).filter((p: any) => user!.propertyIds!.includes(p.id))
    : allProperties
  // S652: whose card, and which one. The counter is about to take money with
  // nobody handing anything over, so the screen says it out loud first.
  // 10/2 (Nic, front desk foolproof): the list of what is still out is read
  // fresh every time it is shown — never a cached copy from before another
  // register settled something.
  const tickets = useQuery<any[]>(
    ['pos-tickets', registerProperty],
    () => apiGet(`/pos/tickets?propertyId=${registerProperty}`),
    { enabled: !!registerProperty && tab === 'register', retry: false, staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: true },
  )
  useEffect(() => {
    if (ticketsOpen && registerProperty) void tickets.refetch()
  }, [ticketsOpen, registerProperty])   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Back to an empty register, with nothing left behind: the live cart session
   * is closed (so it never comes back as an "open cart"), the reader's waiting
   * charge is let go, and the person, discount, stay, ticket and pay link are
   * all cleared. Every way out of a sale that is not a sale ends here.
   */
  const resetRegister = (sessionReason: string) => {
    if (clientSessionId) {
      setDismissedSessions(d => new Set(d).add(clientSessionId))
      void enqueueSync({ op: 'VOID_SESSION', clientSessionId, payload: { reason: sessionReason } })
      qc.invalidateQueries(['pos-sessions-open', registerProperty])
    }
    setClientSessionId(null); abandonPendingIntent()
    setCart([]); setPerson(null); setAppliedDiscount(null); setStay(null); setCashGiven('')
    setOpenTicketId(null); setTicketSnapshot(null); setPayLinkId(null)
  }

  const writeTicketMut = useMutation(
    () => apiPost('/pos/tickets', {
      propertyId: registerProperty,
      tenantId: tenantId || null,
      posCustomerId: posCustomerId || null,
      items: cart.map(i => ({ id: i.id, name: i.name, qty: i.qty, price: i.price, tax: i.tax })),
    }),
    {
      onSuccess: () => {
        qc.invalidateQueries('pos-tickets')
        resetRegister('held_for_delivery')
        toastOnce('Held for delivery — it is on the open tickets list.')
      },
      onError: (e: any) => toastOnce(errorMessage(e, 'Could not hold it for delivery — check the connection and press Hold for delivery again.'), { error: true }),
    },
  )

  // 10/2: Clear on a reopened ticket puts THAT ticket back — never a second one.
  // The cart still matching it: nothing to send. Changed: updated in place.
  /**
   * What putting the reopened ticket back sends: null when the cart still
   * matches it — or is empty (an emptied cart never empties a ticket; it goes
   * back as it was). With nobody in the cart the ticket keeps its own person:
   * a ticket is always for someone.
   */
  const ticketChanges = (): any | null => {
    if (!openTicketId) return null
    const snap = ticketSnapshot
    const lines = cart.map(i => ({ id: i.id.startsWith('open-') ? null : i.id, name: i.name, qty: i.qty, price: i.price, tax: i.tax }))
    const personChanged = !!person && (
      (tenantId || null) !== (snap?.tenantId ?? null) || (posCustomerId || null) !== (snap?.posCustomerId ?? null))
    const unchanged = !lines.length || (!!snap && snap.id === openTicketId && snap.lines === linesKey(lines) && !personChanged)
    return unchanged ? null : {
      propertyId: registerProperty,
      items: lines.filter(l => !!l.id),
      ...(personChanged ? { tenantId: tenantId || null, posCustomerId: posCustomerId || null } : {}),
    }
  }
  /** What the cashier is told once a ticket is back — and, if they took the person off, that it is still that person's. */
  const putBackWords = (sent: boolean): string => {
    const still = !person && ticketSnapshot?.name
      ? ` It is still under ${ticketSnapshot.name} — a ticket is always for someone. To change who it is for, open it, pick the new person, then press Clear.`
      : ''
    return (sent ? 'Ticket updated and put back on the open list.' : 'Ticket put back on the open list.') + still
  }
  /** A ticket settled or voided at another register (404/409) — anything else wrong keeps the cart. */
  const ticketIsGone = (e: any) => e?.response?.status === 404 || e?.response?.status === 409
  const putTicketBackMut = useMutation(
    (v: { id: string; body: any | null; words: string }) => v.body ? apiPut(`/pos/tickets/${v.id}`, v.body) : Promise.resolve(null),
    {
      onSuccess: (_r: any, v) => {
        qc.invalidateQueries('pos-tickets')
        resetRegister('ticket_put_back')
        toastOnce(v.words)
      },
      onError: (e: any) => {
        if (ticketIsGone(e)) {
          // Settled or voided at another register: nothing to put back, and
          // nothing in this cart is owed any more.
          qc.invalidateQueries('pos-tickets')
          resetRegister('ticket_gone')
          toastOnce('That ticket was already settled or voided at another register, so there was nothing to put back. The cart is clear.')
          return
        }
        // 10/2 (review): anything else — the person picked cannot go on it, the
        // connection dropped — leaves the cart exactly as it is, with the
        // server's own words for what to do.
        toastOnce(errorMessage(e, 'The ticket could not be put back — check the connection and press Clear again.'), { error: true })
      },
    },
  )
  const putTicketBack = () => {
    if (!openTicketId) return
    const body = ticketChanges()
    putTicketBackMut.mutate({ id: openTicketId, body, words: putBackWords(!!body) })
  }

  /**
   * 10/2 (review): switching property with a reopened ticket in the cart puts
   * it back first — changed lines are saved, never thrown away. If it cannot be
   * saved the register stays where it is, cart and all.
   */
  const switchProperty = async (next: string) => {
    if (openTicketId) {
      const body = ticketChanges()
      if (body) {
        try {
          await apiPut(`/pos/tickets/${openTicketId}`, body)
          qc.invalidateQueries('pos-tickets')
          toastOnce(putBackWords(true))
        } catch (e: any) {
          if (!ticketIsGone(e)) {
            toastOnce(errorMessage(e, 'The ticket could not be put back — check the connection, then pick the property again.'), { error: true })
            return
          }
          toastOnce('That ticket was already settled or voided at another register, so there was nothing to put back.')
        }
      } else if (!person && ticketSnapshot?.name) {
        toastOnce(putBackWords(false))
      }
      resetRegister('property_switched')
    } else if (payLinkId) {
      // A pay link opened here stays on this property's list, as it was.
      resetRegister('property_switched')
    }
    setRegisterProperty(next); setPerson(null)
  }

  /** The register's Clear: a reopened ticket goes back, a pay link stays out, a named cart is held, anything else is emptied. */
  const clearRegister = () => {
    if (openTicketId) { putTicketBack(); return }
    if (payLinkId) { resetRegister('pay_link_put_back'); toastOnce('Pay link put back on the open list.'); return }
    // S652 (Nic): "just clearing the cart should clear it, and if they have a
    // name associated with it save it as a ticket."
    if (tenantId || posCustomerId) { writeTicketMut.mutate(); return }
    resetRegister('cleared_by_cashier')
  }

  // 10/2 (Nic, front desk foolproof): a ticket or pay link is opened from the
  // server at the moment it is opened — never from a list that may be a
  // minute old — and the person on it comes back as the chip, by name.
  const reopenTicket = async (t: any) => {
    setReopening(t.id)
    try {
      // A reopened ticket already in the cart goes back to the list first —
      // changes saved; one settled elsewhere meanwhile has nothing to save.
      if (openTicketId && openTicketId !== t.id) {
        const body = ticketChanges()
        if (body) await apiPut(`/pos/tickets/${openTicketId}`, body).catch((e: any) => { if (!ticketIsGone(e)) throw e })
      }
      const kind = t.kind === 'pay_link' ? 'pay_link' : 'ticket'
      const fresh: any = await apiGet(`/pos/tickets/${t.id}?propertyId=${registerProperty}&kind=${kind}`)
      resetRegister('reopened_another')
      const lines = cartFromTicket(fresh)
      setCart(lines)
      setPerson(personOfTicket(fresh))
      if (kind === 'pay_link') {
        setPayLinkId(fresh.id)
        // 10/2 (review): the link's own discount comes with it. A link sent
        // at $20 less $5 is $15 at the counter too — it was being settled for $20.
        const linkDiscount = Number(fresh.discountAmount) || 0
        // 10/2 (review): it was given for the whole order — with only some of
        // the link's lines left in the cart, only that share of it applies
        // (linkDiscountShare, the server's own arithmetic), so taking a line
        // out never leaves the whole discount on what is left.
        if (linkDiscount > 0) setAppliedDiscount({ type: 'fixed', value: linkDiscount, name: 'Pay link discount', linkLines: fresh.items || [] })
      } else {
        setOpenTicketId(fresh.id)
        setTicketSnapshot({ id: fresh.id, tenantId: fresh.tenantId ?? null, posCustomerId: fresh.posCustomerId ?? null,
          name: personOfTicket(fresh)?.name ?? null,
          lines: linesKey(lines.map(i => ({ id: i.id.startsWith('open-') ? null : i.id, qty: i.qty, price: i.price }))) })
      }
      setTicketsOpen(false)
      // 10/3: a ticket whose reservation is over opens with what is left on it, and says why.
      if (fresh.notice) toastOnce(String(fresh.notice))
    } catch (e: any) {
      if (ticketIsGone(e)) {
        void tickets.refetch()
        toastOnce(errorMessage(e, 'That one was already settled or closed — the list below is up to date now.'))
      } else {
        toastOnce(errorMessage(e, 'Could not open that ticket — check the connection and press Settle again.'), { error: true })
      }
    } finally { setReopening(null) }
  }
  const cardOnFile = useQuery<any>(
    ['pos-card-on-file', tenantId, posCustomerId],
    () => apiGet(`/pos/card-on-file?propertyId=${registerProperty}&${tenantId?`tenantId=${tenantId}`:`posCustomerId=${posCustomerId}`}`),
    { enabled: method==='card_on_file' && !!(tenantId||posCustomerId), retry: false },
  )
  const { data: taxRates = [] } = useQuery<any[]>(['pos-tax-rates', registerProperty], () => apiGet(`/pos/tax-rates${propQ}`), { enabled: tab==='taxes'||tab==='register' })
  const { data: discounts = [] } = useQuery<any[]>(['pos-discounts', registerProperty], () => apiGet(`/pos/discounts${propQ}`), { enabled: tab==='discounts'||tab==='register' })
  const { data: txns = [], isLoading: txLoading } = useQuery<any[]>(['pos-transactions', registerProperty, historyCustomer?.id ?? null], () => apiGet(`/pos/transactions${propQ}${historyCustomer ? `${propQ ? '&' : '?'}posCustomerId=${historyCustomer.id}` : ''}`), { enabled: tab==='history' })
  const { data: vendors = [] } = useQuery<any[]>(['pos-vendors', registerProperty], () => apiGet(`/pos/vendors?propertyId=${registerProperty}`), { enabled: !!registerProperty && (tab==='vendors'||tab==='orders') })
  const { data: purchaseOrders = [] } = useQuery<any[]>(['pos-purchase-orders', registerProperty], () => apiGet(`/pos/purchase-orders${propQ}`), { enabled: tab==='orders' })
  const { data: inventoryLog = [] } = useQuery<any[]>(['pos-inventory-log', registerProperty], () => apiGet(`/pos/inventory-log${propQ}`), { enabled: tab==='inventory' })
  const { data: lowStock = [] } = useQuery<any[]>(['pos-low-stock', registerProperty], () => apiGet(`/pos/low-stock${propQ}`), { enabled: tab==='inventory' })

  // S243: smart readers registered to the cart's property — filters
  // the smart-reader selector in the charge modal. Re-fetches when
  // registerProperty changes. Also populates the Readers-tab table.
  const { data: registeredReaders = [] } = useQuery<RegisteredReader[]>(
    ['pos-terminal-readers', registerProperty || 'all'],
    () => listRegisteredReaders(registerProperty || undefined),
    { enabled: (tab==='register' && !!registerProperty) || tab==='readers' },
  )
  // S654 (Nic): "selecting the reader — that should not pop up unless any
  // account has more than one reader." One registered reader at the property
  // IS the reader: it is chosen on its own, and the chooser appears only when
  // there is a choice to make. A reader chosen for another property is let go
  // when the register moves.
  useEffect(() => {
    if (tab !== 'register' || !registerProperty) return
    const smart = registeredReaders as RegisteredReader[]
    const stillHere = activeReader?.type === 'bluetooth'
      || (activeReader?.type === 'smart' && smart.some(r => r.stripeReaderId === activeReader.stripeReaderId))
    if (stillHere) return
    if (smart.length === 1) setActiveReader({ type: 'smart', stripeReaderId: smart[0].stripeReaderId, nickname: smart[0].nickname })
    else if (activeReader) setActiveReader(null)
  }, [registeredReaders, registerProperty, tab])  // eslint-disable-line react-hooks/exhaustive-deps

  const categories = ['all', ...Array.from(new Set((items as any[]).map((i:any) => i.category)))]
  // S218 / S220: property-aware category filter for dropdown surfaces.
  // Replaces the old unconditional `categoryOptions` derivation —
  // every dropdown consumer now passes its form's propertyId so the
  // filter respects category scope.
  // - company-wide categories (propertyId NULL) appear everywhere
  // - property-scoped categories appear only when the consuming form's
  //   property matches
  // - company-wide consuming context (propertyId empty/null) sees only
  //   company-wide categories — picking a property-scoped category for
  //   a company-wide item is logically inconsistent
  // S227: returns {id, name, icon} so dropdowns can use the uuid as the
  // option value. Pre-S227 returned only name+icon and the dropdown
  // submitted the name string — the FK refactor moved the source of
  // truth to category_id.
  const categoriesForProperty = (propertyId: string | null | undefined): { id: string; name: string; icon: string }[] => {
    return (posCategories as any[])
      .filter((c:any) => {
        const ids = c.propertyIds as string[] | null | undefined
        if (!ids || ids.length === 0) return true   // all properties (company-wide)
        if (!propertyId) return false                // scoped category, no property context
        return ids.includes(propertyId)
      })
      .map((c:any) => ({ id: c.id, name: c.name, icon: c.icon || '📦' }))
  }
  // Register shows items for the selected property (+ any company-wide),
  // then the active category filter. Items are per-property, so ringing is
  // scoped to the chosen register/property.
  const visibleItems = (items as any[])
    .filter((i:any) => !registerProperty || !i.propertyId || i.propertyId === registerProperty)
    .filter((i:any) => filterCat === 'all' || i.category === filterCat)

  // S243: single-property landlords don't see a property selector —
  // auto-pick on first load so the card-charge flow Just Works. Multi-
  // property landlords explicitly choose per-sale.
  useEffect(() => {
    if (registerProperty) return
    if ((properties as any[]).length === 1) {
      setRegisterProperty((properties as any[])[0].id)
    }
  }, [properties, registerProperty])

  // S227: when categories load (or the form's property scope changes
  // such that newItem.categoryId no longer points at a visible category),
  // auto-pick the first available so the dropdown isn't empty. Misc
  // wins if present (matches the historical default).
  useEffect(() => {
    if (newItem.categoryId) {
      const visible = categoriesForProperty(registerProperty).find(c => c.id === newItem.categoryId)
      if (visible) return
    }
    const list = categoriesForProperty(registerProperty)
    if (list.length === 0) return
    const misc = list.find(c => c.name === 'Misc')
    setNewItem(s => ({ ...s, categoryId: (misc ?? list[0]).id }))
  }, [posCategories, registerProperty])

  // W-12: new tax rates default to the page property; "All locations"
  // stays available as an explicit choice in the dropdown.
  useEffect(() => {
  }, [registerProperty])

  // S263: open-tab query (cross-terminal pickup + crash recovery). When
  // the register tab loads with a property selected and no live session,
  // surface a banner if there's an open tab on this property.
  const { data: openSessions = [] } = useQuery<any[]>(
    ['pos-sessions-open', registerProperty],
    () => apiGet(`/pos/sessions?status=open&propertyId=${registerProperty}`),
    { enabled: tab==='register' && !!registerProperty },
  )
  useEffect(() => {
    if (clientSessionId) { setOpenTabs([]); return }
    const live = (openSessions || []).filter((s: any) => !dismissedSessions.has(s.id) && !dismissedSessions.has(s.clientSessionId))
    // S654 (Nic, live): "Discard is still requiring three clicks and Resume
    // does absolutely nothing." Each click cleared ONE stale tab and the
    // banner showed the next; an EMPTY tab resumed to an empty cart. Empty
    // tabs clear themselves; the banner counts the rest; Discard clears all.
    const empty = live.filter((s: any) => Number(s.itemCount ?? 0) === 0)
    if (empty.length) {
      setDismissedSessions(prev => { const n = new Set(prev); empty.forEach((s: any) => n.add(s.id)); return n })
      for (const s of empty) void apiPost(`/pos/sessions/${s.id}/void`, { reason: 'empty_tab_auto_cleared' }).catch(() => {})
    }
    const withItems = live.filter((s: any) => Number(s.itemCount ?? 0) > 0)
    setOpenTabs(withItems.map((s: any) => ({
      id: s.id, total: Number(s.total ?? 0), openedAt: s.openedAt, itemCount: Number(s.itemCount ?? 0),
      customerName: s.customerName ?? null, preview: s.preview ?? null,
    })))
  }, [openSessions, clientSessionId])

  // S263/S264: server-session helpers. ensureSession lazily mints a
  // client-side uuid AND enqueues OPEN_SESSION. The server-side
  // pos_sessions row is created async (resolves via the queue mapping).
  // Until the OPEN_SESSION drains, subsequent item ops queue behind it
  // — the FIFO drain serializes them.
  function ensureSession(): string|null {
    if (clientSessionId) return clientSessionId
    if (!registerProperty) return null
    const csid = mintClientId()
    setClientSessionId(csid)
    void enqueueSync({
      op: 'OPEN_SESSION',
      clientSessionId: csid,
      payload: {
        propertyId: registerProperty,
        tenantId: method==='charge' && tenantId ? tenantId : null,
        posCustomerId: method==='charge' && posCustomerId ? posCustomerId : null,
      },
    })
    return csid
  }

  async function resumeSession(id: string) {
    try {
      const res: any = await apiGet(`/pos/sessions/${id}`)
      // apiGet already unwraps the { success, data } envelope, so `res` IS the
      // payload — the old `res.data.items` fallback could never match.
      const items = res?.items || []
      // Pre-map server ids → self so the queue resolves them synchronously
      // for any subsequent PATCH/DELETE/VOID against this session.
      await preloadMapping(id, id)
      const restored: CartItem[] = []
      for (const it of items) {
        const serverItemId = it.id
        // Each restored line is its own "clientId" too (self-mapped).
        await preloadMapping(serverItemId, serverItemId)
        restored.push({
          id: it.itemId || ('open-' + serverItemId),
          name: it.itemName,
          price: Number(it.unitPrice),
          qty: Number(it.qty),
          tax: Number(it.taxRate),
          cat: it.itemCategory ?? 'misc',
          icon: '📦',
          chargeEligible: false,
          _sessionItemId: serverItemId,
        } as any)
      }
      setCart(restored)
      setClientSessionId(id)
      setOpenTabs([])
      // 10/2: a person on the cart comes back with it, shown by name with ×.
      const sess = res?.session
      setPerson(sess?.tenantId ? { kind: 'resident', tenantId: sess.tenantId, customerId: null, name: String(sess.customerName ?? '').trim() || 'Resident', hint: 'resident' }
        : sess?.posCustomerId ? { kind: 'customer', tenantId: null, customerId: sess.posCustomerId, name: String(sess.customerName ?? '').trim() || 'Customer' }
        : null)
    } catch (e) {
      console.error('[pos-session] resume failed', e)
      toastOnce('That open cart could not be opened — check the connection and press Resume again.', { error: true })
    }
  }

  async function discardOpenTab(id: string | 'all') {
    try {
      // Discard is a direct synchronous call (we know the server id and
      // we're not editing the cart). Best-effort; if it fails the banner
      // re-appears on next refresh. S654: one tab, or every open tab at once.
      const ids = id === 'all' ? openTabs.map(t => t.id) : [id]
      await Promise.all(ids.map(x => apiPost(`/pos/sessions/${x}/void`, { reason: 'discarded_at_terminal_load' })))
      qc.invalidateQueries(['pos-sessions-open', registerProperty])
      setOpenTabs(prev => prev.filter(t => !ids.includes(t.id)))
    } catch (e) {
      console.error('[pos-session] discard failed', e)
      toastOnce('That open cart could not be discarded — check the connection and press Discard again.', { error: true })
    }
  }

  const addToCart = async (item: any) => {
    // 10/2 (decisions #9): a reservation in the cart is its own price — another
    // tap of its stay button never adds nights to it.
    if (cart.some(x => x.id === item.id && x.reservation)) {
      showStockNotice('That reservation is already in the cart — its nights and price are set on the schedule.')
      return
    }
    // S536 (Nic): the cart can never hold more quantity than inventory
    // shows — the tile says "N left", so N is the ceiling.
    const inCartQty = cart.find(x => x.id === item.id)?.qty ?? 0
    if (inCartQty + 1 > Number(item.stockQty)) {
      showStockNotice(Number(item.stockQty) <= 0 ? 'Out of stock' : `Only ${item.stockQty} in stock`)
      return
    }
    const csid = ensureSession()
    if (!csid) return
    const clientItemId = mintClientId()
    void enqueueSync({
      op: 'ADD_ITEM',
      clientSessionId: csid,
      clientItemId,
      payload: {
        itemId: item.id,
        itemName: item.name,
        itemCategory: item.category || null,
        qty: 1,
        unitPrice: Number(item.sellPrice),
        taxRate: Number(item.taxRate) || 0,
      },
    })
    setCart(c => {
      const ex = c.find(x => x.id === item.id)
      // S264: when the user double-taps an item the local merge stays —
      // visual qty goes up — but a NEW ADD_ITEM mutation still fires.
      // Server resolves into two pos_session_items rows; resume after a
      // tab reopen will show them split. Acceptable for v1; merge logic
      // can come later if line clutter becomes a complaint.
      // clamp INSIDE the updater too — rapid clicks batch renders, so the
      // pre-check above can read a stale cart; the updater always sees
      // the latest state and is the hard guarantee.
      if (ex) return c.map(x => x.id===item.id ? {...unpriceStay(x),qty:Math.min(x.qty+1, Math.max(1, Number(item.stockQty))), _sessionItemId: (x as any)._sessionItemId ?? clientItemId} as any : x)
      // S652 (Nic): a stay's price is the SITE's, not the catalog's, and no
      // site has been picked yet. Starts at zero and fills in when one is,
      // so nothing on screen ever shows a number the guest will not be charged.
      // S652 (Nic): a stay starts at the property's base rate (the cheapest site
      // of that length) and takes the chosen site's rate once one is picked.
      return [...c, { id:item.id, name:item.name, price:item.stayUnit?Number(item.baseRate ?? 0):Number(item.sellPrice), qty:1, tax:Number(item.taxRate), cat:item.category, icon:item.icon, chargeEligible:item.chargeEligible, stayUnit:item.stayUnit ?? null, _sessionItemId: clientItemId } as any]
    })
  }
  // S536 (Nic): absolute-quantity setter — the register quantity is
  // typeable (selling 40 gallons shouldn't take 40 clicks) and every
  // path caps at the item's stock so the cart can never exceed
  // inventory. Open items (no inventory row) are uncapped.
  const stockCapFor = (id:string) => {
    if (id.startsWith('open-')) return Infinity
    const it = (items as any[]).find((x:any) => x.id === id)
    return it ? Number(it.stockQty) : Infinity
  }
  const setQty = async (id:string, target:number) => {
    const line = cart.find(x => x.id === id)
    if (!line) return
    // 10/2 (decisions #9): the reservation's line is not counted at the register.
    if (line.reservation) return
    const cap = stockCapFor(id)
    if (Number.isFinite(cap) && target > cap) showStockNotice(`Only ${cap} in stock`)
    // S652 (Nic): "will not let you put in decimal points." Propane is sold by
    // the gallon and a gallon has tenths. Two decimals, never floored.
    const newQty = Math.min(Math.max(0, Math.round(target * 100) / 100), cap)
    const csid = clientSessionId
    const lineClientId = (line as any)._sessionItemId
    if (csid && lineClientId) {
      if (newQty === 0) {
        void enqueueSync({
          op: 'DELETE_ITEM',
          clientSessionId: csid,
          clientItemId: lineClientId,
          payload: {},
        })
      } else {
        void enqueueSync({
          op: 'PATCH_ITEM',
          clientSessionId: csid,
          clientItemId: lineClientId,
          payload: { qty: newQty },
        })
      }
    }
    // 10/3 (decisions #9): a stay's new length is priced when its site is picked again.
    setCart(c => c.map(x => x.id===id ? {...(x.stayUnit ? unpriceStay(x) : x),qty:newQty} : x).filter(x=>x.qty>0))
  }
  const updateQty = (id:string, delta:number) => {
    const line = cart.find(x => x.id === id)
    if (line) void setQty(id, line.qty + delta)
  }
  // 10/5 (Nic, R8): the background check's fee the server quoted for the stay
  // in the cart — its own line, which the server adds and the register cannot
  // take off. Shown here so the cart says what Charge takes.
  const screeningDue = stayLine && stayPriced(stayLine) ? Number(stayLine.screeningFee) || 0 : 0
  const subtotal = cart.reduce((s,i) => s+lineAmount(i), 0) + screeningDue
  // 10/3 (review, decisions #9): a stay is charged at the schedule's price —
  // a sale with a stay (or a reservation) in it takes no discount, and the
  // server refuses one. The box says so instead of offering it.
  const noDiscountForStay = cart.some(i => !!i.stayUnit || !!i.reservation)
  useEffect(() => { if (noDiscountForStay && appliedDiscount) setAppliedDiscount(null) }, [noDiscountForStay, appliedDiscount])
  const fixedDiscount = appliedDiscount?.linkLines ? linkDiscountShare(appliedDiscount.value, appliedDiscount.linkLines, cart) : appliedDiscount?.value
  const discountAmt = appliedDiscount && !noDiscountForStay ? (appliedDiscount.type==='percent' ? subtotal*(appliedDiscount.value/100) : Math.min(fixedDiscount, subtotal)) : 0
  const discountedSubtotal = subtotal - discountAmt
  const taxAmount = cart.reduce((s,i) => s+lineTax(i), 0)
  // S650: the cart's tax by name ("Lodging tax"), from each item's taxes.
  const cartTaxLines = (() => {
    const by = new Map<string, number>()
    for (const c of cart as any[]) {
      // 10/2 (decisions #9): a reservation's tax is in its quoted price.
      if (c.reservation) continue
      // 10/3 (decisions #21): a priced stay's tax is the property's lodging tax.
      if (stayPriced(c)) { if (c.stayTax > 0) by.set('Lodging tax', (by.get('Lodging tax') || 0) + Number(c.stayTax)); continue }
      const it = (items as any[]).find((x:any) => x.id === c.id)
      for (const t of (it?.taxes || [])) {
        const name = t.name === 'Item tax rate' ? 'Tax' : t.name
        by.set(name, (by.get(name) || 0) + c.price * c.qty * Number(t.rate))
      }
    }
    return Array.from(by.entries()).map(([name, amount]) => ({ name, amount }))
  })()
  const namedTaxTotal = cartTaxLines.reduce((a, l) => a + l.amount, 0)
  // S648 (Nic): every card payment carries the card fee; the property decides
  // whether the customer pays it on top or the landlord absorbs it. The server
  // decides the real figure (cart-quote / transactions); this shows it first.
  const absorbsCardFee = (allProperties as any[]).find(p => p.id === registerProperty)?.registerCardFeePayer === 'landlord'
  const surcharge = method==='charge' ? discountedSubtotal*0.01
    : (method==='card'||method==='card_on_file') && !absorbsCardFee ? processingFeeFor({ amount: discountedSubtotal + taxAmount, paymentMethod: 'card' })
    : 0
  const total = discountedSubtotal + taxAmount + surcharge
  // 10/3 (decisions #16): "Cash given" left blank is exact cash — received is
  // the total and no change is due. Cash given below the total is short: the
  // register says by how much, and Charge waits until it covers the total.
  // Worked in cents, so $20.00 against $20.00 is never a penny short.
  const cashBlank = String(cashGiven).trim() === ''
  const cashCents = Math.round((Number(cashGiven) || 0) * 100)
  const totalCents = Math.round(total * 100)
  const cashShortBy = method==='cash' && !cashBlank ? Math.max(0, totalCents - cashCents) / 100 : 0
  const changeDue = method==='cash' && !cashBlank ? Math.max(0, cashCents - totalCents) / 100 : 0
  const cashReceived = method==='cash' ? (cashBlank ? total : cashCents / 100) : null
  const chargeBlocked = method==='charge' && cart.some(i => !i.chargeEligible)

  // S654 (Nic): "it goes away. It needs to be there the whole time … link it to
  // be always on the screen until the payment is processed. Also, it doesn't
  // show a customer name." Stripe's own pay screen shows the total and nothing
  // else, and Stripe sends no word when a card is tapped on the breakdown. So
  // the breakdown — the customer's name first — goes on the reader as the cart
  // is rung, follows every change, and the customer taps ON it. Charge then
  // finishes with that tap. Nothing is charged by showing it.
  const [readerCart, setReaderCart] = useState<{ sig: string; shown: boolean; busy?: string } | null>(null)
  const [readerCartNonce, setReaderCartNonce] = useState(0)
  const shownOnReader = useRef<{ readerId: string; propertyId: string } | null>(null)
  const liveCartCall = useRef<Promise<unknown> | null>(null)
  const liveReaderId = method==='card' && activeReader?.type==='smart' ? activeReader.stripeReaderId : null
  const liveCartLines = cart.map(i => wireLine(i, openTicketId, payLinkId))
  // 10/3 (review): a stay with no site and dates yet has no price — the
  // customer's screen leaves it off (and out of its total) until it is priced,
  // rather than show the item's rate × nights and a tax Charge never takes.
  const readerCartLines = cart.filter(i => !(i.stayUnit && !i.reservation && !stayPriced(i))).map(i => wireLine(i, openTicketId, payLinkId))
  const liveCartSig = liveReaderId && registerProperty && readerCartLines.length
    ? JSON.stringify([liveReaderId, registerProperty, readerCartLines, discountAmt, tenantId, posCustomerId, readerCartNonce]) : ''
  // Every call to the reader goes in one line, in order: a take-down can never
  // land before a display that was already on its way, and it reads what is up
  // only after that display has landed.
  const queueReader = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = (liveCartCall.current ?? Promise.resolve()).then(fn)
    liveCartCall.current = run.catch(() => {})
    return run
  }
  const takeDownLiveCart = () => {
    void queueReader(async () => {
      const was = shownOnReader.current
      shownOnReader.current = null
      if (was) await showCartLive({ stripeReaderId: was.readerId, propertyId: was.propertyId, items: [] }).catch(() => {})
    })
  }
  useEffect(() => {
    if (terminalStatus === 'collecting' || terminalStatus === 'capturing') return
    if (!liveCartSig) { takeDownLiveCart(); setReaderCart(null); return }
    if (shownOnReader.current && shownOnReader.current.readerId !== liveReaderId) takeDownLiveCart()
    if (readerCart?.shown && readerCart.sig === liveCartSig && shownOnReader.current?.readerId === liveReaderId) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    // A reader still busy (the last customer's question) or a display that
    // failed is tried again every few seconds while this cart is on screen.
    const tryAgain = () => { retry = setTimeout(() => setReaderCartNonce(n => n + 1), 3000) }
    const target = { readerId: liveReaderId!, propertyId: registerProperty }
    const timer = setTimeout(() => {
      queueReader(async () => {
        if (cancelled) return null   // the cart moved on before this one was sent
        const r = await showCartLive({ stripeReaderId: target.readerId, propertyId: target.propertyId, items: readerCartLines,
          discountAmount: discountAmt, tenantId: tenantId || null, posCustomerId: posCustomerId || null })
        if (r.shown) shownOnReader.current = target
        return r
      }).then(r => {
        if (!r || cancelled) return
        setReaderCart({ sig: liveCartSig, shown: !!r.shown, busy: r.busy })
        if (!r.shown) tryAgain()
      }).catch(() => { if (!cancelled) { setReaderCart({ sig: liveCartSig, shown: false }); tryAgain() } })
    }, 500)
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(retry) }
  }, [liveCartSig, terminalStatus])   // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the register takes the breakdown off the reader.
  useEffect(() => () => takeDownLiveCart(), [])   // eslint-disable-line react-hooks/exhaustive-deps
  const breakdownIsUp = !!readerCart?.shown && readerCart.sig === liveCartSig
  // The latest cart, read when the tap window ends — the cashier may still have
  // changed it while the customer was reading the breakdown.
  const latest = useRef({ cart, discountAmt, tenantId, posCustomerId, openTicketId, payLinkId })
  latest.current = { cart, discountAmt, tenantId, posCustomerId, openTicketId, payLinkId }

  // S654 (Nic): "leave it going for like thirty to forty-five seconds. They tap
  // and then it processes." After Charge the breakdown stays up for the tap.
  // Stripe sends no word of the tap itself, so the window ends on its own, or
  // early with "They tapped — finish now", or "Cancel" goes back to the cart.
  const [tapEndsAt, setTapEndsAt] = useState<number | null>(null)
  const [tapNow, setTapNow] = useState(Date.now())
  const tapWaiter = useRef<((o: 'tapped' | 'cancel') => void) | null>(null)
  useEffect(() => {
    if (!tapEndsAt) return
    const t = setInterval(() => setTapNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [tapEndsAt])
  useEffect(() => () => tapWaiter.current?.('cancel'), [])
  const waitForTap = () => new Promise<'tapped' | 'time' | 'cancel'>(resolve => {
    const ms = TAP_WINDOW_SECONDS * 1000
    const done = (o: 'tapped' | 'time' | 'cancel') => { clearTimeout(timer); tapWaiter.current = null; setTapEndsAt(null); resolve(o) }
    const timer = setTimeout(() => done('time'), ms)
    tapWaiter.current = done
    setTapNow(Date.now()); setTapEndsAt(Date.now() + ms)
  })
  const tapSecondsLeft = tapEndsAt ? Math.max(0, Math.ceil((tapEndsAt - tapNow) / 1000)) : 0
  // S654 (review): the window charges the sale that was on screen when Charge
  // was pressed. If the tender, reader, cart or customer changes while it runs,
  // the window ends as Cancel — nothing is charged; press Charge again.
  const chargeSubject = JSON.stringify([method, liveReaderId, liveCartLines, discountAmt, tenantId, posCustomerId])
  const tapSubject = useRef<string | null>(null)
  useEffect(() => {
    if (terminalStatus === 'awaiting_tap' && tapSubject.current && tapSubject.current !== chargeSubject) tapWaiter.current?.('cancel')
  }, [chargeSubject, terminalStatus])
  // While the reader holds a charge the tender, Clear, hold-for-delivery and
  // pay link wait — a card the reader takes is only ever this card sale.
  const readerHoldsCharge = terminalStatus === 'awaiting_tap' || terminalStatus === 'collecting' || terminalStatus === 'capturing'

  const applyDiscountCode = () => {
    const d = (discounts as any[]).find((x:any) => x.code?.toLowerCase() === discountCode.toLowerCase())
    if (d) { setAppliedDiscount(d); setDiscountCode('') }
  }

  // S243: optional stripePaymentIntentId from the terminal capture flow.
  // The S242 backend gate validates it against the landlord's Connect
  // account (status='succeeded', metadata.gam_purpose='pos_terminal',
  // amount matches the server-computed total). Cash/charge paths pass
  // null and skip validation.
  const checkoutMut = useMutation(
    (stripePaymentIntentId?: string) => apiPost('/pos/transactions', {
      items: cart.map(i => ({ ...wireLine(i, openTicketId, payLinkId), cat:i.cat })),
      // S654: a card the reader took is a card sale, whatever the tender buttons say now.
      paymentMethod: stripePaymentIntentId ? 'card' : method,
      // S254: charge mode posts customer + property scoping for FlexCharge
      tenantId: tenantId||null,
      // S652: a card on file belongs to a PERSON, so the sale has to say which
      // one — the same tenant-or-customer pair a charge sale sends.
      // S654 (Nic): "for cash people we can add them as a customer" — a picked
      // customer rides on every sale, not only charge-account ones.
      posCustomerId: posCustomerId||null,
      // S654: the reader the card was tapped on, so it can ask about keeping the card.
      stripeReaderId: method==='card' && activeReader?.type==='smart' ? activeReader.stripeReaderId : null,
      // Always send the register's property (not just for FlexCharge) so every
      // sale is tied to a property — required for cashier property-lock scoping.
      propertyId: registerProperty || null,
      subtotal:discountedSubtotal, taxAmount, surcharge, total, changeGiven:changeDue,
      discountAmount:discountAmt, discountReason:appliedDiscount?.name||null,
      stripePaymentIntentId: stripePaymentIntentId || null,
      // S652: the ticket this sale settles, claimed inside the sale's own
      // transaction so two drivers cannot both charge the same tank.
      openTicketId,
      payLinkId,
      // S651: present only when a stay is in the cart. The server derives the
      // dates from the item and its quantity; this is the part only the
      // cashier knows. (A stay taken back out leaves nothing behind.)
      stay: stayInCart ? (stay || null) : null,
    }),
    { onSuccess: async (res:any) => {
      // 10/3 (Nic, decisions #16): the change stays on screen until the cashier
      // closes the receipt — with what was handed over and the total beside it.
      // 10/3 (decisions #21): a reservation's lodging tax is in its price; the
      // sale records it as tax, and the receipt shows the sale's own figures.
      // 10/3 (review): its lines too — the reservation (or stay) at its price
      // before its lodging tax — so the lines and the tax add up to the total.
      const hasReservation = cart.some(i => i.reservation || stayPriced(i))
      const saleLines: any[] | null = Array.isArray(res.data?.items) && res.data.items.length ? res.data.items : null
      setReceipt({ ...res.data, cartItems: hasReservation && saleLines ? saleLines : cart,
                   subtotal: hasReservation && res.data?.subtotal != null ? Number(res.data.subtotal) : subtotal,
                   taxAmount: hasReservation && res.data?.taxAmount != null ? Number(res.data.taxAmount) : taxAmount,
                   discountAmt, surcharge, total, changeDue, method, cashReceived })
      setReceiptSent(null); setReceiptEmail(res.data?.customer?.email || '')
      setSaveCard(res.data?.customer?.prompting ? 'asking' : null)
      // S263/S264: link the live session to this transaction via the
      // queue. FIFO order guarantees the OPEN_SESSION + ADD_ITEMs have
      // already drained by the time the cashier reached checkout (those
      // mutations need network and so does /pos/transactions). The
      // session/complete endpoint is idempotent.
      const txId = res?.data?.id
      if (clientSessionId && txId) {
        void enqueueSync({
          op: 'COMPLETE_SESSION',
          clientSessionId,
          payload: { transactionId: txId },
        })
      }
      setClientSessionId(null)
      abandonPendingIntent(); setCart([]); setCashGiven(''); setPerson(null); setAppliedDiscount(null); setStay(null)
      setOpenTicketId(null); setTicketSnapshot(null); setPayLinkId(null); qc.invalidateQueries('pos-tickets')
      qc.invalidateQueries('pos-transactions'); qc.invalidateQueries('pos-items')
      // 10/3 (review): a stay sold here took its site — the next picker reads what is free again.
      qc.invalidateQueries('stay-availability')
      qc.invalidateQueries(['pos-sessions-open', registerProperty])
    },
    // S652 (Nic): a propane sale failed on the server and the register said
    // nothing — the cart just sat there as an open tab. A failed sale says
    // why, and keeps the cart so the cashier can charge it again.
    onError: (e: any) => {
      // A ticket or pay link settled elsewhere a moment ago: the open list is
      // read again — and so is what is free (a site taken a moment ago).
      if (e?.response?.status === 409) { qc.invalidateQueries('pos-tickets'); qc.invalidateQueries('stay-availability') }
      toastOnce(errorMessage(e, 'The sale did not go through — nothing was charged. Check the connection and press Charge again.'), { error: true })
    },
    }
  )

  const toggleChargeMut = useMutation(({ id, val }:{ id:string; val:boolean }) => apiPatch(`/pos/items/${id}`, { chargeEligible:val }), { onSuccess: () => qc.invalidateQueries('pos-items') })
  const toggleActiveMut = useMutation(({ id, val }:{ id:string; val:boolean }) => apiPatch(`/pos/items/${id}`, { isActive:val }), { onSuccess: () => qc.invalidateQueries('pos-items') })
  const createItemMut = useMutation(() => apiPost('/pos/items', { ...newItem, propertyId: registerProperty, categoryId: newItem.categoryId, costPrice:Number(newItem.costPrice), sellPrice:Number(newItem.sellPrice), marginPct: newItem.marginPct === '' ? null : Number(newItem.marginPct), chargeEligible:newItem.chargeEligible, stockQty:Number(newItem.stockQty), stockMin:Number(newItem.stockMin), stockMax:Number(newItem.stockMax) }), { onSuccess: () => { qc.invalidateQueries('pos-items'); setNewItem({ name:'', categoryId:'', icon:'📦', sellPrice:'', costPrice:'', marginPct: defaultMarginPct!=null?String(defaultMarginPct):'', chargeEligible:true, stockQty:'0', stockMin:'5', stockMax:'50', propertyId:'' }) }, onError: (e:any) => toastOnce(errorMessage(e, 'Could not add the item — fill in the name, sell price and category, then press Add again.'), { error: true }) })

  // POS #1 auto-pricing helpers. Margin is gross % of sell price:
  // sell = cost / (1 - margin/100); margin = (sell - cost) / sell * 100.
  const round2 = (n: number) => Math.round(n * 100) / 100
  const priceFromMargin = (cost: number, margin: number) =>
    (margin >= 0 && margin < 100 && cost > 0) ? round2(cost / (1 - margin / 100)) : null
  const setItemCost = (v: string) => setNewItem(s => {
    const cost = Number(v), m = Number(s.marginPct)
    const next = { ...s, costPrice: v }
    if (s.marginPct !== '' && cost > 0) { const p = priceFromMargin(cost, m); if (p != null) next.sellPrice = String(p) }
    return next
  })
  const setItemMargin = (v: string) => setNewItem(s => {
    const cost = Number(s.costPrice), m = Number(v)
    const next = { ...s, marginPct: v }
    const p = priceFromMargin(cost, m); if (p != null) next.sellPrice = String(p)
    return next
  })
  const setItemSell = (v: string) => setNewItem(s => {
    const sell = Number(v), cost = Number(s.costPrice)
    const next = { ...s, sellPrice: v }
    if (sell > 0 && cost > 0) next.marginPct = String(round2(((sell - cost) / sell) * 100))
    return next
  })
  // Seed the item form's margin with the business default once it loads.
  useEffect(() => {
    if (defaultMarginPct != null) setNewItem(s => s.marginPct === '' && s.costPrice === '' && s.sellPrice === '' ? { ...s, marginPct: String(defaultMarginPct) } : s)
  }, [defaultMarginPct])
  // Override-confirm: if a default margin exists and this item's margin
  // deviates from it, confirm before saving.
  const submitNewItem = async () => {
    if (defaultMarginPct != null && newItem.marginPct !== '') {
      const m = Number(newItem.marginPct)
      if (Math.abs(m - defaultMarginPct) > 0.5) {
        if (!(await appConfirm(`This price is a ${m.toFixed(1)}% margin, not your ${defaultMarginPct}% default. Save anyway?`, { confirmLabel: 'Save anyway' }))) return
      }
    }
    createItemMut.mutate()
  }
  const updateItemMut = useMutation((data:any) => apiPatch(`/pos/items/${editItem.id}`, data), { onSuccess: () => { qc.invalidateQueries('pos-items'); setEditItem(null) } })

  const createVendorMut = useMutation(() => apiPost('/pos/vendors', { propertyId: registerProperty, ...newVendor, leadTimeDays:Number(newVendor.leadTimeDays) }), { onSuccess: () => { qc.invalidateQueries('pos-vendors'); setNewVendor({ name:'', contactName:'', email:'', phone:'', address:'', leadTimeDays:'3', notes:'' }) } })
  const updateVendorMut = useMutation((data:any) => apiPatch(`/pos/vendors/${editVendor.id}`, data), { onSuccess: () => { qc.invalidateQueries('pos-vendors'); setEditVendor(null) } })

  const createPOMut = useMutation(() => apiPost('/pos/purchase-orders', { ...newPO, items: poItems, propertyId: registerProperty }), { onSuccess: () => { qc.invalidateQueries('pos-purchase-orders'); setNewPO({ vendorId:'', notes:'', expectedDate:'' }); setPoItems([]) } })
  const updatePOMut = useMutation(({ id, status }:{ id:string; status:string }) => apiPatch(`/pos/purchase-orders/${id}`, { status }), { onSuccess: () => qc.invalidateQueries('pos-purchase-orders') })

  // S219: category CRUD. Invalidates both the active-only query (drives
  // dropdowns) and the all-inclusive query (drives the manage tab).
  const invalCats = () => { qc.invalidateQueries('pos-categories'); qc.invalidateQueries('pos-categories-all') }
  const createCategoryMut = useMutation(
    () => apiPost('/pos/categories', { name:newCategory.name, icon:newCategory.icon||'📦', sortOrder: newCategory.sortOrder===''?0:Number(newCategory.sortOrder), propertyIds: newCategory.propertyIds }),
    { onSuccess: () => { invalCats(); setNewCategory({ name:'', icon:'📦', sortOrder:'', propertyIds:[] }) } }
  )
  const updateCategoryMut = useMutation(
    (data:any) => apiPatch(`/pos/categories/${editCategory.id}`, data),
    { onSuccess: () => { invalCats(); setEditCategory(null) } }
  )
  const toggleCategoryActiveMut = useMutation(
    ({ id, val }:{ id:string; val:boolean }) => apiPatch(`/pos/categories/${id}`, { isActive:val }),
    { onSuccess: invalCats }
  )

  // W-12: '' in the form means "All locations" — an explicit choice; the
  // form's default is the page property (synced by the effect below).
  const taxBody = (d: typeof blankTax) => ({
    name: d.name.trim(), rate: Number(d.ratePct) / 100,
    appliesTo: d.all ? ['all'] : [],
    categoryIds: d.all ? [] : d.categoryIds, itemIds: d.all ? [] : d.itemIds,
  })
  const saveTaxMut = useMutation(() => taxDraft.id
    ? apiPatch(`/pos/tax-rates/${taxDraft.id}`, taxBody(taxDraft))
    : apiPost('/pos/tax-rates', { ...taxBody(taxDraft), propertyId: registerProperty || null }),
    { onSuccess: () => { qc.invalidateQueries('pos-tax-rates'); qc.invalidateQueries('pos-items'); setTaxDraft(blankTax) },
      onError: (e:any) => toastOnce(errorMessage(e, 'Could not save the tax — check the connection and press Save again.'), { error: true }) })
  const deleteTaxMut = useMutation((id:string) => apiDel(`/pos/tax-rates/${id}`), { onSuccess: () => { qc.invalidateQueries('pos-tax-rates'); qc.invalidateQueries('pos-items') } })
  // Turn one tax on or off for one item (the item editor's checkboxes).
  const setItemTaxMut = useMutation((v: { tax: any; itemId: string; on: boolean }) => {
    const ids: string[] = v.tax.itemIds || []
    const next = v.on ? Array.from(new Set([...ids, v.itemId])) : ids.filter((x: string) => x !== v.itemId)
    return apiPatch(`/pos/tax-rates/${v.tax.id}`, { itemIds: next })
  }, { onSuccess: () => { qc.invalidateQueries('pos-tax-rates'); qc.invalidateQueries('pos-items') } })
  // Taxes that belong to the register's property (or every location).
  const propertyTaxes = (taxRates as any[]).filter((r: any) => r.isActive !== false && (!r.propertyId || r.propertyId === registerProperty))
  const taxAppliesToAll = (t: any) => Array.isArray(t.appliesTo) && t.appliesTo.some((x: string) => String(x).toLowerCase() === 'all')
  /** How a tax reaches an item: 'all', 'category', 'item', or null. */
  const taxReach = (t: any, item: any): 'all' | 'category' | 'item' | null => {
    if (taxAppliesToAll(t)) return 'all'
    if ((t.categoryIds || []).includes(item.categoryId)
      || (Array.isArray(t.appliesTo) && t.appliesTo.some((x: string) => String(x).toLowerCase() === String(item.category || '').toLowerCase()))) return 'category'
    if ((t.itemIds || []).includes(item.id)) return 'item'
    return null
  }
  const createDiscountMut = useMutation(() => apiPost('/pos/discounts', { ...newDiscount, value:Number(newDiscount.value), propertyId: registerProperty }), { onSuccess: () => { qc.invalidateQueries('pos-discounts'); setNewDiscount({ name:'', type:'percent', value:'', code:'' }) } })
  const deleteDiscountMut = useMutation((id:string) => apiDel(`/pos/discounts/${id}`), { onSuccess: () => qc.invalidateQueries('pos-discounts') })
  const refundMut = useMutation(() => apiPost(`/pos/transactions/${refundModal.tx?.id}/refund`, { amount:Number(refundAmt)||refundModal.tx?.total, reason:refundReason, refundMethod }), { onSuccess: (r: any) => {
      qc.invalidateQueries('pos-transactions'); setRefundModal({show:false,tx:null}); setRefundAmt(''); setRefundReason(''); setRefundMethod('cash')
      // 10/3 (review): say what to do next — what to hand back, and that the
      // reservation (if any) is still on the schedule (decisions #23).
      const d = r?.data ?? {}
      const amt = `$${Number(d.refundAmount ?? 0).toFixed(2)}`
      const how = d.refundMethod === 'cash' ? `Refunded ${amt} — hand back ${amt} in cash.`
        : d.refundMethod === 'check' ? `Refunded ${amt} — write them a check for ${amt}.`
        : d.refundMethod === 'charge' ? `Refunded ${amt} to their charge account.`
        : (d.refundMethod === 'card' || d.refundMethod === 'card_on_file') ? `Refunded ${amt} to their card — it shows on their statement in a few days.`
        : `Refunded ${amt}.`
      toastOnce(d.reservationStillOnSchedule ? `${how} Their reservation is still on the schedule — cancel it there if they are not staying.` : how)
    },
    onError: (e: any) => { qc.invalidateQueries('pos-transactions'); toastOnce(errorMessage(e, 'The refund did not go through — check the connection, then press Process Refund again.'), { error: true }) } })
  // 10/3 (review): a void puts what the sale took back on the shelf — the item
  // grid, the low-stock list and the stock log read their counts again, as
  // after a sale or a stock change (also on a refusal: another desk may have
  // voided it first).
  const afterVoid = () => {
    qc.invalidateQueries('pos-transactions'); qc.invalidateQueries('pos-items')
    qc.invalidateQueries('pos-low-stock'); qc.invalidateQueries('pos-inventory-log')
  }
  const voidMut = useMutation((id:string) => apiPost(`/pos/transactions/${id}/void`, { reason:'Voided by cashier' }), {
    onSuccess: () => { setVoidAsk(null); toastOnce('Sale voided — what it took is back on the shelf'); afterVoid() },
    onError: (e: any) => { setVoidAsk(null); afterVoid(); toastOnce(errorMessage(e, 'The sale was not voided — check the connection, then press Void again.'), { error: true }) } })

  // S243: SDK Bluetooth-reader discovery + connect (handheld path).
  // Smart readers (S700, WisePOS E) appear in the modal too but via
  // the `registeredReaders` GAM-side list, not the SDK scan.
  const discoverAndConnect = async () => {
    setTerminalStatus('discovering'); setTerminalError('')
    try {
      if (!registerProperty) throw new Error('Select a property first')
      const found = await discoverReaders(registerProperty); setReaders(found); setTerminalStatus('idle')
    }
    catch (e: any) { setTerminalError(e.message); setTerminalStatus('error') }
  }
  const selectBluetoothReader = async (reader: any) => {
    setTerminalStatus('connecting')
    try {
      const r = await connectReader(reader)
      setActiveReader({ type: 'bluetooth', sdkReader: r, label: r.label || r.serialNumber })
      setReaderModal(false); setTerminalStatus('idle')
    } catch (e: any) { setTerminalError(e.message); setTerminalStatus('error') }
  }
  const selectSmartReader = (r: RegisteredReader) => {
    setActiveReader({ type: 'smart', stripeReaderId: r.stripeReaderId, nickname: r.nickname })
    setReaderModal(false)
  }

  // S243: full card-present charge flow.
  // 1. Create PI on GAM's account (server-side).
  // 2. Branch:
  //    - smart reader: push PI to reader, poll status until
  //      requires_capture / canceled / timeout.
  //    - bluetooth:    SDK collects card in-browser; SDK process
  //      returns the PI in requires_capture.
  // 3. POST /pos/transactions with stripePaymentIntentId — backend
  //    validates, records the sale and captures the card together.
  // 5. On any error, attempt PI cancel so it doesn't sit in
  //    requires_payment_method.
  const chargeWithReader = async () => {
    if (!registerProperty) {
      setTerminalError('Select a property before charging')
      setTerminalStatus('error'); return
    }
    if (!activeReader) { setReaderModal(true); return }
    setTerminalStatus('collecting'); setTerminalError('')
    let piId: string | null = null
    try {
      // S654 (Nic): "Can the tap happen in the background while the display is
      // still up for the breakdown?" Yes — the breakdown stays up (it was put
      // there while the cart was rung) for the tap window; a card tapped on it
      // is what the charge goes through with. Nothing is charged until the
      // window ends, so "Cancel" simply goes back to the cart.
      let breakdownUp = false
      if (activeReader.type === 'smart') {
        breakdownUp = breakdownIsUp
        await liveCartCall.current?.catch(() => {})
        if (!breakdownUp) {
          const l = latest.current
          const rid = activeReader.stripeReaderId
          const r = await queueReader(() => showCartLive({ stripeReaderId: rid, propertyId: registerProperty,
            items: l.cart.map(i => wireLine(i, l.openTicketId, l.payLinkId)),
            discountAmount: l.discountAmt, tenantId: l.tenantId || null, posCustomerId: l.posCustomerId || null })).catch(() => null)
          breakdownUp = !!r?.shown
          if (breakdownUp) shownOnReader.current = { readerId: activeReader.stripeReaderId, propertyId: registerProperty }
        }
        if (breakdownUp) {
          tapSubject.current = JSON.stringify(['card', activeReader.stripeReaderId,
            latest.current.cart.map(i => wireLine(i, latest.current.openTicketId, latest.current.payLinkId)),
            latest.current.discountAmt, latest.current.tenantId, latest.current.posCustomerId])
          setTerminalStatus('awaiting_tap')
          const outcome = await waitForTap()
          tapSubject.current = null
          if (outcome === 'cancel') { setTerminalStatus('idle'); return }
          setTerminalStatus('collecting')
          await liveCartCall.current?.catch(() => {})
        }
      }
      // S554: mint the PI against the SERVER's authoritative total (same
      // computeCartTotals /transactions runs), not the client-side total.
      // Server tax can differ from item.tax_rate when a pos_tax_rates row is
      // configured; without this the amounts diverge and the sale 400s AFTER
      // the card is captured (money taken, no sale).
      // S648: the server prices the reader charge from the cart itself, card
      // fee included — the register no longer sends an amount.
      const l = latest.current
      const cartLines = l.cart.map(i => wireLine(i, l.openTicketId, l.payLinkId))
      const who = { tenantId: l.tenantId || null, posCustomerId: l.posCustomerId || null, cartOnReader: breakdownUp }
      let intent: { id: string; clientSecret: string } | null = null
      // S654: a charge the reader timed out on is sent again as-is. The server
      // re-prices the cart and refuses a changed one, in which case the old
      // charge is voided and a fresh one minted.
      if (pendingIntent && activeReader.type === 'smart' && pendingIntent.readerId === activeReader.stripeReaderId) {
        try {
          await processIntentOnReader({ paymentIntentId: pendingIntent.id, stripeReaderId: activeReader.stripeReaderId, items: cartLines, discountAmount: l.discountAmt, ...who })
          intent = { id: pendingIntent.id, clientSecret: '' }
        } catch {
          await cancelTerminalIntent(pendingIntent.id).catch(() => {})
          setPendingIntent(null)
        }
      }
      if (!intent) {
        // 10/2 (decisions #9): a reservation ticket's charge is priced by the
        // server as the reservation, from the ticket it settles.
        const intentArgs = { items: cartLines, discountAmount: l.discountAmt, propertyId: registerProperty, description: 'GAM POS sale', openTicketId: l.openTicketId }
        const fresh = await createTerminalIntent(intentArgs)
        intent = fresh
        if (activeReader.type === 'smart') {
          await processIntentOnReader({ paymentIntentId: fresh.id, stripeReaderId: activeReader.stripeReaderId, items: cartLines, discountAmount: l.discountAmt, ...who })
        }
      }
      piId = intent.id

      if (activeReader.type === 'smart') {
        await pollPiUntilTerminal(intent.id)
      } else {
        await collectCardPayment(intent.clientSecret)
      }

      // S648: recording the sale captures the card, in one server step.
      setTerminalStatus('capturing')
      await checkoutMut.mutateAsync(intent.id)
      setPendingIntent(null)
      setTerminalStatus('idle')
    } catch (e: any) {
      const raw = e?.response?.data?.error
      const msg: string = (typeof raw === 'string' ? raw : raw?.message) || e?.message || 'Charge failed'
      // 10/3 (review): a refusal because something changed (a site taken, a
      // figure moved) reads what is free again for the next pick.
      if (e?.response?.status === 409) qc.invalidateQueries('stay-availability')
      if (activeReader.type === 'bluetooth') {
        await cancelCurrentPayment().catch(() => {})
        if (piId) await cancelTerminalIntent(piId).catch(() => {})
        setTerminalError(msg)
      } else if (piId) {
        // S654 (Nic): clear the reader's "tap or insert"; keep the charge and the cart.
        await clearReaderPrompt(piId, activeReader.stripeReaderId).catch(() => {})
        setPendingIntent({ id: piId, readerId: activeReader.stripeReaderId })
        setReaderCartNonce(n => n + 1)   // the breakdown goes back up for the next try
        // 10/2 (review): one instruction, never two — a server message that
        // already says what to press is shown as it is.
        setTerminalError(/timed out/i.test(msg)
          ? 'No card was presented. The cart is still here — tap Charge again when they are ready.'
          : /press (charge|clear)|tap charge|charge again|on the reader instead|another form of payment/i.test(msg)
            ? msg
            : `${msg} — the cart is still here; tap Charge to try again.`)
      } else {
        setTerminalError(msg)
      }
      setTerminalStatus('error')
    }
  }

  // S243: Readers-tab mutations. Register-new + archive surface the
  // S241 backend CRUD so landlords can pair smart readers without
  // hitting the API directly.
  const registerReaderMut = useMutation(
    () => registerNewReader(newReader),
    { onSuccess: () => {
      qc.invalidateQueries('pos-terminal-readers')
      setNewReader({ propertyId:'', registrationCode:'', nickname:'' })
    }},
  )
  const archiveReaderMut = useMutation(
    (id: string) => archiveRegisteredReader(id),
    { onSuccess: () => qc.invalidateQueries('pos-terminal-readers') },
  )

  // Every POS tab is its own permission (`pos.tab.*`) so an owner can grant a
  // staff member exactly the tabs they need — one cashier gets Register only,
  // another also gets Discounts, etc. Owners (landlord/admin) see all tabs.
  // Staff see only tabs whose permission they hold. These keys are toggled on
  // the per-user permissions page.
  const isOwner = !!user && ['landlord', 'admin', 'super_admin'].includes(user.role)
  const canSeeTab = (perm: string) => isOwner || (user?.permissions as any)?.[perm] === true
  const canRefund = canSeeTab('pos.refund')
  const canVoid = canSeeTab('pos.void')
  const TABS = [
    { key:'register',  label:'Register',   perm:'pos.tab.register' },
    { key:'history',   label:'History',    perm:'pos.tab.history' },
    // S654 (Nic): "an overall customers tab… see my whole customer history."
    { key:'customers', label:'Customers',  perm:'pos.tab.history' },
    // S648: emailed pay links + QR codes — anyone who can ring a sale.
    { key:'paylinks',  label:'Pay Links',  perm:'pos.tab.register' },
    { key:'items',     label:'Items',      perm:'pos.tab.items' },
    { key:'categories',label:'Categories', perm:'pos.tab.categories' },
    { key:'taxes',     label:'Tax Rates',  perm:'pos.tab.taxes' },
    { key:'discounts', label:'Discounts',  perm:'pos.tab.discounts' },
    { key:'vendors',   label:'Vendors',    perm:'pos.tab.vendors' },
    { key:'orders',    label:'Orders',     perm:'pos.tab.orders' },
    { key:'inventory', label:'Inventory',  perm:'pos.tab.inventory' },
    { key:'readers',   label:'Readers',    perm:'pos.tab.readers' },
  ].filter(t => canSeeTab(t.perm))

  // S536 (Nic): consolidate configuration under one Settings tab —
  // Register / History / Inventory are daily-use and stay top-level;
  // Items / Categories / Tax Rates / Discounts / Vendors / Orders /
  // Readers are set-once config behind Settings. Permission gating is
  // unchanged: Settings shows only the subtabs the user may see and
  // disappears entirely when none are allowed.
  const SETTINGS_KEYS = ['items','categories','taxes','discounts','vendors','orders','readers']
  const settingsTabs = TABS.filter(t => SETTINGS_KEYS.includes(t.key))
  const primaryTabs  = TABS.filter(t => !SETTINGS_KEYS.includes(t.key))
  const inSettings   = SETTINGS_KEYS.includes(tab)

  // If the active tab isn't one this user can see (e.g. a cashier without the
  // default Register tab), snap to their first available tab so content and
  // the tab bar stay in sync.
  const visibleTabKeys = TABS.map(t => t.key).join(',')
  useEffect(() => {
    if (TABS.length && !TABS.some(t => t.key === tab)) setTab(TABS[0].key as any)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabKeys])

  // S654: watch the reader for the customer's answer (two minutes, Stripe's own prompt timeout).
  useEffect(() => {
    if (saveCard !== 'asking' || !receipt?.customer?.readerId || !receipt?.id) return
    let stop = false
    const deadline = Date.now() + 125_000
    const tick = async () => {
      while (!stop && Date.now() < deadline) {
        try {
          const a: any = await apiGet<any>(`/pos/terminal/readers/${receipt.customer.readerId}/save-card-answer?transactionId=${receipt.id}`)
          if (stop) return
          if (a.answered) {
            setSaveCard(a.saved ? 'saved' : 'declined')
            if (a.receiptSentTo) { setReceiptSent(a.receiptSentTo); setReceiptEmail(a.receiptSentTo) }
            if (a.nameSet) {
              const parts = String(a.nameSet).split(' ')
              setReceipt((r: any) => r ? { ...r, customer: { ...r.customer, firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0], lastName: parts.length > 1 ? parts[parts.length - 1] : '' } } : r)
            }
            return
          }
        } catch { /* keep watching */ }
        await new Promise(r => setTimeout(r, 2000))
      }
      if (!stop) setSaveCard('timeout')
    }
    void tick()
    return () => { stop = true }
  }, [saveCard, receipt?.id])   // eslint-disable-line react-hooks/exhaustive-deps
  // 10/2 (review): the card tapped was folded into the person picked, with its
  // other sales — Undo puts the card and those sales back (the sale stays theirs).
  const cardUndoMut = useMutation(
    (v: { saleId: string; undo: string }) => apiPost<any>(`/pos/transactions/${v.saleId}/customer/undo`, { undo: v.undo }).then((r: any) => r?.data),
    { onSuccess: (r: any) => {
        setReceipt((x: any) => x ? { ...x, customer: { ...(x.customer || {}), cardNote: r?.message ?? null, cardUndo: null } } : x)
        toastOnce(r?.message || 'Put back')
        qc.invalidateQueries('pos-transactions'); qc.invalidateQueries('pos-customer-base')
      },
      onError: (e: any) => {
        setReceipt((x: any) => x ? { ...x, customer: { ...(x.customer || {}), cardUndo: null } } : x)
        toastOnce(errorMessage(e, 'That could not be undone — check the connection, then open the sale in History and pick the right person.'), { error: true })
      } })
  const emailReceiptMut = useMutation(
    () => apiPost(`/pos/transactions/${receipt?.id}/email-receipt`, { email: receiptEmail.trim() }),
    { onSuccess: (r: any) => { setReceiptSent(r.data.sentTo) },
      onError: (e: any) => toastOnce(errorMessage(e, 'The receipt could not be sent — check the email and press Send again.'), { error: true }) })
  const { data: customersBase = [], isLoading: custLoading } = useQuery<any[]>(['pos-customer-base', registerProperty],
    () => apiGet(`/pos/customers?propertyId=${registerProperty}`), { enabled: tab==='customers' && !!registerProperty })
  const txReceiptMut = useMutation(
    (v: { id: string; email: string }) => apiPost(`/pos/transactions/${v.id}/email-receipt`, { email: v.email.trim() }),
    { onSuccess: (r: any) => { setTxEdit(null); toastOnce(`Receipt sent to ${r.data.sentTo}`); qc.invalidateQueries('pos-customer-base') },
      onError: (e: any) => toastOnce(errorMessage(e, 'The receipt could not be sent — check the email and press Send receipt again.'), { error: true }) })
  // The person the finished sale names, as the picker shows them. A card with
  // no name yet is nobody: the panel opens ready to type.
  const rc: any = receipt?.customer ?? null
  const rcName = rc ? `${rc.firstName ?? ''} ${rc.lastName ?? ''}`.trim() : ''
  const receiptPerson: PickedPerson | null = !rc?.id ? null
    : rc.isResident ? { kind: 'resident', tenantId: rc.tenantId ?? null, customerId: rc.id, name: rcName || 'Resident', hint: 'resident' }
    : (rc.firstName === 'Card' && rc.lastName === 'Customer') || !rcName ? null
    : { kind: 'customer', tenantId: null, customerId: rc.id, name: rcName, hint: rc.email || null }

  if (receipt) return (
    <div>
      <div className="page-header"><div><h1 className="page-title">Point of Sale</h1></div></div>
      <div style={{maxWidth:420,margin:'0 auto'}}>
        <div className="card" style={{textAlign:'center',padding:32}}>
          <div style={{fontSize:'2rem',marginBottom:8}}>✅</div>
          <div style={{fontWeight:700,fontSize:'1.1rem',marginBottom:4}}>Sale Complete</div>
          <div style={{color:'var(--text-3)',fontSize:'.82rem',marginBottom:receipt.method==='cash'?12:24}}>Transaction recorded</div>
          {/* 10/3 (Nic, decisions #16): the change to hand back stays up until
              the cashier closes this — never gone the moment the sale lands. */}
          {receipt.method==='cash' && (
            <div style={{border:'2px solid var(--gold)',borderRadius:10,padding:'14px 12px',marginBottom:20}}>
              <div style={{fontSize:'1.7rem',fontWeight:800,color:'var(--gold)',lineHeight:1.2}}>
                {receipt.changeDue>0 ? `Give ${fmt(receipt.changeDue)} change` : 'No change due'}
              </div>
              <div style={{fontSize:'.9rem',color:'var(--text-2)',marginTop:6}}>
                Received {fmt(receipt.cashReceived ?? receipt.total)} / Total {fmt(receipt.total)}
              </div>
            </div>
          )}
          <table className="data-table" style={{marginBottom:16}}>
            <tbody>{receipt.cartItems.map((i:any,idx:number) => (<tr key={idx}><td>{i.name}</td><td className="mono">x{i.qty}</td><td className="mono">{fmt(i.price*i.qty)}</td></tr>))}</tbody>
          </table>
          <div style={{display:'grid',gap:4,fontSize:'.88rem',marginBottom:16}}>
            <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Subtotal</span><span>{fmt(receipt.subtotal)}</span></div>
            {receipt.discountAmt>0&&<div style={{display:'flex',justifyContent:'space-between',color:'var(--green)'}}><span>Discount</span><span>-{fmt(receipt.discountAmt)}</span></div>}
            {receipt.taxAmount>0&&(Array.isArray(receipt.taxBreakdown)&&receipt.taxBreakdown.length
              ? receipt.taxBreakdown.map((l:any)=><div key={l.name} style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>{l.name}</span><span>{fmt(Number(l.amount))}</span></div>)
              : <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Tax</span><span>{fmt(receipt.taxAmount)}</span></div>)}
            {receipt.surcharge>0&&<div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>{receipt.method==='card' ? 'Card processing fee' : 'Charge account fee (1%)'}</span><span>{fmt(receipt.surcharge)}</span></div>}
            <div style={{display:'flex',justifyContent:'space-between',fontWeight:700,fontSize:'1rem',borderTop:'1px solid var(--border-1)',paddingTop:8,marginTop:4}}>
              <span>Total</span><span style={{color:'var(--gold)'}}>{fmt(receipt.total)}</span>
            </div>
            {receipt.method==='cash'&&<div style={{display:'flex',justifyContent:'space-between',color:'var(--text-2)'}}><span>Received</span><span>{fmt(receipt.cashReceived ?? receipt.total)}</span></div>}
            {receipt.method==='cash'&&receipt.changeDue>0&&<div style={{display:'flex',justifyContent:'space-between',color:'var(--gold)',fontWeight:700}}><span>Give change</span><span>{fmt(receipt.changeDue)}</span></div>}
          </div>
          {/* 10/5 (Nic): what the stay sold here means — the server's own words
              (R13: a 30+ night stay with no lease is held only through what is
              paid), the paid background check and where its link went (R8), and
              a lease drafted for the landlord (R2). */}
          {receipt.stayBooking && (receipt.stayBooking.heldWords || receipt.stayBooking.screeningFee || receipt.stayBooking.leaseId) && (
            <div style={{textAlign:'left',border:'1px solid var(--border-1)',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:'.8rem',display:'grid',gap:6,color:'var(--text-2)',lineHeight:1.45}}>
              {receipt.stayBooking.heldWords && <div>{receipt.stayBooking.heldWords}</div>}
              {receipt.stayBooking.screeningFee && <div>
                Their background check is paid ({fmt(Number(receipt.stayBooking.screeningFee))}).{receipt.stayBooking.screeningEmail ? ` The link to fill it out was emailed to ${receipt.stayBooking.screeningEmail}.` : ''} Check-in waits for the results and the owner's decision.
              </div>}
              {receipt.stayBooking.leaseId && <div>A month-to-month lease was drafted for the owner to review and send for signature.</div>}
            </div>)}
          {/* 10/2 (Nic): who the sale was for — typed and picked, exactly as at
              the register. A sale that names nobody (or only a card) opens ready
              to type; linking it fills in every other sale on the same card. */}
          <div style={{textAlign:'left',border:'1px solid var(--border-1)',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:'.82rem',display:'grid',gap:6}}>
            <SaleCustomerLink key={receipt.id} saleId={receipt.id} propertyId={registerProperty} current={receiptPerson} startOpen
              onLinked={(r:any, picked)=>{
                const name = String(r?.customerName ?? picked?.name ?? '').trim()
                const parts = name.split(' ')
                setReceipt((x:any)=>({ ...x, tenantId: r?.tenantId ?? null, posCustomerId: r?.posCustomerId ?? null,
                  customer: { ...(x.customer || {}), id: r?.posCustomerId ?? null,
                    firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0], lastName: parts.length > 1 ? parts[parts.length - 1] : '',
                    isResident: !!r?.tenantId, tenantId: r?.tenantId ?? null, email: picked?.email ?? null,
                    isNew: false, priorPurchases: undefined, cardNote: null } }))
                if (picked?.email && !receiptEmail.trim()) setReceiptEmail(picked.email)
                qc.invalidateQueries('pos-transactions'); qc.invalidateQueries('pos-customer-base')
              }} />
            {receipt.customer?.id && receiptPerson && (
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,color:'var(--text-3)',fontSize:'.75rem'}}>
                <span>
                  {receipt.customer.last4 ? `Card ending ${receipt.customer.last4}` : 'Paid'}
                  {receipt.customer.isNew ? ' · new customer'
                    : typeof receipt.customer.priorPurchases === 'number' ? ` · ${receipt.customer.priorPurchases} previous purchase${receipt.customer.priorPurchases===1?'':'s'}` : ''}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={()=>{ setHistoryCustomer({ id: receipt.customer.id, name: receiptPerson.name }); setReceipt(null); setTab('history') }}>History</button>
              </div>
            )}
            {receipt.customer?.cardNote && <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',color:'var(--text-2)'}}>
              <span>{receipt.customer.cardNote}</span>
              {receipt.customer.cardUndo && <button type="button" className="btn btn-primary btn-sm" disabled={cardUndoMut.isLoading}
                onClick={()=>cardUndoMut.mutate({ saleId: receipt.id, undo: receipt.customer.cardUndo })}>{cardUndoMut.isLoading ? 'Putting back…' : 'Undo'}</button>}
            </div>}
            {receipt.customer && (<>
              {saveCard==='asking' && <div style={{color:'var(--text-2)'}}>
                Asking on the reader{[receipt.customer.asks?.askSave&&'whether to keep the card', receipt.customer.asks?.askName&&'for a name', receipt.customer.asks?.askEmail&&'for a receipt email'].filter(Boolean).map((x,i,a)=>(i===0?' ':i===a.length-1?' and ':', ')+x).join('')}…
              </div>}
              {saveCard==='saved' && <div style={{color:'var(--green)'}}>Card kept for next time — it shows under On file.</div>}
              {saveCard==='declined' && receipt.customer.asks?.askSave && <div style={{color:'var(--text-3)'}}>Card not kept.</div>}
              {saveCard==='declined' && !receipt.customer.asks?.askSave && <div style={{color:'var(--text-3)'}}>Done on the reader.</div>}
              {saveCard==='timeout' && <div style={{color:'var(--text-3)'}}>No answer on the reader.</div>}
              {receipt.customer.cardSaved && saveCard==null && <div style={{color:'var(--text-3)'}}>Card already on file.</div>}
              {!receipt.customer.cardSaved && !receipt.customer.cardKeepable && !receipt.customer.isResident && receipt.customer.last4 && saveCard==null && <div style={{color:'var(--text-3)'}}>A phone-wallet tap can't be kept on file.</div>}
            </>)}
          </div>
          <div style={{textAlign:'left',marginBottom:14}}>
            <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Email a copy of the receipt</div>
            {receiptSent ? (
              <div style={{fontSize:'.82rem',color:'var(--green)'}}>Receipt sent to {receiptSent}</div>
            ) : (
              <div style={{display:'flex',gap:6}}>
                <input className="form-input" type="email" placeholder="name@example.com" value={receiptEmail} onChange={e=>setReceiptEmail(e.target.value)} style={{flex:1}} />
                <button className="btn btn-primary btn-sm" disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(receiptEmail.trim())||emailReceiptMut.isLoading} onClick={()=>emailReceiptMut.mutate()}>{emailReceiptMut.isLoading?'Sending…':'Send'}</button>
              </div>
            )}
          </div>
          <button className="btn btn-primary" style={{width:'100%'}} onClick={()=>{ setReceipt(null); setSaveCard(null) }}>New Sale</button>
        </div>
      </div>
    </div>
  )

  return (
    <div>
      <div className="page-header">
        <div style={{display:'flex',alignItems:'center',gap:14}}>
          <h1 className="page-title" style={{margin:0}}>Point of Sale</h1>
          {/* W-12 (S531): ONE property context for the whole POS surface —
              every tab (register, history, items, taxes, …) reads and
              writes within this property. No cross-property mixing. */}
          {(properties as any[]).length > 1 && (
            <select className="form-select" value={registerProperty} onChange={e=>{ void switchProperty(e.target.value) }} style={{width:'auto',minWidth:200}}>
              <option value="" disabled>Select a property…</option>
              {(properties as any[]).map((p:any)=><option key={p.id} value={p.id}>{p.name||p.street1}</option>)}
            </select>
          )}
        </div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          {primaryTabs.map(t => <button key={t.key} className={"tab-btn "+(tab===t.key?'active':'')} onClick={()=>setTab(t.key as any)}>{t.label}</button>)}
          {settingsTabs.length > 0 && (
            <button className={"tab-btn "+(inSettings?'active':'')} onClick={()=>setTab(settingsTabs[0].key as any)}>Settings</button>
          )}
        </div>
      </div>

      {inSettings && (
        <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:14}}>
          {settingsTabs.map(t => <button key={t.key} className={"tab-btn "+(tab===t.key?'active':'')} onClick={()=>setTab(t.key as any)} style={{fontSize:'.78rem',padding:'4px 12px'}}>{t.label}</button>)}
        </div>
      )}

      {!registerProperty && (
        <div style={{padding:'48px 24px',textAlign:'center',color:'var(--text-3)',border:'1px dashed var(--border-1)',borderRadius:12}}>
          Select a property above — POS is per-property: its register, sales history, items, and tax rates all live at one location.
        </div>
      )}

      {tab==='register' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 340px',gap:16,alignItems:'start'}}>
          <div>
            {!registerProperty ? null : (<>
            {/* S263: open-tab banner — appears when there's an unclosed
                session on this property from a prior terminal visit /
                crash / handoff. Resume loads the items; Discard voids. */}
            {openTabs.length > 0 && cart.length === 0 && (() => {
              const line = (t: OpenTab) => `${t.itemCount} item${t.itemCount===1?'':'s'} · ${fmt(t.total)} · opened ${t.openedAt ? new Date(t.openedAt).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : 'earlier'}${t.customerName ? ` · ${t.customerName}` : ''}${t.preview ? ` · ${t.preview}` : ''}`
              const many = openTabs.length > 1
              const shown = many && !tabsExpanded ? [] : openTabs
              return (
              <div style={{padding:'12px 16px',background:'rgba(201,162,39,.08)',border:'1px solid rgba(201,162,39,.3)',borderRadius:10,marginBottom:12}}>
                <div style={{display:'flex',alignItems:'center',gap:12}}>
                  <div style={{flex:1,cursor:many?'pointer':'default'}} onClick={()=>many&&setTabsExpanded(x=>!x)}>
                    <div style={{fontWeight:700,color:'var(--gold)',fontSize:'.85rem'}}>
                      {many ? <>{tabsExpanded ? '▾' : '▸'} {openTabs.length} open carts on this register</> : 'Open cart on this register'}
                    </div>
                    {!many && <div style={{fontSize:'.75rem',color:'var(--text-2)',marginTop:2}}>{line(openTabs[0])}</div>}
                    {many && !tabsExpanded && <div style={{fontSize:'.75rem',color:'var(--text-3)',marginTop:2}}>Open the list to pick one to resume.</div>}
                  </div>
                  {!many && <button onClick={()=>resumeSession(openTabs[0].id)} className="btn btn-primary btn-sm">Resume</button>}
                  {!many && <button onClick={()=>discardOpenTab(openTabs[0].id)} className="btn btn-ghost btn-sm">Discard</button>}
                  {many && <button onClick={()=>discardOpenTab('all')} className="btn btn-ghost btn-sm">Discard all</button>}
                </div>
                {many && tabsExpanded && (
                  <div style={{display:'grid',gap:6,marginTop:10}}>
                    {shown.map(t => (
                      <div key={t.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',background:'var(--bg-1)',border:'1px solid var(--border-1)',borderRadius:8}}>
                        <div style={{flex:1,fontSize:'.78rem',color:'var(--text-1)'}}>{line(t)}</div>
                        <button onClick={()=>resumeSession(t.id)} className="btn btn-primary btn-sm">Resume</button>
                        <button onClick={()=>discardOpenTab(t.id)} className="btn btn-ghost btn-sm">Discard</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>)
            })()}
            <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
              {categories.map(c => (<button key={c} onClick={()=>setFilterCat(c)} className={"tab-btn "+(filterCat===c?'active':'')} style={{fontSize:'.78rem',padding:'4px 12px',textTransform:'capitalize'}}>{c}</button>))}
              {/* S650 (Nic): no open items. "Items are set prices. There's no
                  custom item thing." Anything sold here is a button somebody
                  set up; a one-off goes on the lease or out as a pay link. */}
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))',gap:10}}>
              {visibleItems.filter((i:any)=>i.isActive).map((item:any) => (
                <button key={item.id} onClick={()=>addToCart(item)} style={{background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:'var(--r-lg)',padding:16,cursor:'pointer',textAlign:'left'}} onMouseEnter={e=>(e.currentTarget.style.borderColor='var(--gold)')} onMouseLeave={e=>(e.currentTarget.style.borderColor='var(--border-1)')}>
                  <div style={{fontSize:'.82rem',fontWeight:600,color:'var(--text-0)',marginBottom:2}}>{item.name}</div>
                  {/* S652 (Nic): a stay has no single price — site 5 is $40 a
                      night and site 6 is $42 — so the button cannot show one.
                      The price appears when the site does. */}
                  <div style={{fontSize:'.88rem',color:'var(--gold)',fontWeight:700}}>
                    {item.stayUnit
                      ? <>{fmt(Number(item.baseRate ?? 0))}<span style={{fontSize:'.62rem',color:'var(--text-3)',fontWeight:600,marginLeft:4}}>from</span></>
                      : fmt(item.sellPrice)}
                  </div>
                  <div style={{display:'flex',gap:4,marginTop:4,flexWrap:'wrap'}}>
                    {item.chargeEligible&&<span style={{fontSize:'.65rem',background:'var(--gold-bg)',color:'var(--gold)',padding:'1px 4px',borderRadius:3}}>charge</span>}
                    {item.stockQty<999&&<span style={{fontSize:'.65rem',color:item.stockQty<=item.stockMin?'var(--amber)':'var(--text-3)'}}>{Number(item.stockQty)} left</span>}
                  </div>
                </button>
              ))}
            </div>
            </>)}
          </div>
          <div className="card" style={{position:'sticky',top:80}}>
            {stockNotice && (
              <div style={{background:'rgba(245,158,11,.12)',border:'1px solid var(--amber)',borderRadius:8,padding:'6px 10px',marginBottom:8,fontSize:'.78rem',color:'var(--amber)',fontWeight:600}}>
                {stockNotice}
              </div>
            )}
            <div className="card-header"><span className="card-title">Current Sale</span>
              {/* S652 (Nic): "just clearing the cart should clear it, and if
                  they have a name associated with it save it as a ticket."
                  10/2: a reopened ticket goes BACK (never a second ticket), a
                  pay link stays out, and the live cart session is closed so it
                  never comes back as "resume or discard" (resetRegister). */}
              {(cart.length>0||!!openTicketId||!!payLinkId)&&<button disabled={readerHoldsCharge || putTicketBackMut.isLoading || writeTicketMut.isLoading} onClick={clearRegister}
                title={openTicketId ? 'Put this ticket back on the open list' : payLinkId ? 'Put this pay link back on the open list' : (tenantId||posCustomerId) ? 'Hold it for delivery under their name' : 'Empty the cart'}
                style={{background:'none',border:'none',color:'var(--text-3)',cursor:'pointer',fontSize:'.75rem'}}>
                {putTicketBackMut.isLoading ? 'Putting it back…' : 'Clear'}
              </button>}
            </div>
            {cart.length===0?(<div style={{color:'var(--text-3)',fontSize:'.85rem',padding:'24px 0',textAlign:'center'}}>No items added</div>):(
              <div style={{marginBottom:12}}>
                {cart.map(i=>(<div key={i.id} style={{display:'flex',alignItems:'center',gap:6,padding:'7px 0',borderBottom:'1px solid var(--border-1)'}}>
                  <div style={{flex:1,minWidth:0}}><div style={{fontSize:'.8rem',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:i.reservation?'normal':'nowrap'}}>{i.name}</div>
                    {!i.chargeEligible&&method==='charge'&&<div style={{fontSize:'.65rem',color:'var(--red)'}}>not charge eligible</div>}
                  </div>
                  {/* 10/2 (decisions #9, #23): the reservation is charged at
                      its own price — its nights, site and price change only on
                      the schedule, never counted up or down here. */}
                  {i.reservation ? (
                    <div style={{fontSize:'.68rem',color:'var(--text-3)',textAlign:'right',maxWidth:110,lineHeight:1.3}}>
                      {i.nights ? `${i.nights} night${i.nights===1?'':'s'} · ` : ''}reservation price · change it on the schedule
                    </div>
                  ) : i.fixed ? (
                    <div style={{fontSize:'.68rem',color:'var(--text-3)',textAlign:'right',maxWidth:110,lineHeight:1.3}}>
                      required · cannot be taken off
                    </div>
                  ) : (
                  <div style={{display:'flex',alignItems:'center',gap:4}}>
                    <button onClick={()=>updateQty(i.id,-1)} style={{background:'var(--bg-3)',border:'none',borderRadius:3,width:20,height:20,cursor:'pointer',fontWeight:700}}>-</button>
                    <input type="number" min={0} step="any" value={i.qty} onFocus={e=>e.currentTarget.select()} onChange={e=>{const v=parseFloat(e.target.value); if(!isNaN(v)) void setQty(i.id, v)}} style={{width:46,textAlign:'center',fontSize:'.82rem',fontWeight:600,background:'var(--bg-3)',border:'1px solid var(--border-1)',borderRadius:4,color:'var(--text-0)',padding:'2px 0'}} />
                    <button onClick={()=>updateQty(i.id,1)} style={{background:'var(--bg-3)',border:'none',borderRadius:3,width:20,height:20,cursor:'pointer',fontWeight:700}}>+</button>
                  </div>
                  )}
                  <div style={{fontSize:'.82rem',fontWeight:600,minWidth:44,textAlign:'right'}}>{fmt(lineAmount(i))}</div>
                </div>))}
                {/* 10/5 (Nic, R8): a stay over three weeks with no background
                    check on file carries the check's fee — the server adds it
                    to the sale, and nobody can take it off. */}
                {screeningDue>0 && (<div style={{display:'flex',alignItems:'center',gap:6,padding:'7px 0',borderBottom:'1px solid var(--border-1)'}}>
                  <div style={{flex:1,minWidth:0,fontSize:'.8rem',fontWeight:500}}>{stay?.screeningLineName || 'Background check'}</div>
                  <div style={{fontSize:'.68rem',color:'var(--text-3)',textAlign:'right',maxWidth:110,lineHeight:1.3}}>required · cannot be taken off</div>
                  <div style={{fontSize:'.82rem',fontWeight:600,minWidth:44,textAlign:'right'}}>{fmt(screeningDue)}</div>
                </div>)}
              </div>
            )}
            {/* S650: the discount box is for staff allowed to discount; the server refuses it otherwise. */}
            {!(isOwner || (user?.permissions as any)?.['pos.discount'] === true || (user?.permissions as any)?.['pos.manage_inventory'] === true) ? null
              : noDiscountForStay ? (<div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:10,lineHeight:1.45}}>
                  No discount on a sale with a stay — the stay is charged at the schedule's price. To discount other items, ring them on a sale of their own.
                </div>)
              : appliedDiscount?(<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:'var(--gold-bg)',borderRadius:6,padding:'6px 10px',marginBottom:10,fontSize:'.8rem'}}>
              <span style={{color:'var(--gold)',fontWeight:600}}>discount: {appliedDiscount.name}</span>
              <button onClick={()=>setAppliedDiscount(null)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-3)'}}>x</button>
            </div>):(<div style={{display:'flex',gap:6,marginBottom:10}}>
              <input className="form-input" placeholder="Discount code" value={discountCode} onChange={e=>setDiscountCode(e.target.value)} style={{flex:1,fontSize:'.78rem',padding:'4px 8px'}} />
              <button className="btn btn-primary btn-sm" onClick={applyDiscountCode}>Apply</button>
            </div>)}
            <div style={{fontSize:'.82rem',display:'grid',gap:3,marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Subtotal</span><span>{fmt(subtotal)}</span></div>
              {discountAmt>0&&<div style={{display:'flex',justifyContent:'space-between',color:'var(--green)'}}><span>Discount</span><span>-{fmt(discountAmt)}</span></div>}
              {taxAmount>0&&(Math.abs(namedTaxTotal-taxAmount)<0.01 && cartTaxLines.length
                ? cartTaxLines.map(l=><div key={l.name} style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>{l.name}</span><span>{fmt(l.amount)}</span></div>)
                : <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Tax</span><span>{fmt(taxAmount)}</span></div>)}
              {surcharge>0&&<div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>{(method==='card'||method==='card_on_file') ? 'Card processing fee' : 'Charge account fee (1%)'}</span><span>{fmt(surcharge)}</span></div>}
              <div style={{display:'flex',justifyContent:'space-between',fontWeight:700,fontSize:'.95rem',borderTop:'1px solid var(--border-1)',paddingTop:6,marginTop:2}}>
                <span>Total</span><span style={{color:'var(--gold)'}}>{fmt(total)}</span>
              </div>
            </div>
            {/* S652: what is still out for delivery. The driver opens one and it
                fills the cart — same cart, same tenders, same server path. */}
            {(tickets.data?.length || openTicketId || payLinkId) && (
              <button className="btn btn-ghost btn-sm" style={{width:'100%',marginBottom:8,textAlign:'left'}}
                      onClick={()=>setTicketsOpen(true)}>
                {openTicketId
                  ? 'Settling a ticket · tap to change'
                  : payLinkId
                    ? 'Settling an emailed pay link · tap to change'
                    : `${tickets.data?.length} open ticket${tickets.data?.length === 1 ? '' : 's'} & pay link${tickets.data?.length === 1 ? '' : 's'}`}
              </button>)}
            <div style={{marginBottom:10}}>
              <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:5}}>Payment method</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:5}}>
                {/* S652 (Nic): "if they save a payment method on file as a
                    point of sale customer, we can just auto charge them on
                    delivery and we don't even have to take the reader with us."
                    Same card, same fee — nobody is holding the plastic. */}
                {(['cash','card','card_on_file','charge'] as const).filter(m=>!(LAUNCH_HIDE_CHARGE && m==='charge')).map(m=>(<button key={m} disabled={readerHoldsCharge} onClick={()=>setMethod(m)} style={{opacity:readerHoldsCharge&&method!==m?0.45:1,padding:'7px 0',border:"1px solid "+(method===m?'var(--gold)':'var(--border-1)'),background:method===m?'var(--gold-bg)':'var(--bg-2)',borderRadius:'var(--r-md)',cursor:'pointer',fontSize:'.75rem',fontWeight:method===m?700:400,color:method===m?'var(--gold)':'var(--text-2)'}}>{m==='card_on_file'?'On file':m==='charge'?'Charge':m==='cash'?'Cash':'Card'}</button>))}
              </div>
            </div>
            {method==='cash'&&(<div style={{marginBottom:10}}>
              <input className="form-input" type="number" {...nonNeg} placeholder="Cash given" value={cashGiven} onChange={e=>setCashGiven(e.target.value)} style={{width:'100%'}} />
              {cashBlank
                ? <div style={{fontSize:'.72rem',color:'var(--text-3)',marginTop:4}}>Left blank, it is exact cash — no change due.</div>
                : cashShortBy>0
                  ? <div style={{fontSize:'.82rem',color:'var(--red)',fontWeight:600,marginTop:4}}>Cash given is short by {fmt(cashShortBy)} — take the rest, then press Charge.</div>
                  : <div style={{fontSize:'.82rem',color:'var(--green)',fontWeight:600,marginTop:4}}>{changeDue>0 ? `Change: ${fmt(changeDue)}` : 'No change due'}</div>}
            </div>)}
            {/* S654 (Nic): "it should show their name on the pay screen as
                well." 10/2 (Nic): "type their name, not a scroll down list...
                One flow. If they aren't in the system, I choose add new, from
                that flow." One typed picker for every tender — required only
                where the tender needs a person (a charge account, a card on
                file). Picked, it is a chip; the name leads the reader's breakdown. */}
            <div style={{marginBottom:10,display:'grid',gap:6}}>
              <div style={{fontSize:'.72rem',color:'var(--text-3)'}}>Customer{(method==='charge'||method==='card_on_file')?'':' (optional)'}</div>
              <POSCustomerPicker propertyId={registerProperty} value={person} onChange={setPerson}
                disabled={!registerProperty || readerHoldsCharge}
                placeholder={(method==='charge'||method==='card_on_file') ? 'Type who this is for' : 'Type a name, email or phone'} />
            </div>
            {(method==='charge'||method==='card_on_file')&&(<div style={{marginBottom:10,display:'grid',gap:6}}>
              {method==='charge'&&chargeBlocked&&<div style={{fontSize:'.72rem',color:'var(--red)'}}>Cart has non-charge-eligible items</div>}
              {method==='card_on_file'&&(
                cardOnFile.isFetching
                  ? <div style={{fontSize:'.72rem',color:'var(--text-3)'}}>Checking for a card…</div>
                  : !(tenantId||posCustomerId)
                    ? <div style={{fontSize:'.72rem',color:'var(--text-3)'}}>Pick who this is for.</div>
                    : cardOnFile.data
                      ? <div style={{fontSize:'.75rem',color:'var(--gold)',fontWeight:600}}>
                          Charging {cardOnFile.data.brand ?? 'card'} ••••{cardOnFile.data.last4 ?? '????'}
                        </div>
                      : <div style={{fontSize:'.72rem',color:'var(--amber)',lineHeight:1.5}}>
                          No card on file. Run it on the reader — that saves the card at the same time,
                          so next time this button works.
                        </div>)}
            </div>)}
            {/* S243: card-method property + reader controls. Auto-hidden
                for single-property landlords (auto-picked on load); only
                shows the picker when the landlord owns 2+ properties. */}
            {method==='card'&&(<div style={{marginBottom:10,display:'grid',gap:6}}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={()=>setReaderModal(true)} style={{width:'100%',justifyContent:'space-between',display:'flex'}}>
                <span style={{color:'var(--text-3)'}}>Reader</span>
                <span style={{color:activeReader?'var(--gold)':'var(--text-3)'}}>
                  {activeReader ? (activeReader.type==='smart' ? activeReader.nickname : activeReader.label) : 'Select…'}
                </span>
              </button>
              {/* S654: what the customer is looking at, and the order that keeps it there. */}
              {terminalStatus==='awaiting_tap' && (
                <div style={{display:'grid',gap:6,padding:'8px 10px',border:'1px solid var(--gold)',borderRadius:'var(--r-md)',background:'var(--gold-bg)'}}>
                  <div style={{fontSize:'.78rem',color:'var(--gold)',fontWeight:700,lineHeight:1.45}}>
                    The breakdown is on the reader. Waiting for their tap · {tapSecondsLeft}s
                  </div>
                  <div style={{fontSize:'.72rem',color:'var(--text-2)',lineHeight:1.45}}>
                    The charge goes through when the time is up, with the card they tapped. If nobody taps, the reader then asks for the card.
                  </div>
                  <div style={{display:'flex',gap:6}}>
                    <button type="button" className="btn btn-primary btn-sm" style={{flex:1}} onClick={()=>tapWaiter.current?.('tapped')}>They tapped — finish now</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={()=>tapWaiter.current?.('cancel')}>Cancel</button>
                  </div>
                </div>)}
              {activeReader?.type==='smart' && cart.length>0 && terminalStatus!=='awaiting_tap' && terminalStatus!=='collecting' && terminalStatus!=='capturing' && (
                // 10/3 (review): a stay with no site and dates has no price, so
                // nothing is on the reader yet — say what puts it there.
                readerCartLines.length===0
                  ? <div style={{fontSize:'.72rem',color:'var(--text-3)',lineHeight:1.45}}>
                      Pick the site and dates — the breakdown goes on the reader once the stay is priced.
                    </div>
                  : breakdownIsUp
                  ? <div style={{fontSize:'.75rem',color:'var(--gold)',fontWeight:600,lineHeight:1.45,padding:'6px 8px',border:'1px solid var(--gold)',borderRadius:'var(--r-md)',background:'var(--gold-bg)'}}>
                      The breakdown is on the reader. They can tap any time; Charge gives them {TAP_WINDOW_SECONDS} seconds.
                    </div>
                  : readerCart?.busy && readerCart.sig === liveCartSig
                    ? <div style={{fontSize:'.72rem',color:'var(--amber)',lineHeight:1.45}}>
                        {readerCart.busy==='collect_inputs' ? 'The reader is still asking the last customer a question. It shows this sale when they answer.' : 'The reader is busy with another payment.'}
                      </div>
                    : <div style={{fontSize:'.72rem',color:'var(--text-3)'}}>Putting the breakdown on the reader…</div>)}
              {terminalStatus==='collecting'&&<div style={{fontSize:'.72rem',color:'var(--text-3)'}}>Waiting for customer at reader…</div>}
              {terminalStatus==='capturing'&&<div style={{fontSize:'.72rem',color:'var(--text-3)'}}>Capturing payment…</div>}
              {terminalStatus==='error'&&terminalError&&<div style={{fontSize:'.72rem',color:'var(--red)'}}>{terminalError}</div>}
            </div>)}
            {/* S651: a stay cannot be rung without a site and an arrival date,
                so the button says what it needs instead of failing on submit.
                Once set, the site and dates show above it. */}
            {stayInCart && (stayReady
              ? <>
                  <button className="btn btn-primary btn-sm" style={{width:'100%',marginBottom:6,textAlign:'left'}}
                          onClick={()=>setStayModal(true)}>
                    {stay.extendBookingId ? 'Add a month · ' : ''}{stay.siteLabel} · {stay.checkIn} → {stay.checkOut} · {stay.guestName}
                    {stay.stayTerms ? ` · ${STAY_TERMS_LABEL[stay.stayTerms as StayTerms]}` : ''}
                  </button>
                  {/* 10/5 (Nic, R13): a 30+ night stay with no lease is held only through what is paid. */}
                  {stay.heldWords && <div style={{fontSize:'.7rem',color:'var(--text-3)',marginBottom:6,lineHeight:1.45}}>{stay.heldWords}</div>}
                </>
              : stay ? <div style={{fontSize:'.72rem',color:'var(--amber)',marginBottom:6}}>The nights changed — pick the site again for the new dates.</div>
              : null)}
            <button className="btn btn-primary" style={{width:'100%'}} disabled={
              cart.length===0
              || checkoutMut.isLoading
              || terminalStatus==='awaiting_tap'
              || terminalStatus==='collecting'
              || terminalStatus==='capturing'
              || (method==='charge' && (chargeBlocked || !registerProperty || (!tenantId && !posCustomerId)))
              || (method==='card' && !registerProperty)
              // 10/3: cash given that does not cover the total is not a sale yet.
              || (method==='cash' && cashShortBy > 0)
              // S652: no customer, no card — and a customer with no card saved
              // has to go on the reader, which saves it for next time.
              || (method==='card_on_file' && (!registerProperty || (!tenantId && !posCustomerId) || !cardOnFile.data))
            } onClick={()=>{
              if (stayInCart && !stayReady) { setStayModal(true); return }
              method==='card'?chargeWithReader():checkoutMut.mutate(undefined)
            }}>
              {checkoutMut.isLoading?'Processing...':terminalStatus==='awaiting_tap'?'Waiting for the tap…':terminalStatus==='collecting'?'Awaiting card…':terminalStatus==='capturing'?'Capturing…'
               :stayInCart&&!stayReady?'Pick a site and dates'
               :'Charge '+fmt(total)}
            </button>
            {/* S648 (Nic): "generate an item, a charge and send it to a link so
                they can pay by email." The same cart, paid later by card. */}
            {/* 10/2: a ticket or pay link opened here is already out — a link
                for it too would be a second bill for the same thing. */}
            <button className="btn btn-primary" style={{width:'100%',marginTop:8}}
              disabled={cart.length===0 || !registerProperty || readerHoldsCharge || !!openTicketId || !!payLinkId}
              title={openTicketId || payLinkId ? 'This is already out on the open list — charge it here, or press Clear to put it back.' : undefined}
              onClick={()=>{
                // 10/3 (decisions #9): a stay goes out on a link with its site and
                // dates — held for them, at the same price Charge would take.
                if (stayInCart && !stayReady) { setStayModal(true); return }
                setPayLinkOpen(true)
              }}>
              Email a pay link
            </button>
            {/* S652 (Nic): the propane is pumped here, where the meter is and
                where it has to be zeroed before the next tank — and paid for at
                the customer's door. Nic, on why this is not a pay link: "That's
                product actually out and payment needs to be rendered right then
                instead of chasing somebody down later." */}
            {/* 10/3 (review): a stay is never held for delivery — it needs a
                site and dates and is paid now, or sent on a link that holds
                the site. The button says so instead of failing on the server. */}
            <button className="btn btn-primary" style={{width:'100%',marginTop:8}}
              disabled={cart.length===0 || !registerProperty || (!tenantId && !posCustomerId) || !!openTicketId || !!payLinkId
                        || stayInCart || writeTicketMut.isLoading || readerHoldsCharge}
              title={stayInCart ? 'A stay is charged now or sent on a pay link — it is not held for delivery.' : undefined}
              onClick={()=>writeTicketMut.mutate()}>
              {writeTicketMut.isLoading ? 'Writing it up…' : 'Hold for delivery'}
            </button>
            {cart.length>0 && !openTicketId && !payLinkId && stayInCart &&
              <div style={{fontSize:'.7rem',color:'var(--text-3)',marginTop:4}}>
                A stay is not held for delivery — charge it now, or email a pay link (that holds the site).
              </div>}
            {cart.length>0 && !openTicketId && !payLinkId && !stayInCart && !tenantId && !posCustomerId &&
              <div style={{fontSize:'.7rem',color:'var(--text-3)',marginTop:4}}>
                Pick who it is for to hold it for delivery.
              </div>}
            {payLinkOpen && (
              <SendPayLinkModal
                propertyId={registerProperty}
                cart={cart.map(i => ({ id: i.id.startsWith('open-') ? null : i.id, name: i.name, qty: i.qty, price: i.price, tax: i.tax, cat: i.cat,
                                       // 10/3 (review): the stay's figure as shown — the link never goes out at another.
                                       ...(stayPriced(i) ? { stayTotal: i.stayTotal } : {}) }))}
                stay={stayInCart && stayReady && stay ? { unitId: stay.unitId, checkIn: stay.checkIn, guestName: stay.guestName, guestPhone: stay.guestPhone || null,
                                                          guestEmail: stay.guestEmail || null, stayTerms: stay.stayTerms || null,
                                                          extendBookingId: stay.extendBookingId || null, screeningFee: stay.screeningFee || null,
                                                          screeningLineName: stay.screeningLineName || null, heldWords: stay.heldWords || null,
                                                          returningGuest: stay.returningGuest === true } : null}
                discountAmount={discountAmt}
                total={discountedSubtotal + taxAmount}
                customerPaysFee={!absorbsCardFee}
                onClose={()=>setPayLinkOpen(false)}
                person={person}
                onSent={()=>{ setPayLinkOpen(false); resetRegister('sent_as_pay_link'); qc.invalidateQueries('pos-tickets'); qc.invalidateQueries('stay-availability') }}
              />
            )}
          </div>
        </div>
      )}

      {tab==='paylinks' && <PayLinksTab propertyId={registerProperty} />}

      {tab==='history' && !!registerProperty && (<>
        {historyCustomer && (
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,fontSize:'.8rem'}}>
            <span style={{color:'var(--text-3)'}}>Showing purchases by</span><strong>{historyCustomer.name}</strong>
            <button className="btn btn-ghost btn-sm" onClick={()=>setHistoryCustomer(null)}>Show everyone</button>
          </div>
        )}
        
        <div className="card" style={{padding:0}}>
          {txLoading?<div style={{padding:32,textAlign:'center',color:'var(--text-3)'}}>Loading...</div>:(
            <table className="data-table">
              <thead><tr><th>Date</th><th>Items</th><th>Subtotal</th><th>Total</th><th>Method</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {(txns as any[]).length?(txns as any[]).map((t:any)=>(<Fragment key={t.id}><tr style={{cursor:'pointer'}} onClick={()=>setOpenTx(o=>o===t.id?null:t.id)} title="Click to see what was sold">
                  <td className="mono">{new Date(t.createdAt).toLocaleDateString()}</td>
                  <td style={{color:'var(--text-3)',fontSize:'.82rem'}}>
                    {/* S653 (Nic): "it isn't clickable" — the lines open under the row. */}
                    {(t.items||[]).length===1 ? `${t.items[0].name} ×${Number(t.items[0].qty)}` : `${t.itemCount} items`}
                    <span style={{marginLeft:6,color:'var(--text-3)'}}>{openTx===t.id?'▾':'▸'}</span>
                  </td>
                  <td className="mono">{fmt(t.subtotal)}</td>
                  <td className="mono" style={{fontWeight:600}}>{fmt(t.total)}</td>
                  <td><span className={"badge "+(METHOD_MAP[t.tender||t.paymentMethod]||'badge-muted')}>{TENDER_LABEL[t.tender||t.paymentMethod]||humanize(t.tender||t.paymentMethod)}</span></td>
                  <td><span className={"badge "+(STATUS_MAP[t.status]||'badge-muted')}>{t.status||'completed'}</span></td>
                  {/* S652 (Nic): refund and void are their own permissions
                      (pos.refund / pos.void) — a cashier with Sales history
                      sees the sales, not the buttons. The API refuses either
                      without the permission; the page simply doesn't offer them. */}
                  {/* 10/3 (review): Void only where it goes through — never on
                      a card sale (the card was charged: Refund) or a sale that
                      paid a stay or a pay link (Refund; cancel the stay on the
                      schedule). It asks first, in the app. */}
                  <td>{t.status==='completed'&&(canRefund||(canVoid&&!t.voidBlocked))&&(<div style={{display:'flex',gap:6}}>
                    {canRefund&&<button className="btn btn-ghost btn-sm" onClick={e=>{e.stopPropagation(); setRefundModal({show:true,tx:t})}}>Refund</button>}
                    {canVoid&&!t.voidBlocked&&<button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={e=>{e.stopPropagation(); setVoidAsk(t)}}>Void</button>}
                  </div>)}
                  {t.status==='refunded'&&<span style={{fontSize:'.75rem',color:'var(--text-3)'}}>-{fmt(t.refundAmount)}</span>}
                  </td>
                </tr>
                {openTx===t.id&&(<tr><td colSpan={7} style={{background:'var(--bg-2)',padding:'8px 16px 12px'}}>
                  <div style={{display:'grid',gap:4,fontSize:'.8rem'}}>
                    {(t.items||[]).map((it:any,i:number)=>(<div key={i} style={{display:'flex',justifyContent:'space-between',gap:12}}>
                      <span>{it.name} <span style={{color:'var(--text-3)'}}>×{Number(it.qty)} @ {fmt(it.price)}</span></span>
                      <span className="mono">{fmt(it.subtotal)}</span>
                    </div>))}
                    {Number(t.discountAmount)>0&&<div style={{display:'flex',justifyContent:'space-between',color:'var(--text-3)'}}><span>Discount{t.discountReason?` — ${t.discountReason}`:''}</span><span className="mono">-{fmt(t.discountAmount)}</span></div>}
                    {Number(t.taxAmount)>0&&<div style={{display:'flex',justifyContent:'space-between',color:'var(--text-3)'}}><span>Tax</span><span className="mono">{fmt(t.taxAmount)}</span></div>}
                    {Number(t.surcharge)>0&&<div style={{display:'flex',justifyContent:'space-between',color:'var(--text-3)'}}><span>Card fee</span><span className="mono">{fmt(t.surcharge)}</span></div>}
                    <div style={{display:'flex',justifyContent:'space-between',color:'var(--text-3)'}}>
                      <span>{TENDER_LABEL[t.tender||t.paymentMethod]||humanize(t.paymentMethod)}{t.tenantName?` · ${t.tenantName}`:t.customerName?` · ${t.customerName}`:''} · {new Date(t.createdAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</span>
                      <span className="mono" style={{fontWeight:700,color:'var(--text-0)'}}>{fmt(t.total)}</span>
                    </div>
                    {/* S654 (Nic): fix who a sale belongs to; resend its receipt.
                        10/2: typed and picked — linking fills in the card's other sales. */}
                    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginTop:8,paddingTop:8,borderTop:'1px solid var(--border-1)'}}>
                      {(() => { const te = txEdit && txEdit.id===t.id ? txEdit : null
                      if (te && te.mode==='receipt') { const cur = te; return (<>
                        <input className="form-input" type="email" placeholder="name@example.com" value={cur.value} onChange={e=>{ const v=e.target.value; setTxEdit(prev=>prev?{ ...prev, value:v }:prev) }} style={{minWidth:220}} />
                        <button className="btn btn-primary btn-sm" disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cur.value.trim())||txReceiptMut.isLoading} onClick={()=>txReceiptMut.mutate({ id:t.id, email:cur.value })}>{txReceiptMut.isLoading?'Sending…':'Send receipt'}</button>
                        <button className="btn btn-ghost btn-sm" onClick={()=>setTxEdit(null)}>Cancel</button>
                      </>) }
                      return (<>
                        <div style={{flex:'1 1 320px',minWidth:0}}>
                          <SaleCustomerLink key={`${t.id}:${t.posCustomerId ?? ''}:${t.tenantId ?? ''}`} saleId={t.id} propertyId={registerProperty}
                            current={personOfSale(t)}
                            onLinked={()=>{ qc.invalidateQueries('pos-transactions'); qc.invalidateQueries('pos-customer-base') }} />
                        </div>
                        <button className="btn btn-ghost btn-sm" onClick={()=>setTxEdit({ id:t.id, mode:'receipt', value: t.customerEmail||'' })}>Email receipt</button>
                      </>) })()}
                    </div>
                  </div>
                </td></tr>)}
                </Fragment>)):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No transactions yet.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </>)}

      {tab==='items' && !!registerProperty && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header" style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
              <span className="card-title">Add Item</span>
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>Default margin %</span>
                <input className="form-input" type="number" {...nonNeg} style={{width:80}} value={marginEdit}
                  placeholder={defaultMarginPct!=null?String(defaultMarginPct):'none'}
                  onChange={e=>setMarginEdit(e.target.value)} />
                <button className="btn btn-ghost btn-sm" disabled={saveMarginMut.isLoading}
                  onClick={()=>saveMarginMut.mutate(marginEdit)}>Save</button>
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" value={newItem.name} onChange={e=>setNewItem(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Category</div><select className="form-select" value={newItem.categoryId} onChange={e=>setNewItem(s=>({...s,categoryId:e.target.value}))} style={{width:'100%'}}>{categoriesForProperty(registerProperty).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Cost Price</div><input className="form-input" type="number" {...nonNeg} value={newItem.costPrice} onChange={e=>setItemCost(e.target.value)} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Margin %{defaultMarginPct!=null?` (default ${defaultMarginPct})`:''}</div><input className="form-input" type="number" {...nonNeg} value={newItem.marginPct} onChange={e=>setItemMargin(e.target.value)} placeholder={defaultMarginPct!=null?String(defaultMarginPct):'—'} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Sell Price{newItem.costPrice&&newItem.marginPct?' (auto)':''}</div><input className="form-input" type="number" {...nonNeg} value={newItem.sellPrice} onChange={e=>setItemSell(e.target.value)} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Tax</div><div style={{fontSize:'.75rem',color:'var(--text-3)',paddingTop:8}}>Taxes on the item's category apply automatically. Tick single-item taxes in Edit after saving.</div></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Qty</div><input className="form-input" type="number" {...nonNeg} value={newItem.stockQty} onChange={e=>setNewItem(s=>({...s,stockQty:e.target.value}))} style={{width:'100%'}} /></div>
              {!LAUNCH_HIDE_CHARGE && <div style={{display:'flex',alignItems:'center',gap:8,paddingTop:20}}><input type="checkbox" id="ce" checked={newItem.chargeEligible} onChange={e=>setNewItem(s=>({...s,chargeEligible:e.target.checked}))} /><label htmlFor="ce" style={{fontSize:'.82rem'}}>Charge eligible</label></div>}
              {/* S192: property selector. Empty = company-wide. */}
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={submitNewItem} disabled={!newItem.name||!newItem.sellPrice||!newItem.categoryId||!registerProperty||createItemMut.isLoading}>{createItemMut.isLoading?'Adding…':'Add Item'}</button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleItemSort('name')}>Item {itemSort.key==='name'?(itemSort.dir==='asc'?'▲':'▼'):''}</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleItemSort('category')}>Category {itemSort.key==='category'?(itemSort.dir==='asc'?'▲':'▼'):''}</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleItemSort('property')}>Property {itemSort.key==='property'?(itemSort.dir==='asc'?'▲':'▼'):''}</th>
                <th>Cost</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleItemSort('price')}>Price {itemSort.key==='price'?(itemSort.dir==='asc'?'▲':'▼'):''}</th>
                <th>Tax</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleItemSort('stock')}>Stock {itemSort.key==='stock'?(itemSort.dir==='asc'?'▲':'▼'):''}</th>
                {!LAUNCH_HIDE_CHARGE && <th>Charge</th>}
                <th>Active</th>
                <th></th>
              </tr></thead>
              <tbody>
                {(items as any[])
                  .sort((a:any,b:any)=>{
                    const propLabel=(i:any)=>{ const p=i.propertyId?(properties as any[]).find((x:any)=>x.id===i.propertyId):null; return p?(p.street1||p.name||''):(posSettings?.businessName||'') }
                    let av:any, bv:any
                    if(itemSort.key==='name'){av=a.name||'';bv=b.name||''}
                    else if(itemSort.key==='category'){av=a.category||'';bv=b.category||''}
                    else if(itemSort.key==='property'){av=propLabel(a);bv=propLabel(b)}
                    else if(itemSort.key==='price'){av=Number(a.sellPrice)||0;bv=Number(b.sellPrice)||0}
                    else {av=Number(a.stockQty)||0;bv=Number(b.stockQty)||0}
                    const cmp = (typeof av==='number'&&typeof bv==='number') ? (av-bv) : String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})
                    return itemSort.dir==='asc'?cmp:-cmp
                  })
                  .map((item:any)=>{
                  const iprop = item.propertyId ? (properties as any[]).find((p:any)=>p.id===item.propertyId) : null
                  const ipropAddr = iprop ? (iprop.street1 || iprop.name || '(unknown)') : null
                  return (<tr key={item.id}>
                  <td style={{fontWeight:500}}>{item.name}</td>
                  <td><span className="badge badge-muted">{item.category}</span></td>
                  <td>{ipropAddr
                    ? <span style={{color:'var(--gold)',fontWeight:500,fontSize:'.78rem'}}>{ipropAddr}</span>
                    : <span style={{color:'var(--text-3)',fontSize:'.78rem'}}>{posSettings?.businessName || 'Company-wide'}</span>
                  }</td>
                  <td className="mono">{fmt(item.costPrice)}</td>
                  <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{fmt(item.sellPrice)}</td>
                  <td className="mono">{pct(item.taxRate)}</td>
                  <td className="mono">{item.stockQty>=999?'inf':item.stockQty}</td>
                  {!LAUNCH_HIDE_CHARGE && <td><button onClick={()=>toggleChargeMut.mutate({id:item.id,val:!item.chargeEligible})} style={{background:item.chargeEligible?'var(--gold-bg)':'var(--bg-3)',border:"1px solid "+(item.chargeEligible?'var(--gold)':'var(--border-1)'),borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:item.chargeEligible?'var(--gold)':'var(--text-3)'}}>{item.chargeEligible?'Yes':'No'}</button></td>}
                  <td><button onClick={()=>toggleActiveMut.mutate({id:item.id,val:!item.isActive})} style={{background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:item.isActive?'var(--green)':'var(--text-3)'}}>{item.isActive?'Active':'Off'}</button></td>
                  <td><button className="btn btn-ghost btn-sm" onClick={()=>setEditItem({...item,_sell:String(item.sellPrice),_cost:String(item.costPrice),_stock:String(item.stockQty),_min:String(item.stockMin),_max:String(item.stockMax)})}>Edit</button></td>
                </tr>)})}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='categories' && !!registerProperty && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Category</span></div>
            <div style={{display:'grid',gridTemplateColumns:'80px 1fr auto',gap:12,marginTop:12,alignItems:'end'}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name *</div><input className="form-input" placeholder="Snacks" value={newCategory.name} onChange={e=>setNewCategory(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <button className="btn btn-primary" onClick={()=>createCategoryMut.mutate()} disabled={!newCategory.name||createCategoryMut.isLoading}>{createCategoryMut.isLoading?'Adding...':'Add'}</button>
            </div>
            {/* Property scope — opens a popup picker (clearer than inline).
                "All properties" (empty) = company-wide; else the chosen subset. */}
            <div style={{marginTop:12}}>
              <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:6}}>Available at</div>
              <button type="button" className="form-select" onClick={()=>setShowCatPropPicker(true)}
                style={{width:'100%',textAlign:'left',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span>{newCategory.propertyIds.length===0
                  ? 'All properties'
                  : newCategory.propertyIds.length===1
                    ? ((properties as any[]).find((p:any)=>p.id===newCategory.propertyIds[0])?.name || '1 property')
                    : `${newCategory.propertyIds.length} properties`}</span>
                <span style={{color:'var(--text-3)'}}>▾</span>
              </button>
            </div>
            <div style={{fontSize:'.72rem',color:'var(--text-3)',marginTop:8}}>
              Categories appear in the Add/Edit Item dropdown and the tax-rate Applies-To dropdown. Click the Name or Property column header below to sort. Inactive categories stay attached to existing items but won't appear in dropdowns.
            </div>
          </div>
          {/* S220: list filter mirrors the items + tax-rates property filters. */}
          <div style={{display:'flex',alignItems:'center',gap:8,padding:'4px 4px 0'}}>
            <label style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:0}}>Filter by property:</label>
            <select className="form-select" value={filterCategoryProperty} onChange={e=>setFilterCategoryProperty(e.target.value)} style={{width:'auto',padding:'4px 10px',fontSize:'.82rem'}}>
              <option value="all">All ({(posCategoriesAll as any[]).length})</option>
              <option value="company-wide">Company-wide ({(posCategoriesAll as any[]).filter((c:any)=>!c.propertyIds?.length).length})</option>
              {(properties as any[]).map((p:any)=>{
                const n = (posCategoriesAll as any[]).filter((c:any)=>!c.propertyIds?.length || c.propertyIds.includes(p.id)).length
                return <option key={p.id} value={p.id}>{p.name} ({n})</option>
              })}
            </select>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleCatSort('name')}>Name {catSort.key==='name' ? (catSort.dir==='asc'?'▲':'▼') : ''}</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleCatSort('property')}>Property {catSort.key==='property' ? (catSort.dir==='asc'?'▲':'▼') : ''}</th>
                <th style={{width:80}}>Items</th>
                <th style={{width:90}}>Status</th>
                <th style={{width:80}}></th>
              </tr></thead>
              <tbody>
                {(() => {
                  const filtered = (posCategoriesAll as any[]).filter((c:any) => {
                    if (filterCategoryProperty === 'all') return true
                    const ids = c.propertyIds as string[] | null | undefined
                    if (filterCategoryProperty === 'company-wide') return !ids || ids.length === 0
                    // A specific property shows categories available there:
                    // company-wide ones plus any scoped to include it.
                    return !ids || ids.length === 0 || ids.includes(filterCategoryProperty)
                  })
                  // Scope label for the Property column + sort. Company-wide →
                  // business name; one property → its address; many → "N properties".
                  const catScopeLabel = (c:any): { text: string; scoped: boolean } => {
                    const ids = c.propertyIds as string[] | null | undefined
                    if (!ids || ids.length === 0) return { text: posSettings?.businessName || 'Company-wide', scoped: false }
                    if (ids.length === 1) { const p = (properties as any[]).find((x:any)=>x.id===ids[0]); return { text: p ? (p.street1||p.name||'(unknown)') : '(unknown)', scoped: true } }
                    return { text: `${ids.length} properties`, scoped: true }
                  }
                  const sorted = [...filtered].sort((a:any,b:any) => {
                    const av = catSort.key==='name' ? (a.name||'') : catScopeLabel(a).text
                    const bv = catSort.key==='name' ? (b.name||'') : catScopeLabel(b).text
                    const cmp = String(av).localeCompare(String(bv), undefined, { numeric:true, sensitivity:'base' })
                    return catSort.dir==='asc' ? cmp : -cmp
                  })
                  return sorted.length ? sorted.map((c:any) => {
                    const itemCount = (items as any[]).filter((i:any) => i.categoryId === c.id).length
                    // Property column shows where the category is available:
                    // company-wide → business name; else the address (1) or count.
                    const scope = catScopeLabel(c)
                    return (<tr key={c.id}>
                      <td style={{fontWeight:500}}>{c.name}</td>
                      <td><span style={{color:scope.scoped?'var(--gold)':'var(--text-3)',fontWeight:scope.scoped?500:400,fontSize:'.78rem'}}>{scope.text}</span></td>
                      <td className="mono" style={{color:'var(--text-3)'}}>{itemCount}</td>
                      <td><button onClick={()=>toggleCategoryActiveMut.mutate({id:c.id,val:!c.isActive})} style={{background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:c.isActive?'var(--green)':'var(--text-3)'}}>{c.isActive?'Active':'Off'}</button></td>
                      <td><button className="btn btn-ghost btn-sm" onClick={()=>setEditCategory({...c, _name:c.name, _icon:c.icon||'📦', _sort:String(c.sortOrder ?? 0), _propertyIds: Array.isArray(c.propertyIds) ? c.propertyIds : []})}>Edit</button></td>
                    </tr>)
                  }) : <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>{(posCategoriesAll as any[]).length ? 'No categories at this property scope.' : 'Loading…'}</td></tr>
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='taxes' && !!registerProperty && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Taxes</span></div>
            <div style={{fontSize:'.75rem',color:'var(--text-3)',margin:'4px 0 12px'}}>Make a tax once, then choose what it applies to: everything, whole categories, or single items. Its name is what the receipt shows.</div>
            <table className="data-table">
              <thead><tr><th>Name</th><th style={{width:90}}>Rate</th><th>Applies to</th><th style={{width:150}}></th></tr></thead>
              <tbody>
                {propertyTaxes.length ? propertyTaxes.map((t:any)=>{
                  const cats = categoriesForProperty(registerProperty).filter(c=>(t.categoryIds||[]).includes(c.id)).map(c=>c.name)
                  const legacy = Array.isArray(t.appliesTo) ? t.appliesTo.filter((x:string)=>String(x).toLowerCase()!=='all') : []
                  const its = (items as any[]).filter((i:any)=>i.propertyId===registerProperty).filter((i:any)=>(t.itemIds||[]).includes(i.id)).map((i:any)=>i.name)
                  const reach = taxAppliesToAll(t) ? 'Everything' : [...cats, ...legacy].map(n=>`${n} (category)`).concat(its).join(', ') || 'Nothing yet'
                  return (<tr key={t.id}>
                    <td style={{fontWeight:500}}>{t.name}</td>
                    <td className="mono">{pct(t.rate)}</td>
                    <td style={{fontSize:'.82rem'}}>{reach}</td>
                    <td style={{textAlign:'right',whiteSpace:'nowrap'}}>
                      <button className="btn btn-ghost btn-sm" onClick={()=>setTaxDraft({ id:t.id, name:t.name, ratePct:String(+(Number(t.rate)*100).toFixed(4)), all:taxAppliesToAll(t), categoryIds:t.categoryIds||[], itemIds:t.itemIds||[] })}>Edit</button>
                      <button className="btn btn-ghost btn-sm" onClick={()=>deleteTaxMut.mutate(t.id)}>Remove</button>
                    </td>
                  </tr>)
                }) : <tr><td colSpan={4} style={{textAlign:'center',color:'var(--text-3)',padding:24}}>No taxes yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">{taxDraft.id ? 'Edit tax' : 'Add a tax'}</span></div>
            <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name (printed on the receipt)</div><input className="form-input" placeholder="Lodging tax" value={taxDraft.name} onChange={e=>setTaxDraft(d=>({...d,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Rate %</div><input className="form-input" type="number" {...nonNeg} step="0.01" placeholder="6.35" value={taxDraft.ratePct} onChange={e=>setTaxDraft(d=>({...d,ratePct:e.target.value}))} style={{width:'100%'}} /></div>
            </div>
            <div style={{marginTop:12,display:'flex',gap:16,fontSize:'.85rem'}}>
              <label style={{display:'flex',gap:6,alignItems:'center'}}><input type="radio" checked={taxDraft.all} onChange={()=>setTaxDraft(d=>({...d,all:true}))} /> Everything sold here</label>
              <label style={{display:'flex',gap:6,alignItems:'center'}}><input type="radio" checked={!taxDraft.all} onChange={()=>setTaxDraft(d=>({...d,all:false}))} /> Only what I choose</label>
            </div>
            {!taxDraft.all && (
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginTop:12}}>
                <div>
                  <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:6}}>Whole categories</div>
                  {categoriesForProperty(registerProperty).map(c=>(
                    <label key={c.id} style={{display:'flex',gap:8,alignItems:'center',fontSize:'.82rem',marginBottom:4}}>
                      <input type="checkbox" checked={taxDraft.categoryIds.includes(c.id)} onChange={e=>setTaxDraft(d=>({...d,categoryIds:e.target.checked?[...d.categoryIds,c.id]:d.categoryIds.filter(x=>x!==c.id)}))} />
                      {c.icon} {c.name}
                    </label>))}
                </div>
                <div>
                  <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:6}}>Single items</div>
                  {(items as any[]).filter((i:any)=>i.propertyId===registerProperty).map((i:any)=>(
                    <label key={i.id} style={{display:'flex',gap:8,alignItems:'center',fontSize:'.82rem',marginBottom:4}}>
                      <input type="checkbox" checked={taxDraft.itemIds.includes(i.id)} onChange={e=>setTaxDraft(d=>({...d,itemIds:e.target.checked?[...d.itemIds,i.id]:d.itemIds.filter(x=>x!==i.id)}))} />
                      {i.name} <span style={{color:'var(--text-3)',fontSize:'.72rem'}}>{i.category}</span>
                    </label>))}
                </div>
              </div>
            )}
            <div style={{display:'flex',gap:8,marginTop:14}}>
              <button className="btn btn-primary" onClick={()=>saveTaxMut.mutate()} disabled={!taxDraft.name.trim()||taxDraft.ratePct===''||saveTaxMut.isLoading}>{saveTaxMut.isLoading?'Saving…':taxDraft.id?'Save tax':'Add tax'}</button>
              {taxDraft.id && <button className="btn btn-ghost" onClick={()=>setTaxDraft(blankTax)}>Cancel</button>}
            </div>
          </div>
        </div>
      )}

      {tab==='discounts' && !!registerProperty && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Discount</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" placeholder="Senior Discount" value={newDiscount.name} onChange={e=>setNewDiscount(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Type</div><select className="form-select" value={newDiscount.type} onChange={e=>setNewDiscount(s=>({...s,type:e.target.value}))} style={{width:'100%'}}><option value="percent">Percent %</option><option value="fixed">Fixed $</option></select></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Value</div><input className="form-input" type="number" {...nonNeg} value={newDiscount.value} onChange={e=>setNewDiscount(s=>({...s,value:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Code (optional)</div><input className="form-input" placeholder="SENIOR10" value={newDiscount.code} onChange={e=>setNewDiscount(s=>({...s,code:e.target.value}))} style={{width:'100%'}} /></div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>createDiscountMut.mutate()} disabled={!newDiscount.name||!newDiscount.value}>Add Discount</button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Code</th><th></th></tr></thead>
              <tbody>
                {(discounts as any[]).length?(discounts as any[]).map((d:any)=>(<tr key={d.id}>
                  <td style={{fontWeight:500}}>{d.name}</td><td><span className="badge badge-muted">{humanize(d.type)}</span></td>
                  <td className="mono">{d.type==='percent'?d.value+"%":fmt(d.value)}</td>
                  <td className="mono" style={{color:'var(--gold)'}}>{d.code||'—'}</td>
                  <td><button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={()=>deleteDiscountMut.mutate(d.id)}>Remove</button></td>
                </tr>)):<tr><td colSpan={5} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No discounts configured.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='customers' && !!registerProperty && (() => {
        const q = custSearch.trim().toLowerCase()
        const rows = (customersBase as any[]).filter((c:any) => !q || [c.firstName, c.lastName, c.email, c.phone, ...(c.cards||[]).map((k:any)=>k.last4)].filter(Boolean).join(' ').toLowerCase().includes(q))
        return (
        <div className="card" style={{padding:0}}>
          <div className="card-header" style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
            <span className="card-title">Customers <span style={{fontWeight:400,color:'var(--text-3)',fontSize:'.8rem'}}>· {rows.length}</span></span>
            <input className="form-input" placeholder="Search name, email, phone, last four" value={custSearch} onChange={e=>setCustSearch(e.target.value)} style={{maxWidth:300}} />
          </div>
          {custLoading ? <div style={{padding:24,color:'var(--text-3)'}}>Loading…</div> : rows.length===0 ? (
            <div style={{padding:32,textAlign:'center',color:'var(--text-3)'}}>No customers yet — a card tapped on the reader adds one, and typing a name in the register's Customer box and choosing "Add new customer" adds anyone else.</div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Customer</th><th>Email</th><th>Phone</th><th>Cards</th><th style={{textAlign:'right'}}>Purchases</th><th>Last</th><th style={{textAlign:'right'}}>Spent</th></tr></thead>
              <tbody>{rows.map((c:any) => (<Fragment key={c.id}>
                <tr onClick={()=>setOpenCust(openCust===c.id?null:c.id)} style={{cursor:'pointer'}}>
                  <td style={{fontWeight:500}}>{c.firstName} {c.lastName}
                    {(c.duplicateIds||[]).length>0 && <span style={{marginLeft:8,fontSize:'.68rem',color:'var(--amber, #d0a02a)',fontWeight:600}}>possible duplicate</span>}
                    {c.isResident && <span style={{marginLeft:8,fontSize:'.68rem',color:'var(--gold)',fontWeight:600}}>resident</span>}
                    {c.createdFrom==='card_reader' && !c.isResident && <span style={{marginLeft:8,fontSize:'.68rem',color:'var(--text-3)'}}>from a card</span>}
                  </td>
                  <td style={{fontSize:'.82rem'}}>{c.email||'—'}</td>
                  <td style={{fontSize:'.82rem'}}>{c.phone||'—'}</td>
                  <td style={{fontSize:'.8rem'}}>{(c.cards||[]).length ? c.cards.map((k:any,i:number)=><span key={i} style={{marginRight:8}}>{humanize(k.brand||'card')} ····{k.last4}{k.saved?<span style={{color:'var(--gold)'}}> on file</span>:null}</span>) : '—'}</td>
                  <td className="mono" style={{textAlign:'right'}}>{c.purchases}</td>
                  <td style={{fontSize:'.82rem'}}>{c.lastPurchaseAt?new Date(c.lastPurchaseAt).toLocaleDateString():'—'}</td>
                  <td className="mono" style={{textAlign:'right'}}>{fmt(Number(c.totalSpent||0))}</td>
                </tr>
                {openCust===c.id && (<tr><td colSpan={7} style={{background:'var(--bg-2)',padding:'10px 16px 14px'}}>
                  <CustomerEditor c={c} all={customersBase as any[]}
                    onHistory={()=>{ setHistoryCustomer({ id:c.id, name:`${c.firstName} ${c.lastName}`.trim() }); setTab('history') }}
                    onChanged={()=>{ setOpenCust(null) }} />
                </td></tr>)}
              </Fragment>))}</tbody>
            </table>
          )}
        </div>)
      })()}
      {tab==='vendors' && !!registerProperty && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Vendor</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name *</div><input className="form-input" style={{width:'100%'}} placeholder="Acme Supply Co." value={newVendor.name} onChange={e=>setNewVendor(s=>({...s,name:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Contact Name</div><input className="form-input" style={{width:'100%'}} placeholder="Jane Smith" value={newVendor.contactName} onChange={e=>setNewVendor(s=>({...s,contactName:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Email</div><input className="form-input" style={{width:'100%'}} placeholder="orders@vendor.com" value={newVendor.email} onChange={e=>setNewVendor(s=>({...s,email:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Phone</div><input className="form-input" style={{width:'100%'}} placeholder="(555) 000-0000" value={newVendor.phone} onChange={e=>setNewVendor(s=>({...s,phone:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Address</div><input className="form-input" style={{width:'100%'}} placeholder="123 Main St" value={newVendor.address} onChange={e=>setNewVendor(s=>({...s,address:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Lead Time (days)</div><input className="form-input" type="number" {...nonNeg} style={{width:'100%'}} value={newVendor.leadTimeDays} onChange={e=>setNewVendor(s=>({...s,leadTimeDays:e.target.value}))} /></div>
              <div style={{gridColumn:'1/-1'}}><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Notes</div><input className="form-input" style={{width:'100%'}} placeholder="Optional notes" value={newVendor.notes} onChange={e=>setNewVendor(s=>({...s,notes:e.target.value}))} /></div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>createVendorMut.mutate()} disabled={!newVendor.name||createVendorMut.isLoading}>Add Vendor</button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>Contact</th><th>Email</th><th>Phone</th><th>Lead Time</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {(vendors as any[]).length?(vendors as any[]).map((v:any)=>(<tr key={v.id}>
                  <td style={{fontWeight:600}}>{v.name}</td>
                  <td>{v.contactName||'—'}</td>
                  <td style={{fontSize:'.82rem'}}>{v.email||'—'}</td>
                  <td style={{fontSize:'.82rem'}}>{v.phone||'—'}</td>
                  <td className="mono">{v.leadTimeDays}d</td>
                  <td><span className={"badge "+(v.isActive?'badge-green':'badge-red')}>{v.isActive?'active':'inactive'}</span></td>
                  <td><button className="btn btn-ghost btn-sm" onClick={()=>setEditVendor({...v})}>Edit</button></td>
                </tr>)):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No vendors yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='orders' && !!registerProperty && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">New Purchase Order</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Vendor *</div>
                <select className="form-select" style={{width:'100%'}} value={newPO.vendorId} onChange={e=>setNewPO(s=>({...s,vendorId:e.target.value}))}>
                  <option value="">Select vendor...</option>
                  {(vendors as any[]).map((v:any)=><option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Expected Date</div><input className="form-input" type="date" style={{width:'100%'}} value={newPO.expectedDate} onChange={e=>setNewPO(s=>({...s,expectedDate:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Notes</div><input className="form-input" style={{width:'100%'}} value={newPO.notes} onChange={e=>setNewPO(s=>({...s,notes:e.target.value}))} /></div>
            </div>
            <div style={{marginTop:16,borderTop:'1px solid var(--border-1)',paddingTop:16}}>
              <div style={{fontSize:'.82rem',fontWeight:600,marginBottom:8}}>Line Items</div>
              <div style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr auto',gap:8,alignItems:'end',marginBottom:8}}>
                <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:3}}>Item</div>
                  <select className="form-select" style={{width:'100%'}} value={poItemRow.itemId} onChange={e=>{const it=(items as any[]).find((x:any)=>x.id===e.target.value);setPoItemRow(s=>({...s,itemId:e.target.value,unitCost:it?String(it.costPrice):s.unitCost}))}}>
                    <option value="">Select item...</option>
                    {(items as any[]).map((i:any)=><option key={i.id} value={i.id}>{i.name}</option>)}
                  </select>
                </div>
                <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:3}}>Qty</div><input className="form-input" type="number" {...nonNeg} style={{width:'100%'}} value={poItemRow.qtyOrdered} onChange={e=>setPoItemRow(s=>({...s,qtyOrdered:e.target.value}))} /></div>
                <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:3}}>Unit Cost</div><input className="form-input" type="number" {...nonNeg} style={{width:'100%'}} value={poItemRow.unitCost} onChange={e=>setPoItemRow(s=>({...s,unitCost:e.target.value}))} /></div>
                <button className="btn btn-ghost" style={{height:36}} onClick={()=>{
                  const it=(items as any[]).find((x:any)=>x.id===poItemRow.itemId)
                  setPoItems(p=>[...p,{itemId:poItemRow.itemId,itemName:it?.name||'Custom Item',qtyOrdered:Number(poItemRow.qtyOrdered)||1,unitCost:Number(poItemRow.unitCost)||0}])
                  setPoItemRow({itemId:'',qtyOrdered:'1',unitCost:''})
                }}>+ Add</button>
              </div>
              {poItems.length>0&&(<div style={{background:'var(--bg-2)',borderRadius:8,padding:12,marginBottom:12}}>
                {poItems.map((pi,idx)=>(<div key={idx} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'4px 0',fontSize:'.82rem'}}>
                  <span>{pi.itemName} x {pi.qtyOrdered}</span>
                  <div style={{display:'flex',gap:12,alignItems:'center'}}>
                    <span className="mono">{fmt(pi.unitCost*pi.qtyOrdered)}</span>
                    <button onClick={()=>setPoItems(p=>p.filter((_,i)=>i!==idx))} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-3)'}}>x</button>
                  </div>
                </div>))}
                <div style={{display:'flex',justifyContent:'space-between',fontWeight:700,borderTop:'1px solid var(--border-1)',marginTop:8,paddingTop:8,fontSize:'.85rem'}}>
                  <span>Total</span><span style={{color:'var(--gold)'}}>{fmt(poItems.reduce((s,i)=>s+i.unitCost*i.qtyOrdered,0))}</span>
                </div>
              </div>)}
            </div>
            <button className="btn btn-primary" onClick={()=>createPOMut.mutate()} disabled={!newPO.vendorId||poItems.length===0||createPOMut.isLoading}>
              {createPOMut.isLoading?'Creating...':'Create Purchase Order'}
            </button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>PO #</th><th>Vendor</th><th>Items</th><th>Total</th><th>Status</th><th>Expected</th><th>Actions</th></tr></thead>
              <tbody>
                {(purchaseOrders as any[]).length?(purchaseOrders as any[]).map((po:any)=>(<>
                  <tr key={po.id} style={{cursor:'pointer'}} onClick={()=>setExpandedPO(expandedPO===po.id?null:po.id)}>
                    <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{po.poNumber}</td>
                    <td style={{fontWeight:500}}>{po.vendorName}</td>
                    <td className="mono">{po.itemCount}</td>
                    <td className="mono">{fmt(po.subtotal)}</td>
                    <td><span className={"badge "+(po.status==='received'?'badge-green':po.status==='draft'?'badge-muted':po.status==='sent'?'badge-blue':'badge-amber')}>{humanize(po.status)}</span></td>
                    <td style={{fontSize:'.82rem',color:'var(--text-3)'}}>{po.expectedDate?new Date(po.expectedDate).toLocaleDateString():'—'}</td>
                    <td><div style={{display:'flex',gap:6}} onClick={e=>e.stopPropagation()}>
                      {po.status==='draft'&&<button className="btn btn-ghost btn-sm" onClick={()=>updatePOMut.mutate({id:po.id,status:'sent'})}>Mark Sent</button>}
                      {po.status==='sent'&&<button className="btn btn-ghost btn-sm" style={{color:'var(--green)'}} onClick={()=>updatePOMut.mutate({id:po.id,status:'received'})}>Receive</button>}
                    </div></td>
                  </tr>
                  {expandedPO===po.id&&po.items&&(<tr key={po.id+'-exp'}>
                    <td colSpan={7} style={{background:'var(--bg-2)',padding:'8px 16px'}}>
                      <table style={{width:'100%',fontSize:'.8rem'}}>
                        <thead><tr style={{color:'var(--text-3)'}}><th style={{textAlign:'left',padding:'2px 8px'}}>Item</th><th style={{textAlign:'right',padding:'2px 8px'}}>Qty</th><th style={{textAlign:'right',padding:'2px 8px'}}>Unit Cost</th><th style={{textAlign:'right',padding:'2px 8px'}}>Total</th></tr></thead>
                        <tbody>{po.items.map((li:any)=>(<tr key={li.id}><td style={{padding:'2px 8px'}}>{li.itemName}</td><td className="mono" style={{textAlign:'right',padding:'2px 8px'}}>{li.qtyOrdered}</td><td className="mono" style={{textAlign:'right',padding:'2px 8px'}}>{fmt(li.unitCost)}</td><td className="mono" style={{textAlign:'right',padding:'2px 8px'}}>{fmt(li.subtotal)}</td></tr>))}</tbody>
                      </table>
                    </td>
                  </tr>)}
                </>)):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No purchase orders yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='inventory' && !!registerProperty && (
        <div style={{display:'grid',gap:16}}>
          {(lowStock as any[]).length>0&&(<div className="card" style={{borderColor:'var(--amber)'}}>
            <div className="card-header"><span className="card-title" style={{color:'var(--amber)'}}>Low Stock ({(lowStock as any[]).length} items)</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:10,marginTop:12}}>
              {(lowStock as any[]).map((item:any)=>(<div key={item.id} style={{background:'var(--bg-1)',borderRadius:8,padding:'10px 14px',border:'1px solid var(--border-1)'}}>
                <div style={{fontWeight:600,fontSize:'.85rem'}}>{item.name}</div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginTop:2}}>{item.vendorName||'No vendor linked'}</div>
                <div style={{marginTop:6,display:'flex',justifyContent:'space-between'}}>
                  <span style={{color:'var(--amber)',fontWeight:700}}>{item.stockQty} left</span>
                  <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>min {item.stockMin}</span>
                </div>
              </div>))}
            </div>
          </div>)}
          <div className="card" style={{padding:0}}>
            <div className="card-header" style={{padding:'16px 20px'}}><span className="card-title">Stock Overview</span></div>
            <table className="data-table">
              <thead><tr><th>Item</th><th>Category</th><th>In Stock</th><th>Min</th><th>Max</th><th>Status</th><th>Adjust</th></tr></thead>
              <tbody>
                {(items as any[]).filter((i:any)=>i.stockQty<999).map((item:any)=>(<tr key={item.id}>
                  <td style={{fontWeight:500}}>{item.name}</td>
                  <td><span className="badge badge-muted">{item.category}</span></td>
                  <td className="mono" style={{fontWeight:700,color:item.stockQty===0?'var(--red)':item.stockQty<=item.stockMin?'var(--amber)':'var(--text-0)'}}>{item.stockQty}</td>
                  <td className="mono" style={{color:'var(--text-3)'}}>{item.stockMin}</td>
                  <td className="mono" style={{color:'var(--text-3)'}}>{item.stockMax}</td>
                  <td>{item.stockQty===0?<span className="badge badge-red">Out</span>:item.stockQty<=item.stockMin?<span className="badge badge-amber">Low</span>:<span className="badge badge-green">OK</span>}</td>
                  <td><button className="btn btn-ghost btn-sm" onClick={async()=>{
                    const n=await appPrompt('Adjust qty by (negative to reduce):', { title: 'Adjust stock' })
                    if(!n||isNaN(Number(n)))return
                    await apiPost("/pos/items/"+item.id+"/adjust-stock",{changeQty:Number(n),reason:'manual'})
                    qc.invalidateQueries('pos-items');qc.invalidateQueries('pos-low-stock');qc.invalidateQueries('pos-inventory-log')
                  }}>+/- Adjust</button></td>
                </tr>))}
              </tbody>
            </table>
          </div>
          <div className="card" style={{padding:0}}>
            <div className="card-header" style={{padding:'16px 20px'}}><span className="card-title">Stock Movement Log</span></div>
            <table className="data-table">
              <thead><tr><th>Date</th><th>Item</th><th>Change</th><th>Before</th><th>After</th><th>Reason</th></tr></thead>
              <tbody>
                {(inventoryLog as any[]).length?(inventoryLog as any[]).map((log:any)=>(<tr key={log.id}>
                  <td className="mono" style={{fontSize:'.78rem',color:'var(--text-3)'}}>{new Date(log.createdAt).toLocaleDateString()}</td>
                  <td style={{fontWeight:500}}>{log.itemIcon} {log.itemName}</td>
                  <td className="mono" style={{fontWeight:700,color:log.changeQty>0?'var(--green)':'var(--red)'}}>{log.changeQty>0?'+':''}{log.changeQty}</td>
                  <td className="mono">{log.stockBefore}</td>
                  <td className="mono">{log.stockAfter}</td>
                  <td><span className="badge badge-muted">{humanize(log.reason)}</span></td>
                </tr>)):<tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No stock movements yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* S243: Readers tab — pair / list / archive smart readers (S700,
          WisePOS E, etc.). Smart readers are bound to a property and
          surfaced in the charge modal when that property is selected.
          Bluetooth handheld readers don't appear here — they're paired
          via the JS SDK at charge time. */}
      {tab==='readers' && !!registerProperty && (
        <div style={{display:'grid',gap:16}}>
          {/* S652 (Nic): "they get their card reader, they plug it in, they're
              good to go." One supported model, the price, the plan, the address
              — GAM orders it from Stripe pre-registered to this property and
              ships it straight here. It shows in Active Readers on its own. */}
          <GetReaderCard propertyId={registerProperty} property={(properties as any[]).find((p:any)=>p.id===registerProperty)} />
          <div className="card">
            <div className="card-header"><span className="card-title">Pair New Smart Reader</span></div>
            <div style={{fontSize:'.78rem',color:'var(--text-3)',marginTop:8,marginBottom:12}}>
              Put the reader in pairing mode (Settings → Generate Pairing Code on the device).
              Enter the code shown on the reader's screen below.
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,alignItems:'end'}}>
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Property</div>
                <select className="form-select" value={newReader.propertyId} onChange={e=>setNewReader(s=>({...s,propertyId:e.target.value}))} style={{width:'100%'}}>
                  <option value="">Select…</option>
                  {(properties as any[]).map((p:any)=><option key={p.id} value={p.id}>{p.name||p.address1||p.id}</option>)}
                </select>
              </div>
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Pairing code</div>
                <input className="form-input" value={newReader.registrationCode} onChange={e=>setNewReader(s=>({...s,registrationCode:e.target.value}))} style={{width:'100%'}} placeholder="e.g. cute-cat-purple" />
              </div>
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Nickname</div>
                <input className="form-input" value={newReader.nickname} onChange={e=>setNewReader(s=>({...s,nickname:e.target.value}))} style={{width:'100%'}} placeholder="e.g. Front office S700" />
              </div>
              <div style={{gridColumn:'1/-1'}}>
                <button
                  className="btn btn-primary"
                  style={{width:'100%'}}
                  onClick={()=>registerReaderMut.mutate()}
                  disabled={!newReader.propertyId||!newReader.registrationCode||!newReader.nickname||registerReaderMut.isLoading}
                >
                  {registerReaderMut.isLoading?'Pairing…':'Pair Reader'}
                </button>
                {registerReaderMut.isError&&<div style={{fontSize:'.75rem',color:'var(--red)',marginTop:6}}>{(registerReaderMut.error as any)?.response?.data?.error?.message||'Pairing failed'}</div>}
              </div>
            </div>
          </div>

          <div className="card" style={{padding:0}}>
            <div className="card-header" style={{padding:'16px 20px'}}>
              <span className="card-title">Active Readers</span>
              <span style={{fontSize:'.75rem',color:'var(--text-3)'}}>{(registeredReaders as RegisteredReader[]).length} reader(s)</span>
            </div>
            <table className="data-table">
              <thead><tr><th>Nickname</th><th>Property</th><th>Stripe ID</th><th>Registered</th><th></th></tr></thead>
              <tbody>
                {(registeredReaders as RegisteredReader[]).length?(registeredReaders as RegisteredReader[]).map(r=>{
                  const prop = (properties as any[]).find((p:any)=>p.id===r.propertyId)
                  return (
                    <tr key={r.id}>
                      <td style={{fontWeight:500}}>{r.nickname}</td>
                      <td style={{color:'var(--text-3)',fontSize:'.82rem'}}>{prop?.name||prop?.address1||r.propertyId}</td>
                      <td className="mono" style={{fontSize:'.75rem',color:'var(--text-3)'}}>{r.stripeReaderId}</td>
                      <td className="mono" style={{fontSize:'.78rem',color:'var(--text-3)'}}>{new Date(r.registeredAt).toLocaleDateString()}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{color:'var(--red)'}}
                          onClick={()=>{ appConfirm('Archive '+r.nickname+'? It will no longer appear in the charge modal.', { danger: true, confirmLabel: 'Archive' }).then(ok => { if (ok) archiveReaderMut.mutate(r.id) }) }}
                        >Archive</button>
                      </td>
                    </tr>
                  )
                }):<tr><td colSpan={5} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No readers paired yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editItem&&(<div className="modal-overlay" onClick={()=>setEditItem(null)}><div className="modal" style={{maxWidth:520}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Edit {editItem.name}</span><button className="btn btn-ghost btn-sm" onClick={()=>setEditItem(null)}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" style={{width:'100%'}} value={editItem.name} onChange={e=>setEditItem((s:any)=>({...s,name:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Category</div><select className="form-select" style={{width:'100%'}} value={editItem.categoryId} onChange={e=>setEditItem((s:any)=>({...s,categoryId:e.target.value}))}>{categoriesForProperty(editItem.propertyId).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Sell Price</div><input className="form-input" style={{width:'100%'}} type="number" {...nonNeg} value={editItem._sell} onChange={e=>setEditItem((s:any)=>({...s,_sell:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Cost Price</div><input className="form-input" style={{width:'100%'}} type="number" {...nonNeg} value={editItem._cost} onChange={e=>setEditItem((s:any)=>({...s,_cost:e.target.value}))} /></div>
          {/* S650: tick the taxes this item carries. A tax on everything or on the
              item's whole category shows ticked and is changed on the Taxes tab. */}
          <div style={{gridColumn:'1/-1'}}><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Taxes</div>
            {propertyTaxes.length === 0
              ? <div style={{fontSize:'.78rem',color:'var(--text-3)'}}>No taxes set up for this property yet — add one on the Taxes tab.</div>
              : <div style={{display:'grid',gap:4}}>{propertyTaxes.map((t:any)=>{
                  const reach = taxReach(t, editItem)
                  const inherited = reach === 'all' || reach === 'category'
                  return (<label key={t.id} style={{display:'flex',alignItems:'center',gap:8,fontSize:'.82rem',color:inherited?'var(--text-3)':'var(--text-1)'}}>
                    <input type="checkbox" checked={!!reach} disabled={inherited || setItemTaxMut.isLoading}
                      onChange={e=>setItemTaxMut.mutate({ tax: t, itemId: editItem.id, on: e.target.checked })} />
                    {t.name} ({pct(t.rate)}){reach === 'all' ? ' — on everything' : reach === 'category' ? ' — on the whole category' : ''}
                  </label>)
                })}</div>}
          </div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Qty</div><input className="form-input" style={{width:'100%'}} type="number" {...nonNeg} value={editItem._stock} onChange={e=>setEditItem((s:any)=>({...s,_stock:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Min</div><input className="form-input" style={{width:'100%'}} type="number" {...nonNeg} value={editItem._min} onChange={e=>setEditItem((s:any)=>({...s,_min:e.target.value}))} /></div>
          {/* S192: property reassignment. null = company-wide. */}
          <div style={{gridColumn:'1/-1'}}>
            <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>
              Property <span style={{color:'var(--text-3)'}}>(low-stock alerts route to this property's manager)</span>
            </div>
            <select
              className="form-select"
              style={{width:'100%'}}
              value={editItem.propertyId || ''}
              onChange={e=>setEditItem((s:any)=>({...s,propertyId:e.target.value || null}))}
            >
              <option value="" disabled>Select a property…</option>
              {(properties as any[]).map((p:any)=>(
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div style={{gridColumn:'1/-1',marginTop:8}}><button className="btn btn-primary" style={{width:'100%'}} onClick={()=>updateItemMut.mutate({name:editItem.name,icon:editItem.icon,categoryId:editItem.categoryId,sellPrice:Number(editItem._sell),costPrice:Number(editItem._cost),stockQty:Number(editItem._stock),stockMin:Number(editItem._min),chargeEligible:editItem.chargeEligible,propertyId:editItem.propertyId || null})} disabled={updateItemMut.isLoading}>{updateItemMut.isLoading?'Saving...':'Save Changes'}</button></div>
        </div>
      </div></div>)}

      {editCategory&&(<div className="modal-overlay" onClick={()=>setEditCategory(null)}><div className="modal" style={{maxWidth:460}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Edit Category — {editCategory.name}</span><button className="btn btn-ghost btn-sm" onClick={()=>setEditCategory(null)}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
          <div style={{display:'grid',gridTemplateColumns:'80px 1fr',gap:12}}>
            <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" style={{width:'100%'}} value={editCategory._name} onChange={e=>setEditCategory((s:any)=>({...s,_name:e.target.value}))} /></div>
          </div>
          {/* Property scope — toggle per property. "All properties" (empty) = company-wide. */}
          <div>
            <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:6}}>Available at <span style={{color:'var(--text-3)'}}>(toggle the properties that carry this category)</span></div>
            <div style={{display:'flex',flexWrap:'wrap',gap:'8px 16px'}}>
              <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'.82rem',cursor:'pointer'}}>
                <input type="checkbox" checked={(editCategory._propertyIds||[]).length===0} onChange={()=>setEditCategory((s:any)=>({...s,_propertyIds:[]}))} />
                All properties
              </label>
              {(properties as any[]).map((p:any)=>(
                <label key={p.id} style={{display:'flex',alignItems:'center',gap:6,fontSize:'.82rem',cursor:'pointer'}}>
                  <input type="checkbox" checked={(editCategory._propertyIds||[]).includes(p.id)} onChange={e=>setEditCategory((s:any)=>({...s,_propertyIds: e.target.checked ? [...(s._propertyIds||[]), p.id] : (s._propertyIds||[]).filter((x:string)=>x!==p.id)}))} />
                  {p.name || p.street1}
                </label>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" style={{width:'100%'}} onClick={()=>updateCategoryMut.mutate({name:editCategory._name,icon:editCategory._icon,sortOrder:Number(editCategory._sort),propertyIds: editCategory._propertyIds||[]})} disabled={updateCategoryMut.isLoading||!editCategory._name}>{updateCategoryMut.isLoading?'Saving...':'Save Changes'}</button>
        </div>
      </div></div>)}

      {showCatPropPicker&&(<div className="modal-overlay" onClick={()=>setShowCatPropPicker(false)}><div className="modal" style={{maxWidth:420}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Available at which properties?</span><button className="btn btn-ghost btn-sm" onClick={()=>setShowCatPropPicker(false)}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gap:10}}>
          <div style={{fontSize:'.75rem',color:'var(--text-3)'}}>Choose "All properties" (company-wide) or toggle the specific properties that carry this category.</div>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:'.88rem',cursor:'pointer',padding:'6px 0',borderBottom:'1px solid var(--border-1)'}}>
            <input type="checkbox" checked={newCategory.propertyIds.length===0} onChange={()=>setNewCategory(s=>({...s,propertyIds:[]}))} />
            All properties
          </label>
          {(properties as any[]).map((p:any)=>(
            <label key={p.id} style={{display:'flex',alignItems:'center',gap:8,fontSize:'.88rem',cursor:'pointer',padding:'4px 0'}}>
              <input type="checkbox" checked={newCategory.propertyIds.includes(p.id)} onChange={e=>setNewCategory(s=>({...s,propertyIds: e.target.checked ? [...s.propertyIds, p.id] : s.propertyIds.filter((x:string)=>x!==p.id)}))} />
              {p.name || p.street1}
            </label>
          ))}
          <button className="btn btn-primary" style={{width:'100%',marginTop:8}} onClick={()=>setShowCatPropPicker(false)}>Done</button>
        </div>
      </div></div>)}

      {editVendor&&(<div className="modal-overlay" onClick={()=>setEditVendor(null)}><div className="modal" style={{maxWidth:520}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Edit Vendor — {editVendor.name}</span><button className="btn btn-ghost btn-sm" onClick={()=>setEditVendor(null)}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" style={{width:'100%'}} value={editVendor.name} onChange={e=>setEditVendor((s:any)=>({...s,name:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Contact</div><input className="form-input" style={{width:'100%'}} value={editVendor.contactName||''} onChange={e=>setEditVendor((s:any)=>({...s,contactName:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Email</div><input className="form-input" style={{width:'100%'}} value={editVendor.email||''} onChange={e=>setEditVendor((s:any)=>({...s,email:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Phone</div><input className="form-input" style={{width:'100%'}} value={editVendor.phone||''} onChange={e=>setEditVendor((s:any)=>({...s,phone:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Lead Time (days)</div><input className="form-input" type="number" {...nonNeg} style={{width:'100%'}} value={editVendor.leadTimeDays||3} onChange={e=>setEditVendor((s:any)=>({...s,leadTimeDays:Number(e.target.value)}))} /></div>
          <div style={{display:'flex',alignItems:'center',gap:8,paddingTop:20}}><input type="checkbox" id="va" checked={editVendor.isActive} onChange={e=>setEditVendor((s:any)=>({...s,isActive:e.target.checked}))} /><label htmlFor="va" style={{fontSize:'.82rem'}}>Active</label></div>
          <div style={{gridColumn:'1/-1',marginTop:8}}><button className="btn btn-primary" style={{width:'100%'}} onClick={()=>updateVendorMut.mutate({name:editVendor.name,contactName:editVendor.contactName,email:editVendor.email,phone:editVendor.phone,leadTimeDays:editVendor.leadTimeDays,isActive:editVendor.isActive})} disabled={updateVendorMut.isLoading}>{updateVendorMut.isLoading?'Saving...':'Save Changes'}</button></div>
        </div>
      </div></div>)}

      {readerModal&&(<div className="modal-overlay" onClick={()=>setReaderModal(false)}><div className="modal" style={{maxWidth:460}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Select Card Reader</span><button className="btn btn-ghost btn-sm" onClick={()=>setReaderModal(false)}>x</button></div>
        <div style={{padding:'0 24px 24px'}}>
          {terminalStatus==='error'&&<div style={{color:'var(--red)',fontSize:'.82rem',marginBottom:12}}>{terminalError}</div>}

          {/* S243: smart readers registered to the cart's property. Server-driven flow. */}
          <div style={{fontSize:'.72rem',color:'var(--text-3)',textTransform:'uppercase',letterSpacing:.5,margin:'4px 0 8px'}}>Registered readers</div>
          {!registerProperty&&<div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:12}}>Select a property first to list its registered readers.</div>}
          {registerProperty&&(registeredReaders as RegisteredReader[]).length===0&&<div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:12}}>No readers registered for this property. Pair one under the Readers tab, or use a Bluetooth reader below.</div>}
          {(registeredReaders as RegisteredReader[]).map(r=>(
            <div key={r.id} onClick={()=>selectSmartReader(r)} style={{border:'1px solid var(--border-1)',borderRadius:8,padding:'10px 14px',marginBottom:6,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between'}} onMouseEnter={e=>(e.currentTarget.style.borderColor='var(--gold)')} onMouseLeave={e=>(e.currentTarget.style.borderColor='var(--border-1)')}>
              <div><div style={{fontWeight:600,fontSize:'.85rem'}}>{r.nickname}</div><div style={{fontSize:'.72rem',color:'var(--text-3)'}}>smart reader</div></div>
              <span style={{color:'var(--gold)',fontSize:'.78rem'}}>Use</span>
            </div>
          ))}

          {/* S243: Bluetooth handheld readers discovered via the Terminal JS SDK. Client-driven flow. */}
          <div style={{fontSize:'.72rem',color:'var(--text-3)',textTransform:'uppercase',letterSpacing:.5,margin:'14px 0 8px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span>Bluetooth readers</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={discoverAndConnect} disabled={terminalStatus==='discovering'||terminalStatus==='connecting'}>
              {terminalStatus==='discovering'?'Searching…':terminalStatus==='connecting'?'Connecting…':'Discover'}
            </button>
          </div>
          {readers.length===0&&terminalStatus==='idle'&&<div style={{fontSize:'.78rem',color:'var(--text-3)'}}>Tap Discover to scan nearby readers.</div>}
          {readers.map((r:any)=>(
            <div key={r.id} onClick={()=>selectBluetoothReader(r)} style={{border:'1px solid var(--border-1)',borderRadius:8,padding:'10px 14px',marginBottom:6,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between'}} onMouseEnter={e=>(e.currentTarget.style.borderColor='var(--gold)')} onMouseLeave={e=>(e.currentTarget.style.borderColor='var(--border-1)')}>
              <div><div style={{fontWeight:600,fontSize:'.85rem'}}>{r.label||r.serialNumber}</div><div style={{fontSize:'.72rem',color:'var(--text-3)'}}>{humanize(r.deviceType)} · {humanize(r.status)}</div></div>
              <span style={{color:'var(--gold)',fontSize:'.78rem'}}>Connect</span>
            </div>
          ))}
        </div>
      </div></div>)}



      {voidAsk&&(<div className="modal-overlay" onClick={()=>{ if (!voidMut.isLoading) setVoidAsk(null) }}><div className="modal" style={{maxWidth:400}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Void this sale?</span></div>
        <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
          <div style={{fontSize:'.85rem',lineHeight:1.5}}>
            Void the {fmt(voidAsk.total)} sale from {new Date(voidAsk.createdAt).toLocaleDateString()}? A void says the sale never happened — use it for a sale rung by mistake, and hand back any cash taken for it. What it took goes back on the shelf.
            To give money back for a real sale, press Keep it, then Refund.
          </div>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button className="btn btn-ghost" disabled={voidMut.isLoading} onClick={()=>setVoidAsk(null)}>Keep it</button>
            <button className="btn btn-primary" disabled={voidMut.isLoading} onClick={()=>voidMut.mutate(voidAsk.id)}>{voidMut.isLoading ? 'Voiding…' : 'Void the sale'}</button>
          </div>
        </div>
      </div></div>)}
      {refundModal.show&&(<div className="modal-overlay" onClick={()=>setRefundModal({show:false,tx:null})}><div className="modal" style={{maxWidth:380}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Refund Transaction</span><button className="btn btn-ghost btn-sm" onClick={()=>setRefundModal({show:false,tx:null})}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
          <div style={{fontSize:'.85rem',color:'var(--text-3)'}}>Original total: <strong style={{color:'var(--text-0)'}}>{fmt(refundModal.tx?.total)}</strong></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Refund Amount (blank for full refund)</div><input className="form-input" style={{width:'100%'}} type="number" {...nonNeg} value={refundAmt} onChange={e=>setRefundAmt(e.target.value)} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Reason</div><input className="form-input" style={{width:'100%'}} value={refundReason} onChange={e=>setRefundReason(e.target.value)} /></div>
          {!LAUNCH_HIDE_CHARGE && refundModal.tx?.paymentMethod === 'charge' ? (
            <div style={{fontSize:'.8rem',color:'var(--text-3)',padding:'8px 12px',background:'var(--bg-2)',borderRadius:4}}>Reverses on FlexCharge account (no cash payout).</div>
          ) : (
            <div>
              <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Refund Method</div>
              <div style={{display:'flex',gap:12}}>
                <label style={{display:'flex',alignItems:'center',gap:4,cursor:'pointer'}}><input type="radio" checked={refundMethod==='cash'} onChange={()=>setRefundMethod('cash')} /> Cash</label>
                <label style={{display:'flex',alignItems:'center',gap:4,cursor:'pointer'}}><input type="radio" checked={refundMethod==='check'} onChange={()=>setRefundMethod('check')} /> Check</label>
              </div>
            </div>
          )}
          <button className="btn btn-primary" onClick={()=>refundMut.mutate()} disabled={refundMut.isLoading}>Process Refund</button>
        </div>
      </div></div>)}
      {/* ── S651: the stay's site, dates and guest ────────────────────────
          The register could already sell "RV site — daily" and take the money
          without recording a site or a date, so the schedule never heard about
          it and somebody sat on a spot the software thought was empty.

          Only three things are asked, because only three cannot be derived:
          when they arrive, which site, and who it is for. The length comes from
          the item and the quantity already rung — Nic: "You add two of those,
          it's two days or two weeks or two months." */}
      {ticketsOpen&&(<div className="modal-overlay" onClick={()=>setTicketsOpen(false)}>
        <div className="modal" style={{maxWidth:460}} onClick={e=>e.stopPropagation()}>
          <div className="modal-header">
            <span className="modal-title">Open tickets &amp; pay links</span>
            <button className="btn btn-ghost btn-sm" onClick={()=>setTicketsOpen(false)}>✕</button>
          </div>
          <div style={{padding:'4px 24px 24px',display:'grid',gap:8}}>
            {/* 10/2: read fresh every time this opens; a fresh sale in the cart
                is finished or cleared before another one is opened. */}
            {tickets.isFetching && <div style={{fontSize:'.75rem',color:'var(--text-3)'}}>Checking what is still out…</div>}
            {cart.length>0 && !openTicketId && !payLinkId && (
              <div style={{fontSize:'.75rem',color:'var(--amber)',lineHeight:1.45}}>
                Finish the sale on the register, or press Clear, before opening one of these.
              </div>)}
            {!tickets.isFetching && !tickets.data?.length && <div style={{fontSize:'.8rem',color:'var(--text-3)'}}>Nothing is out — no tickets, no unpaid pay links.</div>}
            {(tickets.data ?? []).map((t:any)=>(
              <div key={t.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,
                                      padding:'11px 14px',background:'var(--bg-2)',
                                      border:`1px solid ${(openTicketId===t.id||payLinkId===t.id)?'var(--gold)':'var(--border-1)'}`,
                                      borderRadius:10}}>
                <div>
                  <div style={{fontWeight:700,fontSize:'.88rem'}}>
                    {t.customerName || (t.bookingId ? 'Reservation' : 'Customer')}
                    {t.kind==='pay_link' && <span style={{marginLeft:8,fontSize:'.66rem',fontWeight:700,color:'var(--gold)',border:'1px solid var(--gold)',borderRadius:10,padding:'1px 7px'}}>PAY LINK</span>}
                  </div>
                  <div style={{fontSize:'.72rem',color:'var(--text-3)'}}>
                    {(t.items||[]).map((i:any)=>`${i.qty} × ${i.name||'item'}`).join(', ')}
                  </div>
                  {t.note && <div style={{fontSize:'.7rem',color:'var(--text-3)',marginTop:2}}>{t.note}</div>}
                </div>
                {(openTicketId===t.id||payLinkId===t.id)
                  ? <span style={{fontSize:'.72rem',color:'var(--gold)',fontWeight:700,whiteSpace:'nowrap'}}>In the cart</span>
                  : <button className="btn btn-primary btn-sm"
                      disabled={!!reopening || putTicketBackMut.isLoading || readerHoldsCharge || (cart.length>0 && !openTicketId && !payLinkId)}
                      onClick={()=>void reopenTicket(t)}>{reopening===t.id ? 'Opening…' : 'Settle'}</button>}
              </div>
            ))}
          </div>
        </div>
      </div>)}
      {stayModal&&stayLine&&(<div className="modal-overlay" onClick={()=>setStayModal(false)}>
        <div className="modal" style={{maxWidth:520}} onClick={e=>e.stopPropagation()}>
          <StayDetailsModal
            line={stayLine}
            propertyId={registerProperty}
            initial={stay}
            onCancel={()=>setStayModal(false)}
            onLeaseDrafted={(message:string)=>{
              // 10/5 (Nic, M5): Add a month answered lease sells no month — the
              // lease was drafted instead, so the month comes out of the cart.
              setCart(c=>c.filter(i=>i.id!==stayLine.id)); setStay(null); setStayModal(false)
              toastOnce(message)
            }}
            onDone={(d:any)=>{
              setStay(d); setStayModal(false)
              // The site carries the rate. Writing it onto the cart line is what
              // makes the total, the tax, the card authorization and the booking
              // all one number instead of four. 10/3 (decisions #9, #21): what
              // these nights cost on that site by the schedule's own pricing,
              // the lodging tax inside it — the figure Charge and a link take.
              // 10/5 (Nic): with what the stay needs — the guest's email, the
              // lease answer, the month added and the background check's fee —
              // all as the server quoted them (POST /pos/stays/quote).
              setCart(c=>c.map(i=>i.id===stayLine.id ? { ...i, price: d.rate != null ? Number(d.rate) : i.price,
                stayUnitId: d.unitId, stayCheckIn: d.checkIn, stayTotal: Number(d.lineTotal), stayTax: Number(d.lodgingTax) || 0,
                stayEmail: d.guestEmail || null, stayTerms: d.stayTerms || null, stayExtend: d.extendBookingId || null,
                screeningFee: d.screeningFee != null ? Number(d.screeningFee) : null, stayReturning: d.returningGuest === true || null } : i))
            }}
          />
        </div>
      </div>)}
    </div>
  )
}


/**
 * S651 — what the cashier fills in for a stay.
 *
 * The site list is what is ACTUALLY FREE for those dates, from the server,
 * using the same three-way test the booking site uses: another booking, a
 * lease, or an out-of-order window. Showing every site and letting the sale
 * fail afterwards would put the error in front of a customer standing at the
 * counter instead of in front of the cashier choosing.
 *
 * 10/5 (Nic): and what the stay needs, from the server (POST /pos/stays/quote)
 * — never worked out here. The price is whole nights, weeks or months, never
 * prorated (R5). A stay over three weeks in a row needs the guest's email and,
 * with no background check on file, carries the check's fee (R1/R8). A stay of
 * 30+ nights needs the counter's answer: lease or no lease (R2) — "it's the
 * front counter person that's clicking lease or no lease." A monthly stay can
 * instead add a month to a stay that is here now (R6).
 */
function StayDetailsModal({ line, propertyId, initial, onCancel, onDone, onLeaseDrafted }: {
  line: any; propertyId: string; initial: any
  onCancel: () => void; onDone: (d: any) => void
  /** 10/5 (Nic, M5): Add a month answered lease — the lease was drafted and no month is sold. */
  onLeaseDrafted: (message: string) => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const canExtend = line.stayUnit === 'month' && Number(line.qty) === 1
  const [mode, setMode] = useState<'new' | 'extend'>(canExtend && initial?.extendBookingId ? 'extend' : 'new')
  const [checkIn, setCheckIn] = useState<string>(initial?.extendBookingId ? today : (initial?.checkIn || today))
  const [unitId, setUnitId] = useState<string>(initial?.extendBookingId ? '' : (initial?.unitId || ''))
  const [guestName, setGuestName] = useState<string>(initial?.guestName || '')
  const [guestPhone, setGuestPhone] = useState<string>(initial?.guestPhone || '')
  const [guestEmail, setGuestEmail] = useState<string>(initial?.guestEmail || '')
  const [stayTerms, setStayTerms] = useState<StayTerms | null>(initial?.stayTerms || null)
  // 10/6 (Nic): "Returning guest — they've stayed with us before" — no background
  // check. Offered by the server only to the owner or a manager allowed to invite.
  const [returning, setReturning] = useState<boolean>(initial?.returningGuest === true)
  const [extendId, setExtendId] = useState<string>(initial?.extendBookingId || '')
  const [findStay, setFindStay] = useState<string>('')
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail.trim())

  // 10/3 (review, front desk foolproof): what is free is read FRESH every time
  // the picker opens (never a list from before the last sale or link took a
  // site), and the site cannot be used while that read is still on its way.
  const { data, isFetching, error } = useQuery<any>(
    ['stay-availability', propertyId, checkIn, line.stayUnit, line.qty],
    () => apiGet(`/pos/stays/available?propertyId=${propertyId}&checkIn=${checkIn}&stayUnit=${line.stayUnit}&qty=${line.qty}`),
    { enabled: mode === 'new' && !!propertyId && !!checkIn, retry: false, keepPreviousData: true, staleTime: 0, refetchOnMount: 'always' },
  )
  const units: any[] = data?.units ?? []
  // A site chosen for one set of dates may not be free for another, so the
  // pick clears whenever the dates move it out of the list.
  useEffect(() => {
    if (unitId && units.length && !units.some((u: any) => u.id === unitId)) setUnitId('')
  }, [units, unitId])

  // 10/5 (Nic, R6): the stays here now that a month can be added to.
  const current = useQuery<any[]>(
    ['stays-current', propertyId, findStay.trim()],
    () => apiGet(`/pos/stays/current?propertyId=${propertyId}&q=${encodeURIComponent(findStay.trim())}`),
    { enabled: mode === 'extend' && !!propertyId, retry: false, keepPreviousData: true, staleTime: 0 },
  )
  const stays: any[] = Array.isArray(current.data) ? current.data : []
  const pickedStay = stays.find((x: any) => x.bookingId === extendId)

  // 10/5: what the stay comes to and needs — the server's figures, read every
  // time the site, dates, email or answer changes.
  const quoteBody = mode === 'extend'
    ? (extendId ? { propertyId, itemId: line.id, qty: line.qty, extendBookingId: extendId, guestEmail: emailOk ? guestEmail.trim() : null, stayTerms,
                    ...(returning ? { returningGuest: true } : {}) } : null)
    : (unitId && checkIn ? { propertyId, itemId: line.id, qty: line.qty, unitId, checkIn, guestEmail: emailOk ? guestEmail.trim() : null, stayTerms,
                             ...(returning ? { returningGuest: true } : {}) } : null)
  const quote = useQuery<any>(
    ['stay-quote', JSON.stringify(quoteBody)],
    () => apiPost('/pos/stays/quote', quoteBody).then((r: any) => r.data),
    { enabled: !!quoteBody, retry: false, staleTime: 0, keepPreviousData: false },
  )
  const q: any = quote.data ?? null
  // A guest who comes back the same day as another of their stays ends is the
  // same stay (their nights add up); the answer they gave then stands.
  useEffect(() => {
    if (q && !stayTerms && (q.terms === 'lease' || q.terms === 'stay')) setStayTerms(q.terms)
  }, [q?.terms])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (mode === 'extend' && pickedStay?.guestEmail && !guestEmail) setGuestEmail(pickedStay.guestEmail)
  }, [pickedStay?.bookingId])   // eslint-disable-line react-hooks/exhaustive-deps

  const lengthLabel = line.stayUnit === 'night' ? `${line.qty} night${line.qty === 1 ? '' : 's'}`
    : line.stayUnit === 'week' ? `${line.qty} week${line.qty === 1 ? '' : 's'}`
    : `${line.qty} month${line.qty === 1 ? '' : 's'}`

  const picked = units.find((u: any) => u.id === unitId)
  const needsAnswer = q?.leaseChoice === 'needed' && !stayTerms
  const needsEmail = !!q?.needsEmail && !emailOk
  // 10/3 (decisions #9): a site is picked by what these nights cost on it; 10/5: once the server has said what the stay needs.
  const ready = !!q && !quote.isFetching && !quote.error && !needsAnswer && !needsEmail
    && (mode === 'extend' ? !!extendId : (!!unitId && picked?.lineTotal != null && !!checkIn && !!guestName.trim() && !isFetching))
  const quoteError = (quote.error as any)?.response?.data?.error
  // 10/5 (Nic, M5): a month is sold only as a stay. Answered lease, the lease
  // is drafted instead (it bills the months from here on) and nothing is charged.
  const leaseInstead = mode === 'extend' && !!q?.leaseInstead
  const draftLease = useMutation(
    () => apiPost('/pos/stays/lease', { propertyId, bookingId: extendId }).then((r: any) => r.data),
    { onSuccess: (d: any) => onLeaseDrafted(d?.message || 'Their lease is drafted for the owner to review and send. Nothing was charged.'),
      onError: (e: any) => toastOnce(errorMessage(e, 'Their lease could not be drafted — check the connection and press Draft their lease again.'), { error: true }) })

  return (
    <>
      <div className="modal-title" style={{marginBottom:4}}>{line.name}</div>
      <div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:14}}>
        {mode === 'extend' ? 'Add a month to their stay' : <>{lengthLabel}{data?.checkOut ? ` · ${checkIn} → ${data.checkOut}` : ''}</>}
      </div>

      {canExtend && (
        <div style={{display:'flex',gap:16,marginBottom:12,fontSize:'.82rem'}}>
          <label style={{display:'flex',alignItems:'center',gap:4,cursor:'pointer'}}>
            <input type="radio" checked={mode==='new'} onChange={()=>{ setMode('new'); setExtendId('') }} /> A new stay
          </label>
          <label style={{display:'flex',alignItems:'center',gap:4,cursor:'pointer'}}>
            <input type="radio" checked={mode==='extend'} onChange={()=>{ setMode('extend'); setUnitId('') }} /> Add a month to a stay here now
          </label>
        </div>)}

      {mode === 'extend' ? (<>
        <label style={{fontSize:'.78rem',color:'var(--text-2)'}}>Their stay</label>
        <input className="input" style={{width:'100%',marginBottom:6}} placeholder="Find by name, email or site"
               value={findStay} onChange={e=>setFindStay(e.target.value)} />
        {current.error
          ? <div style={{fontSize:'.78rem',color:'var(--red)',marginBottom:12}}>{(current.error as any)?.response?.data?.error || 'Could not look the stays up.'}</div>
          : stays.length
            ? <select className="input" style={{width:'100%',marginBottom:12}} value={extendId} onChange={e=>setExtendId(e.target.value)}>
                <option value="">Pick their stay…</option>
                {stays.map((x:any)=>(
                  <option key={x.bookingId} value={x.bookingId}>
                    {[x.guestName || 'Guest', `site ${x.unitNumber}`, `${x.checkIn} → ${x.checkOut}`].join(' · ')}
                  </option>))}
              </select>
            : <div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:12}}>{current.isFetching ? 'Looking…' : 'No stay here now matches. A stay with a lease is not listed — its lease holds the site.'}</div>}
      </>) : (<>
      <label style={{fontSize:'.78rem',color:'var(--text-2)'}}>Arriving</label>
      <input type="date" className="input" style={{width:'100%',marginBottom:12}}
             value={checkIn} min={today} onChange={e=>setCheckIn(e.target.value)} />

      <label style={{fontSize:'.78rem',color:'var(--text-2)'}}>Site</label>
      {error
        ? <div style={{fontSize:'.78rem',color:'var(--red)',marginBottom:12}}>
            {(error as any)?.response?.data?.error || 'Could not check what is free.'}
          </div>
        : isFetching && !units.length
          ? <div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:12}}>Checking what is free…</div>
          : units.length
            ? <>
                {/* S652 (Nic): the counter tells the customer what IS available
                    — back-in or pull-through, what amp service, and the price —
                    and the customer chooses from what exists. A bare list of
                    site numbers makes the person behind the counter recite all
                    of that from memory. The price is the site's rate card, the
                    same number the booking site quotes. */}
                <select className="input" style={{width:'100%',marginBottom:12}}
                        value={unitId} onChange={e=>setUnitId(e.target.value)}>
                  <option value="">Pick a site…</option>
                  {units.map((u:any)=>(
                    <option key={u.id} value={u.id} disabled={u.lineTotal == null}>
                      {[u.unitNumber, rvSiteFactsLabel(u),
                        u.lineTotal == null ? 'no rate set' : `${fmt(u.lineTotal)}${Number(u.lodgingTax) > 0 ? ' with lodging tax' : ''}`,
                        // 10/6 (Nic): six nights at the week's price, said so.
                        u.lineTotal == null ? null : u.lowerRateWords,
                        u.heldByUnpaidHold ? `held, unpaid${u.heldFor ? ` — ${u.heldFor}` : ''}` : null]
                        .filter(Boolean).join(' · ')}
                    </option>
                  ))}
                </select>
                {units.some((u:any)=>u.lineTotal == null) && (
                  <div style={{fontSize:'.72rem',color:'var(--amber)',marginBottom:12}}>
                    A site with no rate for this length cannot be sold until one is set on the site.
                  </div>)}
                {/* 10/3 (S652: an unpaid hold yields to anyone who pays) */}
                {units.find((u:any)=>u.id===unitId)?.heldByUnpaidHold && (
                  <div style={{fontSize:'.72rem',color:'var(--amber)',marginBottom:12}}>
                    {(()=>{ const h:any = units.find((u:any)=>u.id===unitId); return h?.heldFor ? `${h.heldFor} is` : 'Someone is' })()} holding this
                    site without paying. If that is the person in front of you, press Cancel and settle their link or ticket from the
                    open list instead. Otherwise, charging for it here moves their hold to another free site and emails them the new
                    site — or, if the park is full, cancels their hold and the owner gets a notice to call them. A pay link cannot take
                    a held site.
                  </div>)}
              </>
            : <div style={{fontSize:'.78rem',color:'var(--amber)',marginBottom:12}}>
                Nothing is free for those dates. Try a different arrival date.
              </div>}

      <label style={{fontSize:'.78rem',color:'var(--text-2)'}}>Who is it for</label>
      <input className="input" style={{width:'100%',marginBottom:12}} placeholder="Name"
             value={guestName} onChange={e=>setGuestName(e.target.value)} />
      <input className="input" style={{width:'100%',marginBottom:12}} placeholder="Phone (optional)"
             value={guestPhone} onChange={e=>setGuestPhone(e.target.value)} />
      </>)}
      <input className="input" type="email" style={{width:'100%',marginBottom:4}}
             placeholder="Email (needed for a stay over three weeks)"
             value={guestEmail} onChange={e=>setGuestEmail(e.target.value)} />
      {needsEmail && <div style={{fontSize:'.72rem',color:'var(--amber)',marginBottom:8}}>
        This comes to {q.nights} nights in a row — type their email. Their background check goes to it, and their back-to-back stays add up by it.
      </div>}

      {/* 10/5 (Nic): what the stay comes to and needs — the server's figures. */}
      {quoteBody && (quote.isFetching
        ? <div style={{fontSize:'.78rem',color:'var(--text-3)',margin:'10px 0'}}>Checking what this stay needs…</div>
        : quoteError
          ? <div style={{fontSize:'.78rem',color:'var(--red)',margin:'10px 0'}}>{quoteError}</div>
          : q && (
            <div style={{border:'1px solid var(--border-1)',borderRadius:8,padding:'10px 12px',margin:'10px 0 14px',fontSize:'.8rem',display:'grid',gap:6}}>
              {!leaseInstead && <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
                <span style={{color:'var(--text-2)'}}>{q.depositOnly ? 'Lease deposit now — the lease bills the rest' : q.what}</span>
                <span className="mono">{fmt(Number(q.charge))}</span>
              </div>}
              {q.screeningFee && !leaseInstead && <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
                <span style={{color:'var(--text-2)'}}>{q.screeningLineName}</span><span className="mono">{fmt(Number(q.screeningFee))}</span>
              </div>}
              {q.screening === 'fee_due' && !leaseInstead && <div style={{fontSize:'.72rem',color:'var(--text-3)',lineHeight:1.45}}>
                {q.nights} nights in a row is more than three weeks, so a background check is required. Its fee goes on this sale and cannot be taken off; the link to fill it out is emailed to them, and check-in waits for the results and your decision.
              </div>}
              {q.screening === 'on_file' && <div style={{fontSize:'.72rem',color:'var(--text-3)',lineHeight:1.45}}>
                {q.nights} nights in a row — their background check is already on file or paid for, so nothing is added. Check-in waits for its results and your decision.
              </div>}
              {/* 10/6 (Nic): the third choice beside the check's fee — greyed with the reason when the property's allowance is used up. */}
              {q.returning && (q.screening === 'fee_due' || returning) && !leaseInstead && (q.returning.available
                ? <label style={{display:'flex',alignItems:'flex-start',gap:8,cursor:'pointer',fontSize:'.78rem'}}>
                    <input type="checkbox" checked={returning} onChange={e=>setReturning(e.target.checked)} style={{marginTop:3}} />
                    <span><b>{RETURNING_GUEST_LABEL}</b><br/>
                      <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>No background check and no fee — check-in won't wait on one. GAM records that you confirmed it.</span></span>
                  </label>
                : <div style={{fontSize:'.72rem',color:'var(--text-3)',opacity:.7,lineHeight:1.45}}>
                    <b style={{color:'var(--text-1)'}}>{RETURNING_GUEST_LABEL}</b> — {q.returning.message}
                  </div>)}
              {q.screening === 'returning' && <div style={{fontSize:'.72rem',color:'var(--text-3)',lineHeight:1.45}}>
                {q.nights} nights in a row — a returning guest, so no background check is needed.
              </div>}
              {q.leaseOrStayWords && (<>
                <div style={{color:'var(--text-2)',lineHeight:1.45}}>{q.nights} nights in a row — ask them: lease or no lease? {q.leaseOrStayWords}</div>
                <div style={{display:'flex',gap:16}}>
                  {STAY_TERMS.map(t => (
                    <label key={t} style={{display:'flex',alignItems:'center',gap:4,cursor:'pointer'}}>
                      <input type="radio" checked={stayTerms===t} onChange={()=>setStayTerms(t)} /> {STAY_TERMS_LABEL[t]}
                    </label>))}
                </div>
                {stayTerms === 'lease' && (leaseInstead
                  ? <div style={{fontSize:'.72rem',color:'var(--text-3)',lineHeight:1.45}}>{q.leaseInsteadWords}</div>
                  : <div style={{fontSize:'.72rem',color:'var(--text-3)',lineHeight:1.45}}>
                      A month-to-month lease is drafted for the owner to review and send. It bills from check-in by the property's rent settings.
                    </div>)}
                {q.heldWords && <div style={{fontSize:'.72rem',color:'var(--text-3)',lineHeight:1.45}}>{q.heldWords}</div>}
              </>)}
            </div>))}

      <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        {leaseInstead ? (
          <button className="btn btn-primary" disabled={!ready || draftLease.isLoading} onClick={()=>draftLease.mutate()}>
            {draftLease.isLoading ? 'Drafting…' : 'Draft their lease'}
          </button>
        ) : (
        <button className="btn btn-primary" disabled={!ready} title={isFetching || quote.isFetching ? 'Checking…' : undefined} onClick={()=>onDone({
          ...(mode === 'extend'
            ? { extendBookingId: extendId, unitId: q.unitId, checkIn: q.checkIn, guestName: pickedStay?.guestName || q.extend?.guestName || 'Guest',
                guestPhone: null, siteLabel: q.unitNumber, rate: null }
            : { unitId, checkIn, guestName: guestName.trim(), guestPhone: guestPhone.trim() || null,
                siteLabel: units.find((u:any)=>u.id===unitId)?.unitNumber ?? 'Site', rate: units.find((u:any)=>u.id===unitId)?.rate ?? null }),
          checkOut: q.checkOut,
          guestEmail: emailOk ? guestEmail.trim() : null,
          stayTerms: q.terms ?? stayTerms ?? null,
          // What the stay line charges (the stay, or a lease's deposit) and the lodging tax inside it.
          lineTotal: q.charge,
          lodgingTax: q.lodgingTax ?? 0,
          screeningFee: q.screeningFee ?? null,
          screeningLineName: q.screeningLineName,
          heldWords: q.heldWords ?? null,
          returningGuest: q.returningGuest === true,
        })}>{(isFetching && !!unitId) || quote.isFetching ? 'Checking…' : mode === 'extend' ? 'Add this month' : 'Use this site'}</button>
        )}
      </div>
    </>
  )
}


// S652: ask GAM for the supported card reader, shipped straight from Stripe.
function GetReaderCard({ propertyId, property }: { propertyId: string; property: any }) {
  const qc = useQueryClient()
  const { data: orders = [] } = useQuery<any[]>(['pos-reader-orders', propertyId], () => apiGet(`/pos/reader-orders?propertyId=${propertyId}`))
  const open = (orders as any[]).find(o => !['registered','cancelled'].includes(o.status))
  const [form, setForm] = useState(() => ({
    name: '', company: property?.name || '', line1: property?.street1 || '', line2: property?.street2 || '',
    city: property?.city || '', state: property?.state || '', zip: property?.zip || '', phone: '', email: '', note: '',
  }))
  const [showForm, setShowForm] = useState(false)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))
  const request = useMutation(
    () => apiPost('/pos/reader-orders', { propertyId, shipTo: {
      name: form.name, company: form.company || null, line1: form.line1, line2: form.line2 || null,
      city: form.city, state: form.state.toUpperCase(), zip: form.zip, phone: form.phone || null, email: form.email || null,
    }, note: form.note || null }),
    { onSuccess: () => { qc.invalidateQueries(['pos-reader-orders', propertyId]); setShowForm(false); toastOnce('Request sent — we order it and ship it to you') },
      onError: (e: any) => toastOnce(errorMessage(e, 'Could not send the request — check the connection and press Send again.'), { error: true }) })
  const cancel = useMutation((id: string) => apiPost(`/pos/reader-orders/${id}/cancel`, {}),
    { onSuccess: () => qc.invalidateQueries(['pos-reader-orders', propertyId]) })
  const pieces = SUPPORTED_CARD_READER.installments
  const piece = (SUPPORTED_CARD_READER.price / pieces).toFixed(2)
  return (
    <div className="card">
      <div className="card-header" style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
        <span className="card-title">Get a card reader</span>
        <span style={{ fontSize:'.75rem', color:'var(--text-3)' }}>{SUPPORTED_CARD_READER.label}</span>
      </div>
      {open ? (
        <div style={{ fontSize:'.82rem', color:'var(--text-2)', marginTop: 8 }}>
          <div><strong>{READER_ORDER_STATUS_LABEL[open.status as keyof typeof READER_ORDER_STATUS_LABEL]}</strong> — requested {new Date(open.createdAt).toLocaleDateString()}, shipping to {open.shipLine1}, {open.shipCity}.</div>
          {open.trackingUrl && <div style={{ marginTop: 4 }}><a href={open.trackingUrl} target="_blank" rel="noopener noreferrer" style={{ color:'var(--gold)' }}>Track the package</a></div>}
          <div style={{ fontSize:'.74rem', color:'var(--text-3)', marginTop: 6 }}>
            When it arrives: plug in power, connect it to your Wi-Fi (or the Ethernet dock). It appears under Active Readers on its own — nothing to type.
          </div>
          {open.status === 'requested' && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} disabled={cancel.isLoading} onClick={() => cancel.mutate(open.id)}>Cancel request</button>
          )}
        </div>
      ) : !showForm ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize:'.82rem', color:'var(--text-2)', lineHeight: 1.55 }}>
            {SUPPORTED_CARD_READER.blurb} We order it from Stripe already set up for this property and ship it straight to you.
          </div>
          <div style={{ fontSize:'.86rem', fontWeight: 700, marginTop: 8 }}>
            ${SUPPORTED_CARD_READER.price.toFixed(2)} — {pieces} monthly payments of ${piece}, taken from your payouts, each shown as its own line.
          </div>
          <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => setShowForm(true)}>Request a reader</button>
        </div>
      ) : (
        <div style={{ display:'grid', gap: 10, marginTop: 8 }}>
          <div style={{ fontSize:'.78rem', color:'var(--text-3)' }}>Where should it ship? A street address — no PO boxes.</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 10 }}>
            <div><div className="form-label">YOUR NAME</div><input className="form-input" style={{ width:'100%' }} value={form.name} onChange={e => set('name', e.target.value)} /></div>
            <div><div className="form-label">COMPANY (ON THE BOX)</div><input className="form-input" style={{ width:'100%' }} value={form.company} onChange={e => set('company', e.target.value)} /></div>
            <div style={{ gridColumn:'1/-1' }}><div className="form-label">STREET</div><input className="form-input" style={{ width:'100%' }} value={form.line1} onChange={e => set('line1', e.target.value)} /></div>
            <div style={{ gridColumn:'1/-1' }}><div className="form-label">STREET LINE 2</div><input className="form-input" style={{ width:'100%' }} value={form.line2} onChange={e => set('line2', e.target.value)} /></div>
            <div><div className="form-label">CITY</div><input className="form-input" style={{ width:'100%' }} value={form.city} onChange={e => set('city', e.target.value)} /></div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 10 }}>
              <div><div className="form-label">STATE</div><input className="form-input" style={{ width:'100%' }} maxLength={2} value={form.state} onChange={e => set('state', e.target.value.toUpperCase())} /></div>
              <div><div className="form-label">ZIP</div><input className="form-input" style={{ width:'100%' }} value={form.zip} onChange={e => set('zip', e.target.value)} /></div>
            </div>
            <div><div className="form-label">PHONE (FOR THE COURIER)</div><input className="form-input" style={{ width:'100%' }} value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
            <div><div className="form-label">EMAIL FOR SHIPPING UPDATES</div><input className="form-input" style={{ width:'100%' }} value={form.email} onChange={e => set('email', e.target.value)} /></div>
          </div>
          <div style={{ fontSize:'.8rem', color:'var(--text-2)' }}>
            You are asking for one {SUPPORTED_CARD_READER.label} at ${SUPPORTED_CARD_READER.price.toFixed(2)}, paid as {pieces} monthly payments of ${piece} from your payouts, on the 1st of each month after it ships.
          </div>
          <div style={{ display:'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Back</button>
            <button className="btn btn-primary" disabled={!form.name || !form.line1 || !form.city || form.state.length !== 2 || !/^\d{5}(-\d{4})?$/.test(form.zip) || request.isLoading}
              onClick={() => request.mutate()}>{request.isLoading ? 'Sending…' : 'Send the request'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
