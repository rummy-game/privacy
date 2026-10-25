// Die Spiellogik des Online-Dienstes (Gegenstück zu `GameService.kt`): Der Server hält Vorrat und alle
// Ablagen, prüft jeden Zug mit denselben Regeln wie die App und gibt jedem Konto nur die eigene Sicht.

import { chooseMove } from './ai';
import type { AiLevel } from './ai';
import type { NewGameRequest, OnlineMove, OnlineReply, OnlineSummary, OnlineView } from './codec';
import { randomName } from './names';
import {
  drawOrPass,
  fullDeck,
  GameState,
  handPoints,
  newGame,
  playTurn,
  Rng,
  scores,
} from './rules';
import type { Game, Slot, Store, Stored } from './store';

export const MAX_MISSES = 3;
export const MAX_ACTIVE_GAMES = 10;
export const MAX_ACCOUNTS = 100_000;
export const FINISHED_KEEP_MS = 30 * 24 * 3600 * 1000;
export const LOBBY_KEEP_MS = 7 * 24 * 3600 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const RETRIES = 6;

export const fail = (error: string, detail = ''): OnlineReply => ({ error, detail, view: null });

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

interface Outcome {
  reply: OnlineReply;
  /** Partie aus dem Speicher entfernen (Ersteller verlässt die Lobby). */
  remove?: boolean;
}

export class Service {
  constructor(
    private store: Store,
    private clock: () => number = Date.now,
    private rng: Rng,
  ) {}

  // --- Konten ---

  private token(bytes: number): string {
    return hex(Uint8Array.from({ length: bytes }, () => Math.floor(this.rng() * 256)));
  }

  async createAccount(): Promise<{ id: string; secret: string; name: string } | null> {
    if ((await this.store.countAccounts()) >= MAX_ACCOUNTS) return null;
    const secret = this.token(16);
    const secretHash = await sha256(secret);
    for (let i = 0; i < 20; i++) {
      const account = { id: this.token(8), secretHash, name: randomName(this.rng) };
      if (await this.store.createAccount(account)) return { id: account.id, secret, name: account.name };
    }
    return null;
  }

  async authenticate(id: string, secret: string): Promise<boolean> {
    if (!id || !secret || id.length > 64 || secret.length > 128) return false;
    const account = await this.store.getAccount(id);
    return account !== null && sameText(account.secretHash, await sha256(secret));
  }

  async rerollName(accountId: string): Promise<string | null> {
    for (let i = 0; i < 20; i++) {
      const name = randomName(this.rng);
      if (await this.store.renameAccount(accountId, name)) {
        for (const s of await this.store.gamesOf(accountId)) {
          await this.transact(s.game.id, (g) => {
            g.slots.filter((x) => x.accountId === accountId).forEach((x) => (x.name = name));
            return { reply: fail('ok') };
          });
        }
        return name;
      }
    }
    return null;
  }

  /** Löscht das Konto: laufende Partien werden aufgegeben, danach bleibt nichts zurück. */
  async deleteAccount(accountId: string): Promise<boolean> {
    if (!(await this.store.getAccount(accountId))) return false;
    for (const s of await this.store.gamesOf(accountId)) {
      await this.transact(s.game.id, (g) => this.leave(accountId, g));
    }
    await this.store.deleteAccount(accountId);
    return true;
  }

  // --- Partien ---

  async createGame(accountId: string, req: NewGameRequest): Promise<OnlineReply> {
    const account = await this.store.getAccount(accountId);
    if (!account) return fail('unknown');
    const r = req.rules;
    if (r.jokers < 0 || r.jokers > 2 || r.handSize < 7 || r.handSize > 20 || r.initialMeldMin < 0 || r.initialMeldMin > 60) return fail('invalid', 'rules');
    if (req.seats * r.handSize >= fullDeck(r.jokers).length) return fail('invalid', 'rules');
    if ((await this.activeCount(accountId)) >= MAX_ACTIVE_GAMES) return fail('limit', 'Zu viele laufende Partien');

    const slots: Slot[] = Array.from({ length: req.seats }, () => ({ accountId: null, name: '', ai: null, misses: 0 }));
    slots[0] = { accountId, name: account.name, ai: null, misses: 0 };
    const now = this.clock();
    for (let i = 0; i < 20; i++) {
      const game: Game = {
        id: this.token(6),
        code: await this.uniqueCode(),
        creatorId: accountId,
        rules: { ...r },
        limitSeconds: req.limitSeconds,
        fillLevel: req.fillLevel,
        slots,
        status: 'LOBBY',
        state: null,
        turn: 0,
        event: { kind: 'none', player: 0, count: 0 },
        deadlineAt: 0,
        finishedAt: 0,
        createdAt: now,
      };
      if (await this.store.insertGame(game)) return { error: null, detail: '', view: this.viewFor(game, accountId) };
    }
    return fail('busy');
  }

