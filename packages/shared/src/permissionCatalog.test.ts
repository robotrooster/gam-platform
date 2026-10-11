/**
 * 10/3 (Nic): "each permission that you're going to toggle on or off should
 * have a little description of what it does next to it. That way, you know,
 * like point of sale has one called card readers. I don't know if I need to
 * toggle that so that she can use the card reader to ring people up or if
 * that's for setting up a card reader."
 *
 * The description (`hint`) is what the owner reads under each toggle on the
 * staff permissions page, so it is held to the same rules as any other screen
 * copy: always there, plain words, no internal key names, American spelling,
 * and when it sends the owner to another permission it names one that exists.
 */
import { describe, it, expect } from 'vitest';
import { PERMISSION_CATALOG, ALL_CATALOG_PERMISSION_KEYS } from './index';

const items = PERMISSION_CATALOG.flatMap(g =>
  g.sections.flatMap(s => s.items.map(i => ({ ...i, group: g.label }))));
const labels = new Set(items.map(i => i.label));

describe('permission catalog descriptions (10/3)', () => {
  it('every permission has a description', () => {
    const missing = items.filter(i => typeof i.hint !== 'string' || i.hint.trim() === '').map(i => i.key);
    expect(missing).toEqual([]);
    // Every key the page can grant is covered — nothing outside `items`.
    expect(items.map(i => i.key).sort()).toEqual([...ALL_CATALOG_PERMISSION_KEYS].sort());
  });

  it('every key appears once, so each toggle has exactly one description', () => {
    const seen = new Map<string, number>();
    for (const i of items) seen.set(i.key, (seen.get(i.key) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });

  it('no description shows a raw permission key or code name', () => {
    const offenders: string[] = [];
    for (const i of items) {
      const h = i.hint;
      // A catalog key, dotted (pos.ring_sale) or bare (take_payment, guest_access).
      for (const k of ALL_CATALOG_PERMISSION_KEYS) if (h.includes(k)) offenders.push(`${i.key}: names key ${k}`);
      // Any snake_case word (owner_use, on_hold) or dotted lowercase name (units.edit).
      const snake = h.match(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g);
      if (snake) offenders.push(`${i.key}: snake_case ${snake.join(', ')}`);
      const dotted = h.match(/\b[a-z]+\.[a-z_]+\b/g);
      if (dotted) offenders.push(`${i.key}: dotted ${dotted.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('a permission named in a description is a real one, by its exact label', () => {
    // Descriptions point the owner at another toggle by quoting its label
    // ("Ring sales"). Renaming a label must not leave a description pointing
    // at a toggle that no longer exists.
    const broken: string[] = [];
    for (const i of items) {
      for (const m of i.hint.matchAll(/"([^"]+)"/g)) {
        if (!labels.has(m[1])) broken.push(`${i.key}: "${m[1]}"`);
      }
      // Curly quotes would dodge the check above.
      if (/[“”]/.test(i.hint)) broken.push(`${i.key}: curly quotes`);
    }
    expect(broken).toEqual([]);
  });

  it('descriptions are one plain line, short enough to read on a phone', () => {
    const bad = items.filter(i => /[\n\r\t]/.test(i.hint) || i.hint.length > 250 || i.hint.trim() !== i.hint)
      .map(i => `${i.key} (${i.hint.length})`);
    expect(bad).toEqual([]);
    // A description that only repeats the label tells the owner nothing.
    const echo = items.filter(i => i.hint.toLowerCase().replace(/[^a-z]/g, '') === i.label.toLowerCase().replace(/[^a-z]/g, ''))
      .map(i => i.key);
    expect(echo).toEqual([]);
  });

  it('descriptions use American spelling', () => {
    const british = /\b(cancell(?:ed|ing)|colour|favour|behaviour|organis|recognis|authoris|licence|cheque|labelled|catalogue|centre|neighbour|travell(?:ed|ing)|whilst|amongst)/i;
    const bad = items.filter(i => british.test(i.hint)).map(i => `${i.key}: ${i.hint.match(british)![0]}`);
    expect(bad).toEqual([]);
  });

  it('the card reader toggle answers the question that started this', () => {
    // Nic could not tell whether "Card readers" lets someone charge on a
    // reader or set one up. It sets readers up; charging is "Register" plus
    // "Ring sales" for a sale, "Record a cash / check payment" for rent.
    const readers = items.find(i => i.key === 'pos.tab.readers')!;
    expect(readers.label).toBe('Card readers');
    expect(readers.hint).toMatch(/order, pair, or remove/);
    expect(readers.hint).toMatch(/Not needed to charge a card/);
    // Ring sales alone does not reach the register screen, and rent on the
    // reader is a counter payment, not a sale — say both, or the owner turns
    // on only "Ring sales" and the front desk still cannot charge anyone.
    expect(readers.hint).toContain('"Register" plus "Ring sales"');
    expect(readers.hint).toContain('"Record a cash / check payment"');
  });

  it('descriptions name the powers that move money or email residents', () => {
    // Each of these was missing from the first pass, and each is something an
    // owner would not expect from the label alone. Read from the route gates.
    const hint = (k: string) => items.find(i => i.key === k)!.hint;
    // The desk can only re-send an invite; changing its address is refused.
    expect(hint('front_desk.view')).toMatch(/not change its name or email/);
    expect(hint('front_desk.view')).not.toMatch(/update a phone, email/);
    // 10/3: meter readers read blind — master bills and prices are owner-only now.
    expect(hint('utility.read_meters')).toMatch(/do not see past readings, prices or master bills/);
    // Marking a first rent paid in the old system settles a charge with no money.
    expect(hint('take_payment')).toMatch(/first rent as paid in your old system/);
    // The paid-ahead draw is also open to the leaving-date permission.
    expect(hint('front_desk.mark_leaving')).toMatch(/paid-ahead money/);
    // Lease edits include notices that go out to residents.
    expect(hint('leases.edit')).toMatch(/renewal offer or non-renewal notice/);
    expect(hint('payments.view')).toMatch(/email a resident a reminder/);
    expect(hint('settings.maintenance_approval')).toMatch(/tax ID/);
    // The three store lists load only with a sale or setup permission.
    for (const k of ['pos.tab.items', 'pos.tab.categories', 'pos.tab.taxes']) {
      expect(hint(k)).toContain('"Ring sales" or "Create / edit items, tax, vendors"');
    }
  });
});
