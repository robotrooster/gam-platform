/// <reference types="vite/client" />
import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

/**
 * In-app live route map (S510). Keeps the driver inside GAM (foreground)
 * so the device GPS keeps running: it plots the route + stops on a sleek
 * dark vector basemap, follows the driver with a live dot, fires
 * `onArrive` when the dot enters the current stop's geofence, and pings
 * `onPosition` for downstream ETAs.
 *
 * Basemap: CARTO dark-matter vector style — modern cartography, free,
 * no API key. Swap via VITE_MAP_STYLE_URL (self-host for launch, same
 * pattern as GEOCODER_URL).
 */

export interface LiveMapStop {
  id: string
  sequenceOrder: number
  stopKind: 'customer' | 'dump' | 'depot_return'
  status: 'planned' | 'completed' | 'skipped'
  lat: number | null
  lon: number | null
}

export interface TurnStep { instruction: string; lat: number; lon: number; distanceM: number }
export interface RouteDirections { geometry: [number, number][]; steps: TurnStep[] }

interface Props {
  stops: LiveMapStop[]
  currentStopId: string | null
  geofenceMeters: number
  onArrive: (stopId: string) => void
  onComplete: (stopId: string) => void
  onPosition: (lat: number, lon: number) => void
  directions?: RouteDirections | null
}

const DEFAULT_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL || DEFAULT_STYLE
const POSITION_POST_MS = 20_000
// Arrival requires the truck to actually be STOPPED inside the fence, not
// merely passing near it — otherwise dense same-street routes (cans every
// ~25m) would false-trigger as the truck drives by or as the next stop
// becomes current. "Stopped" = GPS speed near zero, or (when the device
// doesn't report speed) sitting in the fence for a few seconds.
const SPEED_STOPPED_MS = 1.5        // ~3.3 mph
const STOP_CONFIRM_MS = 8_000
// Departure = clearly outside the fence (hysteresis avoids GPS jitter).
const DEPART_HYSTERESIS_M = 25

type Plotted = LiveMapStop & { lat: number; lon: number }
const hasCoords = (s: LiveMapStop): s is Plotted => s.lat != null && s.lon != null

function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const markerColor = (s: LiveMapStop, currentStopId: string | null) =>
  s.status === 'completed' ? '#22c55e'
  : s.status === 'skipped' ? '#f59e0b'
  : s.id === currentStopId ? '#c9a227'
  : '#8a96b0'