  async join(accountId: string, code: string): Promise<OnlineReply> {
    const account = await this.store.getAccount(accountId);
    if (!account) return fail('unknown');
    const found = await this.store.findLobbyByCode(code.trim().toUpperCase().slice(0, 16));
    if (!found) return fail('notfound', 'Kein offenes Spiel mit diesem Code');
    if ((await this.activeCount(accountId)) >= MAX_ACTIVE_GAMES) return fail('limit', 'Zu viele laufende Partien');
    return this.transact(found.game.id, (g) => {
      if (g.status !== 'LOBBY') return { reply: fail('notfound', 'Kein offenes Spiel mit diesem Code') };
      if (g.slots.some((s) => s.accountId === accountId)) return { reply: this.ok(g, accountId) };
      const slot = g.slots.find((s) => this.isOpen(s));
      if (!slot) return { reply: fail('full', 'Das Spiel ist voll') };
      slot.accountId = accountId;
      slot.name = account.name;
      if (!g.slots.some((s) => this.isOpen(s))) this.begin(g);
      return { reply: this.ok(g, accountId) };
    });
  }

  /** Der Ersteller startet früher; freie Plätze füllt eine KI. */
  async start(accountId: string, gameId: string): Promise<OnlineReply> {
    return this.transact(gameId, (g) => {
      if (g.creatorId !== accountId) return { reply: fail('forbidden', 'Nur der Ersteller startet') };
      if (g.status !== 'LOBBY') return { reply: fail('notlobby') };
      this.begin(g);
      return { reply: this.ok(g, accountId) };
    });
  }

  async view(accountId: string, gameId: string): Promise<OnlineReply> {
    return this.transact(gameId, (g) => {
      if (!g.slots.some((s) => s.accountId === accountId)) return { reply: fail('forbidden') };
      this.sweep(g);
      return { reply: this.ok(g, accountId) };
    });
  }

  async list(accountId: string): Promise<OnlineSummary[]> {
    const out: OnlineSummary[] = [];
    for (const s of await this.store.gamesOf(accountId)) {
      let g = s.game;
      const swept = await this.transact(g.id, (x) => {
        this.sweep(x);
        g = x;
        return { reply: fail('ok') };
      });
      void swept;
      const seat = g.slots.findIndex((x) => x.accountId === accountId);
      if (seat < 0) continue;
      out.push({
        id: g.id,
        code: g.code,
        status: g.status,
        myTurn: g.status === 'RUNNING' && g.state?.current === seat,
        names: g.slots.map((x) => (this.isOpen(x) ? '-' : x.name)),
        deadlineAt: g.deadlineAt,
      });
    }
    return out.sort((a, b) => b.deadlineAt - a.deadlineAt);
  }

