/**
 * 10/12 (Nic): "one list of everyone the company pays (contractors, garbage
 * company, power company) with a type; contractors get a 1099 box and their
 * payments add up per calendar year." The Contractors page is folded in here.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import React, { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { useLocation } from 'react-router-dom'
import {
  formatCurrency, BOOKS_VENDOR_TYPES, BOOKS_VENDOR_TYPE_LABEL, BOOKS_VENDOR_PAYMENT_TERMS, BOOKS_VENDOR_PAYMENT_TERM_LABEL,
  BOOKS_W9_TAX_CLASSIFICATIONS, BOOKS_W9_TAX_CLASSIFICATION_LABEL, BOOKS_CONTRACTOR_PAY_UNITS, BOOKS_CONTRACTOR_PAY_UNIT_LABEL,
  type BooksVendorType,
} from '@gam/shared'
import { booksGet as get, booksPost as post, booksPatch as patch, toast } from './adapter'
import { Modal } from './common'

// ── VENDORS ───────────────────────────────────────────────────────────
// 10/11: the form's terms are the API's list and the account # and tax ID are
// optional on both sides. 10/12: every vendor has a type; a contractor may
// carry the 1099 box (with their W-9 box, trade and usual rate); the taxpayer
// ID is never sent back — only its last four digits.
const typeLabel=(t:string)=>(BOOKS_VENDOR_TYPE_LABEL as Record<string,string>)[t]??'Other'
const termsLabel=(t:string)=>(BOOKS_VENDOR_PAYMENT_TERM_LABEL as Record<string,string>)[t]??'—'
const w9Label=(t:string)=>(BOOKS_W9_TAX_CLASSIFICATION_LABEL as Record<string,string>)[t]??'—'
const unitLabel=(t:string)=>(BOOKS_CONTRACTOR_PAY_UNIT_LABEL as Record<string,string>)[t]??''

type Tab='all'|BooksVendorType
const blankForm={vendorType:'supplier',name:'',contactName:'',email:'',phone:'',address:'',category:'',paymentTerms:'net30',
  accountNumber:'',taxId:'',notes:'',is1099:false,taxClassification:'',w9OnFile:false,trade:'',payRate:'',payUnit:'project',status:'active'}
type Form=typeof blankForm

export function VendorsPage(){
  const qc=useQueryClient()
  // ?type=contractor (the old Contractors page's address lands here) opens that tab.
  const asked=new URLSearchParams(useLocation().search).get('type')
  const[tab,setTab]=useState<Tab>((BOOKS_VENDOR_TYPES as readonly string[]).includes(asked??'')?asked as Tab:'all')
  const[showInactive,setShowInactive]=useState(false)
  const{data:vendors=[],isLoading}=useQuery(['ven',showInactive],()=>get<any[]>(`/books/vendors${showInactive?'?includeInactive=true':''}`))
  const[editing,setEditing]=useState<any|null|'new'>(null)
  const[form,setForm]=useState<Form>(blankForm)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const set=(k:keyof Form)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>{
    const v=e.target.type==='checkbox'?(e.target as HTMLInputElement).checked:e.target.value
    setForm(p=>({...p,[k]:v}))
  }

  const list=(vendors as any[]).filter(v=>tab==='all'||v.vendorType===tab)
  const live=(vendors as any[]).filter(v=>v.status==='active')
  const paid=live.reduce((s,v)=>s+(+v.paidThisYear||0),0)
  const owed=live.reduce((s,v)=>s+(+v.owed||0),0)
  const ten99=live.filter(v=>v.is1099)
  const year=(vendors as any[])[0]?.year??new Date().getFullYear()

  const openNew=()=>{setForm(blankForm);setErr('');setEditing('new')}
  const openEdit=(v:any)=>{
    setForm({vendorType:v.vendorType,name:v.name??'',contactName:v.contactName??'',email:v.email??'',phone:v.phone??'',address:v.address??'',
      category:v.category??'',paymentTerms:v.paymentTerms??'net30',accountNumber:v.accountNumber??'',taxId:'',notes:v.notes??'',
      is1099:!!v.is1099,taxClassification:v.taxClassification??'',w9OnFile:!!v.w9OnFile,trade:v.trade??'',
      payRate:v.payRate!=null?String(v.payRate):'',payUnit:v.payUnit??'project',status:v.status??'active'})
    setErr('');setEditing(v)
  }
  const save=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    const contractor=form.vendorType==='contractor'
    const body:any={...form,is1099:contractor&&form.is1099,taxClassification:form.taxClassification||null,
      payRate:contractor&&form.payRate?+form.payRate:'',trade:contractor?form.trade:'',payUnit:contractor&&form.payRate?form.payUnit:''}
    try{
      if(editing==='new'){
        delete body.status
        await post('/books/vendors',body)
        toast(`${form.name} added.`)
      }else{
        if(!form.taxId)delete body.taxId
        await patch(`/books/vendors/${editing.id}`,body)
        toast(`${form.name} saved.`)
      }
      qc.invalidateQueries('ven');setEditing(null)
    }catch(ex:any){setErr(ex.response?.data?.error||'Could not save the vendor.')}
    finally{setSaving(false)}
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏪 Vendors</h1><p className="ps">Everyone your company pays: contractors, utility companies, suppliers and anyone else. A contractor can carry the 1099 box; what they are paid adds up for each calendar year.</p></div>
        <button className="btn bp" onClick={openNew}>+ Add Vendor</button>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Active Vendors</div><div className="kv t">{live.length}</div><div className="ks">In your vendor list</div></div>
        <div className="kpi"><div className="kl">Paid in {year}</div><div className="kv gold">{formatCurrency(paid)}</div><div className="ks">Payments on their expenses</div></div>
        <div className="kpi"><div className="kl">Still Owed</div><div className={`kv ${owed>0?'a':'g'}`}>{formatCurrency(owed)}</div><div className="ks">Unpaid bills</div></div>
        <div className="kpi"><div className="kl">1099 Contractors</div><div className="kv b">{ten99.length}</div><div className="ks">{ten99.filter(v=>!v.w9OnFile).length} without a W-9 on file</div></div>
      </div>

      <div className="tabs">
        {(['all',...BOOKS_VENDOR_TYPES] as Tab[]).map(t=>(
          <button key={t} className={`tab${tab===t?' on':''}`} onClick={()=>setTab(t)}>{t==='all'?'All':typeLabel(t)}</button>
        ))}
        <label style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:6,fontSize:'.75rem',textTransform:'none',letterSpacing:0,color:'var(--t2)',marginBottom:0}}>
          <input type="checkbox" checked={showInactive} onChange={e=>setShowInactive(e.target.checked)} style={{width:'auto'}}/> Show inactive
        </label>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <div style={{overflowX:'auto'}}>
            <table className="tbl" style={{minWidth:640}}>
              <thead><tr><th>Vendor</th><th>Type</th><th>Paid in {year}</th><th>Owed</th><th>Taxpayer ID</th><th>Terms</th><th></th></tr></thead>
              <tbody>
                {list.length?list.map((v:any)=>(
                  <tr key={v.id} style={{opacity:v.status==='active'?1:.55}}>
                    <td>
                      <div style={{fontWeight:600,color:'var(--t0)'}}>{v.name}{v.status!=='active'&&<span className="badge bmu" style={{marginLeft:6}}>Inactive</span>}</div>
                      <div style={{fontSize:'.68rem',color:'var(--t3)'}}>{[v.contactName,v.email,v.trade].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td>
                      <span className="badge bmu">{typeLabel(v.vendorType)}</span>
                      {v.is1099&&<span className={`badge ${v.w9OnFile?'bg2':'ba'}`} style={{marginLeft:4}}>1099{v.w9OnFile?'':' · no W-9'}</span>}
                    </td>
                    <td className="mono">{formatCurrency(v.paidThisYear)}{+v.paidByCardThisYear>0&&<div style={{fontSize:'.62rem',color:'var(--t3)'}}>{formatCurrency(v.paidByCardThisYear)} by card</div>}</td>
                    <td className="mono" style={{color:+v.owed>0?'var(--amber)':'var(--t3)'}}>{+v.owed>0?formatCurrency(v.owed):'—'}</td>
                    <td className="mono" style={{fontSize:'.72rem',color:'var(--t3)'}}>{v.taxIdLast4?`••${v.taxIdLast4}`:'—'}</td>
                    <td style={{fontSize:'.72rem',color:'var(--t2)'}}>{v.paymentTerms?termsLabel(v.paymentTerms):'—'}</td>
                    <td><button className="btn bp bsm" onClick={()=>openEdit(v)}>Edit</button></td>
                  </tr>
                )):<tr><td colSpan={7}><div className="empty">{tab==='all'?'No vendors yet. Add the people and companies you pay.':`No ${typeLabel(tab).toLowerCase()} vendors.`}</div></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing&&(
        <Modal title={editing==='new'?'Add Vendor':`Edit ${editing.name}`} onClose={()=>setEditing(null)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={save}>
            <div className="frow2">
              <div><label>What kind of vendor</label>
                <select value={form.vendorType} onChange={set('vendorType')} required>
                  {BOOKS_VENDOR_TYPES.map(t=><option key={t} value={t}>{typeLabel(t)}</option>)}
                </select>
              </div>
              {editing!=='new'&&<div><label>Status</label>
                <select value={form.status} onChange={set('status')}><option value="active">Active</option><option value="inactive">Inactive (kept, with everything paid to them)</option></select>
              </div>}
            </div>
            <div className="frow"><label>Name</label><input type="text" value={form.name} onChange={set('name')} maxLength={200} required placeholder="e.g. APS Electric, City of Phoenix Water, Jose Ruiz"/></div>
            <div className="frow2">
              <div><label>Contact Name</label><input type="text" value={form.contactName} onChange={set('contactName')} maxLength={200} required/></div>
              <div><label>Phone</label><input type="tel" value={form.phone} onChange={set('phone')} minLength={7} maxLength={20} required/></div>
            </div>
            <div className="frow"><label>Email</label><input type="email" value={form.email} onChange={set('email')} maxLength={200} required/></div>
            <div className="frow"><label>Address</label><input type="text" value={form.address} onChange={set('address')} placeholder="Street, city, state, ZIP" required/></div>
            <div className="frow2">
              <div><label>What they do (optional)</label><input type="text" value={form.category} onChange={set('category')} maxLength={100} placeholder="e.g. Trash pickup"/></div>
              <div><label>Payment Terms</label>
                <select value={form.paymentTerms} onChange={set('paymentTerms')}>
                  {BOOKS_VENDOR_PAYMENT_TERMS.map(t=><option key={t} value={t}>{termsLabel(t)}</option>)}
                </select>
              </div>
            </div>
            <div className="frow2">
              <div><label>Account # (optional)</label><input type="text" value={form.accountNumber} onChange={set('accountNumber')} maxLength={100}/></div>
              <div><label>Taxpayer ID (optional)</label><input type="text" value={form.taxId} onChange={set('taxId')}
                placeholder={editing!=='new'&&editing.taxIdLast4?`On file ••${editing.taxIdLast4}. Leave blank to keep it.`:'EIN 12-3456789 or SSN'}/></div>
            </div>
            {form.vendorType==='contractor'&&(
              <div className="card" style={{background:'var(--bg3)',marginBottom:14}}>
                <label style={{display:'flex',alignItems:'center',gap:8,textTransform:'none',letterSpacing:0,fontSize:'.8rem'}}>
                  <input type="checkbox" checked={form.is1099} onChange={set('is1099')} style={{width:'auto'}}/> Gets a 1099 (their payments add up for each calendar year)
                </label>
                <div className="frow2" style={{marginTop:10}}>
                  <div><label>Box ticked on their W-9</label>
                    <select value={form.taxClassification} onChange={set('taxClassification')}>
                      <option value="">Not known yet</option>
                      {BOOKS_W9_TAX_CLASSIFICATIONS.map(t=><option key={t} value={t}>{w9Label(t)}</option>)}
                    </select>
                  </div>
                  <div><label>W-9 on file</label>
                    <label style={{display:'flex',alignItems:'center',gap:8,textTransform:'none',letterSpacing:0,fontSize:'.8rem',marginTop:8}}>
                      <input type="checkbox" checked={form.w9OnFile} onChange={set('w9OnFile')} style={{width:'auto'}}/> I have their W-9
                    </label>
                  </div>
                </div>
                <div className="frow2" style={{marginBottom:0}}>
                  <div><label>Trade (optional)</label><input type="text" value={form.trade} onChange={set('trade')} maxLength={100} placeholder="e.g. Plumbing"/></div>
                  <div><label>Usual rate (optional)</label>
                    <div style={{display:'flex',gap:6}}>
                      <input type="number" min="0.01" step="0.01" value={form.payRate} onChange={set('payRate')} style={{flex:1}}/>
                      <select value={form.payUnit} onChange={set('payUnit')} style={{width:'auto'}}>
                        {BOOKS_CONTRACTOR_PAY_UNITS.map(u=><option key={u} value={u}>per {unitLabel(u).toLowerCase()}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div className="frow"><label>Notes (optional)</label><textarea rows={2} value={form.notes} onChange={set('notes')}/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setEditing(null)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:editing==='new'?'Add Vendor':'Save'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
