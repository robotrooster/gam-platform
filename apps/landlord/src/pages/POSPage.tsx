import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Plus, X, Check, Search, ShoppingCart, DollarSign, CreditCard, Zap, MoreVertical, Edit2, Trash2, RefreshCw } from 'lucide-react'
import { formatCurrency } from '@gam/shared'

const SURCHARGE = 0.03
const CHARGE_FEE = 0.01

const ITEMS = [
  { id:1,  name:'Propane 20lb',    price:24.99, icon:'⛽', cat:'fuel',     tax:.08, charge:true },
  { id:2,  name:'Propane Refill',  price:14.99, icon:'🔧', cat:'fuel',     tax:.08, charge:true },
  { id:3,  name:'Firewood Bundle', price:8.99,  icon:'🪵', cat:'amenity',  tax:.08, charge:true },
  { id:4,  name:'Firewood Box',    price:24.99, icon:'🔥', cat:'amenity',  tax:.08, charge:true },
  { id:5,  name:'Ice Bag 10lb',    price:3.99,  icon:'🧊', cat:'misc',     tax:.08, charge:true },
  { id:6,  name:'Washer Load',     price:2.50,  icon:'🧺', cat:'laundry',  tax:0,   charge:true },
  { id:7,  name:'Dryer Load',      price:2.00,  icon:'🌀', cat:'laundry',  tax:0,   charge:true },
  { id:8,  name:'Parking Day',     price:10.00, icon:'🅿️', cat:'parking',  tax:0,   charge:true },
  { id:9,  name:'Parking Month',   price:75.00, icon:'🚗', cat:'parking',  tax:0,   charge:true },
  { id:10, name:'Late Fee',        price:75.00, icon:'⏰', cat:'fee',      tax:0,   charge:false },
  { id:11, name:'Key Replace',     price:25.00, icon:'🔑', cat:'fee',      tax:0,   charge:false },
  { id:12, name:'Pool Pass Day',   price:5.00,  icon:'🏊', cat:'amenity',  tax:0,   charge:true },
  { id:13, name:'Early Check-in',  price:35.00, icon:'🌅', cat:'amenity',  tax:.08, charge:false },
  { id:14, name:'Late Checkout',   price:35.00, icon:'🌆', cat:'amenity',  tax:.08, charge:false },
  { id:15, name:'Pet Fee Daily',   price:15.00, icon:'🐾', cat:'fee',      tax:0,   charge:true },
  { id:16, name:'Cleaning Fee',    price:85.00, icon:'🧹', cat:'fee',      tax:.08, charge:false },
]

const CATS = ['all','fuel','amenity','laundry','parking','fee','misc']