  async move(accountId: string, gameId: string, move: OnlineMove): Promise<OnlineReply> {
    return this.transact(gameId, (g) => {
      const seat = g.slots.findIndex((s) => s.accountId === accountId);
      if (seat < 0) return { reply: fail('forbidden') };
      this.sweep(g);
      const state = g.state;
      const err = (error: string, detail: string): Outcome => ({ reply: { error, detail, view: this.viewFor(g, accountId) } });
      if (g.status !== 'RUNNING' || !state) return err('notrunning', 'Die Partie läuft nicht');
      // Wiederholte oder veraltete Einreichungen ändern nichts: die Zugnummer muss stimmen.
      if (move.turn !== g.turn) return err('conflict', 'Der Stand hat sich geändert');
      if (state.current !== seat) return err('notyourturn', 'Du bist nicht dran');

      let next: GameState;
      let event: Game['event'];
      if (move.table === null) {
        const hadPool = state.pool.length > 0;
        next = drawOrPass(state);
        event = { kind: hadPool ? 'drew' : 'passed', player: seat, count: 0 };
      } else {
        const deck = new Set(fullDeck(2));
        if (move.table.flat().some((id) => !deck.has(id))) return err('invalid', 'UNKNOWN_TILE');
        const before = state.players[seat].rack.length;
        const result = playTurn(state, move.table);
        if (!result.ok) return err('invalid', `${result.invalid.reason} ${result.invalid.detail}`.trim());
        next = result.state;
        event = { kind: 'placed', player: seat, count: before - next.players[seat].rack.length };
      }
      g.slots[seat].misses = 0;
      this.apply(g, next, event);
      this.advanceAi(g);
      return { reply: this.ok(g, accountId) };
    });
  }

  /** Aufgeben oder die Lobby verlassen. */
  async resign(accountId: string, gameId: string): Promise<OnlineReply> {
    return this.transact(gameId, (g) => {
      if (!g.slots.some((s) => s.accountId === accountId)) return { reply: fail('forbidden') };
      return this.leave(accountId, g);
    });
  }

  /** Alte beendete und nie gestartete Partien löschen; läuft täglich über den Wartungsaufruf. */
  async maintenance(): Promise<void> {
    await this.store.purge(this.clock(), FINISHED_KEEP_MS, LOBBY_KEEP_MS);
  }

  // --- intern ---

  private isOpen(s: Slot) {
    return s.accountId === null && s.ai === null;
  }

  private async activeCount(accountId: string) {
    return (await this.store.gamesOf(accountId)).filter((s) => s.game.status !== 'FINISHED').length;
  }

