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
  /** Schlüssel des anonymen Kontos (nur Tests); E-Mail-Konten haben Geräte-Schlüssel in `account_secrets`. */
  secretHash: string;
  /** Bestätigte E-Mail-Adresse in Kleinbuchstaben, `null` bei anonymen Konten (nur Tests). */
  email: string | null;
  name: string;
  /** Zeitpunkt der letzten Nutzung (Epoch-Millisekunden), höchstens auf einen Tag genau. */
  lastSeen: number;
}

export type CodePurpose = 'login' | 'delete';

/** Ein offener Bestätigungscode: nur der Prüfwert wird gespeichert. */
export interface CodeEntry {
  email: string;
  purpose: CodePurpose;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
  windowStart: number;
  sentCount: number;
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
  findAccountByEmail(email: string): Promise<Account | null>;
  addSecret(accountId: string, secretHash: string, now: number): Promise<void>;
  hasSecret(accountId: string, secretHash: string): Promise<boolean>;
  getCode(email: string, purpose: CodePurpose): Promise<CodeEntry | null>;
  putCode(entry: CodeEntry): Promise<void>;
  deleteCode(email: string, purpose: CodePurpose): Promise<void>;
  /** Abgelaufene Bestätigungscodes löschen, die vor `before` verschickt wurden. */
  purgeCodes(before: number): Promise<void>;
  /** Zählt eine versendete Mail am Tag `day` und liefert den neuen Stand. */
  countMail(day: number): Promise<number>;
  touchAccount(id: string, now: number): Promise<void>;
  /** Konten, die seit `cutoff` nicht genutzt wurden (höchstens 100). */
  staleAccounts(cutoff: number): Promise<string[]>;
  deleteAccount(id: string): Promise<void>;
  countAccounts(): Promise<number>;

  loadGame(id: string): Promise<Stored | null>;
  insertGame(game: Game): Promise<boolean>;
  saveGame(game: Game, version: number): Promise<boolean>;
  deleteGame(id: string): Promise<void>;
  findLobbyByCode(code: string): Promise<Stored | null>;
  codeInUse(code: string): Promise<boolean>;
  gamesOf(accountId: string): Promise<Stored[]>;
  /** Alte beendete, nie gestartete und seit langem ruhende Partien löschen. */
  purge(now: number, finishedKeepMs: number, lobbyKeepMs: number, idleKeepMs: number): Promise<void>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Speicher im Arbeitsspeicher, für Tests. */
export class MemoryStore implements Store {
  accounts = new Map<string, Account>();
  secrets = new Map<string, Set<string>>();
  codes = new Map<string, CodeEntry>();
  mails = new Map<number, number>();
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
  async findAccountByEmail(email: string) {
    const a = [...this.accounts.values()].find((x) => x.email === email);
    return a ? clone(a) : null;
  }
  async addSecret(accountId: string, secretHash: string) {
    if (!this.secrets.has(accountId)) this.secrets.set(accountId, new Set());
    this.secrets.get(accountId)!.add(secretHash);
  }
  async hasSecret(accountId: string, secretHash: string) {
    return this.secrets.get(accountId)?.has(secretHash) ?? false;
  }
  async getCode(email: string, purpose: CodePurpose) {
    const c = this.codes.get(`${email}|${purpose}`);
    return c ? clone(c) : null;
  }
  async putCode(entry: CodeEntry) {
    this.codes.set(`${entry.email}|${entry.purpose}`, clone(entry));
  }
  async deleteCode(email: string, purpose: CodePurpose) {
    this.codes.delete(`${email}|${purpose}`);
  }
  async purgeCodes(before: number) {
    for (const [k, c] of this.codes) if (c.sentAt < before) this.codes.delete(k);
  }
  async countMail(day: number) {
    const n = (this.mails.get(day) ?? 0) + 1;
    this.mails.set(day, n);
    return n;
  }
  async touchAccount(id: string, now: number) {
    const a = this.accounts.get(id);
    if (a) a.lastSeen = now;
  }
  async staleAccounts(cutoff: number) {
    return [...this.accounts.values()].filter((a) => a.lastSeen < cutoff).slice(0, 100).map((a) => a.id);
  }
  async deleteAccount(id: string) {
    this.accounts.delete(id);
    this.secrets.delete(id);
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
  async purge(now: number, finishedKeepMs: number, lobbyKeepMs: number, idleKeepMs: number) {
    for (const [id, s] of this.games) {
      const g = s.game;
      const idle = g.status === 'RUNNING' && g.deadlineAt > 0 && now - g.deadlineAt > idleKeepMs;
      if ((g.status === 'FINISHED' && now - g.finishedAt > finishedKeepMs) || (g.status === 'LOBBY' && now - g.createdAt > lobbyKeepMs) || idle) this.games.delete(id);
    }
  }
}

/** Speicher in Cloudflare D1 (siehe `migrations/0001_init.sql`). */
export class D1Store implements Store {
  constructor(private db: D1Database) {}

