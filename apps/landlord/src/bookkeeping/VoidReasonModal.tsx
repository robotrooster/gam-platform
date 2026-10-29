/**
 * 10/12 (Nic): GAM never erases — a loan, a loan payment or a fixed asset
 * entered by mistake is VOIDED, kept on record with who, when and why. This
 * window asks why before it voids. Same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts).
 */
import React, { useState } from 'react'
import { Modal } from './common'

export function VoidReasonModal({title,what,onVoid,onClose}:{title:string;what:string;onVoid:(reason:string)=>Promise<void>;onClose:()=>void}){
  const[reason,setReason]=useState('')
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const go=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{await onVoid(reason.trim());onClose()}
    catch(ex:any){setErr(ex.response?.data?.error||'Could not void it.')}
    finally{setSaving(false)}
  }
  return(
    <Modal title={title} onClose={onClose}>
      {err&&<div className="alert ae">{err}</div>}
      <form onSubmit={go}>
        <p style={{fontSize:'.8rem',color:'var(--t2)',marginBottom:12}}>{what} It stays on record as voided, with who voided it, when and why; what it put on the books is taken back.</p>
        <div className="frow"><label>Why</label><textarea rows={2} value={reason} onChange={e=>setReason(e.target.value)} minLength={3} maxLength={500} required placeholder="e.g. Entered twice"/></div>
        <div className="factions">
          <button type="button" className="btn bg-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn bp" disabled={saving||reason.trim().length<3}>{saving?<><span className="spinner"/>Voiding…</>:'Void it'}</button>
        </div>
      </form>
    </Modal>
  )
}