  private async uniqueCode(): Promise<string> {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(this.rng() * CODE_ALPHABET.length)];
      if (!(await this.store.codeInUse(code))) return code;
    }
  }

  /** Lädt die Partie, wendet [fn] an und speichert bei Änderung; bei gleichzeitiger Änderung wird wiederholt. */
  private async transact(id: string, fn: (g: Game) => Outcome): Promise<OnlineReply> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const stored: Stored | null = await this.store.loadGame(id);
      if (!stored) return fail('notfound');
      const before = JSON.stringify(stored.game);
      const game = stored.game;
      const outcome = fn(game);
      if (outcome.remove) {
        await this.store.deleteGame(id);
        return outcome.reply;
      }
      if (JSON.stringify(game) === before) return outcome.reply;
      if (await this.store.saveGame(game, stored.version)) return outcome.reply;
    }
    return fail('busy', 'Bitte noch einmal versuchen');
  }

  private begin(g: Game): void {
    let aiNo = 0;
    for (const slot of g.slots) {
      if (this.isOpen(slot)) slot.ai = g.fillLevel;
      if (slot.ai !== null && slot.name === '') slot.name = `KI ${++aiNo}`;
    }
    // Allein am Tisch: eine KI genügt als Gegner, alle Plätze sind jetzt besetzt.
    const state = newGame(g.slots.length, g.rules, this.rng);
    g.state = state;
    g.status = 'RUNNING';
    g.turn = 0;
    g.event = { kind: 'started', player: state.current, count: 0 };
    g.deadlineAt = 0;
    this.scheduleDeadline(g);
    this.advanceAi(g);
  }

  private apply(g: Game, next: GameState, event: Game['event']): void {
    g.state = next;
    g.turn++;
    g.event = event;
    if (next.finished) {
      g.status = 'FINISHED';
      g.finishedAt = this.clock();
      g.deadlineAt = 0;
    } else {
      this.scheduleDeadline(g);
    }
  }

  /** KI-Plätze ziehen sofort; danach läuft die Frist des nächsten Menschen. */
  private advanceAi(g: Game): void {
    while (g.status === 'RUNNING' && g.state) {
      const state = g.state;
      const level = g.slots[state.current].ai;
      if (level === null) return;
      const index = state.current;
      const before = state.players[index].rack.length;
      const move = chooseMove(state, level as AiLevel, this.rng);
      const played = move ? playTurn(state, move) : null;
      if (played && played.ok) {
        this.apply(g, played.state, { kind: 'placed', player: index, count: before - played.state.players[index].rack.length });
      } else {
        const hadPool = state.pool.length > 0;
        this.apply(g, drawOrPass(state), { kind: hadPool ? 'drew' : 'passed', player: index, count: 0 });
      }
    }
  }

  private scheduleDeadline(g: Game): void {
    g.deadlineAt = g.limitSeconds > 0 ? this.clock() + g.limitSeconds * 1000 : 0;
  }

  /** Abgelaufene Zugfristen: automatisch ziehen; nach MAX_MISSES Versäumnissen übernimmt eine KI den Platz. */
  private sweep(g: Game): void {
    let guard = 0;
    while (g.status === 'RUNNING' && g.deadlineAt > 0 && this.clock() > g.deadlineAt && g.state && guard++ < 50) {
      const state = g.state;
      const seat = state.current;
      const slot = g.slots[seat];
      if (slot.ai !== null) break;
      slot.misses++;
      const hadPool = state.pool.length > 0;
      this.apply(g, drawOrPass(state), { kind: hadPool ? 'drew' : 'passed', player: seat, count: 0 });
      if (slot.misses >= MAX_MISSES) this.replaceByAi(g, slot);
      this.advanceAi(g);
    }
  }

  private replaceByAi(g: Game, slot: Slot): void {
    slot.accountId = null;
    slot.ai = 'BEGINNER';
    slot.name = `${slot.name} (KI)`;
    if (g.status === 'RUNNING' && g.slots.every((s) => s.accountId === null)) {
      g.status = 'FINISHED';
      g.finishedAt = this.clock();
      g.deadlineAt = 0;
    }
  }

  private leave(accountId: string, g: Game): Outcome {
    const slot = g.slots.find((s) => s.accountId === accountId);
    if (!slot) return { reply: fail('ok') };
    const gone: OnlineReply = { error: null, detail: '', view: null };
    if (g.status === 'LOBBY') {
      if (g.creatorId === accountId) return { reply: gone, remove: true };
      slot.accountId = null;
      slot.name = '';
      return { reply: gone };
    }
    if (g.status === 'RUNNING') {
      this.replaceByAi(g, slot);
      this.advanceAi(g);
      return { reply: gone };
    }
    slot.accountId = null;
    if (g.slots.every((s) => s.accountId === null)) return { reply: gone, remove: true };
    return { reply: gone };
  }

  // --- Sicht ---

  private ok(g: Game, accountId: string): OnlineReply {
    return { error: null, detail: '', view: this.viewFor(g, accountId) };
  }

  /** Die Sicht eines Kontos: nur die eigene Ablage, vom Rest nur Anzahlen. */
  viewFor(g: Game, accountId: string): OnlineView {
    const seat = g.slots.findIndex((s) => s.accountId === accountId);
    const state = g.state;
    const me = seat >= 0 && state ? state.players[seat] : null;
    return {
      id: g.id,
      code: g.code,
      status: g.status,
      turn: g.turn,
      mySeat: seat,
      creator: g.creatorId === accountId,
      current: state?.current ?? 0,
      rules: g.rules,
      limitSeconds: g.limitSeconds,
      deadlineAt: g.deadlineAt,
      seats: g.slots.map((s, i) => ({
        name: s.name,
        ai: s.ai,
        open: this.isOpen(s),
        mine: i === seat,
        tileCount: state?.players[i].rack.length ?? 0,
      })),
      poolSize: state?.pool.length ?? 0,
      table: state ? state.table.map((m) => [...m]) : [],
      rack: me ? [...me.rack] : [],
      hasMelded: me?.hasMelded ?? false,
      newTileId: me?.lastDrawn ?? null,
      event: g.event,
      result:
        state && state.finished
          ? { winner: state.winner, scores: scores(state), remaining: state.players.map(handPoints) }
          : null,
    };
  }
}
