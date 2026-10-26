// Die Spiellogik des Online-Dienstes (Gegenstück zu `GameService.kt`): Der Server hält Vorrat und alle
// Ablagen, prüft jeden Zug mit denselben Regeln wie die App und gibt jedem Konto nur die eigene Sicht.

import { chooseMove } from './ai';
import type { AiLevel } from './ai';
import type { AuthPurpose, NewGameRequest, OnlineMove, OnlineReply, OnlineSummary, OnlineView } from './codec';
import { NoMailer } from './mailer';
import type { Mailer } from './mailer';
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
import { NoPusher, pushText } from './push';
import type { Pusher } from './push';
import type { Game, ReportEntry, Slot, Store, Stored } from './store';

export const MAX_MISSES = 3;
/** Ab diesem Zeitpunkt gilt der feste Testcode nicht mehr, auch wenn die Secrets noch gesetzt sind (31.12.2026). */
export const TEST_LOGIN_UNTIL = Date.UTC(2026, 11, 31);
const TEST_DOMAIN = '@rummy-test.invalid';
export const MAX_REPORTS_PER_DAY = 20;
const REPORT_KEEP_MS = 90 * 24 * 3600 * 1000;
export const MAX_ACTIVE_GAMES = 10;
export const MAX_ACCOUNTS = 100_000;
export const FINISHED_KEEP_MS = 30 * 24 * 3600 * 1000;
export const LOBBY_KEEP_MS = 7 * 24 * 3600 * 1000;
/** Laufende Partien, deren Zugfrist seit so langer Zeit abgelaufen ist, ohne dass jemand nachgesehen hat. */
export { NO_LIMIT_IDLE_KEEP_MS } from './store';
export const IDLE_GAME_KEEP_MS = 30 * 24 * 3600 * 1000;
/** Konten ohne Nutzung werden nach dieser Zeit gelöscht. */
export const INACTIVE_ACCOUNT_MS = 365 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 24 * 3600 * 1000;

// E-Mail-Anmeldung
export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
const MIN_RESEND_MS = 30 * 1000;
const MAX_CODES_PER_HOUR = 5;
const HOUR_MS = 3600 * 1000;
/** Tageslimit des Mailanbieters (Brevo kostenlos: 300) mit etwas Reserve. */
export const MAX_MAILS_PER_DAY = 250;

/** Nur für den internen Test: Für diese Adressen gilt ein fester Code, es wird keine Mail verschickt. */
export interface TestLogin {
  emails: Set<string>;
  code: string;
}

export interface AuthResult {
  error: string | null;
  account?: { id: string; secret: string; name: string; isNew: boolean };
}

