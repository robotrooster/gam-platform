// 10/27 (Nic) — THE ONE SEARCH BAR, IN THE TOPBAR SO IT IS ON EVERY PAGE.
//
//   "if I'm just on the dashboard, I should have a search bar where I can
//    quickly type in this person's name or unit 5, and it will link to every
//    matching text across any page in the landlord portal... I can type John,
//    and every tenant I have named John will show up in a list, and I can just
//    have a quick shortcut type of situation."
//
// The reason it lives in the topbar rather than on the dashboard: he asked for
// it on the dashboard because that is where he was standing, but the problem
// he described — "they're not going to know that they need to go into this
// thing or this thing to find what they need" — is worst in the middle of the
// portal, not on its front page. One place, every page.
//
// Keyboard first, because it is a shortcut: ⌘K or Ctrl-K from anywhere opens
// it, arrows move, Enter opens, Escape closes. Somebody who has learned it
// never needs the mouse; somebody who has not sees a search box.

import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { apiGet } from '../../lib/api'

interface Hit {
  kind:  'resident' | 'space' | 'property' | 'lease'
  title: string
  where: string | null
  note:  string | null
  href:  string
}
interface Results { query: string; hits: Hit[]; truncated: boolean }

/** What each kind is called on screen — never the raw enum. */
const KIND_LABEL: Record<Hit['kind'], string> = {
  resident: 'Resident',
  space:    'Space',
  property: 'Property',
  lease:    'Lease',
}

export default function PortalSearch() {
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const [res, setRes] = React.useState<Results | null>(null)
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  // ⌘K / Ctrl-K from anywhere. The shortcut is the whole point for somebody
  // who already knows the portal; the visible box is for everybody else.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Click anywhere else and the list goes away.
  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // Debounced, and every in-flight answer is discarded if a newer keystroke
  // has happened — otherwise a slow early request lands on top of a fast later
  // one and the list shows results for something the box no longer says.
  React.useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setRes(null); setLoading(false); return }
    let dead = false
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const r = await apiGet<Results>(`/landlords/search?q=${encodeURIComponent(term)}`)
        if (dead) return
        setRes(r); setActive(0); setOpen(true)
      } catch {
        if (!dead) setRes(null)
      } finally {
        if (!dead) setLoading(false)
      }
    }, 180)
    return () => { dead = true; clearTimeout(t) }
  }, [q])

  const hits = res?.hits ?? []

  const go = (h: Hit) => {
    setOpen(false)
    setQ('')
    setRes(null)
    navigate(h.href)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return }
    if (!open || hits.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % hits.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + hits.length) % hits.length) }
    else if (e.key === 'Enter') { e.preventDefault(); const h = hits[active]; if (h) go(h) }
  }

  return (
    <div ref={boxRef} style={{ position:'relative', width:'min(420px, 42vw)' }}>
      <div style={{ position:'relative' }}>
        <Search
          size={14}
          style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)',
                   color:'var(--t3)', pointerEvents:'none' }}
        />
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          onFocus={() => { if (hits.length) setOpen(true) }}
          onKeyDown={onKeyDown}
          placeholder="Search residents, spaces, properties…"
          aria-label="Search the portal"
          style={{
            width:'100%', padding:'6px 10px 6px 26px', fontSize:'.8rem',
            borderRadius:8, border:'1px solid var(--line)',
            background:'var(--bg-2)', color:'var(--t1)',
          }}
        />
      </div>

      {open && q.trim().length >= 2 && (
        <div
          style={{
            position:'absolute', top:'calc(100% + 6px)', left:0, right:0, zIndex:300,
            background:'var(--bg-1)', border:'1px solid var(--line)', borderRadius:10,
            boxShadow:'0 10px 30px rgba(0,0,0,.35)', overflow:'hidden', maxHeight:'70vh', overflowY:'auto',
          }}
        >
          {loading && hits.length === 0 && (
            <div style={{ padding:'10px 12px', fontSize:'.78rem', color:'var(--t3)' }}>Looking…</div>
          )}
          {!loading && hits.length === 0 && (
            <div style={{ padding:'10px 12px', fontSize:'.78rem', color:'var(--t3)' }}>
              Nothing matches “{q.trim()}”.
            </div>
          )}
          {hits.map((h, i) => (
            <button
              key={`${h.kind}:${h.href}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(h)}
              style={{
                display:'block', width:'100%', textAlign:'left', border:'none',
                padding:'8px 12px', cursor:'pointer',
                background: i === active ? 'var(--bg-2)' : 'transparent',
                color:'var(--t1)',
              }}
            >
              <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
                <span style={{ fontSize:'.84rem', fontWeight:600 }}>{h.title}</span>
                <span style={{ fontSize:'.66rem', color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.04em' }}>
                  {KIND_LABEL[h.kind]}
                </span>
              </div>
              {(h.where || h.note) && (
                <div style={{ fontSize:'.74rem', color:'var(--t3)', marginTop:1 }}>
                  {[h.where, h.note].filter(Boolean).join(' · ')}
                </div>
              )}
            </button>
          ))}
          {res?.truncated && (
            <div style={{ padding:'7px 12px', fontSize:'.7rem', color:'var(--t3)', borderTop:'1px solid var(--line)' }}>
              More matches than this — keep typing to narrow it.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
