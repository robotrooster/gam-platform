import { useEffect, useRef, useState } from 'react'
import { Camera, Video as VideoIcon, X, Square, RefreshCw } from 'lucide-react'

/**
 * In-app camera capture (B3) — tenant copy. Opens the device camera via
 * getUserMedia and captures a PHOTO (canvas frame → JPEG) or VIDEO
 * (MediaRecorder → WebM) directly. No file-picker path, so the capture is
 * fresh from the lens, not the gallery; the caller uploads it capturedLive.
 * (Landlord app has a sibling copy — no shared UI package across the Vite
 * apps, so this is duplicated intentionally.)
 */
export function CameraCapture({
  mode,
  onCapture,
  onClose,
}: {
  mode: 'photo' | 'video'
  onCapture: (file: File) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cancelRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: mode === 'video',
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
      } catch {
        setError('Couldn’t open the camera. Check the browser camera permission and that a camera is connected.')
      }
    })()
    return () => {
      cancelled = true
      if (recorderRef.current?.state === 'recording') {
        cancelRef.current = true
        recorderRef.current.stop()
      }
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [mode])

  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(id)
  }, [recording])

  function stamp() {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }

  function capturePhoto() {
    const v = videoRef.current
    if (!v) return
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) { setError('Capture failed.'); return }
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(
      (blob) => {
        if (!blob) { setError('Capture failed.'); return }
        onCapture(new File([blob], `photo-${stamp()}.jpg`, { type: 'image/jpeg' }))
        onClose()
      },
      'image/jpeg',
      0.92,
    )
  }

  function startRecording() {
    const stream = streamRef.current
    if (!stream) return
    chunksRef.current = []
    const mime = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : ''
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    rec.onstop = () => {
      if (cancelRef.current) return
      const blob = new Blob(chunksRef.current, { type: 'video/webm' })
      onCapture(new File([blob], `video-${stamp()}.webm`, { type: 'video/webm' }))
      onClose()
    }
    recorderRef.current = rec
    cancelRef.current = false
    rec.start()
    setElapsed(0)
    setRecording(true)
  }

  function stopRecording() {
    recorderRef.current?.stop()
    setRecording(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
      <button className="btn btn-g btn-sm" onClick={onClose} style={{ position: 'absolute', top: 16, right: 16, color: '#fff' }}>
        <X size={18} /> Close
      </button>

      {error ? (
        <div className="card" style={{ padding: 24, maxWidth: 420, textAlign: 'center' }}>
          <div style={{ color: 'var(--red)', marginBottom: 12 }}>{error}</div>
          <button className="btn btn-g" onClick={onClose}>Close</button>
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ maxWidth: '92vw', maxHeight: '70vh', borderRadius: 12, background: '#000' }}
          />
          <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 16 }}>
            {mode === 'photo' ? (
              <button className="btn btn-p" onClick={capturePhoto}>
                <Camera size={16} /> Capture photo
              </button>
            ) : recording ? (
              <button className="btn btn-p" onClick={stopRecording} style={{ background: 'var(--red)' }}>
                <Square size={16} /> Stop ({elapsed}s)
              </button>
            ) : (
              <button className="btn btn-p" onClick={startRecording}>
                <VideoIcon size={16} /> Start recording
              </button>
            )}
          </div>
          <div style={{ marginTop: 12, fontSize: '.78rem', color: 'rgba(255,255,255,.6)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={12} /> Live camera — captured fresh, not uploaded from your library.
          </div>
        </>
      )}
    </div>
  )
}