/** Kleinbuchstaben, ohne Leerraum; `null`, wenn es keine plausible Adresse ist. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  if (!/^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[a-z0-9-]{2,}$/.test(email)) return null;
  return email;
}
/** Anzeigename prüfen und bereinigen; `null`, wenn er nicht zulässig ist. Mit „KI“ beginnende Namen sind den Computerspielern vorbehalten. */
export function normalizeName(raw: string): string | null {
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.length > 20) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*[\p{L}\p{N}]$/u.test(name)) return null;
  if (/^ki\b/i.test(name) || /\(ki\)/i.test(name)) return null;
  return name;
}
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
    private mailer: Mailer = new NoMailer(),
    private testLogin: TestLogin | null = null,
    private pusher: Pusher = new NoPusher(),
  ) {}

  /** Adresse des Betreibers für Meldungen (leer = keine Mail; die Meldungen bleiben abrufbar). */
  reportTo = '';

  /** Laufende Benachrichtigungen; der Aufrufer wartet nach der Antwort darauf (`waitUntil`). */
  private pending: Promise<void>[] = [];

  async flush(): Promise<void> {
    await Promise.all(this.pending);
    this.pending = [];
  }

  private queuePush(accountId: string, kind: 'turn' | 'invite', name = '', data: Record<string, string> = {}): void {
    this.pending.push(
      (async () => {
        try {
          for (const t of await this.store.pushTokensOf(accountId)) {
            const text = pushText(kind, t.lang, name);
            const result = await this.pusher.send(t.token, { ...text, data: { kind, ...data } });
            if (result === 'invalid') await this.store.dropPushToken(t.token);
          }
        } catch {
          // Benachrichtigungen sind nur eine Zugabe: ein Fehler darf den Zug nicht beeinträchtigen.
        }
      })(),
    );
  }

  // --- Benachrichtigungen und Partner ---

  async setPush(accountId: string, token: string, lang: string): Promise<boolean> {
    if (token.length < 20 || token.length > 4096 || !/^[\w:.\-]+$/.test(token)) return false;
    await this.store.addPushToken(accountId, token, lang === 'en' ? 'en' : 'de', this.clock());
    return true;
  }

  async clearPush(accountId: string, token: string): Promise<void> {
    await this.store.removePushToken(accountId, token);
  }

  private testLoginActive(): boolean {
    return this.testLogin !== null && this.clock() < TEST_LOGIN_UNTIL;
  }

  /**
   * Ratenbegrenzung: höchstens [max] Zugriffe je Zeitfenster [windowMs] für [key]. Der Schlüssel ist ein Prüfwert
   * (nie die Adresse im Klartext); die Zähler werden täglich gelöscht.
   */
  async allow(key: string, max: number, windowMs: number): Promise<boolean> {
    const n = await this.store.hit(`${key}|${windowMs}`, Math.floor(this.clock() / windowMs));
    return n <= max;
  }

  /** Prüfwert für eine Absenderadresse, nur für den laufenden Tag gültig. */
  async limitKey(ip: string, scope: string): Promise<string> {
    return sha256(`rl|${scope}|${ip}|${Math.floor(this.clock() / (24 * HOUR_MS))}`);
  }

  // --- Blockieren, Melden, Sperren ---

  private async isBannedEmail(email: string): Promise<boolean> {
    return this.store.isBanned(await sha256(`ban|${email}`));
  }

  /** Sitzt in der Partie ein Mensch, mit dem [accountId] gegenseitig gesperrt ist? */
  private async blockedInGame(accountId: string, g: Game): Promise<boolean> {
    for (const s of g.slots) {
      if (s.accountId && s.accountId !== accountId && (await this.store.isBlockedEither(accountId, s.accountId))) return true;
    }
    return false;
  }

  async blocks(accountId: string) {
    return this.store.blocksOf(accountId);
  }

  async block(accountId: string, targetId: string): Promise<{ error: string | null }> {
    if (targetId === accountId) return { error: 'invalid' };
    if (!(await this.store.getAccount(targetId))) return { error: 'notfound' };
    await this.store.addBlock(accountId, targetId, this.clock());
    await this.store.removePartners(accountId, targetId);
    for (const [owner, other] of [[accountId, targetId], [targetId, accountId]]) {
      for (const i of await this.store.invitesOf(owner)) if (i.fromId === other) await this.store.deleteInvite(i.gameId, owner);
    }
    return { error: null };
  }

  async unblock(accountId: string, targetId: string): Promise<void> {
    await this.store.removeBlock(accountId, targetId);
  }

  /** Der Mitspieler auf Platz [seat] der eigenen Partie (nur Menschen, nicht man selbst). */
  private async seatTarget(accountId: string, gameId: string, seat: number): Promise<{ id: string; name: string } | { error: string }> {
    const stored = await this.store.loadGame(gameId);
    const g = stored?.game;
    if (!g || !g.slots.some((s) => s.accountId === accountId)) return { error: 'forbidden' };
    const slot = g.slots[seat];
    if (!slot || !slot.accountId || slot.accountId === accountId) return { error: 'invalid' };
    return { id: slot.accountId, name: slot.name };
  }

  async blockSeat(accountId: string, gameId: string, seat: number): Promise<{ error: string | null }> {
    const t = await this.seatTarget(accountId, gameId, seat);
    return 'error' in t ? t : this.block(accountId, t.id);
  }

  /** Meldung an den Betreiber: nur ein Grund aus einer festen Liste, kein Freitext. Höchstens 20 Meldungen je Konto und Tag. */
  async report(accountId: string, gameId: string, seat: number, reason: string): Promise<{ error: string | null }> {
    if (!['name', 'behavior', 'other'].includes(reason)) return { error: 'invalid' };
    const t = await this.seatTarget(accountId, gameId, seat);
    if ('error' in t) return t;
    const now = this.clock();
    if ((await this.store.countReportsBy(accountId, now - 24 * HOUR_MS)) >= MAX_REPORTS_PER_DAY) return { error: 'throttled' };
    await this.store.addReport({ reporterId: accountId, reportedId: t.id, reportedName: t.name, reason, gameId, createdAt: now });
    if (this.reportTo) {
      const text = `Meldung zu „${t.name}“ (Konto ${t.id}), Grund: ${reason}, Partie ${gameId}.`;
      this.pending.push(this.mailer.send(this.reportTo, 'Rummy: Meldung', text).then(() => undefined, () => undefined));
    }
    return { error: null };
  }

  /** Für den Betreiber: die neuesten Meldungen mit der Zahl der Meldungen je Konto. */
  async adminReports(): Promise<Array<ReportEntry & { count: number }>> {
    const list = await this.store.reports(100);
    return list.map((r) => ({ ...r, count: list.filter((x) => x.reportedId === r.reportedId).length }));
  }

  /** Sperrt ein Konto: Daten werden wie beim Löschen entfernt, die Adresse (nur als Prüfwert) kann sich nicht neu anmelden. */
  async adminBan(accountId: string, reason: string): Promise<boolean> {
    const account = await this.store.getAccount(accountId);
    if (!account) return false;
    if (account.email) await this.store.addBan(await sha256(`ban|${account.email}`), reason.slice(0, 40), this.clock());
    await this.deleteAccount(accountId);
    return true;
  }

  async adminUnban(rawEmail: string): Promise<boolean> {
    const email = normalizeEmail(rawEmail);
    if (!email) return false;
    await this.store.removeBan(await sha256(`ban|${email}`));
    return true;
  }

  async adminDismiss(reportId: number): Promise<void> {
    await this.store.deleteReport(reportId);
  }

  async partners(accountId: string) {
    return this.store.partnersOf(accountId);
  }

  async removePartner(accountId: string, partnerId: string): Promise<void> {
    await this.store.removePartners(accountId, partnerId);
  }

  /** Lädt einen gemerkten Partner in die eigene Lobby ein; er sieht die Einladung und kann ohne Code beitreten. */
  async invite(accountId: string, gameId: string, partnerId: string): Promise<{ error: string | null }> {
    if (!(await this.store.isPartner(accountId, partnerId)) || (await this.store.isBlockedEither(accountId, partnerId))) return { error: 'forbidden' };
    const me = await this.store.getAccount(accountId);
    if (!me) return { error: 'unknown' };
    const loaded = await this.store.loadGame(gameId);
    const g = loaded?.game;
    if (!g || g.creatorId !== accountId) return { error: 'forbidden' };
    if (g.status !== 'LOBBY' || !g.slots.some((s) => this.isOpen(s))) return { error: 'notlobby' };
    if (g.slots.some((s) => s.accountId === partnerId)) return { error: 'already' };
    if (await this.store.hasInvite(gameId, partnerId)) return { error: null };
    await this.store.putInvite(gameId, partnerId, accountId, this.clock());
    this.queuePush(partnerId, 'invite', me.name, { game: gameId });
    return { error: null };
  }

  /** Offene Einladungen; erledigte oder ungültige werden dabei aufgeräumt. */
  async invites(accountId: string): Promise<Array<{ gameId: string; fromName: string; seats: number }>> {
    const out: Array<{ gameId: string; fromName: string; seats: number }> = [];
    for (const i of await this.store.invitesOf(accountId)) {
      const stored = await this.store.loadGame(i.gameId);
      const from = await this.store.getAccount(i.fromId);
      const g = stored?.game;
      if (!g || !from || g.status !== 'LOBBY' || !g.slots.some((s) => this.isOpen(s))) {
        await this.store.deleteInvite(i.gameId, accountId);
        continue;
      }
      out.push({ gameId: i.gameId, fromName: from.name, seats: g.slots.length });
    }
    return out;
  }

  async acceptInvite(accountId: string, gameId: string): Promise<OnlineReply> {
    if (!(await this.store.hasInvite(gameId, accountId))) return fail('notfound', 'Keine Einladung');
    const account = await this.store.getAccount(accountId);
    if (!account) return fail('unknown');
    if ((await this.activeCount(accountId)) >= MAX_ACTIVE_GAMES) return fail('limit', 'Zu viele laufende Partien');
    const lobby = await this.store.loadGame(gameId);
    if (lobby && (await this.blockedInGame(accountId, lobby.game))) {
      await this.store.deleteInvite(gameId, accountId);
      return fail('notfound', 'Keine Einladung');
    }
    const reply = await this.joinLobby(accountId, account.name, gameId);
    await this.store.deleteInvite(gameId, accountId);
    return reply;
  }

  async declineInvite(accountId: string, gameId: string): Promise<void> {
    await this.store.deleteInvite(gameId, accountId);
  }

  // --- Konten ---

  private token(bytes: number): string {
    return hex(Uint8Array.from({ length: bytes }, () => Math.floor(this.rng() * 256)));
  }

  /** Konto ohne E-Mail: nur für Tests; im Betrieb gibt es Konten ausschließlich über [verifyAuth]. */
  async createAccount(): Promise<{ id: string; secret: string; name: string } | null> {
    if ((await this.store.countAccounts()) >= MAX_ACCOUNTS) return null;
    const secret = this.token(16);
    const secretHash = await sha256(secret);
    for (let i = 0; i < 20; i++) {
      const account = { id: this.token(8), secretHash, email: null, name: randomName(this.rng), lastSeen: this.clock() };
      if (await this.store.createAccount(account)) return { id: account.id, secret, name: account.name };
    }
    return null;
  }

  // --- Anmeldung per E-Mail ---

  /**
   * Schickt einen sechsstelligen Code an die Adresse. Ob es dazu schon ein Konto gibt, verrät die Antwort nicht
   * (beim Löschen wird nur gesendet, wenn es eins gibt). Fehler: `invalid-email`, `throttled`, `busy`, `mail`.
   */
  async startAuth(rawEmail: string, purpose: AuthPurpose, lang: 'de' | 'en'): Promise<{ error: string | null }> {
    const email = normalizeEmail(rawEmail);
    if (!email) return { error: 'invalid-email' };
    if (purpose === 'login' && (await this.isBannedEmail(email))) return { error: 'banned' };
    if (purpose === 'delete' && !(await this.store.findAccountByEmail(email))) return { error: null };

    const now = this.clock();
    if (this.testLoginActive() && this.testLogin!.emails.has(email)) {
      await this.store.putCode({
        email,
        purpose,
        codeHash: await sha256(`${email}|${purpose}|${this.testLogin.code}`),
        expiresAt: now + CODE_TTL_MS,
        attempts: 0,
        sentAt: now,
        windowStart: now,
        sentCount: 1,
      });
      return { error: null };
    }
    const old = await this.store.getCode(email, purpose);
    let windowStart = now;
    let sentCount = 1;
    if (old) {
      if (now - old.sentAt < MIN_RESEND_MS) return { error: 'throttled' };
      if (now - old.windowStart < HOUR_MS) {
        if (old.sentCount >= MAX_CODES_PER_HOUR) return { error: 'throttled' };
        windowStart = old.windowStart;
        sentCount = old.sentCount + 1;
      }
    }
    if ((await this.store.countMail(Math.floor(now / (24 * HOUR_MS)))) > MAX_MAILS_PER_DAY) return { error: 'busy' };

    const code = String(Math.floor(this.rng() * 900000) + 100000);
    await this.store.putCode({
      email,
      purpose,
      codeHash: await sha256(`${email}|${purpose}|${code}`),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      sentAt: now,
      windowStart,
      sentCount,
    });
    const text = lang === 'de'
      ? purpose === 'login'
        ? `Dein Bestätigungscode für Rummy: ${code}\n\nEr gilt 15 Minuten. Wenn du ihn nicht angefordert hast, kannst du diese E-Mail ignorieren.\n`
        : `Dein Code zum Löschen deines Rummy-Kontos: ${code}\n\nEr gilt 15 Minuten. Wenn du das nicht angefordert hast, ignoriere diese E-Mail: Dein Konto bleibt dann bestehen.\n`
      : purpose === 'login'
        ? `Your confirmation code for Rummy: ${code}\n\nIt is valid for 15 minutes. If you did not request it, you can ignore this email.\n`
        : `Your code to delete your Rummy account: ${code}\n\nIt is valid for 15 minutes. If you did not request this, ignore this email: your account will remain.\n`;
    const subject = lang === 'de' ? (purpose === 'login' ? 'Dein Rummy-Code' : 'Rummy-Konto löschen') : (purpose === 'login' ? 'Your Rummy code' : 'Delete Rummy account');
    if (!(await this.mailer.send(email, subject, text))) {
      await this.store.deleteCode(email, purpose);
      return { error: 'mail' };
    }
    return { error: null };
  }

  /**
   * Prüft den Code. Anmelden: legt beim ersten Mal das Konto an und gibt dem Gerät einen neuen Schlüssel (weitere
   * Geräte desselben Kontos bleiben angemeldet). Löschen: entfernt das Konto zu dieser Adresse samt Schlüsseln.
   * Fehler: `invalid-email`, `code`, `locked`.
   */
  async verifyAuth(rawEmail: string, code: string, purpose: AuthPurpose): Promise<AuthResult> {
    const email = normalizeEmail(rawEmail);
    if (!email) return { error: 'invalid-email' };
    const entry = await this.store.getCode(email, purpose);
    const now = this.clock();
    if (!entry || now > entry.expiresAt) return { error: 'code' };
    if (entry.attempts >= MAX_CODE_ATTEMPTS) return { error: 'locked' };
    if (!sameText(entry.codeHash, await sha256(`${email}|${purpose}|${code}`))) {
      await this.store.putCode({ ...entry, attempts: entry.attempts + 1 });
      return { error: entry.attempts + 1 >= MAX_CODE_ATTEMPTS ? 'locked' : 'code' };
    }
    await this.store.deleteCode(email, purpose);
    if (purpose === 'login' && (await this.isBannedEmail(email))) return { error: 'banned' };

    const existing = await this.store.findAccountByEmail(email);
    if (purpose === 'delete') {
      if (existing) await this.deleteAccount(existing.id);
      return { error: null };
    }
    const secret = this.token(16);
    const secretHash = await sha256(secret);
    if (existing) {
      await this.store.addSecret(existing.id, secretHash, now);
      await this.store.touchAccount(existing.id, now);
      return { error: null, account: { id: existing.id, secret, name: existing.name, isNew: false } };
    }
    if ((await this.store.countAccounts()) >= MAX_ACCOUNTS) return { error: 'busy' };
    for (let i = 0; i < 20; i++) {
      const account = { id: this.token(8), secretHash: '', email, name: randomName(this.rng), lastSeen: now };
      if (await this.store.createAccount(account)) {
        await this.store.addSecret(account.id, secretHash, now);
        return { error: null, account: { id: account.id, secret, name: account.name, isNew: true } };
      }
      // Name oder Kennung schon vergeben, oder eine parallele Anfrage hat das Konto zur Adresse angelegt.
      const raced = await this.store.findAccountByEmail(email);
      if (raced) {
        await this.store.addSecret(raced.id, secretHash, now);
        return { error: null, account: { id: raced.id, secret, name: raced.name, isNew: false } };
      }
    }
    return { error: 'busy' };
  }

  async authenticate(id: string, secret: string): Promise<boolean> {
    if (!id || !secret || id.length > 64 || secret.length > 128) return false;
    const account = await this.store.getAccount(id);
    if (account === null) return false;
    const hash = await sha256(secret);
    if (!(account.secretHash !== '' && sameText(account.secretHash, hash)) && !(await this.store.hasSecret(id, hash))) return false;
    // Höchstens einmal am Tag schreiben: genügt, um inaktive Konten zu erkennen.
    const now = this.clock();
    if (now - account.lastSeen > TOUCH_INTERVAL_MS) await this.store.touchAccount(id, now);
    return true;
  }

  async rerollName(accountId: string): Promise<string | null> {
    for (let i = 0; i < 20; i++) {
      const name = randomName(this.rng);
      if (await this.store.renameAccount(accountId, name)) {
        await this.renameInGames(accountId, name);
        return name;
      }
    }
    return null;
  }

  /** Eigener Anzeigename: 3 bis 20 Zeichen (Buchstaben, Ziffern, Leerzeichen, Punkt, Bindestrich, Unterstrich), einmalig vergeben. */
  async setName(accountId: string, raw: string): Promise<{ name?: string; error?: 'invalid' | 'taken' | 'unknown' }> {
    const name = normalizeName(raw);
    if (name === null) return { error: 'invalid' };
    const account = await this.store.getAccount(accountId);
    if (!account) return { error: 'unknown' };
    if (account.name === name) return { name };
    if (!(await this.store.renameAccount(accountId, name))) return { error: 'taken' };
    await this.renameInGames(accountId, name);
    return { name };
  }

  private async renameInGames(accountId: string, name: string): Promise<void> {
    for (const s of await this.store.gamesOf(accountId)) {
      await this.transact(s.game.id, (g) => {
        g.slots.filter((x) => x.accountId === accountId).forEach((x) => (x.name = name));
        return { reply: fail('ok') };
      });
    }
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
    // Wer einen Mitspieler blockiert hat oder von ihm blockiert wurde, sieht nur „kein offenes Spiel“.
    if (await this.blockedInGame(accountId, found.game)) return fail('notfound', 'Kein offenes Spiel mit diesem Code');
    const reply = await this.joinLobby(accountId, account.name, found.game.id);
    // Wer einem Spiel per Code beitritt, wird mit dem Ersteller zu gegenseitig gemerkten Partnern.
    if (reply.error === null && found.game.creatorId !== accountId) {
      await this.store.addPartners(found.game.creatorId, accountId, this.clock());
    }
    return reply;
  }

  private async joinLobby(accountId: string, name: string, gameId: string): Promise<OnlineReply> {
    return this.transact(
      gameId,
      (g) => {
        if (g.status !== 'LOBBY') return { reply: fail('notfound', 'Kein offenes Spiel') };
        if (g.slots.some((s) => s.accountId === accountId)) return { reply: this.ok(g, accountId) };
        const slot = g.slots.find((s) => this.isOpen(s));
        if (!slot) return { reply: fail('full', 'Das Spiel ist voll') };
        slot.accountId = accountId;
        slot.name = name;
        if (!g.slots.some((s) => this.isOpen(s))) this.begin(g);
        return { reply: this.ok(g, accountId) };
      },
      accountId,
    );
  }

  /** Der Ersteller startet früher; freie Plätze füllt eine KI. */
  async start(accountId: string, gameId: string): Promise<OnlineReply> {
    return this.transact(
      gameId,
      (g) => {
        if (g.creatorId !== accountId) return { reply: fail('forbidden', 'Nur der Ersteller startet') };
        if (g.status !== 'LOBBY') return { reply: fail('notlobby') };
        this.begin(g);
        return { reply: this.ok(g, accountId) };
      },
      accountId,
    );
  }

  async view(accountId: string, gameId: string): Promise<OnlineReply> {
    return this.transact(
      gameId,
      (g) => {
        if (!g.slots.some((s) => s.accountId === accountId)) return { reply: fail('forbidden') };
        this.sweep(g);
        return { reply: this.ok(g, accountId) };
      },
      accountId,
    );
  }

  async list(accountId: string): Promise<OnlineSummary[]> {
    const out: OnlineSummary[] = [];
    for (const s of await this.store.gamesOf(accountId)) {
      let g = s.game;
      const swept = await this.transact(
        g.id,
        (x) => {
          this.sweep(x);
          g = x;
          return { reply: fail('ok') };
        },
        accountId,
      );
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
    }, accountId);
  }

  /** Aufgeben oder die Lobby verlassen. */
  async resign(accountId: string, gameId: string): Promise<OnlineReply> {
    return this.transact(
      gameId,
      (g) => {
        if (!g.slots.some((s) => s.accountId === accountId)) return { reply: fail('forbidden') };
        return this.leave(accountId, g);
      },
      accountId,
    );
  }

  /** Täglicher Wartungsaufruf: alte Partien löschen und Konten entfernen, die lange nicht genutzt wurden. */
  async maintenance(): Promise<void> {
    const now = this.clock();
    await this.store.purge(now, FINISHED_KEEP_MS, LOBBY_KEEP_MS, IDLE_GAME_KEEP_MS);
    await this.store.purgeCodes(now - 24 * HOUR_MS);
    await this.store.purgeReports(now - REPORT_KEEP_MS);
    await this.store.purgeLimits(24 * HOUR_MS, now);
    // Ist der Testzugang nicht mehr aktiv, werden dessen Konten entfernt.
    if (!this.testLoginActive()) for (const id of await this.store.accountsWithEmailSuffix(TEST_DOMAIN)) await this.deleteAccount(id);
    for (const id of await this.store.staleAccounts(now - INACTIVE_ACCOUNT_MS)) await this.deleteAccount(id);
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
  private async transact(id: string, fn: (g: Game) => Outcome, actor?: string): Promise<OnlineReply> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const stored: Stored | null = await this.store.loadGame(id);
      if (!stored) return fail('notfound');
      const before = JSON.stringify(stored.game);
      const game = stored.game;
      const prev = { turn: game.turn, status: game.status };
      const outcome = fn(game);
      if (outcome.remove) {
        await this.store.deleteGame(id);
        return outcome.reply;
      }
      if (JSON.stringify(game) === before) return outcome.reply;
      game.touchedAt = this.clock();
      if (await this.store.saveGame(game, stored.version)) {
        this.notifyTurn(game, prev, actor);
        if (game.status === 'FINISHED' && prev.status !== 'FINISHED') await this.recordFinish(game);
        return outcome.reply;
      }
    }
    return fail('busy', 'Bitte noch einmal versuchen');
  }

  /**
   * Gesamtstand gegen einzelne Mitspieler: Am Ende einer Partie zählt für jedes Paar von Menschen, wer gegen wen gewonnen
   * hat (Remis, wenn niemand gewonnen hat). Zwei Verlierer zählen untereinander nicht; ausgestiegene Spieler (durch den
   * Computer ersetzt) sind nicht mehr dabei.
   */
  private async recordFinish(g: Game): Promise<void> {
    if (!g.state) return;
    const winner = g.state.winner;
    const humans = g.slots.map((s, seat) => ({ id: s.accountId, seat })).filter((h): h is { id: string; seat: number } => h.id !== null);
    for (const a of humans) {
      for (const b of humans) {
        if (a.id === b.id) continue;
        if (winner === null) await this.store.addRecord(a.id, b.id, 'draw');
        else if (winner === a.seat) await this.store.addRecord(a.id, b.id, 'win');
        else if (winner === b.seat) await this.store.addRecord(a.id, b.id, 'loss');
      }
    }
  }

  /** Gesamtstand gegen alle Mitspieler, mit denen schon eine Partie zu Ende ging. */
  async records(accountId: string) {
    return this.store.recordsOf(accountId);
  }

  /** Ist nach einer Änderung ein anderer Mensch an der Reihe, bekommt er (falls eingeschaltet) eine Benachrichtigung. */
  private notifyTurn(g: Game, prev: { turn: number; status: string }, actor?: string): void {
    if (g.status !== 'RUNNING' || !g.state) return;
    if (g.turn === prev.turn && prev.status === 'RUNNING') return;
    const next = g.slots[g.state.current]?.accountId;
    if (next && next !== actor) this.queuePush(next, 'turn', '', { game: g.id });
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

  /**
   * Abgelaufene Zugfristen: automatisch ziehen. Bei Partien mit mehr als zwei Plätzen übernimmt nach MAX_MISSES
   * Versäumnissen in Folge der Computer den Platz, bei zwei Plätzen nie (es wird nur gezogen).
   */
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
      if (g.slots.length > 2 && slot.misses >= MAX_MISSES) this.replaceByAi(g, slot);
      this.advanceAi(g);
    }
  }

  /** Aufgabe in einer Partie zu zweit: Sie endet, der andere Platz gewinnt; der Aufgebende bleibt in der Partie eingetragen. */
  private endByResign(g: Game, seat: number): void {
    const state = g.state;
    if (!state || seat < 0) return;
    const winner = (seat + 1) % g.slots.length;
    g.state = { ...state, finished: true, winner };
    g.status = 'FINISHED';
    g.finishedAt = this.clock();
    g.deadlineAt = 0;
    g.turn++;
    g.event = { kind: 'resigned', player: seat, count: 0 };
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
      if (g.slots.length > 2) {
        // Mit mehr als zwei Plätzen läuft die Partie weiter: ein Computer übernimmt den Platz.
        this.replaceByAi(g, slot);
        this.advanceAi(g);
      } else {
        this.endByResign(g, g.slots.indexOf(slot));
      }
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
