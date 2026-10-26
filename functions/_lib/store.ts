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

export interface PushToken {
  token: string;
  lang: string;
}

export interface PartnerEntry {
  id: string;
  name: string;
}

export interface InviteEntry {
  gameId: string;
  fromId: string;
  createdAt: number;
}

export interface ReportEntry {
  id: number;
  reporterId: string;
  reportedId: string;
  reportedName: string;
  reason: string;
  gameId: string;
  createdAt: number;
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

  /** Gerätetoken für Benachrichtigungen; je Konto bleiben höchstens die fünf neuesten. */
  addPushToken(accountId: string, token: string, lang: string, now: number): Promise<void>;
  removePushToken(accountId: string, token: string): Promise<void>;
  /** Löscht einen Token überall (Gerät nicht mehr erreichbar). */
  dropPushToken(token: string): Promise<void>;
  pushTokensOf(accountId: string): Promise<PushToken[]>;

  /** Gemerkte Spielpartner (gegenseitig). */
  addPartners(a: string, b: string, now: number): Promise<void>;
  removePartners(a: string, b: string): Promise<void>;
  partnersOf(accountId: string): Promise<PartnerEntry[]>;
  isPartner(a: string, b: string): Promise<boolean>;

  /** Einladungen in eine Lobby ohne Code. */
  putInvite(gameId: string, to: string, from: string, now: number): Promise<void>;
  invitesOf(to: string): Promise<InviteEntry[]>;
  deleteInvite(gameId: string, to: string): Promise<void>;
  hasInvite(gameId: string, to: string): Promise<boolean>;

  /** Blockieren: gilt in beide Richtungen (keine Einladung, kein Beitritt). */
  addBlock(accountId: string, blockedId: string, now: number): Promise<void>;
  removeBlock(accountId: string, blockedId: string): Promise<void>;
  blocksOf(accountId: string): Promise<PartnerEntry[]>;
  /** `true`, wenn einer der beiden den anderen blockiert hat. */
  isBlockedEither(a: string, b: string): Promise<boolean>;

  addReport(r: Omit<ReportEntry, 'id'>): Promise<void>;
  countReportsBy(reporterId: string, since: number): Promise<number>;
  reports(limit: number): Promise<ReportEntry[]>;
  deleteReport(id: number): Promise<void>;
  purgeReports(before: number): Promise<void>;

  /** Gesperrte Adressen (nur Prüfwert). */
  addBan(emailHash: string, reason: string, now: number): Promise<void>;
  removeBan(emailHash: string): Promise<void>;
  isBanned(emailHash: string): Promise<boolean>;

