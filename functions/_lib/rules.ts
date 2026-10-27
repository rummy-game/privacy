// TypeScript-Fassung der Spielregeln aus dem Kotlin-Modul `core` (rummy.core). Die Fälle in
// test/golden.json stammen aus der Kotlin-Fassung und sichern, dass beide dasselbe Ergebnis liefern.

export const MIN_NUMBER = 1;
export const MAX_NUMBER = 13;
export const NUMBER_TILE_COUNT = 104;
export const JOKER_HAND_VALUE = 30;

/** Ein Plättchen ist nur seine ID: Satz*52 + Farbe*13 + (Zahl-1); ab 104 sind es Joker. */
export type TileId = number;
export type Meld = TileId[];

export const isJoker = (id: TileId) => id >= NUMBER_TILE_COUNT;
export const colorOf = (id: TileId) => Math.floor((id % 52) / 13);
export const numberOf = (id: TileId) => (id % 13) + 1;
export const handValue = (id: TileId) => (isJoker(id) ? JOKER_HAND_VALUE : numberOf(id));

export function fullDeck(jokers: number): TileId[] {
  const n = NUMBER_TILE_COUNT + jokers;
  return Array.from({ length: n }, (_, i) => i);
}

export interface Rules {
  jokers: number;
  handSize: number;
  initialMeldMin: number;
  randomStart: boolean;
}

export const defaultRules = (): Rules => ({ jokers: 2, handSize: 14, initialMeldMin: 30, randomStart: false });

export const firstMeldRestricted = (rules: Rules, hasMelded: boolean) => !hasMelded && rules.initialMeldMin > 0;

// --- Kombinationen ---

export type MeldKind = 'RUN' | 'GROUP';
export interface MeldInfo {
  kind: MeldKind;
  value: number;
}

function runValue(meld: Meld): number | null {
  if (meld.length > MAX_NUMBER) return null;
  let color: number | null = null;
  let start: number | null = null;
  for (let i = 0; i < meld.length; i++) {
    const id = meld[i];
    if (isJoker(id)) continue;
    if (color === null) color = colorOf(id);
    else if (color !== colorOf(id)) return null;
    const candidate = numberOf(id) - i;
    if (start === null) start = candidate;
    else if (start !== candidate) return null;
  }
  const first = start ?? MAX_NUMBER - meld.length + 1;
  const last = first + meld.length - 1;
  if (first < MIN_NUMBER || last > MAX_NUMBER) return null;
  let sum = 0;
  for (let n = first; n <= last; n++) sum += n;
  return sum;
}

function groupValue(meld: Meld): number | null {
  if (meld.length > 4) return null;
  const numbers = meld.filter((id) => !isJoker(id));
  if (new Set(numbers.map(numberOf)).size > 1) return null;
  if (new Set(numbers.map(colorOf)).size !== numbers.length) return null;
  const number = numbers.length ? numberOf(numbers[0]) : MAX_NUMBER;
  return number * meld.length;
}

/** Bewertet eine Kombination; `null` = ungültig. Bei Mehrdeutigkeit zählt der höhere Wert (Folge vor Gruppe). */
export function evaluate(meld: Meld): MeldInfo | null {
  if (meld.length < 3) return null;
  if (new Set(meld).size !== meld.length) return null;
  const run = runValue(meld);
  const group = groupValue(meld);
  const r: MeldInfo | null = run === null ? null : { kind: 'RUN', value: run };
  const g: MeldInfo | null = group === null ? null : { kind: 'GROUP', value: group };
  if (r && g) return g.value > r.value ? g : r;
  return r ?? g;
}

export const isValidMeld = (meld: Meld) => evaluate(meld) !== null;