export function POSPage() {
  const [cart, setCart] = useState<any[]>([])
  const [cat, setCat] = useState('all')
  const [search, setSearch] = useState('')
  const [tenant, setTenant] = useState<any>(null)
  const [isWalkin, setIsWalkin] = useState(false)
  const [payMethod, setPayMethod] = useState<'card'|'cash'|'charge'>('card')
  const [showCash, setShowCash] = useState(false)
  const [cashEntry, setCashEntry] = useState('')
  const [showReceipt, setShowReceipt] = useState<any>(null)
  const [contextMenu, setContextMenu] = useState<{item:any,x:number,y:number}|null>(null)
  const qc = useQueryClient()
  const [drawerBalance, setDrawerBalance] = useState(250)
  const [stats, setStats] = useState({ cash:0, card:0, charge:0, txCount:0 })
  const [flash, setFlash] = useState('')
  useEffect(() => {
    if (payMethod === 'charge' && tenant && !activeChargeSet.has(tenant.id)) setTenant(null)
  }, [payMethod])

  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const { data: posItems = [] } = useQuery<any[]>('pos-items', () => apiGet('/pos/items'))
  const { data: posCats = [] } = useQuery<any[]>('pos-cats', () => apiGet('/pos/categories'))
  const { data: chargeAccounts = [] } = useQuery<any[]>('flex-charge-accounts', () => apiGet('/landlords/flexcharge'))
  const tenants = (units as any[]).filter(u => u.tenant_first).map(u => ({
    id: u.tenant_id, name: `${u.tenant_first} ${u.tenant_last}`,
    unit: u.unit_number, property: u.property_name,
    initials: `${u.tenant_first[0]}${u.tenant_last?.[0]||''}`,
    balance: 0, limit: 100,
  }))

  const activeChargeSet = new Set((chargeAccounts as any[]).filter((a:any) => a.status === 'active').map((a:any) => a.tenant_id))
  const searchableTenants = payMethod === 'charge' ? tenants.filter(t => activeChargeSet.has(t.id)) : tenants

  const filteredTenants = search && !isWalkin
    ? searchableTenants.filter(t => t.name.toLowerCase().includes(search.toLowerCase()) || t.unit.includes(search))
    : []

  const items = ITEMS.filter(i => (cat === 'all' || i.cat === cat))

  const getSubtotal = () => cart.reduce((s,i) => s + i.price * i.qty, 0)
  const getTax = () => cart.reduce((s,i) => s + i.price * i.qty * i.tax, 0)
  const getSurcharge = () => payMethod === 'card' ? (getSubtotal() + getTax()) * SURCHARGE : 0
  const getTotal = () => getSubtotal() + getTax() + getSurcharge()

  const addItem = (item: any) => {
    setCart(c => {
      const ex = c.find(x => x.id === item.id)
      if (ex) return c.map(x => x.id === item.id ? {...x, qty: x.qty+1} : x)
      return [...c, {...item, qty:1}]
    })
  }
  const removeItem = (id: number) => {
    setCart(c => {
      const ex = c.find(x => x.id === id)
      if (ex?.qty === 1) return c.filter(x => x.id !== id)
      return c.map(x => x.id === id ? {...x, qty: x.qty-1} : x)
    })
  }
  const clearCart = () => setCart([])

  const showFlash = (msg: string) => {
    setFlash(msg)
    setTimeout(() => setFlash(''), 2100)
  }

  const completeTransaction = (method: string, change = 0) => {
    const total = getTotal()
    const subtotal = getSubtotal()
    const tax = getTax()
    const surcharge = getSurcharge()
    const ts = new Date().toLocaleString()

    setStats(s => ({
      ...s,
      txCount: s.txCount + 1,
      cash: method === 'cash' ? s.cash + total : s.cash,
      card: method === 'card' ? s.card + total : s.card,
      charge: method === 'charge' ? s.charge + subtotal : s.charge,
    }))
    if (method === 'cash') setDrawerBalance(b => b + total)

    setShowReceipt({ items: [...cart], total, subtotal, tax, surcharge, method, change, tenant, ts })
    clearCart()
    setShowCash(false)
    setCashEntry('')
  }

  const tendered = parseFloat(cashEntry || '0') / 100
  const change = tendered - getTotal()
  const canCharge = cart.length > 0 && tenant && cart.every(i => i.charge) && payMethod === 'charge' && activeChargeSet.has(tenant?.id)

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 112px)', overflow:'hidden' }}>

      {/* Flash */}
      {flash && (
        <div style={{ position:'fixed', top:70, left:'50%', transform:'translateX(-50%)', background:'rgba(30,219,122,.15)', border:'1px solid rgba(30,219,122,.3)', borderRadius:10, padding:'10px 20px', fontSize:'.82rem', fontWeight:600, color:'var(--green)', zIndex:200, whiteSpace:'nowrap' }}>
          {flash}
        </div>
      )}

      {/* Stats bar */}
      <div style={{ display:'flex', gap:20, padding:'6px 0', borderBottom:'1px solid var(--border-0)', fontSize:'.68rem', fontFamily:'var(--font-mono)', color:'var(--text-3)', flexShrink:0 }}>
        <span>Drawer: <span style={{color:'var(--text-1)'}}>{formatCurrency(drawerBalance)}</span></span>
        <span>Cash: <span style={{color:'var(--text-1)'}}>{formatCurrency(stats.cash)}</span></span>
        <span>Card: <span style={{color:'var(--text-1)'}}>{formatCurrency(stats.card)}</span></span>
        <span>Charge: <span style={{color:'var(--text-1)'}}>{formatCurrency(stats.charge)}</span></span>
        <span>Txns: <span style={{color:'var(--text-1)'}}>{stats.txCount}</span></span>
        <span style={{marginLeft:'auto', color:'var(--amber)', fontSize:'.65rem'}}>💡 Cash Discount Program — 3% fee on card payments</span>
      </div>

      <div style={{ flex:1, display:'grid', gridTemplateColumns:'1fr 360px', overflow:'hidden', gap:0 }}>

        {/* LEFT: Items */}
        <div style={{ display:'flex', flexDirection:'column', overflow:'hidden', borderRight:'1px solid var(--border-0)', paddingRight:16 }}>

          {/* Customer bar */}
          <div style={{ padding:'10px 0', borderBottom:'1px solid var(--border-0)', flexShrink:0 }}>
            <div style={{ display:'flex', gap:8, marginBottom: filteredTenants.length > 0 ? 8 : 0 }}>
              <div style={{ flex:1, position:'relative' }}>
                <Search size={13} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--text-3)' }} />
                <input
                  className="input" placeholder="Search tenant by name or unit…"
                  value={search} onChange={e => setSearch(e.target.value)}
                  disabled={isWalkin}
                  style={{ width:'100%', paddingLeft:30, fontSize:'.8rem' }}
                />
              </div>
              <button
                className={`btn btn-sm ${isWalkin ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => { setIsWalkin(v => !v); setTenant(null); setSearch('') }}
                style={{ whiteSpace:'nowrap' }}
              >
                {isWalkin ? '✓ Walk-in' : 'Walk-in'}
              </button>
            </div>

            {/* Tenant dropdown */}
            {filteredTenants.length > 0 && (
              <div style={{ background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:8, overflow:'hidden' }}>
                {filteredTenants.slice(0,5).map(t => (
                  <div key={t.id} onClick={() => { setTenant(t); setSearch('') }} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', cursor:'pointer', borderBottom:'1px solid var(--border-0)' }}
                    onMouseEnter={e => (e.currentTarget.style.background='var(--bg-3)')}
                    onMouseLeave={e => (e.currentTarget.style.background='')}>
                    <div style={{ width:28, height:28, borderRadius:6, background:'linear-gradient(135deg,var(--gold-dark),var(--gold))', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'.65rem', fontWeight:800, color:'var(--bg-0)' }}>{t.initials}</div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:'.78rem', fontWeight:600, color:'var(--text-0)' }}>{t.name}</div>
                      <div style={{ fontSize:'.65rem', color:'var(--text-3)' }}>Unit {t.unit} · {t.property}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Tenant card */}
            {tenant && (
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', background:'rgba(201,162,39,.06)', border:'1px solid rgba(201,162,39,.2)', borderRadius:8, marginTop:8 }}>
                <div style={{ width:30, height:30, borderRadius:6, background:'linear-gradient(135deg,var(--gold-dark),var(--gold))', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'.65rem', fontWeight:800, color:'var(--bg-0)' }}>{tenant.initials}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:'.8rem', fontWeight:600, color:'var(--text-0)' }}>{tenant.name}</div>
                  <div style={{ fontSize:'.65rem', color:'var(--text-3)' }}>Unit {tenant.unit}{payMethod==='charge'&&activeChargeSet.has(tenant.id)?' · ⚡ Charge active':''}</div>
                </div>
                <button onClick={() => setTenant(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:4 }}><X size={13} /></button>
              </div>
            )}
          </div>

          {/* Category tabs */}
          <div style={{ display:'flex', gap:6, padding:'8px 0', overflowX:'auto', flexShrink:0 }}>
            {CATS.map(c => (
              <button key={c} onClick={() => setCat(c)} className={`btn btn-sm ${cat===c ? 'btn-primary' : 'btn-ghost'}`} style={{ whiteSpace:'nowrap', textTransform:'capitalize', fontSize:'.7rem' }}>
                {c}
              </button>
            ))}
          </div>

          {/* Items grid */}
          <div style={{ flex:1, overflowY:'auto', display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))', gap:8, alignContent:'start', paddingBottom:16 }}>
            {items.map(item => (
              <div key={item.id} onClick={() => addItem(item)} style={{ background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10, padding:'12px 10px', cursor:'pointer', transition:'all .12s', position:'relative', userSelect:'none' }}
                onMouseEnter={e => { (e.currentTarget as any).style.background='var(--bg-3)'; (e.currentTarget as any).style.transform='translateY(-1px)' }}
                onMouseLeave={e => { (e.currentTarget as any).style.background='var(--bg-2)'; (e.currentTarget as any).style.transform='' }}
                onMouseDown={e => (e.currentTarget as any).style.transform='scale(.97)'}
                onMouseUp={e => (e.currentTarget as any).style.transform='translateY(-1px)'}
              >
                <button onClick={e => { e.stopPropagation(); setContextMenu({ item, x: e.clientX, y: e.clientY }) }} style={{ position:'absolute', top:4, right:4, background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:3, borderRadius:4, opacity:.6, lineHeight:0 }} onMouseEnter={e => (e.currentTarget as any).style.opacity=1} onMouseLeave={e => (e.currentTarget as any).style.opacity=.6}><MoreVertical size={12} /></button>
                {item.charge && <span style={{ position:'absolute', bottom:6, right:6, fontSize:'.55rem', opacity:.5 }}>⚡</span>}
                <div style={{ fontSize:'1.4rem', marginBottom:6 }}>{item.icon}</div>
                <div style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-0)', marginBottom:3, lineHeight:1.3 }}>{item.name}</div>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:'.78rem', color:'var(--gold)' }}>{formatCurrency(item.price)}</div>
                {payMethod === 'card' && <div style={{ fontSize:'.6rem', color:'var(--blue)', marginTop:1 }}>+3% = {formatCurrency(item.price*1.03)}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT: Cart */}
        <div style={{ display:'flex', flexDirection:'column', paddingLeft:16, overflow:'hidden' }}>

          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 0', borderBottom:'1px solid var(--border-0)', flexShrink:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <ShoppingCart size={15} style={{ color:'var(--text-3)' }} />
              <span style={{ fontFamily:'var(--font-display)', fontSize:'.85rem', fontWeight:700, color:'var(--text-0)' }}>Order</span>
              <span style={{ fontSize:'.65rem', padding:'1px 7px', borderRadius:10, background:'rgba(201,162,39,.12)', border:'1px solid rgba(201,162,39,.2)', color:'var(--gold)' }}>
                {cart.reduce((s,i) => s+i.qty, 0)} items
              </span>
            </div>
            <button onClick={clearCart} style={{ background:'none', border:'none', cursor:'pointer', fontSize:'.68rem', color:'var(--text-3)' }}>Clear</button>
          </div>

          {/* Cart items */}
          <div style={{ flex:1, overflowY:'auto' }}>
            {cart.length === 0 ? (
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:8, color:'var(--text-3)' }}>
                <ShoppingCart size={32} style={{ opacity:.2 }} />
                <div style={{ fontSize:'.78rem', opacity:.5 }}>Add items to begin</div>
              </div>
            ) : (
              <div style={{ padding:'8px 0' }}>
                {cart.map(item => (
                  <div key={item.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 0', borderBottom:'1px solid var(--border-0)' }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:'.78rem', color:'var(--text-0)', fontWeight:500 }}>{item.icon} {item.name}</div>
                      <div style={{ fontSize:'.65rem', color:'var(--text-3)' }}>{formatCurrency(item.price)} each{item.charge?' ⚡':''}</div>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                      <button onClick={() => removeItem(item.id)} style={{ width:20, height:20, borderRadius:4, border:'1px solid var(--border-0)', background:'var(--bg-3)', cursor:'pointer', color:'var(--text-1)', fontSize:'.85rem', display:'flex', alignItems:'center', justifyContent:'center' }}>−</button>
                      <span style={{ fontFamily:'var(--font-mono)', fontSize:'.75rem', width:16, textAlign:'center' }}>{item.qty}</span>
                      <button onClick={() => addItem(item)} style={{ width:20, height:20, borderRadius:4, border:'1px solid var(--border-0)', background:'var(--bg-3)', cursor:'pointer', color:'var(--text-1)', fontSize:'.85rem', display:'flex', alignItems:'center', justifyContent:'center' }}>+</button>
                    </div>
                    <div style={{ fontFamily:'var(--font-mono)', fontSize:'.78rem', minWidth:48, textAlign:'right' }}>{formatCurrency(item.price*item.qty)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Totals */}
          {cart.length > 0 && (
            <div style={{ borderTop:'1px solid var(--border-0)', padding:'10px 0', flexShrink:0 }}>
              {[
                { label:'Subtotal', val: formatCurrency(getSubtotal()) },
                { label:'Tax', val: formatCurrency(getTax()) },
                ...(payMethod==='card' ? [{ label:'Card processing (3%)', val:`+${formatCurrency(getSurcharge())}`, amber:true }] : []),
              ].map((r:any) => (
                <div key={r.label} style={{ display:'flex', justifyContent:'space-between', fontSize:'.73rem', padding:'2px 0' }}>
                  <span style={{ color: r.amber ? 'var(--amber)' : 'var(--text-3)' }}>{r.label}</span>
                  <span style={{ fontFamily:'var(--font-mono)', color: r.amber ? 'var(--amber)' : 'var(--text-1)' }}>{r.val}</span>
                </div>
              ))}
              <div style={{ display:'flex', justifyContent:'space-between', borderTop:'1px solid var(--border-0)', marginTop:6, paddingTop:6 }}>
                <span style={{ fontWeight:700, color:'var(--text-0)', fontSize:'.82rem' }}>Total</span>
                <span style={{ fontFamily:'var(--font-mono)', fontWeight:700, color:'var(--text-0)', fontSize:'1rem' }}>{formatCurrency(getTotal())}</span>
              </div>

              {/* Charge account notice */}
              {payMethod === 'charge' && tenant && (
                <div style={{ marginTop:8, padding:'6px 10px', background:'rgba(201,162,39,.06)', border:'1px solid rgba(201,162,39,.2)', borderRadius:7, fontSize:'.65rem', color:'var(--gold)', lineHeight:1.5 }}>
                  ⚡ 1% platform fee ({formatCurrency(getSubtotal()*CHARGE_FEE)}) applied at month-end settlement.
                </div>
              )}
            </div>
          )}

          {/* Payment method pills */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:8, flexShrink:0 }}>
            {(['card','cash','charge'] as const).map(m => (
              <button key={m} onClick={() => setPayMethod(m)} style={{
                padding:'8px 6px', borderRadius:8, border:`1px solid ${payMethod===m ? (m==='card'?'rgba(74,158,255,.4)':m==='cash'?'rgba(30,219,122,.4)':'rgba(201,162,39,.4)') : 'var(--border-0)'}`,
                background: payMethod===m ? (m==='card'?'rgba(74,158,255,.08)':m==='cash'?'rgba(30,219,122,.08)':'rgba(201,162,39,.08)') : 'var(--bg-2)',
                color: payMethod===m ? (m==='card'?'var(--blue)':m==='cash'?'var(--green)':'var(--gold)') : 'var(--text-3)',
                cursor:'pointer', fontSize:'.68rem', fontWeight:600, transition:'all .12s',
                display:'flex', flexDirection:'column', alignItems:'center', gap:2,
              }}>
                <span>{m==='card'?'💳':m==='cash'?'💵':'⚡'}</span>
                <span style={{ textTransform:'capitalize' }}>{m==='card'?'Card +3%':m==='cash'?'Cash':'Charge Acct'}</span>
              </button>
            ))}
          </div>

          {/* Pay button */}
          <button
            disabled={cart.length === 0 || (payMethod==='charge' && !canCharge)}
            onClick={() => {
              if (payMethod === 'cash') { setShowCash(true); setCashEntry('') }
              else if (payMethod === 'card') { showFlash('💳 Processing via Stripe Terminal…'); setTimeout(() => completeTransaction('card'), 800) }
              else if (canCharge) completeTransaction('charge')
            }}
            style={{ padding:'13px', borderRadius:10, border:'none', background: cart.length===0 ? 'var(--bg-3)' : 'linear-gradient(135deg,var(--gold-dark),var(--gold))', color: cart.length===0 ? 'var(--text-3)' : 'var(--bg-0)', fontWeight:700, fontSize:'.88rem', cursor: cart.length===0 ? 'not-allowed' : 'pointer', fontFamily:'var(--font-display)', flexShrink:0 }}
          >
            {cart.length === 0 ? 'Add items to begin' :
             payMethod==='card' ? `💳 Charge Card — ${formatCurrency(getTotal())}` :
             payMethod==='cash' ? `💵 Accept Cash — ${formatCurrency(getTotal())}` :
             canCharge ? `⚡ Post to Account — ${formatCurrency(getSubtotal())}` :
             tenant ? 'Some items not charge-eligible' : 'Select tenant for charge account'}
          </button>
        </div>
      </div>

      {contextMenu && (
        <div style={{ position:'fixed', inset:0, zIndex:300 }} onClick={() => setContextMenu(null)}>
          <div style={{ position:'fixed', top: contextMenu.y, left: contextMenu.x, background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10, padding:6, minWidth:160, boxShadow:'0 8px 32px rgba(0,0,0,.4)', zIndex:301 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize:'.72rem', fontWeight:700, color:'var(--text-3)', padding:'4px 10px 8px', borderBottom:'1px solid var(--border-0)', marginBottom:4 }}>{contextMenu.item.icon} {contextMenu.item.name}</div>
            {[
              { icon: <Edit2 size={12}/>, label:'Edit in Inventory', action: () => { window.location.href = '/inventory?edit=' + contextMenu!.item.id; setContextMenu(null) } },
              { icon: <RefreshCw size={12}/>, label:'Adjust stock', action: () => { window.location.href = '/inventory?adjust=' + contextMenu!.item.id; setContextMenu(null) } },
              { icon: <Trash2 size={12}/>, label:'Remove from POS', color:'var(--red)', action: async () => { if(window.confirm('Remove ' + contextMenu!.item.name + '?')) { await apiPatch('/pos/items/' + contextMenu!.item.id, { isActive: false }); qc.invalidateQueries('pos-items'); setContextMenu(null) } } },
            ].map(opt => (
              <div key={opt.label} onClick={opt.action} style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', borderRadius:7, cursor:'pointer', color:(opt as any).color||'var(--text-1)', fontSize:'.78rem' }} onMouseEnter={e => (e.currentTarget as any).style.background='var(--bg-3)'} onMouseLeave={e => (e.currentTarget as any).style.background=''}>{opt.icon} {opt.label}</div>
            ))}
          </div>
        </div>
      )}

      {/* Cash modal */}
      {showCash && (
        <div className="modal-overlay" onClick={() => setShowCash(false)}>
          <div className="modal" style={{ maxWidth:380 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">💵 Cash Payment</div>
            <div style={{ background:'var(--bg-3)', borderRadius:10, padding:16, textAlign:'center', marginBottom:12 }}>
              <div style={{ fontSize:'.65rem', color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:4 }}>Amount Due</div>
              <div style={{ fontFamily:'var(--font-display)', fontSize:'2rem', fontWeight:800, color:'var(--gold)' }}>{formatCurrency(getTotal())}</div>
            </div>
            <div style={{ background:'var(--bg-3)', borderRadius:10, padding:12, textAlign:'center', marginBottom:12 }}>
              <div style={{ fontSize:'.65rem', color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:4 }}>Tendered</div>
              <div style={{ fontFamily:'var(--font-display)', fontSize:'1.8rem', fontWeight:800, color:'var(--text-0)' }}>{formatCurrency(tendered)}</div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6, marginBottom:12 }}>
              {['1','2','3','4','5','6','7','8','9','C','0','⌫'].map(k => (
                <button key={k} onClick={() => {
                  if (k==='C') setCashEntry('')
                  else if (k==='⌫') setCashEntry(v => v.slice(0,-1))
                  else if (cashEntry.length < 8) setCashEntry(v => v+k)
                }} style={{ padding:14, borderRadius:8, border:'1px solid var(--border-0)', background:'var(--bg-3)', color: k==='⌫'?'var(--red)':k==='C'?'var(--text-3)':'var(--text-0)', fontSize:'1rem', fontWeight:600, cursor:'pointer', fontFamily:'var(--font-mono)' }}>
                  {k}
                </button>
              ))}
            </div>
            {tendered >= getTotal() && (
              <div style={{ display:'flex', justifyContent:'space-between', padding:'10px 14px', background:'rgba(30,219,122,.08)', border:'1px solid rgba(30,219,122,.2)', borderRadius:8, marginBottom:12 }}>
                <span style={{ fontSize:'.78rem', color:'var(--green)' }}>Change Due</span>
                <span style={{ fontFamily:'var(--font-mono)', fontWeight:700, color:'var(--green)' }}>{formatCurrency(change)}</span>
              </div>
            )}
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowCash(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={tendered < getTotal()} onClick={() => completeTransaction('cash', change)}>
                Complete Sale
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt modal */}
      {showReceipt && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth:400 }}>
            <div style={{ textAlign:'center', marginBottom:16 }}>
              <div style={{ width:48, height:48, borderRadius:'50%', background:'rgba(30,219,122,.12)', border:'2px solid var(--green)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 10px' }}>
                <Check size={22} style={{ color:'var(--green)' }} />
              </div>
              <div style={{ fontFamily:'var(--font-display)', fontSize:'1.1rem', fontWeight:800, color:'var(--text-0)' }}>Sale Complete</div>
            </div>
            <div style={{ background:'var(--bg-3)', borderRadius:10, padding:14, fontFamily:'var(--font-mono)', fontSize:'.72rem', color:'var(--text-2)', lineHeight:1.9, marginBottom:16 }}>
              <div style={{ textAlign:'center', marginBottom:10, fontFamily:'var(--font-display)', color:'var(--gold)', fontWeight:800 }}>GOLD ASSET MANAGEMENT</div>
              <div style={{ textAlign:'center', fontSize:'.62rem', color:'var(--text-3)', marginBottom:10 }}>{showReceipt.ts}</div>
              <div style={{ borderTop:'1px dashed var(--border-0)', paddingTop:8, marginBottom:8 }}>
                {showReceipt.items.map((i:any) => (
                  <div key={i.id} style={{ display:'flex', justifyContent:'space-between' }}>
                    <span>{i.icon} {i.name} ×{i.qty}</span>
                    <span>{formatCurrency(i.price*i.qty)}</span>
                  </div>
                ))}
              </div>
              <div style={{ borderTop:'1px dashed var(--border-0)', paddingTop:8 }}>
                <div style={{ display:'flex', justifyContent:'space-between' }}><span>Subtotal</span><span>{formatCurrency(showReceipt.subtotal)}</span></div>
                <div style={{ display:'flex', justifyContent:'space-between' }}><span>Tax</span><span>{formatCurrency(showReceipt.tax)}</span></div>
                {showReceipt.surcharge > 0 && <div style={{ display:'flex', justifyContent:'space-between', color:'var(--amber)' }}><span>Card fee (3%)</span><span>+{formatCurrency(showReceipt.surcharge)}</span></div>}
                <div style={{ display:'flex', justifyContent:'space-between', fontWeight:700, color:'var(--text-0)', marginTop:4, fontSize:'.8rem' }}><span>TOTAL</span><span>{formatCurrency(showReceipt.total)}</span></div>
                {showReceipt.method==='cash' && <div style={{ display:'flex', justifyContent:'space-between', color:'var(--green)' }}><span>Change</span><span>{formatCurrency(showReceipt.change)}</span></div>}
              </div>
              <div style={{ textAlign:'center', marginTop:8, color:'var(--text-3)', fontSize:'.65rem' }}>
                {showReceipt.method==='card'?'💳 Stripe Terminal':showReceipt.method==='cash'?'💵 Cash':`⚡ Charge Account`}
                {showReceipt.tenant && ` · ${showReceipt.tenant.name}`}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowReceipt(null)}>Done</button>
              <button className="btn btn-primary" onClick={() => { setShowReceipt(null); showFlash('🖨️ Sending to printer…') }}>🖨️ Print</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