export function RouteMapLive({ stops, currentStopId, geofenceMeters, onArrive, onComplete, onPosition, directions }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const liveMarkerRef = useRef<maplibregl.Marker | null>(null)
  const arrivedRef = useRef<Set<string>>(new Set())
  const departedRef = useRef<Set<string>>(new Set())
  const fenceEntryRef = useRef<Map<string, number>>(new Map())
  const lastPostRef = useRef<number>(0)
  const [activeStep, setActiveStep] = useState(0)

  // Latest values for the long-lived geolocation callback.
  const liveRef = useRef({ stops, currentStopId, geofenceMeters, onArrive, onComplete, onPosition, directions })
  liveRef.current = { stops, currentStopId, geofenceMeters, onArrive, onComplete, onPosition, directions }

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return
    const plotted = stops.filter(hasCoords)
    const center: [number, number] = plotted.length
      ? [plotted[0].lon, plotted[0].lat]
      : [-112.07, 33.42]
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center,
      zoom: 11,
      attributionControl: { compact: true },
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Redraw route line + stop markers whenever the stops change.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const draw = () => {
      markersRef.current.forEach(m => m.remove())
      markersRef.current = []
      const plotted = stops.filter(hasCoords)

      // Prefer the road-following geometry; fall back to straight lines.
      const coords = directions?.geometry?.length
        ? directions.geometry
        : plotted.map(s => [s.lon, s.lat])
      const line = {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: coords },
        properties: {},
      }
      const src = map.getSource('route') as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(line as any)
      else {
        map.addSource('route', { type: 'geojson', data: line as any })
        map.addLayer({
          id: 'route-line', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#c9a227', 'line-width': 3, 'line-opacity': 0.65 },
        })
      }

      for (const s of plotted) {
        const el = document.createElement('div')
        el.style.cssText =
          `width:26px;height:26px;border-radius:50%;background:#0f1116;` +
          `border:2px solid ${markerColor(s, currentStopId)};color:#f0f2f7;` +
          `font:700 12px/22px 'DM Sans',sans-serif;text-align:center;box-shadow:0 1px 5px rgba(0,0,0,.6)`
        el.textContent = s.stopKind === 'depot_return' ? '⌂' : String(s.sequenceOrder)
        markersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(map))
      }

      if (plotted.length) {
        const b = new maplibregl.LngLatBounds()
        plotted.forEach(s => b.extend([s.lon, s.lat]))
        map.fitBounds(b, { padding: 48, maxZoom: 14, duration: 400 })
      }
    }
    if (map.isStyleLoaded()) draw()
    else map.once('load', draw)
  }, [stops, currentStopId, directions])

  // Watch device GPS: follow with a live dot, ping position, detect arrival.
  useEffect(() => {
    if (!('geolocation' in navigator)) return
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        const map = mapRef.current
        if (map) {
          if (!liveMarkerRef.current) {
            const el = document.createElement('div')
            el.style.cssText =
              'width:16px;height:16px;border-radius:50%;background:#3b82f6;' +
              'border:3px solid #fff;box-shadow:0 0 0 6px rgba(59,130,246,.3)'
            liveMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([longitude, latitude]).addTo(map)
          } else {
            liveMarkerRef.current.setLngLat([longitude, latitude])
          }
        }
        const g = liveRef.current
        const now = Date.now()
        if (now - lastPostRef.current > POSITION_POST_MS) {
          lastPostRef.current = now
          g.onPosition(latitude, longitude)
        }
        if (g.currentStopId) {
          const cur = g.stops.find(s => s.id === g.currentStopId)
          if (cur && hasCoords(cur)) {
            const dist = metersBetween(latitude, longitude, cur.lat, cur.lon)
            const inFence = dist <= g.geofenceMeters
            const speed = typeof pos.coords.speed === 'number' && pos.coords.speed >= 0 ? pos.coords.speed : null

            if (!arrivedRef.current.has(cur.id)) {
              if (inFence) {
                // Record first fence-entry; require the truck to be stopped
                // (low speed) or to have sat here long enough to count.
                if (!fenceEntryRef.current.has(cur.id)) fenceEntryRef.current.set(cur.id, now)
                const dwellMs = now - (fenceEntryRef.current.get(cur.id) ?? now)
                const stopped = speed != null ? speed < SPEED_STOPPED_MS : dwellMs >= STOP_CONFIRM_MS
                if (stopped) { arrivedRef.current.add(cur.id); g.onArrive(cur.id) }
              } else {
                fenceEntryRef.current.delete(cur.id)  // drove past without stopping
              }
            } else if (!departedRef.current.has(cur.id) && dist > g.geofenceMeters + DEPART_HYSTERESIS_M) {
              // Arrived, now clearly left → real departure → complete.
              departedRef.current.add(cur.id)
              g.onComplete(cur.id)
            }
          }
        }
        // Highlight the nearest upcoming turn.
        const steps = g.directions?.steps
        if (steps && steps.length) {
          let best = 0, bestD = Infinity
          for (let i = 0; i < steps.length; i++) {
            const d = metersBetween(latitude, longitude, steps[i].lat, steps[i].lon)
            if (d < bestD) { bestD = d; best = i }
          }
          setActiveStep(best)
        }
      },
      () => { /* permission denied / unavailable — map still shows the route */ },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
    )
    return () => navigator.geolocation.clearWatch(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const steps = directions?.steps ?? []
  const fmtDist = (m: number) => m >= 1609 ? `${(m / 1609).toFixed(1)} mi` : `${Math.round(m / 30.48) * 10} ft`

  return (
    <div>
      <div ref={containerRef}
        style={{ width: '100%', height: 260, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-0)' }} />
      {steps.length > 0 && (
        <div style={turnPanelStyle}>
          <div style={nextTurnStyle}>
            <span style={{ color: 'var(--gold)', fontWeight: 700 }}>Next</span>{' '}
            {steps[activeStep]?.instruction ?? steps[0].instruction}
          </div>
          <div style={turnListStyle}>
            {steps.map((s, i) => (
              <div key={i} style={{
                ...turnRowStyle,
                opacity: i < activeStep ? 0.4 : 1,
                color: i === activeStep ? 'var(--text-0)' : 'var(--text-2)',
                fontWeight: i === activeStep ? 600 : 400,
              }}>
                <span>{s.instruction}</span>
                <span style={{ color: 'var(--text-3)', whiteSpace: 'nowrap', marginLeft: 8 }}>{fmtDist(s.distanceM)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const turnPanelStyle: React.CSSProperties = {
  marginTop: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden',
}
const nextTurnStyle: React.CSSProperties = {
  padding: '12px 14px', fontSize: 15, color: 'var(--text-0)',
  borderBottom: '1px solid var(--border-0)', background: 'var(--bg-2)',
}
const turnListStyle: React.CSSProperties = {
  maxHeight: 168, overflowY: 'auto',
}
const turnRowStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '9px 14px', fontSize: 13, borderBottom: '1px solid var(--border-0)',
}