  async createAccount(a: Account) {
    try {
      await this.db
        .prepare('INSERT INTO accounts (id, secret_hash, name, created_at, last_seen, email) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(a.id, a.secretHash, a.name, a.lastSeen, a.lastSeen, a.email)
        .run();
      return true;
    } catch {
      return false; // ID oder Name schon vergeben
    }
  }
  async getAccount(id: string) {
    const r = await this.db
      .prepare('SELECT id, secret_hash, name, last_seen, email FROM accounts WHERE id = ?')
      .bind(id)
      .first<{ id: string; secret_hash: string; name: string; last_seen: number; email: string | null }>();
    return r ? { id: r.id, secretHash: r.secret_hash, name: r.name, lastSeen: r.last_seen, email: r.email } : null;
  }
  async renameAccount(id: string, name: string) {
    try {
      const r = await this.db.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(name, id).run();
      return r.meta.changes > 0;
    } catch {
      return false;
    }
  }
  async touchAccount(id: string, now: number) {
    await this.db.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').bind(now, id).run();
  }
  async findAccountByEmail(email: string) {
    const r = await this.db.prepare('SELECT id FROM accounts WHERE email = ?').bind(email).first<{ id: string }>();
    return r ? this.getAccount(r.id) : null;
  }
  async addSecret(accountId: string, secretHash: string, now: number) {
    await this.db.prepare('INSERT OR IGNORE INTO account_secrets (account_id, secret_hash, created_at) VALUES (?, ?, ?)').bind(accountId, secretHash, now).run();
  }
  async hasSecret(accountId: string, secretHash: string) {
    const r = await this.db.prepare('SELECT 1 AS x FROM account_secrets WHERE account_id = ? AND secret_hash = ?').bind(accountId, secretHash).first();
    return r !== null;
  }
  async getCode(email: string, purpose: CodePurpose) {
    const r = await this.db
      .prepare('SELECT email, purpose, code_hash, expires_at, attempts, sent_at, window_start, sent_count FROM email_codes WHERE email = ? AND purpose = ?')
      .bind(email, purpose)
      .first<{ email: string; purpose: CodePurpose; code_hash: string; expires_at: number; attempts: number; sent_at: number; window_start: number; sent_count: number }>();
    return r
      ? { email: r.email, purpose: r.purpose, codeHash: r.code_hash, expiresAt: r.expires_at, attempts: r.attempts, sentAt: r.sent_at, windowStart: r.window_start, sentCount: r.sent_count }
      : null;
  }
  async putCode(e: CodeEntry) {
    await this.db
      .prepare('INSERT OR REPLACE INTO email_codes (email, purpose, code_hash, expires_at, attempts, sent_at, window_start, sent_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(e.email, e.purpose, e.codeHash, e.expiresAt, e.attempts, e.sentAt, e.windowStart, e.sentCount)
      .run();
  }
  async deleteCode(email: string, purpose: CodePurpose) {
    await this.db.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?').bind(email, purpose).run();
  }
  async purgeCodes(before: number) {
    await this.db.prepare('DELETE FROM email_codes WHERE sent_at < ?').bind(before).run();
    await this.db.prepare('DELETE FROM mail_counter WHERE day < ?').bind(Math.floor(before / 86_400_000) - 7).run();
  }
  async countMail(day: number) {
    await this.db.prepare('INSERT INTO mail_counter (day, sent) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET sent = sent + 1').bind(day).run();
    const r = await this.db.prepare('SELECT sent FROM mail_counter WHERE day = ?').bind(day).first<{ sent: number }>();
    return r?.sent ?? 1;
  }
  async staleAccounts(cutoff: number) {
    const r = await this.db.prepare('SELECT id FROM accounts WHERE last_seen < ? LIMIT 100').bind(cutoff).all<{ id: string }>();
    return r.results.map((x) => x.id);
  }
  async deleteAccount(id: string) {
    await this.db.batch([
      this.db.prepare('DELETE FROM game_players WHERE account_id = ?').bind(id),
      this.db.prepare('DELETE FROM account_secrets WHERE account_id = ?').bind(id),
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
        .prepare('INSERT INTO games (id, code, status, version, data, created_at, finished_at, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
        .bind(game.id, game.code, game.status, JSON.stringify(game), game.createdAt, game.finishedAt, game.deadlineAt)
        .run();
      await this.writePlayers(game);
      return true;
    } catch {
      return false;
    }
  }
  async saveGame(game: Game, version: number) {
    const r = await this.db
      .prepare('UPDATE games SET code = ?, status = ?, version = version + 1, data = ?, finished_at = ?, deadline_at = ? WHERE id = ? AND version = ?')
      .bind(game.code, game.status, JSON.stringify(game), game.finishedAt, game.deadlineAt, game.id, version)
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
  async purge(now: number, finishedKeepMs: number, lobbyKeepMs: number, idleKeepMs: number) {
    // In Runden, bis nichts Altes mehr da ist (höchstens fünf Runden pro Aufruf).
    for (let round = 0; round < 5; round++) {
      const old = await this.db
        .prepare(
          "SELECT id FROM games WHERE (status = 'FINISHED' AND finished_at < ?) OR (status = 'LOBBY' AND created_at < ?) OR (status = 'RUNNING' AND deadline_at > 0 AND deadline_at < ?) LIMIT 100",
        )
        .bind(now - finishedKeepMs, now - lobbyKeepMs, now - idleKeepMs)
        .all<{ id: string }>();
      for (const r of old.results) await this.deleteGame(r.id);
      if (old.results.length < 100) break;
    }
  }
}
