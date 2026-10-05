// 10/2 (Nic) — who a register sale is for: one typed flow, everywhere.
//
//   "it should be type their name, not a scroll down list. I can type in the
//    field to search and narrow down based on match or partial match... type
//    somebody's last name and have it pop up. One flow. If they aren't in the
//    system, I choose add new, from that flow."
//
// Used on the register, the panel after a sale, each History row and the pay
// link window. Shipped in BOTH register apps (apps/landlord and apps/pos) —
// byte-identical, enforced by apps/api/src/pos-parity.test.ts.
//
// The server decides who can be found (GET /pos/people): this property's
// residents and this company's customers by part of a name, email or phone —
// and (settled 10/2) everyone else on GAM by part of a name, or an email or
// phone typed whole, shown as a name and a masked hint only ("phone ••1234",
// "j•••@gmail.com"). Picking someone from
// elsewhere hands back the sealed pick the search gave out; the server makes
// (or finds) the record in this company. The screen never holds their id.
//
// 10/2 (review, "back out with one button and no side effects"): History and
// the pay-link window keep that pick on the chip and the record is made only
// when they write something (sealedPicks). The register needs a record at
// once (the reader, a ticket and the card on file name people by record), so
// one made by a pick there is let go again when the clerk takes the person back
// off before anything was sold (× or Clear).
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api, apiPost } from '../lib/api'
import { toast } from './dialogs'

// 10/2 (Nic, front desk foolproof): "As hand-holding as possible." The same
// message never stacks — one already on screen, or shown a moment ago, is not
// shown again. Every register, front-desk and pay-link message goes through here.
const lastShown = new Map<string, number>()
export function toastOnce(text: string, opts: { error?: boolean; id?: string } = {}): void {
  const key = opts.id ?? text
  const now = Date.now()
  for (const [k, at] of lastShown) if (now - at > 60_000) lastShown.delete(k)
  const recent = lastShown.get(key)
  const onScreen = typeof document !== 'undefined' && Array.from(document.querySelectorAll('[title="Click to dismiss"]'))
    .some(el => (el.firstElementChild?.textContent ?? '').trim() === text.trim())
  if (onScreen || (recent && now - recent < 4000)) { lastShown.set(key, now); return }
  lastShown.set(key, now)
  if (opts.error) toast.error(text); else toast(text)
}

/** What went wrong, in the server's own plain words — or, with no answer at all, what to press next. */
export function errorMessage(e: any, fallback: string): string {
  const raw = e?.response?.data?.error
  return (typeof raw === 'string' ? raw : raw?.message) || fallback
}

/** The person picked: a resident (by their tenant record) or a register customer. */
export interface PickedPerson {
  kind: 'resident' | 'customer'
  tenantId: string | null
  customerId: string | null
  name: string
  hint?: string | null
  email?: string | null
  phone?: string | null
  /** Someone from outside this company, not on this company's books yet: the sealed pick to hand the server. */
  pick?: string | null
  /** A record made just now by picking someone from elsewhere — let go again if they are taken off before anything is sold. */
  madeByPick?: boolean
}

export interface NewCustomerDraft { firstName: string; lastName: string; email: string; phone: string }

interface Hit {
  key: string
  kind: 'resident' | 'customer' | 'elsewhere'
  tenantId: string | null
  customerId: string | null
  name: string
  hint: string | null
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  /** Someone from elsewhere: handed back, unread, to pick them. */
  pick?: string
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/** The longest search the server takes (PEOPLE_QUERY_MAX); the box stops there. */
const MAX_TYPED = 120

/** What was typed, laid into the add-new form: words → first/last, '@' → email, digits → phone. */
export function draftFromTyped(typed: string): NewCustomerDraft {
  const t = typed.trim()
  if (t.includes('@')) return { firstName: '', lastName: '', email: t, phone: '' }
  const digits = t.replace(/\D/g, '')
  if (digits.length >= 3 && /^[\d\s()+.-]+$/.test(t)) return { firstName: '', lastName: '', email: '', phone: t }
  const words = t.split(/\s+/).filter(Boolean)
  return { firstName: words[0] ?? '', lastName: words.slice(1).join(' '), email: '', phone: '' }
}

/** The customer record the server answered with, as the picker's person. */
export function personFromCustomer(c: any, opts: { fromPick?: boolean } = {}): PickedPerson {
  const name = `${c?.firstName ?? ''} ${c?.lastName ?? ''}`.trim() || 'Customer'
  const resident = c?.kind === 'resident' || !!c?.tenantId
  return {
    kind: resident ? 'resident' : 'customer',
    tenantId: resident ? (c?.tenantId ?? null) : null,
    customerId: c?.id ?? null,
    name,
    hint: resident ? 'resident' : (c?.email || c?.phone || null),
    email: c?.email ?? null,
    phone: c?.phone ?? null,
    ...(opts.fromPick && !c?.existing && !resident && c?.id ? { madeByPick: true } : {}),
  }
}

/** A register record a pick made, let go again (the server keeps it if anything was written against it). */
function letGo(customerId: string): void {
  apiPost(`/pos/customers/${customerId}/let-go`, {}).catch(() => { /* best-effort: it stays */ })
}

export function POSCustomerPicker({ propertyId, value, onChange, onAddNew, sealedPicks, placeholder, disabled, autoFocus, busy }: {
  propertyId: string
  value: PickedPerson | null
  onChange: (p: PickedPerson | null) => void
  /** When given, "Add new customer" hands the typed details here instead of
   *  making the customer — History links a past sale and names them in one step. */
  onAddNew?: (draft: NewCustomerDraft) => void
  /** When given, someone found outside this company comes back as their sealed
   *  pick (PickedPerson.pick) and no record is made — the caller hands the pick
   *  to the server with whatever it writes (a link, a pay link). */
  sealedPicks?: boolean
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  /** The caller is saving what was picked. */
  busy?: boolean
}) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [hits, setHits] = useState<Hit[]>([])
  const [searching, setSearching] = useState(false)
  // 10/2 (review): a search that did not go through says so — it never reads
  // as "nobody by that name", which invites a second record for someone.
  const [searchError, setSearchError] = useState<string | null>(null)
  // Past the limit on looking at other companies, only this company's show.
  const [elsewhereLimited, setElsewhereLimited] = useState(false)
  const [active, setActive] = useState(0)
  const [draft, setDraft] = useState<NewCustomerDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const seq = useRef(0)

