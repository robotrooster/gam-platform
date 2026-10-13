/**
 * 10/12 (Nic): "fixed assets with depreciation". Buildings, improvements to a
 * property, equipment and vehicles wear out over years: their cost is spread
 * over the life the landlord chooses (straight line), one amount at the end of
 * each month. Land never wears out. An expense filed under a
 * capital-improvement category (one that charges to an asset account) can be
 * turned into an asset here.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import React, { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import {
  formatCurrency, BOOKS_FIXED_ASSET_CLASSES, BOOKS_FIXED_ASSET_CLASS_LABEL, BOOKS_DEPRECIATION_METHOD_LABEL,
} from '@gam/shared'
import { booksGet as get, booksPost as post, booksPatch as patch, toast } from './adapter'
import { Modal } from './common'
import { VoidReasonModal } from './VoidReasonModal'

const day=(d:string|null|undefined)=>d?new Date(`${d.slice(0,10)}T12:00:00`).toLocaleDateString():'—'
const classLabel=(c:string)=>(BOOKS_FIXED_ASSET_CLASS_LABEL as Record<string,string>)[c]??'—'
const years=(y:string|number|null|undefined)=>y==null||y===''?'—':`${+y} yr`

const blankAsset={name:'',propertyId:'',assetClass:'building',cost:'',salvageValue:'0',acquiredOn:'',inServiceDate:'',lifeYears:'',priorDepreciation:'',notes:''}
type AssetForm=typeof blankAsset

export function FixedAssetsPage(){
  const qc=useQueryClient()
  const[showVoided,setShowVoided]=useState(false)
  const{data:assets=[],isLoading}=useQuery(['assets',showVoided],()=>get<any[]>(`/books/fixed-assets${showVoided?'?includeVoided=true':''}`))
  const{data:capital=[]}=useQuery('capitalExpenses',()=>get<any[]>('/books/fixed-assets/capital-expenses'))
  const{data:opts}=useQuery('loanOpts',()=>get<any>('/books/loans/form-options'))
  const{data:properties=[]}=useQuery('booksProps',()=>get<any[]>('/books/properties').catch(()=>[]))
  const[editing,setEditing]=useState<any|null|'new'>(null)
  const[fromExpense,setFromExpense]=useState<any|null>(null)
  const[voiding,setVoiding]=useState<any|null>(null)
  const refresh=()=>{qc.invalidateQueries('assets');qc.invalidateQueries('capitalExpenses')}

  const live=(assets as any[]).filter(a=>!a.voidedAt)
  const cost=live.reduce((s,a)=>s+(+a.cost||0),0)
  const taken=live.reduce((s,a)=>s+(+a.depreciatedToDate||0),0)
  const monthly=live.reduce((s,a)=>s+(a.monthsLeft>0?+a.monthly||0:0),0)

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏗 Fixed Assets</h1><p className="ps">Buildings, improvements, equipment and vehicles wear out over years. Their cost is spread over the life you choose, the same amount each month. Your accountant can tell you which life to use.</p></div>
        <button className="btn bp" onClick={()=>setEditing('new')}>+ Add Asset</button>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">What They Cost</div><div className="kv">{formatCurrency(cost)}</div><div className="ks">{live.length} assets</div></div>
        <div className="kpi"><div className="kl">Depreciation So Far</div><div className="kv a">{formatCurrency(taken)}</div><div className="ks">Through the last month that ended</div></div>
        <div className="kpi"><div className="kl">Worth on the Books</div><div className="kv gold">{formatCurrency(cost-taken)}</div><div className="ks">Cost less depreciation</div></div>
        <div className="kpi"><div className="kl">Each Month</div><div className="kv t">{formatCurrency(monthly)}</div><div className="ks">Posted at the end of the month</div></div>
      </div>

      {(capital as any[]).length>0&&(
        <div className="card" style={{marginBottom:16}}>
          <div className="ct">Capital improvements not yet an asset</div>
          <p style={{fontSize:'.75rem',color:'var(--t3)',marginTop:0}}>These expenses are filed under a category that charges to an asset account. Make each one an asset to spread its cost over its life.</p>
          <div style={{overflowX:'auto'}}>
            <table className="tbl" style={{minWidth:480}}>
              <thead><tr><th>Expense</th><th>Category</th><th>Property</th><th>Day</th><th>Cost</th><th></th></tr></thead>
              <tbody>
                {(capital as any[]).map((e:any)=>(
                  <tr key={e.id}>
                    <td style={{fontWeight:600,color:'var(--t0)'}}>{e.description||'Capital improvement'}</td>
                    <td style={{fontSize:'.72rem'}}>{e.categoryName}</td>
                    <td style={{fontSize:'.72rem'}}>{e.propertyName??'Company'}</td>
                    <td style={{fontSize:'.72rem'}}>{day(e.expenseDate)}</td>
                    <td className="mono">{formatCurrency(e.amount)}</td>
                    <td><button className="btn bp bsm" onClick={()=>setFromExpense(e)}>Make it an asset</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{display:'flex',justifyContent:'flex-end',marginBottom:8}}>
        <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'.75rem',textTransform:'none',letterSpacing:0,color:'var(--t2)',marginBottom:0}}>
          <input type="checkbox" checked={showVoided} onChange={e=>setShowVoided(e.target.checked)} style={{width:'auto'}}/> Show voided
        </label>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <div style={{overflowX:'auto'}}>
            <table className="tbl" style={{minWidth:720}}>
              <thead><tr><th>Asset</th><th>Property</th><th>In service</th><th>Cost</th><th>Life</th><th>Monthly</th><th>So far</th><th>On the books</th><th></th></tr></thead>
              <tbody>
                {(assets as any[]).length?(assets as any[]).map((a:any)=>(
                  <tr key={a.id} style={{opacity:a.voidedAt?.5:1}}>
                    <td>
                      <div style={{fontWeight:600,color:'var(--t0)'}}>{a.name}</div>
                      <div style={{fontSize:'.66rem',color:'var(--t3)'}}>{classLabel(a.assetClass)}{a.sourceExpenseId?' · from an expense':''}{a.opensAtBooksStart?' · owned before your books start':''}{a.voidedAt?' · voided':''}</div>
                      {a.problem&&<div className="badge ba" style={{marginTop:4}}>{a.problem}</div>}
                    </td>
                    <td style={{fontSize:'.72rem'}}>{a.propertyName??'Company'}</td>
                    <td style={{fontSize:'.72rem'}}>{day(a.inServiceDate)}</td>
                    <td className="mono">{formatCurrency(a.cost)}</td>
                    <td style={{fontSize:'.72rem'}}>{a.depreciates?years(a.lifeYears):'Does not wear out'}</td>
                    <td className="mono">{a.depreciates&&a.monthsLeft>0?formatCurrency(a.monthly):'—'}</td>
                    <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(a.depreciatedToDate)}</td>
                    <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{formatCurrency(a.bookValue)}</td>
                    <td style={{whiteSpace:'nowrap'}}>{!a.voidedAt&&<>
                      <button className="btn bp bsm" onClick={()=>setEditing(a)}>Edit</button>{' '}
                      <button className="btn bp bsm" onClick={()=>setVoiding(a)}>Void</button>
                    </>}</td>
                  </tr>
                )):<tr><td colSpan={9}><div className="empty">No fixed assets yet. Add a building, an improvement, equipment or a vehicle.</div></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing&&<AssetFormModal asset={editing==='new'?null:editing} booksStart={opts?.booksStartDate??null} properties={properties as any[]}
        onClose={()=>setEditing(null)} onSaved={()=>{refresh();setEditing(null)}}/>}
      {fromExpense&&<FromExpenseModal expense={fromExpense} onClose={()=>setFromExpense(null)} onSaved={()=>{refresh();setFromExpense(null)}}/>}
      {voiding&&<VoidReasonModal title={`Void ${voiding.name}`} what="Void this asset if it was entered by mistake; its opening and every month of depreciation are taken back."
        onClose={()=>setVoiding(null)} onVoid={async r=>{await post(`/books/fixed-assets/${voiding.id}/void`,{reason:r});toast('Asset voided.');refresh()}}/>}
    </div>
  )
}

function AssetFormModal({asset,booksStart,properties,onClose,onSaved}:{asset:any|null;booksStart:string|null;properties:any[];onClose:()=>void;onSaved:()=>void}){
  const[form,setForm]=useState<AssetForm>(()=>asset?{
    name:asset.name??'',propertyId:asset.propertyId??'',assetClass:asset.assetClass,cost:String(+asset.cost),salvageValue:String(+asset.salvageValue||0),
    acquiredOn:asset.acquiredOn??'',inServiceDate:asset.inServiceDate??'',lifeYears:asset.lifeYears!=null?String(+asset.lifeYears):'',
    priorDepreciation:asset.priorDepreciation!=null?String(+asset.priorDepreciation):'',notes:asset.notes??''}:blankAsset)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const set=(k:keyof AssetForm)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm(p=>({...p,[k]:e.target.value}))
  const fromExpense=!!asset?.sourceExpenseId
  const land=form.assetClass==='land'
  const owned=!!booksStart&&!!form.acquiredOn&&form.acquiredOn<booksStart&&!fromExpense
  const save=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    const body:any={...form,lifeYears:land?'':form.lifeYears,priorDepreciation:owned&&!land?form.priorDepreciation:''}
    if(fromExpense){delete body.cost;delete body.acquiredOn;delete body.propertyId}
    try{
      if(asset)await patch(`/books/fixed-assets/${asset.id}`,body)
      else await post('/books/fixed-assets',body)
      toast(asset?'Asset saved.':`${form.name} added.`)
      onSaved()
    }catch(ex:any){setErr(ex.response?.data?.error||'Could not save the asset.')}
    finally{setSaving(false)}
  }
  return(
    <Modal title={asset?`Edit ${asset.name}`:'Add Asset'} onClose={onClose}>
      {err&&<div className="alert ae">{err}</div>}
      <form onSubmit={save}>
        <div className="frow2">
          <div><label>Name</label><input type="text" value={form.name} onChange={set('name')} maxLength={120} required placeholder="e.g. Clubhouse, Riding mower"/></div>
          <div><label>What it is</label>
            <select value={form.assetClass} onChange={set('assetClass')}>
              {BOOKS_FIXED_ASSET_CLASSES.map(c=><option key={c} value={c}>{classLabel(c)}</option>)}
            </select>
          </div>
        </div>
        <div className="frow"><label>Property</label>
          <select value={form.propertyId} onChange={set('propertyId')} disabled={fromExpense}>
            <option value="">The company (no one property)</option>
            {properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="frow2">
          <div><label>What it cost</label><input type="number" min="0.01" step="0.01" value={form.cost} onChange={set('cost')} required disabled={fromExpense}/></div>
          <div><label>Worth at the end of its life</label><input type="number" min="0" step="0.01" value={form.salvageValue} onChange={set('salvageValue')}/></div>
        </div>
        <div className="frow2">
          <div><label>Day you bought it</label><input type="date" value={form.acquiredOn} onChange={set('acquiredOn')} required disabled={fromExpense}/></div>
          <div><label>Day it went into service</label><input type="date" value={form.inServiceDate} onChange={set('inServiceDate')} placeholder="Same as bought"/></div>
        </div>
        {!land&&<div className="frow2">
          <div><label>Life in years</label><input type="number" min="0.0833" max="100" step="0.0001" value={form.lifeYears} onChange={set('lifeYears')} required placeholder="e.g. 27.5"/></div>
          <div><label>Method</label><input type="text" value={BOOKS_DEPRECIATION_METHOD_LABEL['straight_line']} disabled/></div>
        </div>}
        {owned&&!land&&<div className="card" style={{background:'var(--bg3)',marginBottom:14}}>
          <p style={{fontSize:'.76rem',color:'var(--t2)',marginTop:0}}>You owned this before your books start ({day(booksStart)}), so it opens on your books at its cost less the depreciation already taken. Leave this blank to use the straight-line months before that day, or enter the figure from your earlier records.</p>
          <div className="frow" style={{marginBottom:0}}><label>Depreciation already taken (optional)</label><input type="number" min="0" step="0.01" value={form.priorDepreciation} onChange={set('priorDepreciation')}/></div>
        </div>}
        {!owned&&!fromExpense&&<p style={{fontSize:'.72rem',color:'var(--t3)'}}>Bought on or after your books start: its cost is already on your books through how you paid for it (an expense under a capital-improvement category, a loan, or a journal entry). This adds the depreciation.</p>}
        <div className="frow"><label>Notes (optional)</label><textarea rows={2} value={form.notes} onChange={set('notes')}/></div>
        <div className="factions">
          <button type="button" className="btn bg-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:asset?'Save':'Add Asset'}</button>
        </div>
      </form>
    </Modal>
  )
}

function FromExpenseModal({expense,onClose,onSaved}:{expense:any;onClose:()=>void;onSaved:()=>void}){
  const[form,setForm]=useState({name:expense.description||'',assetClass:'improvement',salvageValue:'0',inServiceDate:expense.expenseDate??'',lifeYears:'',notes:''})
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const set=(k:keyof typeof form)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm(p=>({...p,[k]:e.target.value}))
  const land=form.assetClass==='land'
  const save=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post(`/books/fixed-assets/from-expense/${expense.id}`,{...form,lifeYears:land?'':form.lifeYears})
      toast('It is a fixed asset now.')
      onSaved()
    }catch(ex:any){setErr(ex.response?.data?.error||'Could not make it an asset.')}
    finally{setSaving(false)}
  }
  return(
    <Modal title="Make it an asset" onClose={onClose}>
      {err&&<div className="alert ae">{err}</div>}
      <form onSubmit={save}>
        <p style={{fontSize:'.78rem',color:'var(--t2)',marginTop:0}}>{formatCurrency(expense.amount)} on {day(expense.expenseDate)}, filed under {expense.categoryName}. Its cost is already on your books as an asset; this spreads it over its life.</p>
        <div className="frow2">
          <div><label>Name</label><input type="text" value={form.name} onChange={set('name')} maxLength={120}/></div>
          <div><label>What it is</label>
            <select value={form.assetClass} onChange={set('assetClass')}>
              {BOOKS_FIXED_ASSET_CLASSES.map(c=><option key={c} value={c}>{classLabel(c)}</option>)}
            </select>
          </div>
        </div>
        <div className="frow2">
          <div><label>Day it went into service</label><input type="date" value={form.inServiceDate} onChange={set('inServiceDate')}/></div>
          <div><label>Worth at the end of its life</label><input type="number" min="0" step="0.01" value={form.salvageValue} onChange={set('salvageValue')}/></div>
        </div>
        {!land&&<div className="frow"><label>Life in years</label><input type="number" min="0.0833" max="100" step="0.0001" value={form.lifeYears} onChange={set('lifeYears')} required placeholder="e.g. 15"/></div>}
        <div className="factions">
          <button type="button" className="btn bg-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Make it an asset'}</button>
        </div>
      </form>
    </Modal>
  )
}
