/**
 * S616 (Nic) — "Occupancy also needs to track not just active leases, but it
 * needs to track on short term stays, aggregate thirty nights of bookings as
 * well."
 *
 * Occupancy was active LEASES over total units, so a park running on nightly
 * bookings read as almost empty while it was full — a booking is not a lease, so
 * every booked spot still carries status 'vacant'.
 */
import { describe, it, expect } from 'vitest';
import { occupancyRateFrom, SHORT_STAY_NIGHTS_PER_UNIT_MONTH } from './index';

describe('occupancy counts short stays (S616)', () => {
  it('thirty booked nights is one occupied unit-month', () => {
    expect(SHORT_STAY_NIGHTS_PER_UNIT_MONTH).toBe(30);
    // 10 spots, none leased, one spot booked solid for the month.
    expect(occupancyRateFrom(0, 30, 10)).toBe(10);
  });

  it('leases and bookings add together', () => {
    // 10 spots: 5 on leases, 90 booked nights = 3 more.
    expect(occupancyRateFrom(5, 90, 10)).toBe(80);
  });

  // THE CASE THAT DROVE THIS. An RV park full of nightly guests read as empty.
  it('a fully booked park is not zero percent occupied', () => {
    expect(occupancyRateFrom(0, 300, 10)).toBe(100);
    // The old formula, for contrast: 0 leases / 10 units.
    expect(Math.round(100 * 0 / 10)).toBe(0);
  });

  // A spot turned over many times in one month is still one spot.
  it('never reports more than full', () => {
    expect(occupancyRateFrom(0, 900, 10)).toBe(100);
    expect(occupancyRateFrom(10, 300, 10)).toBe(100);
  });

  it('a partial month of nights rounds up to the spot it occupied', () => {
    // 4 nights is not 4/30ths of a spot for occupancy purposes — the spot was
    // occupied. CEIL keeps a lightly-booked park from reading as empty.
    expect(occupancyRateFrom(0, 4, 10)).toBe(10);
  });

  it('no units is zero, not a divide by zero', () => {
    expect(occupancyRateFrom(0, 0, 0)).toBe(0);
    expect(occupancyRateFrom(5, 100, 0)).toBe(0);
  });

  it('a pure long-term portfolio is unchanged', () => {
    expect(occupancyRateFrom(7, 0, 10)).toBe(70);
  });
});