  // A record a pick made here, taken back off before anything was sold (× or
  // Clear), goes again. The server keeps it if a sale, ticket or link names it.
  const shown = useRef<PickedPerson | null>(value)
  useEffect(() => {
    const before = shown.current
    shown.current = value
    if (before?.madeByPick && before.customerId && before.customerId !== value?.customerId) letGo(before.customerId)
  }, [value])

  // Debounced search from two characters. A slower answer to an older
  // keystroke never replaces a newer one.
  useEffect(() => {
    const q = text.trim()
    if (q.length < 2 || !propertyId) { setHits([]); setSearching(false); setSearchError(null); setElsewhereLimited(false); return }
    const mine = ++seq.current
    setSearching(true)
    const timer = setTimeout(() => {
      api.get<{ data: Hit[]; elsewhereLimited?: boolean }>(`/pos/people?propertyId=${propertyId}&q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (seq.current !== mine) return
          setHits(Array.isArray(r.data?.data) ? r.data.data : []); setActive(0)
          setSearchError(null); setElsewhereLimited(!!r.data?.elsewhereLimited)
        })
        .catch((e) => {
          if (seq.current !== mine) return
          setHits([]); setElsewhereLimited(false)
          setSearchError(errorMessage(e, 'The search did not go through — check the connection, then type again.'))
        })
        .finally(() => { if (seq.current === mine) setSearching(false) })
    }, 250)
    return () => clearTimeout(timer)
  }, [text, propertyId])

  const reset = () => { setText(''); setHits([]); setOpen(false); setDraft(null); setActive(0); setSearchError(null); setElsewhereLimited(false) }

  const pick = async (h: Hit) => {
    if (h.kind === 'elsewhere' && sealedPicks) {
      // Kept as the sealed pick: nothing is made until the caller writes.
      reset()
      onChange({ kind: 'customer', tenantId: null, customerId: null, name: h.name, hint: h.hint, email: null, phone: null, pick: h.pick ?? null })
      return
    }
    if (h.kind === 'elsewhere') {
      // Someone from outside this company: a record of THIS company's is made
      // (or found) for them — their name, and only what was typed in full.
      setSaving(true)
      try {
        const r: any = await apiPost('/pos/customers', { propertyId, match: { pick: h.pick } })
        reset(); onChange(personFromCustomer(r?.data, { fromPick: true }))
      } catch (e) {
        toastOnce(errorMessage(e, 'They could not be added — check the connection, then type their name again and pick them.'), { error: true })
      } finally { setSaving(false) }
      return
    }
    reset()
    onChange({
      kind: h.kind, tenantId: h.kind === 'resident' ? h.tenantId : null, customerId: h.customerId,
      name: h.name, hint: h.hint, email: h.email, phone: h.phone,
    })
  }

  const startAdd = () => { setDraft(draftFromTyped(text)); setOpen(false) }

  const saveNew = async () => {
    if (!draft) return
    const d = { firstName: draft.firstName.trim(), lastName: draft.lastName.trim(), email: draft.email.trim(), phone: draft.phone.trim() }
    if (onAddNew) { reset(); onAddNew(d); return }
    setSaving(true)
    try {
      const r: any = await apiPost('/pos/customers', { propertyId, firstName: d.firstName, lastName: d.lastName || null,
        email: d.email || null, phone: d.phone || null })
      const p = personFromCustomer(r?.data)
      if (r?.data?.existing) toastOnce(`${p.name} is already here — picked them.`)
      reset(); onChange(p)
    } catch (e) {
      toastOnce(errorMessage(e, 'The customer could not be added — check the connection and press Add customer again.'), { error: true })
    } finally { setSaving(false) }
  }

  const rows = hits.length + 1   // the last row is always "Add new customer"
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, rows - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (!text.trim()) return
      if (active < hits.length) void pick(hits[active]); else startAdd()
    } else if (e.key === 'Escape') { setOpen(false) }
  }

  const working = saving || !!busy

  if (value) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: '1px solid var(--gold)',
        borderRadius: 'var(--r-md)', background: 'var(--gold-bg)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '.84rem', fontWeight: 700, color: 'var(--text-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value.name}</div>
          {value.hint && <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{value.hint}</div>}
        </div>
        <button type="button" aria-label="Remove customer" title="Remove customer" disabled={disabled || working}
          onClick={() => { onChange(null); setTimeout(() => inputRef.current?.focus(), 0) }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)', fontSize: '1rem', lineHeight: 1, padding: '2px 4px' }}>×</button>
      </div>
    )
  }

  if (draft) {
    const emailOk = !draft.email.trim() || EMAIL.test(draft.email.trim())
    return (
      <div style={{ display: 'grid', gap: 6, padding: '8px 10px', border: '1px solid var(--border-1)', borderRadius: 8 }}>
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>New customer</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="form-input" placeholder="First name" autoFocus value={draft.firstName} onChange={e => setDraft(d => d && ({ ...d, firstName: e.target.value }))} />
          <input className="form-input" placeholder="Last name" value={draft.lastName} onChange={e => setDraft(d => d && ({ ...d, lastName: e.target.value }))} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="form-input" type="email" placeholder="Email (optional)" value={draft.email} onChange={e => setDraft(d => d && ({ ...d, email: e.target.value }))} />
          <input className="form-input" type="tel" placeholder="Phone (optional)" value={draft.phone} onChange={e => setDraft(d => d && ({ ...d, phone: e.target.value }))} />
        </div>
        {!emailOk && <div style={{ fontSize: '.7rem', color: 'var(--red)' }}>That email does not look right.</div>}
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={!draft.firstName.trim() || !emailOk || working || disabled} onClick={() => void saveNew()}>
            {working ? 'Saving…' : 'Add customer'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={working} onClick={() => { setDraft(null); setTimeout(() => inputRef.current?.focus(), 0) }}>Cancel</button>
        </div>
      </div>
    )
  }

  const typed = text.trim()
  return (
    <div style={{ position: 'relative' }}>
      <input ref={inputRef} className="form-input" style={{ width: '100%' }} autoFocus={autoFocus} disabled={disabled || working}
        maxLength={MAX_TYPED}
        role="combobox" aria-expanded={open && !!typed} aria-autocomplete="list"
        placeholder={placeholder ?? 'Type a name, email or phone'}
        value={text}
        onChange={e => { setText(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKey} />
      {open && typed && (
        <div role="listbox" style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%', marginTop: 4, background: 'var(--bg-1)',
          border: '1px solid var(--border-1)', borderRadius: 8, maxHeight: 280, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
          {typed.length < 2 && <div style={{ padding: '8px 10px', fontSize: '.74rem', color: 'var(--text-3)' }}>Keep typing to search…</div>}
          {typed.length >= 2 && searching && !hits.length && !searchError && <div style={{ padding: '8px 10px', fontSize: '.74rem', color: 'var(--text-3)' }}>Searching…</div>}
          {typed.length >= 2 && !searching && searchError && (
            <div role="alert" style={{ padding: '8px 10px', fontSize: '.74rem', color: 'var(--red)', lineHeight: 1.45 }}>{searchError}</div>)}
          {typed.length >= 2 && !searching && !searchError && !hits.length && (
            <div style={{ padding: '8px 10px', fontSize: '.74rem', color: 'var(--text-3)', lineHeight: 1.45 }}>
              Nobody by that name yet. Keep typing, or press “Add new customer” below.
            </div>)}
          {typed.length >= 2 && !searchError && elsewhereLimited && (
            <div style={{ padding: '8px 10px', fontSize: '.72rem', color: 'var(--text-3)', lineHeight: 1.45, borderBottom: '1px solid var(--border-0)' }}>
              Only this company’s customers are showing for the next few minutes — too many searches in a row. If they are not listed, press “Add new customer” below.
            </div>)}
          {hits.map((h, i) => (
            <button key={h.key} type="button" role="option" aria-selected={i === active}
              onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => void pick(h)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', cursor: 'pointer', border: 'none',
                borderBottom: '1px solid var(--border-0)', color: 'var(--text-0)', background: i === active ? 'var(--gold-bg)' : 'transparent' }}>
              <div style={{ fontSize: '.84rem', fontWeight: 600 }}>{h.name}</div>
              {h.hint && <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{h.hint}</div>}
            </button>
          ))}
          <button type="button" role="option" aria-selected={active === hits.length}
            onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(hits.length)} onClick={startAdd}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', cursor: 'pointer', border: 'none',
              color: 'var(--gold)', fontWeight: 700, fontSize: '.82rem', background: active === hits.length ? 'var(--gold-bg)' : 'transparent' }}>
            + Add new customer{typed ? ` “${typed}”` : ''}
          </button>
        </div>
      )}
    </div>
  )
}