  /** Zählt einen Zugriff im Fenster [window] des Schlüssels [key] und liefert den neuen Stand. */
  hit(key: string, window: number): Promise<number>;
  /** Löscht Zähler, deren Fenster vor [before] (Fensternummer in Millisekunden, grob) liegt. */
  purgeLimits(olderThanMs: number, now: number): Promise<void>;
  /** Konten, deren Adresse auf [suffix] endet (Testkonten), höchstens 100. */
  accountsWithEmailSuffix(suffix: string): Promise<string[]>;

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
  pushTokens = new Map<string, { accountId: string; lang: string; at: number }>();
  partners = new Map<string, Set<string>>();
  invites: Array<{ gameId: string; to: string; from: string; at: number }> = [];
  blocks = new Map<string, Set<string>>();
  reportList: ReportEntry[] = [];
  bans = new Set<string>();
  limits = new Map<string, number>();

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
    for (const [t, v] of this.pushTokens) if (v.accountId === id) this.pushTokens.delete(t);
    this.partners.delete(id);
    for (const set of this.partners.values()) set.delete(id);
    this.blocks.delete(id);
    for (const set of this.blocks.values()) set.delete(id);
    this.invites = this.invites.filter((i) => i.to !== id && i.from !== id);
  }
  async hit(key: string, window: number) {
    const k = `${key}#${window}`;
    const n = (this.limits.get(k) ?? 0) + 1;
    this.limits.set(k, n);
    return n;
  }
  async purgeLimits() {
    this.limits.clear();
  }
  async accountsWithEmailSuffix(suffix: string) {
    return [...this.accounts.values()].filter((a) => a.email?.endsWith(suffix)).map((a) => a.id).slice(0, 100);
  }
  async addBlock(accountId: string, blockedId: string) {
    if (!this.blocks.has(accountId)) this.blocks.set(accountId, new Set());
    this.blocks.get(accountId)!.add(blockedId);
  }
  async removeBlock(accountId: string, blockedId: string) {
    this.blocks.get(accountId)?.delete(blockedId);
  }
  async blocksOf(accountId: string) {
    return [...(this.blocks.get(accountId) ?? [])].map((id) => ({ id, name: this.accounts.get(id)?.name ?? '' })).filter((p) => p.name !== '');
  }
  async isBlockedEither(a: string, b: string) {
    return (this.blocks.get(a)?.has(b) ?? false) || (this.blocks.get(b)?.has(a) ?? false);
  }
  async addReport(r: Omit<ReportEntry, 'id'>) {
    this.reportList.push({ ...r, id: this.reportList.length + 1 });
  }
  async countReportsBy(reporterId: string, since: number) {
    return this.reportList.filter((r) => r.reporterId === reporterId && r.createdAt >= since).length;
  }
  async reports(limit: number) {
    return this.reportList.slice(-limit).reverse().map((r) => ({ ...r }));
  }
  async deleteReport(id: number) {
    this.reportList = this.reportList.filter((r) => r.id !== id);
  }
  async purgeReports(before: number) {
    this.reportList = this.reportList.filter((r) => r.createdAt >= before);
  }
  async addBan(emailHash: string) {
    this.bans.add(emailHash);
  }
  async removeBan(emailHash: string) {
    this.bans.delete(emailHash);
  }
  async isBanned(emailHash: string) {
    return this.bans.has(emailHash);
  }
  async addPushToken(accountId: string, token: string, lang: string, now: number) {
    this.pushTokens.set(token, { accountId, lang, at: now });
    const mine = [...this.pushTokens.entries()].filter(([, v]) => v.accountId === accountId).sort((a, b) => b[1].at - a[1].at);
    for (const [t] of mine.slice(5)) this.pushTokens.delete(t);
  }
  async removePushToken(accountId: string, token: string) {
    if (this.pushTokens.get(token)?.accountId === accountId) this.pushTokens.delete(token);
  }
  async dropPushToken(token: string) {
    this.pushTokens.delete(token);
  }
  async pushTokensOf(accountId: string) {
    return [...this.pushTokens.entries()].filter(([, v]) => v.accountId === accountId).map(([token, v]) => ({ token, lang: v.lang }));
  }
  async addPartners(a: string, b: string) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!this.partners.has(x)) this.partners.set(x, new Set());
      this.partners.get(x)!.add(y);
    }
  }
  async removePartners(a: string, b: string) {
    this.partners.get(a)?.delete(b);
    this.partners.get(b)?.delete(a);
  }
  async partnersOf(accountId: string) {
    return [...(this.partners.get(accountId) ?? [])]
      .map((id) => ({ id, name: this.accounts.get(id)?.name ?? '' }))
      .filter((p) => p.name !== '')
      .sort((x, y) => x.name.localeCompare(y.name));
  }
  async isPartner(a: string, b: string) {
    return this.partners.get(a)?.has(b) ?? false;
  }
  async putInvite(gameId: string, to: string, from: string, now: number) {
    if (!this.invites.some((i) => i.gameId === gameId && i.to === to)) this.invites.push({ gameId, to, from, at: now });
  }
  async invitesOf(to: string) {
    return this.invites.filter((i) => i.to === to).map((i) => ({ gameId: i.gameId, fromId: i.from, createdAt: i.at }));
  }
  async deleteInvite(gameId: string, to: string) {
    this.invites = this.invites.filter((i) => !(i.gameId === gameId && i.to === to));
  }
  async hasInvite(gameId: string, to: string) {
    return this.invites.some((i) => i.gameId === gameId && i.to === to);
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
  async hit(key: string, window: number) {
    await this.db.prepare('INSERT INTO rate_limits (key, window, n) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET n = n + 1').bind(key, window).run();
    const r = await this.db.prepare('SELECT n FROM rate_limits WHERE key = ? AND window = ?').bind(key, window).first<{ n: number }>();
    return r?.n ?? 1;
  }
  async purgeLimits() {
    // Fenster sind nach spätestens einem Tag abgelaufen; Zähler sind nur kurz nützlich.
    await this.db.prepare('DELETE FROM rate_limits').run();
  }
  async accountsWithEmailSuffix(suffix: string) {
    const r = await this.db.prepare("SELECT id FROM accounts WHERE email LIKE ? ESCAPE '\\' LIMIT 100").bind('%' + suffix.replace(/[%_\\]/g, (c) => '\\' + c)).all<{ id: string }>();
    return r.results.map((x) => x.id);
  }
  async addBlock(accountId: string, blockedId: string, now: number) {
    await this.db.prepare('INSERT OR IGNORE INTO blocks (account_id, blocked_id, since) VALUES (?, ?, ?)').bind(accountId, blockedId, now).run();
  }
  async removeBlock(accountId: string, blockedId: string) {
    await this.db.prepare('DELETE FROM blocks WHERE account_id = ? AND blocked_id = ?').bind(accountId, blockedId).run();
  }
  async blocksOf(accountId: string) {
    const r = await this.db
      .prepare('SELECT a.id AS id, a.name AS name FROM blocks b JOIN accounts a ON a.id = b.blocked_id WHERE b.account_id = ? ORDER BY a.name')
      .bind(accountId)
      .all<{ id: string; name: string }>();
    return r.results.map((x) => ({ id: x.id, name: x.name }));
  }
  async isBlockedEither(a: string, b: string) {
    const r = await this.db
      .prepare('SELECT 1 AS x FROM blocks WHERE (account_id = ? AND blocked_id = ?) OR (account_id = ? AND blocked_id = ?)')
      .bind(a, b, b, a)
      .first();
    return r !== null;
  }
  async addReport(r: Omit<ReportEntry, 'id'>) {
    await this.db
      .prepare('INSERT INTO reports (reporter_id, reported_id, reported_name, reason, game_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(r.reporterId, r.reportedId, r.reportedName, r.reason, r.gameId, r.createdAt)
      .run();
  }
  async countReportsBy(reporterId: string, since: number) {
    const r = await this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at >= ?').bind(reporterId, since).first<{ n: number }>();
    return r?.n ?? 0;
  }
  async reports(limit: number) {
    const r = await this.db
      .prepare('SELECT id, reporter_id, reported_id, reported_name, reason, game_id, created_at FROM reports ORDER BY id DESC LIMIT ?')
      .bind(limit)
      .all<{ id: number; reporter_id: string; reported_id: string; reported_name: string; reason: string; game_id: string; created_at: number }>();
    return r.results.map((x) => ({
      id: x.id,
      reporterId: x.reporter_id,
      reportedId: x.reported_id,
      reportedName: x.reported_name,
      reason: x.reason,
      gameId: x.game_id,
      createdAt: x.created_at,
    }));
  }
  async deleteReport(id: number) {
    await this.db.prepare('DELETE FROM reports WHERE id = ?').bind(id).run();
  }
  async purgeReports(before: number) {
    await this.db.prepare('DELETE FROM reports WHERE created_at < ?').bind(before).run();
  }
  async addBan(emailHash: string, reason: string, now: number) {
    await this.db.prepare('INSERT OR REPLACE INTO bans (email_hash, reason, created_at) VALUES (?, ?, ?)').bind(emailHash, reason, now).run();
  }
  async removeBan(emailHash: string) {
    await this.db.prepare('DELETE FROM bans WHERE email_hash = ?').bind(emailHash).run();
  }
  async isBanned(emailHash: string) {
    return (await this.db.prepare('SELECT 1 AS x FROM bans WHERE email_hash = ?').bind(emailHash).first()) !== null;
  }
  async addPushToken(accountId: string, token: string, lang: string, now: number) {
    await this.db
      .prepare('INSERT OR REPLACE INTO push_tokens (token, account_id, lang, created_at) VALUES (?, ?, ?, ?)')
      .bind(token, accountId, lang, now)
      .run();
    await this.db
      .prepare('DELETE FROM push_tokens WHERE account_id = ? AND token NOT IN (SELECT token FROM push_tokens WHERE account_id = ? ORDER BY created_at DESC LIMIT 5)')
      .bind(accountId, accountId)
      .run();
  }
  async removePushToken(accountId: string, token: string) {
    await this.db.prepare('DELETE FROM push_tokens WHERE account_id = ? AND token = ?').bind(accountId, token).run();
  }
  async dropPushToken(token: string) {
    await this.db.prepare('DELETE FROM push_tokens WHERE token = ?').bind(token).run();
  }
  async pushTokensOf(accountId: string) {
    const r = await this.db.prepare('SELECT token, lang FROM push_tokens WHERE account_id = ?').bind(accountId).all<{ token: string; lang: string }>();
    return r.results.map((x) => ({ token: x.token, lang: x.lang }));
  }
  async addPartners(a: string, b: string, now: number) {
    await this.db.batch([
      this.db.prepare('INSERT OR IGNORE INTO partners (account_id, partner_id, since) VALUES (?, ?, ?)').bind(a, b, now),
      this.db.prepare('INSERT OR IGNORE INTO partners (account_id, partner_id, since) VALUES (?, ?, ?)').bind(b, a, now),
    ]);
  }
  async removePartners(a: string, b: string) {
    await this.db.batch([
      this.db.prepare('DELETE FROM partners WHERE account_id = ? AND partner_id = ?').bind(a, b),
      this.db.prepare('DELETE FROM partners WHERE account_id = ? AND partner_id = ?').bind(b, a),
    ]);
  }
  async partnersOf(accountId: string) {
    const r = await this.db
      .prepare('SELECT a.id AS id, a.name AS name FROM partners p JOIN accounts a ON a.id = p.partner_id WHERE p.account_id = ? ORDER BY a.name')
      .bind(accountId)
      .all<{ id: string; name: string }>();
    return r.results.map((x) => ({ id: x.id, name: x.name }));
  }
  async isPartner(a: string, b: string) {
    return (await this.db.prepare('SELECT 1 AS x FROM partners WHERE account_id = ? AND partner_id = ?').bind(a, b).first()) !== null;
  }
  async putInvite(gameId: string, to: string, from: string, now: number) {
    await this.db.prepare('INSERT OR IGNORE INTO invites (game_id, to_account, from_account, created_at) VALUES (?, ?, ?, ?)').bind(gameId, to, from, now).run();
  }
  async invitesOf(to: string) {
    const r = await this.db
      .prepare('SELECT game_id, from_account, created_at FROM invites WHERE to_account = ? ORDER BY created_at DESC')
      .bind(to)
      .all<{ game_id: string; from_account: string; created_at: number }>();
    return r.results.map((x) => ({ gameId: x.game_id, fromId: x.from_account, createdAt: x.created_at }));
  }
  async deleteInvite(gameId: string, to: string) {
    await this.db.prepare('DELETE FROM invites WHERE game_id = ? AND to_account = ?').bind(gameId, to).run();
  }
  async hasInvite(gameId: string, to: string) {
    return (await this.db.prepare('SELECT 1 AS x FROM invites WHERE game_id = ? AND to_account = ?').bind(gameId, to).first()) !== null;
  }

  async deleteAccount(id: string) {
    await this.db.batch([
      this.db.prepare('DELETE FROM push_tokens WHERE account_id = ?').bind(id),
      this.db.prepare('DELETE FROM partners WHERE account_id = ? OR partner_id = ?').bind(id, id),
      this.db.prepare('DELETE FROM blocks WHERE account_id = ? OR blocked_id = ?').bind(id, id),
      this.db.prepare('DELETE FROM invites WHERE to_account = ? OR from_account = ?').bind(id, id),
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
