/**
 * Agent chat — landlord portal.
 *
 * A floating support bubble (every page) + a full-page version at
 * /support, sharing one ChatPanel. Talks to POST /api/agent/chat (JWT
 * auto-attached by lib/api). The agent is presented as a real, named
 * support person (David / Sonny) — never as a bot. Conversation + its
 * server thread id persist in localStorage.
 *
 * Parallel of apps/tenant/src/components/AgentChatWidget.tsx — same logic,
 * landlord theme tokens (--text-*, --border-*, --bg-*, --font-display/body).
 * Keep the two in sync when editing.
 */

import { useState, useRef, useEffect } from 'react'
import { MessageCircle, Send, X, ChevronDown } from 'lucide-react'
import { apiPost } from '../lib/api'

interface AgentProfile { title: string; c1: string; c2: string }

// Reviewable copy — the support team's public profiles. Edit freely.
const AGENT_PROFILES: Record<string, AgentProfile> = {
  David:    { title: 'Landlord Support',        c1: '#3b6fb0', c2: '#5b8fd0' },
  Sonny:    { title: 'Senior Landlord Support', c1: '#3f8f6b', c2: '#5fb08a' },
  Ava:      { title: 'Tenant Support',          c1: '#c9a227', c2: '#e6c45a' },
  Samantha: { title: 'Senior Tenant Support',   c1: '#b97f8f', c2: '#d8a0ad' },
}
const DEFAULT_AGENT = 'David'
const STORAGE_KEY = 'gam_landlord_agent_chat'
const GREETING =
  "Hi! I'm David with GAM support. Ask me anything about your payouts, occupancy, billing, or day-to-day operations — happy to help."

interface Msg { role: 'user' | 'agent'; text: string }

function profileFor(name: string): AgentProfile {
  return AGENT_PROFILES[name] || AGENT_PROFILES[DEFAULT_AGENT]
}

function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const p = profileFor(name)
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div
        style={{
          width: size, height: size, borderRadius: '50%',
          background: `linear-gradient(135deg, ${p.c1}, ${p.c2})`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#0a0b0e', fontWeight: 700, fontFamily: 'var(--font-display)', fontSize: size * 0.42,
        }}
      >
        {name.charAt(0)}
      </div>
      <span
        title="Online"
        style={{
          position: 'absolute', right: 0, bottom: 0, width: size * 0.28, height: size * 0.28,
          borderRadius: '50%', background: 'var(--green)', border: '2px solid var(--bg-2)',
        }}
      />
    </div>
  )
}

export function ChatPanel({ onClose, embedded = false, initialInput }: { onClose?: () => void; embedded?: boolean; initialInput?: string }) {
  const [agent, setAgent] = useState(DEFAULT_AGENT)
  const [messages, setMessages] = useState<Msg[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  // Prefill (never auto-send) when opened from a "Start walkthrough"-style CTA;
  // the landlord reviews the suggested message and sends it themselves.
  useEffect(() => { if (initialInput) setInput(initialInput) }, [initialInput])
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw)
        if (Array.isArray(saved.messages)) setMessages(saved.messages)
        if (saved.conversationId) setConversationId(saved.conversationId)
        if (saved.agent) setAgent(saved.agent)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, conversationId, agent })) } catch { /* quota */ }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, conversationId, agent, sending])

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text }])
    setSending(true)
    try {
      const res = await apiPost<any>('/agent/chat', conversationId ? { message: text, conversationId } : { message: text })
      const d = res.data
      if (d?.handledBy?.name) setAgent(d.handledBy.name)
      if (d?.conversationId) setConversationId(d.conversationId)
      setMessages((m) => [...m, { role: 'agent', text: d?.reply || "Sorry, I didn't catch that — could you say it another way?" }])
    } catch (e: any) {
      const status = e?.response?.status
      // No system/infra language — it gives away that this isn't a person. The
      // 180s server timeout keeps the turn pending until the model answers, so
      // this only fires on a genuine failure.
      const msg =
        status === 429
          ? "You're sending messages a little quickly — give me just a moment and try again."
          : "Sorry, that one took me longer than expected — mind sending it to me once more?"
      setMessages((m) => [...m, { role: 'agent', text: msg }])
    } finally {
      setSending(false)
    }
  }

  const p = profileFor(agent)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border-1)', background: 'var(--bg-1)' }}>
        <Avatar name={agent} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--text-0)', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15 }}>{agent}</div>
          <div style={{ color: 'var(--text-2)', fontSize: 12 }}>{p.title} · <span style={{ color: 'var(--green)' }}>Online</span></div>
        </div>
        {onClose && (
          <button onClick={onClose} aria-label="Close chat" style={iconBtn}>
            {embedded ? <X size={18} /> : <ChevronDown size={18} />}
          </button>
        )}
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Bubble role="agent" text={GREETING} agent={agent} />
        {messages.map((m, i) => <Bubble key={i} role={m.role} text={m.text} agent={agent} />)}
        {sending && <Working agent={agent} />}
      </div>

      <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border-1)', background: 'var(--bg-1)' }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Type your message…"
          rows={1}
          style={{
            flex: 1, resize: 'none', maxHeight: 96, padding: '9px 11px', borderRadius: 9,
            background: 'var(--bg-3)', border: '1px solid var(--border-1)', color: 'var(--text-0)',
            fontFamily: 'var(--font-body)', fontSize: 14, outline: 'none',
          }}
        />
        <button onClick={send} disabled={!input.trim() || sending} aria-label="Send" style={sendBtn}>
          <Send size={17} />
        </button>
      </div>
    </div>
  )
}

