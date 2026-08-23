/**
 * S617 (Nic): "a real person can never read that fast and comprehend that
 * fast." These pin the pacing in a human band and, more importantly, pin that
 * LENGTH IS STILL FELT at the long end — the old numbers capped so low that a
 * 1,600-character message was paced identically to a 90-character one.
 */
import { describe, it, expect } from 'vitest';
import { readBeatMs, typeBeatMs, readGapMs, PAUSE_BEFORE_TYPING_MS } from './chatCadence';

/** ~5 characters per word is the standard convention. */
const impliedWpm = (chars: number, ms: number) => (chars / 5) / (ms / 60_000);

describe('chat cadence (S617)', () => {
  it('reads at a speed a person could actually read', () => {
    // Below the cap's knee (~260 chars), where the per-character rate governs.
    // Above it the implied speed climbs again by design — see chatCadence.ts.
    // The old numbers gave 400 wpm at 150 chars and 1,067 at 400.
    for (const chars of [60, 150, 250]) {
      const wpm = impliedWpm(chars, readBeatMs(chars));
      expect(wpm).toBeGreaterThan(80);
      expect(wpm).toBeLessThan(300);
    }
  });

  it('takes longer over a longer message — the whole complaint', () => {
    expect(readBeatMs(400)).toBeGreaterThan(readBeatMs(150));
    expect(readBeatMs(150)).toBeGreaterThan(readBeatMs(60));
    // The old cap made these three equal.
    expect(readBeatMs(1600)).toBeGreaterThan(readBeatMs(150));
  });

  it('types longer for a longer reply', () => {
    expect(typeBeatMs(600)).toBeGreaterThan(typeBeatMs(200));
    expect(typeBeatMs(200)).toBeGreaterThan(typeBeatMs(40));
  });

  it('still answers a one-liner promptly', () => {
    // "ok thanks" should not sit for ten seconds.
    expect(readBeatMs(9) + PAUSE_BEFORE_TYPING_MS + typeBeatMs(30)).toBeLessThan(5_000);
  });

  it('is bounded — a long wait stops reading as thoughtful', () => {
    expect(readBeatMs(100_000)).toBeLessThanOrEqual(13_000);
    expect(typeBeatMs(100_000)).toBeLessThanOrEqual(18_000);
    expect(readGapMs(100_000)).toBeLessThanOrEqual(8_000);
  });

  it('never returns a beat so short it reads as instant', () => {
    for (const n of [0, 1, 5]) {
      expect(readBeatMs(n)).toBeGreaterThanOrEqual(1_300);
      expect(typeBeatMs(n)).toBeGreaterThanOrEqual(2_200);
      expect(readGapMs(n)).toBeGreaterThanOrEqual(1_900);
    }
  });

  it('is strictly slower than the numbers Nic complained about', () => {
    const oldRead = (n: number) => Math.min(4500, 1100 + n * 40);
    const oldType = (n: number) => Math.min(9000, Math.max(1800, n * 55));
    for (const n of [50, 150, 400, 1200]) {
      expect(readBeatMs(n)).toBeGreaterThan(oldRead(n));
      expect(typeBeatMs(n)).toBeGreaterThan(oldType(n));
    }
  });
});
