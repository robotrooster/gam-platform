/**
 * S462 — routeOptimizer.ts coverage.
 *
 * Pure-function tests. No DB. Deterministic geometry: stops arranged
 * on a known plane so the nearest-neighbor outcome is predictable.
 */

import { describe, it, expect } from 'vitest'
import {
  haversineMiles,
  optimizeRoute,
  GeoPoint,
  OptimizerStop,
  OptimizerDumpLocation,
  OptimizerVehicle,
} from './routeOptimizer'

const PHX_DEPOT: GeoPoint = { lat: 33.4484, lon: -112.0740 }  // Phoenix downtown
const PHX_DUMP:  OptimizerDumpLocation = {
  id: 'dump_1', lat: 33.5000, lon: -112.0500, dumpMinutes: 15,
}

const DEFAULT_VEHICLE: OptimizerVehicle = {
  stopsPerDump: 50,        // high — most tests don't dump
  avgSpeedMph: 25,
  avgServiceMinutes: 3,
}

const START = new Date('2026-07-01T08:00:00Z')

// Build stops at offsets from the depot (rough lat/lon deltas — each
// 0.01 deg ≈ ~0.7 mi at Phoenix latitude).
function stop(id: string, dLat: number, dLon: number): OptimizerStop {
  return {
    id,
    lat: PHX_DEPOT.lat + dLat,
    lon: PHX_DEPOT.lon + dLon,
  }
}

// ─── haversine sanity ───────────────────────────────────────

describe('haversineMiles', () => {
  it('returns 0 for the same point', () => {
    expect(haversineMiles(PHX_DEPOT, PHX_DEPOT)).toBeCloseTo(0, 3)
  })

  it('produces a reasonable urban distance (Phoenix to Tempe ~7 mi)', () => {
    // Phoenix downtown -> Tempe downtown is roughly 7 miles.
    const tempe = { lat: 33.4255, lon: -111.9400 }
    const d = haversineMiles(PHX_DEPOT, tempe)
    expect(d).toBeGreaterThan(6)
    expect(d).toBeLessThan(8.5)
  })

  it('is symmetric', () => {
    const a = { lat: 33.4, lon: -112.1 }
    const b = { lat: 33.5, lon: -112.0 }
    expect(haversineMiles(a, b)).toBeCloseTo(haversineMiles(b, a), 6)
  })
})

// ─── optimizer: empty + single-stop ─────────────────────────

describe('optimizeRoute — edge shapes', () => {
  it('zero stops → one leg (depot return, zero miles, zero minutes)', () => {
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP], stops: [], startAt: START,
    })
    expect(r.legs).toHaveLength(1)
    expect(r.legs[0].kind).toBe('depot_return')
    expect(r.totalMiles).toBe(0)
    expect(r.stopCount).toBe(0)
    expect(r.dumpCount).toBe(0)
  })

  it('single stop → stop + depot_return; round-trip distance > 0', () => {
    const s = stop('s1', 0.05, 0.05)  // ~5 mi NE
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP], stops: [s], startAt: START,
    })
    expect(r.legs).toHaveLength(2)
    expect(r.legs[0].kind).toBe('stop')
    expect((r.legs[0] as any).stopId).toBe('s1')
    expect(r.legs[1].kind).toBe('depot_return')
    expect(r.totalMiles).toBeGreaterThan(0)
    expect(r.stopCount).toBe(1)
  })
})

// ─── nearest-neighbor ordering ──────────────────────────────

