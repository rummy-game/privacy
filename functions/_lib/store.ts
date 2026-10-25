import type { AiLevel } from './ai';
import type { OnlineEvent, OnlineStatus } from './codec';
import type { GameState, Rules } from './rules';

export interface Slot {
  accountId: string | null;
  name: string;
  ai: AiLevel | null;
  misses: number;
}

export interface Game {
  id: string;
  code: string;
  creatorId: string;
  rules: Rules;
  limitSeconds: number;
  fillLevel: AiLevel;
  slots: Slot[];
  status: OnlineStatus;
  state: GameState | null;
  turn: number;
  event: OnlineEvent;
  deadlineAt: number;
  finishedAt: number;
  createdAt: number;
}

export interface Account {
  id: string;
  secretHash: string;
  name: string;
}

export interface Stored {
  game: Game;
  version: number;
}

/**
 * Speicher des Dienstes. Partien werden mit einer Versionsnummer gespeichert: Ein Schreibvorgang
 * gelingt nur, wenn niemand die Partie inzwischen geändert hat (optimistische Sperre). So bleiben
 * gleichzeitige Anfragen auch ohne Sperren konsistent.
 */
export interface Store {
  createAccount(a: Account): Promise<boolean>;
  getAccount(id: string): Promise<Account | null>;
  renameAccount(id: string, name: string): Promise<boolean>;
  deleteAccount(id: string): Promise<void>;
  countAccounts(): Promise<number>;

  loadGame(id: string): Promise<Stored | null>;
  insertGame(game: Game): Promise<boolean>;
  saveGame(game: Game, version: number): Promise<boolean>;
  deleteGame(id: string): Promise<void>;
  findLobbyByCode(code: string): Promise<Stored | null>;
  codeInUse(code: string): Promise<boolean>;
  gamesOf(accountId: string): Promise<Stored[]>;
  /** Alte beendete und nie gestartete Partien löschen. */
  purge(now: number, finishedKeepMs: number, lobbyKeepMs: number): Promise<void>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Speicher im Arbeitsspeicher, für Tests. */
export class MemoryStore implements Store {
  accounts = new Map<string, Account>();
  games = new Map<string, Stored>();

  async createAccount(a: Account) {
    if (this.accounts.has(a.id) || [...this.accounts.values()].some((x) => x.name === a.name)) return false;
    this.accounts.set(a.id, clone(a));
    return true;
  }
  async getAccount(id: string) {
    const a = this.accounts.get(id);
    return a ? clone(a) : null;
  }
  async renameAccount(id: string, name: string) {
    const a = this.accounts.get(id);
    if (!a || [...this.accounts.values()].some((x) => x.name === name)) return false;
    a.name = name;
    return true;
  }
  async deleteAccount(id: string) {
    this.accounts.delete(id);
  }
  async countAccounts() {
    return this.accounts.size;
  }
  async loadGame(id: string) {
    const s = this.games.get(id);
    return s ? { game: clone(s.game), version: s.version } : null;
  }
  async insertGame(game: Game) {
    if (this.games.has(game.id)) return false;
    this.games.set(game.id, { game: clone(game), version: 1 });
    return true;
  }
  async saveGame(game: Game, version: number) {
    const s = this.games.get(game.id);
    if (!s || s.version !== version) return false;
    this.games.set(game.id, { game: clone(game), version: version + 1 });
    return true;
  }
  async deleteGame(id: string) {
    this.games.delete(id);
  }
  async findLobbyByCode(code: string) {
    for (const s of this.games.values()) if (s.game.code === code && s.game.status === 'LOBBY') return { game: clone(s.game), version: s.version };
    return null;
  }
  async codeInUse(code: string) {
    return [...this.games.values()].some((s) => s.game.code === code && s.game.status !== 'FINISHED');
  }
  async gamesOf(accountId: string) {
    return [...this.games.values()]
      .filter((s) => s.game.slots.some((x) => x.accountId === accountId))
      .map((s) => ({ game: clone(s.game), version: s.version }));
  }
  async purge(now: number, finishedKeepMs: number, lobbyKeepMs: number) {
    for (const [id, s] of this.games) {
      const g = s.game;
      if ((g.status === 'FINISHED' && now - g.finishedAt > finishedKeepMs) || (g.status === 'LOBBY' && now - g.createdAt > lobbyKeepMs)) this.games.delete(id);
    }
  }
}

/** Speicher in Cloudflare D1 (siehe `migrations/0001_init.sql`). */
export class D1Store implements Store {
  constructor(private db: D1Database) {}