/** Bringt die Plättchen einer Kombination in eine sinnvolle Reihenfolge (wie `MeldArranger`). */
export function arrange(tiles: Meld): Meld {
  const numbers = tiles.filter((id) => !isJoker(id));
  const jokers = tiles.filter(isJoker);
  if (numbers.length === 0) return tiles;
  const sameNumber = new Set(numbers.map(numberOf)).size === 1;
  const distinctColors = new Set(numbers.map(colorOf)).size === numbers.length;
  if (numbers.length >= 2 && sameNumber && distinctColors) {
    return [...[...numbers].sort((a, b) => colorOf(a) - colorOf(b)), ...jokers];
  }
  return arrangeRun(numbers, jokers) ?? tiles;
}

function arrangeRun(numbers: TileId[], jokers: TileId[]): Meld | null {
  if (new Set(numbers.map(colorOf)).size !== 1) return null;
  const sorted = [...numbers].sort((a, b) => numberOf(a) - numberOf(b));
  if (new Set(sorted.map(numberOf)).size !== sorted.length) return null;
  const result: TileId[] = [];
  const spare = [...jokers];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const gap = numberOf(sorted[i]) - numberOf(sorted[i - 1]) - 1;
      for (let k = 0; k < gap; k++) {
        const j = spare.shift();
        if (j === undefined) return null;
        result.push(j);
      }
    }
    result.push(sorted[i]);
  }
  let last = numberOf(sorted[sorted.length - 1]);
  while (spare.length) {
    const j = spare.shift()!;
    if (last < MAX_NUMBER) {
      result.push(j);
      last++;
    } else {
      result.unshift(j);
    }
  }
  return result;
}

// --- Zugprüfung ---

export type InvalidReason =
  | 'DUPLICATE_TILE'
  | 'INVALID_MELD'
  | 'TABLE_TILE_REMOVED'
  | 'TILE_NOT_FROM_RACK'
  | 'NOTHING_PLAYED'
  | 'INITIAL_MELD_TOO_LOW'
  | 'INITIAL_MELD_TOUCHES_TABLE';

export type Validation =
  | { valid: true; placed: TileId[]; points: number }
  | { valid: false; reason: InvalidReason; detail: string };

const invalid = (reason: InvalidReason, detail = ''): Validation => ({ valid: false, reason, detail });

export function validateTurn(table: Meld[], rack: TileId[], newTable: Meld[], hasMelded: boolean, rules: Rules): Validation {
  const newTiles = newTable.flat();
  if (new Set(newTiles).size !== newTiles.length) return invalid('DUPLICATE_TILE');
  const newIds = new Set(newTiles);
  const oldTiles = table.flat();
  const removed = oldTiles.find((id) => !newIds.has(id));
  if (removed !== undefined) return invalid('TABLE_TILE_REMOVED', `Plättchen ${removed}`);
  const oldIds = new Set(oldTiles);
  const placed = newTiles.filter((id) => !oldIds.has(id));
  const rackSet = new Set(rack);
  const foreign = placed.find((id) => !rackSet.has(id));
  if (foreign !== undefined) return invalid('TILE_NOT_FROM_RACK', `Plättchen ${foreign}`);
  if (placed.length === 0) return invalid('NOTHING_PLAYED');

  const infos = newTable.map(evaluate);
  if (infos.some((i) => i === null)) return invalid('INVALID_MELD');

  let points = 0;
  if (firstMeldRestricted(rules, hasMelded)) {
    const remaining = newTable.map((_, i) => i);
    for (const old of table) {
      const oldSet = new Set(old);
      const matchPos = remaining.findIndex((i) => newTable[i].length === oldSet.size && newTable[i].every((id) => oldSet.has(id)));
      if (matchPos < 0) return invalid('INITIAL_MELD_TOUCHES_TABLE');
      remaining.splice(matchPos, 1);
    }
    points = remaining.reduce((sum, i) => sum + infos[i]!.value, 0);
    if (points < rules.initialMeldMin) return invalid('INITIAL_MELD_TOO_LOW', `${points} < ${rules.initialMeldMin}`);
  }
  return { valid: true, placed, points };
}