describe('greedy nearest-neighbor ordering', () => {
  it('visits the nearest stop first', () => {
    // s_far is ~10mi NE; s_near is ~1mi E. From depot, s_near should
    // come first.
    const sNear = stop('near', 0.0, 0.013)   // ~1 mi E
    const sFar  = stop('far',  0.13, 0.13)   // ~12 mi NE
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP],
      stops: [sFar, sNear], startAt: START,
    })
    const stopLegs = r.legs.filter(l => l.kind === 'stop') as any[]
    expect(stopLegs[0].stopId).toBe('near')
    expect(stopLegs[1].stopId).toBe('far')
  })

  it('order is independent of input order (when distances are distinct)', () => {
    // Stops at distinct distances east of depot — A=1mi, B=2mi, C=3mi.
    // No ties, so greedy always produces A → B → C regardless of input.
    const sA = stop('A', 0.0, 0.013)
    const sB = stop('B', 0.0, 0.026)
    const sC = stop('C', 0.0, 0.039)
    const r1 = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP],
      stops: [sA, sB, sC], startAt: START,
    })
    const r2 = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP],
      stops: [sC, sA, sB], startAt: START,
    })
    const ids1 = r1.legs.filter(l => l.kind === 'stop').map((l: any) => l.stopId)
    const ids2 = r2.legs.filter(l => l.kind === 'stop').map((l: any) => l.stopId)
    expect(ids1).toEqual(['A', 'B', 'C'])
    expect(ids2).toEqual(ids1)
  })

  it('chains: each stop is the nearest unvisited to the previous', () => {
    // Linear east row: stops at lon offsets 0.013, 0.026, 0.039.
    // Greedy starting from depot should visit them in order
    // (each next is the nearest unvisited).
    const s1 = stop('A', 0.0, 0.013)
    const s2 = stop('B', 0.0, 0.026)
    const s3 = stop('C', 0.0, 0.039)
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP],
      stops: [s3, s1, s2], startAt: START,   // out-of-order input
    })
    const ids = r.legs.filter(l => l.kind === 'stop').map((l: any) => l.stopId)
    expect(ids).toEqual(['A', 'B', 'C'])
  })
})

// ─── dump insertion ─────────────────────────────────────────

describe('dump insertion', () => {
  it('inserts a dump leg after every stopsPerDump customer stops', () => {
    // 5 stops, stopsPerDump=2 → expect dumps after stop 2 + stop 4.
    // (No dump after the last stop — we'd just head home.)
    const stops = [0, 1, 2, 3, 4].map(i =>
      stop(`s${i}`, 0.0, 0.013 * (i + 1)))
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: { ...DEFAULT_VEHICLE, stopsPerDump: 2 },
      dumpLocations: [PHX_DUMP],
      stops, startAt: START,
    })
    const kinds = r.legs.map(l => l.kind)
    // Expected sequence: stop, stop, dump, stop, stop, dump, stop, depot_return
    expect(kinds).toEqual([
      'stop', 'stop', 'dump',
      'stop', 'stop', 'dump',
      'stop', 'depot_return',
    ])
    expect(r.dumpCount).toBe(2)
    expect(r.stopCount).toBe(5)
  })

  it('no dumps inserted when stopsPerDump >= total stops', () => {
    const stops = [0, 1, 2].map(i => stop(`s${i}`, 0.0, 0.013 * (i + 1)))
    const r = optimizeRoute({
      depot: PHX_DEPOT,
      vehicle: { ...DEFAULT_VEHICLE, stopsPerDump: 10 },
      dumpLocations: [PHX_DUMP], stops, startAt: START,
    })
    expect(r.dumpCount).toBe(0)
  })

  it('no dump locations supplied → no dumps even when threshold hits', () => {
    const stops = [0, 1, 2, 3, 4].map(i =>
      stop(`s${i}`, 0.0, 0.013 * (i + 1)))
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: { ...DEFAULT_VEHICLE, stopsPerDump: 2 },
      dumpLocations: [],   // e.g., maintenance crew
      stops, startAt: START,
    })
    expect(r.dumpCount).toBe(0)
    expect(r.legs.every(l => l.kind !== 'dump')).toBe(true)
  })

  it('picks the nearest dump when multiple supplied', () => {
    const dumpNear: OptimizerDumpLocation = {
      id: 'near', lat: PHX_DEPOT.lat + 0.013, lon: PHX_DEPOT.lon,
      dumpMinutes: 15,
    }
    const dumpFar:  OptimizerDumpLocation = {
      id: 'far',  lat: PHX_DEPOT.lat + 0.2, lon: PHX_DEPOT.lon,
      dumpMinutes: 15,
    }
    // Need 3+ stops with stopsPerDump=2 so a dump leg actually fires
    // (after stop 2 the algorithm only dumps if remaining.length > 0).
    const stops = [
      stop('s1', 0.013, 0.0),
      stop('s2', 0.020, 0.0),
      stop('s3', 0.030, 0.0),
    ]
    const r = optimizeRoute({
      depot: PHX_DEPOT,
      vehicle: { ...DEFAULT_VEHICLE, stopsPerDump: 2 },
      dumpLocations: [dumpFar, dumpNear],
      stops, startAt: START,
    })
    const dumpLegs = r.legs.filter(l => l.kind === 'dump') as any[]
    expect(dumpLegs).toHaveLength(1)
    expect(dumpLegs[0].dumpLocationId).toBe('near')
  })
})