function Bubble({ role, text, agent }: { role: 'user' | 'agent'; text: string; agent: string }) {
  const isUser = role === 'user'
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexDirection: isUser ? 'row-reverse' : 'row' }}>
      {!isUser && <Avatar name={agent} size={26} />}
      <div
        style={{
          maxWidth: '78%', padding: '9px 12px', borderRadius: 12, fontSize: 14, lineHeight: 1.45,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: isUser ? 'var(--gold)' : 'var(--bg-3)',
          color: isUser ? '#0a0b0e' : 'var(--text-1)',
          borderBottomRightRadius: isUser ? 3 : 12, borderBottomLeftRadius: isUser ? 12 : 3,
        }}
      >
        {text}
      </div>
    </div>
  )
}

function Working({ agent }: { agent: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Avatar name={agent} size={26} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', borderRadius: 12, background: 'var(--bg-3)', color: 'var(--text-2)', fontSize: 13, fontStyle: 'italic' }}>
        {agent} is looking into that
        <span className="agent-dots"><i /><i /><i /></span>
      </div>
    </div>
  )
}

// Open the assistant (optionally prefilled) from anywhere in the app, e.g. a
// "Start guided walkthrough" CTA. The ChatWidget listens for this event.
export function openAssistant(prefill?: string) {
  window.dispatchEvent(new CustomEvent('gam:open-assistant', { detail: { prefill } }))
}

export function ChatWidget() {
  const [open, setOpen] = useState(false)
  const [prefill, setPrefill] = useState<string | undefined>()
  useEffect(() => {
    const handler = (e: Event) => { setPrefill((e as CustomEvent).detail?.prefill); setOpen(true) }
    window.addEventListener('gam:open-assistant', handler)
    return () => window.removeEventListener('gam:open-assistant', handler)
  }, [])
  return (
    <>
      <style>{DOT_CSS}</style>
      {open && (
        <div style={{
          position: 'fixed', bottom: 88, right: 20, width: 380, maxWidth: 'calc(100vw - 40px)',
          height: 540, maxHeight: 'calc(100vh - 120px)', zIndex: 1000,
          borderRadius: 16, overflow: 'hidden', border: '1px solid var(--border-2)',
          boxShadow: '0 18px 50px rgba(0,0,0,.5)',
        }}>
          <ChatPanel onClose={() => setOpen(false)} initialInput={prefill} />
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close support chat' : 'Open support chat'}
        style={{
          position: 'fixed', bottom: 20, right: 20, width: 56, height: 56, borderRadius: '50%',
          background: 'var(--gold)', color: '#0a0b0e', border: 'none', cursor: 'pointer', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 8px 24px rgba(0,0,0,.45)',
        }}
      >
        {open ? <ChevronDown size={24} /> : <MessageCircle size={24} />}
      </button>
    </>
  )
}

export function SupportPage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <h1 style={{ color: 'var(--text-0)', fontFamily: 'var(--font-display)', marginBottom: 4 }}>Support</h1>
      <p style={{ color: 'var(--text-2)', marginBottom: 16 }}>Chat with the GAM support team — we're here to help.</p>
      <style>{DOT_CSS}</style>
      <div style={{ height: 'calc(100vh - 220px)', minHeight: 420, borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border-1)' }}>
        <ChatPanel embedded />
      </div>
    </div>
  )
}

const iconBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--text-2)', cursor: 'pointer', padding: 4, display: 'flex' }
const sendBtn: React.CSSProperties = { width: 40, flexShrink: 0, borderRadius: 9, background: 'var(--gold)', color: '#0a0b0e', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }

const DOT_CSS = `
.agent-dots{display:inline-flex;gap:3px;margin-left:2px}
.agent-dots i{width:4px;height:4px;border-radius:50%;background:var(--text-2);animation:agentdot 1.2s infinite ease-in-out}
.agent-dots i:nth-child(2){animation-delay:.2s}
.agent-dots i:nth-child(3){animation-delay:.4s}
@keyframes agentdot{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
`
