/**
 * Agent chat — tenant portal.
 *
 * A floating support bubble (bottom-right, every page) + a full-page
 * version at /support, both sharing one ChatPanel. Talks to the agent
 * backend at POST /api/agent/chat (JWT auto-attached by lib/api). The
 * agent is presented as a real, named support person (Ava / Samantha) —
 * never as a bot. The conversation (and its server-side thread id) is
 * persisted in localStorage so it survives navigation/refresh.
 *
 * Theme tokens are the tenant set (--t0..--t3, --b0..--b2, --bg0..--bg4,
 * --gold). The landlord portal has a parallel component with its own token
 * names; keep the two in sync when editing.
 */

import { useState, useRef, useEffect } from 'react'
import { MessageCircle, Send, X, ChevronDown } from 'lucide-react'
import { apiPost } from '../lib/api'

interface AgentProfile {
  title: string
  c1: string
  c2: string
}

// Reviewable copy — the support team's public profiles. Edit freely.
const AGENT_PROFILES: Record<string, AgentProfile> = {
  Ava:      { title: 'Tenant Support',         c1: '#c9a227', c2: '#e6c45a' },
  Samantha: { title: 'Senior Tenant Support',  c1: '#b97f8f', c2: '#d8a0ad' },
  David:    { title: 'Landlord Support',        c1: '#3b6fb0', c2: '#5b8fd0' },
  Sonny:    { title: 'Senior Landlord Support', c1: '#3f8f6b', c2: '#5fb08a' },
}
const DEFAULT_AGENT = 'Ava'
const STORAGE_KEY = 'gam_tenant_agent_chat'
const GREETING =
  "Hi! I'm Ava with GAM support. Ask me anything about your rent, lease, payments, or a maintenance issue — happy to help."

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
          color: '#0a0b0e', fontWeight: 700, fontFamily: 'var(--font-d)', fontSize: size * 0.42,
        }}
      >
        {name.charAt(0)}
      </div>
      <span
        title="Online"
        style={{
          position: 'absolute', right: 0, bottom: 0, width: size * 0.28, height: size * 0.28,
          borderRadius: '50%', background: 'var(--green)', border: '2px solid var(--bg2)',
        }}
      />
    </div>
  )
}

/** The shared chat surface: profile header, message list, input. */
export function ChatPanel({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const [agent, setAgent] = useState(DEFAULT_AGENT)
  const [messages, setMessages] = useState<Msg[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Restore prior conversation (and its server thread id) on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw)
        if (Array.isArray(saved.messages)) setMessages(saved.messages)
        if (saved.conversationId) setConversationId(saved.conversationId)
        if (saved.agent) setAgent(saved.agent)
      }
    } catch { /* ignore corrupt cache */ }
  }, [])

  // Persist + autoscroll on every change.
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
      // Never surface system/infra language ("trouble reaching support") — it
      // gives away that this isn't a person. Stay human. The 180s server timeout
      // keeps the turn PENDING (the "…is looking into that" indicator) until the
      // model answers, so this fallback only fires on a genuine failure.
      const text =
        status === 429
          ? "You're sending messages a little quickly — give me just a moment and try again."
          : "Sorry, that one took me longer than expected — mind sending it to me once more?"
      setMessages((m) => [...m, { role: 'agent', text }])
    } finally {
      setSending(false)
    }
  }

  const p = profileFor(agent)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg2)' }}>
      {/* Header — the agent's profile card */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--b1)', background: 'var(--bg1)' }}>
        <Avatar name={agent} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--t0)', fontFamily: 'var(--font-d)', fontWeight: 600, fontSize: 15 }}>{agent}</div>
          <div style={{ color: 'var(--t2)', fontSize: 12 }}>{p.title} · <span style={{ color: 'var(--green)' }}>Online</span></div>
        </div>
        {onClose && (
          <button onClick={onClose} aria-label="Close chat" style={iconBtn}>
            {embedded ? <X size={18} /> : <ChevronDown size={18} />}
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Bubble role="agent" text={GREETING} agent={agent} />
        {messages.map((m, i) => <Bubble key={i} role={m.role} text={m.text} agent={agent} />)}
        {sending && <Working agent={agent} />}
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--b1)', background: 'var(--bg1)' }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Type your message…"
          rows={1}
          style={{
            flex: 1, resize: 'none', maxHeight: 96, padding: '9px 11px', borderRadius: 9,
            background: 'var(--bg3)', border: '1px solid var(--b1)', color: 'var(--t0)',
            fontFamily: 'var(--font-b)', fontSize: 14, outline: 'none',
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
          background: isUser ? 'var(--gold)' : 'var(--bg3)',
          color: isUser ? '#0a0b0e' : 'var(--t1)',
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', borderRadius: 12, background: 'var(--bg3)', color: 'var(--t2)', fontSize: 13, fontStyle: 'italic' }}>
        {agent} is looking into that
        <span className="agent-dots"><i /><i /><i /></span>
      </div>
    </div>
  )
}

/** Floating bubble + popup panel, mounted globally in the Layout. */
export function AgentChatWidget() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <style>{DOT_CSS}</style>
      {open && (
        <div style={{
          position: 'fixed', bottom: 88, right: 20, width: 380, maxWidth: 'calc(100vw - 40px)',
          height: 540, maxHeight: 'calc(100vh - 120px)', zIndex: 1000,
          borderRadius: 16, overflow: 'hidden', border: '1px solid var(--b2)',
          boxShadow: '0 18px 50px rgba(0,0,0,.5)',
        }}>
          <ChatPanel onClose={() => setOpen(false)} />
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

/** Full-page version at /support. */
export function SupportPage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <h1 style={{ color: 'var(--t0)', fontFamily: 'var(--font-d)', marginBottom: 4 }}>Support</h1>
      <p style={{ color: 'var(--t2)', marginBottom: 16 }}>Chat with the GAM support team — we're here to help.</p>
      <style>{DOT_CSS}</style>
      <div style={{ height: 'calc(100vh - 220px)', minHeight: 420, borderRadius: 14, overflow: 'hidden', border: '1px solid var(--b1)' }}>
        <ChatPanel embedded />
      </div>
    </div>
  )
}

const iconBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--t2)', cursor: 'pointer', padding: 4, display: 'flex' }
const sendBtn: React.CSSProperties = { width: 40, flexShrink: 0, borderRadius: 9, background: 'var(--gold)', color: '#0a0b0e', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }

const DOT_CSS = `
.agent-dots{display:inline-flex;gap:3px;margin-left:2px}
.agent-dots i{width:4px;height:4px;border-radius:50%;background:var(--t2);animation:agentdot 1.2s infinite ease-in-out}
.agent-dots i:nth-child(2){animation-delay:.2s}
.agent-dots i:nth-child(3){animation-delay:.4s}
@keyframes agentdot{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
`