// ─── ETAs + totals ──────────────────────────────────────────

describe('ETA + totals', () => {
  it('arriveAt at the first stop equals startAt + drive minutes', () => {
    const s = stop('A', 0.0, 0.013)
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP], stops: [s], startAt: START,
    })
    const first = r.legs[0] as any
    const driveMin = (haversineMiles(PHX_DEPOT, s) / DEFAULT_VEHICLE.avgSpeedMph) * 60
    const expectedArriveMs = START.getTime() + driveMin * 60_000
    expect(first.arriveAt.getTime()).toBeCloseTo(expectedArriveMs, -2)
  })

  it('departAt = arriveAt + serviceMinutes', () => {
    const s = stop('A', 0.0, 0.013)
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP], stops: [s], startAt: START,
    })
    const first = r.legs[0] as any
    const diff = (first.departAt.getTime() - first.arriveAt.getTime()) / 60_000
    expect(diff).toBeCloseTo(DEFAULT_VEHICLE.avgServiceMinutes, 3)
  })

  it('per-stop serviceMinutes override is respected', () => {
    const s: OptimizerStop = {
      id: 'A', lat: PHX_DEPOT.lat, lon: PHX_DEPOT.lon + 0.013,
      serviceMinutes: 10,
    }
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP], stops: [s], startAt: START,
    })
    const first = r.legs[0] as any
    const diff = (first.departAt.getTime() - first.arriveAt.getTime()) / 60_000
    expect(diff).toBe(10)
  })

  it('totalMiles is the sum of all transition distances', () => {
    const s1 = stop('A', 0.0, 0.013)
    const s2 = stop('B', 0.0, 0.026)
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP], stops: [s1, s2], startAt: START,
    })
    // depot -> A -> B -> depot
    const expected =
      haversineMiles(PHX_DEPOT, s1) +
      haversineMiles(s1, s2) +
      haversineMiles(s2, PHX_DEPOT)
    expect(r.totalMiles).toBeCloseTo(Math.round(expected * 100) / 100, 2)
  })

  it('totalMinutes covers drive + service + final return', () => {
    const s = stop('A', 0.0, 0.013)
    const r = optimizeRoute({
      depot: PHX_DEPOT, vehicle: DEFAULT_VEHICLE,
      dumpLocations: [PHX_DUMP], stops: [s], startAt: START,
    })
    // out + service + back
    const oneWayMin = (haversineMiles(PHX_DEPOT, s) / DEFAULT_VEHICLE.avgSpeedMph) * 60
    const expected = oneWayMin + DEFAULT_VEHICLE.avgServiceMinutes + oneWayMin
    expect(r.totalMinutes).toBeCloseTo(Math.round(expected * 100) / 100, 1)
  })
})