// --- Spielzustand ---

export interface PlayerState {
  index: number;
  rack: TileId[];
  hasMelded: boolean;
  lastDrawn: TileId | null;
}

export interface GameState {
  rules: Rules;
  players: PlayerState[];
  table: Meld[];
  pool: TileId[];
  current: number;
  passes: number;
  finished: boolean;
  winner: number | null;
}

/** Zufallsquelle: liefert Zahlen in [0, 1). */
export type Rng = () => number;

export const cryptoRng: Rng = () => {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 4294967296;
};

export function shuffle<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function newGame(playerCount: number, rules: Rules, rng: Rng): GameState {
  if (playerCount < 2 || playerCount > 4) throw new Error('2 bis 4 Spieler');
  const deck = shuffle(fullDeck(rules.jokers), rng);
  if (playerCount * rules.handSize >= deck.length) throw new Error('Zu viele Startplättchen');
  const players: PlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({ index: i, rack: deck.slice(i * rules.handSize, (i + 1) * rules.handSize), hasMelded: false, lastDrawn: null });
  }
  return {
    rules,
    players,
    table: [],
    pool: deck.slice(playerCount * rules.handSize),
    current: rules.randomStart ? Math.floor(rng() * playerCount) : 0,
    passes: 0,
    finished: false,
    winner: null,
  };
}

const advance = (s: GameState): GameState => ({ ...s, current: (s.current + 1) % s.players.length });

export const handPoints = (p: PlayerState) => p.rack.reduce((sum, id) => sum + handValue(id), 0);

export type PlayResult = { ok: true; state: GameState } | { ok: false; invalid: Extract<Validation, { valid: false }> };

export function playTurn(state: GameState, newTable: Meld[]): PlayResult {
  if (state.finished) throw new Error('Spiel ist beendet');
  const player = state.players[state.current];
  const v = validateTurn(state.table, player.rack, newTable, player.hasMelded, state.rules);
  if (!v.valid) return { ok: false, invalid: v };
  const placed = new Set(v.placed);
  const newRack = player.rack.filter((id) => !placed.has(id));
  const players = state.players.map((p, i) => (i === state.current ? { ...p, rack: newRack, hasMelded: true, lastDrawn: null } : p));
  const next: GameState = { ...state, players, table: newTable, passes: 0 };
  return { ok: true, state: newRack.length === 0 ? { ...next, finished: true, winner: state.current } : advance(next) };
}

/** Ziehen, bei leerem Vorrat aussetzen. */
export function drawOrPass(state: GameState): GameState {
  if (state.finished) throw new Error('Spiel ist beendet');
  if (state.pool.length > 0) {
    const drawn = state.pool[0];
    const players = state.players.map((p, i) => (i === state.current ? { ...p, rack: [...p.rack, drawn], lastDrawn: drawn } : p));
    return advance({ ...state, players, pool: state.pool.slice(1), passes: 0 });
  }
  const passes = state.passes + 1;
  const cleared = state.players.map((p, i) => (i === state.current ? { ...p, lastDrawn: null } : p));
  const next = { ...state, players: cleared, passes };
  if (passes >= state.players.length) return blocked(next);
  return advance(next);
}

function blocked(state: GameState): GameState {
  const points = state.players.map(handPoints);
  const best = Math.min(...points);
  const leaders = points.map((p, i) => (p === best ? i : -1)).filter((i) => i >= 0);
  return { ...state, finished: true, winner: leaders.length === 1 ? leaders[0] : null };
}

export function scores(state: GameState): number[] {
  const penalties = state.players.map(handPoints);
  if (state.winner === null) return state.players.map(() => 0);
  const w = state.winner;
  const total = penalties.reduce((a, b) => a + b, 0);
  return state.players.map((_, i) => (i === w ? total - penalties[w] : -penalties[i]));
}
