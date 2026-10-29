/**
 * 10/12 (Nic): the chart of accounts — the company ledger's accounts and their balances.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import React, { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { formatCurrency, humanize, BOOKS_ACCOUNT_TYPES, BOOKS_ACCOUNT_TYPE_LABEL, type BooksAccountType } from '@gam/shared'
import { booksGet as get, booksPost as post, booksPatch as patch, toast, appConfirm } from './adapter'
import { Modal } from './common'

// ── CHART OF ACCOUNTS ─────────────────────────────────────────────────
// 10/11: the five types are the API's list (BOOKS_ACCOUNT_TYPES); an account's
// balance is shown in its normal sign (normalBalance: what a liability owes and
// income earned read positive); an account with money in it cannot be turned
// off (the server says why), and a turned-off account can be listed and turned
// back on.
// 10/12 (Nic, ledger P7): an account the books hold anything on (posted
// lines, journal lines, or a posting role pointing at it — inUse) is turned
// off by choosing the account that takes its place: the postings that went to
// it go there from then on, and its open months move there.
const TYPE_COLORS:Record<string,string>={asset:'bb',liability:'br',equity:'ba',income:'bg2',expense:'bgold'}
const TYPE_PLURAL:Record<BooksAccountType,string>={asset:'Assets',liability:'Liabilities',equity:'Equity',income:'Income',expense:'Expenses'}
const accountTypeLabel=(t:string)=>(BOOKS_ACCOUNT_TYPE_LABEL as Record<string,string>)[t]??humanize(t)

export function ChartOfAccountsPage(){
  const qc=useQueryClient()
  const[showInactive,setShowInactive]=useState(false)
  const{data:accounts=[],isLoading}=useQuery(['acct',showInactive],()=>get<any[]>(`/books/accounts${showInactive?'?includeInactive=true':''}`))
  const[tab,setTab]=useState<'all'|BooksAccountType>('all')
  const[showAdd,setShowAdd]=useState(false)
  const[seeding,setSeeding]=useState(false)
  const initForm={code:'',name:'',type:'asset' as BooksAccountType,subtype:'',description:''}
  const[form,setForm]=useState(initForm)
  const[saving,setSaving]=useState(false)
  const[err,setErr]=useState('')
  const[retiring,setRetiring]=useState<any>(null)
  const[replacement,setReplacement]=useState('')
  const[retireErr,setRetireErr]=useState('')

  const list=accounts as any[]
  const activeCount=list.filter((a:any)=>a.active!==false).length
  const filtered=tab==='all'?list:list.filter((a:any)=>a.type===tab)
  const grouped=BOOKS_ACCOUNT_TYPES.reduce((acc:Record<string,number>,t)=>({...acc,[t]:list.filter((a:any)=>a.type===t).length}),{})

  const seedAccounts=async()=>{
    setSeeding(true)
    try{
      const r=await post('/books/accounts/seed')
      qc.invalidateQueries('acct')
      toast((r.data as any).message)
    }catch(e:any){toast.error(e.response?.data?.error||'Seed failed')}
    finally{setSeeding(false)}
  }

  const addAccount=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/accounts',form)
      qc.invalidateQueries('acct')
      setShowAdd(false)
      setForm(initForm)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed to save')}
    finally{setSaving(false)}
  }

  const setActive=async(a:any,active:boolean)=>{
    if(!active&&a.inUse){setRetiring(a);setReplacement('');setRetireErr('');return}
    if(!active&&!(await appConfirm(`Deactivate ${a.name}? It can be turned back on later.`, { danger: true, confirmLabel: 'Deactivate' })))return
    try{
      await patch(`/books/accounts/${a.id}`,{active})
      qc.invalidateQueries('acct')
      if(active)toast(`${a.name} is active again.`)
    }catch(ex:any){toast.error(ex.response?.data?.error||'Could not change the account.')}
  }

  const retire=async(e:React.FormEvent)=>{
    e.preventDefault();setRetireErr('')
    try{
      await patch(`/books/accounts/${retiring.id}`,{active:false,replacementAccountId:replacement})
      qc.invalidateQueries('acct')
      toast(`${retiring.name} is turned off; its place goes to the account you chose.`)
      setRetiring(null)
    }catch(ex:any){setRetireErr(ex.response?.data?.error||'Could not turn this account off.')}
  }
  const replacements=retiring?list.filter((x:any)=>x.type===retiring.type&&x.active!==false&&x.id!==retiring.id):[]

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">📂 Chart of Accounts</h1><p className="ps">{activeCount} active accounts · double-entry bookkeeping foundation</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <label style={{display:'flex',alignItems:'center',gap:6,marginBottom:0,textTransform:'none',letterSpacing:0,fontSize:'.78rem',color:'var(--t2)'}}>
            <input type="checkbox" checked={showInactive} onChange={e=>setShowInactive(e.target.checked)} style={{width:'auto'}}/>Show inactive
          </label>
          {list.length===0&&!showInactive&&<button className="btn bp" onClick={seedAccounts} disabled={seeding}>{seeding?<><span className="spinner"/>Seeding…</>:'⚡ Seed Standard COA'}</button>}
          <button className="btn bp" onClick={()=>setShowAdd(true)}>+ Add Account</button>
        </div>
      </div>

      {list.length===0&&!isLoading&&!showInactive&&(
        <div className="alert agold">No accounts yet. Click <strong>⚡ Seed Standard COA</strong> to load a standard chart of accounts instantly.</div>
      )}

      <div className="grid4" style={{marginBottom:16}}>
        {BOOKS_ACCOUNT_TYPES.map(t=>(
          <div key={t} className="kpi" style={{cursor:'pointer',border:tab===t?'1px solid var(--gold)':'1px solid var(--b1)'}} onClick={()=>setTab(tab===t?'all':t)}>
            <div className="kl">{TYPE_PLURAL[t]}</div>
            <div className="kv">{grouped[t]||0}</div>
          </div>
        ))}
      </div>

      <div className="tabs">
        <button className={`tab ${tab==='all'?'on':''}`} onClick={()=>setTab('all')}>All ({list.length})</button>
        {BOOKS_ACCOUNT_TYPES.map(t=><button key={t} className={`tab ${tab===t?'on':''}`} onClick={()=>setTab(t)}>{BOOKS_ACCOUNT_TYPE_LABEL[t]} ({grouped[t]||0})</button>)}
      </div>

      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Code</th><th>Account Name</th><th>Type</th><th>Subtype</th><th>Balance</th><th>System</th><th></th></tr></thead>
            <tbody>
              {filtered.length?filtered.map((a:any)=>(
                <tr key={a.id} style={{opacity:a.active===false?.6:1}}>
                  <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{a.code}</td>
                  <td style={{color:'var(--t0)',fontWeight:500}}>{a.name}{a.active===false&&<span className="badge bmu" style={{marginLeft:8,fontSize:'.6rem'}}>Inactive</span>}</td>
                  <td><span className={`badge ${TYPE_COLORS[a.type]||'bmu'}`}>{accountTypeLabel(a.type)}</span></td>
                  <td style={{fontSize:'.72rem',color:'var(--t3)'}}>{a.subtype?humanize(a.subtype):'—'}</td>
                  <td className="mono">{formatCurrency(a.normalBalance??a.balance)}</td>
                  <td>{a.isSystem?<span className="badge bmu">System</span>:<span style={{color:'var(--t3)'}}>—</span>}</td>
                  <td>{a.active===false
                    ?<button className="btn bp bsm" onClick={()=>setActive(a,true)}>Reactivate</button>
                    :<button className="btn bd bsm" onClick={()=>setActive(a,false)}>Deactivate</button>}</td>
                </tr>
              )):<tr><td colSpan={7}><div className="empty">No {tab==='all'?'':BOOKS_ACCOUNT_TYPE_LABEL[tab].toLowerCase()+' '}accounts.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {retiring&&(
        <Modal title={`Deactivate ${retiring.name}`} onClose={()=>setRetiring(null)}>
          {retireErr&&<div className="alert ae">{retireErr}</div>}
          <form onSubmit={retire}>
            <p style={{fontSize:'.8rem',color:'var(--t2)',marginTop:0}}>Your books already hold entries on {retiring.name}. Choose the {accountTypeLabel(retiring.type).toLowerCase()} account that takes its place: what GAM books there goes to that account from now on, and its open months move there. Closed months keep it as they were.</p>
            <div className="frow"><label>Account that takes its place</label>
              <select value={replacement} onChange={e=>setReplacement(e.target.value)} required>
                <option value="">Choose…</option>
                {replacements.map((x:any)=><option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
              </select>
            </div>
            {replacements.length===0&&<div style={{fontSize:'.72rem',color:'var(--amber)',marginBottom:10}}>Add another {accountTypeLabel(retiring.type).toLowerCase()} account first.</div>}
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setRetiring(null)}>Cancel</button>
              <button type="submit" className="btn bd" disabled={!replacement}>Deactivate</button>
            </div>
          </form>
        </Modal>
      )}

      {showAdd&&(
        <Modal title="Add Account" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={addAccount}>
            <div className="frow2">
              <div><label>Account Code</label><input type="text" maxLength={20} value={form.code} onChange={e=>setForm(f=>({...f,code:e.target.value}))} placeholder="e.g. 4010" required/></div>
              <div><label>Type</label>
                <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value as BooksAccountType}))}>
                  {BOOKS_ACCOUNT_TYPES.map(t=><option key={t} value={t}>{BOOKS_ACCOUNT_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
            </div>
            <div className="frow"><label>Account Name</label><input type="text" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Rental Income" required/></div>
            <div className="frow"><label>Subtype (optional)</label><input type="text" value={form.subtype} onChange={e=>setForm(f=>({...f,subtype:e.target.value}))} placeholder="e.g. operating, bank, current…"/></div>
            <div className="frow"><label>Description (optional)</label><textarea rows={2} value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))}/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Add Account'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
