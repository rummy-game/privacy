// Computergegner für den Online-Server: Anfänger und Mittel, wie in `AiPlayer.kt`. Die Stufen Schwer
// und Experte brauchen den Tischumbau-Solver (`MeldSolver`) und laufen online vorerst wie „Mittel".

import {
  arrange,
  colorOf,
  firstMeldRestricted,
  GameState,
  isJoker,
  isValidMeld,
  Meld,
  numberOf,
  Rng,
  TileId,
  validateTurn,
} from './rules';

export type AiLevel = 'BEGINNER' | 'MEDIUM' | 'HARD' | 'EXPERT';

/** Weniger Knoten als in der App, damit eine Anfrage auch im CPU-Limit der Worker bleibt. */
const NODE_BUDGET = 30_000;

const mistakeRate = (level: AiLevel) => (level === 'BEGINNER' ? 0.25 : 0.1);

/** Gewünschter Tisch am Zugende oder `null` (ziehen). Das Ergebnis ist vorab geprüft. */
export function chooseMove(state: GameState, level: AiLevel, rng: Rng): Meld[] | null {
  if (rng() < mistakeRate(level)) return null;
  const move = level === 'BEGINNER' ? beginnerMove(state) : mediumMove(state);
  if (!move) return null;
  const p = state.players[state.current];
  return validateTurn(state.table, p.rack, move, p.hasMelded, state.rules).valid ? move : null;
}

function beginnerMove(state: GameState): Meld[] | null {
  const p = state.players[state.current];
  const minPoints = firstMeldRestricted(state.rules, p.hasMelded) ? state.rules.initialMeldMin : 0;
  const melds = newMelds(p.rack, minPoints);
  return melds ? [...state.table, ...melds] : null;
}

function mediumMove(state: GameState): Meld[] | null {
  const p = state.players[state.current];
  if (firstMeldRestricted(state.rules, p.hasMelded)) return beginnerMove(state);

  const extendFirst = () => {
    const table = state.table.map((m) => [...m]);
    const rack = [...p.rack];
    extend(table, rack);
    const fresh = newMelds(rack, 0) ?? [];
    const left = rack.length - fresh.reduce((n, m) => n + m.length, 0);
    return { table: [...table, ...fresh], left };
  };
  const newFirst = () => {
    let rack = [...p.rack];
    const fresh = newMelds(rack, 0) ?? [];
    const used = new Set(fresh.flat());
    rack = rack.filter((id) => !used.has(id));
    const table = state.table.map((m) => [...m]);
    extend(table, rack);
    return { table: [...table, ...fresh], left: rack.length };
  };
  const a = extendFirst();
  const b = newFirst();
  const best = b.left < a.left ? b : a;
  return best.left < p.rack.length ? best.table : null;
}

/** Hängt Zahlenplättchen an bestehende Kombinationen an, solange das gültig bleibt. */
function extend(table: Meld[], rack: TileId[]): void {
  let changed = true;
  while (changed) {
    changed = false;
    const candidates = rack.filter((id) => !isJoker(id)).sort((a, b) => numberOf(b) - numberOf(a));
    outer: for (const tile of candidates) {
      for (let i = 0; i < table.length; i++) {
        const candidate = arrange([...table[i], tile]);
        if (isValidMeld(candidate)) {
          table[i] = candidate;
          rack.splice(rack.indexOf(tile), 1);
          changed = true;
          break outer;
        }
      }
    }
  }
}

// --- Neue Kombinationen aus der Ablage (ohne Joker) ---

interface Pattern {
  cells: Array<[number, number]>; // [Farbe, Zahl]
  value: number;
}

const pattern = (cells: Array<[number, number]>): Pattern => ({ cells, value: cells.reduce((s, c) => s + c[1], 0) });

function candidatePatterns(counts: number[][]): Pattern[] {
  const result: Pattern[] = [];
  for (let color = 0; color < 4; color++) {
    for (let start = 1; start <= 13; start++) {
      let end = start;
      while (end <= 13 && counts[color][end] > 0) {
        if (end - start >= 2) {
          const cells: Array<[number, number]> = [];
          for (let n = start; n <= end; n++) cells.push([color, n]);
          result.push(pattern(cells));
        }
        end++;
      }
    }
  }
  for (let number = 1; number <= 13; number++) {
    const colors = [0, 1, 2, 3].filter((c) => counts[c][number] > 0);
    if (colors.length >= 3) {
      result.push(pattern(colors.map((c) => [c, number] as [number, number])));
      if (colors.length === 4) {
        for (const skip of colors) result.push(pattern(colors.filter((c) => c !== skip).map((c) => [c, number] as [number, number])));
      }
    }
  }
  return result;
}

/** Neue Kombinationen nur aus Zahlenplättchen; `null`, wenn (mit `minPoints`) nichts möglich ist. */
function newMelds(rack: TileId[], minPoints: number): Meld[] | null {
  const counts = Array.from({ length: 4 }, () => new Array<number>(14).fill(0));
  for (const id of rack) if (!isJoker(id)) counts[colorOf(id)][numberOf(id)]++;
  const patterns = candidatePatterns(counts);
  if (patterns.length === 0) return null;

  let nodes = 0;
  let bestScore = -1;
  let best: Pattern[] | null = null;
  const current: Pattern[] = [];
  const run = (start: number, value: number, tiles: number) => {
    if (nodes++ > NODE_BUDGET) return;
    if (value >= minPoints && tiles > 0) {
      const score = minPoints > 0 ? value * 1000 + tiles : tiles * 1000 + value;
      if (score > bestScore) {
        bestScore = score;
        best = [...current];
      }
    }
    for (let i = start; i < patterns.length; i++) {
      const p = patterns[i];
      if (p.cells.some(([c, n]) => counts[c][n] === 0)) continue;
      p.cells.forEach(([c, n]) => counts[c][n]--);
      current.push(p);
      run(i, value + p.value, tiles + p.cells.length);
      current.pop();
      p.cells.forEach(([c, n]) => counts[c][n]++);
    }
  };
  run(0, 0, 0);
  if (!best) return null;

  const pool = rack.filter((id) => !isJoker(id));
  return (best as Pattern[]).map((p) =>
    arrange(
      p.cells.map(([color, number]) => {
        const at = pool.findIndex((id) => colorOf(id) === color && numberOf(id) === number);
        return pool.splice(at, 1)[0];
      }),
    ),
  );
}