  async createAccount(a: Account) {
    try {
      await this.db.prepare('INSERT INTO accounts (id, secret_hash, name, created_at) VALUES (?, ?, ?, ?)').bind(a.id, a.secretHash, a.name, Date.now()).run();
      return true;
    } catch {
      return false; // ID oder Name schon vergeben
    }
  }
  async getAccount(id: string) {
    const r = await this.db.prepare('SELECT id, secret_hash, name FROM accounts WHERE id = ?').bind(id).first<{ id: string; secret_hash: string; name: string }>();
    return r ? { id: r.id, secretHash: r.secret_hash, name: r.name } : null;
  }
  async renameAccount(id: string, name: string) {
    try {
      const r = await this.db.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(name, id).run();
      return r.meta.changes > 0;
    } catch {
      return false;
    }
  }
  async deleteAccount(id: string) {
    await this.db.batch([
      this.db.prepare('DELETE FROM game_players WHERE account_id = ?').bind(id),
      this.db.prepare('DELETE FROM accounts WHERE id = ?').bind(id),
    ]);
  }
  async countAccounts() {
    const r = await this.db.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
    return r?.n ?? 0;
  }

  private parse(row: { data: string; version: number }): Stored {
    return { game: JSON.parse(row.data) as Game, version: row.version };
  }

  async loadGame(id: string) {
    const r = await this.db.prepare('SELECT data, version FROM games WHERE id = ?').bind(id).first<{ data: string; version: number }>();
    return r ? this.parse(r) : null;
  }
  async insertGame(game: Game) {
    try {
      await this.db
        .prepare('INSERT INTO games (id, code, status, version, data, created_at, finished_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
        .bind(game.id, game.code, game.status, JSON.stringify(game), game.createdAt, game.finishedAt)
        .run();
      await this.writePlayers(game);
      return true;
    } catch {
      return false;
    }
  }
  async saveGame(game: Game, version: number) {
    const r = await this.db
      .prepare('UPDATE games SET code = ?, status = ?, version = version + 1, data = ?, finished_at = ? WHERE id = ? AND version = ?')
      .bind(game.code, game.status, JSON.stringify(game), game.finishedAt, game.id, version)
      .run();
    if (r.meta.changes !== 1) return false;
    await this.writePlayers(game);
    return true;
  }
  private async writePlayers(game: Game) {
    const ids = [...new Set(game.slots.map((s) => s.accountId).filter((x): x is string => x !== null))];
    await this.db.batch([
      this.db.prepare('DELETE FROM game_players WHERE game_id = ?').bind(game.id),
      ...ids.map((a) => this.db.prepare('INSERT INTO game_players (game_id, account_id) VALUES (?, ?)').bind(game.id, a)),
    ]);
  }
  async deleteGame(id: string) {
    await this.db.batch([
      this.db.prepare('DELETE FROM game_players WHERE game_id = ?').bind(id),
      this.db.prepare('DELETE FROM games WHERE id = ?').bind(id),
    ]);
  }
  async findLobbyByCode(code: string) {
    const r = await this.db.prepare("SELECT data, version FROM games WHERE code = ? AND status = 'LOBBY'").bind(code).first<{ data: string; version: number }>();
    return r ? this.parse(r) : null;
  }
  async codeInUse(code: string) {
    const r = await this.db.prepare("SELECT 1 AS x FROM games WHERE code = ? AND status != 'FINISHED'").bind(code).first();
    return r !== null;
  }
  async gamesOf(accountId: string) {
    const rows = await this.db
      .prepare('SELECT g.data AS data, g.version AS version FROM games g JOIN game_players p ON p.game_id = g.id WHERE p.account_id = ?')
      .bind(accountId)
      .all<{ data: string; version: number }>();
    return rows.results.map((r) => this.parse(r));
  }
  async purge(now: number, finishedKeepMs: number, lobbyKeepMs: number) {
    const old = await this.db
      .prepare("SELECT id FROM games WHERE (status = 'FINISHED' AND finished_at < ?) OR (status = 'LOBBY' AND created_at < ?) LIMIT 50")
      .bind(now - finishedKeepMs, now - lobbyKeepMs)
      .all<{ id: string }>();
    for (const r of old.results) await this.deleteGame(r.id);
  }
}
