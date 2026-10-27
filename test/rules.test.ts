import { describe, expect, it } from 'vitest';
import golden from './golden.json';
import { arrange, evaluate, validateTurn, defaultRules } from '../functions/_lib/rules';

// Die Fälle stammen aus der Kotlin-Fassung (core/GoldenExportTest) und müssen hier identisch ausgehen.
describe('Regeln wie in Kotlin', () => {
  it('bewertet Kombinationen gleich', () => {
    for (const c of golden.melds) {
      expect(evaluate(c.ids), JSON.stringify(c)).toEqual(c.result);
    }
    expect(golden.melds.filter((m) => m.result).length).toBeGreaterThan(1000);
  });

  it('ordnet Kombinationen gleich an', () => {
    for (const c of golden.arranges) expect(arrange(c.ids), JSON.stringify(c)).toEqual(c.out);
    expect(golden.arranges.length).toBeGreaterThan(300);
  });

  it('prüft Züge gleich', () => {
    let valid = 0;
    for (const c of golden.turns) {
      const rules = { ...defaultRules(), ...c.rules, randomStart: false };
      const r = validateTurn(c.table, c.rack, c.newTable, c.hasMelded, rules);
      const want = c.result as { valid: boolean; reason?: string; placed?: number[]; points?: number };
      expect(r.valid, JSON.stringify(c)).toBe(want.valid);
      if (r.valid) {
        valid++;
        expect(r.placed).toEqual(want.placed);
        expect(r.points).toBe(want.points);
      } else {
        expect(r.reason, JSON.stringify(c)).toBe(want.reason);
      }
    }
    expect(valid).toBeGreaterThan(80);
  });
});
