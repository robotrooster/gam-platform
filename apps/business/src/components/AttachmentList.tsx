/**
 * S509 — reusable attachment list + uploader.
 *
 * Plugs into any detail view (work order, customer, quote, etc.).
 * Caller passes entityType + entityId; the component fetches existing
 * attachments, renders a grid of thumbnails (for images) or file rows
 * (for PDFs), and provides an upload button that POSTs multipart.
 *
 * Permission gating happens at the API layer. UI assumes the caller
 * already has at least read access to the parent — if write is missing
 * the upload + delete return 403 and we surface the error.
 */

import { useEffect, useRef, useState } from 'react'
import { apiGet, apiDelete, api } from '../lib/api'
import { Paperclip, X, Upload, FileText, EyeOff } from 'lucide-react'

export type AttachmentEntityType = 'work_order' | 'customer' | 'quote' | 'invoice' | 'inventory_item'

interface Attachment {
  id: string
  entityType: AttachmentEntityType
  entityId: string
  fileName: string
  fileSizeBytes: number
  mimeType: string
  description: string | null
  isInternal: boolean
  uploadedByUserId: string | null
  createdAt: string
}

const MAX_FILE_BYTES = 20 * 1024 * 1024

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/')
}

function downloadUrl(id: string): string {
  return `/business-attachments/${id}/download`
}

export function AttachmentList({
  entityType, entityId, canEdit = true, label = 'Attachments',
}: {
  entityType: AttachmentEntityType
  entityId: string
  canEdit?: boolean
  label?: string
}) {
  const [items, setItems] = useState<Attachment[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [showInternal, setShowInternal] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const r = await apiGet<Attachment[]>(
        `/business-attachments?entityType=${entityType}&entityId=${entityId}`)
      setItems(r)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load attachments')
    }
  }
  useEffect(() => { reload() }, [entityType, entityId])

  const onPick = () => fileInputRef.current?.click()

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''  // allow re-selecting the same file later
    if (file.size > MAX_FILE_BYTES) {
      setErr(`File too large (${fmtBytes(file.size)}). Max is 20 MB.`)
      return
    }
    setUploading(true); setErr(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('entityType', entityType)
      form.append('entityId', entityId)
      form.append('isInternal', String(showInternal))
      await api.post('/business-attachments', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Upload failed')
    } finally { setUploading(false) }
  }

  const onDelete = async (a: Attachment) => {
    if (!window.confirm(`Delete "${a.fileName}"?`)) return
    setErr(null)
    try {
      await apiDelete(`/business-attachments/${a.id}`)
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Delete failed')
    }
  }

  const openAttachment = async (a: Attachment) => {
    try {
      const r = await api.get(downloadUrl(a.id), { responseType: 'blob' })
      const blobUrl = URL.createObjectURL(r.data as Blob)
      window.open(blobUrl, '_blank', 'noopener,noreferrer')
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not open file')
    }
  }

  return (
    <div>
      <div style={{
        display: 'flex' as const, justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: 8,
      }}>
        <h2 style={{
          fontSize: 14, color: 'var(--text-2)',
          textTransform: 'uppercase' as const, letterSpacing: 1,
          margin: 0, fontWeight: 600,
          display: 'inline-flex' as const, alignItems: 'center', gap: 6,
        }}>
          <Paperclip size={12} /> {label}
          {items.length > 0 && (
            <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>
              · {items.length}
            </span>
          )}
        </h2>
        {canEdit && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{
              display: 'inline-flex' as const, alignItems: 'center', gap: 5,
              fontSize: 11, color: 'var(--text-3)', cursor: 'pointer',
            }}>
              <input type="checkbox" checked={showInternal}
                onChange={e => setShowInternal(e.target.checked)} />
              Mark next upload as internal
            </label>
            <button onClick={onPick} disabled={uploading} style={uploadBtn}>
              <Upload size={12} /> {uploading ? 'Uploading…' : 'Upload'}
            </button>
            <input ref={fileInputRef} type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,image/heic,application/pdf"
              onChange={onUpload}
              style={{ display: 'none' }} />
          </div>
        )}
      </div>

      {err && (
        <div style={errStyle}>{err}</div>
      )}

      {items.length === 0 ? (
        <div style={emptyStyle}>
          No files yet. {canEdit && 'Photos and PDFs (max 20MB each).'}
        </div>
      ) : (
        <div style={{
          display: 'grid' as const,
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 10,
        }}>
          {items.map(a => (
            <div key={a.id} style={tileStyle}>
              <button onClick={() => openAttachment(a)} style={tileBodyBtn}>
                {isImage(a.mimeType) ? (
                  <img src={`${(api.defaults.baseURL ?? '').replace(/\/api$/, '')}/api${downloadUrl(a.id)}`}
                    alt={a.fileName}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    style={thumbStyle} />
                ) : (
                  <div style={pdfThumb}>
                    <FileText size={32} color="var(--gold)" />
                  </div>
                )}
              </button>
              <div style={tileInfo}>
                <div style={{
                  fontSize: 12, color: 'var(--text-0)',
                  overflow: 'hidden' as const,
                  textOverflow: 'ellipsis' as const,
                  whiteSpace: 'nowrap' as const,
                }} title={a.fileName}>
                  {a.fileName}
                </div>
                <div style={{
                  display: 'flex' as const, justifyContent: 'space-between',
                  alignItems: 'center', marginTop: 4,
                }}>
                  <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                    {fmtBytes(a.fileSizeBytes)}
                    {a.isInternal && (
                      <span title="Hidden from customer-facing surfaces" style={{
                        marginLeft: 6, color: 'var(--amber)',
                        display: 'inline-flex' as const, alignItems: 'center', gap: 2,
                      }}>
                        <EyeOff size={10} /> Internal
                      </span>
                    )}
                  </span>
                  {canEdit && (
                    <button onClick={() => onDelete(a)} style={deleteBtn} title="Delete">
                      <X size={11} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────

const uploadBtn: React.CSSProperties = {
  padding: '6px 10px', fontSize: 11, fontWeight: 600,
  background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 6,
  cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 4,
}
const tileStyle: React.CSSProperties = {
  background: 'var(--bg-2)',
  border: '1px solid var(--border-0)',
  borderRadius: 8,
  overflow: 'hidden' as const,
  display: 'flex' as const,
  flexDirection: 'column' as const,
}
const tileBodyBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: 0,
  cursor: 'pointer',
  width: '100%', aspectRatio: '4 / 3',
  display: 'flex' as const, alignItems: 'center', justifyContent: 'center',
}
const thumbStyle: React.CSSProperties = {
  width: '100%', height: '100%', objectFit: 'cover' as const,
}
const pdfThumb: React.CSSProperties = {
  width: '100%', height: '100%',
  display: 'flex' as const, alignItems: 'center', justifyContent: 'center',
  background: 'var(--bg-1)',
}
const tileInfo: React.CSSProperties = {
  padding: '8px 10px',
  borderTop: '1px solid var(--border-0)',
}
const deleteBtn: React.CSSProperties = {
  padding: 3, background: 'transparent', border: 'none',
  color: 'var(--text-3)', cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center',
}
const emptyStyle: React.CSSProperties = {
  padding: 20, textAlign: 'center' as const,
  background: 'var(--bg-2)', borderRadius: 8,
  color: 'var(--text-3)', fontSize: 13,
}
const errStyle: React.CSSProperties = {
  marginBottom: 12, padding: '8px 10px',
  background: 'var(--red-bg)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red-dim, #ef4444)', borderRadius: 6, fontSize: 12,
}
